/**
 * Minimal Canvas 2D-compatible surface we depend on.
 * Browser HTMLCanvasElement.getContext('2d') and wx.createCanvas().getContext('2d')
 * both satisfy this shape, so renderer code stays platform-agnostic.
 */
export type LineCap = "butt" | "round" | "square";
export type LineJoin = "miter" | "round" | "bevel";
export type TextAlign = "start" | "end" | "left" | "right" | "center";
export type TextBaseline = "top" | "hanging" | "middle" | "alphabetic" | "ideographic" | "bottom";

export interface DrawCtx {
  canvas: { width: number; height: number };
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  lineCap: LineCap;
  lineJoin: LineJoin;
  font: string;
  textAlign: TextAlign;
  textBaseline: TextBaseline;
  globalAlpha: number;

  save(): void;
  restore(): void;
  translate(x: number, y: number): void;
  rotate(angle: number): void;
  scale(x: number, y: number): void;
  beginPath(): void;
  closePath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  rect(x: number, y: number, w: number, h: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  strokeRect(x: number, y: number, w: number, h: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  arc(x: number, y: number, r: number, a0: number, a1: number, ccw?: boolean): void;
  fill(): void;
  stroke(): void;
  fillText(text: string, x: number, y: number): void;
}
