// Shared snake-walk solver used by the @ea/tools scripts.
//
// Strategy: greedy round-robin ranked by (escapes? > step count > id),
// with a hash-memoized DFS fallback. Solves the entire 3548-level sample
// using just the greedy phase (verified during snake-walk validation).

// `@ea/core` resolves to its TS source (`main: ./src/index.ts`) for the TS
// workspace; node can't load that. Import the built JS directly instead.
// Requires `pnpm build:core` once before running solver scripts — wired in
// via the package.json prescript.
import { createGame, loadLevel, resetGame, tryPull } from "../../core/dist/index.js";

export { createGame, loadLevel, resetGame, tryPull };

export function snapshot(state) {
  return {
    a: state.arrows.map((a) => (a.escaped ? -1 - a.progress : a.progress)),
    status: state.status,
  };
}

export function restore(state, snap) {
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

export function hashState(state) {
  let h = "";
  for (const a of state.arrows) h += a.escaped ? "X," : a.progress + ",";
  return h;
}

export function rankMoves(state) {
  const out = [];
  for (const a of state.arrows) {
    if (a.escaped) continue;
    const snap = snapshot(state);
    const r = tryPull(state, a.id);
    if (r.steps > 0 || r.escaped) {
      out.push({ id: a.id, escapes: r.escaped, steps: r.steps });
    }
    restore(state, snap);
  }
  out.sort((x, y) => (y.escapes ? 1 : 0) - (x.escapes ? 1 : 0) || y.steps - x.steps || x.id - y.id);
  return out;
}

export function greedy(state, onMove) {
  let safety = 200000;
  while (state.status !== "won") {
    if (--safety <= 0) return false;
    const moves = rankMoves(state);
    if (moves.length === 0) return false;
    const top = moves[0];
    tryPull(state, top.id);
    if (onMove) onMove(top.id);
  }
  return true;
}

export function dfs(state, visited, deadline, plan) {
  if (state.status === "won") return true;
  if (Date.now() > deadline) throw new Error("deadline");
  const h = hashState(state);
  if (visited.has(h)) return false;
  visited.add(h);
  const moves = rankMoves(state);
  for (const m of moves) {
    const snap = snapshot(state);
    tryPull(state, m.id);
    if (plan) plan.push(m.id);
    if (dfs(state, visited, deadline, plan)) return true;
    if (plan) plan.pop();
    restore(state, snap);
  }
  return false;
}
