// Polyfill for performance.now() in WeChat mini-game environment
if (typeof performance === "undefined") {
  (globalThis as any).performance = {
    now(): number {
      return Date.now();
    },
  };
}

// Global error handler for debugging
if (typeof wx !== "undefined" && wx.onError) {
  wx.onError((error: string) => {
    console.error("[wxgame] Global error:", error);
  });
}

import {
  type CompactLevel,
  createGame,
  decodeCompact,
  ensureShuffleSeed,
  findArrowAt,
  findNextMove,
  type GameSnapshot,
  type GameState,
  loadLevel,
  loadProgress,
  type Progress,
  type ProgressStorage,
  resetGame,
  restoreGame,
  saveProgress,
  shuffleByDifficulty,
  snapshotGame,
  tryPull,
} from "@ea/core";
import {
  type AudioContextLike,
  drawGame,
  drawWinOverlay,
  fitView,
  hitTestOverlay,
  makeSynth,
  type OverlayHitbox,
  pickCell,
  type Synth,
} from "@ea/renderer";
import {
  ALL_KEYS,
  KEY_TO_LOC,
  MAIN_LEVELS,
  type MainLevel,
  PACK_COUNT,
} from "./levels.generated.js";
import {
  addLives,
  getConfig as getLivesConfig,
  getState as getLivesState,
  nextRegenMs,
  tickNow as tickLives,
  tryConsume as tryConsumeLife,
} from "./lives-store.js";

const STORAGE_KEY = "escape_arrows_progress";

const storage: ProgressStorage = {
  read: () => {
    try {
      const v = wx.getStorageSync(STORAGE_KEY);
      return typeof v === "string" && v.length > 0 ? v : null;
    } catch {
      return null;
    }
  },
  write: (v) => {
    try {
      wx.setStorageSync(STORAGE_KEY, v);
    } catch {
      /* swallow */
    }
  },
};

const progress: Progress = loadProgress(storage);
function persist(): void {
  saveProgress(storage, progress);
}

// Player-facing order: difficulty quantiles, intra-bucket shuffle keyed by
// a per-user seed minted on first launch. See @ea/core/order.
const shuffleSeed = ensureShuffleSeed(progress);
persist();
const ORDERED_KEYS = shuffleByDifficulty(ALL_KEYS, shuffleSeed);

// --- canvas ---------------------------------------------------------------

const sys = wx.getSystemInfoSync();
console.log("[wxgame] System info:", sys);

const canvas = (GameGlobal.canvas ?? wx.createCanvas()) as WxCanvas;
console.log("[wxgame] Canvas created:", canvas ? "success" : "failed");

canvas.width = Math.floor(sys.windowWidth * sys.pixelRatio);
canvas.height = Math.floor(sys.windowHeight * sys.pixelRatio);
const ctx = canvas.getContext("2d");
ctx.setTransform(sys.pixelRatio, 0, 0, sys.pixelRatio, 0, 0);

const cssW = sys.windowWidth;
const cssH = sys.windowHeight;

console.log(`[wxgame] Canvas size: ${canvas.width}x${canvas.height}, CSS size: ${cssW}x${cssH}`);

// --- subpackage / level catalog --------------------------------------------
//
// MAIN_LEVELS is embedded in the main bundle. Pack data lives in
// subpackages and is fetched on demand via wx.loadSubpackage; the
// subpackage's `entry` script sets globalThis.__EA_PACK_DATA[packIdx].

interface PackEntry {
  key: string;
  data: CompactLevel;
}

declare global {
  // eslint-disable-next-line no-var
  var __EA_PACK_DATA: Record<number, PackEntry[]> | undefined;
}

// wxgame subpackages don't auto-execute on load — we need to require the
// entry file ourselves. esbuild would try to statically resolve a literal
// `require("./pack0/...")` at bundle time, so we route through a runtime
// variable to keep the call opaque to it. `require` is provided by the
// wxgame CJS host. The entry file is `game.js` per wxgame convention so
// DevTools' compile pass finds it (see bundle.mjs header).
declare const require: (path: string) => unknown;
declare function setTimeout(handler: () => void, timeout: number): number;
const runtimeRequire = require as unknown as (p: string) => unknown;

const mainByKey = new Map<string, MainLevel>();
for (const lvl of MAIN_LEVELS) mainByKey.set(lvl.key, lvl);

const packCache = new Map<number, PackEntry[]>();
const inflight = new Map<number, Promise<PackEntry[]>>();

function loadPack(packIdx: number): Promise<PackEntry[]> {
  const cached = packCache.get(packIdx);
  if (cached) return Promise.resolve(cached);
  const existing = inflight.get(packIdx);
  if (existing) return existing;
  const p = new Promise<PackEntry[]>((resolve, reject) => {
    try {
      wx.loadSubpackage({
        name: `pack${packIdx}`,
        success: () => {
          try {
            runtimeRequire(`./pack${packIdx}/game.js`);
          } catch (e) {
            reject({ errMsg: `require pack${packIdx} failed: ${String(e)}` });
            return;
          }
          const data = globalThis.__EA_PACK_DATA?.[packIdx];
          if (!data) {
            reject({ errMsg: `pack${packIdx} loaded but data not registered` });
            return;
          }
          packCache.set(packIdx, data);
          resolve(data);
        },
        fail: (err) => reject(err),
      });
    } catch (e) {
      reject({ errMsg: String(e) });
    }
  });
  inflight.set(packIdx, p);
  p.finally(() => inflight.delete(packIdx));
  return p;
}

