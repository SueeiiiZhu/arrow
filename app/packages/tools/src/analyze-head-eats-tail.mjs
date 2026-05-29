// Static scan: for every arrow in every shipped pack, check whether any of
// its own path cells path[1..n-1] lie on the head's facing ray
// (path[0] + j*facing for j >= 1). If yes, the LAX engine permits the head
// to "eat" its own bent body / tail later in the same pull — the visual
// behaviour the user has been complaining about.
//
// Commit fe661c1 added a forbid in the GENERATOR to keep new arrows out of
// this shape; this script checks the shipped pack JSONs to verify it (or
// flag any that slipped through).
//
// Usage: node packages/tools/src/analyze-head-eats-tail.mjs

import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeCompact } from "../../core/dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKS_DIR = resolve(__dirname, "../../web/public/packs");

const packFiles = readdirSync(PACKS_DIR)
  .filter((f) => f.startsWith("pack") && f.endsWith(".json"))
  .sort((a, b) => Number(a.match(/pack(\d+)/)[1]) - Number(b.match(/pack(\d+)/)[1]));

let totalLevels = 0;
let totalArrows = 0;
let arrowsWithSelfRay = 0;
const samples = [];

for (const pf of packFiles) {
  const raw = JSON.parse(readFileSync(resolve(PACKS_DIR, pf), "utf8"));
  for (let li = 0; li < raw.length; li++) {
    const entry = raw[li];
    const rawLevel = decodeCompact(entry.data);
    totalLevels++;
    for (let ai = 0; ai < rawLevel.arrows.length; ai++) {
      const a = rawLevel.arrows[ai];
      totalArrows++;
      const head = a.path[0];
      const [fx, fy] = a.facing;
      // Head's facing ray: head + j*facing for j = 1..(W+H). We bound j by
      // grid diameter; any further offset can't be on-grid anyway.
      const W = rawLevel.width;
      const H = rawLevel.height;
      const maxJ = W + H;
      const rayCells = new Set();
      for (let j = 1; j <= maxJ; j++) {
        const rx = head[0] + j * fx;
        const ry = head[1] + j * fy;
        rayCells.add(`${rx},${ry}`);
      }
      let hitIdx = -1;
      for (let i = 1; i < a.path.length; i++) {
        const c = a.path[i];
        if (rayCells.has(`${c[0]},${c[1]}`)) {
          hitIdx = i;
          break;
        }
      }
      if (hitIdx >= 0) {
        arrowsWithSelfRay++;
        if (samples.length < 30) {
          samples.push({
            pack: pf,
            level: li,
            name: entry.key,
            arrow: ai,
            n: a.path.length,
            hitIdx,
            facing: a.facing,
            head: a.path[0],
            hitCell: a.path[hitIdx],
          });
        }
      }
    }
  }
}

console.log(`packs scanned:               ${packFiles.length}`);
console.log(`levels:                      ${totalLevels}`);
console.log(`arrows total:                ${totalArrows}`);
console.log(`arrows with self-ray cell:   ${arrowsWithSelfRay}`);
console.log(
  `ratio:                       ${((arrowsWithSelfRay / totalArrows) * 100).toFixed(3)}%`,
);
if (samples.length > 0) {
  console.log(`\nSample arrows where a path cell is on the head's facing ray:`);
  for (const s of samples) {
    console.log(
      `  ${s.pack} [${s.level}] arrow#${s.arrow} n=${s.n} hitIdx=${s.hitIdx}  ` +
        `head=(${s.head[0]},${s.head[1]}) facing=(${s.facing[0]},${s.facing[1]}) ` +
        `hit=(${s.hitCell[0]},${s.hitCell[1]})  ` +
        `${s.name?.slice(0, 50) ?? ""}`,
    );
  }
}
