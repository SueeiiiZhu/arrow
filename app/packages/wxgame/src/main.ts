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
// Info section is two stacked rows on a strict grid — every item is
// anchored to LEFT, CENTER, or RIGHT so the long level name and the heart
// row can never collide regardless of screen width:
//
//   Row 1 (38 px): [LV n / total] pill (LEFT)        hearts ❤×N + timer (RIGHT)
//   Row 2 (30 px): 💡N 🪙N counters (LEFT) | 剩余 N/M status (CENTER) | ⚙ (RIGHT)
//
// Then a 28-px button row: prev / hint / reset / undo / next.
const HUD_H = 96;
const HUD_INFO_ROW1_H = 38;
const HUD_INFO_ROW2_H = 30;
const HUD_INFO_H = HUD_INFO_ROW1_H + HUD_INFO_ROW2_H;
const HUD_BTN_H = HUD_H - HUD_INFO_H;

// --- UI palette ----------------------------------------------------------
// "Editorial Bauhaus" — cool dark chrome with warm-gold accents, coral
// hearts, mint-green win state. Tighter contrast than the original generic
// slate-blue HUD; clear hierarchy primaries / secondaries / accents.
const UI = {
  hudBg: "#0c111c",
  hudHairline: "#1a2238",
  ruleAccent: "rgba(230, 184, 92, 0.30)",
  chipBg: "#161e2e",
  chipBorder: "#252e45",
  textPrimary: "#e8e1d2",
  textSecondary: "#7e8093",
  textGold: "#e6b85c",
  heartFill: "#fb6e51",
  heartEmpty: "#3a4257",
  statusWon: "#7ee3a1",
  hintGold: "#e6b85c",
  coinGold: "#ffd879",
  btnText: "#e8e1d2",
  btnTextDisabled: "#3a4257",
  btnDivider: "#1a2238",
  btnHintActiveBg: "#2a1f0e",
  btnHintActiveText: "#e6b85c",
  gear: "#9aa0b3",
  modalBackdrop: "rgba(8, 11, 18, 0.84)",
  modalCardBg: "#15131a",
  modalCardBorder: "#2c2530",
  modalTitle: "#f4ecdc",
  modalBody: "#9c9099",
  modalAccent: "#e6b85c",
  ctaPrimaryBg: "#fb6e51",
  ctaPrimaryText: "#15131a",
  ctaSecondaryBorder: "#3a3340",
  ctaSecondaryText: "#9c9099",
  switchOn: "#e6b85c",
  switchOff: "#3a4257",
  switchKnob: "#f4ecdc",
  fontDisplayCJK: '"PingFang SC", "Helvetica Neue", -apple-system, sans-serif',
};

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
  ctx.fillStyle = UI.gear;
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
  // Center hole — punched through to HUD background.
  ctx.fillStyle = UI.hudBg;
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.32, 0, Math.PI * 2);
  ctx.fill();
}

