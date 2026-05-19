// Empirical answer to HANDOFF P0 #1 — "Does head extension need to stay
// inside levelMask?".
//
// Two models are simulated against the corpus and compared:
//
//   LAX (current `tryPull`): head only blocked when in-grid AND occupied by
//                            another arrow's body. Head may freely cross
//                            cells inside the bounding rectangle that are
//                            in no arrow's path ("void cells").
//
//   STRICT: head additionally blocked by in-grid cells that are NOT in
//           levelMask (= the union of arrow paths). Off-grid extension is
//           still allowed (the head pokes outside the puzzle shape).
//
// Reported signals:
//   - solvability under each model (greedy escape-first).
//   - among LAX-solvable levels, how many require crossing a void cell at
//     least once (the LAX plan would be illegal under STRICT).
//   - per-level diff: levels solved under LAX but stuck under STRICT.
//
// Interpretation:
//   - If both models solve the same level set AND void-crossings are 0
//     across all winning plans, STRICT is a safe drop-in tightening.
//   - If many LAX plans use void crossings, the lax rule is necessary.
//   - If STRICT fails on many levels we know are real puzzles from the
//     original game, the original almost certainly tolerates void crossings.
//
// Usage:
//   pnpm --filter @ea/tools analyze:void                  # first 200 levels
//   pnpm --filter @ea/tools analyze:void -- --limit=all
//   pnpm --filter @ea/tools analyze:void -- --limit=500 --verbose

import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createGame, loadLevel } from "../../core/dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LEVELS_DIR = resolve(__dirname, "../../../levels_data");

const args = process.argv.slice(2);
const limitArg = args.find((a) => a.startsWith("--limit="));
const VERBOSE = args.includes("--verbose");
const rawLimit = limitArg ? limitArg.split("=")[1] : "200";
const LIMIT = rawLimit === "all" ? Infinity : Number(rawLimit);

function key(x, y) {
  return `${x},${y}`;
}

// Drop-in clone of core.tryPull, but with an `extraBlocked: Set<string>` of
// cells that count as obstacles for the head in addition to other arrows'
// bodies. We can't use core.tryPull directly because we need to vary the
// rule per call.
function tryPullWith(state, arrowId, extraBlocked) {
  const arrow = state.arrows[arrowId];
  if (!arrow || arrow.escaped || state.status !== "playing") {
    return { steps: 0, escaped: false, won: false, crossedVoid: false };
  }
  const W = state.level.width;
  const H = state.level.height;
  const { facing, path } = arrow.data;
  const n = path.length;

  const obstacles = new Set();
  for (const other of state.arrows) {
    if (other.id === arrow.id || other.escaped) continue;
    const op = other.data.path;
    const ofacing = other.data.facing;
    const oN = op.length;
    for (let i = 0; i < oN; i++) {
      // bodyCellsAt(other, other.progress)[i] (head-first ordering, integer k).
      const k = other.progress - i + (oN - 1);
      let ox, oy;
      if (k >= oN - 1) {
        const s = k - (oN - 1);
        ox = op[0].x + s * ofacing.x;
        oy = op[0].y + s * ofacing.y;
      } else if (k < 0) {
        continue;
      } else {
        ox = op[oN - 1 - k].x;
        oy = op[oN - 1 - k].y;
      }
      if (ox >= 0 && ox < W && oy >= 0 && oy < H) {
        obstacles.add(key(ox, oy));
      }
    }
  }

  let steps = 0;
  let crossedVoid = false;
  const maxSteps = n + W + H + 2;
  while (steps < maxSteps) {
    const k = arrow.progress + steps + 1;
    const hx = path[0].x + k * facing.x;
    const hy = path[0].y + k * facing.y;
    const headOnGrid = hx >= 0 && hx < W && hy >= 0 && hy < H;
    if (headOnGrid) {
      if (obstacles.has(key(hx, hy))) break;
      if (extraBlocked?.has(key(hx, hy))) break;
      // Detect crossing of a void cell under the LAX rule (extraBlocked
      // empty): caller uses voidSet for that.
    }
    steps++;
    // Record void crossing (the head cell is in-grid AND not in levelMask).
    if (headOnGrid && extraBlocked === null && state.voidSet.has(key(hx, hy))) {
      crossedVoid = true;
    }
    let tx, ty;
    if (k >= n - 1) {
      const s = k - (n - 1);
      tx = path[0].x + s * facing.x;
      ty = path[0].y + s * facing.y;
    } else {
      tx = path[n - 1 - k].x;
      ty = path[n - 1 - k].y;
    }
    const tailOff = tx < 0 || tx >= W || ty < 0 || ty >= H;
    if (tailOff) {
      arrow.escaped = true;
      break;
    }
  }
  arrow.progress += steps;
  let won = false;
  if (state.status === "playing" && state.arrows.every((a) => a.escaped)) {
    state.status = "won";
    won = true;
  }
  return { steps, escaped: arrow.escaped, won, crossedVoid };
}

