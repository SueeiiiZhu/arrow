import {
  type CompactLevel,
  createGame,
  decodeCompact,
  ensureShuffleSeed,
  findArrowAt,
  type GameState,
  loadLevel,
  loadProgress,
  type Progress,
  type ProgressStorage,
  resetGame,
  saveProgress,
  shuffleByDifficulty,
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
// wxgame CJS host.
declare const require: (path: string) => unknown;
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
            runtimeRequire(`./pack${packIdx}/index.js`);
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

let levelIndex = 0;
let game: GameState | null = null;
let loadingKey: string | null = null;

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
      noLivesOpen
    ) {
      rafId = requestAnimationFrame(step);
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
    const t = fitView(game.level, cssW, cssH - 56);
    const view2 = { ...t, oy: t.oy + 56 };
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
    drawGame(ctx as any, game, view2, {
      showPaths: false,
      progressOverride,
      shakeOffsets,
      drawEscapedIds,
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

function drawHud(): void {
  ctx.fillStyle = "#0f172a";
  ctx.fillRect(0, 0, cssW, 56);
  ctx.fillStyle = "#e2e8f0";
  ctx.font = "16px sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  const key = ORDERED_KEYS[levelIndex] ?? "";
  const name = key.replace(/^\d+__/, "").replace(/\.json$/, "");
  ctx.fillText(`${levelIndex + 1}/${ORDERED_KEYS.length}  ${name}`, 12, 28);

  drawHearts(cssW / 2, 28);

  if (game) {
    const remaining = game.arrows.filter((a) => !a.escaped).length;
    ctx.textAlign = "right";
    ctx.fillStyle = game.status === "won" ? "#22c55e" : "#e2e8f0";
    ctx.font = "16px sans-serif";
    ctx.fillText(
      game.status === "won" ? "通关！" : `剩余 ${remaining}/${game.arrows.length}`,
      cssW - 12,
      28,
    );
  } else if (loadingKey != null) {
    ctx.textAlign = "right";
    ctx.fillStyle = "#94a3b8";
    ctx.font = "16px sans-serif";
    ctx.fillText("加载中...", cssW - 12, 28);
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
  ctx.fillRect(0, 56, cssW, cssH - 56);
  ctx.fillStyle = "#e2e8f0";
  ctx.font = `${Math.floor(Math.min(cssW, cssH) * 0.06)}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const dots = ".".repeat(1 + (Math.floor(performance.now() / 350) % 3));
  ctx.fillText(`加载关卡${dots}`, cssW / 2, cssH / 2);
}

// --- input ----------------------------------------------------------------

function hitHud(x: number, y: number): "prev" | "next" | "reset" | null {
  if (y > 56) return null;
  if (x < cssW * 0.25) return "prev";
  if (x > cssW * 0.75) return "next";
  if (x > cssW * 0.4 && x < cssW * 0.6) return "reset";
  return null;
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
  if (hud === "prev") {
    selectLevelByIndex(levelIndex - 1);
    return;
  }
  if (hud === "next") {
    selectLevelByIndex(levelIndex + 1);
    return;
  }
  if (hud === "reset") {
    if (!game) return;
    if (!tryConsumeLife()) {
      noLivesOpen = true;
      ensureRAF();
      render();
      return;
    }
    resetGame(game);
    clearAnimations();
    winStart = null;
    render();
    return;
  }

  if (!game || isAnimating()) return;
  const view = fitView(game.level, cssW, cssH - 56);
  const view2 = { ...view, oy: view.oy + 56 };
  const cell = pickCell(px, py, view2);
  if (cell.x < 0 || cell.y < 0 || cell.x >= game.level.width || cell.y >= game.level.height) {
    return;
  }
  const arrow = findArrowAt(game, cell);
  if (!arrow) return;
  const before = arrow.progress;
  const r = tryPull(game, arrow.id);
  const after = arrow.progress;
  if (r.steps > 0) {
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

// --- bootstrap ------------------------------------------------------------

// Restore last-played level if it's known; else level 0.
const restoreIdx = progress.lastKey ? ORDERED_KEYS.indexOf(progress.lastKey) : -1;
selectLevelByIndex(restoreIdx >= 0 ? restoreIdx : 0);

// Surface PACK_COUNT for inspection in devtools.
void PACK_COUNT;