function findLevel(key: string):
  | {
      inMain: MainLevel;
    }
  | {
      packIdx: number;
      localIdx: number;
    }
  | null {
  const main = mainByKey.get(key);
  if (main) return { inMain: main };
  const loc = KEY_TO_LOC[key];
  if (!loc) return null;
  const [packIdx, localIdx] = loc;
  if (packIdx < 0) return null;
  return { packIdx, localIdx };
}

async function resolveLevel(key: string): Promise<CompactLevel | null> {
  const f = findLevel(key);
  if (!f) return null;
  if ("inMain" in f) return f.inMain.data;
  const pack = await loadPack(f.packIdx);
  return pack[f.localIdx]?.data ?? null;
}

/**
 * Synchronously resolve a level if its data is already in memory (main
 * bundle or a cached pack). Returns null if the pack still needs to be
 * downloaded — caller should fall back to async `resolveLevel`. Used to
 * avoid a "loading…" flash on every same-pack level switch.
 */
function tryResolveLevelSync(key: string): CompactLevel | null {
  const f = findLevel(key);
  if (!f) return null;
  if ("inMain" in f) return f.inMain.data;
  const cached = packCache.get(f.packIdx);
  if (!cached) return null;
  return cached[f.localIdx]?.data ?? null;
}

/**
 * Look ahead from `fromIdx` and kick off a background `loadPack` for the
 * first uncached pack we'd hit. Idempotent — `loadPack` is itself cached
 * via `packCache` + `inflight`, so multiple calls coalesce.
 */
function prefetchUpcomingPack(fromIdx: number): void {
  for (let off = 1; off <= 4; off++) {
    const k = ORDERED_KEYS[fromIdx + off];
    if (!k) return;
    const f = findLevel(k);
    if (!f || "inMain" in f) continue;
    if (packCache.has(f.packIdx) || inflight.has(f.packIdx)) continue;
    loadPack(f.packIdx).catch(() => {
      /* prefetch failures are best-effort */
    });
    return;
  }
}

// --- game state ----------------------------------------------------------

// HUD layout (logical, in CSS px). The bar starts at `safeTop` so it sits
// below the platform capsule (×, ...) which the WeChat host renders on
// top-right of every wxgame canvas.
//
// Info section is two stacked rows:
//   Row 1 (28 px): level idx/name | hearts | status/loading text
//   Row 2 (44 px): 💡N 🪙N counters | gear ⚙ → settings modal
// Then a 24-px button row: prev / hint / reset / undo / next.
const HUD_H = 96;
const HUD_INFO_H = 72;
const HUD_BTN_H = HUD_H - HUD_INFO_H;
const HUD_INFO_ROW1_H = 28;
const HUD_INFO_ROW2_H = HUD_INFO_H - HUD_INFO_ROW1_H;

// Reserve vertical space for the platform-rendered capsule (×, ...) at the
// top-right of every wxgame canvas. `getMenuButtonBoundingClientRect` is
// the documented way to get its CSS-px position; we add a small pad so the
// HUD doesn't kiss the capsule's bottom edge. The fallback handles older
// devtools / hosts that don't ship the API.
function computeSafeTop(): number {
  try {
    const r = (
      wx as unknown as {
        getMenuButtonBoundingClientRect?: () => { bottom: number };
      }
    ).getMenuButtonBoundingClientRect?.();
    if (r && typeof r.bottom === "number" && r.bottom > 0) {
      return Math.ceil(r.bottom) + 4;
    }
  } catch {
    /* fall through */
  }
  // Capsule height ~32, top ~ statusBarHeight + 7, plus our 4-px pad.
  const sbh = (sys as { statusBarHeight?: number }).statusBarHeight ?? 20;
  return sbh + 7 + 32 + 4;
}
const safeTop = computeSafeTop();
const hudBottom = safeTop + HUD_H;
const boardTop = hudBottom;
const boardH = cssH - boardTop;
const row1MidY = safeTop + HUD_INFO_ROW1_H / 2;
const row2TopY = safeTop + HUD_INFO_ROW1_H;
const row2MidY = row2TopY + HUD_INFO_ROW2_H / 2;
const btnTopY = safeTop + HUD_INFO_H;
const btnMidY = btnTopY + HUD_BTN_H / 2;
// Gear icon tap zone (right side of row 2).
let gearHitbox: RectHit | null = null;

// Screen mode. Splash shows the title + health-game advisory + age rating
// + Start button on cold launch (备案首图要求). After the user taps Start
// we switch to "game" and never go back this session.
type Screen = "splash" | "game";
let screen: Screen = "splash";
let splashHitbox: { x: number; y: number; w: number; h: number } | null = null;

let levelIndex = 0;
let game: GameState | null = null;
let loadingKey: string | null = null;

// Undo / hint state
const UNDO_CAP = 20;
const undoStack: GameSnapshot[] = [];
let hintArrowId: number | null = null;
let hintStart = 0;
let hintBusy = false;
const HINT_DURATION = 2500;
const HINT_AD_REFILL = 3;
const COIN_PER_WIN = 1;
const COIN_PER_AD = 5;

// Modal state. Only one modal is open at a time.
type Modal = "none" | "noLives" | "noHints" | "settings";
let modal: Modal = "none";
interface RectHit {
  x: number;
  y: number;
  w: number;
  h: number;
}
interface NoHintsHitbox {
  ad: RectHit;
  close: RectHit;
}
interface SettingsHitbox {
  sfx: RectHit;
  vibrate: RectHit;
  close: RectHit;
}
let noHintsHitbox: NoHintsHitbox | null = null;
let settingsHitbox: SettingsHitbox | null = null;
function clearUndoStack(): void {
  undoStack.length = 0;
}
function isHintActive(): boolean {
  return hintArrowId != null && performance.now() - hintStart < HINT_DURATION;
}

