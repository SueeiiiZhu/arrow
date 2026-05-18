# AGENTS.md — Escape Arrows

> 给在本仓库工作的 AI agent（Codex、Cursor、Aider、Claude Code 等）的通用指引。Claude Code 还会额外读 `CLAUDE.md`；其它 agent 只需要这一份。

---

## 一句话概括

把反编译自《Escape Arrows》APK 的关卡数据，用 **TypeScript + Canvas 2D** 重写规则和渲染，产出 **H5 网页**和**微信小游戏**两个目标。**不打包任何原版美术 / 音频资源**。

## 仓库结构

```
app/
├── levels_data/                 # 关卡 JSON（neutral 格式，3548 关）
├── packages/
│   ├── core/                    # 规则 + 关卡加载，引擎无关
│   ├── renderer/                # DOM-free Canvas 2D 渲染
│   ├── web/                     # H5 入口（Vite）
│   └── wxgame/                  # 微信小游戏入口（esbuild）
├── README.md                    # 启动指南
├── HANDOFF.md                   # 未完成事项 + 优先级
└── CLAUDE.md / AGENTS.md        # agent 指引
```

每个包内部约定见自身 `package.json` 和源码顶部注释。

## 红线（不要越过）

1. **不允许打包原版资源**：APK 解出来的 PNG / TTF / 音频禁止 import 到 `packages/`。视觉一律 Canvas 程序化绘制。
2. **关卡几何数据**复用自 APK（位于 `levels_data/`）。属于受保护表达，公开发布 / 商业化前需要单独评估。
3. **渲染层不依赖 DOM**：`packages/renderer/` 不能引用 `document` / `window` / 其它浏览器特有 API。共用接口在 `packages/renderer/src/canvas-ctx.ts`。
4. **不引入游戏引擎**：禁止 Cocos / Phaser / Pixi / Three.js / Babylon。原生 TS + Canvas。

## 已确定的设计决定

不要在没有用户明示同意的情况下推翻：

- **游戏模型 = snake-walk**：body 沿自身 path 滑动，head 沿 facing 探出。`packages/core/src/game.ts` 顶部注释有完整论证；rigid translation、rope extension 都试过并排除。
- **坐标系**：top-left 原点，+y 向下，行优先。`facing == -(path[1] - path[0])`。
- **动画**：rAF + easeOutCubic，拉动 120-450ms 自适应，阻挡 220ms 沿 facing 抖动衰减。动画中暂停输入。
- **微信小游戏当前只内嵌前 50 关**（主包 4MB 限制）；分包还没做（HANDOFF.md P1）。

## 启动命令

```bash
# 在 app/ 下
pnpm install                  # 第一次
pnpm dev:web                  # H5 调试，http://localhost:5173
pnpm build:web                # H5 生产构建 → packages/web/dist/
pnpm build:wxgame             # 小游戏 bundle → packages/wxgame/dist/wxgame/
pnpm typecheck                # 全包 tsc --noEmit
```

微信开发者工具：小游戏 → 导入项目 → 选 `packages/wxgame/dist/wxgame/` 目录。

## 工作建议

- 多文件改动后跑 `pnpm typecheck` 自检
- 改 core 后要 `pnpm build:core` 让外部 `node` 脚本看到新版
- 改交互 / 视觉时主动起 dev server 自测，把验证步骤告诉用户
- 临时脚本不要留在 `/tmp/`，要复用就收纳到（尚未建立的）`packages/tools/`，并在 HANDOFF.md 记一笔
- commit message 用简洁中文

## 禁忌速查

| ❌ 不要 | ✅ 替代 |
| --- | --- |
| `import "..../ArrowHead.png"` | 自己用 Canvas path 画 |
| `import "phaser"` | Canvas 2D 原生 API |
| `renderer/` 里写 `document.getElementById` | 用 `DrawCtx` 接口 |
| 偷偷把规则切回 rigid translation | 保持 snake-walk |
| vite.config 加 `assetsInclude: ["**/*.json"]` | 保持默认 JSON ESM 解析（之前的踩坑） |
| 创建一堆 `*-NOTES.md` 散乱文档 | 改 README.md / HANDOFF.md |

## 用户偏好

- 默认中文输出，技术术语 / 代码标识符保留原文
- 喜欢端到端推进，少打断式确认
- 视觉问题用户会自己回浏览器看，agent 把代码改完描述清楚就行

## 下一步看哪里

打开 `HANDOFF.md`，从 P0 开始。
