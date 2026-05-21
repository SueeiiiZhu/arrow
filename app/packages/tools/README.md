# @ea/tools

> 中文版本: [README.zh-CN.md](./README.zh-CN.md)

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
| `pnpm --filter @ea/tools generate:partition -- [flags]` | **Partition-first generator v2** — real path-partition + Kahn joint facing/escape-order + targeted SCC-core backtracking. Beats reverse and matches/beats corpus on most structural metrics at 10×10 through 25×31. 31×38 works but minutes per candidate. See "Partition-first generator" below. |
| `pnpm --filter @ea/tools quality:eval -- --w=W --h=H [--count=N]` | Distributional comparison: reverse-generated batch vs. same-size corpus sample, on fill / init-escapable / bottleneck / greedy-moves / path-length. Also supports `--from-dir=<dir>` to load externally-generated levels (use this to evaluate `generate:partition` output). See "Quality evaluation" below. |

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

1. Start with an empty grid. Maintain `rayMap`: empty cell → number of preceding arrows whose facing ray passes through it. Placing a body cell here will block that many earlier-placed arrows in the final init state.
2. For `k = n, n-1, …, 1` (target arrow count `n` is bounded by `--max-arrows` and `--target-fill`):
   - Enumerate `(start, facing)` anchors where `start` is empty, `start + i*facing` is empty out to off-grid, and `start − facing` (= `path[1]`) is in-grid + empty. Record each anchor's `rayLen` (number of in-grid ray cells).
   - **Bucket anchors** so the better init-esc reducers run first:
     - `bucket[0]`: `rayLen ≥ 1` AND `path[1]` already on `rayMap` — placing here blocks a prior arrow immediately.
     - `bucket[1]`: `rayLen ≥ 1`, `path[1]` not on `rayMap`.
     - `bucket[2]`: `rayLen == 0` — the head escapes immediately and the arrow is forever init-escapable (no cell exists where any blocker could sit). Kept as a fallback so the grid can fill.
   - From the first successful bucket, do a random walk through empty cells to extend `path[2..]` to a target length in `[minLen, maxLen]`. The walk **prefers cells already on `rayMap`** (`--ray-bias`, default 0.95) over the straight direction (`--straight-bias`, default 0.65); ray cells block prior arrows on contact.
   - Mark path cells occupied; record the new arrow's ray into `rayMap`.
