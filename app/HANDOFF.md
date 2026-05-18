# Escape Arrows — 移交 / TODO

> 上次推进到 2026-05-18。下次继续，先把 dev server 起来（`pnpm dev:web`，浏览器到 `http://localhost:5173`，被占就降到 5174）再按本文档推进。

---

## 当前进度概览

### 已完成

- `core/`：snake-walk 规则（body 沿 bent path 滑、head 沿 facing 直探出）。`tryPull` 贪心；新 export `trajectoryAt(data, t)` / `bodyCellsAt(data, k)` 支持小数 progress，给动画用。模型来龙去脉记在 `packages/core/src/game.ts` 顶部注释。
- `renderer/`：`drawGame` 用 `bodyCellsAt`，body 是粗圆角折线，head 是圆角三角形（仿 `ArrowHead.png` 形状），tail 是圆形 cap（仿 `ArrowEnd.png`）。绝对没有打包原图。`DrawOptions` 新增 `progressOverride` / `shakeOffsets` / `drawEscapedIds`。
- `web/main.ts` & `wxgame/main.ts`：rAF 缓动（easeOutCubic，120-450ms 时长按拉动距离自适应），被挡时沿 facing 抖动 220ms。动画进行中输入门禁。
- `wxgame/`：esbuild 把 entry + 50 关数据打成 `dist/wxgame/game.js`（~700KB CJS）+ `game.json`。
- `README.md`：本地启动 + 微信小游戏导入步骤。
- Sanity solver（在 `/tmp/ea_solve_snake.mjs`，**未入仓**）：50 关里 49 关 greedy round-robin 走通，0 关初始无法移动，1 关（OG_LevelBig7, 62 箭头）DFS 600ms 超时。

### 入口点速查

| 关心 | 看哪里 |
| --- | --- |
| 规则 / 移动 / 碰撞 | `packages/core/src/game.ts` |
| 视觉（箭头、body、tail、动画 hook） | `packages/renderer/src/board.ts` |
| H5 入口 / 输入 / 动画 loop | `packages/web/src/main.ts` |
| 微信小游戏入口 + HUD | `packages/wxgame/src/main.ts` |
| 关卡数据 | `levels_data/*.json`（neutral 格式） |
| 关卡导入 / 校验 | `packages/core/src/level.ts` |
| 小游戏关卡内嵌脚本 | `packages/wxgame/scripts/build-levels.mjs`（目前内嵌前 50 关） |
| 小游戏打包脚本 | `packages/wxgame/scripts/bundle.mjs` |

---

## 未完成 — 按优先级

### P0：先做 / 阻塞验收

1. **浏览器实测 snake-walk 模型**
   - `pnpm dev:web` → 玩 5-10 关，重点确认：
     - 之前点不动的箭头，现在是「能拉动」还是「沿 facing 轻微抖动」（两种之一都对，不应该是「无任何反应」）
     - 消失轨迹是否沿 path 弯道走（带 90° 急转的关最有代表性）
     - 箭头视觉是否还需要调整（目前 head=圆角三角，tail=圆形，body=粗圆角线）
   - 任何不对劲都在 issue / 笔记里记下来对应的关卡 key，方便复现

2. **OG_LevelBig7 (62 箭头) 求解器超时**
   - 当前 `/tmp/ea_solve_snake.mjs` 的 bounded DFS 在这关 600ms cap 内没找到解
   - 需要一个更靠谱的求解器：BFS + 状态去重，或贪心 + 局部回溯
   - 跑通后说明 snake-walk 模型是自洽的；跑不通要再回头看模型边界

3. **head extension 是否需要限制在 levelMask 内？**
   - 现在 `game.ts` 只检查 head 下一格不能撞别人 body，没要求它必须在某条 path 里。如果原版要求 head 只能沿 mask 走、从 mask 边缘破口逃出，那现在的模型太宽松。
   - 验证方法：找一关 `path[0]` 旁边一格既不在任何 path 里也不在棋盘外（即「真空格」），如果原版不让 head 走进去，就要把约束加上。
   - 暂时没有装真机原版，可考虑跑 IL2CPP 反编译再次找 `IsBlocked` 类方法的名字 + 引用，定位规则。