// Rounded-rect path on the active context; caller picks fill/stroke.
function roundRectPath(x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arc(x + w - rr, y + rr, rr, -Math.PI / 2, 0);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arc(x + w - rr, y + h - rr, rr, 0, Math.PI / 2);
  ctx.lineTo(x + rr, y + h);
  ctx.arc(x + rr, y + h - rr, rr, Math.PI / 2, Math.PI);
  ctx.lineTo(x, y + rr);
  ctx.arc(x + rr, y + rr, rr, Math.PI, -Math.PI / 2);
  ctx.closePath();
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

function drawHeartsRight(rightX: number, midY: number): void {
  tickLives();
  const { lives } = getLivesState();
  const { max } = getLivesConfig();
  const r = 8;
  const gap = 5;
  const slotW = r * 2 + gap;
  const totalW = max * slotW - gap;
  const ms = nextRegenMs();

  let timerW = 0;
  if (ms != null) {
    ctx.font = `bold 11px ${UI.fontDisplayCJK}`;
    timerW = ctx.measureText(formatMs(ms)).width + 8;
  }
  const heartsRightX = rightX - timerW;
  const heartsLeftX = heartsRightX - totalW;
  for (let i = 0; i < max; i++) {
    const cx = heartsLeftX + i * slotW + r;
    if (i < lives) {
      ctx.fillStyle = UI.heartFill;
      drawHeart(cx, midY, r, true);
    } else {
      ctx.strokeStyle = UI.heartEmpty;
      ctx.lineWidth = 1.4;
      drawHeart(cx, midY, r, false);
    }
  }
  if (ms != null) {
    ctx.fillStyle = UI.textSecondary;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.font = `bold 11px ${UI.fontDisplayCJK}`;
    ctx.fillText(formatMs(ms), rightX, midY + 1);
  }
}

function drawLevelPill(leftX: number, midY: number): void {
  const h = 30;
  const r = h / 2;
  const y = midY - h / 2;
  // Pre-measure text to size pill to content + padding.
  const idx = `${levelIndex + 1}`;
  const tot = `/ ${ORDERED_KEYS.length}`;
  ctx.font = `bold 16px ${UI.fontDisplayCJK}`;
  const idxW = ctx.measureText(idx).width;
  ctx.font = `12px ${UI.fontDisplayCJK}`;
  const totW = ctx.measureText(tot).width;
  const lvCapsW = 22;
  const padL = 14;
  const padR = 14;
  const innerGap = 6;
  const w = padL + lvCapsW + innerGap + idxW + 4 + totW + padR;

  // Body fill + subtle border.
  roundRectPath(leftX, y, w, h, r);
  ctx.fillStyle = UI.chipBg;
  ctx.fill();
  ctx.strokeStyle = UI.chipBorder;
  ctx.lineWidth = 1;
  ctx.stroke();

  // Gold accent stripe on the left edge (3px tall band inside the pill).
  ctx.fillStyle = UI.textGold;
  ctx.fillRect(leftX + 4, y + 7, 3, h - 14);

  // "LV" small caps in gold.
  ctx.fillStyle = UI.textGold;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.font = `bold 10px ${UI.fontDisplayCJK}`;
  ctx.fillText("LV", leftX + padL, midY - 1);

  // Current level number in bold cream.
  ctx.fillStyle = UI.textPrimary;
  ctx.font = `bold 16px ${UI.fontDisplayCJK}`;
  ctx.fillText(idx, leftX + padL + lvCapsW + innerGap, midY);

  // Total in muted grey.
  ctx.fillStyle = UI.textSecondary;
  ctx.font = `12px ${UI.fontDisplayCJK}`;
  ctx.fillText(tot, leftX + padL + lvCapsW + innerGap + idxW + 4, midY + 1);
}

type HudButton = "prev" | "hint" | "reset" | "undo" | "next";
const HUD_BUTTON_ORDER: HudButton[] = ["prev", "hint", "reset", "undo", "next"];
const HUD_BUTTON_LABEL: Record<HudButton, string> = {
  prev: "‹ 上一",
  hint: "提示",
  reset: "重开",
  undo: "撤销",
  next: "下一 ›",
};

function drawHud(): void {
  // 1) Single dark band across the full HUD chrome — including the area
  //    behind the platform capsule (×, ...) so the capsule reads as part
  //    of the bar instead of floating on top of the board.
  ctx.fillStyle = UI.hudBg;
  ctx.fillRect(0, 0, cssW, hudBottom);

  // 2) Hairline right below the safe-top — separates platform capsule from
  //    the in-game HUD content visually.
  ctx.strokeStyle = UI.hudHairline;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, safeTop + 0.5);
  ctx.lineTo(cssW, safeTop + 0.5);
  ctx.stroke();

  // 3) Row 1 — level pill (LEFT) + hearts row (RIGHT). Both anchored to
  //    opposite edges so they never collide on narrow screens.
  drawLevelPill(12, row1MidY);
  drawHeartsRight(cssW - 12, row1MidY);

  // 4) Row 2 — resource counters (LEFT) | status (CENTER) | gear (RIGHT).
  //    Status is the only centred element; counters and gear are anchored
  //    to the edges with hard padding so center never gets crowded.
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.fillStyle = UI.hintGold;
  ctx.font = `bold 12px ${UI.fontDisplayCJK}`;
  const hintLabel = `💡 ${progress.hints}`;
  ctx.fillText(hintLabel, 12, row2MidY);
  const hintW = ctx.measureText(hintLabel).width;
  ctx.fillStyle = UI.coinGold;
  ctx.fillText(`🪙 ${progress.coins}`, 12 + hintW + 14, row2MidY);

  ctx.textAlign = "center";
  if (game) {
    const remaining = game.arrows.filter((a) => !a.escaped).length;
    if (game.status === "won") {
      ctx.fillStyle = UI.statusWon;
      ctx.font = `bold 13px ${UI.fontDisplayCJK}`;
      ctx.fillText("通关 ✓", cssW / 2, row2MidY);
    } else {
      ctx.fillStyle = UI.textPrimary;
      ctx.font = `bold 13px ${UI.fontDisplayCJK}`;
      ctx.fillText(`剩余 ${remaining}/${game.arrows.length}`, cssW / 2, row2MidY);
    }
  } else if (loadingKey != null) {
    ctx.fillStyle = UI.textSecondary;
    ctx.font = `12px ${UI.fontDisplayCJK}`;
    ctx.fillText("加载中…", cssW / 2, row2MidY);
  }

  const gearR = 11;
  const gearCX = cssW - 12 - gearR;
  drawGearIcon(gearCX, row2MidY, gearR);
  gearHitbox = { x: gearCX - gearR - 4, y: row2MidY - gearR - 4, w: gearR * 2 + 8, h: gearR * 2 + 8 };

  // 5) Hairline above button row (cool slate), then accent gold rule at
  //    the bottom of the HUD to visually separate chrome from the board.
  ctx.strokeStyle = UI.hudHairline;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, btnTopY + 0.5);
  ctx.lineTo(cssW, btnTopY + 0.5);
  ctx.stroke();

  // 6) Button row — ghost buttons; the only color is on the hint label
  //    (gold) and on the active-hint state (warm dark backdrop). Vertical
  //    hairlines are inset 4px top/bottom so the row reads as separators,
  //    not as a grid.
  const btnW = cssW / 5;
  ctx.font = `bold 13px ${UI.fontDisplayCJK}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (let i = 0; i < 5; i++) {
    const btn = HUD_BUTTON_ORDER[i]!;
    const enabled = isHudButtonEnabled(btn);
    const x = i * btnW;

    if (btn === "hint" && hintBusy) {
      ctx.fillStyle = UI.btnHintActiveBg;
      ctx.fillRect(x, btnTopY + 1, btnW, HUD_BTN_H - 1);
    }

    if (i > 0) {
      ctx.strokeStyle = UI.btnDivider;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, btnTopY + 6);
      ctx.lineTo(x + 0.5, hudBottom - 6);
      ctx.stroke();
    }

    let fg = UI.btnText;
    if (!enabled) fg = UI.btnTextDisabled;
    else if (btn === "hint" && hintBusy) fg = UI.btnHintActiveText;
    else if (btn === "hint") fg = UI.textGold;
    ctx.fillStyle = fg;
    ctx.fillText(HUD_BUTTON_LABEL[btn], x + btnW / 2, btnMidY);
  }

  // 7) Bottom accent rule — thin gold line marks the boundary between HUD
  //    chrome and the puzzle board.
  ctx.strokeStyle = UI.ruleAccent;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, hudBottom - 0.5);
  ctx.lineTo(cssW, hudBottom - 0.5);
  ctx.stroke();
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

// Shared modal card chrome: backdrop dim, rounded card, title eyebrow,
// title, body lines, primary CTA, secondary close.
function drawModalCard(
  cardW: number,
  cardH: number,
  eyebrow: string,
  title: string,
): { cardX: number; cardY: number } {
  ctx.fillStyle = UI.modalBackdrop;
  ctx.fillRect(0, 0, cssW, cssH);

  const cardX = (cssW - cardW) / 2;
  const cardY = (cssH - cardH) / 2;

  // Card body — rounded, with a thin top accent rule in gold.
  roundRectPath(cardX, cardY, cardW, cardH, 16);
  ctx.fillStyle = UI.modalCardBg;
  ctx.fill();
  ctx.strokeStyle = UI.modalCardBorder;
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.strokeStyle = UI.modalAccent;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cardX + 22, cardY + 14);
  ctx.lineTo(cardX + 56, cardY + 14);
  ctx.stroke();

  // Eyebrow — small caps gold, above title.
  ctx.fillStyle = UI.modalAccent;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `bold 10px ${UI.fontDisplayCJK}`;
  ctx.fillText(eyebrow, cardX + cardW / 2, cardY + 32);

  // Title.
  ctx.fillStyle = UI.modalTitle;
  ctx.font = `bold 19px ${UI.fontDisplayCJK}`;
  ctx.fillText(title, cardX + cardW / 2, cardY + 58);

  return { cardX, cardY };
}

function drawPrimaryCta(x: number, y: number, w: number, h: number, label: string): void {
  roundRectPath(x, y, w, h, 10);
  ctx.fillStyle = UI.ctaPrimaryBg;
  ctx.fill();
  ctx.fillStyle = UI.ctaPrimaryText;
  ctx.font = `bold 15px ${UI.fontDisplayCJK}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, x + w / 2, y + h / 2);
}

