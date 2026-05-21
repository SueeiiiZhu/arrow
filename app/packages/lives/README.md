# @ea/lives

> 中文版本: [README.zh-CN.md](./README.zh-CN.md)

Hearts / lives state module. Mirrors the monetization-layer semantics of the original APK's `LivesComponent` / `MaxLives`: every failure costs 1 heart; once they hit zero, the player must wait for automatic regen or watch a rewarded ad for +1.

The module itself is **pure functions + a time anchor** — it depends on no host APIs (no `localStorage`, no `wx.*`). Persistence, the current clock, and ad playback are all injected by the host, so web and wxgame share the same implementation.

## API quick reference

```ts
import {
  createFresh,        // (config, now) → full-hearts new state
  tick,               // (state, config, now) → apply pending regen to state
  consume,            // (state, config, now) → { ok, state }; ok=false when starved
  refill,             // (state, config, now, amount=1) → add hearts, cap to max
  msToNextRegen,      // (state, config, now) → ms until next +1, null when full
  fromJSON,           // (raw, config, now) → restore from persisted JSON (with clamping / defaults)
  defaultConfig,      // { max: 5, regenIntervalMs: 30*60_000 }
} from "@ea/lives";
```

Invariants:

- `lives ∈ [0, max]`, integer; out-of-range values from `fromJSON` are clamped.
- `regenAnchor` is an absolute epoch ms. When the system clock rolls back, `tick()` pulls `anchor` back to `now` so the user doesn't get instantly refilled.
- While full, `anchor` is pinned to `now`, so the countdown only starts after the first heart is consumed from a full state (matches the original APK).
- For any fixed `(state, config, now)`, calling `tick` repeatedly returns an equivalent result (idempotent).

## Tuning

Default: 5 hearts, +1 every 30 minutes. To change the numbers, **edit `defaultConfig`** in `src/lives.ts`; hosts don't need to change anything:

```ts
export const defaultConfig: LivesConfig = {
  max: 5,
  regenIntervalMs: 30 * 60_000,
};
```

Or let the host pass its own `LivesConfig` (the integration layer currently hard-codes `defaultConfig`; consider this if you want per-difficulty tuning).

## Host integration (already wired in the repo)

| Host | Persistence key (`Storage`) | Persistence backend |
| --- | --- | --- |
| `@ea/web` | `escape_arrows_lives` | `localStorage` |
| `@ea/wxgame` | `escape_arrows_lives` | `wx.setStorageSync` / `wx.getStorageSync` |

Each host maintains a thin store (`packages/{web,wxgame}/src/lives-store.ts`) that wires the pure-function API above to its storage + clock, exposing the same set of helpers: `getState / getConfig / tickNow / tryConsume / addLives / nextRegenMs` (web has an extra `subscribe`).

Integration points (look here if you ever change the trigger conditions):

- **Reset button consumes 1 heart**: `resetBtn` click handler in `packages/web/src/main.ts`; `hud === "reset"` branch in `packages/wxgame/src/main.ts`.
- **Empty-hearts dialog when starved**: web uses a DOM `#no-lives-dialog` (`packages/web/index.html`); wxgame draws on Canvas + has a hitbox (`drawNoLivesOverlay` + `noLivesHitbox`).

> Current policy: **only "reset" consumes a heart**. Entering a level, switching levels, and completing a level don't. This is closest to the original APK's `LevelFailViewBase` behavior.

## Wiring up rewarded video ads (wxgame)

The web build has no ad slots — the "watch ad for +1 heart" button currently **adds 1 immediately** so the flow stays exercisable. The wxgame build wires `wx.createRewardedVideoAd` to a real rewarded video. The steps below get it shippable.

### 1. Register an ad slot in mp.weixin.qq.com

1. Log into the mini-game backend → **Monetization** → **Traffic Owner** → **Rewarded Video Ad Slot**.
2. Create a new slot, type "Rewarded Video". After submission you'll get an `adUnitId` shaped like `adunit-xxxxxxxxxxxxxxxx`.
3. Wait for approval (usually 1–3 days). You can already drop the ID into code and test in WeChat DevTools during approval, but real-device display requires approval.

### 2. Drop the ID into the code

Open `packages/wxgame/src/main.ts` and find:

```ts
// Replace with your own ad unit ID before submitting to mp.weixin.qq.com.
// `wx.createRewardedVideoAd` is absent in devtool / older clients — we then
// fall back to refilling 1 immediately so the flow is still exercisable.
const REWARDED_AD_UNIT_ID = "";
```

Replace the empty string with the `adunit-xxxxxxxxxxxxxxxx` from the backend.

### 3. Behavior

`tryAdRefill()`'s fallback chain:

| Condition | Behavior |
| --- | --- |
| `REWARDED_AD_UNIT_ID === ""` or `wx.createRewardedVideoAd` is absent | Directly `addLives(1)` and close the dialog. Useful during development. |
| Created OK, user **watches to completion** (`onClose` callback with `e.isEnded === true`) | `addLives(1)` and close the dialog. |
| Created OK, user **closes mid-ad** (`isEnded === false`) | No refill; close the dialog. |
| `ad.show()` fails | Try `ad.load()` then `show()` once more; on second failure give up and leave the dialog open. |

`ad.destroy()` is called on both the `onClose` and the failure branches to avoid leaking ad instances.

### 4. Rolling out / pausing

To temporarily disable ad delivery (during approval, gradual rollback, etc.), set `REWARDED_AD_UNIT_ID` back to an empty string and re-release. No UI changes needed.

## Debugging / resetting

If hearts run out during development the "reset" button gets stuck. Manual reset:

### web

Browser DevTools → Application → Local Storage → delete the `escape_arrows_lives` key, or in Console:

```js
localStorage.removeItem("escape_arrows_lives"); location.reload();
```

### wxgame (WeChat DevTools)

Toolbar → **Clear Cache** → check "Clear data cache" → confirm. Or in Console:

```js
wx.removeStorageSync("escape_arrows_lives");
```

### Tune hearts to short intervals for manual testing

Temporarily set `defaultConfig.regenIntervalMs` to `5_000` (5 seconds) and rebuild — you can then observe regen / countdown / full-state anchor reset within tens of seconds. Remember to set it back to `30 * 60_000` when you're done.

## Tests

```bash
pnpm --filter @ea/lives test
```

19 `node:test` cases cover: full-state anchor pinning, regen across multiple intervals, max cap, clock rollback, consume (full → non-full first-time countdown start / non-full / starved), `refill` cap, `msToNextRegen` (full → null / mid-interval countdown / across-interval remainder), `fromJSON` (valid / out-of-range clamp / missing-field defaults / non-object fallback).