// --- animation state -----------------------------------------------------

interface Tween {
  from: number;
  to: number;
  /** When set, animate from → bounceTo → from (forward push, recoil) to
   *  visualize a blocked pull. The body's logical progress is unchanged. */
  bounceTo?: number;
  start: number;
  dur: number;
  escapedAtEnd: boolean;
}
const tweens = new Map<number, Tween>();
let rafId = 0;

function easeOutCubic(u: number): number {
  return 1 - (1 - u) ** 3;
}
function evalTween(tw: Tween, now: number): number {
  const u = Math.min(1, Math.max(0, (now - tw.start) / tw.dur));
  if (tw.bounceTo !== undefined) {
    const v = u < 0.5 ? u * 2 : (1 - u) * 2;
    return tw.from + (tw.bounceTo - tw.from) * easeOutCubic(v);
  }
  return tw.from + (tw.to - tw.from) * easeOutCubic(u);
}
function startTween(id: number, before: number, after: number, escapedAtEnd: boolean): void {
  const now = performance.now();
  const existing = tweens.get(id);
  const fromNow = existing ? evalTween(existing, now) : before;
  const dist = Math.abs(after - fromNow);
  const dur = Math.min(450, Math.max(120, dist * 70));
  tweens.set(id, { from: fromNow, to: after, start: now, dur, escapedAtEnd });
  ensureRAF();
}
function startBounce(id: number, from: number, bump: number): void {
  tweens.set(id, {
    from,
    to: from,
    bounceTo: from + bump,
    start: performance.now(),
    dur: 280,
    escapedAtEnd: false,
  });
  ensureRAF();
}
function ensureRAF(): void {
  if (rafId) return;
  const step = (): void => {
    rafId = 0;
    render();
    if (
      tweens.size > 0 ||
      isWinAnimating() ||
      loadingKey != null ||
      modal !== "none" ||
      isHintActive()
    ) {
      rafId = requestAnimationFrame(step);
    } else if (hintArrowId != null) {
      hintArrowId = null;
      render();
    }
  };
  rafId = requestAnimationFrame(step);
}
function isAnimating(): boolean {
  return tweens.size > 0;
}
function clearAnimations(): void {
  tweens.clear();
}

// --- audio ----------------------------------------------------------------

const audioCtx: AudioContextLike | null = (() => {
  try {
    if (typeof wx.createWebAudioContext === "function") {
      return wx.createWebAudioContext() as AudioContextLike;
    }
    return null;
  } catch {
    return null;
  }
})();
const synth: Synth = makeSynth(audioCtx);
synth.muted = !progress.settings.sfx;

function applySettings(): void {
  synth.muted = !progress.settings.sfx;
}

function vibrate(): void {
  if (!progress.settings.vibrate) return;
  try {
    const wxAny = wx as unknown as { vibrateShort?: (opts: { type: string }) => void };
    wxAny.vibrateShort?.({ type: "light" });
  } catch {
    /* unsupported */
  }
}

// --- win overlay ----------------------------------------------------------

let winStart: number | null = null;
let winHitbox: OverlayHitbox | null = null;
function isWinAnimating(): boolean {
  return winStart != null && performance.now() - winStart < 700;
}

// --- no-lives overlay -----------------------------------------------------

interface NoLivesHitbox {
  ad: { x: number; y: number; w: number; h: number };
  close: { x: number; y: number; w: number; h: number };
}
let noLivesHitbox: NoLivesHitbox | null = null;

// Replace with your own ad unit ID before submitting to mp.weixin.qq.com.
// `wx.createRewardedVideoAd` is absent in devtool / older clients — we then
// fall back to refilling 1 immediately so the flow is still exercisable.
const REWARDED_AD_UNIT_ID = "";

/**
 * Show a rewarded video ad and call `onReward` if the user watches it to
 * completion. Falls back to immediate-grant when the API or ad-unit-id is
 * missing (devtools / pre-onboarding) so the flow stays exercisable.
 */
function showRewardedAd(onReward: () => void): void {
  const create = wx.createRewardedVideoAd;
  if (!create || !REWARDED_AD_UNIT_ID) {
    onReward();
    ensureRAF();
    render();
    return;
  }
  const ad = create({ adUnitId: REWARDED_AD_UNIT_ID });
  const onClose = (e: { isEnded: boolean }): void => {
    if (e.isEnded) onReward();
    ad.offClose(onClose);
    ad.destroy();
    ensureRAF();
    render();
  };
  ad.onClose(onClose);
  ad.show().catch(() => {
    ad.load()
      .then(() => ad.show())
      .catch(() => {
        ad.offClose(onClose);
        ad.destroy();
      });
  });
}

function tryAdRefillLife(): void {
  showRewardedAd(() => {
    addLives(1);
    modal = "none";
  });
}

function tryAdRefillHints(): void {
  showRewardedAd(() => {
    progress.hints += HINT_AD_REFILL;
    progress.coins += COIN_PER_AD;
    persist();
    modal = "none";
  });
}

// --- level selection ------------------------------------------------------

