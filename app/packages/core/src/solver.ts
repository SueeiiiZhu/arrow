// Snake-walk solver. Two-phase: greedy escape-first round-robin solves the
// entire 3548-level corpus in our sampling; DFS with state hashing is the
// fallback for hypothetical pathological positions. Ported from the
// long-lived `packages/tools/src/_solver.mjs` so the engine can serve Hint
// requests from in-process / web-worker without depending on @ea/tools.
//
// Used by:
//   - `packages/tools/src/_solver.mjs`   (CI solver sweep, generator filter)
//   - `packages/web` / `packages/wxgame` Hint button (this is the new caller
//     2026-05-25 — kept synchronous so the same code can run in a Worker
//     and on the wxgame main thread).

import { type GameState, restoreGame, snapshotGame, tryPull } from "./game.js";

export interface RankedMove {
  id: number;
  escapes: boolean;
  steps: number;
}

/** Compact string hash of the live arrows' per-arrow state (cheap; suitable for a Set). */
export function hashState(state: GameState): string {
  let h = "";
  for (const a of state.arrows) h += a.escaped ? "X," : `${a.progress},`;
  return h;
}

/**
 * Probe each non-escaped arrow with a tentative pull, record (escapes, steps)
 * if it moved, then revert. Returns moves sorted by:
 *   1. escape > non-escape
 *   2. more steps > fewer steps
 *   3. lower id (stable)
 */
export function rankMoves(state: GameState): RankedMove[] {
  const out: RankedMove[] = [];
  for (const a of state.arrows) {
    if (a.escaped) continue;
    const snap = snapshotGame(state);
    const r = tryPull(state, a.id);
    if (r.steps > 0 || r.escaped) {
      out.push({ id: a.id, escapes: r.escaped, steps: r.steps });
    }
    restoreGame(state, snap);
  }
  out.sort((x, y) => (y.escapes ? 1 : 0) - (x.escapes ? 1 : 0) || y.steps - x.steps || x.id - y.id);
  return out;
}

/** Greedy escape-first solve. `onMove` receives each chosen arrow id. */
export function greedy(state: GameState, onMove?: (id: number) => void): boolean {
  let safety = 200000;
  while (state.status !== "won") {
    if (--safety <= 0) return false;
    const moves = rankMoves(state);
    if (moves.length === 0) return false;
    const top = moves[0]!;
    tryPull(state, top.id);
    if (onMove) onMove(top.id);
  }
  return true;
}

/**
 * DFS with state hashing. `deadlineMs` is an absolute Date.now() bound.
 * On hit the function throws `"deadline"` so callers can distinguish "no
 * solution exists" from "ran out of time".
 */
export function dfs(
  state: GameState,
  visited: Set<string>,
  deadlineMs: number,
  plan?: number[],
): boolean {
  if (state.status === "won") return true;
  if (Date.now() > deadlineMs) throw new Error("deadline");
  const h = hashState(state);
  if (visited.has(h)) return false;
  visited.add(h);
  const moves = rankMoves(state);
  for (const m of moves) {
    const snap = snapshotGame(state);
    tryPull(state, m.id);
    if (plan) plan.push(m.id);
    if (dfs(state, visited, deadlineMs, plan)) return true;
    if (plan) plan.pop();
    restoreGame(state, snap);
  }
  return false;
}

/**
 * Find the next arrow to pull from the current state. Always restores the
 * input state before returning.
 *
 * Strategy: try greedy first on a snapshot; if it wins, the first chosen
 * move is the hint. If greedy stalls (dead end), fall back to DFS with the
 * given deadline; if DFS finds a plan, return its first move. If neither
 * finds a winning plan, return `null` (the position is lost or beyond the
 * time budget).
 */
export function findNextMove(state: GameState, deadlineMs = Date.now() + 2000): number | null {
  if (state.status === "won") return null;
  const snap = snapshotGame(state);
  try {
    const greedyPlan: number[] = [];
    if (greedy(state, (id) => greedyPlan.push(id))) {
      return greedyPlan[0] ?? null;
    }
  } finally {
    restoreGame(state, snap);
  }

  // Greedy stalled — try DFS within the deadline.
  try {
    const visited = new Set<string>();
    const plan: number[] = [];
    if (dfs(state, visited, deadlineMs, plan)) {
      return plan[0] ?? null;
    }
  } catch {
    /* deadline */
  } finally {
    restoreGame(state, snap);
  }
  return null;
}
