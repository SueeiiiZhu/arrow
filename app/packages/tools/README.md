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
| `pnpm --filter @ea/tools generate -- [flags]` | **Procedural level generator** (path-partition algorithm — see below). |
| `pnpm --filter @ea/tools generate:reverse -- [flags]` | **Reverse-construction generator** (recommended; scales to corpus-median grids — see below). |

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

**This algorithm tops out around 20×20.** For corpus-median grids (31×38) and beyond, use the reverse-construction generator below — solvability is guaranteed by construction instead of by post-hoc filtering.

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

## Reverse-construction generator (`generate-reverse.mjs`) — recommended

Same output format as `generate.mjs`, same legal boundary (never move into `levels_data/`), but the algorithm is fundamentally different: instead of randomly partitioning then filtering, it places arrows **in reverse escape order** so that solvability is guaranteed by construction.

### Why it works

The snake-walk engine blocks a head step only when the new head cell is occupied by **another** non-escaped arrow's body (see `tryPull` in `packages/core/src/game.ts`). Self-body cells, void cells, and cells belonging to already-escaped arrows are all transparent.

That means a level is solvable iff there exists an escape order `[A_1, A_2, …, A_n]` such that for each `k`, when `A_k` is pulled, the facing ray from `A_k.path[0]` to off-grid passes only through cells **not** occupied by `A_{k+1..n}` (the arrows that will outlive `A_k`). `A_1..A_{k-1}` have already escaped, so their cells are free.

We build that guarantee in reverse: place `A_n` first (no constraints — nothing in the grid yet), then `A_{n-1}` (must clear `A_n`), then `A_{n-2}` (must clear `A_n` ∪ `A_{n-1}`), … finally `A_1` (must clear everyone else). At placement time the grid contains exactly the arrows the new arrow must avoid, so checking "facing ray is empty" is a single grid lookup.

### Algorithm

1. Start with an empty grid.
2. For `k = n, n-1, …, 1` (target arrow count `n` is bounded by `--max-arrows` and `--target-fill`):
   - Enumerate all `(start, facing)` anchors where `start` is empty, `start + i*facing` for `i=1,2,…` is empty until off-grid, and `start − facing` is in-grid + empty (this cell becomes `path[1]`).
   - Shuffle and pick the first anchor; from `path[1]`, do a straight-biased random walk through empty cells to extend `path[2..]` to a target length in `[minLen, maxLen]`.
   - Mark the path cells as occupied; record the arrow.
3. Reverse the recorded list so `arrows[0]` is the first to escape. That sequence is the constructed solution.
4. **Verify** by simulating `tryPull(arrowId)` for `id = 0, 1, …, n-1`. If any pull doesn't escape, the algorithm has a model bug — reject loudly. (Should never happen.)
5. **Sequencing filter**: count how many arrows have an unblocked facing ray in the *initial* state. If too many (`> arrows × min-sequencing`, default 0.5) the level is too trivial — reject.

### Usage

```bash
# 3 candidates printed to stdout (JSONL):
pnpm --filter @ea/tools generate:reverse -- --w=30 --h=30 --count=3 --seed=1

# Write to packages/tools/generated/ (gitignored):
pnpm --filter @ea/tools generate:reverse -- --w=31 --h=38 --count=5 --seed=1 --out

# Stricter sequencing — at most 20 % of arrows allowed to escape independently:
pnpm --filter @ea/tools generate:reverse -- --w=20 --h=20 --count=5 --min-sequencing=0.2
```

### Flags

| Flag | Default | Meaning |
| --- | --- | --- |
| `--w`, `--h` | 10 × 10 | Grid size. Scales to corpus median (31×38) and beyond. |
| `--seed` | 1 | PRNG seed (`mulberry32`). Deterministic. |
| `--count` | 5 | Number of accepted levels to produce. |
| `--target-fill` | 0.85 | Desired fraction of cells covered. Construction stops when reached. |
| `--min-arrow-len` | 3 | Minimum arrow length. |
| `--max-arrow-len` | 30 | Maximum arrow length. |
| `--max-arrows` | 300 | Hard cap on arrows per level. |
| `--max-attempts` | 20 | Stop after this × `count` rejected candidates. |
| `--min-sequencing` | 0.5 | Reject if fraction of *initially* escapable arrows exceeds this. Lower = tighter puzzle (harder to find). |
| `--out` | (none) | If present (with or without `=<dir>`): write `gen_rev_w{W}h{H}_s{seed}_n{NNN}.json`. Without `--out`, JSONL to stdout. Default dir: `packages/tools/generated/` (gitignored). |

### Yield

| Grid | Result | Notes |
| --- | --- | --- |
| 8×8 | 5/5 in ~10 attempts | Trivial-rejection dominates here — small grids have few sequencing patterns. |
| 10×10 | 3/3 in ~7 attempts | |
| 20×20 | 10/10 in ~16 attempts | |
| 30×30 | 5/5 in 5 attempts | First-try acceptance. Partition algorithm yielded 0/5 at this size. |
| 31×38 | 5/5 in 5 attempts | Corpus median — comfortably in reach. |
| 50×50 | 3/3 in 3 attempts | No regression past 30×30. |

Verifier (step 4 above) has never failed across these runs. Iff it fires, that's a signal the construction or the engine's collision rule has drifted out of sync — investigate before shipping the output.

### What about quality / "fun"?

The `--min-sequencing` filter is a coarse quality lever — it caps the fraction of arrows that can escape from the initial state without anyone else moving. Lowering it forces tighter, more sequential puzzles (at the cost of more rejections). Other levers that could be wired in:

- **Greedy heuristic gap**: ratio of greedy `moves` to optimal `arrows` count. Higher = more re-pulls during play = more interaction.
- **Bottleneck arrow**: count arrows that block ≥ 2 other arrows' facing rays. These are the "keystone" pieces that make a level memorable.
- **Path-length distribution**: corpus median is p50=7 / p90=24. The default `[3, 30]` matches that, but a more constrained distribution might feel more curated.

None wired yet — the current generator gates only on construction correctness and the sequencing fraction.
