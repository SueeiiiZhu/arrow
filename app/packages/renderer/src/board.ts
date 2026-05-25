import { bodyCellsAt, type GameState, type LevelData, type Vec2 } from "@ea/core";
import type { DrawCtx } from "./canvas-ctx.js";
import { colorFor } from "./palette.js";

export interface ViewTransform {
  /** size of a single grid cell in pixels */
  cell: number;
  /** top-left offset of the board on the canvas */
  ox: number;
  oy: number;
}

export function fitView(
  level: LevelData,
  canvasW: number,
  canvasH: number,
  margin = 16,
): ViewTransform {
  const usableW = canvasW - margin * 2;
  const usableH = canvasH - margin * 2;
  const cell = Math.max(4, Math.floor(Math.min(usableW / level.width, usableH / level.height)));
  const boardW = cell * level.width;
  const boardH = cell * level.height;
  return {
    cell,
    ox: Math.floor((canvasW - boardW) / 2),
    oy: Math.floor((canvasH - boardH) / 2),
  };
}

export function cellCenter(v: Vec2, t: ViewTransform): { cx: number; cy: number } {
  return {
    cx: t.ox + (v.x + 0.5) * t.cell,
    cy: t.oy + (v.y + 0.5) * t.cell,
  };
}

/** Inverse of cellCenter — map a canvas point back to a grid cell. */
export function pickCell(px: number, py: number, t: ViewTransform): Vec2 {
  return {
    x: Math.floor((px - t.ox) / t.cell),
    y: Math.floor((py - t.oy) / t.cell),
  };
}

export interface DrawOptions {
  background: string;
  gridLine: string;
  maskFill: string;
  gridLineWidth: number;
  showPaths: boolean;
  highlightArrowId: number | null;
  /** 0..1 alpha multiplier for the highlight halo. Lets the caller pulse it via rAF. */
  highlightPulse: number;
  /** override an arrow's effective progress (used for animation). */
  progressOverride: Map<number, number> | null;
  /** per-arrow pixel offset added during rendering (for shake feedback). */
  shakeOffsets: Map<number, { dx: number; dy: number }> | null;
  /** keep drawing escaped arrows whose id appears in this set. */
  drawEscapedIds: Set<number> | null;
}

export const defaultOptions: DrawOptions = {
  background: "#0f172a",
  gridLine: "#1e293b",
  maskFill: "#152033",
  gridLineWidth: 1,
  showPaths: false,
  highlightArrowId: null,
  highlightPulse: 1,
  progressOverride: null,
  shakeOffsets: null,
  drawEscapedIds: null,
};

/** Static view: full paths and arrows in their initial positions. */
export function drawLevel(
  ctx: DrawCtx,
  level: LevelData,
  t: ViewTransform,
  opts: Partial<DrawOptions> = {},
): void {
  const o = { ...defaultOptions, ...opts };
  paintBackground(ctx, o);
  paintLevelMask(ctx, level, t, o);
  paintGrid(ctx, level, t, o);

  for (let i = 0; i < level.arrows.length; i++) {
    const a = level.arrows[i]!;
    const color = colorFor(i);
    if (o.showPaths) drawPath(ctx, a.path, t, color, 0.18);
    drawArrowGlyph(ctx, a.start, a.facing, t, color);
  }
}

/** Live view: render arrows at their current progress, mask + grid below. */
export function drawGame(
  ctx: DrawCtx,
  game: GameState,
  t: ViewTransform,
  opts: Partial<DrawOptions> = {},
): void {
  const o = { ...defaultOptions, ...opts };
  paintBackground(ctx, o);
  paintLevelMask(ctx, game.level, t, o);
  paintGrid(ctx, game.level, t, o);

  for (let i = 0; i < game.arrows.length; i++) {
    const arrow = game.arrows[i]!;
    if (arrow.escaped && !o.drawEscapedIds?.has(arrow.id)) {
      continue;
    }
    const color = colorFor(arrow.id);
    const k = o.progressOverride?.get(arrow.id) ?? arrow.progress;
    const f = arrow.data.facing;
    const body = bodyCellsAt(arrow.data, k);
    const headPos: Vec2 = body[0]!;
    const tailPos: Vec2 = body[body.length - 1]!;

    const shake = o.shakeOffsets?.get(arrow.id);
    if (shake) {
      ctx.save();
      ctx.translate(shake.dx, shake.dy);
    }

    if (o.showPaths) drawPath(ctx, arrow.data.path, t, color, 0.12);

    const hinted = o.highlightArrowId === arrow.id;
    if (hinted) drawHintHalo(ctx, body, t, o.highlightPulse);
    drawBody(ctx, body, t, color, hinted);
    drawTailCap(ctx, tailPos, t, color);
    drawArrowGlyph(ctx, headPos, f, t, color);

    if (shake) ctx.restore();
  }
}

function paintBackground(ctx: DrawCtx, o: DrawOptions): void {
  ctx.fillStyle = o.background;
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
}

