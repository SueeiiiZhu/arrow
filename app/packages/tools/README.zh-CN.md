# @ea/tools

> English: [README.md](./README.md)

私有 workspace 包 —— 求解器、语料分析、过程化关卡生成器。这些脚本**不会**打进 H5 或 wxgame 产物，只在本地离线用。

所有脚本都依赖已构建的 `@ea/core`，所以会先跑 `pnpm -F @ea/core build`（`prebuild:core`）作为 prestep。如果你刚改了 `packages/core/`，这一步会自动同步到最新代码。

## 速查表

| 脚本 | 作用 |
| --- | --- |
| `pnpm --filter @ea/tools solve:big` | 解 `00190__OG_LevelBig7.json`（62 个箭头）。求解器烟雾测试。 |
| `pnpm --filter @ea/tools solve:all -- --limit=N` | 把求解器扫到 `levels_data/` 的前 N 关（或 `all`）。我们的运行结果：贪心 escape-first 可以解完整 3548 关全语料；DFS 兜底（带 hash memo）作为回归保险。 |
| `pnpm --filter @ea/tools analyze:void -- --limit=N` | 在 N 关上对比 LAX vs STRICT 的 head 延伸规则。用来论证保留「head 自由穿过 void 格」的设定（详见 `packages/core/src/game.ts` 顶部注释）。 |
| `pnpm --filter @ea/tools stat:corpus` | 把 3548 关全语料的分布统计 dump 出来（网格大小、箭头数、蛇长、转角数、密度、facing、tag）。 |
| `pnpm --filter @ea/tools generate -- [flags]` | **过程化关卡生成器**（path-partition 算法 —— 见下）。 |
| `pnpm --filter @ea/tools generate:reverse -- [flags]` | **反向构造生成器**（推荐；能扩展到 corpus 中位网格 —— 见下）。 |
| `pnpm --filter @ea/tools generate:partition -- [flags]` | **Partition-first 生成器 v2** —— 真 path-partition + Kahn 联合 facing/escape-order + targeted SCC-core 回溯。在 10×10 到 25×31 上结构指标对齐或超过 corpus 和 reverse-gen。31×38 可用（2026-05-22 放宽 `--max-deadlock-rate` 默认值之后），详见下面「Partition-first 生成器」章节。 |
| `pnpm --filter @ea/tools quality:eval -- --w=W --h=H [--count=N]` | 分布对比：reverse-gen 批次 vs 同尺寸语料样本，比较 fill / init-escapable / bottleneck / greedy-moves / path-length。也支持 `--from-dir=<dir>` 加载外部生成器的输出（用这个评估 `generate:partition` 的产物）。详见下面「质量评估」章节。 |

## 过程化关卡生成器（`generate.mjs`）

用 **path-partition + facing 分配 + 求解器验证过滤** 从零生成新关卡。输出格式和 `levels_data/*.json` 字节兼容，但**绝对不要把它放进 `levels_data/`** —— 那个目录是原 APK 衍生的语料，边界对法律审阅来说很重要（详见 [`../../README.md`](../../README.md) §「关于关卡数据的法律边界」）。

### 用法

```bash
# 把 3 个候选关卡按 JSONL 打到 stdout（不落盘）：
pnpm --filter @ea/tools generate -- --w=10 --h=10 --count=3 --seed=42

# 写到 packages/tools/generated/（gitignored）：
pnpm --filter @ea/tools generate -- --w=10 --h=10 --count=5 --seed=42 --out

# 自定义输出目录：
pnpm --filter @ea/tools generate -- --w=14 --h=14 --count=10 --out=/tmp/gen
```

### Flags

| Flag | 默认 | 含义 |
| --- | --- | --- |
| `--w`, `--h` | 10 × 10 | 网格大小。甜区是 8–20；详见下面「已知上限」。 |
| `--seed` | 1 | PRNG 种子（`mulberry32`）。确定性 —— 同 seed → 同关卡。 |
| `--count` | 5 | 要产出的关卡数。 |
| `--target-fill` | 0.85 | 期望的箭头路径覆盖比例。语料中位是 0.96；生成器特意压在下面给随机游走留余量。 |
| `--min-arrow-len` | 2 | 最短蛇长（按格子算）。 |
| `--max-arrow-len` | 30 | 最长蛇长。 |
| `--max-attempts` | 50 | 被拒掉的 candidate 数超过 `count` × 这个值就停。 |
| `--dfs-ms` | 200 | 贪心解不开时回退到 DFS 的 wall-clock 上限（毫秒）。设 0 关闭 DFS。 |
| `--out` | （无） | 给了（带或不带 `=<dir>`）就把每关写成 `gen_w{W}h{H}_s{seed}_n{NNN}.json` 文件。不给 `--out` 时输出 JSONL 到 stdout（每行一个 JSON）。默认输出目录是 `packages/tools/generated/`，已经 `.gitignore`。 |

