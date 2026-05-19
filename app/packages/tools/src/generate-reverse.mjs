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
//   --max-arrow-len    maximum path length per arrow (default 30)
//   --max-arrows       hard cap on arrows per level (default 300)
//   --max-attempts     give up after this many candidates per requested level (default 20)
//   --min-sequencing   require initial-escapable arrows < arrows × this fraction
//                      (default 0.5 — i.e. at least half the arrows must be initially blocked)
//   --out              output dir, or stdout JSONL if omitted

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createGame, loadLevel, tryPull } from "./_solver.mjs";

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
        // Forward ray must be all empty (excluding path[0] itself).
        let cx = x + fx;
        let cy = y + fy;
        let clear = true;
        while (inGrid(cx, cy)) {
          if (!isEmpty(cx, cy)) {
            clear = false;
            break;
          }
          cx += fx;
          cy += fy;
        }
        if (!clear) continue;
        // path[1] candidate cell.
        const bx = x - fx;
        const by = y - fy;
        if (!inGrid(bx, by) || !isEmpty(bx, by)) continue;
        out.push({ start: [x, y], facing: [fx, fy], second: [bx, by] });
      }
    }
  }
  return out;
}

// --- Path extension --------------------------------------------------------

// Extend `path` by a constrained random walk through empty cells with a
// straight-line bias. Mutates `path` and `used`.
function extendPath(path, used, W, H, grid, rand, opts) {
  const { minLen, maxLen, straightBias } = opts;
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
    if (lastDir && rand() < straightBias) {
      const straight = free.find((d) => d[0] === lastDir[0] && d[1] === lastDir[1]);
      pick = straight ?? free[Math.floor(rand() * free.length)];
    } else {
      pick = free[Math.floor(rand() * free.length)];
    }
    const nx = hx + pick[0];
    const ny = hy + pick[1];
    path.push([nx, ny]);
    used.add(idx(nx, ny));
    lastDir = pick;
  }
}

// Place one arrow into the grid. Iterates over shuffled anchors and accepts
// the first whose path can be extended to at least minLen.
function placeOne(W, H, grid, rand, opts) {
  const anchors = collectAnchors(W, H, grid);
  if (anchors.length === 0) return null;
  shuffleInPlace(anchors, rand);

  const idx = (x, y) => y * W + x;
  for (const { start, facing, second } of anchors) {
    const path = [start, second];
    const used = new Set([idx(start[0], start[1]), idx(second[0], second[1])]);
    extendPath(path, used, W, H, grid, rand, opts);
    if (path.length >= opts.minLen) {
      return { start, facing, path };
    }
  }
  return null;
}

// --- Top-level construction ------------------------------------------------

function generate(W, H, rand, opts) {
  const grid = new Uint8Array(W * H);
  const idx = (x, y) => y * W + x;
  const arrows = []; // placed in reverse escape order
  let filled = 0;
  const targetCells = Math.floor(W * H * opts.targetFill);

  for (let k = 0; k < opts.maxArrows; k++) {
    if (filled >= targetCells) break;
    const arrow = placeOne(W, H, grid, rand, opts);
    if (!arrow) break;
    for (const [x, y] of arrow.path) {
      grid[idx(x, y)] = 1;
      filled++;
    }
    arrows.push(arrow);
  }

  // arrows is in construction order (A_n, A_{n-1}, …, A_1); flip to escape order.
  arrows.reverse();
  return { arrows, fillRate: filled / (W * H) };
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
function countInitialEscapable(raw) {
  const W = raw.width;
  const H = raw.height;
  const grid = new Map();
  for (let i = 0; i < raw.arrows.length; i++) {
    for (const [x, y] of raw.arrows[i].path) grid.set(`${x},${y}`, i);
  }
  let count = 0;
  for (let i = 0; i < raw.arrows.length; i++) {
    const a = raw.arrows[i];
    const [sx, sy] = a.start;
    const [fx, fy] = a.facing;
    let cx = sx + fx;
    let cy = sy + fy;
    let blocked = false;
    while (cx >= 0 && cx < W && cy >= 0 && cy < H) {
      const owner = grid.get(`${cx},${cy}`);
      if (owner !== undefined && owner !== i) {
        blocked = true;
        break;
      }
      cx += fx;
      cy += fy;
    }
    if (!blocked) count++;
  }
  return count;
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
const maxLen = Number(args["max-arrow-len"] ?? 30);
const maxArrows = Number(args["max-arrows"] ?? 300);
const maxAttempts = Number(args["max-attempts"] ?? 20);
const minSequencing = Number(args["min-sequencing"] ?? 0.5);
const outDir =
  args.out === undefined ? null : args.out === "true" ? DEFAULT_OUT : resolve(args.out);

const opts = { minLen, maxLen, targetFill, straightBias: 0.65, maxArrows };

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
  const initEsc = countInitialEscapable(raw);
  const escFrac = initEsc / arrows.length;
  if (escFrac > minSequencing) {
    rejects["too trivial (low sequencing)"]++;
    continue;
  }
  produced++;
  const label = `gen_rev_w${W}h${H}_s${baseSeed}_n${String(produced).padStart(3, "0")}`;
  const meta = `arrows=${raw.arrows.length} fill=${(fillRate * 100).toFixed(0)}% initEsc=${initEsc}/${raw.arrows.length}`;
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
    `hint: relax --min-sequencing (current ${minSequencing}), bump --max-attempts, or pick a different seed`,
  );
  process.exit(produced === 0 ? 1 : 0);
}