### P1：用户体验闭环

4. **微信小游戏关卡分包**
   - 现状：50/3548 关，主包压缩后 ~700KB 已经接近最佳
   - 目标：按段切分，每个 subpackage 装 100-300 关
   - 改动点：
     - `packages/wxgame/scripts/build-levels.mjs` 输出多个 `levels_<n>.generated.ts`
     - `game.json` 加 subpackages 配置
     - `main.ts` 加一层 `wx.loadSubpackage` 异步加载，HUD 处理「加载中」状态
   - 微信限制：主包 4MB，单分包 4MB，整包 20MB

5. **关卡进度本地持久化**
   - H5：`localStorage`
   - WX：`wx.setStorageSync`
   - 至少存「当前关 index」+「已通关 key 集合」

6. **关卡选择器 UX**
   - 现在 H5 是一个 3548 项的 `<select>`，难用
   - 选项：按关卡名 `[WxH]_[N arrows]_[Tags]` 加筛选条；或做一个 grid 缩略图选关页（用 `drawLevel` 渲染小预览）

### P2：抛光

7. **通关动画 / Win UI**
   - 当前只在右上角文字「通关！」，需要全屏覆盖 + 「下一关」按钮 + 自动延时跳转
   - 全部 Canvas 程序化绘制（粒子 / 星星都自己画），不抄原图

8. **音效**
   - Web Audio 自合成短音：tap-click、pull-whoosh、blocked-thud、escape-pop、win-fanfare
   - WX 端 `wx.createInnerAudioContext` 或同样自合成
   - **绝不抄原版音频**

### P3：工程化

9. **core 单元测试**
   - 现在零测试。最该补 `tryPull`：2x2 / 3x3 fixture，断言 `progress` / `escaped` / `blocked`
   - 用 `vitest` 或 `node:test`

10. **求解 / 验证脚本收纳**
    - 现在散在 `/tmp/`，下次会丢
    - 建 `packages/tools/`（不发布，标 `"private": true`），收纳 solver / level-stats / model-validator

11. **lint / CI**
    - 目前无 ESLint / Prettier / GitHub Actions
    - 至少 CI 跑 `pnpm typecheck` + 一个最小 sanity solver

---

## 已经做出的关键决定（别推翻）

1. **不打包原版美术资源**（PNG/字体/音频）。视觉全部 Canvas 程序化。这一条是法务红线。
2. **关卡几何数据**（`levels_data/`）复用自 APK 转换。这是受保护表达，公开发布或商业化前要重新评估（自制或获得授权）。
3. **snake-walk 而非 rigid translation**：两个模型都验证过，rigid 在一些关里让本该能动的箭头动不了，且视觉错。snake-walk 还原了「沿 path 滑动」的直觉。
4. **没有 Cocos/Phaser/Pixi**：原生 TS + Canvas 2D。`packages/renderer/src/canvas-ctx.ts` 的 `DrawCtx` 接口让 H5 的 HTMLCanvasContext 和 WX 的 `wx.createCanvas()` 都能用同一份渲染代码。
5. **WX 主包先只装 50 关**：分包方案没做完之前，主包内嵌全部 3548 关会爆 4MB 限制。

---

## 启动命令速查

```bash
# 在 app/ 下
pnpm install                  # 第一次

pnpm dev:web                  # H5 调试，http://localhost:5173
pnpm build:web                # H5 生产构建 → packages/web/dist/
pnpm build:wxgame             # 小游戏单文件 → packages/wxgame/dist/wxgame/
pnpm typecheck                # 全包 tsc --noEmit
```

微信开发者工具：小游戏 → 导入项目 → 选 `app/packages/wxgame/dist/wxgame/` 目录。
