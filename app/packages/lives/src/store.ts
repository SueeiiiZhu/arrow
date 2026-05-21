/**
 * Host-neutral store wrapper around the pure-function Lives API. The host
 * injects a raw string Storage (mirroring @ea/core/progress's
 * ProgressStorage) and an optional clock; we own the parsing, the in-memory
 * state, and the subscribe / change-emission machinery.
 *
 * Web wires localStorage; wxgame wires wx.setStorageSync/getStorageSync.
 * Both then expose the exact same surface to the UI.
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
} from "./lives.js";

export interface LivesStorage {
  read(): string | null;
  write(value: string): void;
}

export interface LivesStoreOptions {
  storage: LivesStorage;
  /** Wall clock; defaults to Date.now. Injectable for tests. */
  now?: () => number;
  /** Override defaults; if omitted, defaultConfig is used. */
  config?: LivesConfig;
}

export interface LivesStore {
  getState(): LivesState;
  getConfig(): LivesConfig;
  /** Reconcile pending regen against the current clock. */
  tickNow(): LivesState;
  /** Try to spend one life; returns true on success. */
  tryConsume(): boolean;
  /** Add lives (e.g. ad reward). */
  addLives(amount?: number): void;
  /** Milliseconds until the next +1; null if already at max. */
  nextRegenMs(): number | null;
  /** Subscribe to state changes. Returns an unsubscribe. */
  subscribe(fn: () => void): () => void;
}

function readPersisted(storage: LivesStorage, config: LivesConfig, now: number): LivesState {
  const raw = storage.read();
  if (!raw) return createFresh(config, now);
  try {
    return fromJSON(JSON.parse(raw), config, now);
  } catch {
    return createFresh(config, now);
  }
}

export function createLivesStore(opts: LivesStoreOptions): LivesStore {
  const { storage } = opts;
  const now = opts.now ?? (() => Date.now());
  const config = opts.config ?? defaultConfig;

  let state = readPersisted(storage, config, now());
  const subscribers = new Set<() => void>();

  function emit(): void {
    for (const fn of subscribers) fn();
  }

  function writePersisted(s: LivesState): void {
    try {
      storage.write(JSON.stringify(s));
    } catch {
      // quota / privacy mode — drop silently
    }
  }

  function setState(next: LivesState): void {
    if (next === state) return;
    state = next;
    writePersisted(state);
    emit();
  }

  return {
    getState: () => state,
    getConfig: () => config,
    tickNow(): LivesState {
      setState(tick(state, config, now()));
      return state;
    },
    tryConsume(): boolean {
      const { ok, state: next } = consume(state, config, now());
      if (ok) setState(next);
      return ok;
    },
    addLives(amount = 1): void {
      setState(refill(state, config, now(), amount));
    },
    nextRegenMs(): number | null {
      return msToNextRegen(state, config, now());
    },
    subscribe(fn: () => void): () => void {
      subscribers.add(fn);
      return () => {
        subscribers.delete(fn);
      };
    },
  };
}