### 算法

1. **Path partition**（`generate.mjs` 里的 `partition()`）。在 W×H 网格上做随机游走 path-cover：
   - **边优先顺序**：边格优先于内部格被访问，让尽量多的 path 起点落在边上（这样 head 朝外一抬就出去）。
   - 每条 path 用 ~65% 直行偏好走，目标长度在 `[minLen, maxLen]` 间随机。
   - 一旦 `targetFill` 达到或没有空起点了就停。剩下的格子变成 void。
2. **Facing 分配**（`assignFacing()`）。每条 path 两端都是 head 候选：
   - 引擎固定 `facing = path[0] − path[1]`，所以唯一的选择是哪端当 `path[0]`。
   - **优先选立刻就出格的那端**（head 在边上朝外）—— 这是打破「随机 partition 容易产出的死锁循环」的关键 trick。两端都没法立刻出去时按「出格距离更短」做 tiebreak，加一点随机扰动。
3. **求解器验证过滤**（`evaluate()`）。
   - 跑 `_solver.mjs` 的贪心。解不开就回退到带时间上限的 DFS（`--dfs-ms`）。
   - 拒绝 **`moves.length ≤ arrows.length`** 的关卡 —— 这意味着每个箭头独立一拉就走，没有交互。我们至少要求一次 re-pull（曾经被挡住、等到某个箭头逃走才解锁）。

### 已知上限

| 网格 | 现有 PoC yield |
| --- | --- |
| 8×8 | ~5/5 在 ~60 次尝试内 |
| 10×10 | 5/5 在 ~75 次尝试内 |
| 14×14 | 5/5 在 ~100 次尝试内 |
| 20×20 | 5/5 在 ~190 次尝试内 |
| 30×30 | 0/5（边长太短，相对内部太小；大部分 path 没法搞到朝外的 head） |

**这个算法到 20×20 左右就到顶了。** 想做 corpus 中位（31×38）或更大的，用下面的 reverse-construction 生成器 —— 它的可解性由构造本身保证，而不是事后过滤。

### 复现同一关卡

```bash
pnpm --filter @ea/tools generate -- --w=10 --h=10 --seed=42 --count=1
```

PRNG 以 `seed + attempt * 1009` 播种，所以给定 (W, H, seed) 下**第一个被接受的关卡**是稳定的。如果你改了 `--max-arrow-len`、`--target-fill` 之类的，candidate 流会变，第一个被接受的关卡也可能不一样。

### 关于质量 / "好玩"

可解性查了，但「好玩」没查。生成的关卡可能感觉机械 —— 一根根长管子按显而易见的顺序冲掉。两个可以提高门槛的方向：

- **最小步数过滤**：要求贪心 `moves.length ≥ arrows.length × 1.5`（re-pull 越多 = 交互越多）。
- **Bottleneck score**：算贪心过程中至少被挡住一次的箭头数。太少就拒。

两个都是 `evaluate()` 加一行就能做的事。

### 为什么 gitignored？

`packages/tools/generated/` 被 `app/.gitignore` 排除，理由有二：

1. **可复现**：同 `--seed` 就能重新生成同样的关卡，存 JSON 等于增加噪音不增加信息。
2. **法律卫生**：生成关卡是 clean-room（不是 APK 衍生）。放在单独的 gitignored 目录让边界一眼可见 —— 没有把它们混进 `levels_data/` 的诱惑。

## 反向构造生成器（`generate-reverse.mjs`）—— 推荐

输出格式和 `generate.mjs` 一样，法律边界一样（绝不要进 `levels_data/`），但算法完全不同：不是随机 partition 再过滤，而是**按 escape 的逆序**放置箭头，让可解性由构造本身保证。

### 为什么可行

