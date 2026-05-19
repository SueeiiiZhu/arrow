// Corpus statistics over levels_data/*.json.
//
// Goal: characterize the 3548-level distribution so a future procedural
// generator has concrete targets to match (grid sizes, arrow counts, snake
// lengths, corner density, etc.). Pure read; no @ea/core import needed.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LEVELS_DIR = resolve(__dirname, "../../../levels_data");

// --- Filename parsing -------------------------------------------------------

// Examples:
//   00190__OG_LevelBig7.json
//   00177__07-08_[19x27]_[54]_[Snake, Country].json
const RE_TAGS = /\[([^[\]]+)\]\.json$/;
const RE_OG = /__OG_/;

function parseTags(fname) {
  const m = fname.match(RE_TAGS);
  if (!m) return [];
  return m[1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// --- Per-arrow geometry -----------------------------------------------------

function cornerCount(path) {
  if (path.length < 3) return 0;
  let corners = 0;
  for (let i = 2; i < path.length; i++) {
    const dx1 = path[i - 1][0] - path[i - 2][0];
    const dy1 = path[i - 1][1] - path[i - 2][1];
    const dx2 = path[i][0] - path[i - 1][0];
    const dy2 = path[i][1] - path[i - 1][1];
    if (dx1 !== dx2 || dy1 !== dy2) corners++;
  }
  return corners;
}

function facingKey(f) {
  if (f[0] === 1 && f[1] === 0) return "+x";
  if (f[0] === -1 && f[1] === 0) return "-x";
  if (f[0] === 0 && f[1] === 1) return "+y";
  if (f[0] === 0 && f[1] === -1) return "-y";
  return "?";
}

function isOnBorder(x, y, W, H) {
  return x === 0 || y === 0 || x === W - 1 || y === H - 1;
}

// --- Statistics helpers -----------------------------------------------------

function pct(arr, p) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}

function mean(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}

function bucket(value, edges) {
  for (let i = 0; i < edges.length; i++) {
    if (value <= edges[i]) return i;
  }
  return edges.length;
}

function fmtBucketLabel(i, edges) {
  if (i === 0) return `≤${edges[0]}`;
  if (i === edges.length) return `>${edges[edges.length - 1]}`;
  return `${edges[i - 1] + 1}-${edges[i]}`;
}

function histogram(values, edges) {
  const counts = new Array(edges.length + 1).fill(0);
  for (const v of values) counts[bucket(v, edges)]++;
  const total = values.length;
  return counts.map((c, i) => ({
    label: fmtBucketLabel(i, edges),
    count: c,
    pct: total ? ((c / total) * 100).toFixed(1) : "0.0",
  }));
}

function printHist(title, hist, barWidth = 40) {
  const max = Math.max(1, ...hist.map((h) => h.count));
  console.log(`\n${title}`);
  for (const row of hist) {
    const w = Math.round((row.count / max) * barWidth);
    const bar = "█".repeat(w) + "·".repeat(barWidth - w);
    console.log(
      `  ${row.label.padStart(10)}  ${bar} ${String(row.count).padStart(5)}  (${row.pct}%)`,
    );
  }
}

function minMax(values) {
  let mn = Infinity;
  let mx = -Infinity;
  for (const v of values) {
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  return [mn, mx];
}

function summary(name, values, unit = "") {
  if (values.length === 0) {
    console.log(`  ${name.padEnd(30)} —`);
    return;
  }
  const [min, max] = minMax(values);
  console.log(
    `  ${name.padEnd(30)} min=${String(min).padStart(4)} ` +
      `p50=${String(pct(values, 50)).padStart(4)} ` +
      `p90=${String(pct(values, 90)).padStart(4)} ` +
      `p99=${String(pct(values, 99)).padStart(4)} ` +
      `max=${String(max).padStart(5)} ` +
      `mean=${mean(values).toFixed(1).padStart(6)}${unit}`,
  );
}

// --- Main -------------------------------------------------------------------

const files = readdirSync(LEVELS_DIR)
  .filter((f) => f.endsWith(".json"))
  .sort();
console.log(`Reading ${files.length} levels from ${LEVELS_DIR}...`);

// Per-level
const widths = [];
const heights = [];
const cellCounts = []; // W*H
const arrowCounts = [];
const densities = []; // occupied / (W*H)
const voidRatios = []; // (W*H - occupied) / (W*H)
const isOG = [];

// Per-arrow
const pathLens = [];
const corners = [];
const headOnBorder = [];
const facingDist = { "+x": 0, "-x": 0, "+y": 0, "-y": 0, "?": 0 };

// Tag frequency
const tagCounts = new Map();
const tagCombos = new Map();

let badLevels = 0;

for (const f of files) {
  const fpath = join(LEVELS_DIR, f);
  let lvl;
  try {
    lvl = JSON.parse(readFileSync(fpath, "utf8"));
  } catch {
    badLevels++;
    continue;
  }
  const W = lvl.width;
  const H = lvl.height;
  widths.push(W);
  heights.push(H);
  cellCounts.push(W * H);
  arrowCounts.push(lvl.arrows.length);
  isOG.push(RE_OG.test(f));

  let occupied = 0;
  for (const a of lvl.arrows) {
    pathLens.push(a.path.length);
    corners.push(cornerCount(a.path));
    const [hx, hy] = a.path[0];
    headOnBorder.push(isOnBorder(hx, hy, W, H) ? 1 : 0);
    facingDist[facingKey(a.facing)]++;
    occupied += a.path.length;
  }
  const dens = occupied / (W * H);
  densities.push(dens);
  voidRatios.push(1 - dens);

  const tags = parseTags(f);
  for (const t of tags) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
  const combo = tags.length === 0 ? "(none)" : tags.slice().sort().join("+");
  tagCombos.set(combo, (tagCombos.get(combo) ?? 0) + 1);
}

if (badLevels > 0) console.log(`(skipped ${badLevels} malformed levels)`);

// --- Output -----------------------------------------------------------------

console.log("\n=== Per-level metrics ===");
summary("grid width", widths);
summary("grid height", heights);
summary("grid cells (W*H)", cellCounts);
summary("arrows / level", arrowCounts);
summary(
  "fill density (%)",
  densities.map((d) => Math.round(d * 100)),
  "%",
);
console.log(`  OG-prefixed levels:            ${isOG.filter(Boolean).length} / ${files.length}`);

console.log("\n=== Per-arrow metrics ===");
summary("path length (snake length)", pathLens);
summary("corners per arrow", corners);
console.log(
  `  head starts on border:         ${(
    (headOnBorder.filter((b) => b).length / headOnBorder.length) * 100
  ).toFixed(1)}%  (${headOnBorder.filter((b) => b).length}/${headOnBorder.length})`,
);

console.log("\n=== Facing distribution (per arrow) ===");
const totalArrows = pathLens.length;
for (const [k, v] of Object.entries(facingDist)) {
  console.log(`  ${k}   ${String(v).padStart(7)}  (${((v / totalArrows) * 100).toFixed(1)}%)`);
}

// Histograms
printHist("Grid cell-count distribution (W*H)", histogram(cellCounts, [100, 400, 900, 1600, 2500]));
printHist("Arrows / level distribution", histogram(arrowCounts, [10, 25, 50, 100, 200]));
printHist("Path-length distribution (per arrow)", histogram(pathLens, [2, 5, 10, 20, 50]));
printHist("Corners-per-arrow distribution", histogram(corners, [0, 1, 3, 6, 12]));
printHist(
  "Fill density distribution (%)",
  histogram(
    densities.map((d) => Math.round(d * 100)),
    [25, 50, 75, 90, 100],
  ),
);

console.log("\n=== Tag frequency (single-tag counts) ===");
const sortedTags = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]);
for (const [t, c] of sortedTags) {
  console.log(
    `  ${t.padEnd(20)}  ${String(c).padStart(5)}  (${((c / files.length) * 100).toFixed(1)}%)`,
  );
}

