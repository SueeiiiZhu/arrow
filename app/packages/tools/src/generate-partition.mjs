// Partition-first (chain-skeleton) procedural level generator.
//
// Sister to generate-reverse.mjs. The reverse generator is locally greedy
// — it picks anchors whose path[1] sits on a preceding arrow's facing ray,
// which produces medium chains but tops out below the corpus on the
// "forced-chain depth" + "bottleneck %" metrics (see HANDOFF.md and the
// `--preset=strict` comment in generate-reverse.mjs).
//
// This generator pre-commits to a chain skeleton of length K before doing
// the random fill. Concretely (still in reverse escape order, A_K → A_1):
//   1. Place A_K with any valid anchor (free choice).
//   2. For each subsequent A_{K-k} (k = 1..K-1) place an anchor whose
//      `start` cell sits on the immediately-previous arrow's facing ray.
//      Geometrically this means A_{K-k}'s head cell is on A_{K-k+1}'s
//      facing ray → A_{K-k}'s body blocks A_{K-k+1}'s head → the static
//      blocker DAG contains the edge A_{K-k+1} ← A_{K-k}. The skeleton is
//      a single chain by construction, so chainDepth ≥ K.
//   3. Fill the rest of the grid with the standard `placeOne` logic
//      copied from generate-reverse.mjs.
//   4. Reverse → escape order, then extendTails as usual.
//
// What partition-first DOES NOT do (v0 limitations):
//   - It doesn't plan a global partition of the grid into regions; the
//     "partition" label is aspirational. Region partitioning is the
//     planned v1.
//   - It doesn't try to maximize bottleneck % directly — only chainDepth.
//     Bottleneck % piggy-backs because every chain link is by definition
//     blocking exactly one other arrow; the keystones come from the
//     filler arrows happening to block multiple.
//
// HONEST v0 RESULT (measured 2026-05-21 on 25×31, count=30, seed=1):
//   metric              partition   reverse   corpus
//   chainDepth (med)        7          7        10
//   bottleneck %            11%        12%      26%
//   init-escapable %        31%        30%       9%
//   fill %                  85%        85%      97%
//   At every structural metric, partition v0 essentially TIES reverse
//   and is materially below corpus. The chain-skeleton phase is a
//   geometric LOCAL operation: each link constrains placement of the
//   next link, but the filler phase quickly converges to the same
//   distribution as the reverse-generator (same placeOne, same anchor
//   buckets). Cranking --target-fill above 0.85 doesn't help either:
//   the reverse-construction model has a topological cap (~85% fill
//   on 25×31, ~90% on smaller grids) because every new arrow's ray
//   must stay clear of all preceding-placed bodies.
//   So this file is currently a NEGATIVE RESULT documented in code:
//   the construction-primitive lever, as implemented, is not enough
//   to close the corpus gap. A genuine win likely needs either:
//     (a) Tile-then-topo-sort: pre-commit to a grid partition + facings,
//         then solve for an embedding (planned v1 below); OR
//     (b) Drop the strict snake-walk solvability guarantee at construction
//         time and run a search (e.g. SAT / SMT) over a richer state-space.
//   Keeping the script committed despite the null result so future
//   iterations can reuse `quality-eval --from-dir=…` and not redo this
//   experiment from scratch.
//
// Output goes to --out=<dir> (default packages/tools/generated/) and MUST
// NEVER be moved into levels_data/ (legal hygiene boundary; see
// packages/tools/README.md and ../../README.md).
//
// CLI mirrors generate-reverse.mjs; the partition-specific flag:
//   --chain-target=K   target chain length (default min(W, H), clamped 6..20)
//   --chain-min=K      reject candidate if achieved chain length < K
//                      (default = chain-target − 2)
// Other reject gates (--min-chain-depth, --min-bottleneck, --min-sequencing,
// --max-deadlock-rate) and shape knobs (--target-fill, --max-arrow-len,
// --ray-bias, --straight-bias) work the same as generate-reverse.

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

// --- Shared helpers (copy of generate-reverse.mjs internals; keep in sync) -