snake-walk 引擎只在 head 走到的新格子被**别的**未逃出箭头的 body 占据时才挡住（详见 `packages/core/src/game.ts` 里的 `tryPull`）。自己的 body 格、void 格、已逃出箭头的格子全部透明。

也就是说，一个关卡可解当且仅当存在某个 escape 顺序 `[A_1, A_2, …, A_n]`，使得对每个 `k`，当 `A_k` 被拉时，从 `A_k.path[0]` 到出界的 facing 射线只穿过**不**被 `A_{k+1..n}`（仍在场的箭头）占据的格子。`A_1..A_{k-1}` 已经逃了，它们的格子已经空。

我们就反向构造这个保证：先放 `A_n`（无约束 —— 网格还空着），再放 `A_{n-1}`（要避开 `A_n`），再 `A_{n-2}`（要避开 `A_n` ∪ `A_{n-1}`），……最后 `A_1`（要避开所有人）。放置的时候网格里正好是新箭头要避开的全部，所以「facing 射线是否空」就是一次格子查询。

### 算法

1. 从空网格开始。维护 `rayMap`：空格 → 经过它的「前面已放的箭头数」。如果在这里放一个 body 格，就会挡住这么多之前放过的箭头在最终初始态下的射线。
2. 对 `k = n, n-1, …, 1`（目标箭头数 `n` 受 `--max-arrows` 和 `--target-fill` 约束）：
   - 枚举 `(start, facing)` 锚点：`start` 是空格，`start + i*facing` 一路空到出界，`start − facing`（= `path[1]`）在格内且空。记录每个锚点的 `rayLen`（射线在格内的格子数）。
   - **按桶分组**让能更好降低 init-esc 的锚点先跑：
     - `bucket[0]`：`rayLen ≥ 1` 且 `path[1]` 已经在 `rayMap` 上 —— 放在这立刻挡住一个前面的箭头。
     - `bucket[1]`：`rayLen ≥ 1`，`path[1]` 不在 `rayMap` 上。
     - `bucket[2]`：`rayLen == 0` —— head 立刻出界，这个箭头永远 init-escapable（没有任何格子能放一个 blocker）。作为兜底留着保填充率。
   - 从第一个有锚点的桶里随便挑一个，再做随机游走把 `path[2..]` 扩展到 `[minLen, maxLen]` 范围内的目标长度。游走**优先挑已经在 `rayMap` 上的格子**（`--ray-bias`，默认 0.95），其次才是直行方向（`--straight-bias`，默认 0.65）；射线格一被占就挡住前面的箭头。
   - 标记 path 格为已占；把新箭头的射线写进 `rayMap`。
3. 把记录的列表反转，这样 `arrows[0]` 是最先 escape 的。这个顺序就是构造出来的解。
4. **延伸尾部**：轮询所有箭头，把每个箭头的尾部往相邻空格生长。如果新格子 `c` 落在任何**更早 escape** 的箭头的射线上就拒绝（会破坏那个更早箭头的 pull）。在合法候选里，优先选落在**仍 init-escapable 的更晚箭头**的射线上的格子（让延伸把它转成 blocked），其次任何更晚箭头的射线格，最后任意空格。每个箭头最多长到 30 格。这一步在不破坏构造期保证的前提下把剩余填充率补上去。
5. **验证**：对 `id = 0, 1, …, n-1` 模拟 `tryPull(arrowId)`。任何一次 pull 没逃出，说明算法有模型 bug —— 喧闹地拒绝。（理论上不会触发。）
6. **Sequencing 过滤**：数有多少个箭头在初始态下射线就是空的。如果太多（`> arrows × min-sequencing`，默认 0.5）这关太 trivial —— 拒。

### 用法

```bash
# 3 个 candidate 打到 stdout（JSONL）：
pnpm --filter @ea/tools generate:reverse -- --w=30 --h=30 --count=3 --seed=1

# 写到 packages/tools/generated/（gitignored）：
pnpm --filter @ea/tools generate:reverse -- --w=31 --h=38 --count=5 --seed=1 --out

# 更严的 sequencing —— 最多 20 % 箭头可以独立 escape：
pnpm --filter @ea/tools generate:reverse -- --w=20 --h=20 --count=5 --min-sequencing=0.2

# 调过的 "strict" 预设（chain-depth ≥ 8 + bottleneck ≥ 15 % + 120 次尝试 / 关）。
# 把一个批次往 corpus 分布拉 ~1 σ。比默认慢 ~5×，但 count=10 跑 corpus 中位网格
# 仍然不到一分钟。
pnpm --filter @ea/tools generate:reverse -- --w=25 --h=31 --count=10 --seed=1 --preset=strict --out
```

