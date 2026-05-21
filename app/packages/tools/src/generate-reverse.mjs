// Reverse procedural level generator: places arrows in reverse escape order
// so that solvability is guaranteed by construction.
//
// Insight: a level is solvable iff there exists an escape order
// [A_1, A_2, …, A_n] s.t. for each k, A_k's facing ray from path[0] to
// off-grid is clear of A_{k+1..n}'s bodies (because A_1..A_{k-1} have
// already escaped and are no longer obstacles — see the head-collision
// rule in `packages/core/src/game.ts`, where `obstacles` only contains
// OTHER non-escaped arrows' body cells).
//
// We build this guarantee by placing arrows in REVERSE escape order
// (A_n first, A_1 last). At each step:
//   - pick an empty cell as the new arrow's path[0]
//   - pick a facing direction whose ray from path[0] to off-grid passes
//     only through cells that are currently empty (so it's clear of all
//     already-placed arrows, which are the ones that will outlive it)
//   - set path[1] = path[0] − facing (must be in-grid and empty)
//   - extend path[2..] by a constrained random walk through empty cells
// After all arrows are placed, reverse the list so arrows[0] is the
// first to escape — that order is the constructed solution.
//
// Output goes to --out=<dir> (default packages/tools/generated/) and
// MUST NEVER be moved into levels_data/ (legal hygiene boundary; see
// packages/tools/README.md and ../../README.md).
//
// CLI is similar to generate.mjs:
//   node src/generate-reverse.mjs --w=30 --h=30 --seed=1 --count=5 [--out]
//   --w, --h           grid size (default 10×10)
//   --seed             PRNG seed (default 1)
//   --count            how many levels to produce (default 5)
//   --target-fill      target fill density 0-1 (default 0.85)
//   --min-arrow-len    minimum path length per arrow (default 3)
//   --max-arrow-len    construction-time target length cap (default 12 —
//                      tail extension still grows arrows up to 30 cells)
//   --max-arrows       hard cap on arrows per level (default 300)
//   --max-attempts     give up after this many candidates per requested level (default 20)
//   --min-sequencing   require initial-escapable arrows < arrows × this fraction
//                      (default 0.5 — i.e. at least half the arrows must be initially blocked)
//   --ray-bias         prob. of picking a body cell on a preceding arrow's
//                      ray when extending (default 0.95 — high keeps init-
//                      escapable count low)
//   --straight-bias    prob. of continuing in the same direction during path
//                      extension (default 0.65)
//   --max-deadlock-rate  reject if more than this fraction of random "any
//                      movable" rollouts end stuck (default 0.05). Catches
//                      levels where partial pulls can softlock the player
//                      even though a full solution exists.
//   --rollout-trials   number of rollouts per candidate for the deadlock
//                      probe (default 100)
//   --out              output dir, or stdout JSONL if omitted

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createGame, loadLevel, restore, snapshot, tryPull } from "./_solver.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = resolve(__dirname, "../generated");

// --- PRNG -------------------------------------------------------------------

function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleInPlace(arr, rand) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

const DIRS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

// --- Anchor enumeration ----------------------------------------------------

// A valid anchor is a (path[0], facing) pair where:
//   - path[0] is empty in the current grid
//   - the ray path[0] + i*facing for i = 1, 2, … until off-grid lands only
//     on empty cells (so the next arrow's head can escape past every
//     already-placed arrow)
//   - path[0] − facing is in-grid and empty (will become path[1])
function collectAnchors(W, H, grid) {
  const idx = (x, y) => y * W + x;
  const inGrid = (x, y) => x >= 0 && x < W && y >= 0 && y < H;
  const isEmpty = (x, y) => grid[idx(x, y)] === 0;
  const out = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!isEmpty(x, y)) continue;
      for (const [fx, fy] of DIRS) {
        // Forward ray must be all empty (excluding path[0] itself). Also
        // count how many in-grid cells the ray covers — ray length 0 means
        // the head steps off-grid immediately, so it is forever
        // init-escapable (no cell exists where a blocker could be placed).
        let cx = x + fx;
        let cy = y + fy;
        let clear = true;
        let rayLen = 0;
        while (inGrid(cx, cy)) {
          if (!isEmpty(cx, cy)) {
            clear = false;
            break;
          }
          rayLen++;
          cx += fx;
          cy += fy;
        }
        if (!clear) continue;
        // path[1] candidate cell.
        const bx = x - fx;
        const by = y - fy;
        if (!inGrid(bx, by) || !isEmpty(bx, by)) continue;
        out.push({ start: [x, y], facing: [fx, fy], second: [bx, by], rayLen });
      }
    }
  }
  return out;
}

