import type { DrawCtx } from "./canvas-ctx.js";
import { colorFor } from "./palette.js";

export interface OverlayHitbox {
  next: { x: number; y: number; w: number; h: number };
}

/**
 * Full-screen win overlay drawn on top of the board.
 *
 * Particles are triangular arrow glyphs (same shape as the in-game arrow
 * head, rotated to fly outward) so the overlay speaks the same visual
 * language as the board. Colors come from `palette.colorFor` so the burst
 * matches the multi-color arrow set.
 */
export function drawWinOverlay(
  ctx: DrawCtx,
  canvasW: number,
  canvasH: number,
  phase: number,
): OverlayHitbox {
  const cx = canvasW / 2;
  const cy = canvasH / 2;
  const minSide = Math.min(canvasW, canvasH);

  // Eased timeline.
  const backdropP = easeOut(clamp01(phase / 0.25));
  const titleP = easeOutBack(clamp01((phase - 0.05) / 0.45));
  const burstIn = easeOut(clamp01((phase - 0.1) / 0.55));
  const burstFade = 1 - easeIn(clamp01((phase - 0.35) / 0.55));
  const btnP = easeOut(clamp01((phase - 0.45) / 0.35));

  // 1) Backdrop — matches the board background so the overlay feels like a
  //    dimmed continuation of the board, not a foreign panel.
  ctx.globalAlpha = backdropP * 0.82;
  ctx.fillStyle = "#0f172a";
  ctx.fillRect(0, 0, canvasW, canvasH);
  ctx.globalAlpha = 1;

  const titleY = cy - minSide * 0.10;
  const btnW = Math.min(Math.max(canvasW * 0.55, 220), 320);
  const btnH = Math.max(54, Math.round(minSide * 0.10));
  const btnTargetY = cy + minSide * 0.08;
  const btnY = btnTargetY + (1 - btnP) * minSide * 0.04;
  const btnX = cx - btnW / 2;

  // 2) Particle burst — small triangle arrows radiating outward. Angles,
  //    radii, and sizes use a stable hash-based jitter so the layout reads
  //    as a real burst (not a metronome wheel) without flickering between
  //    frames. Colors come from the in-game palette.
  if (burstFade > 0.02) {
    const maxR = minSide * 0.48;
    const particles = 16;
    for (let i = 0; i < particles; i++) {
      const angleJitter = (hash01(i * 3 + 1) - 0.5) * 0.48;
      const a = (i / particles) * Math.PI * 2 + angleJitter;
      const radiusScale = 0.55 + hash01(i * 3 + 2) * 0.55;
      const r = maxR * burstIn * radiusScale;
      const px = cx + Math.cos(a) * r;
      const py = titleY + Math.sin(a) * r;
      const sizeScale = 0.7 + hash01(i * 3 + 3) * 0.7;
      const sz = minSide * 0.030 * burstFade * sizeScale;
      if (sz < 1) continue;
      ctx.globalAlpha = burstFade;
      drawArrowParticle(ctx, px, py, a, sz, colorFor(i));
    }
    ctx.globalAlpha = 1;
  }

  // 3) Title — slate-50 on the dimmed backdrop. No halo behind it; the
  //    contrast against the dark backdrop is enough. A single-pixel shadow
  //    grounds the text without looking like a hand-drawn double stroke.
  if (titleP > 0.02) {
    ctx.save();
    ctx.translate(cx, titleY);
    ctx.scale(titleP, titleP);
    const titleSize = Math.floor(minSide * 0.14);
    ctx.font = `bold ${titleSize}px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.globalAlpha = clamp01(titleP);
    ctx.fillStyle = "rgba(0,0,0,0.45)";
    ctx.fillText("通关！", 1, 1 + cjkBaselineNudge(titleSize));
    ctx.fillStyle = "#f8fafc";
    ctx.fillText("通关！", 0, cjkBaselineNudge(titleSize));
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  // 4) Pill button — drop shadow + rounded body + centered label.
  if (btnP > 0.01) {
    ctx.globalAlpha = btnP;
    const radius = btnH / 2;
    // Shadow row, offset 3px down.
    fillRoundedRect(ctx, btnX, btnY + 3, btnW, btnH, radius, "rgba(0,0,0,0.35)");
    // Button body.
    fillRoundedRect(ctx, btnX, btnY, btnW, btnH, radius, "#10b981");

    // Label.
    const labelSize = Math.floor(btnH * 0.40);
    ctx.font = `bold ${labelSize}px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#ffffff";
    // The visual centre of CJK glyphs sits slightly above the metric middle
    // baseline; nudge a few percent down so the text reads as centred.
    ctx.fillText("下一关 ▶", cx, btnY + btnH / 2 + cjkBaselineNudge(labelSize));
    ctx.globalAlpha = 1;
  }

  return { next: { x: btnX, y: btnY, w: btnW, h: btnH } };
}

// Bold CJK glyphs render visually a touch high under textBaseline="middle"
// because the font's ascender is taller than its descender. Nudging the y by
// ~6% of the font size pulls the ink centre to the geometric centre, which
// is what the eye expects when "centring text inside a button".
function cjkBaselineNudge(fontSize: number): number {
  return Math.round(fontSize * 0.06);
}

// Deterministic [0, 1) pseudo-random from an integer seed. Used so per-frame
// particle jitter stays stable instead of flickering each redraw.
function hash01(n: number): number {
  let x = (n + 0x6d2b79f5) | 0;
  x = Math.imul(x ^ (x >>> 15), x | 1);
  x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
  return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
}

function fillRoundedRect(
  ctx: DrawCtx,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  fill: string,
): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.fillStyle = fill;
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
  ctx.fill();
}

// Same proportions as drawArrowGlyph in board.ts but parameterized by a
// single size so it can stand on its own (no ViewTransform needed).
function drawArrowParticle(
  ctx: DrawCtx,
  cx: number,
  cy: number,
  angle: number,
  size: number,
  color: string,
): void {
  const fwd = size;
  const back = size * 0.52;
  const half = size * 0.82;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineWidth = size * 0.28;
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

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

function easeOut(t: number): number {
  return 1 - (1 - t) * (1 - t);
}

function easeIn(t: number): number {
  return t * t;
}

function easeOutBack(t: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

export function hitTestOverlay(hit: OverlayHitbox, x: number, y: number): "next" | null {
  const n = hit.next;
  if (x >= n.x && x <= n.x + n.w && y >= n.y && y <= n.y + n.h) return "next";
  return null;
}