### Flags

| Flag | 默认 | 含义 |
| --- | --- | --- |
| `--w`, `--h` | 10 × 10 | 网格大小。能扩到 corpus 中位（31×38）和更大。 |
| `--seed` | 1 | PRNG 种子（`mulberry32`）。确定性。 |
| `--count` | 5 | 要产出的合格关卡数。 |
| `--target-fill` | 0.85 | 期望的覆盖比例。构造期一达到就停（之后 tail 延伸还能再涨）。 |
| `--min-arrow-len` | 3 | 最短箭头长度。 |
| `--max-arrow-len` | 12 | 构造期的目标上限。tail 延伸（第 4 步）仍可把箭头长到 30 格。构造期越短 = 箭头越多 = 阻塞越密。 |
| `--max-arrows` | 300 | 每关的箭头硬上限。 |
| `--max-attempts` | 20 | 被拒掉的 candidate 数超过 `count` × 这个值就停。 |
| `--min-sequencing` | 0.5 | 初始可逃箭头的比例超过这个就拒。越低 = 越紧的谜题（也越难找）。 |
| `--min-chain-depth` | 0 | 最长静态阻塞链短于 N 就拒。语料中位 ≈ 10；reverse-gen 自己的中位 ≈ 8。 |
| `--min-bottleneck` | 0 | 「挡 ≥ 2 个其他箭头」的箭头比例低于这个就拒。语料中位 ≈ 25 %；reverse-gen 自己的中位 ≈ 10 %。 |
| `--ray-bias` | 0.95 | 扩展 path 时，挑「已在某个前置箭头射线上的格子」对比任意合法相邻格的概率。高 = init-escapable 低。 |
| `--straight-bias` | 0.65 | path 延伸时继续走同一方向的概率（在 ray-bias 之后应用）。 |
| `--preset` | （无） | 在单 flag 之前应用一组命名套餐。`loose` = 当前默认；`strict` = `--min-chain-depth=8 --min-bottleneck=0.15 --max-attempts=120`。preset 之后的单 flag 会覆盖它的值。 |
| `--out` | （无） | 给了（带或不带 `=<dir>`）就写成 `gen_rev_w{W}h{H}_s{seed}_n{NNN}.json`。没 `--out` 时输出 JSONL 到 stdout。默认目录：`packages/tools/generated/`（gitignored）。 |

### Yield

| 网格 | 结果 | 备注 |
| --- | --- | --- |
| 8×8 | 5/5 在 ~10 次尝试内 | 这里 trivial-rejection 占主导 —— 小网格 sequencing pattern 本来就少。 |
| 10×10 | 3/3 在 ~7 次尝试内 | |
| 20×20 | 10/10 在 ~16 次尝试内 | |
| 30×30 | 5/5 在 5 次尝试内 | 首次接受。partition 算法在这个尺寸是 0/5。 |
| 31×38 | 5/5 在 5 次尝试内 | corpus 中位 —— 轻松达到。 |
| 50×50 | 3/3 在 3 次尝试内 | 30×30 之后没有回归。 |

验证器（上面第 5 步）在这些运行里**从没触发过**。要是触发了，说明构造或者引擎的碰撞规则跑偏了 —— 在发产物前先查清楚。

### 关于质量 / "好玩"

`--min-sequencing` 是一个粗的质量旋钮 —— 限制能从初始态独立 escape 的箭头比例。降低它强制更紧、更顺序的谜题（代价是更多拒绝）。其他能接的旋钮：

- **贪心 heuristic gap**：贪心 `moves` 与最优 `arrows` 数的比值。越高 = 玩的时候 re-pull 越多 = 交互越多。
- **Bottleneck arrow**：算「挡 ≥ 2 个其他箭头射线」的箭头数。这些是让一关令人难忘的「keystone」。
- **Path-length 分布**：语料中位 p50=7 / p90=24。默认 `[3, 30]` 对得上，但更收紧的分布可能感觉更精心设计。

都还没接 —— 现有生成器只在「构造正确性」+「sequencing 比例」上设门。

## Partition-first 生成器（`generate-partition.mjs`）—— v2

