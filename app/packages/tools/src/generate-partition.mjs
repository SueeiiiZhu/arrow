// Partition-then-topo-sort procedural level generator (v2).
//
// Sibling to generate-reverse.mjs. Different construction primitive:
//   1. Path-partition the grid — repeatedly grow a self-avoiding path from
//      a random empty cell until target fill is reached. Each path is one
//      arrow's body (geometry only; no facing yet). Reject a path whose
//      both endpoint facing rays would self-cross another cell of the same
//      path (U-bend snake-walk self-collision; see facingCandidates).
//   2. Jointly assign facing + escape order via Kahn-style topo construction
//      (assignFacings / assignFacingsOnce). At each step pick a path whose
//      at-least-one facing has ALL ray-blockers already escaped, prefer the
//      "blocked" facing over the open-ray one (modulated by --init-esc-rate)
//      to maximize sequencing. Choosing facing and order jointly means we
//      never produce a cycle in the blocker DAG — Phase 3 here doesn't exist
//      as a separate step. If the remaining unpicked paths form a strongly
//      connected component (no facing of any of them is unblocked), we
//      restart with a fresh tie-break (`--kahn-retries=N`).
//   3. **Geometric backtracking** (v2 addition): if Kahn deadlocks even after
//      retries, undo the last `--backtrack-chunk` paths from the partition
//      and regrow with the same PRNG (which has advanced, so re-grown paths
//      differ in shape). Repeat up to `--max-backtracks` times per candidate
//      before rejecting. v1 had no backtracking — at 25×31 it deadlocked on
//      ~67 % of candidates because random partitions tend to form
//      unbreakable SCCs in the blocker DAG; v2 backtracking pushes yield
//      close to 1.
//   4. extendTails greedily extends path tails into free cells to lift fill.
//   5. Verify via tryPull (real snake-walk engine, ground truth).
//
// Why this primitive can beat reverse: reverse forbids placing a new arrow
// whose ray crosses any previously placed body, which caps fill around 85 %
// on 25×31. Partition-first only commits to facings AFTER the geometry is
// pinned, so paths may freely cross other paths' rays — fill is bounded by
// path-growing efficiency, not by the ray-clearance constraint.
//
// Output goes to --out=<dir> (default packages/tools/generated/) and MUST
// NEVER be moved into levels_data/ (legal hygiene boundary; see
// packages/tools/README.md and ../../README.md).
//
// CLI mirrors generate-reverse.mjs where flags overlap; partition-specific:
//   --kahn-retries=20    Phase-2 retry budget when paths get stuck in SCC
//   --max-backtracks=20  Phase-1 geometric-backtrack budget per candidate
//   --backtrack-chunk=3  How many trailing paths to undo per backtrack step
//   --init-esc-rate=0.1  Tie-break bias toward open-ray facings (lower = more
//                        sequenced; 0 = strict, only pick open when forced)
// (No --chain-target / --chain-min: chain emerges from partition geometry.)

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

// --- Phase 1: path-partition ----------------------------------------------

// Grow a single self-avoiding path from a random empty seed cell. Returns
// the path or null if no path of length >= minLen could be grown.
function growPath(W, H, grid, rand, opts) {
  const idx = (x, y) => y * W + x;
  const inGrid = (x, y) => x >= 0 && x < W && y >= 0 && y < H;
  const isEmpty = (x, y) => grid[idx(x, y)] === 0;
  const { minLen, maxLen, straightBias, longTailFrac, longTailMax } = opts;

  const seeds = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (isEmpty(x, y)) seeds.push([x, y]);
    }
  }
  if (seeds.length === 0) return null;
  shuffleInPlace(seeds, rand);

  for (const seed of seeds) {
    const path = [seed];
    const used = new Set([idx(seed[0], seed[1])]);
    // Length-distribution mixture: with probability longTailFrac, target a
    // length in [maxLen, longTailMax] — this gives the path-len distribution
    // a heavy tail closer to corpus (corpus p90=27 vs our p90=16 when every
    // path is capped at maxLen=18). Most paths still target [minLen, maxLen]
    // so structural metrics (chainDepth, bottleneck) stay stable. The walk's
    // hard cap is also lifted to longTailMax for long-tail paths only.
    const isLongTail = longTailFrac > 0 && longTailMax > maxLen && rand() < longTailFrac;
    const targetLen = isLongTail
      ? maxLen + Math.floor(rand() * (longTailMax - maxLen + 1))
      : minLen + Math.floor(rand() * (maxLen - minLen + 1));
    const walkCap = isLongTail ? longTailMax : maxLen;
    let lastDir = null;
    while (path.length < walkCap) {
      const [hx, hy] = path[path.length - 1];
      const free = DIRS.filter(([dx, dy]) => {
        const nx = hx + dx;
        const ny = hy + dy;
        return inGrid(nx, ny) && isEmpty(nx, ny) && !used.has(idx(nx, ny));
      });
      if (free.length === 0) break;
      if (path.length >= targetLen && rand() < 0.4) break;
      let pick = null;
      if (lastDir && rand() < straightBias) {
        pick = free.find((d) => d[0] === lastDir[0] && d[1] === lastDir[1]) ?? null;
      }
      if (!pick) pick = free[Math.floor(rand() * free.length)];
      const nx = hx + pick[0];
      const ny = hy + pick[1];
      path.push([nx, ny]);
      used.add(idx(nx, ny));
      lastDir = pick;
    }
    if (path.length >= minLen) return path;
  }
  return null;
}