function paintLevelMask(ctx: DrawCtx, level: LevelData, t: ViewTransform, o: DrawOptions): void {
  const seen = new Set<string>();
  ctx.fillStyle = o.maskFill;
  for (const arrow of level.arrows) {
    for (const c of arrow.path) {
      const key = `${c.x},${c.y}`;
      if (seen.has(key)) continue;
      seen.add(key);
      ctx.fillRect(t.ox + c.x * t.cell, t.oy + c.y * t.cell, t.cell, t.cell);
    }
  }
}

function paintGrid(ctx: DrawCtx, level: LevelData, t: ViewTransform, o: DrawOptions): void {
  ctx.strokeStyle = o.gridLine;
  ctx.lineWidth = o.gridLineWidth;
  ctx.beginPath();
  for (let x = 0; x <= level.width; x++) {
    ctx.moveTo(t.ox + x * t.cell + 0.5, t.oy);
    ctx.lineTo(t.ox + x * t.cell + 0.5, t.oy + level.height * t.cell);
  }
  for (let y = 0; y <= level.height; y++) {
    ctx.moveTo(t.ox, t.oy + y * t.cell + 0.5);
    ctx.lineTo(t.ox + level.width * t.cell, t.oy + y * t.cell + 0.5);
  }
  ctx.stroke();
}

function drawPath(
  ctx: DrawCtx,
  path: ReadonlyArray<Vec2>,
  t: ViewTransform,
  color: string,
  alpha: number,
): void {
  ctx.strokeStyle = color;
  ctx.globalAlpha = alpha;
  ctx.lineWidth = Math.max(2, t.cell * 0.35);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  for (let k = 0; k < path.length; k++) {
    const c = cellCenter(path[k]!, t);
    if (k === 0) ctx.moveTo(c.cx, c.cy);
    else ctx.lineTo(c.cx, c.cy);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function drawBody(
  ctx: DrawCtx,
  body: ReadonlyArray<Vec2>,
  t: ViewTransform,
  color: string,
  highlight: boolean,
): void {
  if (body.length === 0) return;
  ctx.strokeStyle = color;
  ctx.globalAlpha = highlight ? 1 : 0.92;
  ctx.lineWidth = Math.max(4, t.cell * 0.72);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  if (body.length === 1) {
    // single-cell body: dot of the same thickness as the stroke
    const c = cellCenter(body[0]!, t);
    ctx.moveTo(c.cx, c.cy);
    ctx.lineTo(c.cx, c.cy);
  } else {
    for (let k = 0; k < body.length; k++) {
      const c = cellCenter(body[k]!, t);
      if (k === 0) ctx.moveTo(c.cx, c.cy);
      else ctx.lineTo(c.cx, c.cy);
    }
  }
  ctx.stroke();
  ctx.globalAlpha = 1;
}

/**
 * Golden halo drawn behind the body when this arrow is the hint pick.
 * Two outset strokes of widening radius produce a soft glow without
 * shadowBlur (wxgame canvas doesn't support shadow* reliably).
 */
function drawHintHalo(
  ctx: DrawCtx,
  body: ReadonlyArray<Vec2>,
  t: ViewTransform,
  pulse: number,
): void {
  if (body.length === 0) return;
  const baseLW = Math.max(4, t.cell * 0.72);
  ctx.strokeStyle = "#fde047"; // amber-300
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (let pass = 0; pass < 2; pass++) {
    ctx.globalAlpha = pulse * (pass === 0 ? 0.35 : 0.6);
    ctx.lineWidth = baseLW + (pass === 0 ? t.cell * 0.55 : t.cell * 0.25);
    ctx.beginPath();
    if (body.length === 1) {
      const c = cellCenter(body[0]!, t);
      ctx.moveTo(c.cx, c.cy);
      ctx.lineTo(c.cx, c.cy);
    } else {
      for (let k = 0; k < body.length; k++) {
        const c = cellCenter(body[k]!, t);
        if (k === 0) ctx.moveTo(c.cx, c.cy);
        else ctx.lineTo(c.cx, c.cy);
      }
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

/** Rounded circle cap drawn at the tail cell (matches ArrowEnd.png). */
function drawTailCap(ctx: DrawCtx, pos: Vec2, t: ViewTransform, color: string): void {
  const { cx, cy } = cellCenter(pos, t);
  const r = t.cell * 0.36;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
}

/**
 * Filled, rounded-corner equilateral triangle pointing along `facing`.
 * Approximates the original ArrowHead.png cap that sits on the leading cell.
 */
export function drawArrowGlyph(
  ctx: DrawCtx,
  pos: Vec2,
  facing: Vec2,
  t: ViewTransform,
  color: string,
): void {
  const { cx, cy } = cellCenter(pos, t);
  const angle = Math.atan2(facing.y, facing.x);
  // Triangle dimensions in local frame (forward = +x).
  const fwd = t.cell * 0.58; // tip distance from cell center
  const back = t.cell * 0.3; // base distance behind cell center (overlaps body)
  const half = t.cell * 0.48; // half base width

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);

  // Stroke + fill with same color and a round join softens the three corners,
  // mimicking the rounded-triangle ArrowHead sprite without shipping the PNG.
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineWidth = t.cell * 0.16;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(fwd, 0);
  ctx.lineTo(-back, half);
  ctx.lineTo(-back, -half);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  ctx.restore();
}

/** Kept for back-compat with earlier static-render call sites. */
export const drawArrow = drawArrowGlyph;
