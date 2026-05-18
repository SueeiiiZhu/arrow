# CLAUDE.md

This file is a thin Claude Code-specific overlay. **The canonical guide for working in this repo is [`AGENTS.md`](./AGENTS.md)** — read it first; it covers project goals, repo layout, red lines (no original APK assets, no game engines, renderer is DOM-free), locked-in design decisions (snake-walk model, coordinate system, animation), and the workflow / do-don't list. Everything below is Claude-only additions; do not duplicate AGENTS.md content here.

## Stacking with the global config

`~/.claude/CLAUDE.md` sets several global rules (default Chinese output, end-to-end execution, subagent model routing by task type). All of those continue to apply here — this file does not override them. AGENTS.md repeats the user-preference summary in English so non-Claude tools see it too, but the authoritative version of those preferences lives in the user's global config.

## When working in this repo

- Prefer `Edit` over `Write` when changing existing files.
- Use `Read` before `Edit` (the harness enforces this anyway).
- When `pnpm dev:web` is needed for visual verification, launch it via `Bash` with `run_in_background: true` and tell the user the URL — don't poll.
- Long-running solver / validator scripts go via background `Bash` as well; surface the result, don't sleep-loop.
- Use the task tracker (`TaskCreate` / `TaskUpdate` / `TaskList`) for any multi-step work. The current pending task list is the source of truth for "what's left" — see also [`HANDOFF.md`](./HANDOFF.md) for the human-readable prioritized version.
- For exploratory questions across the codebase, dispatch the `Explore` subagent rather than grepping serially in the main loop.

## Things Claude has previously been tempted to do — and shouldn't

- Re-add `assetsInclude: ["**/*.json"]` to `packages/web/vite.config.ts`. This breaks JSON imports and produces a silently-blank page. AGENTS.md lists it under Don't.
- Switch the game model "for simplicity" — snake-walk was chosen deliberately after rejecting rigid translation and rope extension. Header comment of `packages/core/src/game.ts` has the full argument.
- Bundle PNGs from `_extracted/main/data/Sprite/` (e.g., `ArrowHead.png`). The visual style is approximated with Canvas paths (`drawArrowGlyph`, `drawTailCap` in `packages/renderer/src/board.ts`) precisely so we never ship the originals.

## Pointer

Open [`AGENTS.md`](./AGENTS.md) for everything else, and [`HANDOFF.md`](./HANDOFF.md) for the prioritized TODO list.
