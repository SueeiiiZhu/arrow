# Escape Arrows — Handoff / TODO

> Last advanced 2026-05-18. Next session, start the dev server first (`pnpm dev:web`, browser to `http://localhost:5173`; if the port is taken Vite falls through to 5174…) and pick from this document.

---

## Where we are

### Done

- `core/`: snake-walk model (body slides along its bent path, head extends past `path[0]` along `facing`). `tryPull` is greedy. New exports `trajectoryAt(data, t)` / `bodyCellsAt(data, k)` accept fractional `k` so animation tweens can interpolate smoothly. Full rationale is in the header comment of `packages/core/src/game.ts`.
- `renderer/`: `drawGame` consumes `bodyCellsAt`. Body is a thick rounded polyline, head is a rounded-corner triangle (approximates the original `ArrowHead.png` shape), tail is a filled circle cap (approximates `ArrowEnd.png`). **No original sprites are bundled — everything is Canvas paths.** `DrawOptions` gained `progressOverride`, `shakeOffsets`, and `drawEscapedIds` so the entry layer can drive animation.
- `web/src/main.ts` and `wxgame/src/main.ts`: rAF tweens (easeOutCubic, 120-450ms scaled with distance), 220ms damped shake along `facing` for blocked taps. Input is gated while a pull is animating.
- `wxgame/`: esbuild bundles entry + first 50 levels into `dist/wxgame/game.js` (~700KB CJS) plus a `game.json` manifest.
- `README.md`: local startup + WeChat DevTools import steps.
- Sanity solver (in `/tmp/ea_solve_snake.mjs`, **not in the repo**): 49/50 levels solved by greedy round-robin, 0 levels stuck-from-start, 1 level (`OG_LevelBig7`, 62 arrows) exceeds the 600ms bounded DFS cap.

### Entry points cheat sheet

| What you care about | Where to look |
| --- | --- |
| Rules / movement / collision | `packages/core/src/game.ts` |
| Visuals (arrow, body, tail, animation hooks) | `packages/renderer/src/board.ts` |
| H5 entry / input / animation loop | `packages/web/src/main.ts` |
| WeChat entry + HUD | `packages/wxgame/src/main.ts` |
| Level data | `levels_data/*.json` (neutral format) |
| Level import / validation | `packages/core/src/level.ts` |
| Embedded-level generation for WeChat | `packages/wxgame/scripts/build-levels.mjs` (currently embeds the first 50) |
| WeChat bundle script | `packages/wxgame/scripts/bundle.mjs` |

---

## Outstanding work — by priority

### P0 — blocking acceptance / model verification

1. **Browser-verify the snake-walk model**
   - `pnpm dev:web` → play 5-10 levels. Specifically confirm:
     - Arrows that previously felt unresponsive now either move OR shake (one of the two — never *nothing*).
     - The vanish trajectory really follows the bent path (levels with sharp 90° bends are the most informative).
     - The arrow visual style still looks reasonable (head = rounded triangle, tail = circle, body = thick rounded line).
   - If anything looks wrong, note the level key in a fresh entry so it's reproducible.

2. **Smarter solver for `OG_LevelBig7` (62 arrows)**
   - Current `/tmp/ea_solve_snake.mjs` bounded DFS times out at 600ms on this one level.
   - Need a more capable search: BFS with state deduplication, or greedy + local backtracking, or just a smarter ordering heuristic (prefer arrows whose head-extension lane is currently clear).
   - Once it solves, the snake-walk model is self-consistent across all 50 sampled levels. If it can't solve, revisit model boundary conditions before declaring success.

3. **Does head extension need to stay inside `levelMask`?**
   - `game.ts` currently only checks that the new head cell doesn't collide with another arrow's body. It does not require the head to remain inside any arrow's path or the union mask.
   - If the original game requires the head to slide along the mask and exit only through a notch in the puzzle shape, the current model is too permissive.
   - Easiest validation: find a level where the cell at `path[0] + facing` is on-grid but in **no** arrow's path (i.e., a "void" inside the canvas bounding box). Compare what the original APK does there. If the original blocks, add the constraint; if it allows, leave as-is.
   - If a real device is unavailable, another option is to dump IL2CPP method bodies and look for an `IsBlocked` / `CanMoveTo` symbol and its references.

