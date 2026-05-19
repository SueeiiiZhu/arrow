# Escape Arrows — H5 + 微信小游戏

把 APK 反编译出来的关卡几何用 TypeScript + Canvas 重写，**不打包任何原始美术资源**（仅复用 `levels_data/` 里的关卡数据）。

## 关于关卡数据的法律边界

仓库内的代码 / 渲染 / 音效都是从零写的；视觉风格用 Canvas 路径还原（详见 `packages/renderer/src/board.ts` 里的 `drawArrowGlyph` / `drawTailCap`），不依赖任何原 APK 的 PNG / 字体 / mp3 / ogg。**不要把这些原始资产加入 git** —— 仓库根的 `.gitignore` 用 allowlist 策略 (`/*` + `!/app` + `!/.github`) 主动排除掉了 `_extracted/`、`AndroidManifest.xml`、`classes*.dex` 等所有 APK 反编译副产物，**请勿绕过**。

唯一**已在版本控制内**的"来自 APK 的内容"是 `levels_data/` 里 3548 个关卡 JSON —— 这是关卡几何坐标（不是美术资源），但仍然属于受著作权保护的「表达性内容」(protected expression)。当前仅作为个人 / 学习用途私有使用；**在任何形式的公开发布、上架商店、或商业化之前，必须重新评估** —— 可选路径包括：

- 自创一批新关卡替换 `levels_data/`（推荐）
- 或与原作者协商授权 / 联合发布
- 或仅作为开源代码工具开放，移除 `levels_data/` 让使用者自带

这条边界在 [`AGENTS.md`](./AGENTS.md) 红线 #1 / #2 里也有记录。

## 仓库布局


```
app/
├── levels_data/                # 关卡 JSON（已从原 APK 转换为 neutral 格式）
├── packages/
│   ├── core/                   # 引擎无关的规则：snake-walk 模型 + 关卡加载
│   ├── renderer/               # DOM-free Canvas 2D 渲染器
│   ├── web/                    # H5 入口（Vite）
│   └── wxgame/                 # 微信小游戏入口（esbuild 单文件打包）
└── package.json                # pnpm workspace 根
```

## 准备

```bash
# 在 app/ 目录下
pnpm install
```

需要 Node ≥ 18 + pnpm 10。

## 1. 本地 Web 测试（H5）

```bash
pnpm dev:web
```

Vite 默认监听 `http://localhost:5173`（端口被占就自动降到 5174、5175…，启动日志里会打印实际端口）。

打开浏览器：
- 顶部下拉选关卡，左右键 / `prev` `next` 按钮翻关
- `reset` 重置当前关
- 点击/触摸箭头：
  - 可移动 → body 沿弯道滑出去，head 沿 facing 直线探出
  - 被其他箭头挡住 → 沿 facing 方向轻微晃动作为反馈

线上构建：

```bash
pnpm build:web   # 产物在 packages/web/dist/
```

## 2. 微信小游戏

为了控制主包体积，目前只内嵌**前 50 关**（`packages/wxgame/scripts/build-levels.mjs` 控制范围；更多关卡需要走小游戏分包机制）。

### 构建

```bash
pnpm build:wxgame
```

产物：

```
packages/wxgame/dist/wxgame/
├── game.js     # esbuild CJS 单文件，约 ~700KB
└── game.json   # 小游戏配置清单
```

### 在微信开发者工具里跑

1. 打开 **微信开发者工具 → 小游戏 → 导入项目**
2. 目录选 `app/packages/wxgame/dist/wxgame/`
3. AppID 选「测试号」即可（除非你要真机预览）
4. 项目打开后会自动加载 `game.js`，调试器里可看 console、性能、绘制

操作和 H5 完全一致：点屏幕中段的箭头 = 拉；HUD 三个分区是 prev/reset/next。

> 真机预览 / 上传需要把 AppID 换成你自己的，并按微信规则配置网络域名。这个项目没有任何网络请求，配置可以全空。

## 常用命令汇总

| 命令 | 作用 |
| --- | --- |
| `pnpm dev:web` | 起 Vite，浏览器调试 H5 |
| `pnpm build:web` | 生产构建 H5（`packages/web/dist/`） |
| `pnpm build:wxgame` | 生成 50 关 + 打小游戏单文件（`packages/wxgame/dist/wxgame/`） |
| `pnpm build:core` | 单独构建 core 到 `dist/`（运行非 ts 脚本时需要） |
| `pnpm build:renderer` | 单独构建 renderer 到 `dist/` |
| `pnpm typecheck` | 全包 tsc --noEmit |

## 关于规则模型

当前游戏模型是 **snake-walk**：箭头 body 沿自身弯曲 `path` 滑动，head 越过 `path[0]` 后沿 `facing` 直线探出。一次「拉」是贪心的：head 一直前进，直到撞上其他箭头当前占据的格子，或整条蛇尾也离开棋盘（escape）。详见 `packages/core/src/game.ts` 顶部注释；其它被排除的模型（rigid translation / rope extension）也记录在那里。
