// Quality evaluation: compare reverse-generated levels against a
// same-size corpus sample on a handful of "playability" metrics.
//
// Goal: answer "are the synthetic levels distributionally like real ones,
// or are they obvious in a way the original aren't?" — without anyone
// having to actually play hundreds of them.
//
// Metrics (per level):
//   arrows               total arrow count
//   fill                 cells covered / (W*H)
//   init-escapable %     fraction of arrows whose facing ray is initially
//                        clear of every other arrow (i.e. could be the
//                        player's first move). High = many parallel
//                        starting options = mechanically easier.
//   bottleneck %         fraction of arrows that initially block ≥ 2
//                        other arrows' facing rays. High = a few keystone
//                        pieces gate the rest = more "puzzle-like".
//   greedy moves/arrows  ratio of greedy escape-first moves to arrow
//                        count. > 1 means at least one re-pull happened
//                        during the solve.
//   greedy re-pulls      absolute extra-pull count (moves - arrows). Direct
//                        target for the --min-sequencing reject filter.
//   single-shot %        fraction of levels where greedy solves in exactly
//                        `arrows` moves (re-pulls == 0). High = trivial
//                        batch; corpus value is the meaningful baseline.
//   forced-chain depth   longest chain of "j blocks i at t=0" relationships
//                        among the initial blocker graph. Larger = the
//                        player must clear a specific keystone sequence.
//   path len p50, p90    snake-length distribution shape.
//
// For each metric we print the same summary stats (mean, p25, median,
// p75) for the synthetic group and the corpus group side by side, so
// drift is visible at a glance.
//
// CLI:
//   node src/quality-eval.mjs --w=20 --h=20 --count=50 [--seed=1]
//   --w, --h     target grid size (default 20×20)
//   --count      synthetic levels to generate + corpus samples to draw
//                (default 50). Generation respects the same --max-attempts
//                budget as generate-reverse.mjs.
//   --seed       PRNG seed (default 1)
//   --gen-only   skip corpus sampling (use when no corpus level exists
//                at the target size)
//   --from-dir=<dir>
//                load "generated" levels from .json files in <dir>
//                instead of running the inline reverse-generator. Useful
//                for comparing a non-reverse generator (e.g. generate-
//                partition.mjs) against the corpus without changing
//                this script. With --from-dir, --w/--h are inferred from
//                the loaded files (must all match); --count caps how many
//                are loaded; --seed is ignored.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createGame, greedy, loadLevel, tryPull } from "./_solver.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LEVELS_DIR = resolve(__dirname, "../../../levels_data");

// --- PRNG ------------------------------------------------------------------

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

// --- Reverse generation (inline copy) --------------------------------------
//
// We deliberately don't import from generate-reverse.mjs because that file
// is a CLI script with top-level side effects. The placement logic itself
// is small; the algorithmic details live in the source comments there.

const DIRS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

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

// extendPath / placeOne / genOne mirror generate-reverse.mjs. Keep in sync.
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
    extendPath(path, used, W, H, grid, rand, opts, rayMap);
    if (path.length >= opts.minLen) return { start, facing, path };
  }
  return null;
}

function recordRay(arrow, W, H, grid, rayMap) {
  const idx = (x, y) => y * W + x;
  let cx = arrow.path[0][0] + arrow.facing[0];
  let cy = arrow.path[0][1] + arrow.facing[1];
  while (cx >= 0 && cx < W && cy >= 0 && cy < H) {
    const ci = idx(cx, cy);
    if (grid[ci] === 0) rayMap.set(ci, (rayMap.get(ci) || 0) + 1);
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
      for (const k of initEsc) {
        if (rayByArrow[k].ray.has(ci)) initEsc.delete(k);
      }
    }
  }
  return added;
}