function selectLevelByIndex(i: number): void {
  if (i < 0 || i >= ORDERED_KEYS.length) return;
  const key = ORDERED_KEYS[i]!;
  levelIndex = i;
  game = null;
  clearAnimations();
  clearUndoStack();
  hintArrowId = null;
  hintBusy = false;
  winStart = null;

  // Sync fast-path: if the level is already in memory (main bundle or a
  // pre-warmed pack), build the game inline so the user doesn't see a
  // "loading…" flash. Network/disk only ever stalls us once per pack.
  const syncCompact = tryResolveLevelSync(key);
  if (syncCompact) {
    game = createGame(loadLevel(decodeCompact(syncCompact)));
    loadingKey = null;
    progress.lastKey = key;
    persist();
    ensureRAF();
    render();
    prefetchUpcomingPack(i);
    return;
  }

  loadingKey = key;
  ensureRAF();
  render();
  resolveLevel(key)
    .then((compact) => {
      if (loadingKey !== key) return; // user advanced past us
      if (!compact) {
        loadingKey = null;
        render();
        return;
      }
      game = createGame(loadLevel(decodeCompact(compact)));
      loadingKey = null;
      progress.lastKey = key;
      persist();
      render();
      prefetchUpcomingPack(i);
    })
    .catch(() => {
      if (loadingKey === key) {
        loadingKey = null;
        render();
      }
    });
}

// --- render ---------------------------------------------------------------

let renderCount = 0;
function render(): void {
  renderCount++;
  if (renderCount <= 3) {
    console.log(
      `[wxgame] render() called #${renderCount}, game=${!!game}, loadingKey=${loadingKey}`,
    );
  }

  ctx.fillStyle = "#0b1220";
  ctx.fillRect(0, 0, cssW, cssH);

  if (screen === "splash") {
    splashHitbox = drawSplash();
    return;
  }

  if (game) {
    const t = fitView(game.level, cssW, boardH);
    const view2 = { ...t, oy: t.oy + boardTop };
    const now = performance.now();
    const progressOverride = new Map<number, number>();
    const drawEscapedIds = new Set<number>();
    for (const [id, tw] of tweens) {
      progressOverride.set(id, evalTween(tw, now));
      if (now >= tw.start + tw.dur) {
        tweens.delete(id);
      } else if (tw.escapedAtEnd) {
        drawEscapedIds.add(id);
      }
    }
    let highlightArrowId: number | null = null;
    let highlightPulse = 1;
    if (isHintActive()) {
      highlightArrowId = hintArrowId;
      const u = (now - hintStart) / HINT_DURATION;
      const pulseAmp = 0.55 + 0.45 * Math.sin(now * 0.012);
      const fade = u < 0.8 ? 1 : Math.max(0, 1 - (u - 0.8) / 0.2);
      highlightPulse = pulseAmp * fade;
    }
    drawGame(ctx as any, game, view2, {
      showPaths: false,
      progressOverride,
      drawEscapedIds,
      highlightArrowId,
      highlightPulse,
    });
  }
  drawHud();

  if (loadingKey != null) {
    drawLoadingOverlay();
  } else if (game && game.status === "won" && winStart != null) {
    const phase = (performance.now() - winStart) / 1000;
    winHitbox = drawWinOverlay(ctx as any, cssW, cssH, phase);
  } else {
    winHitbox = null;
  }

  noLivesHitbox = modal === "noLives" ? drawNoLivesOverlay() : null;
  noHintsHitbox = modal === "noHints" ? drawNoHintsOverlay() : null;
  settingsHitbox = modal === "settings" ? drawSettingsOverlay() : null;
}

function drawGearIcon(cx: number, cy: number, r: number): void {
  // Eight-tooth gear: outer star + inner ring + center dot.
  const teeth = 8;
  const innerR = r * 0.7;
  const tipR = r;
  ctx.fillStyle = "#94a3b8";
  ctx.beginPath();
  for (let i = 0; i < teeth * 2; i++) {
    const a = (i / (teeth * 2)) * Math.PI * 2;
    const rad = i % 2 === 0 ? tipR : innerR;
    const x = cx + Math.cos(a) * rad;
    const y = cy + Math.sin(a) * rad;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();
  // Center hole.
  ctx.fillStyle = "#0f172a";
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.32, 0, Math.PI * 2);
  ctx.fill();
}