3. Reverse the recorded list so `arrows[0]` is the first to escape. That sequence is the constructed solution.
4. **Extend tails**: round-robin over arrows, growing each arrow's tail into adjacent empty cells. New cell `c` is rejected if it sits on any **earlier-escaping** arrow's ray (would break that earlier arrow's pull). Among valid candidates, prefer cells on a **still-init-escapable** later arrow's ray (so the extension converts it to blocked), then cells on any later arrow's ray, then any empty cell. Each arrow may grow up to 30 cells total. This phase closes the remaining fill gap without touching the construction-time guarantee.
5. **Verify** by simulating `tryPull(arrowId)` for `id = 0, 1, …, n-1`. If any pull doesn't escape, the algorithm has a model bug — reject loudly. (Should never happen.)
6. **Sequencing filter**: count how many arrows have an unblocked facing ray in the *initial* state. If too many (`> arrows × min-sequencing`, default 0.5) the level is too trivial — reject.

### Usage

```bash
# 3 candidates printed to stdout (JSONL):
pnpm --filter @ea/tools generate:reverse -- --w=30 --h=30 --count=3 --seed=1

# Write to packages/tools/generated/ (gitignored):
pnpm --filter @ea/tools generate:reverse -- --w=31 --h=38 --count=5 --seed=1 --out

# Stricter sequencing — at most 20 % of arrows allowed to escape independently:
pnpm --filter @ea/tools generate:reverse -- --w=20 --h=20 --count=5 --min-sequencing=0.2

# Tuned "strict" preset (chain-depth ≥ 8 + bottleneck ≥ 15 % + 120 attempts/level).
# Pushes a generated batch ~1 σ closer to the corpus distribution. ~5× slower
# than the default but stays under a minute for count=10 at corpus-median grid.
pnpm --filter @ea/tools generate:reverse -- --w=25 --h=31 --count=10 --seed=1 --preset=strict --out
```

### Flags

| Flag | Default | Meaning |
| --- | --- | --- |
| `--w`, `--h` | 10 × 10 | Grid size. Scales to corpus median (31×38) and beyond. |
| `--seed` | 1 | PRNG seed (`mulberry32`). Deterministic. |
| `--count` | 5 | Number of accepted levels to produce. |
| `--target-fill` | 0.85 | Desired fraction of cells covered. Construction stops when reached (then tail extension may push higher). |
| `--min-arrow-len` | 3 | Minimum arrow length. |
| `--max-arrow-len` | 12 | Construction-time target cap. Tail extension (step 4) can still grow arrows up to 30 cells. Shorter construction = more arrows = denser blocking. |
| `--max-arrows` | 300 | Hard cap on arrows per level. |
| `--max-attempts` | 20 | Stop after this × `count` rejected candidates. |
| `--min-sequencing` | 0.5 | Reject if fraction of *initially* escapable arrows exceeds this. Lower = tighter puzzle (harder to find). |
| `--min-chain-depth` | 0 | Reject if longest static blocker chain shorter than N. Corpus median ≈ 10; the reverse-generator's own median ≈ 8. |
| `--min-bottleneck` | 0 | Reject if fraction of arrows blocking ≥ 2 other arrows is below this. Corpus median ≈ 25 %; the reverse-generator's own median ≈ 10 %. |
| `--ray-bias` | 0.95 | When extending a path, probability of picking a cell already on a preceding arrow's facing ray over any other valid neighbour. High keeps init-escapable count low. |
| `--straight-bias` | 0.65 | Probability of continuing in the same direction during path extension (applied after ray-bias). |
| `--preset` | (none) | Apply a named bundle of gates BEFORE individual flags. `loose` = today's defaults; `strict` = `--min-chain-depth=8 --min-bottleneck=0.15 --max-attempts=120`. Individual flags after `--preset` override its values. |
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

## Partition-first generator (`generate-partition.mjs`) — v2

A sibling of `generate-reverse.mjs` with a fundamentally different construction primitive: instead of placing arrows in reverse escape order (reverse-construction's invariant), it first **path-partitions the grid** into snake-shaped paths (geometry only, no facing yet), then **jointly assigns each path's facing and escape order via Kahn-style topological construction**. Choosing facing and order at the same time means we never produce a cycle in the blocker DAG — Phase 3 of the older "topo-sort, then break cycles" sketch doesn't exist as a separate step. v2 adds **targeted SCC-core backtracking**: when Kahn deadlocks, the unpicked paths *are* the strongly-connected component, so we drop exactly those (plus a few neighbour-boundary paths for perturbation), then regrow with the advanced PRNG.

### Why this beats reverse on structural quality

Reverse-construction has to keep every new arrow's ray clear of all previously placed bodies. That clearance constraint caps fill at ~85 % on 25×31 and tightly couples body placement to ray placement — bodies are spread out, not clustered. Bottleneck % and chain-depth suffer.

Partition-first only commits to facings AFTER the geometry is pinned, so paths may freely cross other paths' rays. Each ray crossing becomes a topological dependency (the crossed-by-ray path must escape before the crossing-ray path). Density of crossings = density of dependencies = depth of chain.

### Measured quality (2026-05-21)

**20×20, count=5, seed=1** vs n=1 corpus and reverse-gen:

| metric | partition v2 | reverse-gen v1 | corpus (n=1) |
| --- | --- | --- | --- |
| arrows (med) | 57 | ~25 | 29 |
| fill % (med) | 97 % | ~85 % | 99 % |
| init-escapable % (med) | **11 %** | ~30 % | 24 % |
| bottleneck % (med) | **21 %** | ~12 % | 17 % |
| forced-chain depth (med) | **8** | ~7 | 6 |
| yield | 5/5 in 11 attempts | 10/10 in 16 attempts | — |

**25×31 (corpus median), count=5, seed=2** vs n=7 corpus levels:

| metric | partition v2 | reverse-gen v1 | corpus (n=7) |
| --- | --- | --- | --- |
| arrows (med) | 98 | ~64 | 67 |
| fill % (med) | **96 %** | 85 % | 97 % |
| init-escapable % (med) | **15 %** | 30 % | 9 % |
| bottleneck % (med) | **19 %** | 11 % | 26 % |
| forced-chain depth (med) | **9** | 7 | 10 |
| yield (target-fill=0.85) | 5/5 in 34 attempts | — | — |

Partition v2 closes the 25×31 gap that v1 couldn't reach: fill matches corpus, chain-depth matches corpus (9 vs 10), bottleneck within 7pp (19 % vs 26 %), init-escapable down from reverse-gen's 30 % to 15 % (still 6pp above corpus' 9 %). It packs more arrows of shorter length than the corpus, which is the partition primitive's signature — and which our `--min-sequencing` / `--min-chain-depth` gates approve of.

### Known limitation: 31×38 and larger

v2 backtracking works on 31×38 (the largest commonly-occurring corpus size) but **takes minutes per candidate** because the partition has ~120 paths and each backtrack triggers a full Kahn re-run with O(N²) blocker-scan. If you need 31×38+ levels, use `generate:reverse` (sub-second per candidate, but with the structural-quality gaps documented in its section). v2 ≤ 25×31 is fast (seconds per candidate).

### v1 (deprecated)

v1 used Kahn restarts with random tie-break but no geometric backtracking. It deadlocked on dense 25×31+ partitions because random self-avoiding paths tend to form unbreakable strongly-connected components in the blocker DAG. v2 fixes this by detecting the SCC core (= unpicked paths after Kahn) and undoing exactly those. The previous v1 limitation that "25×31 yield is 1/3 at target-fill=0.7" is fully resolved at target-fill=0.85.

### Usage

```bash
# Smoke test (5 levels at 15×15):
pnpm --filter @ea/tools generate:partition -- --w=15 --h=15 --count=5 --seed=1

# Write to packages/tools/generated/ (gitignored):
pnpm --filter @ea/tools generate:partition -- --w=20 --h=20 --count=10 --seed=1 --out

# Corpus-median 25×31 (v2 territory — push backtracks higher for borderline cases):
pnpm --filter @ea/tools generate:partition -- --w=25 --h=31 --count=5 --seed=2 \
  --target-fill=0.85 --max-backtracks=50 --out

# Compare against same-size corpus (or against reverse-generator output):
mkdir -p /tmp/eval-partition
pnpm --filter @ea/tools generate:partition -- --w=20 --h=20 --count=30 --seed=1 \
  --out=/tmp/eval-partition
pnpm --filter @ea/tools quality:eval -- --from-dir=/tmp/eval-partition
```

### Flags

Inherits sequencing / chain / bottleneck / deadlock gates from `generate:reverse`. Partition-specific:

| Flag | Default | Meaning |
| --- | --- | --- |
| `--target-fill` | 0.95 | Fraction of cells covered by partition paths. Phase 1 stops when reached; tail extension may push higher. |
| `--min-arrow-len` | 3 | Minimum path length grown by Phase 1. |
| `--max-arrow-len` | 12 | Maximum path length grown by Phase 1. Shorter = more paths = denser blocking. |
| `--init-esc-rate` | 0.1 | When Kahn has both "blocked" (ray-blocked) and "open" (no blockers) candidates available, probability of picking an open one. Lower = tighter sequencing. |
| `--kahn-retries` | 20 | Phase-2 retry budget when Kahn deadlocks on a fixed geometry. Higher helps borderline cases; v2 backtracking handles the rest. |
| `--max-backtracks` | 20 | v2 SCC-core backtrack budget per candidate. Raise to 50–80 on 25×31+ to keep yield up at high `--target-fill`. |
| `--backtrack-chunk` | 3 | After each backtrack also drop this many of the most recently *picked* paths, to perturb the SCC boundary so re-growth doesn't refill identical holes. |
| `--max-deadlock-rate` | 0.05 | Reject if random-pull rollout deadlocks above this rate (`--rollout-trials=100` default). Catches puzzles solvable by construction but unfriendly to greedy human play. |
| `--straight-bias` | 0.65 | Probability of continuing in the same direction during path growth. |

## Quality evaluation (`quality-eval.mjs`)

Generator output is "solvable by construction", but solvability is the floor, not the ceiling. To know whether the generated batch *feels* like the APK corpus, we compare distributions on a handful of shape / structural / heuristic-difficulty metrics — a side-by-side at the same grid size.

The script generates `--count` levels via the reverse algorithm at `W × H`, scans `levels_data/` for corpus levels at the **same** dimensions, and prints mean / median / IQR for each metric for both sides.

### Usage

```bash
# 30 generated 25×31 levels vs all corpus levels at 25×31:
pnpm --filter @ea/tools quality:eval -- --w=25 --h=31 --count=30 --seed=1

# Skip the corpus comparison (faster, generator-only smoke check):
pnpm --filter @ea/tools quality:eval -- --w=20 --h=20 --count=20 --gen-only
```

### Flags

| Flag | Default | Meaning |
| --- | --- | --- |
| `--w`, `--h` | 25 × 31 | Grid size. Pick a size with several corpus matches (use `stat:corpus` to find common sizes). |
| `--count` | 30 | Number of synthetic levels to generate. |
| `--seed` | 1 | PRNG seed (`mulberry32`). |
| `--max-attempts` | 20 | Per-level rejection cap, mirrors `generate-reverse.mjs`. |
| `--gen-only` | off | Skip the corpus scan — just dump generator-side stats. |
| `--from-dir` | (none) | Load "generated" levels from `.json` files in `<dir>` instead of running the inline reverse-generator. Use this to evaluate any external generator (e.g. `generate-partition.mjs` output). With `--from-dir`, `--w` / `--h` are inferred from the loaded files, `--seed` is ignored, and `--count` caps how many files are loaded. |

### Metrics

| Metric | What it captures |
| --- | --- |
| `arrows` | Arrow count per level. |
| `fill %` | `(sum of arrow lengths) / (W × H)`. Corpus median is ~96 %. |
| `init-escapable %` | Fraction of arrows that can already escape from the initial state (facing ray clear). **High = loose puzzle, low = tight.** |
| `bottleneck %` | Fraction of arrows whose body blocks ≥ 2 other arrows' facing rays. **High = more keystone pieces.** |
| `greedy moves/arrow` | Ratio of greedy escape moves to arrows. `> 1.0` means at least one re-pull. **The current generator and corpus both sit at exactly 1.0**, so the greedy heuristic doesn't currently discriminate — listed for future tuning. |
| `path len p50` / `p90` | Snake-length percentiles within the level. Corpus median (across levels) is p50≈7, p90≈24. |

### Example output

```
=== 25×31 · generated=30 · corpus=7 · seed=1 ===
metric                [generated]                               [corpus]
──────────────────────────────────────────────────────────────────────────────────────
arrows                μ    63   med    65   iqr    57–   67    μ    57   med    67   iqr    37–   70
fill %                μ  85%   med  86%   iqr  82%– 89%        μ  97%   med  97%   iqr  95%– 99%
init-escapable %      μ  30%   med  30%   iqr  26%– 33%        μ   9%   med   9%   iqr   6%– 11%
bottleneck %          μ  11%   med  11%   iqr  10%– 12%        μ  25%   med  26%   iqr  21%– 27%
greedy moves/arrow    μ  1.00   med  1.00   iqr  1.00– 1.00    μ  1.00   med  1.00   iqr  1.00– 1.00
path len p50          μ    10   med    10   iqr     9–   11    μ    10   med     8   iqr     6–   15
path len p90          μ    19   med    19   iqr    17–   20    μ    33   med    27   iqr    25–   47
```

### How to read the gaps

- **Arrows & path-length p50 — matched.** Construction-time `--max-arrow-len=12` (then tail extension up to 30) lands the count and shape on the corpus median.
- **Fill 85 % vs 97 %** — still 12pp below the corpus. Tail extension already greedily fills every neighbour it can; the residual gap is empty pockets that no in-place body can reach without breaking solvability. Closing it would need a different construction primitive (e.g. partitioning the grid first, then routing arrows through partitions).
- **Init-escapable 30 % vs 9 %** — still well above corpus. ~12pp of it is structural (zero-ray anchors: head at edge facing outward, no cell exists for a blocker — they appear because we keep them as a fallback to maintain fill). The remaining ~18pp is "blockable but not blocked": anchors whose body never lands on a preceding arrow's ray. `extendPath` now picks ray-overlapping cells first (`--ray-bias=0.95`), which moved the needle a little but the geometry is still loose. Tightening further with `--min-sequencing=0.2` is possible at the cost of many more rejected attempts.
- **Bottleneck 11 % vs 25 %** — fewer keystone arrows. Same root cause as init-esc: bodies are not concentrated densely enough on shared chokepoints.
- **Greedy moves/arrow 1.00 on both sides** — current heuristic can't tell them apart. If you want this metric to discriminate, the generator needs to force re-pulls (e.g., reject any level the verifier solves in `arrows.length` moves flat).

Treat the gaps as the prioritized punch list for the next generator pass. Re-run after each change and look for the deltas to narrow.

### Corpus size warning

At rare grid sizes the corpus side may have only one or two matches, which makes mean/IQR meaningless. Common sizes (e.g., 25×31, 31×38) have dozens. Use `pnpm --filter @ea/tools stat:corpus` to find sizes that are well-represented before running an evaluation.