和 `generate-reverse.mjs` 同辈，但用一个根本不同的构造原语：不是按 escape 逆序放箭头（reverse-construction 的不变量），而是先把**网格做 path-partition** 切成蛇形 path（只是几何，还没 facing），再**用 Kahn 式拓扑构造同时给每条 path 分配 facing + escape order**。同时挑 facing 和 order 意味着永远不会在 blocker DAG 里产生环 —— 老的「先拓扑、再破环」方案里的 Phase 3 在这里根本不存在。v2 加上了 **targeted SCC-core 回溯**：Kahn deadlock 的时候，没被选中的那批 path 正好就是强连通分量本身，所以撤掉的恰是它们（再加一小撮邻接边界 path 做扰动），然后用前进过的 PRNG 重新生长。

### 为什么它能在结构指标上压过 reverse

Reverse-construction 必须保证每个新箭头的射线都避开所有之前放好的 body。这个 clearance 约束把 fill 在 25×31 上压在 ~85 %，并且把 body 摆放与射线摆放紧耦合 —— body 是散开的，不是聚成团的。Bottleneck % 和 chain-depth 都受牵连。

Partition-first 在几何钉死之后**才**承诺 facing，所以 path 之间可以随便穿过对方的射线。每个射线穿越就是一条拓扑依赖（被射线穿的那条 path 必须比射出去的那条更早 escape）。穿越密度 = 依赖密度 = 链深。

### 测量质量（2026-05-21）

**20×20，count=5，seed=1** vs n=1 corpus 和 reverse-gen：

| 指标 | partition v2 | reverse-gen v1 | corpus (n=1) |
| --- | --- | --- | --- |
| arrows (med) | 57 | ~25 | 29 |
| fill % (med) | 97 % | ~85 % | 99 % |
| init-escapable % (med) | **11 %** | ~30 % | 24 % |
| bottleneck % (med) | **21 %** | ~12 % | 17 % |
| 强制链深 (med) | **8** | ~7 | 6 |
| yield | 5/5 在 11 次尝试内 | 10/10 在 16 次尝试内 | — |

**25×31，count=5 × seed 2/3/4 (n=15)** vs n=7 corpus 关卡（2026-05-22 加入 canPick blocker-max 偏好 + Phase 1 isolated-path 拒绝后重测）：

| 指标 | partition v2 | reverse-gen v1 | corpus (n=7) |
| --- | --- | --- | --- |
| arrows (med) | 79 | ~64 | 67 |
| fill % (med) | **94 %** | 85 % | 97 % |
| init-escapable % (med) | 15 % | 30 % | 9 % |
| bottleneck % (med) | **20 %** | 11 % | 26 % |
| 强制链深 (med) | **9** | 7 | 10 |
| path len p50 (med) | **8** | — | 8 |
| path len p90 (med) | 16 | — | 27 |
| yield (target-fill=0.85) | 5/5 在 ~15 次尝试内 | — | — |

partition v2 把 v1 摸不到的 25×31 缺口堵上了：强制链深差 1 之内（9 vs 10），bottleneck 差 6pp 之内（20 % vs 26 %），arrow 数和 path-len p50 也都对齐。还剩两个 gap：init-escapable 比 corpus 高 6pp，path-len p90 短了不少（16 vs 27）。两者**同根**——partition 原语把单条 path 上限卡在 `--max-arrow-len`，head 离边沿近，常常朝外出界（射线空 = init-escapable）。Phase 1 现在会拒绝「两端 facing 都不挡任何 path 的 isolated path」（前 5 条 path 宽限期），Phase 2 的 `canPick` 也优先选 blocker 更多的 facing —— 合起来把 init-escapable 从 ~18 % 降到 ~15 %。再往下就得让 path 变长，但 `--max-arrow-len` 调到 18 以上强制链深会退（24 时跌到 8）。

### 已知限制：31×38 及更大

v2 回溯 + Kahn 分配本身很便宜（即便 31×38 也加起来 <100 ms）。真正的耗时大头是**构造后的 `deadlockRate` 过滤** —— 每个 candidate 都要跑 `--rollout-trials` 次随机 play rollout，死锁率超过 `--max-deadlock-rate` 就拒。每次 rollout 要给每个未逃出的箭头做 snapshot/tryPull/restore，开销随 `trials × arrows²` 增长。25×31 在老默认值（`--rollout-trials=100`, `--max-deadlock-rate=0.05`）下要 ~29 s/candidate，占了 ~99 % 墙钟。**2026-05-22 起默认值放宽为 `--rollout-trials=30` 和 `--max-deadlock-rate=0.30`** —— 25×31 几秒内 5/5，31×38 也能跑出来（总时长分钟级，不再是单 candidate 分钟级）。如果需要更严格的过滤，显式传 `--max-deadlock-rate=0.05 --rollout-trials=100` 即可，31×38+ 会很慢。