function drawHeart(cx: number, cy: number, r: number, filled: boolean): void {
  // Two-arc + V-shape heart. Pure path so it works with the minimal
  // WxCanvasRenderingContext2D surface.
  ctx.beginPath();
  ctx.arc(cx - r * 0.45, cy - r * 0.15, r * 0.45, 0, Math.PI * 2);
  ctx.arc(cx + r * 0.45, cy - r * 0.15, r * 0.45, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(cx - r * 0.9, cy - r * 0.1);
  ctx.lineTo(cx, cy + r * 0.85);
  ctx.lineTo(cx + r * 0.9, cy - r * 0.1);
  ctx.closePath();
  if (filled) {
    ctx.fill();
  } else {
    ctx.stroke();
  }
}

function drawHearts(centerX: number, centerY: number): void {
  tickLives();
  const { lives } = getLivesState();
  const { max } = getLivesConfig();
  const r = 9;
  const gap = 4;
  const slotW = r * 2 + gap;
  const totalW = max * slotW - gap;
  const startX = centerX - totalW / 2;
  for (let i = 0; i < max; i++) {
    const x = startX + i * slotW + r;
    if (i < lives) {
      ctx.fillStyle = "#ef4444";
      drawHeart(x, centerY, r, true);
    } else {
      ctx.strokeStyle = "#475569";
      ctx.lineWidth = 1.5;
      drawHeart(x, centerY, r, false);
    }
  }
  const ms = nextRegenMs();
  if (ms != null) {
    ctx.fillStyle = "#94a3b8";
    ctx.font = "11px sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(formatMs(ms), startX + totalW + 6, centerY + 1);
  }
}

type HudButton = "prev" | "hint" | "reset" | "undo" | "next";
const HUD_BUTTON_ORDER: HudButton[] = ["prev", "hint", "reset", "undo", "next"];
const HUD_BUTTON_LABEL: Record<HudButton, string> = {
  prev: "‹ 上一",
  hint: "💡 提示",
  reset: "↻ 重开",
  undo: "↶ 撤销",
  next: "下一 ›",
};

function drawHud(): void {
  // Capsule reserve + info section (drawn as one continuous dark band so
  // the platform capsule on top reads as part of the bar).
  ctx.fillStyle = "#0f172a";
  ctx.fillRect(0, 0, cssW, btnTopY);

  // Row 1: level idx / name (left) | hearts (center) | status (right)
  ctx.fillStyle = "#e2e8f0";
  ctx.font = "14px sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  const key = ORDERED_KEYS[levelIndex] ?? "";
  const name = key.replace(/^\d+__/, "").replace(/\.json$/, "");
  ctx.fillText(`${levelIndex + 1}/${ORDERED_KEYS.length}  ${name}`, 12, row1MidY);

  drawHearts(cssW / 2, row1MidY);

  if (game) {
    const remaining = game.arrows.filter((a) => !a.escaped).length;
    ctx.textAlign = "right";
    ctx.fillStyle = game.status === "won" ? "#22c55e" : "#e2e8f0";
    ctx.font = "14px sans-serif";
    ctx.fillText(
      game.status === "won" ? "通关！" : `剩余 ${remaining}/${game.arrows.length}`,
      cssW - 12,
      row1MidY,
    );
  } else if (loadingKey != null) {
    ctx.textAlign = "right";
    ctx.fillStyle = "#94a3b8";
    ctx.font = "14px sans-serif";
    ctx.fillText("加载中...", cssW - 12, row1MidY);
  }

  // Row 2: hint balance + coin balance (left) | gear icon (right)
  ctx.fillStyle = "#fbbf24";
  ctx.font = "13px sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(`💡 ${progress.hints}`, 12, row2MidY);
  ctx.fillStyle = "#fde047";
  ctx.fillText(`🪙 ${progress.coins}`, 78, row2MidY);

  const gearSize = 36;
  const gearX = cssW - gearSize - 8;
  const gearY = row2TopY + (HUD_INFO_ROW2_H - gearSize) / 2;
  drawGearIcon(gearX + gearSize / 2, gearY + gearSize / 2, 12);
  gearHitbox = { x: gearX, y: gearY, w: gearSize, h: gearSize };

  // Button row — 5 evenly-spaced labels with a thin separator above.
  ctx.strokeStyle = "#1e293b";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, btnTopY + 0.5);
  ctx.lineTo(cssW, btnTopY + 0.5);
  ctx.stroke();

  const btnW = cssW / 5;
  ctx.font = "13px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (let i = 0; i < 5; i++) {
    const btn = HUD_BUTTON_ORDER[i]!;
    const enabled = isHudButtonEnabled(btn);
    let bg = "#0f172a";
    let fg = enabled ? "#e2e8f0" : "#475569";
    if (btn === "hint" && hintBusy) {
      bg = "#7c2d12";
      fg = "#fde047";
    } else if (btn === "hint" && enabled) {
      fg = "#fbbf24";
    } else if (btn === "undo" && enabled) {
      fg = "#cbd5e1";
    }
    ctx.fillStyle = bg;
    ctx.fillRect(i * btnW, btnTopY, btnW, HUD_BTN_H);
    if (i > 0) {
      ctx.strokeStyle = "#1e293b";
      ctx.beginPath();
      ctx.moveTo(i * btnW + 0.5, btnTopY);
      ctx.lineTo(i * btnW + 0.5, hudBottom);
      ctx.stroke();
    }
    ctx.fillStyle = fg;
    ctx.fillText(HUD_BUTTON_LABEL[btn], i * btnW + btnW / 2, btnMidY);
  }
}

function isHudButtonEnabled(btn: HudButton): boolean {
  if (loadingKey != null) return false;
  switch (btn) {
    case "prev":
      return levelIndex > 0;
    case "next":
      return levelIndex < ORDERED_KEYS.length - 1;
    case "reset":
      return !!game;
    case "undo":
      return !!game && undoStack.length > 0;
    case "hint":
      return !!game && game.status === "playing" && !hintBusy;
  }
}

