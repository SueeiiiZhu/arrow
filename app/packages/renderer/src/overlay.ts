import type { DrawCtx } from "./canvas-ctx.js";

export interface OverlayHitbox {
  next: { x: number; y: number; w: number; h: number };
}

/**
 * Full-screen win overlay drawn on top of the board:
 *   - Semi-transparent backdrop fading in
 *   - Centered "通关！" title
 *   - Eight stars bursting from the title position
 *   - Centered "下一关 ▶" button
 * Returns the button hitbox so the input layer can dispatch taps.
 *
 * `phase` is seconds since the win event. 0..0.6s is the intro animation;
 * past 0.6s the overlay is steady-state.
 */
export function drawWinOverlay(
  ctx: DrawCtx,
  canvasW: number,
  canvasH: number,
  phase: number,
): OverlayHitbox {
  const intro = Math.max(0, Math.min(1, phase / 0.6));
  const burst = Math.max(0, Math.min(1, phase / 0.45));

  // backdrop
  ctx.globalAlpha = intro * 0.78;
  ctx.fillStyle = "#0f172a";
  ctx.fillRect(0, 0, canvasW, canvasH);
  ctx.globalAlpha = 1;

  const cx = canvasW / 2;
  const cy = canvasH / 2;
  const minSide = Math.min(canvasW, canvasH);
  const titleY = cy - canvasH * 0.08;

  // star burst — 8 four-point stars expanding outward
  const r = minSide * 0.4 * burst;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + intro * 0.3;
    const sx = cx + Math.cos(a) * r;
    const sy = titleY + Math.sin(a) * r;
    const size = minSide * 0.04 * (1 - burst * 0.5) * intro;
    if (size > 0.5) drawStar(ctx, sx, sy, size, "#fbbf24");
  }

  // title
  ctx.globalAlpha = intro;
  ctx.fillStyle = "#22c55e";
  const titleSize = Math.floor(minSide * 0.13);
  ctx.font = `bold ${titleSize}px -apple-system, "PingFang SC", sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("通关！", cx, titleY);
  ctx.globalAlpha = 1;

  // button (only after the intro completes — feels less rushed)
  const btnW = Math.min(canvasW * 0.55, 300);
  const btnH = 56;
  const btnX = cx - btnW / 2;
  const btnY = cy + canvasH * 0.06;
  const btnAlpha = Math.max(0, Math.min(1, (phase - 0.35) / 0.25));
  ctx.globalAlpha = btnAlpha;
  ctx.fillStyle = "#3b82f6";
  ctx.fillRect(btnX, btnY, btnW, btnH);
  ctx.fillStyle = "#fff";
  ctx.font = `bold 20px -apple-system, "PingFang SC", sans-serif`;
  ctx.fillText("下一关 ▶", cx, btnY + btnH / 2);
  ctx.globalAlpha = 1;

  return { next: { x: btnX, y: btnY, w: btnW, h: btnH } };
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

export function hitTestOverlay(hit: OverlayHitbox, x: number, y: number): "next" | null {
  const n = hit.next;
  if (x >= n.x && x <= n.x + n.w && y >= n.y && y <= n.y + n.h) return "next";
  return null;
}
