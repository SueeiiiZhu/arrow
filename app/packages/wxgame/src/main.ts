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
const canvas = (GameGlobal.canvas ?? wx.createCanvas()) as WxCanvas;
canvas.width = Math.floor(sys.windowWidth * sys.pixelRatio);
canvas.height = Math.floor(sys.windowHeight * sys.pixelRatio);
const ctx = canvas.getContext("2d");
ctx.setTransform(sys.pixelRatio, 0, 0, sys.pixelRatio, 0, 0);

const cssW = sys.windowWidth;
const cssH = sys.windowHeight;

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

// --- game state ----------------------------------------------------------

// HUD is a 80-px tall bar at the top: y=0..56 holds the info row
// (level name | hearts | status), y=56..80 holds 5 button hit zones
// (prev / hint / reset / undo / next), each cssW/5 wide.
const HUD_H = 80;
const HUD_INFO_H = 56;
const HUD_BTN_H = HUD_H - HUD_INFO_H;

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
  start: number;
  dur: number;
  escapedAtEnd: boolean;
}
interface Shake {
  start: number;
  dur: number;
  ax: number;
  ay: number;
}
const tweens = new Map<number, Tween>();
const shakes = new Map<number, Shake>();
let rafId = 0;

function easeOutCubic(u: number): number {
  return 1 - (1 - u) ** 3;
}
function evalTween(tw: Tween, now: number): number {
  const u = Math.min(1, Math.max(0, (now - tw.start) / tw.dur));
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
function startShake(id: number, facing: { x: number; y: number }): void {
  shakes.set(id, {
    start: performance.now(),
    dur: 220,
    ax: facing.x,
    ay: facing.y,
  });
  ensureRAF();
}
function evalShake(sh: Shake, now: number, cell: number): { dx: number; dy: number } | null {
  const u = (now - sh.start) / sh.dur;
  if (u >= 1) return null;
  const amp = cell * 0.22 * (1 - u);
  const w = Math.sin(u * Math.PI * 5);
  return { dx: sh.ax * amp * w, dy: sh.ay * amp * w };
}
function ensureRAF(): void {
  if (rafId) return;
  const step = (): void => {
    rafId = 0;
    render();
    if (
      tweens.size > 0 ||
      shakes.size > 0 ||
      isWinAnimating() ||
      loadingKey != null ||
      noLivesOpen ||
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
  shakes.clear();
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

// --- win overlay ----------------------------------------------------------

let winStart: number | null = null;
let winHitbox: OverlayHitbox | null = null;
function isWinAnimating(): boolean {
  return winStart != null && performance.now() - winStart < 700;
}

// --- no-lives overlay -----------------------------------------------------

let noLivesOpen = false;
interface NoLivesHitbox {
  ad: { x: number; y: number; w: number; h: number };
  close: { x: number; y: number; w: number; h: number };
}
let noLivesHitbox: NoLivesHitbox | null = null;

// Replace with your own ad unit ID before submitting to mp.weixin.qq.com.
// `wx.createRewardedVideoAd` is absent in devtool / older clients — we then
// fall back to refilling 1 immediately so the flow is still exercisable.
const REWARDED_AD_UNIT_ID = "";

function tryAdRefill(): void {
  const create = wx.createRewardedVideoAd;
  if (!create || !REWARDED_AD_UNIT_ID) {
    addLives(1);
    noLivesOpen = false;
    ensureRAF();
    render();
    return;
  }
  const ad = create({ adUnitId: REWARDED_AD_UNIT_ID });
  const onClose = (e: { isEnded: boolean }): void => {
    if (e.isEnded) {
      addLives(1);
      noLivesOpen = false;
    }
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

// --- level selection ------------------------------------------------------

function selectLevelByIndex(i: number): void {
  if (i < 0 || i >= ORDERED_KEYS.length) return;
  const key = ORDERED_KEYS[i]!;
  levelIndex = i;
  loadingKey = key;
  game = null;
  clearAnimations();
  clearUndoStack();
  hintArrowId = null;
  hintBusy = false;
  winStart = null;
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
    })
    .catch(() => {
      if (loadingKey === key) {
        loadingKey = null;
        render();
      }
    });
}

// --- render ---------------------------------------------------------------

function render(): void {
  ctx.fillStyle = "#0b1220";
  ctx.fillRect(0, 0, cssW, cssH);

  if (game) {
    const t = fitView(game.level, cssW, cssH - HUD_H);
    const view2 = { ...t, oy: t.oy + HUD_H };
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
    const shakeOffsets = new Map<number, { dx: number; dy: number }>();
    for (const [id, sh] of shakes) {
      const off = evalShake(sh, now, view2.cell);
      if (!off) {
        shakes.delete(id);
        continue;
      }
      shakeOffsets.set(id, off);
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
      shakeOffsets,
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

  if (noLivesOpen) {
    noLivesHitbox = drawNoLivesOverlay();
  } else {
    noLivesHitbox = null;
  }
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
  // Info row
  ctx.fillStyle = "#0f172a";
  ctx.fillRect(0, 0, cssW, HUD_H);
  ctx.fillStyle = "#e2e8f0";
  ctx.font = "16px sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  const key = ORDERED_KEYS[levelIndex] ?? "";
  const name = key.replace(/^\d+__/, "").replace(/\.json$/, "");
  ctx.fillText(`${levelIndex + 1}/${ORDERED_KEYS.length}  ${name}`, 12, 24);

  drawHearts(cssW / 2, 24);

  if (game) {
    const remaining = game.arrows.filter((a) => !a.escaped).length;
    ctx.textAlign = "right";
    ctx.fillStyle = game.status === "won" ? "#22c55e" : "#e2e8f0";
    ctx.font = "16px sans-serif";
    ctx.fillText(
      game.status === "won" ? "通关！" : `剩余 ${remaining}/${game.arrows.length}`,
      cssW - 12,
      24,
    );
  } else if (loadingKey != null) {
    ctx.textAlign = "right";
    ctx.fillStyle = "#94a3b8";
    ctx.font = "16px sans-serif";
    ctx.fillText("加载中...", cssW - 12, 24);
  }

  // Button row — 5 evenly-spaced labels with a thin separator above.
  ctx.strokeStyle = "#1e293b";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, HUD_INFO_H + 0.5);
  ctx.lineTo(cssW, HUD_INFO_H + 0.5);
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
    ctx.fillRect(i * btnW, HUD_INFO_H, btnW, HUD_BTN_H);
    if (i > 0) {
      ctx.strokeStyle = "#1e293b";
      ctx.beginPath();
      ctx.moveTo(i * btnW + 0.5, HUD_INFO_H);
      ctx.lineTo(i * btnW + 0.5, HUD_H);
      ctx.stroke();
    }
    ctx.fillStyle = fg;
    ctx.fillText(HUD_BUTTON_LABEL[btn], i * btnW + btnW / 2, HUD_INFO_H + HUD_BTN_H / 2);
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

function pointInRect(
  px: number,
  py: number,
  r: { x: number; y: number; w: number; h: number },
): boolean {
  return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
}

function drawLoadingOverlay(): void {
  ctx.fillStyle = "rgba(15,23,42,0.72)";
  ctx.fillRect(0, HUD_H, cssW, cssH - HUD_H);
  ctx.fillStyle = "#e2e8f0";
  ctx.font = `${Math.floor(Math.min(cssW, cssH) * 0.06)}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const dots = ".".repeat(1 + (Math.floor(performance.now() / 350) % 3));
  ctx.fillText(`加载关卡${dots}`, cssW / 2, cssH / 2);
}

// --- input ----------------------------------------------------------------

function hitHud(x: number, y: number): HudButton | null {
  if (y < HUD_INFO_H || y > HUD_H) return null;
  const i = Math.floor(x / (cssW / 5));
  if (i < 0 || i > 4) return null;
  return HUD_BUTTON_ORDER[i]!;
}

wx.onTouchStart((e: WxTouchEvent) => {
  if (e.touches.length === 0) return;
  const t0 = e.touches[0]!;
  const px = t0.clientX;
  const py = t0.clientY;

  if (loadingKey != null) return;

  if (noLivesOpen && noLivesHitbox) {
    if (pointInRect(px, py, noLivesHitbox.ad)) {
      synth.click();
      tryAdRefill();
    } else if (pointInRect(px, py, noLivesHitbox.close)) {
      synth.click();
      noLivesOpen = false;
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
        noLivesOpen = true;
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
  const view = fitView(game.level, cssW, cssH - HUD_H);
  const view2 = { ...view, oy: view.oy + HUD_H };
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
    if (r.escaped) synth.escape();
    else synth.whoosh(r.steps);
  } else {
    startShake(arrow.id, arrow.data.facing);
    synth.thud();
  }
  if (r.won) {
    const key = ORDERED_KEYS[levelIndex]!;
    progress.completed.add(key);
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
  hintBusy = true;
  render();
  // Defer a frame so the "thinking…" highlight paints before solver blocks.
  setTimeout(() => {
    const moveId = game ? findNextMove(game, Date.now() + 1500) : null;
    hintBusy = false;
    if (moveId != null) {
      hintArrowId = moveId;
      hintStart = performance.now();
      ensureRAF();
    }
    render();
  }, 30);
}

// --- bootstrap ------------------------------------------------------------

// Restore last-played level if it's known; else level 0.
const restoreIdx = progress.lastKey ? ORDERED_KEYS.indexOf(progress.lastKey) : -1;
selectLevelByIndex(restoreIdx >= 0 ? restoreIdx : 0);

// Surface PACK_COUNT for inspection in devtools.
void PACK_COUNT;
