/**
 * Browser-side lives store: persists a LivesState to localStorage, exposes
 * a subscribe API for UI ticking, and provides high-level mutate helpers
 * (consume/refill) that automatically reconcile pending regen and persist.
 */

import {
  consume,
  createFresh,
  defaultConfig,
  fromJSON,
  type LivesConfig,
  type LivesState,
  msToNextRegen,
  refill,
  tick,
} from "@ea/lives";

const STORAGE_KEY = "escape_arrows_lives";

const config: LivesConfig = defaultConfig;

function readPersisted(now: number): LivesState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return createFresh(config, now);
    return fromJSON(JSON.parse(raw), config, now);
  } catch {
    return createFresh(config, now);
  }
}

function writePersisted(state: LivesState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // quota / privacy mode — silently drop
  }
}

let state: LivesState = readPersisted(Date.now());
const subscribers = new Set<() => void>();

function emit(): void {
  for (const fn of subscribers) fn();
}

function setState(next: LivesState): void {
  if (next === state) return;
  state = next;
  writePersisted(state);
  emit();
}

export function getState(): LivesState {
  return state;
}

export function getConfig(): LivesConfig {
  return config;
}

/** Reconcile pending regen against the wall clock; no-op if nothing changed. */
export function tickNow(): LivesState {
  setState(tick(state, config, Date.now()));
  return state;
}

/** Try to spend one life. Returns true on success. */
export function tryConsume(): boolean {
  const { ok, state: next } = consume(state, config, Date.now());
  if (ok) setState(next);
  return ok;
}

/** Add lives (e.g. ad reward). */
export function addLives(amount = 1): void {
  setState(refill(state, config, Date.now(), amount));
}

/** Milliseconds until the next +1 heart, or null if already at max. */
export function nextRegenMs(): number | null {
  return msToNextRegen(state, config, Date.now());
}

export function subscribe(fn: () => void): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}
