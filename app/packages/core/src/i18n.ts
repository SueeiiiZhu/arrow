// Minimal i18n: a single `t(key, params)` lookup, plus `setLang` to swap
// dictionaries at boot. UI code references string keys; the zh dict is the
// source of truth and any missing key in another language falls back to zh.
// To add a new language: create another const dict and merge it in the
// `dicts` map below.

export type Lang = "zh" | "en";

type Dict = Readonly<Record<string, string>>;

const zh: Dict = {
  // App-level
  "app.title": "箭路脱困",

  // HUD buttons
  "hud.btn.prev": "‹ 上一关",
  "hud.btn.next": "下一关 ›",
  "hud.btn.nextShort": "下一 ›",
  "hud.btn.reset": "重开",
  "hud.btn.hint": "提示",
  "hud.btn.undo": "撤销",
  "hud.btn.showPaths": "显示路径",
  "hud.btn.hintTitle": "提示下一步 (H)",
  "hud.btn.undoTitle": "撤销上一步 (Z)",
  "hud.btn.hintIdle": "💡 提示",
  "hud.btn.hintThinking": "💡 思考…",
  "hud.btn.hintNoSolve": "💡 无解",

  // Status line
  "hud.status.loading": "加载中…",
  "hud.status.won": "通关 ✓",
  "hud.status.remaining": "剩余 {remaining}/{total}",

  // Meta line
  "meta.size": "{w}×{h}  {n} 箭头",
  "meta.arrowCount": "{n} 箭",
  "meta.levelMissing": "[关卡缺失] {key}",
  "meta.invalid": "[校验失败] {err}",
  "meta.loadFail": "[加载失败] {err}",

  // Level picker
  "picker.btnLabel": "切换关卡",
  "picker.closeLabel": "关闭",
  "picker.placeholder": "搜索：名字 / 标签 / 尺寸 …",
  "picker.more": "还有 {n} 项，缩小搜索范围查看全部",

  // Info line
  "info.tap": "点箭头拉出，被挡住会停下并扣一颗心。",

  // No-lives modal
  "noLives.eyebrow": "ENERGY",
  "noLives.title": "心已用光",
  "noLives.sub": "等待心数自动恢复，或看一个广告免费补 1 颗。",
  "noLives.subShort": "等待心数自动恢复，或观看广告 +1 心",
  "noLives.ad": "看广告 +1 心",
  "noLives.later": "稍后再来",
  "noLives.recovered": "已恢复",

  // No-hints modal
  "noHints.eyebrow": "HINT",
  "noHints.title": "提示已用完",
  "noHints.subAd": "看一段广告补 {n} 次提示",
  "noHints.subCoins": "额外赠送 {n} 金币",
  "noHints.ad": "看广告 +{n} 提示",

  // Settings modal
  "settings.eyebrow": "SETTINGS",
  "settings.title": "设置",
  "settings.sfx": "音效",
  "settings.vibrate": "震动反馈",
  "settings.close": "关闭",

  // Loading overlay (wxgame splash → game transition)
  "loading.eyebrow": "LOADING",
  "loading.label": "加载关卡{dots}",

  // Splash (wxgame)
  "splash.subtitle": "休闲益智 · 箭头脱困谜题",
  "splash.advisoryTitle": "健 康 游 戏 忠 告",
  "splash.advisory1": "抵制不良游戏  拒绝盗版游戏",
  "splash.advisory2": "注意自我保护  谨防受骗上当",
  "splash.advisory3": "适度游戏益脑  沉迷游戏伤身",
  "splash.advisory4": "合理安排时间  享受健康生活",
  "splash.ageNotice": "适龄提示：本游戏适合 8 岁以上用户使用",
  "splash.start": "开始游戏",

  // Win overlay (shared between web/wxgame via @ea/renderer)
  "win.eyebrow": "V I C T O R Y",
  "win.title": "通关",
  "win.next": "下一关",
};

const en: Dict = {
  // English translations to fill in later; missing keys fall back to zh.
};

const dicts: Record<Lang, Dict> = { zh, en };

let currentLang: Lang = "zh";

export function setLang(l: Lang): void {
  currentLang = l;
}

export function getLang(): Lang {
  return currentLang;
}

export function t(key: string, params?: Record<string, string | number>): string {
  const primary = dicts[currentLang];
  let s: string = primary[key] ?? zh[key] ?? key;
  if (params) {
    for (const k of Object.keys(params)) {
      const v = params[k];
      s = s.split(`{${k}}`).join(String(v));
    }
  }
  return s;
}

/** Pick a Lang from a BCP-47 tag (e.g. "zh-CN" → "zh"). Falls back to "zh". */
export function detectLangFromTag(tag: string | undefined | null): Lang {
  if (!tag) return "zh";
  const lower = tag.toLowerCase();
  if (lower.startsWith("zh")) return "zh";
  if (lower.startsWith("en")) return "en";
  return "zh";
}