### v1（已弃用）

v1 用 Kahn 重试加随机 tiebreak，但没有几何回溯。它在 25×31+ 的稠密 partition 上死锁，因为随机自避路径很容易在 blocker DAG 里产生破不开的强连通分量。v2 通过检测 SCC core（= Kahn 之后没被选中的 path）并精确撤掉它们来解决。之前 v1 的「25×31 yield 1/3 at target-fill=0.7」限制在 target-fill=0.85 下完全闭合。

### 用法

```bash
# 烟雾测试（15×15 出 5 关）：
pnpm --filter @ea/tools generate:partition -- --w=15 --h=15 --count=5 --seed=1

# 写到 packages/tools/generated/（gitignored）：
pnpm --filter @ea/tools generate:partition -- --w=20 --h=20 --count=10 --seed=1 --out

# corpus 中位 25×31（v2 主场 —— 边界情况下把 backtracks 调高）：
pnpm --filter @ea/tools generate:partition -- --w=25 --h=31 --count=5 --seed=2 \
  --target-fill=0.85 --max-backtracks=50 --out

# 和同尺寸 corpus 对比（或和 reverse-generator 输出对比）：
mkdir -p /tmp/eval-partition
pnpm --filter @ea/tools generate:partition -- --w=20 --h=20 --count=30 --seed=1 \
  --out=/tmp/eval-partition
pnpm --filter @ea/tools quality:eval -- --from-dir=/tmp/eval-partition
```

### Flags

继承 `generate:reverse` 的 sequencing / chain / bottleneck / deadlock 门控。partition 专属：

| Flag | 默认 | 含义 |
| --- | --- | --- |
| `--target-fill` | 0.95 | partition path 覆盖的格子比例。Phase 1 达到就停；tail 延伸还能再涨。 |
| `--min-arrow-len` | 3 | Phase 1 生长的 path 最短长度。 |
| `--max-arrow-len` | 18 | Phase 1 生长的 path 最长长度。越短 = path 越多 = 阻塞越密。**2026-05-22 从 12 调到 18** —— 在 25×31 上把 arrows 从 98 拉到 78（corpus 67），`path-len p90` 从 12 拉到 17（corpus 27），bottleneck 从 19 % 升到 22 %（corpus 26 %），chainDepth 从 9 升到 10（对齐 corpus）。再调到 24 会把 p90 收得更窄但 chainDepth 退回 8，所以 18 是甜点。10×10 小网格不受影响（self-avoidance 卡在 maxLen 之前）。 |
| `--init-esc-rate` | 0.1 | 当 Kahn 同时有「blocked」（射线被挡）和「open」（无 blocker）候选时，挑 open 的概率。越低 = sequencing 越紧。 |
| `--kahn-retries` | 20 | 固定几何下 Kahn deadlock 后的重试次数。提高对边界情况有帮助；剩下的让 v2 回溯接管。 |
| `--max-backtracks` | 20 | 每个 candidate 的 v2 SCC-core 回溯次数。25×31+ 在高 `--target-fill` 下想保 yield 就调到 50–80。 |
| `--backtrack-chunk` | 3 | 每次回溯额外撤掉这么多最近**被选中**的 path，扰动 SCC 边界让重新生长不会重填到同样的洞里。 |
| `--max-deadlock-rate` | 0.30 | 随机 pull rollout 死锁率超过这个就拒（默认 `--rollout-trials=30`）。抓出「构造上可解但对贪心人类不友好」的谜题。**2026-05-22 放宽** —— 之前是 0.05/100，那时还没意识到这是 25×31+ 的墙钟瓶颈。要严格的贪心友好批次再调回去。 |
| `--straight-bias` | 0.65 | path 生长时继续走同一方向的概率。 |

## 质量评估（`quality-eval.mjs`）

生成器的产物「构造上可解」，但可解只是底线，不是上限。要知道生成批次**感觉**是不是像 APK 语料，就拿一组形状 / 结构 / 启发难度指标做分布对比 —— 同一网格大小下并排放。