// --- Path extension --------------------------------------------------------

// Extend `path` by a constrained random walk through empty cells with a
// straight-line bias. Mutates `path` and `used`.
//
// `rayMap`: Map<cellIdx, hitCount> — empty cells lying on some
// already-placed arrow's facing ray. We prefer those cells when extending
// (with `rayBias` probability), which makes the new arrow's body more
// likely to block earlier-placed arrows in the final state — reducing
// init-escapable count.
function extendPath(path, used, W, H, grid, rand, opts, rayMap) {
  const { minLen, maxLen, straightBias, rayBias } = opts;
  const idx = (x, y) => y * W + x;
  const inGrid = (x, y) => x >= 0 && x < W && y >= 0 && y < H;
  const isEmpty = (x, y) => grid[idx(x, y)] === 0;
  const targetLen = minLen + Math.floor(rand() * (maxLen - minLen + 1));
  let lastDir =
    path.length >= 2
      ? [
          path[path.length - 1][0] - path[path.length - 2][0],
          path[path.length - 1][1] - path[path.length - 2][1],
        ]
      : null;

  while (path.length < maxLen) {
    const [hx, hy] = path[path.length - 1];
    const free = DIRS.filter(([dx, dy]) => {
      const nx = hx + dx;
      const ny = hy + dy;
      return inGrid(nx, ny) && isEmpty(nx, ny) && !used.has(idx(nx, ny));
    });
    if (free.length === 0) break;
    if (path.length >= targetLen && rand() < 0.4) break;

    // Ray-blocking takes priority over straight-bias: hitting a preceding
    // arrow's ray converts it from init-escapable to blocked, which is the
    // metric most in deficit vs the corpus.
    let pick;
    const onRay = free.filter((d) => (rayMap.get(idx(hx + d[0], hy + d[1])) || 0) > 0);
    if (onRay.length > 0 && rand() < rayBias) {
      pick = onRay[Math.floor(rand() * onRay.length)];
    } else if (lastDir && rand() < straightBias) {
      const straight = free.find((d) => d[0] === lastDir[0] && d[1] === lastDir[1]);
      pick = straight ?? null;
    }
    if (!pick) {
      pick = free[Math.floor(rand() * free.length)];
    }
    const nx = hx + pick[0];
    const ny = hy + pick[1];
    path.push([nx, ny]);
    used.add(idx(nx, ny));
    lastDir = pick;
  }
}

// Place one arrow into the grid. Iterates over anchor candidates and
// accepts the first whose path can be extended to at least minLen.
//
// Anchor priority (descending):
//   1. rayLen >= 1 (so a blocker CAN later be placed on the ray) AND
//      path[1] sits on some preceding arrow's facing ray (this arrow's
//      body immediately blocks an earlier-placed arrow).
//   2. rayLen >= 1 alone.
//   3. rayLen == 0 (zero-ray arrows are forever init-escapable; we keep
//      them as a fallback so the grid can fill, mirroring the corpus's
//      ~10 % init-escapable share).
// Within each bucket the order is shuffled to keep `--seed` reproducibility.
function placeOne(W, H, grid, rand, opts, rayMap) {
  const anchors = collectAnchors(W, H, grid);
  if (anchors.length === 0) return null;

  const idx = (x, y) => y * W + x;
  const bucket = [[], [], []];
  for (const a of anchors) {
    const ci = idx(a.second[0], a.second[1]);
    const onRay = (rayMap.get(ci) || 0) > 0;
    if (a.rayLen >= 1 && onRay) bucket[0].push(a);
    else if (a.rayLen >= 1) bucket[1].push(a);
    else bucket[2].push(a);
  }
  for (const b of bucket) shuffleInPlace(b, rand);
  const ordered = bucket[0].concat(bucket[1], bucket[2]);

  for (const { start, facing, second } of ordered) {
    const path = [start, second];
    const used = new Set([idx(start[0], start[1]), idx(second[0], second[1])]);
    // Reserve our own facing ray as off-limits during extension. Without this
    // the random walk can curl back so that path[k>0] lands on start + j*facing,
    // producing a head-eats-tail visual: the head appears to be blocked by
    // its own body. snake-walk lets the head step into a cell its own body is
    // vacating, so the engine considers this legal, but players read it as
    // permanently stuck (and the APK corpus contains the shape in 0.003 % of
    // arrows — essentially never).
    let rx = start[0] + facing[0];
    let ry = start[1] + facing[1];
    while (rx >= 0 && rx < W && ry >= 0 && ry < H) {
      used.add(idx(rx, ry));
      rx += facing[0];
      ry += facing[1];
    }
    extendPath(path, used, W, H, grid, rand, opts, rayMap);
    if (path.length >= opts.minLen) {
      return { start, facing, path };
    }
  }
  return null;
}

