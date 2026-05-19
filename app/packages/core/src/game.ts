import type { ArrowData, LevelData, Vec2 } from "./types.js";

/**
 * Snake-walk model.
 *
 * Each arrow has a fixed bent `path`: path[0] is the head end, path[n-1] is
 * the tail end. `facing == -(path[1] - path[0])` points away from the body
 * out through the head.
 *
 * A tap "pulls" the snake forward by 1 step along its trajectory:
 *   - segment 0 (head) moves from path[0] + k*facing → path[0] + (k+1)*facing
 *   - every other segment slides into the cell vacated by the one ahead of it
 * The body therefore slithers along its OWN curved path; the head emerges
 * past path[0] in a straight line along facing.
 *
 * Collision: a step is blocked when the new head cell is on-grid AND
 * currently occupied by another non-escaped arrow's body cell. Off-grid
 * head positions are fine — the head pokes out of the puzzle shape.
 * The head ALSO freely crosses "void" cells (in-grid cells inside the
 * bounding rectangle that aren't in any arrow's path); this is verified
 * empirically by `packages/tools/src/analyze-head-void.mjs` — out of a
 * 500-level sample, 497 of the winning plans relied on a head crossing
 * a void cell, so tightening this rule would break virtually every
 * puzzle in the corpus.
 *
 * Escape: the arrow leaves the board once its tail cell is off-grid (which
 * implies every other segment, all further along facing, is also off-grid).
 *
 * tryPull is greedy: keep advancing until the snake either escapes or the
 * next head step would collide.
 *
 * Rationale: the rigid-translation model we tried before produced false
 * blockings (entire body translates, runs into neighbours that the original
 * game doesn't treat as obstacles) AND drew the wrong vanish animation
 * (body translated rigidly off-screen instead of snaking through its own
 * bent path).
 */

export interface ArrowState {
  readonly id: number;
  readonly data: ArrowData;
  /** integer step count: how many cells the head has advanced past path[0]. */
  progress: number;
  escaped: boolean;
}

export interface GameState {
  readonly level: LevelData;
  arrows: ArrowState[];
  /** union of every arrow's path cells — useful for renderers. */
  readonly levelMask: ReadonlySet<string>;
  status: "playing" | "won";
}

export function cellKey(x: number, y: number): string {
  return `${x},${y}`;
}

export function createGame(level: LevelData): GameState {
  const mask = new Set<string>();
  for (const arrow of level.arrows) {
    for (const c of arrow.path) mask.add(cellKey(c.x, c.y));
  }
  return {
    level,
    arrows: level.arrows.map((data, id) => ({
      id,
      data,
      progress: 0,
      escaped: false,
    })),
    levelMask: mask,
    status: "playing",
  };
}

export function resetGame(state: GameState): void {
  for (const a of state.arrows) {
    a.progress = 0;
    a.escaped = false;
  }
  state.status = "playing";
}

/**
 * Position of the snake at trajectory distance `t` from path[n-1]:
 *   T(0) = path[n-1] (tail end), T(n-1) = path[0] (head end),
 *   T(n-1+j) = path[0] + j*facing for j >= 0 (head extension).
 * Linearly interpolates between adjacent integer points so fractional t
 * yields smooth in-between cell positions for animation.
 */
export function trajectoryAt(data: ArrowData, t: number): Vec2 {
  const { path, facing } = data;
  const n = path.length;
  if (t >= n - 1) {
    const s = t - (n - 1);
    return {
      x: path[0]!.x + s * facing.x,
      y: path[0]!.y + s * facing.y,
    };
  }
  const tClamped = Math.max(0, t);
  const lo = Math.floor(tClamped);
  const hi = Math.min(n - 1, lo + 1);
  const frac = tClamped - lo;
  const pLo = path[n - 1 - lo]!;
  const pHi = path[n - 1 - hi]!;
  return {
    x: pLo.x + (pHi.x - pLo.x) * frac,
    y: pLo.y + (pHi.y - pLo.y) * frac,
  };
}

/**
 * Body cell positions (head first, tail last) for the given progress.
 * Accepts fractional `k` to support rendering during animation tweens.
 */
export function bodyCellsAt(data: ArrowData, k: number): Vec2[] {
  const n = data.path.length;
  const out: Vec2[] = new Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = trajectoryAt(data, n - 1 + k - i);
  }
  return out;
}

/** Body cells at the arrow's current integer progress. */
export function bodyCells(arrow: ArrowState): Vec2[] {
  if (arrow.escaped) return [];
  return bodyCellsAt(arrow.data, arrow.progress);
}

/** In-grid subset of the current body. */
export function bodyCellsInGrid(arrow: ArrowState, W: number, H: number): Vec2[] {
  return bodyCells(arrow).filter((c) => c.x >= 0 && c.x < W && c.y >= 0 && c.y < H);
}

export function findArrowAt(state: GameState, cell: Vec2): ArrowState | null {
  const W = state.level.width;
  const H = state.level.height;
  for (let i = state.arrows.length - 1; i >= 0; i--) {
    const a = state.arrows[i]!;
    if (a.escaped) continue;
    for (const c of bodyCellsInGrid(a, W, H)) {
      if (c.x === cell.x && c.y === cell.y) return a;
    }
  }
  return null;
}

export interface PullResult {
  steps: number;
  escaped: boolean;
  won: boolean;
}

export function tryPull(state: GameState, arrowId: number): PullResult {
  const arrow = state.arrows[arrowId];
  if (!arrow || arrow.escaped || state.status !== "playing") {
    return { steps: 0, escaped: false, won: false };
  }

  const W = state.level.width;
  const H = state.level.height;
  const { facing, path } = arrow.data;
  const n = path.length;

  // Obstacle set = in-grid integer body cells of every OTHER non-escaped
  // arrow. They don't move during this pull, so we snapshot once.
  const obstacles = new Set<string>();
  for (const other of state.arrows) {
    if (other.id === arrow.id || other.escaped) continue;
    for (const c of bodyCellsInGrid(other, W, H)) {
      obstacles.add(cellKey(c.x, c.y));
    }
  }

  let steps = 0;
  const maxSteps = n + W + H + 2;

  while (steps < maxSteps) {
    const k = arrow.progress + steps + 1;
    const hx = path[0]!.x + k * facing.x;
    const hy = path[0]!.y + k * facing.y;
    const headOnGrid = hx >= 0 && hx < W && hy >= 0 && hy < H;
    if (headOnGrid && obstacles.has(cellKey(hx, hy))) break;
    steps++;

    // Escape when the tail (segment n-1) has gone off-grid. Tail position
    // at progress k: path[n-1-k] while k < n-1, else path[0] + (k-n+1)*facing.
    let tx: number;
    let ty: number;
    if (k >= n - 1) {
      const s = k - (n - 1);
      tx = path[0]!.x + s * facing.x;
      ty = path[0]!.y + s * facing.y;
    } else {
      tx = path[n - 1 - k]!.x;
      ty = path[n - 1 - k]!.y;
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

  return { steps, escaped: arrow.escaped, won };
}
