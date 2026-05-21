# @ea/lives

心数（hearts / lives）状态模块。镜像原 APK `LivesComponent` / `MaxLives` 的盈利层语义：玩家失败需要消耗 1 颗心，归零后只能等待自动回血或看广告 +1。

模块本身是**纯函数 + 时间锚点**，不依赖任何 host API（无 `localStorage`、无 `wx.*`）。持久化、当前时钟、广告播放都由 host 注入，所以 web 与 wxgame 两端共用同一份实现。

## API 速查

```ts
import {
  createFresh,        // (config, now) → 全血新状态
  tick,               // (state, config, now) → 把待回血应用到状态
  consume,            // (state, config, now) → { ok, state }；不够血时 ok=false
  refill,             // (state, config, now, amount=1) → 加血并 cap 到 max
  msToNextRegen,      // (state, config, now) → 距离下次 +1 的毫秒数，满血时 null
  fromJSON,           // (raw, config, now) → 从持久化 JSON 恢复（含 clamp / 默认值）
  defaultConfig,      // { max: 5, regenIntervalMs: 30*60_000 }
} from "@ea/lives";
```

不变量：

- `lives ∈ [0, max]`，整数；`fromJSON` 越界会被 clamp。
- `regenAnchor` 是绝对 epoch ms。系统时间回拨时 `tick()` 把 anchor 拉回 `now`，避免一次性回满。
- 满血时 anchor 持续 pin 到 `now`，所以从满血消耗第一颗才开始倒计时（和原 APK 一致）。
- 同样的 `(state, config, now)` 调任意次 `tick` 都得到等同结果（幂等）。

## 调参

默认 5 颗心 + 每 30 分钟回 1 颗。要换数值，**改 `defaultConfig`**（`src/lives.ts`）即可，host 不需要动：

```ts
export const defaultConfig: LivesConfig = {
  max: 5,
  regenIntervalMs: 30 * 60_000,
};
```

或者让 host 自己传一份 `LivesConfig`（接入层目前固定使用 `defaultConfig`，要按关卡难度做差异化时再考虑）。

## host 接入（已在仓库内完成）

| host | 持久化 key（`Storage`） | 持久化方式 |
| --- | --- | --- |
| `@ea/web` | `escape_arrows_lives` | `localStorage` |
| `@ea/wxgame` | `escape_arrows_lives` | `wx.setStorageSync` / `wx.getStorageSync` |

两端各自维护一个轻量 store（`packages/{web,wxgame}/src/lives-store.ts`），把上面纯函数 API 接上 host 的存储 + 时钟，对外暴露同名 helper：`getState / getConfig / tickNow / tryConsume / addLives / nextRegenMs`（web 多一个 `subscribe`）。

接入点（如果以后改触发条件，看这两处）：

- **重开按钮消耗 1 颗心**：`packages/web/src/main.ts` 里 `resetBtn` 的 click handler；`packages/wxgame/src/main.ts` 里 `hud === "reset"` 分支。
- **归零弹无心数对话框**：web 走 DOM `#no-lives-dialog`（`packages/web/index.html`）；wxgame 走 Canvas 绘制 + hitbox（`drawNoLivesOverlay` + `noLivesHitbox`）。

> 当前策略：**只有「重开」消耗心数**。进入关卡、切关卡、通关都不扣。这与原 APK 的 `LevelFailViewBase` 行为最贴近。

## 配置激励视频广告（wxgame）

web 端没有广告分发位，"看广告 +1 心" 按钮目前**直接补 1 颗**，方便走通流程。wxgame 端通过 `wx.createRewardedVideoAd` 接入真实的激励视频，下面是上线步骤。

### 1. 在 mp.weixin.qq.com 注册广告位

1. 登录小游戏后台 → **变现** → **流量主** → **激励视频广告位**。
2. 新建一个广告位，类型选「激励视频」。提交后会给你一个 `adunit-xxxxxxxxxxxxxxxx` 形式的 `adUnitId`。
3. 等审核通过（一般 1–3 天）。审核期间填进代码也能在「微信开发者工具」里联调，但真机展示需要审核完成。

### 2. 填进代码

打开 `packages/wxgame/src/main.ts`，找到：

```ts
// Replace with your own ad unit ID before submitting to mp.weixin.qq.com.
// `wx.createRewardedVideoAd` is absent in devtool / older clients — we then
// fall back to refilling 1 immediately so the flow is still exercisable.
const REWARDED_AD_UNIT_ID = "";
```

把空串换成后台拿到的 `adunit-xxxxxxxxxxxxxxxx`。

### 3. 行为说明

`tryAdRefill()` 的 fallback 链路：

| 条件 | 行为 |
| --- | --- |
| `REWARDED_AD_UNIT_ID === ""` 或 `wx.createRewardedVideoAd` 不存在 | 直接 `addLives(1)`，关弹窗。便于开发期联调。 |
| 创建成功，用户**看完**（`onClose` 回调 `e.isEnded === true`） | `addLives(1)`，关弹窗。 |
| 创建成功，用户**中途关闭**（`isEnded === false`） | 不补血，关弹窗。 |
| `ad.show()` 失败 | 尝试 `ad.load()` 再 `show()` 一次；再失败就放弃，弹窗保持打开。 |

`ad.destroy()` 在 `onClose` / 失败分支都会调到，避免广告实例泄漏。

### 4. 灰度 / 关闭

要临时关闭广告分发（例如审核期、灰度回滚），把 `REWARDED_AD_UNIT_ID` 改回空串重发版本即可，无需改 UI。

## 调试 / 重置

开发时心数耗光会卡住"重开"按钮，要手动重置：

### web

浏览器 DevTools → Application → Local Storage → 删 `escape_arrows_lives` key，或 Console：

```js
localStorage.removeItem("escape_arrows_lives"); location.reload();
```

### wxgame（微信开发者工具）

工具栏 → **清缓存** → 勾选「清除数据缓存」→ 确定。或在 Console：

```js
wx.removeStorageSync("escape_arrows_lives");
```

### 把心数调成短间隔做手测

临时把 `defaultConfig.regenIntervalMs` 改成 `5_000`（5 秒），重发就能在几十秒内观察到回血 / 倒计时 / 满血 anchor 重置等行为；测完记得改回 `30 * 60_000`。

## 测试

```bash
pnpm --filter @ea/lives test
```

19 条 `node:test` 覆盖：满血 anchor pin、跨多 interval 回血、上限 cap、时钟回拨、消耗（满 → 非满首次开计时 / 非满 / 归零）、`refill` cap、`msToNextRegen`（满血 null / 区间内倒数 / 跨 interval 余数）、`fromJSON`（合法 / 越界 clamp / 缺字段默认 / 非对象兜底）。
