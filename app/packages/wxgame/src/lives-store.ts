/**
 * wxgame-side lives store: persists LivesState via wx.setStorageSync,
 * exposes the same shape as the web store so the renderer/HUD doesn't
 * care which host it runs on.
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
    const v = wx.getStorageSync(STORAGE_KEY);
    if (typeof v !== "string" || v.length === 0) return createFresh(config, now);
    return fromJSON(JSON.parse(v), config, now);
  } catch {
    return createFresh(config, now);
  }
}

function writePersisted(state: LivesState): void {
  try {
    wx.setStorageSync(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* swallow */
  }
}

let state: LivesState = readPersisted(Date.now());

export function getState(): LivesState {
  return state;
}

export function getConfig(): LivesConfig {
  return config;
}

export function tickNow(): LivesState {
  const next = tick(state, config, Date.now());
  if (next !== state) {
    state = next;
    writePersisted(state);
  }
  return state;
}

export function tryConsume(): boolean {
  const { ok, state: next } = consume(state, config, Date.now());
  if (ok) {
    state = next;
    writePersisted(state);
  }
  return ok;
}

export function addLives(amount = 1): void {
  state = refill(state, config, Date.now(), amount);
  writePersisted(state);
}

export function nextRegenMs(): number | null {
  return msToNextRegen(state, config, Date.now());
}
