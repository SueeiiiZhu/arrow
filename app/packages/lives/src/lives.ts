/**
 * Pure-function Lives (heart) state — mirrors the LivesComponent / MaxLives
 * pattern from the original APK. Time-based regen using an absolute epoch
 * anchor so it survives reload, sleep, and clock skew (clamped by tick()).
 *
 * Caller threads `now` (a millisecond timestamp) into every API so this
 * module stays pure and trivially testable. Persistence (localStorage,
 * wx.setStorageSync) and clock providers are the host's responsibility.
 */

export interface LivesConfig {
  /** Hard cap on stored lives. */
  readonly max: number;
  /** Time between automatic regen ticks, in ms. */
  readonly regenIntervalMs: number;
}

export interface LivesState {
  /** Current count, always in [0, max]. */
  readonly lives: number;
  /**
   * Epoch ms anchor used to compute pending regen. When `lives < max`,
   * `now - regenAnchor` is the time accrued towards the next +1. When
   * `lives === max`, this gets refreshed to `now` on every tick so the
   * countdown only starts after the first consumption.
   */
  readonly regenAnchor: number;
}

export const defaultConfig: LivesConfig = {
  max: 5,
  regenIntervalMs: 30 * 60_000,
};

/** Brand-new state — lives at max, anchor at `now`. */
export function createFresh(config: LivesConfig, now: number): LivesState {
  return { lives: config.max, regenAnchor: now };
}

/**
 * Reconcile pending regen into the state. Idempotent: calling twice with
 * the same `now` produces the same state. Clamps a regressing clock by
 * pinning the anchor to `now` if `now < anchor` (e.g. user adjusted system
 * time backwards).
 */
export function tick(state: LivesState, config: LivesConfig, now: number): LivesState {
  if (now < state.regenAnchor) {
    return { lives: state.lives, regenAnchor: now };
  }
  if (state.lives >= config.max) {
    return state.regenAnchor === now ? state : { lives: state.lives, regenAnchor: now };
  }
  const elapsed = now - state.regenAnchor;
  const ticks = Math.floor(elapsed / config.regenIntervalMs);
  if (ticks <= 0) return state;
  const room = config.max - state.lives;
  const applied = Math.min(ticks, room);
  const newLives = state.lives + applied;
  const newAnchor =
    newLives >= config.max ? now : state.regenAnchor + applied * config.regenIntervalMs;
  return { lives: newLives, regenAnchor: newAnchor };
}

/**
 * Try to spend one life. Returns `{ ok: true, state }` on success, or
 * `{ ok: false, state }` (state unchanged from `tick`-ed input) if at 0.
 * If we transition from full → max-1, anchor starts counting at `now`.
 */
export function consume(
  state: LivesState,
  config: LivesConfig,
  now: number,
): { ok: boolean; state: LivesState } {
  const t = tick(state, config, now);
  if (t.lives <= 0) return { ok: false, state: t };
  const wasFull = t.lives >= config.max;
  return {
    ok: true,
    state: {
      lives: t.lives - 1,
      regenAnchor: wasFull ? now : t.regenAnchor,
    },
  };
}

/** Add lives (ad reward, gift, etc.), clamped to max. */
export function refill(
  state: LivesState,
  config: LivesConfig,
  now: number,
  amount = 1,
): LivesState {
  const t = tick(state, config, now);
  if (amount <= 0) return t;
  const newLives = Math.min(config.max, t.lives + amount);
  const newAnchor = newLives >= config.max ? now : t.regenAnchor;
  return { lives: newLives, regenAnchor: newAnchor };
}

/**
 * Milliseconds until the next regen tick, or null if already at max.
 * Use this to drive a UI countdown. Always non-negative.
 */
export function msToNextRegen(state: LivesState, config: LivesConfig, now: number): number | null {
  const t = tick(state, config, now);
  if (t.lives >= config.max) return null;
  const elapsed = now - t.regenAnchor;
  const remaining = config.regenIntervalMs - (elapsed % config.regenIntervalMs);
  return Math.max(0, remaining);
}

/** Normalize raw persisted JSON to a valid LivesState (clamps and defaults). */
export function fromJSON(raw: unknown, config: LivesConfig, now: number): LivesState {
  if (raw && typeof raw === "object") {
    const obj = raw as { lives?: unknown; regenAnchor?: unknown };
    const lives =
      typeof obj.lives === "number" && Number.isFinite(obj.lives)
        ? Math.max(0, Math.min(config.max, Math.floor(obj.lives)))
        : config.max;
    const regenAnchor =
      typeof obj.regenAnchor === "number" && Number.isFinite(obj.regenAnchor)
        ? obj.regenAnchor
        : now;
    return { lives, regenAnchor };
  }
  return createFresh(config, now);
}