### P1 — user-experience loop

4. **WeChat mini-game subpackages**
   - State: 50 / 3548 levels embedded; main bundle ~700KB (well under the 4MB main-package cap, but the remaining ~3500 levels are not loadable).
   - Goal: split into subpackages of ~100-300 levels each.
   - Concrete changes:
     - `packages/wxgame/scripts/build-levels.mjs` emits multiple `levels_<n>.generated.ts` files.
     - `game.json` gains a `subpackages` array.
     - `main.ts` adds an async `wx.loadSubpackage` step with a "loading…" HUD state.
   - WeChat caps: main package 4MB, each subpackage 4MB, total ≤ 20MB.

5. **Persist level progress**
   - H5: `localStorage`.
   - WeChat: `wx.setStorageSync`.
   - Minimum payload: the index of the current level and the set of keys that have been completed. On launch, jump to the last-played (uncompleted) level.

6. **Level picker UX**
   - The H5 build currently uses a flat 3548-entry `<select>` — unusable in practice.
   - Options: a filter box that parses `[WxH]_[N arrows]_[Tags]` out of the file name; or a grid of small thumbnails (reuse `drawLevel` at low resolution for previews).

### P2 — polish

7. **Win screen / completion UI**
   - Today the only completion signal is the word "通关！" in the top-right status text.
   - Add a full-screen overlay with a "next level" button and an optional auto-advance timer. All assets Canvas-drawn (particles, stars, etc.) — no ripped art.

8. **Sound effects**
   - Web Audio API: synthesize short cues for tap-click, pull-whoosh, blocked-thud, escape-pop, win-fanfare.
   - WeChat: `wx.createInnerAudioContext`, or same synthesis approach.
   - **Never bundle original game audio.**

### P3 — engineering hygiene

9. **`core` unit tests**
   - Zero tests today. Highest-value coverage: `tryPull` with a few 2×2 / 3×3 hand-built fixtures asserting `progress` / `escaped` / `blocked` transitions.
   - Use `vitest` or `node:test`.

10. **Promote one-off solver / validator scripts**
    - Currently scattered under `/tmp/`, lost between sessions.
    - Create `packages/tools/` (`"private": true`, not published), move solvers and stats scripts there.

11. **Lint / formatter / CI**
    - No ESLint, Prettier, or GitHub Actions yet.
    - Minimum CI: `pnpm typecheck` plus a small sanity solver run on a fixed subset of levels.

---

## Decisions that should NOT be revisited without explicit consent

1. **No original APK art, font, or audio resources in the bundle.** Visuals are all Canvas. This is a legal red line.
2. **Level geometry data (`levels_data/`) is reused from the APK.** It's protected expression; before any public release or commercialization, re-evaluate (author new levels or obtain a license).
3. **Game model is snake-walk, not rigid translation.** Both rigid translation and rope extension were tried and rejected — rigid broke valid puzzles and showed the wrong vanish trajectory; rope made puzzles trivially solvable.
4. **No game engines.** Native TS + Canvas 2D. The `DrawCtx` interface in `packages/renderer/src/canvas-ctx.ts` lets the same renderer drive both the H5 `HTMLCanvasRenderingContext2D` and the WeChat `wx.createCanvas()` context.
5. **WeChat main bundle currently embeds only 50 levels** because the subpackage strategy isn't done yet — embedding all 3548 would blow past the 4MB main-package limit.

---

## Startup commands

```bash
# from app/
pnpm install                  # first time
pnpm dev:web                  # H5 dev server, http://localhost:5173
pnpm build:web                # H5 production build → packages/web/dist/
pnpm build:wxgame             # WeChat single-file bundle → packages/wxgame/dist/wxgame/
pnpm typecheck                # tsc --noEmit across all workspaces
```

WeChat DevTools: *Mini Game → Import Project → select `app/packages/wxgame/dist/wxgame/`*.