function genOne(W, H, rand, opts) {
  const grid = new Uint8Array(W * H);
  const idx = (x, y) => y * W + x;
  const arrows = [];
  const rayMap = new Map();
  let filled = 0;
  const targetCells = Math.floor(W * H * opts.targetFill);
  for (let k = 0; k < opts.maxArrows; k++) {
    if (filled >= targetCells) break;
    let a = placeOne(W, H, grid, rand, opts, rayMap);
    if (!a && opts.minLen > 2) {
      a = placeOne(W, H, grid, rand, { ...opts, minLen: 2 }, rayMap);
    }
    if (!a) break;
    for (const [x, y] of a.path) {
      grid[idx(x, y)] = 1;
      rayMap.delete(idx(x, y));
      filled++;
    }
    recordRay(a, W, H, grid, rayMap);
    arrows.push(a);
  }
  arrows.reverse();
  extendTails(W, H, grid, arrows, rand);
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

// --- Metrics ---------------------------------------------------------------

function computeMetrics(raw) {
  const W = raw.width;
  const H = raw.height;
  const n = raw.arrows.length;

  // Map every cell → owner-arrow index.
  const grid = new Map();
  for (let i = 0; i < n; i++) {
    for (const [x, y] of raw.arrows[i].path) grid.set(`${x},${y}`, i);
  }

  // Walk each arrow's facing ray to find who (if anyone) blocks it initially.
  // initEsc = arrows with no initial blocker.
  // blockedBy[i] = list of arrows that the i-th arrow blocks (i.e. those
  // arrows' facing rays hit one of i's body cells first).
  const blocksCount = new Array(n).fill(0);
  const blockedBy = new Array(n).fill(-1);
  let initEsc = 0;
  for (let i = 0; i < n; i++) {
    const a = raw.arrows[i];
    const [sx, sy] = a.start;
    const [fx, fy] = a.facing;
    let cx = sx + fx;
    let cy = sy + fy;
    let blocker = null;
    while (cx >= 0 && cx < W && cy >= 0 && cy < H) {
      const owner = grid.get(`${cx},${cy}`);
      if (owner !== undefined && owner !== i) {
        blocker = owner;
        break;
      }
      cx += fx;
      cy += fy;
    }
    if (blocker === null) initEsc++;
    else {
      blocksCount[blocker]++;
      blockedBy[i] = blocker;
    }
  }
  // "Bottleneck" arrow = blocks ≥ 2 others initially.
  let bottleneck = 0;
  for (const c of blocksCount) if (c >= 2) bottleneck++;

  // Forced-chain depth: longest path in the initial blocker DAG. Each arrow's
  // depth is 1 + depth(its unique blocker); init-escapable arrows have depth 1.
  // Cycles in the static blocker graph (would imply nobody can move first) are
  // capped at the arrow count, but in practice generated levels are acyclic.
  const chainDepth = new Array(n).fill(0);
  const visit = (i, stack) => {
    if (chainDepth[i] > 0) return chainDepth[i];
    if (stack.has(i)) return n; // cycle: cap
    stack.add(i);
    const b = blockedBy[i];
    const d = b < 0 ? 1 : 1 + visit(b, stack);
    stack.delete(i);
    chainDepth[i] = d;
    return d;
  };
  let maxChain = 0;
  for (let i = 0; i < n; i++) maxChain = Math.max(maxChain, visit(i, new Set()));

  // Greedy moves count.
  const data = loadLevel(raw);
  const state = createGame(data);
  const moves = [];
  const won = greedy(state, (id) => moves.push(id));

  // Path lengths.
  const lens = raw.arrows.map((a) => a.path.length).sort((a, b) => a - b);
  const cells = raw.arrows.reduce((s, a) => s + a.path.length, 0);

  return {
    arrows: n,
    fill: cells / (W * H),
    initEscFrac: initEsc / n,
    bottleneckFrac: bottleneck / n,
    moveRatio: won ? moves.length / n : null,
    greedyGap: won ? moves.length - n : null,
    singleShot: won ? (moves.length === n ? 1 : 0) : null,
    chainDepth: maxChain,
    pathLenP50: lens[Math.floor(lens.length / 2)],
    pathLenP90: lens[Math.floor(lens.length * 0.9)],
  };
}

// --- Stats helpers ---------------------------------------------------------

function pct(arr, p) {
  if (arr.length === 0) return NaN;
  const sorted = arr.slice().sort((a, b) => a - b);
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)));
  return sorted[i];
}
function mean(arr) {
  if (arr.length === 0) return NaN;
  let s = 0;
  for (const v of arr) s += v;
  return s / arr.length;
}

