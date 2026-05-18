# AGENTS.md — Escape Arrows

> The canonical agent guide for this repo. Read by Codex, Cursor, Aider, Claude Code, and any other AI coding assistant. Claude Code additionally reads [`CLAUDE.md`](./CLAUDE.md), which is a thin Claude-specific overlay on top of this file — do not duplicate content there.

---

## What this repo is

A clean-room reimplementation of the Android game **Escape Arrows** (`com.ecffri.arrows`, Unity 6000.0.58f2 + IL2CPP). The original APK is reverse-engineered for level data only; gameplay and rendering are rewritten from scratch in **TypeScript + Canvas 2D**, targeting two outputs:

- **H5 web build** (Vite)
- **WeChat mini-game** (esbuild, single-file bundle)

## Repo layout

```
app/
├── levels_data/                 # Neutral-format level JSON (3548 levels)
├── packages/
│   ├── core/                    # Engine-neutral rules + level loader
│   ├── renderer/                # DOM-free Canvas 2D rendering
│   ├── web/                     # H5 entry (Vite)
│   └── wxgame/                  # WeChat mini-game entry (esbuild)
├── README.md                    # How to run locally
├── HANDOFF.md                   # Outstanding work, prioritized
└── AGENTS.md / CLAUDE.md        # Agent guides
```

Each package's conventions are documented in its own source — the top of `packages/core/src/game.ts` is especially important to read before touching gameplay.

## Red lines — do not cross

1. **No original APK art or audio in the bundle.** PNGs, fonts, mp3/ogg from `_extracted/` (or anywhere the original ships them) must never be `import`ed into `packages/`. All visuals are programmatic Canvas drawings; sounds (when added) must be synthesized.
2. **Level geometry data in `levels_data/` is reused from the APK.** It is protected expression — re-evaluate before any public release or commercial use.
3. **Renderer is DOM-free.** `packages/renderer/` must not reference `document` / `window` / DOM types. The shared abstraction is the `DrawCtx` interface in `packages/renderer/src/canvas-ctx.ts`, which both `HTMLCanvasRenderingContext2D` (H5) and `wx.createCanvas().getContext("2d")` (WeChat) satisfy.
4. **No game engines.** Cocos, Phaser, Pixi, Three.js, Babylon — all disallowed. Native TS + Canvas 2D only.

## Locked-in design decisions

Do not unilaterally revisit these — the user has signed off on each after explicit verification. Get explicit consent before changing:

- **Game model = snake-walk.** The body slides along its own bent `path`; the head extends past `path[0]` along `facing` in a straight line. A pull is greedy: advance until the head's next cell would collide with another non-escaped arrow's body, or the tail leaves the grid (escape). Two alternatives were tested and rejected:
  - *rigid translation* — broke valid puzzles (arrows that should move couldn't) and produced wrong vanish trajectories.
  - *rope extension* — made all puzzles trivially solvable.
  Full rationale is in the header comment of `packages/core/src/game.ts`.
- **Coordinate system:** top-left origin, +x right, +y down, row-major. `facing == -(path[1] - path[0])` (i.e., points outward away from the body, through the head end).
- **Animation:** rAF + easeOutCubic for pulls (120-450ms, scales with distance); 220ms damped shake along `facing` for blocked taps; input is gated while a pull is animating to prevent double-fires.
- **WeChat bundle currently embeds only the first 50 levels.** Subpackage splitting for the remaining ~3500 is unimplemented (see HANDOFF.md P1).

## Running and building

```bash
# from app/
pnpm install                  # first time
pnpm dev:web                  # H5 dev server, http://localhost:5173
pnpm build:web                # H5 production build → packages/web/dist/
pnpm build:wxgame             # WeChat single-file bundle → packages/wxgame/dist/wxgame/
pnpm typecheck                # tsc --noEmit across all workspaces
```

WeChat DevTools: *Mini Game → Import Project → select `packages/wxgame/dist/wxgame/`*.

## Working conventions

- Run `pnpm typecheck` after multi-file edits before claiming success.
- After changing `packages/core/`, run `pnpm build:core` so external `node` scripts (solvers, validators) see the new compiled output.
- For UI / interaction changes, start the dev server and describe the verification steps to the user — they will eyeball the result.
- Keep throwaway scripts out of `/tmp/`; if a script becomes worth reusing, add it under a new `packages/tools/` (not yet created — log it in HANDOFF.md when you do).
- Commit messages: concise, in Chinese (matches the user's repo style and existing history).

## Do / Don't

| ❌ Don't | ✅ Do |
| --- | --- |
| `import "....ArrowHead.png"` | Draw the shape with Canvas paths |
| `import "phaser"` | Use native Canvas 2D APIs |
| Reference `document` from `renderer/` | Use the `DrawCtx` interface |
| Quietly switch the game model back to rigid translation | Keep snake-walk |
| Add `assetsInclude: ["**/*.json"]` to `vite.config.ts` | Leave default JSON-as-ESM (we hit a blank-page bug because of this once) |
| Spawn one-off `*-NOTES.md` files for every task | Edit README.md / HANDOFF.md instead |
| Push to origin without checking the user is authorized for that remote | Confirm first; the remote owner may differ from the local SSH identity |

## User preferences

- Default to Chinese in user-facing messages; keep code identifiers and technical terms in their original English.
- Prefer end-to-end execution over interrupt-driven check-ins. If a small ambiguity can be inferred from the codebase, infer and continue.
- The user verifies UI bugs themselves in the browser — focus your effort on writing the fix clearly and explaining what to look at.

## Where to start next session

Open [`HANDOFF.md`](./HANDOFF.md) and pick from the P0 list. The current top three:

1. Browser-verify the snake-walk model across 5-10 levels.
2. Build a smarter solver for `OG_LevelBig7` (62 arrows) — current bounded DFS times out.
3. Decide whether head extension must stay inside `levelMask` (currently unrestricted).