// Walk arrow.facing from arrow.path[0] outward; increment rayMap for each
// empty in-grid cell encountered (off-grid stops the walk).
function recordRay(arrow, W, H, grid, rayMap) {
  const idx = (x, y) => y * W + x;
  let cx = arrow.path[0][0] + arrow.facing[0];
  let cy = arrow.path[0][1] + arrow.facing[1];
  while (cx >= 0 && cx < W && cy >= 0 && cy < H) {
    const ci = idx(cx, cy);
    if (grid[ci] === 0) {
      rayMap.set(ci, (rayMap.get(ci) || 0) + 1);
    }
    cx += arrow.facing[0];
    cy += arrow.facing[1];
  }
}

// Post-process: extend each arrow's tail into adjacent empty cells. New
// tail cell c is valid iff c is not on any earlier-escaping arrow's facing
// ray (those arrows pull while this one is still in the grid, so c can't
// obstruct them — that'd make the level unsolvable).
//
// Preference order, for arrow m extending to cell c:
//   1. c sits on some still-init-escapable arrow k's ray (k > m).
//      Strongest preference — directly converts k from init-esc to blocked,
//      which is the metric we most want to close vs corpus.
//   2. c sits on some later-escaping (already-blocked) arrow's ray.
//      Weaker preference — tightens packing without changing init-esc.
//   3. Any valid c (just fills cells).
//
// Inputs:
//   arrows: in ESCAPE order (post-reverse). arrows[0] escapes first.
//   grid: occupancy after main construction (1 = filled, 0 = empty).
// Returns: number of cells added.
function extendTails(W, H, grid, arrows, rand) {
  const idx = (x, y) => y * W + x;
  const rayByArrow = arrows.map((a) => {
    const ray = new Set();
    const list = [];
    let cx = a.path[0][0] + a.facing[0];
    let cy = a.path[0][1] + a.facing[1];
    while (cx >= 0 && cx < W && cy >= 0 && cy < H) {
      const ci = idx(cx, cy);
      ray.add(ci);
      list.push(ci);
      cx += a.facing[0];
      cy += a.facing[1];
    }
    return { ray, list };
  });

  // Live set of init-escapable arrow indices, recomputed lazily.
  const computeInitEsc = () => {
    const out = new Set();
    for (let i = 0; i < arrows.length; i++) {
      let escapable = true;
      for (const ci of rayByArrow[i].list) {
        if (grid[ci] !== 0) {
          escapable = false;
          break;
        }
      }
      if (escapable) out.add(i);
    }
    return out;
  };
  const initEsc = computeInitEsc();

  let added = 0;
  let madeProgress = true;
  while (madeProgress) {
    madeProgress = false;
    for (let m = 0; m < arrows.length; m++) {
      if (arrows[m].path.length >= 30) continue;
      const [tx, ty] = arrows[m].path[arrows[m].path.length - 1];
      const candidates = [];
      for (const [dx, dy] of DIRS) {
        const nx = tx + dx;
        const ny = ty + dy;
        if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
        if (grid[idx(nx, ny)] !== 0) continue;
        const ci = idx(nx, ny);
        // Forbid extending tail into this arrow's OWN facing ray —
        // that creates the head-eats-tail visual the player reads as
        // permanently stuck.
        if (rayByArrow[m].ray.has(ci)) continue;
        let valid = true;
        for (let j = 0; j < m; j++) {
          if (rayByArrow[j].ray.has(ci)) {
            valid = false;
            break;
          }
        }
        if (valid) candidates.push([dx, dy, ci]);
      }
      if (candidates.length === 0) continue;
      const blocksInitEsc = candidates.filter(([, , ci]) => {
        for (const k of initEsc) {
          if (k > m && rayByArrow[k].ray.has(ci)) return true;
        }
        return false;
      });
      let pool;
      if (blocksInitEsc.length > 0) {
        pool = blocksInitEsc;
      } else {
        const blocking = candidates.filter(([, , ci]) => {
          for (let j = m + 1; j < arrows.length; j++) {
            if (rayByArrow[j].ray.has(ci)) return true;
          }
          return false;
        });
        pool = blocking.length > 0 ? blocking : candidates;
      }
      const [dx, dy, ci] = pool[Math.floor(rand() * pool.length)];
      arrows[m].path.push([tx + dx, ty + dy]);
      grid[ci] = 1;
      added++;
      madeProgress = true;
      // Update init-esc set: any k whose ray contained ci is now blocked.
      if (initEsc.size > 0) {
        for (const k of initEsc) {
          if (rayByArrow[k].ray.has(ci)) initEsc.delete(k);
        }
      }
    }
  }
  return added;
}