function drawSecondaryCta(x: number, y: number, w: number, h: number, label: string): void {
  roundRectPath(x, y, w, h, 10);
  ctx.strokeStyle = UI.ctaSecondaryBorder;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = UI.ctaSecondaryText;
  ctx.font = `14px ${UI.fontDisplayCJK}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, x + w / 2, y + h / 2);
}

function drawNoLivesOverlay(): NoLivesHitbox {
  const cardW = Math.min(330, cssW - 40);
  const cardH = 268;
  const { cardX, cardY } = drawModalCard(cardW, cardH, "ENERGY", "心已用光");

  ctx.fillStyle = UI.modalBody;
  ctx.font = `13px ${UI.fontDisplayCJK}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("等待心数自动恢复，或观看广告 +1 心", cardX + cardW / 2, cardY + 88);

  tickLives();
  const ms = nextRegenMs();
  ctx.fillStyle = UI.modalAccent;
  ctx.font = `bold 28px ${UI.fontDisplayCJK}`;
  ctx.fillText(ms == null ? "已恢复" : formatMs(ms), cardX + cardW / 2, cardY + 130);

  const btnW = cardW - 40;
  const btnH = 44;
  const adX = cardX + (cardW - btnW) / 2;
  const adY = cardY + 160;
  drawPrimaryCta(adX, adY, btnW, btnH, "看广告 +1 心");

  const closeY = adY + btnH + 10;
  drawSecondaryCta(adX, closeY, btnW, btnH, "稍后再来");

  return {
    ad: { x: adX, y: adY, w: btnW, h: btnH },
    close: { x: adX, y: closeY, w: btnW, h: btnH },
  };
}