function collectAnchors(W, H, grid) {
  const idx = (x, y) => y * W + x;
  const inGrid = (x, y) => x >= 0 && x < W && y >= 0 && y < H;
  const isEmpty = (x, y) => grid[idx(x, y)] === 0;
  const out = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!isEmpty(x, y)) continue;
      for (const [fx, fy] of DIRS) {
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
        const bx = x - fx;
        const by = y - fy;
        if (!inGrid(bx, by) || !isEmpty(bx, by)) continue;
        out.push({ start: [x, y], facing: [fx, fy], second: [bx, by], rayLen });
      }
    }
  }
  return out;
}

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
  for (const { start, facing, second } of bucket[0].concat(bucket[1], bucket[2])) {
    const path = [start, second];
    const used = new Set([idx(start[0], start[1]), idx(second[0], second[1])]);
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

function recordRay(arrow, W, H, grid, rayMap, rayCells) {
  const idx = (x, y) => y * W + x;
  let cx = arrow.path[0][0] + arrow.facing[0];
  let cy = arrow.path[0][1] + arrow.facing[1];
  while (cx >= 0 && cx < W && cy >= 0 && cy < H) {
    const ci = idx(cx, cy);
    if (grid[ci] === 0) rayMap.set(ci, (rayMap.get(ci) || 0) + 1);
    if (rayCells) rayCells.push([cx, cy]);
    cx += arrow.facing[0];
    cy += arrow.facing[1];
  }
}

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
      if (initEsc.size > 0) {
        for (const k of initEsc) {
          if (rayByArrow[k].ray.has(ci)) initEsc.delete(k);
        }
      }
    }
  }
  return added;
}

// --- Partition-first construction ------------------------------------------