// --- Top-level construction ------------------------------------------------

function generate(W, H, rand, opts) {
  const grid = new Uint8Array(W * H);
  const idx = (x, y) => y * W + x;
  const arrows = []; // placed in reverse escape order
  const rayMap = new Map(); // empty cell idx -> count of preceding facing rays
  let filled = 0;
  const targetCells = Math.floor(W * H * opts.targetFill);

  for (let k = 0; k < opts.maxArrows; k++) {
    if (filled >= targetCells) break;
    let arrow = placeOne(W, H, grid, rand, opts, rayMap);
    // Fallback: relax minLen to 2 when geometry gets tight, so we keep
    // filling the grid instead of giving up early. We only do this once
    // per placement attempt.
    if (!arrow && opts.minLen > 2) {
      arrow = placeOne(W, H, grid, rand, { ...opts, minLen: 2 }, rayMap);
    }
    if (!arrow) break;
    for (const [x, y] of arrow.path) {
      grid[idx(x, y)] = 1;
      rayMap.delete(idx(x, y)); // cell is now occupied, no longer a "blocker-needed" cell
      filled++;
    }
    recordRay(arrow, W, H, grid, rayMap);
    arrows.push(arrow);
  }

  // arrows is in construction order (A_n, A_{n-1}, …, A_1); flip to escape order.
  arrows.reverse();

  // Patch fill: extend tails into adjacent empty cells, preferring cells
  // that block currently-init-escapable arrows.
  const tailAdded = extendTails(W, H, grid, arrows, rand);
  filled += tailAdded;

  return { arrows, fillRate: filled / (W * H), tailAdded };
}

function buildRawLevel(W, H, arrows) {
  return {
    width: W,
    height: H,
    coord_system: "row-major, origin top-left, y-down",
    arrows: arrows.map(({ path, facing }) => ({
      start: [path[0][0], path[0][1]],
      facing: [facing[0], facing[1]],
      path: path.map(([x, y]) => [x, y]),
    })),
  };
}

// --- Verification & quality filters ---------------------------------------

// Sanity check: simulate the construction order. Should always succeed —
// if it ever fails, the algorithm has a model bug.
function verify(raw) {
  const data = loadLevel(raw);
  const state = createGame(data);
  for (let i = 0; i < state.arrows.length; i++) {
    const r = tryPull(state, i);
    if (!r.escaped) {
      return {
        ok: false,
        reason: `arrow ${i}/${state.arrows.length} stuck (steps=${r.steps})`,
      };
    }
  }
  if (state.status !== "won") return { ok: false, reason: "not won after all pulls" };
  return { ok: true };
}

