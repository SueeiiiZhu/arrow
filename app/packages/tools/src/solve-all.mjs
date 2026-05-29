// Sanity-sweep solver across the level corpus.
//
// Usage:
//   pnpm --filter @ea/tools solve:all                  # first 50 levels
//   pnpm --filter @ea/tools solve:all -- --limit=500
//   pnpm --filter @ea/tools solve:all -- --limit=all

import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { levelHasSelfRayArrow } from "../../wxgame/scripts/_encode.mjs";
import { createGame, dfs, greedy, loadLevel, resetGame } from "./_solver.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LEVELS_DIR = resolve(__dirname, "../../../levels_data");

const limitArg = process.argv.find((a) => a.startsWith("--limit="));
const rawLimit = limitArg ? limitArg.split("=")[1] : "50";
const LIMIT = rawLimit === "all" ? Infinity : Number(rawLimit);

// Mirror the shipped corpus: drop self-ray levels that the post-2026-05-28
// tightened tryPull rule no longer admits. Same predicate as _encode.mjs.
let skippedSelfRay = 0;
const all = readdirSync(LEVELS_DIR)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .filter((f) => {
    const raw = JSON.parse(readFileSync(resolve(LEVELS_DIR, f), "utf8"));
    if (levelHasSelfRayArrow(raw)) {
      skippedSelfRay++;
      return false;
    }
    return true;
  });
const files = all.slice(0, Number.isFinite(LIMIT) ? LIMIT : all.length);

let solvedGreedy = 0;
let solvedDFS = 0;
const unsolved = [];
const slow = [];

for (const f of files) {
  const raw = JSON.parse(readFileSync(resolve(LEVELS_DIR, f), "utf8"));
  const level = loadLevel(raw);
  const game = createGame(level);
  const t0 = Date.now();
  let ok = greedy(game);
  const tG = Date.now() - t0;
  if (ok) {
    solvedGreedy++;
    if (tG > 200) slow.push({ f, tG, via: "greedy" });
    continue;
  }
  resetGame(game);
  const t1 = Date.now();
  const deadline = t1 + 2000;
  const visited = new Set();
  try {
    ok = dfs(game, visited, deadline);
  } catch (e) {
    if (e.message !== "deadline") throw e;
  }
  const tD = Date.now() - t1;
  if (ok) {
    solvedDFS++;
    if (tD > 200) slow.push({ f, tD, via: "dfs", visited: visited.size });
  } else {
    unsolved.push({ f, tG, tD });
  }
}

console.log(`\n=== ${files.length} levels (skipped ${skippedSelfRay} self-ray) ===`);
console.log(`solved by greedy escape-first:        ${solvedGreedy}`);
console.log(`solved by DFS (with state memo):      ${solvedDFS}`);
console.log(`total solved:                         ${solvedGreedy + solvedDFS}/${files.length}`);
if (unsolved.length) {
  console.log("unsolved:");
  for (const u of unsolved) console.log("  ", u);
}
if (slow.length) {
  console.log("slow:");
  for (const s of slow) console.log("  ", s);
}
process.exit(unsolved.length > 0 ? 1 : 0);
