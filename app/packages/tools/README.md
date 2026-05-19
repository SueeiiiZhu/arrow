# @ea/tools

Private workspace package — solver, corpus analysis, and the procedural level generator. None of these scripts ship in the H5 or wxgame bundle; they're for offline use.

All scripts depend on the compiled `@ea/core`, so they run `pnpm -F @ea/core build` (`prebuild:core`) as a prestep. If you've just edited `packages/core/`, this picks up the new code automatically.

## Quick reference

| Script | What it does |
| --- | --- |
| `pnpm --filter @ea/tools solve:big` | Solve `00190__OG_LevelBig7.json` (62 arrows). Smoke test for the solver. |
| `pnpm --filter @ea/tools solve:all -- --limit=N` | Sweep solver across the first N (or `all`) levels in `levels_data/`. Greedy escape-first solves the entire 3548-level corpus in our runs; DFS fallback (hash-memoized) is wired in case of regressions. |
| `pnpm --filter @ea/tools analyze:void -- --limit=N` | Compare LAX vs STRICT head-extension rules on N levels. Used to justify keeping the head free to cross void cells (see header of `packages/core/src/game.ts`). |
| `pnpm --filter @ea/tools stat:corpus` | Dump distributional statistics over the full 3548-level corpus (grid sizes, arrow counts, snake lengths, corners, density, facing, tags). |
| `pnpm --filter @ea/tools generate -- [flags]` | **Procedural level generator** — see below. |

## Procedural level generator (`generate.mjs`)

Generates new levels from scratch using **path-partition + facing assignment + solver-validated filtering**. Output is byte-compatible with `levels_data/*.json` but **must never be moved into `levels_data/`** — that directory is the original APK-derived corpus and the boundary matters for the legal review (see [`../../README.md`](../../README.md) §"关于关卡数据的法律边界").

### Usage

```bash
# Print 3 candidate levels to stdout as JSONL (no files written):
pnpm --filter @ea/tools generate -- --w=10 --h=10 --count=3 --seed=42

# Write to packages/tools/generated/ (gitignored):
pnpm --filter @ea/tools generate -- --w=10 --h=10 --count=5 --seed=42 --out

# Custom output directory:
pnpm --filter @ea/tools generate -- --w=14 --h=14 --count=10 --out=/tmp/gen
```

### Flags

| Flag | Default | Meaning |
| --- | --- | --- |
| `--w`, `--h` | 10 × 10 | Grid size. Sweet spot is 8–20; see "Known limits" below. |
| `--seed` | 1 | PRNG seed (`mulberry32`). Deterministic — same seed → same level. |
| `--count` | 5 | Number of levels to produce. |
| `--target-fill` | 0.85 | Desired fraction of cells covered by arrow paths. Corpus median is 0.96; the generator caps below that to leave room for the random walk. |
| `--min-arrow-len` | 2 | Minimum snake length (in cells). |
| `--max-arrow-len` | 30 | Maximum snake length. |
| `--max-attempts` | 50 | Stop after this × `count` rejected candidates. |
| `--dfs-ms` | 200 | DFS fallback wall-clock cap (ms) when greedy can't solve. 0 to disable DFS. |
| `--out` | (none) | If present (with or without `=<dir>`): write each level to a JSON file named `gen_w{W}h{H}_s{seed}_n{NNN}.json`. Without `--out`, levels are printed to stdout as JSONL (one JSON per line). The default output dir is `packages/tools/generated/`, which is `.gitignored`. |

### Algorithm

1. **Path partition** (`partition()` in `generate.mjs`). Random-walk path-cover of the W×H grid:
   - **Border-first ordering**: edge cells are visited before interior ones, so as many paths as possible start on a grid edge (where they can exit immediately by facing outward).
   - Each path walks with a ~65% straight-line bias and a random target length in `[minLen, maxLen]`.
   - Stops once `targetFill` is reached or no more starts are free. Leftover cells become void.
2. **Facing assignment** (`assignFacing()`). For each path, both ends are candidate heads:
   - The engine fixes `facing = path[0] − path[1]`, so the only choice is which end becomes `path[0]`.
   - We **prefer ends that step off-grid immediately** (head on edge facing outward) — this is the key trick that breaks the deadlock cycles random partitions otherwise produce. If neither end exits immediately, we tiebreak by shorter off-grid distance with a small random override.
3. **Solver-validated filter** (`evaluate()`).
   - Run greedy from `_solver.mjs`. If unsolvable, fall back to bounded DFS (`--dfs-ms`).
   - Reject if **`moves.length ≤ arrows.length`** — meaning every arrow escaped in one independent pull, no interaction. We want at least one re-pull (an arrow that was blocked, then freed when another escaped).

### Known limits

| Grid | Yield (current PoC) |
| --- | --- |
| 8×8  | ~5/5 within ~60 attempts |
| 10×10 | 5/5 within ~75 attempts |
| 14×14 | 5/5 within ~100 attempts |
| 20×20 | 5/5 within ~190 attempts |
| 30×30 | 0/5 (border perimeter too small relative to interior; most paths can't get an outward-facing head) |

To reach corpus-median grid sizes (31×38) we'd need a smarter algorithm. The most promising direction is **proper reverse generation**: pick an escape order, place each arrow such that after the previous ones escape, this arrow's facing is unblocked. That guarantees solvability by construction and avoids the deadlock filter altogether. See HANDOFF.md for the planned next steps.

### Reproducing the same level

```bash
pnpm --filter @ea/tools generate -- --w=10 --h=10 --seed=42 --count=1
```

The PRNG is seeded with `seed + attempt * 1009`, so the **first accepted level** for a given (W, H, seed) is stable. If you change `--max-arrow-len`, `--target-fill`, etc., the stream of candidates shifts and you may get a different first accepter.

### What about quality / "fun"?

Solvability is checked; "fun" is not. The generated levels can feel mechanical — long pipes that flush in obvious order. Two ways to raise the bar later:

- **Minimum-move filter**: require greedy `moves.length ≥ arrows.length × 1.5` (more re-pulls = more interaction).
- **Bottleneck score**: count how many arrows are blocked at least once during greedy. Reject if too few.

Both are one-liner additions to `evaluate()`.

### Why is it gitignored?

`packages/tools/generated/` is excluded by `app/.gitignore` for two reasons:

1. **Reproducible**: same `--seed` regenerates the same level, so storing the JSON adds noise without adding information.
2. **Legal hygiene**: generated levels are clean-room (not APK-derived). Keeping them in a separate, gitignored directory makes the boundary visible — there's no temptation to mix them into `levels_data/`.