// How many arrows can escape from the INITIAL state without anyone else
// having moved? Counted geometrically — same predicate we used during
// placement. A level where every arrow can escape independently is a
// puzzle in name only; we want most arrows initially blocked.
// Initial-blocker stats. Walks each arrow's facing ray and records the first
// arrow that blocks it (if any). From the blocker mapping we derive:
//   initEsc        — count of arrows with no blocker (can pull straight away)
//   bottleneck     — count of arrows that block ≥ 2 other arrows (keystones)
//   chainDepth     — longest chain in the blocker DAG; depth 1 means init-
//                    escapable, depth k means k-1 arrows must clear first.
//                    Mirrors the same metric in quality-eval.mjs.
function computeBlockerStats(raw) {
  const W = raw.width;
  const H = raw.height;
  const n = raw.arrows.length;
  const grid = new Map();
  for (let i = 0; i < n; i++) {
    for (const [x, y] of raw.arrows[i].path) grid.set(`${x},${y}`, i);
  }
  const blocksCount = new Array(n).fill(0);
  const blockedBy = new Array(n).fill(-1);
  let initEsc = 0;
  for (let i = 0; i < n; i++) {
    const a = raw.arrows[i];
    const [sx, sy] = a.start;
    const [fx, fy] = a.facing;
    let cx = sx + fx;
    let cy = sy + fy;
    let blocker = -1;
    while (cx >= 0 && cx < W && cy >= 0 && cy < H) {
      const owner = grid.get(`${cx},${cy}`);
      if (owner !== undefined && owner !== i) {
        blocker = owner;
        break;
      }
      cx += fx;
      cy += fy;
    }
    if (blocker < 0) initEsc++;
    else {
      blocksCount[blocker]++;
      blockedBy[i] = blocker;
    }
  }
  let bottleneck = 0;
  for (const c of blocksCount) if (c >= 2) bottleneck++;
  const depth = new Array(n).fill(0);
  const visit = (i, stack) => {
    if (depth[i] > 0) return depth[i];
    if (stack.has(i)) return n;
    stack.add(i);
    const b = blockedBy[i];
    const d = b < 0 ? 1 : 1 + visit(b, stack);
    stack.delete(i);
    depth[i] = d;
    return d;
  };
  let chainDepth = 0;
  for (let i = 0; i < n; i++) chainDepth = Math.max(chainDepth, visit(i, new Set()));
  return { initEsc, bottleneck, chainDepth };
}

// Realistic-rollout deadlock probe. The construction guarantees a solution
// exists, but a human player may pull an arrow that only partially advances
// (head bumps a body mid-path). Once those partial pulls accumulate, the
// state can become unreachable for any escape order — the game becomes
// "softlocked" even though it was solvable from the start.
//
// We model the worst kind of player: at each step pick UNIFORMLY among all
// arrows that move at all (including partials). If a non-trivial fraction
// of rollouts ends with some arrows permanently stuck, the level is
// player-hostile and we reject it.
function deadlockRate(raw, trials, rand) {
  const data = loadLevel(raw);
  const state = createGame(data);
  let deadlocks = 0;
  for (let t = 0; t < trials; t++) {
    // Reset state.
    for (let i = 0; i < state.arrows.length; i++) {
      state.arrows[i].escaped = false;
      state.arrows[i].progress = 0;
    }
    state.status = "playing";

    while (true) {
      const movable = [];
      for (let i = 0; i < state.arrows.length; i++) {
        if (state.arrows[i].escaped) continue;
        const snap = snapshot(state);
        const r = tryPull(state, i);
        const moved = r.steps > 0 || r.escaped;
        restore(state, snap);
        if (moved) movable.push(i);
      }
      if (movable.length === 0) {
        const stuck = state.arrows.some((a) => !a.escaped);
        if (stuck) deadlocks++;
        break;
      }
      const pick = movable[Math.floor(rand() * movable.length)];
      tryPull(state, pick);
    }
  }
  return deadlocks / trials;
}