function formatMs(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function drawNoLivesOverlay(): NoLivesHitbox {
  ctx.fillStyle = "rgba(15,23,42,0.78)";
  ctx.fillRect(0, 0, cssW, cssH);

  const cardW = Math.min(320, cssW - 48);
  const cardH = 240;
  const cardX = (cssW - cardW) / 2;
  const cardY = (cssH - cardH) / 2;

  ctx.fillStyle = "#1e293b";
  ctx.fillRect(cardX, cardY, cardW, cardH);

  ctx.fillStyle = "#f8fafc";
  ctx.font = "bold 18px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("心已用光", cardX + cardW / 2, cardY + 36);

  ctx.fillStyle = "#94a3b8";
  ctx.font = "13px sans-serif";
  ctx.fillText("等待恢复，或看广告 +1", cardX + cardW / 2, cardY + 64);

  tickLives();
  const ms = nextRegenMs();
  ctx.fillStyle = "#f1f5f9";
  ctx.font = "24px sans-serif";
  ctx.fillText(ms == null ? "已恢复" : formatMs(ms), cardX + cardW / 2, cardY + 108);

  const btnW = cardW - 40;
  const btnH = 40;
  const adX = cardX + (cardW - btnW) / 2;
  const adY = cardY + 140;
  ctx.fillStyle = "#22c55e";
  ctx.fillRect(adX, adY, btnW, btnH);
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 15px sans-serif";
  ctx.fillText("看广告 +1 心", cardX + cardW / 2, adY + btnH / 2);

  const closeY = adY + btnH + 10;
  ctx.strokeStyle = "#334155";
  ctx.lineWidth = 1;
  ctx.strokeRect(adX, closeY, btnW, btnH);
  ctx.fillStyle = "#94a3b8";
  ctx.font = "14px sans-serif";
  ctx.fillText("稍后再来", cardX + cardW / 2, closeY + btnH / 2);

  return {
    ad: { x: adX, y: adY, w: btnW, h: btnH },
    close: { x: adX, y: closeY, w: btnW, h: btnH },
  };
}

function drawNoHintsOverlay(): NoHintsHitbox {
  ctx.fillStyle = "rgba(15,23,42,0.78)";
  ctx.fillRect(0, 0, cssW, cssH);

  const cardW = Math.min(320, cssW - 48);
  const cardH = 220;
  const cardX = (cssW - cardW) / 2;
  const cardY = (cssH - cardH) / 2;

  ctx.fillStyle = "#1e293b";
  ctx.fillRect(cardX, cardY, cardW, cardH);

  ctx.fillStyle = "#f8fafc";
  ctx.font = "bold 18px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("提示次数已用完", cardX + cardW / 2, cardY + 36);

  ctx.fillStyle = "#94a3b8";
  ctx.font = "13px sans-serif";
  ctx.fillText(`看一段广告补 ${HINT_AD_REFILL} 次提示`, cardX + cardW / 2, cardY + 66);
  ctx.fillText(`额外赠送 ${COIN_PER_AD} 金币`, cardX + cardW / 2, cardY + 88);

  const btnW = cardW - 40;
  const btnH = 40;
  const adX = cardX + (cardW - btnW) / 2;
  const adY = cardY + 120;
  ctx.fillStyle = "#f59e0b";
  ctx.fillRect(adX, adY, btnW, btnH);
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 15px sans-serif";
  ctx.fillText(`看广告 +${HINT_AD_REFILL} 提示`, cardX + cardW / 2, adY + btnH / 2);

  const closeY = adY + btnH + 10;
  ctx.strokeStyle = "#334155";
  ctx.lineWidth = 1;
  ctx.strokeRect(adX, closeY, btnW, btnH);
  ctx.fillStyle = "#94a3b8";
  ctx.font = "14px sans-serif";
  ctx.fillText("稍后再来", cardX + cardW / 2, closeY + btnH / 2);

  return {
    ad: { x: adX, y: adY, w: btnW, h: btnH },
    close: { x: adX, y: closeY, w: btnW, h: btnH },
  };
}

function drawSettingsOverlay(): SettingsHitbox {
  ctx.fillStyle = "rgba(15,23,42,0.78)";
  ctx.fillRect(0, 0, cssW, cssH);

  const cardW = Math.min(320, cssW - 48);
  const cardH = 260;
  const cardX = (cssW - cardW) / 2;
  const cardY = (cssH - cardH) / 2;

  ctx.fillStyle = "#1e293b";
  ctx.fillRect(cardX, cardY, cardW, cardH);

  ctx.fillStyle = "#f8fafc";
  ctx.font = "bold 18px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("设置", cardX + cardW / 2, cardY + 36);

  const rowW = cardW - 40;
  const rowH = 44;
  const rowX = cardX + (cardW - rowW) / 2;

  const drawRow = (y: number, label: string, on: boolean): RectHit => {
    ctx.fillStyle = "#0f172a";
    ctx.fillRect(rowX, y, rowW, rowH);
    ctx.fillStyle = "#e2e8f0";
    ctx.font = "14px sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(label, rowX + 12, y + rowH / 2);

    const knobW = 56;
    const knobH = 28;
    const knobX = rowX + rowW - knobW - 12;
    const knobY = y + (rowH - knobH) / 2;
    ctx.fillStyle = on ? "#22c55e" : "#475569";
    ctx.fillRect(knobX, knobY, knobW, knobH);
    ctx.fillStyle = "#ffffff";
    const dotR = (knobH - 6) / 2;
    const dotCX = on ? knobX + knobW - dotR - 3 : knobX + dotR + 3;
    ctx.beginPath();
    ctx.arc(dotCX, knobY + knobH / 2, dotR, 0, Math.PI * 2);
    ctx.fill();
    ctx.textAlign = "center";
    return { x: rowX, y, w: rowW, h: rowH };
  };

  const sfxBox = drawRow(cardY + 70, "音效", progress.settings.sfx);
  const vibBox = drawRow(cardY + 70 + rowH + 12, "震动反馈", progress.settings.vibrate);

  const btnW = rowW;
  const btnH = 40;
  const closeX = rowX;
  const closeY = cardY + cardH - btnH - 16;
  ctx.strokeStyle = "#334155";
  ctx.lineWidth = 1;
  ctx.strokeRect(closeX, closeY, btnW, btnH);
  ctx.fillStyle = "#94a3b8";
  ctx.font = "14px sans-serif";
  ctx.textBaseline = "middle";
  ctx.fillText("关闭", cardX + cardW / 2, closeY + btnH / 2);

  return {
    sfx: sfxBox,
    vibrate: vibBox,
    close: { x: closeX, y: closeY, w: btnW, h: btnH },
  };
}

function pointInRect(
  px: number,
  py: number,
  r: { x: number; y: number; w: number; h: number },
): boolean {
  return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
}

function drawLoadingOverlay(): void {
  ctx.fillStyle = "rgba(15,23,42,0.72)";
  ctx.fillRect(0, boardTop, cssW, boardH);
  ctx.fillStyle = "#e2e8f0";
  ctx.font = `${Math.floor(Math.min(cssW, cssH) * 0.06)}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const dots = ".".repeat(1 + (Math.floor(performance.now() / 350) % 3));
  ctx.fillText(`加载关卡${dots}`, cssW / 2, boardTop + boardH / 2);
}

// --- splash --------------------------------------------------------------
// Cold-launch screen shown before the user enters the game. Layout:
// 标题「箭路脱困」+ 健康游戏忠告 (8 短句, 备案文案) + 适龄提示 8+ +
// 「开始游戏」按钮。备案首图截这一屏。

const HEALTH_ADVISORY_LINES = [
  "抵制不良游戏  拒绝盗版游戏",
  "注意自我保护  谨防受骗上当",
  "适度游戏益脑  沉迷游戏伤身",
  "合理安排时间  享受健康生活",
];
const AGE_NOTICE = "适龄提示：本游戏适合 8 岁以上用户使用";

function drawSplash(): { x: number; y: number; w: number; h: number } {
  // Same dark capsule-reserve band so the platform capsule (×, ...) sits
  // on a consistent backdrop instead of bare canvas.
  ctx.fillStyle = "#0f172a";
  ctx.fillRect(0, 0, cssW, safeTop);

  const title = "箭路脱困";
  const cx = cssW / 2;
  const titleY = safeTop + Math.max(80, cssH * 0.18);

  ctx.fillStyle = "#fde047";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `bold ${Math.floor(Math.min(cssW, 480) * 0.11)}px sans-serif`;
  ctx.fillText(title, cx, titleY);

  ctx.fillStyle = "#94a3b8";
  ctx.font = "13px sans-serif";
  ctx.fillText("休闲益智 · 箭头脱困谜题", cx, titleY + 38);

  // Health advisory block
  const advisoryY = titleY + 110;
  ctx.fillStyle = "#cbd5e1";
  ctx.font = "bold 13px sans-serif";
  ctx.fillText("健康游戏忠告", cx, advisoryY);
  ctx.fillStyle = "#e2e8f0";
  ctx.font = "12px sans-serif";
  for (let i = 0; i < HEALTH_ADVISORY_LINES.length; i++) {
    ctx.fillText(HEALTH_ADVISORY_LINES[i]!, cx, advisoryY + 24 + i * 18);
  }

  // Age notice
  const ageY = advisoryY + 24 + HEALTH_ADVISORY_LINES.length * 18 + 22;
  ctx.fillStyle = "#22c55e";
  ctx.font = "bold 13px sans-serif";
  ctx.fillText(AGE_NOTICE, cx, ageY);

  // Start button
  const btnW = Math.min(220, cssW - 80);
  const btnH = 48;
  const btnX = (cssW - btnW) / 2;
  const btnY = Math.min(cssH - btnH - 40, ageY + 60);
  ctx.fillStyle = "#3b82f6";
  ctx.fillRect(btnX, btnY, btnW, btnH);
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 18px sans-serif";
  ctx.fillText("开始游戏", cx, btnY + btnH / 2);

  return { x: btnX, y: btnY, w: btnW, h: btnH };
}

// --- input ----------------------------------------------------------------

function hitHud(x: number, y: number): HudButton | null {
  if (y < btnTopY || y > hudBottom) return null;
  const i = Math.floor(x / (cssW / 5));
  if (i < 0 || i > 4) return null;
  return HUD_BUTTON_ORDER[i]!;
}

wx.onTouchStart((e: WxTouchEvent) => {
  if (e.touches.length === 0) return;
  const t0 = e.touches[0]!;
  const px = t0.clientX;
  const py = t0.clientY;

  if (screen === "splash") {
    if (splashHitbox && pointInRect(px, py, splashHitbox)) {
      synth.click();
      screen = "game";
      // Resume last-played level if known; else level 0.
      const restoreIdx = progress.lastKey ? ORDERED_KEYS.indexOf(progress.lastKey) : -1;
      selectLevelByIndex(restoreIdx >= 0 ? restoreIdx : 0);
    }
    return;
  }

  if (loadingKey != null) return;

  if (modal === "noLives" && noLivesHitbox) {
    if (pointInRect(px, py, noLivesHitbox.ad)) {
      synth.click();
      tryAdRefillLife();
    } else if (pointInRect(px, py, noLivesHitbox.close)) {
      synth.click();
      modal = "none";
      render();
    }
    return;
  }
  if (modal === "noHints" && noHintsHitbox) {
    if (pointInRect(px, py, noHintsHitbox.ad)) {
      synth.click();
      tryAdRefillHints();
    } else if (pointInRect(px, py, noHintsHitbox.close)) {
      synth.click();
      modal = "none";
      render();
    }
    return;
  }
  if (modal === "settings" && settingsHitbox) {
    if (pointInRect(px, py, settingsHitbox.sfx)) {
      progress.settings.sfx = !progress.settings.sfx;
      applySettings();
      synth.click();
      persist();
      render();
    } else if (pointInRect(px, py, settingsHitbox.vibrate)) {
      progress.settings.vibrate = !progress.settings.vibrate;
      synth.click();
      vibrate();
      persist();
      render();
    } else if (pointInRect(px, py, settingsHitbox.close)) {
      synth.click();
      modal = "none";
      render();
    }
    return;
  }

  if (game && game.status === "won" && winHitbox) {
    const hit = hitTestOverlay(winHitbox, px, py);
    if (hit === "next") {
      synth.click();
      selectLevelByIndex(levelIndex + 1);
    }
    return;
  }

  if (gearHitbox && pointInRect(px, py, gearHitbox)) {
    synth.click();
    modal = "settings";
    ensureRAF();
    render();
    return;
  }

  const hud = hitHud(px, py);
  if (hud) {
    if (!isHudButtonEnabled(hud)) {
      synth.thud();
      return;
    }
    synth.click();
    if (hud === "prev") {
      selectLevelByIndex(levelIndex - 1);
    } else if (hud === "next") {
      selectLevelByIndex(levelIndex + 1);
    } else if (hud === "reset") {
      if (!tryConsumeLife()) {
        modal = "noLives";
        ensureRAF();
        render();
        return;
      }
      resetGame(game!);
      clearAnimations();
      clearUndoStack();
      hintArrowId = null;
      winStart = null;
      render();
    } else if (hud === "undo") {
      doUndo();
    } else if (hud === "hint") {
      doHint();
    }
    return;
  }

  if (!game || isAnimating()) return;
  const view = fitView(game.level, cssW, boardH);
  const view2 = { ...view, oy: view.oy + boardTop };
  const cell = pickCell(px, py, view2);
  if (cell.x < 0 || cell.y < 0 || cell.x >= game.level.width || cell.y >= game.level.height) {
    return;
  }
  const arrow = findArrowAt(game, cell);
  if (!arrow) return;
  const before = arrow.progress;
  const snap = snapshotGame(game);
  const r = tryPull(game, arrow.id);
  const after = arrow.progress;
  if (r.steps > 0) {
    undoStack.push(snap);
    if (undoStack.length > UNDO_CAP) undoStack.shift();
    if (hintArrowId === arrow.id) hintArrowId = null;
    startTween(arrow.id, before, after, r.escaped);
    if (r.escaped) {
      synth.escape();
      vibrate();
    } else {
      synth.whoosh(r.steps);
    }
  } else {
    // Blocked. Spend a life, then bounce-back to make the rejection
    // legible. Out-of-lives funnels into the no-lives modal (same as reset).
    if (!tryConsumeLife()) {
      modal = "noLives";
      ensureRAF();
      render();
      return;
    }
    startBounce(arrow.id, before, 0.55);
    synth.thud();
    vibrate();
  }
  if (r.won) {
    const key = ORDERED_KEYS[levelIndex]!;
    const firstClear = !progress.completed.has(key);
    progress.completed.add(key);
    if (firstClear) progress.coins += COIN_PER_WIN;
    persist();
    winStart = performance.now();
    synth.win();
    ensureRAF();
  }
  render();
});

function doUndo(): void {
  if (!game || loadingKey != null || isAnimating()) return;
  const snap = undoStack.pop();
  if (!snap) return;
  restoreGame(game, snap);
  clearAnimations();
  winStart = null;
  hintArrowId = null;
  ensureRAF();
  render();
}

function doHint(): void {
  if (!game || game.status !== "playing") return;
  if (loadingKey != null || isAnimating() || hintBusy) return;
  if (progress.hints <= 0) {
    modal = "noHints";
    ensureRAF();
    render();
    return;
  }
  hintBusy = true;
  render();
  // Defer a frame so the "thinking…" highlight paints before solver blocks.
  setTimeout(() => {
    const moveId = game ? findNextMove(game, Date.now() + 1500) : null;
    hintBusy = false;
    if (moveId != null) {
      hintArrowId = moveId;
      hintStart = performance.now();
      // Spend the hint only when the solver succeeded.
      progress.hints = Math.max(0, progress.hints - 1);
      persist();
      ensureRAF();
    }
    render();
  }, 30);
}

// --- bootstrap ------------------------------------------------------------

console.log("[wxgame] Bootstrap starting...");
console.log(`[wxgame] Total levels: ${ORDERED_KEYS.length}, Packs: ${PACK_COUNT}`);

// Splash → user taps Start → enters game. We still preload the pack of
// the resume target in the background so the first level is ready when
// the user taps, eliminating the cold-start "loading…" flash.
const restoreIdx = progress.lastKey ? ORDERED_KEYS.indexOf(progress.lastKey) : -1;
const startIdx = restoreIdx >= 0 ? restoreIdx : 0;
console.log(`[wxgame] Splash mode — resume idx: ${startIdx}, key: ${progress.lastKey || "none"}`);
const startKey = ORDERED_KEYS[startIdx];
if (startKey) {
  const f = findLevel(startKey);
  if (f && !("inMain" in f) && !packCache.has(f.packIdx) && !inflight.has(f.packIdx)) {
    loadPack(f.packIdx).catch(() => {
      /* best-effort prewarm */
    });
  }
  // And the pack right after, so the second level is also instant.
  prefetchUpcomingPack(startIdx);
}
ensureRAF();
render();

console.log("[wxgame] Bootstrap complete (splash shown)");

// Surface PACK_COUNT for inspection in devtools.
void PACK_COUNT;