function summarize(metricsList, key) {
  const values = metricsList.map((m) => m[key]).filter((v) => v != null && Number.isFinite(v));
  return {
    mean: mean(values),
    p25: pct(values, 0.25),
    median: pct(values, 0.5),
    p75: pct(values, 0.75),
    n: values.length,
  };
}

function fmt(v, kind) {
  if (Number.isNaN(v) || v == null) return "  —  ";
  if (kind === "pct") return `${(v * 100).toFixed(0).padStart(3)}%`;
  if (kind === "ratio") return v.toFixed(2).padStart(5);
  if (kind === "int") return Math.round(v).toString().padStart(5);
  return v.toFixed(2).padStart(5);
}

const METRICS = [
  { key: "arrows", label: "arrows", kind: "int" },
  { key: "fill", label: "fill %", kind: "pct" },
  { key: "initEscFrac", label: "init-escapable %", kind: "pct" },
  { key: "bottleneckFrac", label: "bottleneck %", kind: "pct" },
  { key: "moveRatio", label: "greedy moves/arrow", kind: "ratio" },
  { key: "greedyGap", label: "greedy re-pulls", kind: "int" },
  { key: "singleShot", label: "single-shot %", kind: "pct" },
  { key: "chainDepth", label: "forced-chain depth", kind: "int" },
  { key: "pathLenP50", label: "path len p50", kind: "int" },
  { key: "pathLenP90", label: "path len p90", kind: "int" },
];

