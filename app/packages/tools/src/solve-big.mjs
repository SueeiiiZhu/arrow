// Solve a single (large) level, defaulting to OG_LevelBig7.
//
// Usage:
//   pnpm --filter @ea/tools solve:big
//   pnpm --filter @ea/tools solve:big -- /abs/path/to/level.json
//
// Builds the core package first (consumes ./dist via the workspace alias).

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createGame, dfs, greedy, loadLevel, resetGame } from "./_solver.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT = resolve(__dirname, "../../../levels_data/00190__OG_LevelBig7.json");
const file = process.argv[2] ?? DEFAULT;
const raw = JSON.parse(readFileSync(file, "utf8"));
const level = loadLevel(raw);
console.log(`level: ${file.split("/").pop()}`);
console.log(`${level.arrows.length} arrows on ${level.width}x${level.height}`);

const game = createGame(level);
const plan = [];

const t0 = Date.now();
let ok = greedy(game, (id) => plan.push(id));
const tGreedy = Date.now() - t0;
console.log(`greedy escape-first: ${ok ? "WON" : "STUCK"} in ${tGreedy}ms`);
console.log(
  `  remaining: ${game.arrows.filter((a) => !a.escaped).length}/${
    game.arrows.length
  }, plan length: ${plan.length}`,
);

if (!ok) {
  console.log("falling back to DFS (5s deadline)");
  resetGame(game);
  plan.length = 0;
  const visited = new Set();
  const t1 = Date.now();
  const deadline = t1 + 5000;
  try {
    ok = dfs(game, visited, deadline, plan);
  } catch (e) {
    if (e.message !== "deadline") throw e;
    console.log(`  DFS deadline hit after ${Date.now() - t1}ms`);
  }
  console.log(
    `  DFS: ${ok ? "WON" : "STUCK"} in ${Date.now() - t1}ms (visited ${
      visited.size
    } states, plan length ${plan.length})`,
  );
}

if (ok) {
  console.log("SOLVED. First 20 moves (arrow ids):", plan.slice(0, 20));
  console.log("Last 10 moves:", plan.slice(-10));
}
process.exit(ok ? 0 : 1);