// --- CLI -------------------------------------------------------------------

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = a.match(/^--([\w-]+)(?:=(.+))?$/);
    if (m) out[m[1]] = m[2] ?? "true";
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const W = Number(args.w ?? 10);
const H = Number(args.h ?? 10);
const baseSeed = Number(args.seed ?? 1);
const count = Number(args.count ?? 5);
const targetFill = Number(args["target-fill"] ?? 0.85);
const minLen = Number(args["min-arrow-len"] ?? 3);
const maxLen = Number(args["max-arrow-len"] ?? 12);
const maxArrows = Number(args["max-arrows"] ?? 300);
const maxAttempts = Number(args["max-attempts"] ?? 20);
const minSequencing = Number(args["min-sequencing"] ?? 0.5);
const minChainDepth = Number(args["min-chain-depth"] ?? 0);
const minBottleneck = Number(args["min-bottleneck"] ?? 0);
const rayBias = Number(args["ray-bias"] ?? 0.95);
const straightBias = Number(args["straight-bias"] ?? 0.65);
const maxDeadlockRate = Number(args["max-deadlock-rate"] ?? 0.05);
const rolloutTrials = Number(args["rollout-trials"] ?? 100);
const outDir =
  args.out === undefined ? null : args.out === "true" ? DEFAULT_OUT : resolve(args.out);

const opts = { minLen, maxLen, targetFill, straightBias, rayBias, maxArrows };

if (outDir) mkdirSync(outDir, { recursive: true });

console.error(
  `[reverse] generating up to ${count} level(s) on ${W}×${H}, seed=${baseSeed}, targetFill=${targetFill}` +
    (outDir ? `, out=${outDir}` : ""),
);

let produced = 0;
let attempts = 0;
const rejects = {
  "too few arrows": 0,
  "verify failed (BUG)": 0,
  "too trivial (low sequencing)": 0,
  "shallow forced-chain (--min-chain-depth)": 0,
  "too few keystones (--min-bottleneck)": 0,
  "player-hostile (high deadlock rate)": 0,
};

while (produced < count && attempts < maxAttempts * count) {
  attempts++;
  const rand = mulberry32(baseSeed + attempts * 1009);
  const { arrows, fillRate } = generate(W, H, rand, opts);
  if (arrows.length < 2) {
    rejects["too few arrows"]++;
    continue;
  }
  const raw = buildRawLevel(W, H, arrows);
  const v = verify(raw);
  if (!v.ok) {
    rejects["verify failed (BUG)"]++;
    console.error(`  WARN verify failed (means construction has a model bug): ${v.reason}`);
    continue;
  }
  const { initEsc, bottleneck, chainDepth } = computeBlockerStats(raw);
  const escFrac = initEsc / arrows.length;
  if (escFrac > minSequencing) {
    rejects["too trivial (low sequencing)"]++;
    continue;
  }
  if (chainDepth < minChainDepth) {
    rejects["shallow forced-chain (--min-chain-depth)"]++;
    continue;
  }
  const bottleneckFrac = bottleneck / arrows.length;
  if (bottleneckFrac < minBottleneck) {
    rejects["too few keystones (--min-bottleneck)"]++;
    continue;
  }
  // Deterministic per-candidate seed so the deadlock probe is reproducible.
  const probeRand = mulberry32(baseSeed * 7919 + attempts);
  const dlRate = deadlockRate(raw, rolloutTrials, probeRand);
  if (dlRate > maxDeadlockRate) {
    rejects["player-hostile (high deadlock rate)"]++;
    continue;
  }
  produced++;
  const label = `gen_rev_w${W}h${H}_s${baseSeed}_n${String(produced).padStart(3, "0")}`;
  const meta = `arrows=${raw.arrows.length} fill=${(fillRate * 100).toFixed(0)}% initEsc=${initEsc}/${raw.arrows.length} chainDepth=${chainDepth} bottleneck=${bottleneck}/${raw.arrows.length} deadlockRate=${(dlRate * 100).toFixed(1)}%`;
  if (outDir) {
    const fpath = resolve(outDir, `${label}.json`);
    writeFileSync(fpath, JSON.stringify(raw));
    console.error(`  wrote ${label}.json (${meta})`);
  } else {
    console.log(JSON.stringify({ label, meta, raw }));
  }
}

console.error(
  `done: ${produced}/${count} produced in ${attempts} attempts. Rejects: ${JSON.stringify(rejects)}`,
);

if (produced < count) {
  console.error(
    `hint: relax --min-sequencing (current ${minSequencing}), --min-chain-depth (${minChainDepth}), --min-bottleneck (${minBottleneck}); bump --max-attempts; or pick a different seed`,
  );
  process.exit(produced === 0 ? 1 : 0);
}