// Pick an anchor from `anchors` and turn it into a full arrow (with path
// extended). Returns null if no anchor yields path.length >= opts.minLen.
function buildArrowFromAnchor(anchors, W, H, grid, rand, opts, rayMap) {
  const idx = (x, y) => y * W + x;
  for (const { start, facing, second } of anchors) {
    const path = [start, second];
    const used = new Set([idx(start[0], start[1]), idx(second[0], second[1])]);
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

function generate(W, H, rand, opts) {
  const grid = new Uint8Array(W * H);
  const idx = (x, y) => y * W + x;
  const arrows = []; // reverse escape order
  const rayMap = new Map(); // empty cell idx → count of preceding facing rays
  const lastRayCells = []; // cells on the most-recently-placed arrow's ray
  let filled = 0;
  const targetCells = Math.floor(W * H * opts.targetFill);
  const { chainTarget } = opts;
  let chainAchieved = 0;

  // ---- Phase 1: chain skeleton ------------------------------------------
  //
  // Place A_K first (free anchor). For k = 1..chainTarget−1 require the
  // new arrow's head to sit on the previous arrow's facing ray cells that
  // are still empty in the grid. As soon as the constraint can't be
  // satisfied (geometry exhausted), break out and let phase 2 fill the
  // rest of the grid.
  for (let k = 0; k < chainTarget; k++) {
    let arrow;
    if (k === 0) {
      // First arrow: prefer anchors with rayLen ≥ 1 so phase 2 has somewhere
      // to anchor blockers. Shuffle so different seeds explore different
      // starting positions.
      const all = collectAnchors(W, H, grid);
      if (all.length === 0) break;
      const withRay = all.filter((a) => a.rayLen >= 1);
      const pool = withRay.length > 0 ? withRay : all;
      shuffleInPlace(pool, rand);
      arrow = buildArrowFromAnchor(pool, W, H, grid, rand, opts, rayMap);
    } else {
      // Constrained: head cell must be on the previous arrow's ray AND
      // currently empty. Also reject anchors whose `facing` is parallel and
      // opposite to the previous arrow's facing — that would mean the new
      // arrow shoots back along the same line, immediately reblocking the
      // previous arrow (would create a 2-cycle in the blocker DAG: A_{k-1}
      // blocks A_k via its body, A_k blocks A_{k-1} via its body on the ray).
      const all = collectAnchors(W, H, grid);
      if (all.length === 0) break;
      const allowed = new Set(lastRayCells.map(([x, y]) => idx(x, y)));
      const prevArrow = arrows[arrows.length - 1];
      const [pfx, pfy] = prevArrow.facing;
      const constrained = all.filter((a) => {
        if (!allowed.has(idx(a.start[0], a.start[1]))) return false;
        // Disallow facing exactly opposite of prev: that's the same line
        // and would create a mutual-block cycle.
        return !(a.facing[0] === -pfx && a.facing[1] === -pfy);
      });
      if (constrained.length === 0) break;
      shuffleInPlace(constrained, rand);
      arrow = buildArrowFromAnchor(constrained, W, H, grid, rand, opts, rayMap);
    }
    if (!arrow) break;
    for (const [x, y] of arrow.path) {
      grid[idx(x, y)] = 1;
      rayMap.delete(idx(x, y));
      filled++;
    }
    lastRayCells.length = 0;
    recordRay(arrow, W, H, grid, rayMap, lastRayCells);
    arrows.push(arrow);
    chainAchieved++;
  }

  // ---- Phase 2: random fill (same as generate-reverse) -------------------
  for (let k = 0; k < opts.maxArrows; k++) {
    if (filled >= targetCells) break;
    let arrow = placeOne(W, H, grid, rand, opts, rayMap);
    if (!arrow && opts.minLen > 2) {
      arrow = placeOne(W, H, grid, rand, { ...opts, minLen: 2 }, rayMap);
    }
    if (!arrow) break;
    for (const [x, y] of arrow.path) {
      grid[idx(x, y)] = 1;
      rayMap.delete(idx(x, y));
      filled++;
    }
    recordRay(arrow, W, H, grid, rayMap);
    arrows.push(arrow);
  }

  arrows.reverse();
  const tailAdded = extendTails(W, H, grid, arrows, rand);
  filled += tailAdded;

  return { arrows, fillRate: filled / (W * H), tailAdded, chainAchieved };
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

function verify(raw) {
  const data = loadLevel(raw);
  const state = createGame(data);
  for (let i = 0; i < state.arrows.length; i++) {
    const r = tryPull(state, i);
    if (!r.escaped) {
      return { ok: false, reason: `arrow ${i}/${state.arrows.length} stuck (steps=${r.steps})` };
    }
  }
  if (state.status !== "won") return { ok: false, reason: "not won after all pulls" };
  return { ok: true };
}

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

function deadlockRate(raw, trials, rand) {
  const data = loadLevel(raw);
  const state = createGame(data);
  let deadlocks = 0;
  for (let t = 0; t < trials; t++) {
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
        if (state.arrows.some((a) => !a.escaped)) deadlocks++;
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
const maxAttempts = Number(args["max-attempts"] ?? 40);
const minSequencing = Number(args["min-sequencing"] ?? 0.5);
const minChainDepth = Number(args["min-chain-depth"] ?? 0);
const minBottleneck = Number(args["min-bottleneck"] ?? 0);
const rayBias = Number(args["ray-bias"] ?? 0.95);
const straightBias = Number(args["straight-bias"] ?? 0.65);
const maxDeadlockRate = Number(args["max-deadlock-rate"] ?? 0.05);
const rolloutTrials = Number(args["rollout-trials"] ?? 100);
const chainTargetRaw = args["chain-target"];
const chainTarget =
  chainTargetRaw != null ? Number(chainTargetRaw) : Math.max(6, Math.min(20, Math.min(W, H)));
const chainMin =
  args["chain-min"] != null ? Number(args["chain-min"]) : Math.max(0, chainTarget - 2);
const outDir =
  args.out === undefined ? null : args.out === "true" ? DEFAULT_OUT : resolve(args.out);

const opts = { minLen, maxLen, targetFill, straightBias, rayBias, maxArrows, chainTarget };

if (outDir) mkdirSync(outDir, { recursive: true });

console.error(
  `[partition] generating up to ${count} level(s) on ${W}×${H}, seed=${baseSeed}, ` +
    `chainTarget=${chainTarget}, chainMin=${chainMin}, targetFill=${targetFill}` +
    (outDir ? `, out=${outDir}` : ""),
);

let produced = 0;
let attempts = 0;
const rejects = {
  "too few arrows": 0,
  "verify failed (BUG)": 0,
  "chain short of --chain-min": 0,
  "too trivial (low sequencing)": 0,
  "shallow forced-chain (--min-chain-depth)": 0,
  "too few keystones (--min-bottleneck)": 0,
  "player-hostile (high deadlock rate)": 0,
};

while (produced < count && attempts < maxAttempts * count) {
  attempts++;
  const rand = mulberry32(baseSeed + attempts * 1009);
  const { arrows, fillRate, chainAchieved } = generate(W, H, rand, opts);
  if (arrows.length < 2) {
    rejects["too few arrows"]++;
    continue;
  }
  if (chainAchieved < chainMin) {
    rejects["chain short of --chain-min"]++;
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
  const probeRand = mulberry32(baseSeed * 7919 + attempts);
  const dlRate = deadlockRate(raw, rolloutTrials, probeRand);
  if (dlRate > maxDeadlockRate) {
    rejects["player-hostile (high deadlock rate)"]++;
    continue;
  }
  produced++;
  const label = `gen_part_w${W}h${H}_s${baseSeed}_n${String(produced).padStart(3, "0")}`;
  const meta = `arrows=${raw.arrows.length} fill=${(fillRate * 100).toFixed(0)}% initEsc=${initEsc}/${raw.arrows.length} chainDepth=${chainDepth} bottleneck=${bottleneck}/${raw.arrows.length} chainBuilt=${chainAchieved}/${chainTarget} deadlockRate=${(dlRate * 100).toFixed(1)}%`;
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
    `hint: lower --chain-target (current ${chainTarget}) or --chain-min (${chainMin}); ` +
      `bump --max-attempts; or pick a different seed`,
  );
  process.exit(produced === 0 ? 1 : 0);
}
