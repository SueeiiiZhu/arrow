import {
  createGame,
  findArrowAt,
  loadLevel,
  resetGame,
  tryPull,
  type GameState,
} from "@ea/core";
import { drawGame, fitView, pickCell } from "@ea/renderer";
import { BUNDLED_LEVELS } from "./levels.generated.js";

// wx-game entry: same rules + renderer as the H5 build; only the canvas
// and input acquisition differ.

const sys = wx.getSystemInfoSync();
const canvas = (GameGlobal.canvas ?? wx.createCanvas()) as WxCanvas;
canvas.width = Math.floor(sys.windowWidth * sys.pixelRatio);
canvas.height = Math.floor(sys.windowHeight * sys.pixelRatio);
const ctx = canvas.getContext("2d");
ctx.setTransform(sys.pixelRatio, 0, 0, sys.pixelRatio, 0, 0);

const cssW = sys.windowWidth;
const cssH = sys.windowHeight;

let levelIndex = 0;
let game: GameState | null = null;

// --- animation state (parity with web build) ---------------------------------

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
  return 1 - Math.pow(1 - u, 3);
}
function evalTween(tw: Tween, now: number): number {
  const u = Math.min(1, Math.max(0, (now - tw.start) / tw.dur));
  return tw.from + (tw.to - tw.from) * easeOutCubic(u);
}
function startTween(
  id: number,
  before: number,
  after: number,
  escapedAtEnd: boolean,
): void {
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
function evalShake(
  sh: Shake,
  now: number,
  cell: number,
): { dx: number; dy: number } | null {
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
    if (tweens.size > 0 || shakes.size > 0) {
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

function selectLevel(i: number): void {
  if (i < 0 || i >= BUNDLED_LEVELS.length) return;
  levelIndex = i;
  const entry = BUNDLED_LEVELS[i]!;
  game = createGame(loadLevel(entry.raw));
  clearAnimations();
  render();
}

function render(): void {
  if (!game) return;
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
  drawHud();
}

function drawHud(): void {
  ctx.fillStyle = "#0f172a";
  ctx.fillRect(0, 0, cssW, 56);
  ctx.fillStyle = "#e2e8f0";
  ctx.font = "16px sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  const entry = BUNDLED_LEVELS[levelIndex]!;
  const name = entry.key.replace(/^\d+__/, "").replace(/\.json$/, "");
  ctx.fillText(`${levelIndex + 1}/${BUNDLED_LEVELS.length}  ${name}`, 12, 28);

  if (game) {
    const remaining = game.arrows.filter((a) => !a.escaped).length;
    ctx.textAlign = "right";
    ctx.fillStyle = game.status === "won" ? "#22c55e" : "#e2e8f0";
    ctx.fillText(
      game.status === "won" ? "通关！" : `剩余 ${remaining}/${game.arrows.length}`,
      cssW - 12,
      28,
    );
  }
}

function hitHud(x: number, y: number): "prev" | "next" | "reset" | null {
  if (y > 56) return null;
  // Tap zones on the HUD bar
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

  const hud = hitHud(px, py);
  if (hud === "prev") {
    selectLevel(levelIndex - 1);
    return;
  }
  if (hud === "next") {
    selectLevel(levelIndex + 1);
    return;
  }
  if (hud === "reset") {
    if (game) {
      resetGame(game);
      clearAnimations();
      render();
    }
    return;
  }

  if (!game || game.status === "won" || isAnimating()) return;
  const view = fitView(game.level, cssW, cssH - 56);
  const view2 = { ...view, oy: view.oy + 56 };
  const cell = pickCell(px, py, view2);
  if (
    cell.x < 0 ||
    cell.y < 0 ||
    cell.x >= game.level.width ||
    cell.y >= game.level.height
  ) {
    return;
  }
  const arrow = findArrowAt(game, cell);
  if (!arrow) return;
  const before = arrow.progress;
  const r = tryPull(game, arrow.id);
  const after = arrow.progress;
  if (r.steps > 0) {
    startTween(arrow.id, before, after, r.escaped);
  } else {
    startShake(arrow.id, arrow.data.facing);
  }
  render();
});

selectLevel(0);
