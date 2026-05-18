# CLAUDE.md — Escape Arrows 项目指引

> 此文件是 Claude Code 在本仓库工作时的常驻指引。覆盖全局默认行为；与 `~/.claude/CLAUDE.md` 的全局规则**叠加**生效。

---

## 项目背景

- **目标**：把 Android APK《Escape Arrows》(`com.ecffri.arrows`, Unity 6000.0.58f2 + IL2CPP) 的玩法用 TypeScript + Canvas 2D 重写，同时输出 **H5 (Vite)** 和**微信小游戏 (esbuild)** 两个目标。
- **绝不打包原版美术 / 字体 / 音频资源**。视觉全部 Canvas 程序化绘制。这是法务红线，没有例外。
- **关卡几何数据**（`levels_data/*.json`）确实是从 APK 解出来转换的 neutral 格式。这是「关卡设计」属于受保护表达，公开发布或商业化前必须重新评估。

## 目录结构

```
app/
├── levels_data/                 # 关卡 JSON（3548 关）
├── packages/
│   ├── core/                    # 引擎无关的规则 + 关卡加载
│   ├── renderer/                # DOM-free Canvas 2D 渲染
│   ├── web/                     # H5 入口（Vite）
│   └── wxgame/                  # 微信小游戏入口（esbuild bundle）
├── README.md                    # 启动方法（H5 + 微信小游戏）
├── HANDOFF.md                   # 当前未完成事项 / 优先级 / 已做的关键决定
└── CLAUDE.md / AGENTS.md        # agent 指引
```

## 不能动摇的决定

下列决定都是反复验证过的，**未经用户明确同意不要推翻**：

1. **snake-walk 是确定的游戏模型**
   - body 沿自身 bent path 滑动，head 越过 path[0] 后沿 facing 直线探出
   - 验证过的两个备选已排除：
     - **rigid translation** —— 让本该能动的箭头点不动，且消失轨迹是错的
     - **rope extension** —— 让所有谜题都平凡可解
   - 详细论证在 `packages/core/src/game.ts` 顶部注释里

2. **渲染层 DOM-free**
   - `packages/renderer/src/canvas-ctx.ts` 的 `DrawCtx` 抽象让 H5 (`HTMLCanvasRenderingContext2D`) 和 WX (`wx.createCanvas().getContext("2d")`) 共用同一份渲染代码
   - **不要**在 `renderer/` 里直接 `import` 任何 DOM 类型 / API

3. **不引入游戏引擎**
   - 不允许 Cocos / Phaser / Pixi / Three.js / Babylon
   - 纯原生 TS + Canvas 2D

4. **坐标系**
   - top-left 原点，+x 向右，+y 向下
   - 行优先：cell index = y * width + x
   - `facing == -(path[1] - path[0])`，指向 head 外推方向

5. **动画反馈**
   - 拉动成功：`startTween` 沿 path 缓动（easeOutCubic，120-450ms 自适应距离）
   - 被挡：`startShake` 沿 facing 方向 220ms 衰减抖动
   - 动画进行中**关闭输入**（避免重复触发）

## 工作流

```bash
# 在 app/ 下
pnpm install                  # 第一次
pnpm dev:web                  # H5 调试，http://localhost:5173（被占降到 5174）
pnpm build:web                # H5 生产构建 → packages/web/dist/
pnpm build:wxgame             # 小游戏单文件 → packages/wxgame/dist/wxgame/
pnpm typecheck                # 全包 tsc --noEmit
```

- 多文件改完先跑 `pnpm typecheck` 自检
- 涉及视觉 / 交互的改动，主动开 dev server 自己验一遍（描述操作步骤给用户）
- 改了 `core/`，记得 `pnpm build:core` 才能让 `/tmp/` 下的临时脚本看到新代码

## 不要做的事

- ❌ 不要把任何原版 PNG / TTF / mp3 / ogg 导入到 `packages/` 里
- ❌ 不要 import 原版 `_extracted/main/data/Sprite/*.png`
- ❌ 不要静悄悄换回 rigid translation 或其他被排除的模型
- ❌ 不要在 `renderer/` 里碰 DOM API（`document` / `window`）
- ❌ 不要在主仓库根目录留 `/tmp/` 风格的脚本 —— 收纳到 `packages/tools/`（如果不存在就在 HANDOFF 里登记，让用户决定要不要建）
- ❌ 不要主动创建额外的文档文件（除非用户明确要求）

## 用户偏好

- **默认中文输出**，技术术语 / 标识符保留原文
- 喜欢端到端推进，不要中途反复确认
- 视觉问题用户会自己回浏览器验证，agent 把改动做完描述清楚即可
- commit message 用简洁中文，不需要 emoji

## 常见盲区

- 微信小游戏主包 4MB / 单分包 4MB / 整包 20MB 限制。当前只内嵌前 50 关，全量分包还没做（见 HANDOFF.md P1）
- `/tmp/ea_solve_snake.mjs` 是临时 sanity solver，**不在仓库里**；要重用就先收纳到 `packages/tools/`
- wxgame 用的全局 `requestAnimationFrame` / `performance` 类型在 `packages/wxgame/src/wx-types.d.ts` 里手动声明的（wx 没给 d.ts）
- vite 配置一定要保持 JSON 走默认 ESM 解析，**不要**加 `assetsInclude: ["**/*.json"]`（之前因为这个 H5 完全跑不起来，blank 黑屏）