脚本在 `W × H` 跑 `--count` 关 reverse 算法，再在 `levels_data/` 里扫**同尺寸**的语料关，两边各打印 mean / median / IQR。

### 用法

```bash
# 30 个生成 25×31 关 vs 所有 25×31 语料：
pnpm --filter @ea/tools quality:eval -- --w=25 --h=31 --count=30 --seed=1

# 跳过语料对比（更快，只是生成器侧烟雾）：
pnpm --filter @ea/tools quality:eval -- --w=20 --h=20 --count=20 --gen-only
```

### Flags

| Flag | 默认 | 含义 |
| --- | --- | --- |
| `--w`, `--h` | 25 × 31 | 网格大小。挑一个语料里有多个匹配的尺寸（用 `stat:corpus` 查常见尺寸）。 |
| `--count` | 30 | 生成多少个合成关。 |
| `--seed` | 1 | PRNG 种子（`mulberry32`）。 |
| `--max-attempts` | 20 | 每关的拒绝上限，镜像 `generate-reverse.mjs`。 |
| `--gen-only` | off | 跳过语料扫描 —— 只 dump 生成器侧统计。 |
| `--from-dir` | （无） | 从 `<dir>` 下的 `.json` 文件加载「生成」关卡，而不是跑内联的 reverse-generator。用这个评估任意外部生成器（比如 `generate-partition.mjs` 的输出）。带 `--from-dir` 时 `--w` / `--h` 由文件推断，`--seed` 忽略，`--count` 限制加载多少文件。 |

### 指标

| 指标 | 反映什么 |
| --- | --- |
| `arrows` | 每关箭头数。 |
| `fill %` | `(箭头长度总和) / (W × H)`。语料中位 ~96 %。 |
| `init-escapable %` | 初始态就能 escape 的箭头比例（facing 射线空）。**高 = 谜题松，低 = 紧。** |
| `bottleneck %` | body 挡住 ≥ 2 个其他箭头射线的箭头比例。**高 = keystone 多。** |
| `greedy moves/arrow` | 贪心 escape 步数与箭头数的比。`> 1.0` 表示至少有一次 re-pull。**目前生成器和语料都正好是 1.0**，所以贪心 heuristic 暂时分不出来 —— 列出来留给以后调。 |
| `path len p50` / `p90` | 关卡内蛇长的分位数。跨语料中位是 p50≈7、p90≈24。 |

### 示例输出

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

### 怎么读这些差距

- **arrows 和 path-length p50 —— 对齐。** 构造期 `--max-arrow-len=12`（之后 tail 延伸到 30）让数量和形状落在语料中位上。
- **fill 85 % vs 97 %** —— 仍比语料低 12pp。tail 延伸已经把每个能填的相邻格都贪心填上了，剩下的缺口是「不破坏可解性的前提下任何 body 都到不了的空洞」。要填这个缺口需要不同的构造原语（比如先 partition 网格，再让箭头走 partition）。
- **init-escapable 30 % vs 9 %** —— 仍远高于语料。其中 ~12pp 是结构性的（zero-ray 锚点：head 在边上朝外，没有任何格子能放 blocker —— 我们保留它们作为兜底来维持填充）。剩下的 ~18pp 是「能挡但没挡」：body 没有落在任何前置箭头射线上的锚点。`extendPath` 现在优先挑射线重叠格（`--ray-bias=0.95`），稍微推动了一下指针但几何上还是松。用 `--min-sequencing=0.2` 进一步收紧是可行的，代价是更多被拒尝试。
- **bottleneck 11 % vs 25 %** —— keystone 箭头更少。和 init-esc 同根：body 没在共享 chokepoint 上聚得够密。
- **greedy moves/arrow 两边都是 1.00** —— 当前 heuristic 分不出来。要让这个指标有区分力，生成器得强制 re-pull（比如拒掉验证器用 `arrows.length` 平步就解的关）。

把这些差距当作下一轮生成器迭代的优先 punch list。每改一项重跑一次看 delta 收窄。

### 语料大小警告

少数尺寸下语料侧可能只有一两个匹配，mean/IQR 失去意义。常见尺寸（比如 25×31、31×38）有几十个。先用 `pnpm --filter @ea/tools stat:corpus` 找出代表性好的尺寸再做评估。