console.log("\n=== Tag-combo frequency (top 15) ===");
const sortedCombos = [...tagCombos.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
for (const [c, n] of sortedCombos) {
  console.log(
    `  ${c.padEnd(40)}  ${String(n).padStart(5)}  (${((n / files.length) * 100).toFixed(1)}%)`,
  );
}

console.log("\n=== Quick takeaways for generator design ===");
const medianCells = pct(cellCounts, 50);
const medianArrows = pct(arrowCounts, 50);
const medianDens = pct(
  densities.map((d) => Math.round(d * 100)),
  50,
);
const medianPath = pct(pathLens, 50);
const medianCorners = pct(corners, 50);
console.log(
  `  - Median level: ${pct(widths, 50)} × ${pct(heights, 50)} grid, ${medianCells} cells, ${medianArrows} arrows, ${medianDens}% filled`,
);
console.log(`  - Median arrow: ${medianPath} cells long with ${medianCorners} corner(s)`);
console.log(
  `  - Heads start on the grid border ${((headOnBorder.filter((b) => b).length / headOnBorder.length) * 100).toFixed(0)}% of the time`,
);
console.log(`  - Top tag: ${sortedTags[0]?.[0] ?? "(none)"} (${sortedTags[0]?.[1] ?? 0} levels)`);
