/**
 * wxgame-side lives store: thin shim that wires wx.setStorageSync into the
 * host-neutral createLivesStore factory in @ea/lives. Exposes the same
 * named surface as the web shim so the HUD/main code is host-agnostic.
 */

import { createLivesStore } from "@ea/lives";

const STORAGE_KEY = "escape_arrows_lives";

const store = createLivesStore({
  storage: {
    read: () => {
      try {
        const v = wx.getStorageSync(STORAGE_KEY);
        return typeof v === "string" && v.length > 0 ? v : null;
      } catch {
        return null;
      }
    },
    write: (value) => {
      try {
        wx.setStorageSync(STORAGE_KEY, value);
      } catch {
        /* swallow */
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
