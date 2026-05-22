# Escape Arrows

> H5 + 微信小游戏 / H5 + WeChat Mini Game
>
> 详细文档 / Full docs: **[`app/README.md`](app/README.md)** · **[`app/README.zh-CN.md`](app/README.zh-CN.md)**

把一款 APK 反编译出的箭头解谜游戏关卡几何，用 **TypeScript + Canvas 2D** 从零重写，同时输出 Web (H5) 与微信小游戏两个端。

A from-scratch **TypeScript + Canvas 2D** reimplementation of an APK-decompiled arrow puzzle game — engine, renderer, input, and tooling rebuilt fresh; ships as both an H5 web build and a WeChat Mini Game.

---

## 关键事实 / Quick facts

- **No game engine, no DOM.** 纯 Canvas 2D + 自写渲染器；同一份代码同时跑 H5 `HTMLCanvasRenderingContext2D` 和微信 `wx.createCanvas()`。
- **No original APK assets.** PNG / 字体 / 音频一概不入库；视觉风格用 Canvas 路径手绘还原（`packages/renderer/src/board.ts`）。仓库根 `.gitignore` 用 allowlist 主动屏蔽 `_extracted/`、`classes*.dex`、`AndroidManifest.xml` 等反编译副产物。
- **Snake-walk physics.** 箭头沿自身弯曲 path 像贪吃蛇一样滑出，箭头沿 `facing` 直线延伸；rigid translation 和 rope extension 两种方案试过被否决，理由见 `packages/core/src/game.ts` 顶部注释。
- **3548 关分包加载。** 主包嵌入前 30 关，余下 3518 关切成 12 个 ~1.3 MB 子包按需加载；总体积约 15 MB，远低于微信小游戏 20 MB 上限。
- **解算器 + 关卡生成器**（`packages/tools/`）：partition v2 通过「path 分区 + Kahn 拓扑装配 + SCC-core 回溯」自动生成可解关卡，结构指标已与原游戏 corpus 对齐。

## 仓库布局 / Repo layout

```
/                          仓库根 —— 仅放门面 README、CI、白名单后的 app/
├── app/                   主代码 + 文档（pnpm workspace 根）
│   ├── packages/core/         规则引擎（与渲染无关）
│   ├── packages/renderer/     Canvas 2D 渲染器
│   ├── packages/lives/        体力 / 心数模型
│   ├── packages/web/          Vite H5 入口
│   ├── packages/wxgame/       微信小游戏入口 + 12 子包构建
│   ├── packages/tools/        solver / corpus 分析 / 关卡生成器
│   └── levels_data/           3548 个关卡 JSON（仅几何坐标）
├── .github/               CI（lint / typecheck / test）
└── .gitignore             allowlist：默认忽略一切，仅显式放行 app/ 与少数顶层文件
```

实际开发命令、构建方式、规则模型详解、未完成的工作 —— 全部在 [`app/README.md`](app/README.md) / [`app/README.zh-CN.md`](app/README.zh-CN.md) 与 [`app/AGENTS.md`](app/AGENTS.md) / [`app/HANDOFF.md`](app/HANDOFF.md) 中。

## 法律边界 / Legal boundary

仓库中**唯一来自原 APK 的内容**是 `app/levels_data/` 里的 3548 个关卡 JSON（关卡几何坐标，非美术资源）。这些数据仍属于受著作权保护的「表达性内容」(protected expression)，目前仅作为**个人 / 学习用途**私有使用。在任何形式的公开发布、上架商店或商业化之前，**必须**重新评估其中一条路径：

- 自创一批新关卡替换 `levels_data/`（推荐）；
- 或与原作者协商授权 / 联合发布；
- 或仅开源引擎代码、移除 `levels_data/`，让使用者自带。

The only piece of **APK-derived content** that lives in this repo is the 3548 level JSON files under `app/levels_data/` — these are level geometry coordinates (not art assets), but still **protected expression**. They are used **for personal / learning purposes only**. Before any public release, app-store listing, or commercialization, this must be reassessed: author fresh levels, license from the original author, or ship engine-only and let consumers bring their own levels.

详见 [`app/AGENTS.md`](app/AGENTS.md) 红线 #1 / #2。

## 快速跑起来 / Quickstart

```bash
cd app
pnpm install
pnpm dev:web        # Vite, 默认 http://localhost:5173
pnpm build:wxgame   # 输出 packages/wxgame/dist/wxgame/，可直接导入微信开发者工具
```

要求 Node ≥ 18、pnpm 10。