// growUntilTarget runs the inner growth loop against an existing partial
// state (grid + paths + filled). Returns the updated filled count. Stops
// when target reached, maxArrows hit, or maxFailures consecutive grow
// attempts in a row produce a U-bend reject (or growPath returns null).
function growUntilTarget(W, H, grid, paths, filled, targetCells, rand, opts) {
  const idx = (x, y) => y * W + x;
  let failuresSinceProgress = 0;
  const maxFailures = 30;
  while (filled < targetCells) {
    const path = growPath(W, H, grid, rand, opts);
    if (!path) break;
    const pathId = paths.length + 1;
    // Tentatively place on grid so facingCandidates can see it.
    for (const [x, y] of path) grid[idx(x, y)] = pathId;
    const cands = facingCandidates(path, W, H, grid, pathId);
    // Reject U-bend self-collision (no surviving facing candidates) and —
    // after a small grace period to seed the partition — paths whose BOTH
    // facing rays escape the grid without crossing any other path. Such
    // "isolated" paths are guaranteed init-escapable in the final puzzle
    // (neither facing has a blocker), and the post-construction filter
    // can't fix this — the geometry has to be avoided up front. Grace
    // period: skip the check for the first 5 paths so partition can boot.
    const isolated = paths.length >= 5 && cands.every((c) => c.allBlockers.length === 0);
    if (cands.length === 0 || isolated) {
      for (const [x, y] of path) grid[idx(x, y)] = 0;
      failuresSinceProgress++;
      if (failuresSinceProgress >= maxFailures) break;
      continue;
    }
    filled += path.length;
    paths.push(path);
    failuresSinceProgress = 0;
    if (paths.length >= opts.maxArrows) break;
  }
  return filled;
}

