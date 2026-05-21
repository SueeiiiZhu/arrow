# Escape Arrows — H5 + WeChat Mini Game

> 中文版本: [README.zh-CN.md](./README.zh-CN.md)

Reimplementation of an APK-decompiled puzzle game's level geometry in TypeScript + Canvas. **No original art assets are bundled** — we only reuse the level data in `levels_data/`.

## Legal boundary around level data

All code / rendering / sound effects in this repo are written from scratch; the visual style is approximated with Canvas paths (see `drawArrowGlyph` / `drawTailCap` in `packages/renderer/src/board.ts`), with zero dependency on the original APK's PNGs / fonts / mp3 / ogg. **Do not commit any of those original assets** — the repo-root `.gitignore` uses an allowlist strategy (`/*` + `!/app` + `!/.github`) that actively excludes `_extracted/`, `AndroidManifest.xml`, `classes*.dex`, and every other APK-decompilation byproduct. **Do not bypass it.**

The only **version-controlled** "content from the APK" is the 3548 level JSONs under `levels_data/`. These are level geometry coordinates (not art assets), but they still count as copyrighted **protected expression**. Today they're used for personal / learning purposes only; **before any form of public release, app-store listing, or commercialization, this must be re-evaluated**. Possible paths:

- Author a fresh batch of levels to replace `levels_data/` (recommended).
- Or negotiate a license / co-release with the original author.
- Or open-source the engine code only, removing `levels_data/` so consumers bring their own.

This boundary is also recorded as red lines #1 / #2 in [`AGENTS.md`](./AGENTS.md).

## Repo layout


```
app/
├── levels_data/                # Level JSONs (converted from the APK to a neutral format)
├── packages/
│   ├── core/                   # Engine-agnostic rules: snake-walk model + level loading + compact decoder
│   ├── renderer/               # DOM-free Canvas 2D renderer
│   ├── lives/                  # Hearts/lives system: pure functions + host-neutral createLivesStore
│   ├── web/                    # H5 entry (Vite)
│   ├── wxgame/                 # WeChat mini-game entry (esbuild single-file bundle + 12 subpackages)
│   └── tools/                  # Solver / corpus analysis / level generator (private)
└── package.json                # pnpm workspace root
```

## Prerequisites

```bash
# in app/
pnpm install
```

Requires Node ≥ 18 and pnpm 10.

## 1. Local Web testing (H5)

```bash
pnpm dev:web
```

Vite defaults to `http://localhost:5173` (if the port is taken it falls through to 5174, 5175, …; the actual port is printed in the startup log).

In the browser:
- Top dropdown picks a level; arrow keys / `prev` `next` buttons flip between them.
- `reset` resets the current level.
- Click / touch an arrow:
  - Movable → body slides along its bent path, head extends straight along `facing`.
  - Blocked → small shake along `facing` as feedback.

Production build:

```bash
pnpm build:web   # output in packages/web/dist/
```

The build runs `predev` / `prebuild` hooks → `packages/web/scripts/build-levels.mjs`, which splits the 3548 levels into **30 main levels (embedded in `src/levels.generated.ts`) + 12 packs** (written to `packages/web/public/packs/packN.json`, ~1.3 MB each). At runtime the picker shows every level immediately; jumping past level 30 fetches the matching pack on demand and caches it in a Map. The whole pipeline shares the `packages/wxgame/scripts/_encode.mjs` encoder with the WeChat subpackages below.

> Historical landmine: `web/src/main.ts` used to pull all 3548 JSONs synchronously via `import.meta.glob`, which OOMed `vite build`. **Do not roll back to the glob approach, and do not add `assetsInclude: ["**/*.json"]` back to `vite.config.ts`** — the latter treats JSON as build assets and silently produces a blank page.

## 2. WeChat mini-game

The main bundle embeds only the **first 30 levels** (~560 KB). The remaining 3518 levels are split into **12 subpackages** of ~1.3 MB each, loaded on demand via `wx.loadSubpackage`. The whole game is ~15 MB total, comfortably under the wxgame 20 MB cap. Encoder lives in `packages/wxgame/scripts/_encode.mjs` (shared with H5); subpackage emission is in `packages/wxgame/scripts/bundle.mjs`.

### Build

```bash
pnpm build:wxgame
```

Output:

```
packages/wxgame/dist/wxgame/
├── game.js               # esbuild CJS main bundle + 30 levels, ~560 KB
├── game.json             # Mini-game manifest (includes the subpackages field)
└── pack0/ … pack11/      # 12 subpackages; each index.js writes data into globalThis.__EA_PACK_DATA[N]
```

### Run in WeChat DevTools

1. Open **WeChat DevTools → Mini Game → Import Project**.
2. Pick directory `app/packages/wxgame/dist/wxgame/`.
3. Select the "test AppID" (unless you need on-device preview).
4. The project auto-loads `game.js`; the debugger shows console / performance / drawing.

The controls are identical to H5: tap an arrow in the middle of the screen to pull; the three HUD zones are prev / reset / next.

> On-device preview / upload requires switching to your own AppID and configuring network domains per WeChat's rules. This project makes no network requests, so the network config can be left empty.

## Common commands

| Command | What it does |
| --- | --- |
| `pnpm dev:web` | Start Vite for H5 dev (auto-runs `predev` → generates `levels.generated.ts` + `public/packs/`). |
| `pnpm build:web` | Production build for H5 (`packages/web/dist/`, auto-runs `prebuild`). |
| `pnpm build:wxgame` | Main bundle (30 levels) + 12 subpackages + `game.json` (`packages/wxgame/dist/wxgame/`). |
| `pnpm build:core` | Build `core` to `dist/` (needed when running non-TS scripts). |
| `pnpm build:renderer` | Build `renderer` to `dist/`. |
| `pnpm typecheck` | `tsc --noEmit` across all packages. |
| `pnpm lint` / `pnpm lint:fix` | Biome check / safe autofix. |
| `pnpm test` | `node:test` (`@ea/core` 24 cases + `@ea/lives` 19 cases). |

## About the rules model

The current model is **snake-walk**: the arrow body slides along its own bent `path`, and the head extends straight along `facing` past `path[0]`. A "pull" is greedy — the head keeps advancing until it hits a cell currently occupied by another arrow, or the entire snake tail leaves the grid (escape). See the header comment of `packages/core/src/game.ts`; the rejected alternatives (rigid translation / rope extension) are documented there too.
