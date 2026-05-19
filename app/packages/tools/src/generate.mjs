// Procedural level generator: path-partition + facing assignment +
// solver-validated filter.
//
// Generated levels are written to `--out=<dir>` (default
// `packages/tools/generated/`) — they MUST NOT be moved into
// `levels_data/`, which is the original APK-derived corpus.
//
// CLI:
//   node src/generate.mjs --w=10 --h=10 --seed=1 --count=5 [--out=<dir>]
//   --w, --h           grid size (default 10x10)
//   --seed             PRNG seed (default 1)
//   --count            how many levels to attempt (default 5)
//   --target-fill      target fill density 0-1 (default 0.85; corpus median 0.96)
//   --min-arrow-len    minimum path length per arrow (default 2)
//   --max-arrow-len    maximum path length per arrow (default 30)
//   --max-attempts     give up after this many failed candidates (default 50)
//   --out              output directory; if omitted, prints one JSON per line
//                      to stdout. Will be created if missing.
//
// Algorithm (see HANDOFF "Procedural generator" section for the full story):
//   1. Path partition. Random-walk path-cover of the W×H grid: pick an
//      unoccupied cell, walk with a straight-line bias, stop when length
//      hits a random target in [minLen, maxLen]. Repeat until coverage
//      saturates. Cells that can't be reached become void.
//   2. Facing assignment. For each path, pick the end whose outward
//      direction has the SHORTER off-grid distance — that end becomes the
//      head. (`facing = path[0] − path[1]` by the engine's contract.)
//   3. Solver-validated filter. Run `greedy()`; reject if unsolvable. To
//      avoid trivial levels (every arrow exits in one independent pull),
//      we also require `moves.length > arrows.length` — meaning at least
//      one arrow had to be re-pulled after a body in its way escaped.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createGame, dfs, greedy, loadLevel } from "./_solver.mjs";

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

// --- Path partition ---------------------------------------------------------

const DIRS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

function partition(W, H, rand, opts) {
  const { minLen, maxLen, targetFill, straightBias } = opts;
  const idx = (x, y) => y * W + x;
  const inGrid = (x, y) => x >= 0 && x < W && y >= 0 && y < H;
  const occupied = new Uint8Array(W * H);

  // Border-first ordering: paths that start on an edge cell can immediately
  // exit by facing outward, breaking the deadlock cycles that random
  // partitions otherwise create. Interior cells are visited in a second wave
  // to mop up the rest.
  const border = [];
  const interior = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (x === 0 || y === 0 || x === W - 1 || y === H - 1) border.push([x, y]);
      else interior.push([x, y]);
    }
  }
  shuffleInPlace(border, rand);
  shuffleInPlace(interior, rand);
  const cells = [...border, ...interior];

  const paths = [];
  let occupiedCount = 0;

  for (const [sx, sy] of cells) {
    if (occupiedCount / (W * H) >= targetFill) break;
    if (occupied[idx(sx, sy)]) continue;

    const path = [[sx, sy]];
    occupied[idx(sx, sy)] = 1;
    occupiedCount++;
    let lastDir = null;
    const targetLen = minLen + Math.floor(rand() * (maxLen - minLen + 1));

    while (path.length < maxLen) {
      const [hx, hy] = path[path.length - 1];
      const free = DIRS.filter(([dx, dy]) => {
        const nx = hx + dx;
        const ny = hy + dy;
        return inGrid(nx, ny) && !occupied[idx(nx, ny)];
      });
      if (free.length === 0) break;

      let pick;
      if (lastDir && rand() < straightBias) {
        const straight = free.find((d) => d[0] === lastDir[0] && d[1] === lastDir[1]);
        pick = straight ?? free[Math.floor(rand() * free.length)];
      } else {
        pick = free[Math.floor(rand() * free.length)];
      }

      // Once we've hit the target length, increasing stop chance.
      if (path.length >= targetLen && rand() < 0.4) break;

      const nx = hx + pick[0];
      const ny = hy + pick[1];
      path.push([nx, ny]);
      occupied[idx(nx, ny)] = 1;
      occupiedCount++;
      lastDir = pick;
    }

    if (path.length >= minLen) {
      paths.push(path);
    } else {
      // Path too short — release its cells so a neighbour might reach them.
      // (Rare: only triggers when start cell had no free neighbour at all
      // and minLen > 1.)
      for (const [x, y] of path) {
        occupied[idx(x, y)] = 0;
        occupiedCount--;
      }
    }
  }

  return { paths, fillRate: occupiedCount / (W * H) };
}

// --- Facing assignment ------------------------------------------------------

function distToExit(x, y, fx, fy, W, H) {
  let steps = 0;
  let cx = x;
  let cy = y;
  while (cx >= 0 && cx < W && cy >= 0 && cy < H) {
    cx += fx;
    cy += fy;
    steps++;
    if (steps > Math.max(W, H) + 2) return Infinity;
  }
  return steps;
}