function printSideBySide(label, genStats, corpusStats) {
  const W1 = 22;
  const W2 = 42;
  const W3 = 42;
  console.log(
    label.padEnd(W1) + "[generated]".padEnd(W2) + (corpusStats ? "[corpus]".padEnd(W3) : ""),
  );
  console.log("─".repeat(W1) + "─".repeat(W2) + (corpusStats ? "─".repeat(W3) : ""));
  for (const { key, label: ml, kind } of METRICS) {
    const g = genStats[key];
    const c = corpusStats?.[key];
    const gStr = `μ ${fmt(g.mean, kind)}   med ${fmt(g.median, kind)}   iqr ${fmt(g.p25, kind)}–${fmt(g.p75, kind)}`;
    const cStr = c
      ? `μ ${fmt(c.mean, kind)}   med ${fmt(c.median, kind)}   iqr ${fmt(c.p25, kind)}–${fmt(c.p75, kind)}`
      : "";
    console.log(ml.padEnd(W1) + gStr.padEnd(W2) + cStr);
  }
  console.log("");
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
const fromDir =
  typeof args["from-dir"] === "string" && args["from-dir"] !== "true"
    ? resolve(args["from-dir"])
    : null;
let W;
let H;
let count;
const baseSeed = Number(args.seed ?? 1);
const genOnly = args["gen-only"] === "true";
const maxAttempts = Number(args["max-attempts"] ?? 20);

const genOpts = {
  minLen: 3,
  maxLen: 12,
  targetFill: 0.85,
  straightBias: 0.65,
  rayBias: 0.95,
  maxArrows: 300,
};

// --- Load or generate synthetic batch --------------------------------------

const genLevels = [];
if (fromDir) {
  count = Number(args.count ?? 1000);
  console.error(`[1/3] loading generated levels from ${fromDir}…`);
  const files = readdirSync(fromDir).filter((f) => f.endsWith(".json"));
  for (const f of files) {
    if (genLevels.length >= count) break;
    try {
      const raw = JSON.parse(readFileSync(join(fromDir, f), "utf8"));
      if (!raw.width || !raw.height || !Array.isArray(raw.arrows)) continue;
      if (W === undefined) {
        W = raw.width;
        H = raw.height;
      } else if (raw.width !== W || raw.height !== H) {
        console.error(
          `      WARN ${f} is ${raw.width}×${raw.height}, expected ${W}×${H} — skipping`,
        );
        continue;
      }
      genLevels.push(raw);
    } catch {
      // skip malformed
    }
  }
  if (genLevels.length === 0) {
    console.error(`      no readable .json files in ${fromDir}`);
    process.exit(1);
  }
  console.error(`      loaded ${genLevels.length} level(s) at ${W}×${H}`);
} else {
  W = Number(args.w ?? 20);
  H = Number(args.h ?? 20);
  count = Number(args.count ?? 50);
  console.error(`[1/3] generating ${count} synthetic ${W}×${H} levels…`);
  let attempts = 0;
  while (genLevels.length < count && attempts < maxAttempts * count) {
    attempts++;
    const rand = mulberry32(baseSeed + attempts * 1009);
    const raw = genOne(W, H, rand, genOpts);
    if (raw.arrows.length < 2) continue;
    // Sanity-verify by simulating construction order.
    const data = loadLevel(raw);
    const st = createGame(data);
    let ok = true;
    for (let i = 0; i < st.arrows.length; i++) {
      const r = tryPull(st, i);
      if (!r.escaped) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    genLevels.push(raw);
  }
  console.error(`      produced ${genLevels.length}/${count} in ${attempts} attempts`);
}

// --- Sample corpus at the same WxH -----------------------------------------

let corpusLevels = [];
if (!genOnly) {
  console.error(`[2/3] scanning levels_data/ for ${W}×${H} matches…`);
  const files = readdirSync(LEVELS_DIR).filter((f) => f.endsWith(".json"));
  const matches = [];
  for (const f of files) {
    try {
      const raw = JSON.parse(readFileSync(join(LEVELS_DIR, f), "utf8"));
      if (raw.width === W && raw.height === H) matches.push(raw);
    } catch {
      // skip malformed
    }
  }
  console.error(`      ${matches.length} corpus level(s) match`);
  const rand = mulberry32(baseSeed + 13);
  shuffleInPlace(matches, rand);
  corpusLevels = matches.slice(0, count);
  if (corpusLevels.length === 0) {
    console.error(
      `      no corpus match at ${W}×${H} — skipping comparison (re-run with --gen-only to suppress this notice)`,
    );
  }
}

// --- Metrics + display -----------------------------------------------------

console.error(`[3/3] computing metrics…`);
const genMetrics = genLevels.map(computeMetrics);
const corpusMetrics = corpusLevels.map(computeMetrics);

const genStats = {};
const corpusStats = corpusLevels.length > 0 ? {} : null;
for (const { key } of METRICS) {
  genStats[key] = summarize(genMetrics, key);
  if (corpusStats) corpusStats[key] = summarize(corpusMetrics, key);
}

console.log("");
console.log(
  `=== ${W}×${H}  ·  generated=${genLevels.length}  ·  corpus=${corpusLevels.length}  ·  seed=${baseSeed} ===`,
);
console.log("");
printSideBySide("metric", genStats, corpusStats);

if (corpusStats) {
  console.log(
    "tip: 'init-escapable %' high vs corpus → too many parallel starting moves (loose puzzles).",
  );
  console.log("     'bottleneck %' low vs corpus      → few keystone arrows (less structure).");
  console.log(
    "     'forced-chain depth' low vs corpus → static blocker DAG is shallow; few mandatory orderings.",
  );
  console.log(
    "  note: 'greedy moves/arrow' and 'single-shot %' are usually 100% / 0 re-pulls on both corpus",
  );
  console.log(
    "        and synthetic batches — the snake-walk escape-first greedy almost never needs to re-pull,",
  );
  console.log(
    "        so these two columns mostly serve as a regression canary (any non-zero spike = a bug).",
  );
}
