/**
 * Browser-side lives store: thin shim that wires localStorage into the
 * host-neutral createLivesStore factory in @ea/lives. All state/subscribe
 * machinery lives in the lives package; we only provide the storage adapter.
 */

import { createLivesStore } from "@ea/lives";

const STORAGE_KEY = "escape_arrows_lives";

const store = createLivesStore({
  storage: {
    read: () => {
      try {
        return localStorage.getItem(STORAGE_KEY);
      } catch {
        return null;
      }
    },
    write: (value) => {
      try {
        localStorage.setItem(STORAGE_KEY, value);
      } catch {
        // quota / privacy mode — silently drop
      }
    },
  },
});

export const getState = store.getState;
export const getConfig = store.getConfig;
export const tickNow = store.tickNow;
export const tryConsume = store.tryConsume;
export const addLives = store.addLives;
export const nextRegenMs = store.nextRegenMs;
export const subscribe = store.subscribe;