function snapshot(state) {
  return {
    a: state.arrows.map((a) => (a.escaped ? -1 - a.progress : a.progress)),
    status: state.status,
  };
}
function restore(state, snap) {
  for (let i = 0; i < state.arrows.length; i++) {
    const v = snap.a[i];
    if (v < 0) {
      state.arrows[i].escaped = true;
      state.arrows[i].progress = -1 - v;
    } else {
      state.arrows[i].escaped = false;
      state.arrows[i].progress = v;
    }
  }
  state.status = snap.status;
}

function rankMoves(state, extraBlocked) {
  const out = [];
  for (const a of state.arrows) {
    if (a.escaped) continue;
    const snap = snapshot(state);
    const r = tryPullWith(state, a.id, extraBlocked);
    if (r.steps > 0 || r.escaped) {
      out.push({ id: a.id, escapes: r.escaped, steps: r.steps });
    }
    restore(state, snap);
  }
  out.sort((x, y) => (y.escapes ? 1 : 0) - (x.escapes ? 1 : 0) || y.steps - x.steps || x.id - y.id);
  return out;
}

function greedy(state, extraBlocked) {
  let safety = 200000;
  let voidUsed = false;
  while (state.status !== "won") {
    if (--safety <= 0) return { won: false, voidUsed };
    const moves = rankMoves(state, extraBlocked);
    if (moves.length === 0) return { won: false, voidUsed };
    const r = tryPullWith(state, moves[0].id, extraBlocked);
    if (r.crossedVoid) voidUsed = true;
  }
  return { won: true, voidUsed };
}

const all = readdirSync(LEVELS_DIR)
  .filter((f) => f.endsWith(".json"))
  .sort();
const files = all.slice(0, Number.isFinite(LIMIT) ? LIMIT : all.length);

let laxSolved = 0;
let strictSolved = 0;
let laxNeedsVoid = 0;
const onlyLax = [];
const onlyStrict = [];

for (const f of files) {
  const raw = JSON.parse(readFileSync(resolve(LEVELS_DIR, f), "utf8"));
  const level = loadLevel(raw);

  // Build voidSet = in-grid cells NOT in any arrow's path.
  const mask = new Set();
  for (const a of level.arrows) {
    for (const c of a.path) mask.add(key(c.x, c.y));
  }
  const voidSet = new Set();
  for (let y = 0; y < level.height; y++) {
    for (let x = 0; x < level.width; x++) {
      const k = key(x, y);
      if (!mask.has(k)) voidSet.add(k);
    }
  }

  // LAX run.
  const lax = createGame(level);
  lax.voidSet = voidSet;
  const laxRes = greedy(lax, null);

  // STRICT run.
  const strict = createGame(level);
  strict.voidSet = voidSet;
  const strictRes = greedy(strict, voidSet);

  if (laxRes.won) laxSolved++;
  if (strictRes.won) strictSolved++;
  if (laxRes.won && laxRes.voidUsed) laxNeedsVoid++;
  if (laxRes.won && !strictRes.won) onlyLax.push(f);
  if (!laxRes.won && strictRes.won) onlyStrict.push(f);

  if (VERBOSE && (laxRes.won !== strictRes.won || laxRes.voidUsed)) {
    console.log(
      `${f.padEnd(60)} lax=${laxRes.won ? "WON" : "STUCK"}${
        laxRes.voidUsed ? " [voidUsed]" : ""
      } strict=${strictRes.won ? "WON" : "STUCK"}`,
    );
  }
}

const n = files.length;
console.log(`\n=== analyzed ${n} levels ===`);
console.log(`LAX  (current rule)              solvable by greedy:  ${laxSolved}/${n}`);
console.log(`STRICT (head must stay in mask)  solvable by greedy:  ${strictSolved}/${n}`);
console.log(`among LAX wins, plans that step into a void cell:    ${laxNeedsVoid}`);
console.log(
  `LAX-only (strict fails):     ${onlyLax.length}` +
    (onlyLax.length ? ` (first: ${onlyLax.slice(0, 5).join(", ")})` : ""),
);
console.log(
  `STRICT-only (lax fails):     ${onlyStrict.length}` +
    (onlyStrict.length ? ` (first: ${onlyStrict.slice(0, 5).join(", ")})` : ""),
);

console.log(`
Reading the numbers:
  - If onlyLax == 0 AND laxNeedsVoid == 0: STRICT is at least as permissive
    as LAX on this corpus — safe to adopt as a tightening.
  - If laxNeedsVoid >> 0: many puzzles' greedy plans pass head through void.
    The original game almost certainly tolerates this; keep LAX.
  - If onlyLax >> 0: STRICT rejects valid puzzles. Definitely keep LAX.
`);

process.exit(0);
