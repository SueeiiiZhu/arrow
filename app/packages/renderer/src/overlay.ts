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

  // 2) Tight emerald halo behind the title — subtle, tints the area without
  // becoming the dominant element.
  if (backdropP > 0) {
    ctx.globalAlpha = backdropP * 0.18;
    ctx.fillStyle = "#10b981";
    fillCircle(ctx, cx, titleY, minSide * 0.22);
    ctx.globalAlpha = 1;
  }

  // 3) Particle burst — small triangle arrows radiating outward, each
  //    rotated to point along its travel direction. Colors come from the
  //    in-game palette so the burst looks like the level's arrows escaping
  //    together. Eases out to peak radius then fades.
  if (burstFade > 0.02) {
    const maxR = minSide * 0.46;
    const particles = 14;
    for (let i = 0; i < particles; i++) {
      const a = (i / particles) * Math.PI * 2 + 0.18;
      const r = maxR * burstIn;
      const px = cx + Math.cos(a) * r;
      const py = titleY + Math.sin(a) * r;
      const sz = minSide * 0.034 * burstFade;
      if (sz < 1) continue;
      ctx.globalAlpha = burstFade;
      drawArrowParticle(ctx, px, py, a, sz, colorFor(i));
    }
    ctx.globalAlpha = 1;
  }

  // 4) Title with scale-pop animation.
  if (titleP > 0.02) {
    ctx.save();
    ctx.translate(cx, titleY);
    const scale = titleP;
    ctx.scale(scale, scale);
    const titleSize = Math.floor(minSide * 0.14);
    ctx.font = `bold ${titleSize}px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.globalAlpha = clamp01(titleP);
    // Subtle dark shadow for contrast (drawn first, slightly offset).
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.fillText("通关！", 2, 3 + cjkBaselineNudge(titleSize));
    ctx.fillStyle = "#34d399";
    ctx.fillText("通关！", 0, cjkBaselineNudge(titleSize));
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  // 5) Pill button — drop shadow + rounded body + centered label.
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

function fillCircle(ctx: DrawCtx, cx: number, cy: number, r: number): void {
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
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