function drawNoHintsOverlay(): NoHintsHitbox {
  const cardW = Math.min(330, cssW - 40);
  const cardH = 248;
  const { cardX, cardY } = drawModalCard(cardW, cardH, "HINT", "提示已用完");

  ctx.fillStyle = UI.modalBody;
  ctx.font = `13px ${UI.fontDisplayCJK}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(`看一段广告补 ${HINT_AD_REFILL} 次提示`, cardX + cardW / 2, cardY + 90);
  ctx.fillText(`额外赠送 ${COIN_PER_AD} 金币`, cardX + cardW / 2, cardY + 112);

  const btnW = cardW - 40;
  const btnH = 44;
  const adX = cardX + (cardW - btnW) / 2;
  const adY = cardY + 140;
  drawPrimaryCta(adX, adY, btnW, btnH, `看广告 +${HINT_AD_REFILL} 提示`);

  const closeY = adY + btnH + 10;
  drawSecondaryCta(adX, closeY, btnW, btnH, "稍后再来");

  return {
    ad: { x: adX, y: adY, w: btnW, h: btnH },
    close: { x: adX, y: closeY, w: btnW, h: btnH },
  };
}

function drawSettingsOverlay(): SettingsHitbox {
  const cardW = Math.min(330, cssW - 40);
  const cardH = 278;
  const { cardX, cardY } = drawModalCard(cardW, cardH, "SETTINGS", "设置");

  const rowW = cardW - 40;
  const rowH = 48;
  const rowX = cardX + (cardW - rowW) / 2;

  const drawRow = (y: number, label: string, on: boolean): RectHit => {
    roundRectPath(rowX, y, rowW, rowH, 10);
    ctx.fillStyle = "#1a1820";
    ctx.fill();
    ctx.fillStyle = UI.modalTitle;
    ctx.font = `14px ${UI.fontDisplayCJK}`;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(label, rowX + 14, y + rowH / 2);

    const knobW = 50;
    const knobH = 26;
    const knobX = rowX + rowW - knobW - 12;
    const knobY = y + (rowH - knobH) / 2;
    roundRectPath(knobX, knobY, knobW, knobH, knobH / 2);
    ctx.fillStyle = on ? UI.switchOn : UI.switchOff;
    ctx.fill();
    const dotR = (knobH - 6) / 2;
    const dotCX = on ? knobX + knobW - dotR - 3 : knobX + dotR + 3;
    ctx.fillStyle = UI.switchKnob;
    ctx.beginPath();
    ctx.arc(dotCX, knobY + knobH / 2, dotR, 0, Math.PI * 2);
    ctx.fill();
    ctx.textAlign = "center";
    return { x: rowX, y, w: rowW, h: rowH };
  };

  const sfxBox = drawRow(cardY + 86, "音效", progress.settings.sfx);
  const vibBox = drawRow(cardY + 86 + rowH + 12, "震动反馈", progress.settings.vibrate);

  const btnH = 44;
  const closeY = cardY + cardH - btnH - 16;
  drawSecondaryCta(rowX, closeY, rowW, btnH, "关闭");

  return {
    sfx: sfxBox,
    vibrate: vibBox,
    close: { x: rowX, y: closeY, w: rowW, h: btnH },
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
  ctx.fillStyle = "rgba(12, 17, 28, 0.78)";
  ctx.fillRect(0, boardTop, cssW, boardH);
  ctx.fillStyle = UI.modalAccent;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `bold 11px ${UI.fontDisplayCJK}`;
  ctx.fillText("LOADING", cssW / 2, boardTop + boardH / 2 - 22);
  ctx.fillStyle = UI.textPrimary;
  ctx.font = `bold ${Math.floor(Math.min(cssW, cssH) * 0.052)}px ${UI.fontDisplayCJK}`;
  const dots = ".".repeat(1 + (Math.floor(performance.now() / 350) % 3));
  ctx.fillText(`加载关卡${dots}`, cssW / 2, boardTop + boardH / 2 + 4);
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
  // Full-screen warm-charcoal canvas.
  ctx.fillStyle = UI.hudBg;
  ctx.fillRect(0, 0, cssW, cssH);

  const cx = cssW / 2;
  const titleY = safeTop + Math.max(80, cssH * 0.18);

  // Small caps eyebrow above the title — bold gold "PUZZLE".
  ctx.fillStyle = UI.modalAccent;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `bold 11px ${UI.fontDisplayCJK}`;
  ctx.fillText("ARROW · PUZZLE", cx, titleY - 38);

  // Two thin gold accent rules flanking the eyebrow add an editorial feel.
  ctx.strokeStyle = UI.modalAccent;
  ctx.lineWidth = 1;
  const eyebrowW = ctx.measureText("ARROW · PUZZLE").width;
  ctx.beginPath();
  ctx.moveTo(cx - eyebrowW / 2 - 14, titleY - 38);
  ctx.lineTo(cx - eyebrowW / 2 - 28, titleY - 38);
  ctx.moveTo(cx + eyebrowW / 2 + 14, titleY - 38);
  ctx.lineTo(cx + eyebrowW / 2 + 28, titleY - 38);
  ctx.stroke();

  // Title.
  ctx.fillStyle = UI.modalTitle;
  ctx.font = `bold ${Math.floor(Math.min(cssW, 480) * 0.13)}px ${UI.fontDisplayCJK}`;
  ctx.fillText("箭路脱困", cx, titleY);

  // Subtitle.
  ctx.fillStyle = UI.textSecondary;
  ctx.font = `13px ${UI.fontDisplayCJK}`;
  ctx.fillText("休闲益智 · 箭头脱困谜题", cx, titleY + 42);

  // Health advisory block.
  const advisoryY = titleY + 118;
  ctx.fillStyle = UI.modalAccent;
  ctx.font = `bold 10px ${UI.fontDisplayCJK}`;
  ctx.fillText("健 康 游 戏 忠 告", cx, advisoryY);
  ctx.fillStyle = UI.textPrimary;
  ctx.font = `12px ${UI.fontDisplayCJK}`;
  for (let i = 0; i < HEALTH_ADVISORY_LINES.length; i++) {
    ctx.fillText(HEALTH_ADVISORY_LINES[i]!, cx, advisoryY + 26 + i * 19);
  }

  // Age notice — mint green to signal "official".
  const ageY = advisoryY + 26 + HEALTH_ADVISORY_LINES.length * 19 + 24;
  ctx.fillStyle = UI.statusWon;
  ctx.font = `bold 13px ${UI.fontDisplayCJK}`;
  ctx.fillText(AGE_NOTICE, cx, ageY);

  // Start button — solid coral CTA, rounded.
  const btnW = Math.min(240, cssW - 64);
  const btnH = 52;
  const btnX = (cssW - btnW) / 2;
  const btnY = Math.min(cssH - btnH - 40, ageY + 64);
  roundRectPath(btnX, btnY, btnW, btnH, 12);
  ctx.fillStyle = UI.ctaPrimaryBg;
  ctx.fill();
  ctx.fillStyle = UI.ctaPrimaryText;
  ctx.font = `bold 18px ${UI.fontDisplayCJK}`;
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