function assignFacing(path, W, H, rand) {
  if (path.length < 2) return null;
  const start = path[0];
  const second = path[1];
  const end = path[path.length - 1];
  const penult = path[path.length - 2];

  const sFacing = [start[0] - second[0], start[1] - second[1]];
  const eFacing = [end[0] - penult[0], end[1] - penult[1]];

  // "Exits immediately" = head + facing lands off-grid in one step.
  // These heads can escape without ever needing another body to clear out
  // of the way — drastically reducing the chance of a deadlock cycle.
  const sStepX = start[0] + sFacing[0];
  const sStepY = start[1] + sFacing[1];
  const eStepX = end[0] + eFacing[0];
  const eStepY = end[1] + eFacing[1];
  const sExits = sStepX < 0 || sStepX >= W || sStepY < 0 || sStepY >= H;
  const eExits = eStepX < 0 || eStepX >= W || eStepY < 0 || eStepY >= H;

  let useStart;
  if (sExits && !eExits) useStart = true;
  else if (eExits && !sExits) useStart = false;
  else if (sExits && eExits) useStart = rand() < 0.5;
  else {
    // Neither exits immediately — use shorter off-grid distance as tiebreak.
    const dS = distToExit(start[0], start[1], sFacing[0], sFacing[1], W, H);
    const dE = distToExit(end[0], end[1], eFacing[0], eFacing[1], W, H);
    useStart = dS <= dE ? rand() < 0.85 : rand() >= 0.85;
  }

  if (useStart) return { path, facing: sFacing };
  return { path: path.slice().reverse(), facing: eFacing };
}

// --- Build & validate a candidate level -------------------------------------

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

function evaluate(raw, dfsMs) {
  const data = loadLevel(raw);
  const state = createGame(data);
  const moves = [];
  let won = greedy(state, (id) => moves.push(id));
  if (!won && dfsMs > 0) {
    // Reset and try a bounded DFS — random partitions create death-loops that
    // greedy can't unwind but DFS often can. Cap by wall-clock to keep the
    // generator interactive.
    const fresh = createGame(data);
    moves.length = 0;
    try {
      won = dfs(fresh, new Set(), Date.now() + dfsMs, moves);
    } catch {
      won = false; // deadline hit
    }
  }
  if (!won) return { ok: false, reason: "unsolvable" };
  if (moves.length <= raw.arrows.length) {
    return { ok: false, reason: "trivial (no interaction)" };
  }
  return { ok: true, moves: moves.length, arrows: raw.arrows.length };
}

// --- One generation attempt -------------------------------------------------

function generateOne(W, H, rand, opts) {
  const { paths, fillRate } = partition(W, H, rand, opts);
  if (paths.length < 2) return { ok: false, reason: "too few paths" };

  const arrows = [];
  for (const p of paths) {
    const a = assignFacing(p, W, H, rand);
    if (a) arrows.push(a);
  }
  if (arrows.length < 2) return { ok: false, reason: "too few arrows after facing" };

  const raw = buildRawLevel(W, H, arrows);
  const ev = evaluate(raw, opts.dfsMs);
  if (!ev.ok) return { ok: false, reason: ev.reason, fillRate };
  return { ok: true, raw, moves: ev.moves, arrows: ev.arrows, fillRate };
}

// --- CLI --------------------------------------------------------------------

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
const minLen = Number(args["min-arrow-len"] ?? 2);
const maxLen = Number(args["max-arrow-len"] ?? 30);
const maxAttempts = Number(args["max-attempts"] ?? 50);
const outDir =
  args.out === undefined ? null : args.out === "true" ? DEFAULT_OUT : resolve(args.out);

const dfsMs = Number(args["dfs-ms"] ?? 200);
const opts = { minLen, maxLen, targetFill, straightBias: 0.65, dfsMs };

if (outDir) {
  mkdirSync(outDir, { recursive: true });
}

console.error(
  `generating up to ${count} level(s) on ${W}×${H}, seed=${baseSeed}, targetFill=${targetFill}` +
    (outDir ? `, out=${outDir}` : ""),
);

let produced = 0;
let attempts = 0;
const failBuckets = { unsolvable: 0, "trivial (no interaction)": 0, other: 0 };

while (produced < count && attempts < maxAttempts * count) {
  attempts++;
  const rand = mulberry32(baseSeed + attempts * 1009);
  const r = generateOne(W, H, rand, opts);
  if (!r.ok) {
    if (failBuckets[r.reason] !== undefined) failBuckets[r.reason]++;
    else failBuckets.other++;
    continue;
  }
  produced++;
  const label = `gen_w${W}h${H}_s${baseSeed}_n${String(produced).padStart(3, "0")}`;
  const meta = `arrows=${r.arrows} moves=${r.moves} fill=${(r.fillRate * 100).toFixed(0)}%`;
  if (outDir) {
    const fpath = resolve(outDir, `${label}.json`);
    writeFileSync(fpath, JSON.stringify(r.raw));
    console.error(`  wrote ${label}.json (${meta})`);
  } else {
    console.log(JSON.stringify({ label, meta, raw: r.raw }));
  }
}

console.error(
  `done: ${produced}/${count} produced in ${attempts} attempts. ` +
    `Rejects: ${JSON.stringify(failBuckets)}`,
);

if (produced < count) {
  console.error(`hint: try a different seed, larger grid, or relax --target-fill / --max-attempts`);
  process.exit(produced === 0 ? 1 : 0);
}
