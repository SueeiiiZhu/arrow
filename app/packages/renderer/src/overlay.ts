import type { DrawCtx } from "./canvas-ctx.js";

export interface OverlayHitbox {
  next: { x: number; y: number; w: number; h: number };
}

/**
 * Full-screen win overlay drawn on top of the board.
 *
 * Layout: a single visual column centered on (cx, cy):
 *   1. Title "通关！" — scales in with an overshoot pop.
 *   2. Particle burst radiating from the title.
 *   3. Rounded "下一关 ▶" pill button — slides up + fades in last.
 *
 * `phase` is seconds since the win event; the layout reaches steady-state
 * around 0.8s. Returns the button hitbox so the input layer can dispatch
 * taps. Uses only the minimal DrawCtx surface (no shadows/gradients) so
 * the overlay renders identically on the wxgame canvas.
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

  // 1) Backdrop.
  ctx.globalAlpha = backdropP * 0.82;
  ctx.fillStyle = "#0b1220";
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

  // 3) Particle burst — alternating gold + magenta + emerald stars radiating
  //    out from the title position. Each particle eases out to its peak
  //    radius then fades.
  if (burstFade > 0.02) {
    const maxR = minSide * 0.46;
    const particles = 12;
    const palette = ["#fbbf24", "#f472b6", "#34d399"];
    for (let i = 0; i < particles; i++) {
      const a = (i / particles) * Math.PI * 2 + 0.18;
      const r = maxR * burstIn;
      const px = cx + Math.cos(a) * r;
      const py = titleY + Math.sin(a) * r;
      const sz = minSide * 0.028 * burstFade;
      if (sz < 0.6) continue;
      ctx.globalAlpha = burstFade;
      drawStar(ctx, px, py, sz, palette[i % palette.length]!);
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

function drawStar(ctx: DrawCtx, cx: number, cy: number, r: number, color: string): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  const points = 5;
  for (let i = 0; i < points * 2; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / points;
    const rad = i % 2 === 0 ? r : r * 0.45;
    const x = cx + Math.cos(a) * rad;
    const y = cy + Math.sin(a) * rad;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();
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