// partition + Kahn under one search loop with **targeted** geometric
// backtracking. When Kahn deadlocks, the unpicked paths are exactly the
// SCC core in the blocker DAG — undoing those (and only those) breaks the
// cycle. Surviving picked paths keep their geometry. Re-stamp the grid
// pathIds because path indices shift when we splice. Bounded by
// `maxBacktracks`; on exhaustion return null so the CLI loop can try a
// fresh seed. If `backtrackChunk > 0`, also undo `backtrackChunk` of the
// most recently *picked* paths each round — this perturbs the boundary
// of the surviving core so re-growth lands in different geometry, not
// just identical refills of the same holes.
function partitionWithBacktrack(W, H, rand, opts) {
  const idx = (x, y) => y * W + x;
  const grid = new Uint8Array(W * H);
  const paths = [];
  let filled = 0;
  const targetCells = Math.floor(W * H * opts.targetFill);
  const maxBacktracks = opts.maxBacktracks ?? 20;
  const backtrackChunk = opts.backtrackChunk ?? 3;
  let backtracks = 0;

  const stampGrid = () => {
    grid.fill(0);
    for (let i = 0; i < paths.length; i++) {
      const newId = i + 1;
      for (const [x, y] of paths[i]) grid[idx(x, y)] = newId;
    }
  };

  while (true) {
    filled = growUntilTarget(W, H, grid, paths, filled, targetCells, rand, opts);
    if (paths.length < 2) return null;
    const r = assignFacings(paths, W, H, grid, rand, opts);
    if (r.escapeOrder.length === paths.length) {
      return { paths, grid, filled, arrows: r.arrows, escapeOrder: r.escapeOrder };
    }
    if (backtracks >= maxBacktracks) {
      if (opts.debug) {
        const stuck = paths.length - r.escapeOrder.length;
        console.error(
          `  [debug] backtrack budget hit: ${stuck}/${paths.length} stuck after ${backtracks} backtracks`,
        );
      }
      return null;
    }
    backtracks++;
    // Targeted undo: drop the SCC core (unpicked paths).
    const pickedSet = new Set(r.escapeOrder);
    const surviving = [];
    let removed = 0;
    for (let i = 0; i < paths.length; i++) {
      if (pickedSet.has(i)) surviving.push(paths[i]);
      else removed++;
    }
    paths.length = 0;
    paths.push(...surviving);
    // Boundary perturbation: also drop the last `backtrackChunk` picked
    // paths so the re-grown geometry near the SCC is fresh, not just
    // refilling identical holes.
    const extraUndo = Math.min(backtrackChunk, paths.length);
    for (let u = 0; u < extraUndo; u++) paths.pop();
    // Recompute filled + re-stamp grid pathIds (indices shifted).
    filled = 0;
    for (const p of paths) filled += p.length;
    stampGrid();
    if (opts.debug) {
      console.error(
        `  [debug] backtrack ${backtracks}: removed ${removed} SCC + ${extraUndo} boundary; surviving ${paths.length}, fill=${filled}`,
      );
    }
  }
}

// --- Phase 2: facing assignment -------------------------------------------

// For a given path, compute both candidate facings (head at start vs end).
// Each candidate records ALL other-path indices encountered on the facing
// ray (any one of them, if still on the board when this arrow tries to
// escape, will block it — so they're all topological prerequisites). A
// candidate is rejected if the head's facing ray crosses any cell of the
// same path — that's a snake-walk self-collision (head moves in a straight
// line along facing while the body snakes; a U-bend that loops back into
// the ray blocks the head before the colliding body segment can vacate).
function facingCandidates(path, W, H, grid, pathId) {
  const idx = (x, y) => y * W + x;
  const cands = [];
  for (const headIdx of [0, path.length - 1]) {
    const oriented = headIdx === 0 ? path : path.slice().reverse();
    const [hx, hy] = oriented[0];
    const [sx, sy] = oriented[1];
    const facing = [hx - sx, hy - sy];
    let cx = hx + facing[0];
    let cy = hy + facing[1];
    let selfCrossing = false;
    const blockers = []; // path indices in order encountered
    const seen = new Set();
    while (cx >= 0 && cx < W && cy >= 0 && cy < H) {
      const owner = grid[idx(cx, cy)];
      if (owner === pathId) {
        selfCrossing = true;
        break;
      }
      if (owner !== 0 && !seen.has(owner)) {
        seen.add(owner);
        blockers.push(owner - 1); // path index
      }
      cx += facing[0];
      cy += facing[1];
    }
    if (selfCrossing) continue;
    cands.push({
      oriented,
      facing,
      firstBlockerPath: blockers.length > 0 ? blockers[0] : -1,
      allBlockers: blockers,
    });
  }
  return cands;
}

