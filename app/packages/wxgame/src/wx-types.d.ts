// Minimal type stubs for the wx.* mini-game API surface we touch.
// Sourced from the wx-game JS API reference; only what we call.

interface WxCanvas {
  width: number;
  height: number;
  getContext(type: "2d"): WxCanvasRenderingContext2D;
}

interface WxCanvasRenderingContext2D {
  canvas: { width: number; height: number };
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  lineCap: "butt" | "round" | "square";
  lineJoin: "miter" | "round" | "bevel";
  font: string;
  textAlign: "start" | "end" | "left" | "right" | "center";
  textBaseline: "top" | "hanging" | "middle" | "alphabetic" | "ideographic" | "bottom";
  globalAlpha: number;

  save(): void;
  restore(): void;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
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
  measureText(text: string): { width: number };
}

interface WxTouch {
  clientX: number;
  clientY: number;
  identifier: number;
}

interface WxTouchEvent {
  touches: WxTouch[];
  changedTouches: WxTouch[];
  timeStamp: number;
}

interface WxSystemInfo {
  windowWidth: number;
  windowHeight: number;
  pixelRatio: number;
  language?: string;
}

interface WxLoadSubpackageTask {
  onProgressUpdate?(cb: (e: { progress: number }) => void): void;
}

interface WxLoadSubpackageOpts {
  name: string;
  success?: () => void;
  fail?: (err: { errMsg: string }) => void;
  complete?: () => void;
}

interface WxAPI {
  createCanvas(): WxCanvas;
  getSystemInfoSync(): WxSystemInfo;
  onTouchStart(cb: (e: WxTouchEvent) => void): void;
  offTouchStart(cb: (e: WxTouchEvent) => void): void;
  getStorageSync(key: string): unknown;
  setStorageSync(key: string, value: unknown): void;
  removeStorageSync(key: string): void;
  // wxgame Web Audio (base library >= 2.19.0). Returns a WebAudioContext
  // whose shape matches the standard AudioContext closely enough that the
  // shared synth module (which uses the renderer's AudioContextLike) works.
  createWebAudioContext?(): unknown;
  // Subpackage loading. The subpackage's `entry` file (configured in
  // game.json) auto-executes on success.
  loadSubpackage(opts: WxLoadSubpackageOpts): WxLoadSubpackageTask;
  // Rewarded video ad (optional — only present when the developer has
  // configured an ad unit in mp.weixin.qq.com). We handle absence.
  createRewardedVideoAd?(opts: { adUnitId: string }): WxRewardedVideoAd;
  // Error handling
  onError?(cb: (error: string) => void): void;
  offError?(cb: (error: string) => void): void;
}

interface WxRewardedVideoAd {
  load(): Promise<void>;
  show(): Promise<void>;
  onLoad(cb: () => void): void;
  offLoad(cb: () => void): void;
  onError(cb: (e: { errMsg: string; errCode: number }) => void): void;
  offError(cb: (e: { errMsg: string; errCode: number }) => void): void;
  onClose(cb: (e: { isEnded: boolean }) => void): void;
  offClose(cb: (e: { isEnded: boolean }) => void): void;
  destroy(): void;
}

declare const wx: WxAPI;
declare const GameGlobal: {
  canvas?: WxCanvas;
};

// wx-game global timing primitives
declare function requestAnimationFrame(cb: (ts: number) => void): number;
declare function cancelAnimationFrame(id: number): void;
declare const performance: { now(): number };

// Console is available in wxgame runtime
declare const console: {
  log(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
};
