// Shared level encoder + chunker used by both build-levels.mjs (emits the
// TS module the main bundle imports) and bundle.mjs (emits the WeChat
// subpackage JS files).
//
// Compact level format (chosen to fit all 3548 levels under the wxgame
// 20 MB total-package cap):
//
//   level     := [W, H, arrows[]]
//   arrow     := [fdir, ...cellIdx]
//   fdir      := 0 (+x), 1 (+y), 2 (-x), 3 (-y)        — corresponds to
//                facing on disk; cheaper than [dx,dy].
//   cellIdx   := y*W + x                                — single int.
//
// `start` is dropped (== path[0]). `coord_system` is fixed by convention.
// Round-trip via decodeCompact() must reconstruct a valid RawLevelFile.

import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(__dirname, "../../..");
export const LEVELS_DIR = resolve(ROOT, "levels_data");

/** How many levels live in the main bundle for instant first-launch. */
export const MAIN_BUNDLE_LIMIT = Number(process.env.WXGAME_MAIN_LIMIT ?? "30");
/** Target chunk size per subpackage; tuned for ~750 KB per pack under
 *  the 4 MB single-subpackage cap, with margin for the JS scaffolding. */
export const PACK_SIZE = Number(process.env.WXGAME_PACK_SIZE ?? "300");

function dirToCode(dx, dy) {
  if (dx === 1 && dy === 0) return 0;
  if (dx === 0 && dy === 1) return 1;
  if (dx === -1 && dy === 0) return 2;
  if (dx === 0 && dy === -1) return 3;
  throw new Error(`unexpected facing (${dx},${dy})`);
}

/** Encode one neutral RawLevelFile into the compact tuple form. */
export function encodeLevel(raw) {
  const W = raw.width;
  const H = raw.height;
  const arrows = raw.arrows.map((a) => {
    const fcode = dirToCode(a.facing[0], a.facing[1]);
    const cells = a.path.map(([x, y]) => y * W + x);
    return [fcode, ...cells];
  });
  return [W, H, arrows];
}

/**
 * True if any of `raw`'s arrows has a path cell sitting on the head's
 * facing ray — under the (post-2026-05-28 tightened) `tryPull` rule such
 * an arrow can self-block in a way that reads, visually, as the head
 * eating its own bent body. We drop those levels from shipped packs.
 */
function levelHasSelfRayArrow(raw) {
  const W = raw.width;
  const H = raw.height;
  const maxJ = W + H;
  for (const a of raw.arrows) {
    const head = a.path[0];
    const [fx, fy] = a.facing;
    const ray = new Set();
    for (let j = 1; j <= maxJ; j++) {
      ray.add(`${head[0] + j * fx},${head[1] + j * fy}`);
    }
    for (let i = 1; i < a.path.length; i++) {
      const c = a.path[i];
      if (ray.has(`${c[0]},${c[1]}`)) return true;
    }
  }
  return false;
}

/** Read all neutral levels from disk, sorted by filename. Skips levels
 *  whose tightened-engine semantic would let the head self-block visibly. */
export async function readAllLevels() {
  const files = (await readdir(LEVELS_DIR)).filter((f) => f.endsWith(".json")).sort();
  const out = [];
  let skipped = 0;
  for (const f of files) {
    const raw = JSON.parse(await readFile(resolve(LEVELS_DIR, f), "utf8"));
    if (levelHasSelfRayArrow(raw)) {
      skipped++;
      continue;
    }
    out.push({ key: f, encoded: encodeLevel(raw) });
  }
  if (skipped > 0) {
    console.warn(`[_encode] skipped ${skipped} self-ray level(s); see filter rationale in game.ts`);
  }
  return out;
}

/**
 * Split a flat level list into:
 *   - main:  the first MAIN_BUNDLE_LIMIT levels (embedded in the main bundle)
 *   - packs: subsequent levels grouped into chunks of PACK_SIZE
 *
 * Returns metadata mapping every key to a {pack, idx} so the main bundle
 * can resolve any level → its (subpackage, local index) without I/O.
 */
export function chunkLevels(all) {
  const main = all.slice(0, MAIN_BUNDLE_LIMIT);
  const rest = all.slice(MAIN_BUNDLE_LIMIT);
  const packs = [];
  for (let i = 0; i < rest.length; i += PACK_SIZE) {
    packs.push(rest.slice(i, i + PACK_SIZE));
  }
  /** key → [-1, mainIdx] for main; [packIdx, localIdx] for packs. */
  const locator = {};
  for (let i = 0; i < main.length; i++) locator[main[i].key] = [-1, i];
  for (let p = 0; p < packs.length; p++) {
    for (let i = 0; i < packs[p].length; i++) {
      locator[packs[p][i].key] = [p, i];
    }
  }
  return { main, packs, locator, allKeys: all.map((e) => e.key) };
}