// Assign facings via Kahn-style topo construction:
//   - At each step, find a path whose at-least-one facing candidate's
//     allBlockers are all already in the "escaped" set (i.e. picked).
//   - Mark that path as picked with that facing; add it to escape order.
//   - Repeat until all paths picked or no progress.
//
// This is fundamentally different from "assign facings then topo sort":
// we choose facing and escape order JOINTLY, so we never produce a cycle
// in the first place. The cost is that a partition geometry where every
// remaining path's both facings still depend on unpicked peers becomes
// stuck — but unpicked SCCs can often be broken by retrying with a
// shuffled tie-break order, since which facing got committed early
// determines the dependency chain. We try up to `opts.kahnRetries` random
// restarts before giving up on this partition.
function assignFacingsOnce(allCands, rand, opts) {
  const N = allCands.length;
  const picked = new Uint8Array(N);
  const arrows = new Array(N).fill(null);
  const escapeOrder = [];

  // Among the path's pickable facings, prefer the one with MORE blockers.
  // Both cands satisfy the topo constraint (all their blockers are already
  // picked = will be escaped before this path); choosing the one with more
  // blockers means this path's ray initially crosses more arrow bodies, so
  // it's NOT init-escapable in the final puzzle. Empirically this is the
  // dominant lever on init-escapable %: just respecting the topo order isn't
  // enough — the partition geometry often gives both endpoints a clear ray
  // (one because it points off-grid, the other because its blockers all happen
  // to be picked already), and picking the off-grid endpoint leaks an
  // init-escapable arrow.
  const canPick = (i) => {
    let best = null;
    let bestBlockers = -1;
    for (const c of allCands[i]) {
      let ok = true;
      for (const b of c.allBlockers) {
        if (!picked[b]) {
          ok = false;
          break;
        }
      }
      if (ok && c.allBlockers.length > bestBlockers) {
        best = c;
        bestBlockers = c.allBlockers.length;
      }
    }
    return best;
  };

  let progress = true;
  while (progress) {
    progress = false;
    const pickable = [];
    for (let i = 0; i < N; i++) {
      if (picked[i]) continue;
      const c = canPick(i);
      if (c) pickable.push({ i, cand: c });
    }
    if (pickable.length === 0) break;
    const blocked = pickable.filter((p) => p.cand.firstBlockerPath >= 0);
    const open = pickable.filter((p) => p.cand.firstBlockerPath < 0);
    let chosenPool;
    if (blocked.length > 0 && (open.length === 0 || rand() >= opts.initEscRate)) {
      chosenPool = blocked;
    } else if (open.length > 0) {
      chosenPool = open;
    } else {
      chosenPool = pickable;
    }
    const pick = chosenPool[Math.floor(rand() * chosenPool.length)];
    const { i, cand } = pick;
    arrows[i] = {
      pathIdx: i,
      orientedPath: cand.oriented,
      facing: cand.facing,
      allBlockers: cand.allBlockers.slice(),
      alternative: allCands[i].find((c) => c !== cand) ?? null,
    };
    picked[i] = 1;
    escapeOrder.push(i);
    progress = true;
  }
  return { arrows, escapeOrder };
}

function assignFacings(paths, W, H, grid, rand, opts) {
  const allCands = paths.map((p, i) => facingCandidates(p, W, H, grid, i + 1));
  let best = null;
  for (let t = 0; t < (opts.kahnRetries || 1); t++) {
    const r = assignFacingsOnce(allCands, rand, opts);
    if (r.escapeOrder.length === paths.length) return r;
    if (!best || r.escapeOrder.length > best.escapeOrder.length) best = r;
  }
  return best;
}

// --- Phase 3: ray bookkeeping for extendTails ------------------------------
//
// extendTails wants `arrows` in escape order and grid in {0, 1} (path cells
// = 1). Convert from our internal state.

function arrowsToRawForm(arrows, escapeOrder) {
  return escapeOrder.map((i) => ({
    start: arrows[i].orientedPath[0],
    facing: arrows[i].facing,
    path: arrows[i].orientedPath,
  }));
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

// --- Top-level generate ----------------------------------------------------

function generate(W, H, rand, opts) {
  // Phase 1+2+3: grow partition + jointly assign facings/escape-order via
  // Kahn, backtracking the partition geometry when Kahn deadlocks.
  const result = partitionWithBacktrack(W, H, rand, opts);
  if (!result) return null;
  const { paths, grid, filled, arrows, escapeOrder } = result;
  if (paths.length < 2 || escapeOrder.length < 2) return null;
  // Phase 4: convert and extend tails
  const ordered = arrowsToRawForm(arrows, escapeOrder);
  // For extendTails we need a {0,1} grid (path cells = 1), not {0, pathId}.
  const flatGrid = new Uint8Array(W * H);
  for (let i = 0; i < grid.length; i++) flatGrid[i] = grid[i] === 0 ? 0 : 1;
  const tailAdded = extendTails(W, H, flatGrid, ordered, rand);

  // Chain achieved: longest dependency chain in the blocker DAG.
  let chainAchieved = 0;
  const depthCache = new Array(arrows.length).fill(0);
  function chainAt(i, stack) {
    if (depthCache[i] > 0) return depthCache[i];
    if (stack.has(i)) return arrows.length;
    stack.add(i);
    let maxDep = 0;
    for (const b of arrows[i].allBlockers) {
      maxDep = Math.max(maxDep, chainAt(b, stack));
    }
    stack.delete(i);
    const d = 1 + maxDep;
    depthCache[i] = d;
    return d;
  }
  for (let i = 0; i < arrows.length; i++) {
    chainAchieved = Math.max(chainAchieved, chainAt(i, new Set()));
  }

  return {
    arrows: ordered,
    fillRate: (filled + tailAdded) / (W * H),
    tailAdded,
    chainAchieved,
  };
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
const targetFill = Number(args["target-fill"] ?? 0.95);
const minLen = Number(args["min-arrow-len"] ?? 3);
const maxLen = Number(args["max-arrow-len"] ?? 18);
const longTailFrac = Number(args["long-tail-frac"] ?? 0.15);
const longTailMax = Number(args["long-tail-max"] ?? 40);
const maxArrows = Number(args["max-arrows"] ?? 300);
const maxAttempts = Number(args["max-attempts"] ?? 40);
const minSequencing = Number(args["min-sequencing"] ?? 0.5);
const minChainDepth = Number(args["min-chain-depth"] ?? 0);
const minBottleneck = Number(args["min-bottleneck"] ?? 0);
const straightBias = Number(args["straight-bias"] ?? 0.65);
const initEscRate = Number(args["init-esc-rate"] ?? 0.1);
const maxDeadlockRate = Number(args["max-deadlock-rate"] ?? 0.3);
const rolloutTrials = Number(args["rollout-trials"] ?? 30);
const kahnRetries = Number(args["kahn-retries"] ?? 20);
const maxBacktracks = Number(args["max-backtracks"] ?? 20);
const backtrackChunk = Number(args["backtrack-chunk"] ?? 3);
const debug = args.debug === "true";
const outDir =
  args.out === undefined ? null : args.out === "true" ? DEFAULT_OUT : resolve(args.out);

const opts = {
  minLen,
  maxLen,
  longTailFrac,
  longTailMax,
  targetFill,
  straightBias,
  initEscRate,
  maxArrows,
  kahnRetries,
  maxBacktracks,
  backtrackChunk,
  debug,
};

if (outDir) mkdirSync(outDir, { recursive: true });

console.error(
  `[partition v2] generating up to ${count} level(s) on ${W}×${H}, seed=${baseSeed}, ` +
    `targetFill=${targetFill}, maxLen=${maxLen}, longTailFrac=${longTailFrac}, ` +
    `longTailMax=${longTailMax}, initEscRate=${initEscRate}, maxBacktracks=${maxBacktracks}` +
    (outDir ? `, out=${outDir}` : ""),
);

let produced = 0;
let attempts = 0;
const rejects = {
  "too few arrows": 0,
  "Kahn stuck after backtracking": 0,
  "verify failed (BUG)": 0,
  "too trivial (low sequencing)": 0,
  "shallow forced-chain (--min-chain-depth)": 0,
  "too few keystones (--min-bottleneck)": 0,
  "player-hostile (high deadlock rate)": 0,
};

while (produced < count && attempts < maxAttempts * count) {
  attempts++;
  const rand = mulberry32(baseSeed + attempts * 1009);
  const result = generate(W, H, rand, opts);
  if (!result) {
    rejects["Kahn stuck after backtracking"]++;
    continue;
  }
  const { arrows, fillRate, chainAchieved } = result;
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
  const probeRand = mulberry32(baseSeed * 7919 + attempts);
  const dlRate = deadlockRate(raw, rolloutTrials, probeRand);
  if (dlRate > maxDeadlockRate) {
    rejects["player-hostile (high deadlock rate)"]++;
    continue;
  }
  produced++;
  const label = `gen_part_w${W}h${H}_s${baseSeed}_n${String(produced).padStart(3, "0")}`;
  const meta = `arrows=${raw.arrows.length} fill=${(fillRate * 100).toFixed(0)}% initEsc=${initEsc}/${raw.arrows.length} chainDepth=${chainDepth} bottleneck=${bottleneck}/${raw.arrows.length} chainAchieved=${chainAchieved} deadlockRate=${(dlRate * 100).toFixed(1)}%`;
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
    "hint: lower --target-fill (current " +
      targetFill +
      "), raise --kahn-retries (current " +
      kahnRetries +
      "), or pick a different seed",
  );
  process.exit(produced === 0 ? 1 : 0);
}
