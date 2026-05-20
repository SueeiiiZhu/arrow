// DEV-only playground for manually trying out reverse-generated levels.
// Loads JSON files from `packages/tools/generated/` (gitignored, clean-room
// output) and feeds them to the same render + input pipeline as `main.ts`.
//
// Reachable only via the Vite dev server (`pnpm dev:web` then
// `http://localhost:5173/dev-playground.html`). The prod `vite build` only
// emits `index.html`, so this entry never ships.
//
// Why this exists: solvability is verified at generation time, but "is
// this puzzle interesting to a human?" can only be answered by playing.
// Keeping the playground entirely separate from `index.html` / picker /
// progress storage / `levels_data/` keeps the legal hygiene rule visible
// (synthetic levels never touch the corpus pipeline).

import {
  createGame,
  findArrowAt,
  type GameState,
  loadLevel,
  type RawLevelFile,
  resetGame,
  tryPull,
  validateLevel,
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

// --- level entries ---------------------------------------------------------

const levelModules = import.meta.glob<RawLevelFile>("../../tools/generated/*.json", {
  eager: true,
  import: "default",
});

interface Entry {
  key: string;
  raw: RawLevelFile;
}

const entries: Entry[] = Object.entries(levelModules)
  .map(([path, raw]) => ({ key: path.split("/").pop() ?? path, raw }))
  .sort((a, b) => a.key.localeCompare(b.key));

// --- DOM refs --------------------------------------------------------------

const select = document.getElementById("level-select") as HTMLSelectElement;
const prevBtn = document.getElementById("prev-btn") as HTMLButtonElement;
const nextBtn = document.getElementById("next-btn") as HTMLButtonElement;
const resetBtn = document.getElementById("reset-btn") as HTMLButtonElement;
const showPathsBox = document.getElementById("show-paths") as HTMLInputElement;
const meta = document.getElementById("meta") as HTMLSpanElement;
const status = document.getElementById("status") as HTMLSpanElement;
const canvas = document.getElementById("board") as HTMLCanvasElement;

// Empty-state takeover: if `packages/tools/generated/` is empty, replace
// the canvas with a hint instead of staring at a blank purple screen.
if (entries.length === 0) {
  const main = document.querySelector("main") as HTMLElement;
  main.innerHTML = `
    <div class="empty-state">
      <div class="box">
        <strong>没有生成的关卡可玩。</strong><br><br>
        先跑一次生成器，把关卡写到 <code>packages/tools/generated/</code>：<br><br>
        <code>pnpm --filter @ea/tools generate:reverse -- --w=20 --h=20 --count=5 --seed=1 --out</code><br><br>
        然后刷新本页面即可。
      </div>
    </div>
  `;
  select.disabled = true;
  prevBtn.disabled = true;
  nextBtn.disabled = true;
  resetBtn.disabled = true;
  throw new Error("[dev-playground] no generated levels found; aborting setup");
}

const ctx = canvas.getContext("2d")!;

// --- animation state -------------------------------------------------------

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
    if (tweens.size > 0 || shakes.size > 0 || isWinAnimating()) {
      rafId = requestAnimationFrame(step);
    }
  };
  rafId = requestAnimationFrame(step);
}

function isAnimating(): boolean {
  return tweens.size > 0;
}

function isWinAnimating(): boolean {
  return winStart != null && performance.now() - winStart < 700;
}

function clearAnimations(): void {
  tweens.clear();
  shakes.clear();
}

// --- audio synthesis -------------------------------------------------------

const audioCtx: AudioContextLike | null = (() => {
  try {
    const Ctor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    return new Ctor() as unknown as AudioContextLike;
  } catch {
    return null;
  }
})();
const synth: Synth = makeSynth(audioCtx);

// --- win overlay state -----------------------------------------------------

let winStart: number | null = null;
let winHitbox: OverlayHitbox | null = null;

// --- game state ------------------------------------------------------------

let game: GameState | null = null;
let currentKey: string | null = null;

function dpr(): number {
  return Math.min(window.devicePixelRatio || 1, 2);
}

function viewSize(): { w: number; h: number } {
  const d = dpr();
  return { w: canvas.width / d, h: canvas.height / d };
}

function resize(): void {
  const d = dpr();
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.floor(rect.width * d);
  canvas.height = Math.floor(rect.height * d);
  ctx.setTransform(d, 0, 0, d, 0, 0);
  render();
}

function render(): void {
  if (!game) return;
  const { w, h } = viewSize();
  const t = fitView(game.level, w, h);
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
    const off = evalShake(sh, now, t.cell);
    if (!off) {
      shakes.delete(id);
      continue;
    }
    shakeOffsets.set(id, off);
  }

  drawGame(ctx as unknown as Parameters<typeof drawGame>[0], game, t, {
    showPaths: showPathsBox.checked,
    progressOverride,
    shakeOffsets,
    drawEscapedIds,
  });

  if (game.status === "won" && winStart != null) {
    const phase = (performance.now() - winStart) / 1000;
    winHitbox = drawWinOverlay(ctx as unknown as Parameters<typeof drawWinOverlay>[0], w, h, phase);
  } else {
    winHitbox = null;
  }
}

function updateStatus(): void {
  if (!game) {
    status.textContent = "";
    return;
  }
  const remaining = game.arrows.filter((a) => !a.escaped).length;
  if (game.status === "won") {
    status.textContent = "通关！";
    status.style.color = "#22c55e";
  } else {
    status.textContent = `剩余 ${remaining}/${game.arrows.length}`;
    status.style.color = "#f3e8ff";
  }
}

function selectByKey(key: string): void {
  const entry = entries.find((e) => e.key === key);
  if (!entry) return;
  const level = loadLevel(entry.raw);
  const err = validateLevel(level);
  meta.textContent = err
    ? `[校验失败] ${err}`
    : `${level.width}×${level.height}  ${level.arrows.length} 箭头`;
  game = createGame(level);
  clearAnimations();
  winStart = null;
  currentKey = key;
  select.value = key;
  updateStatus();
  render();
}

function gotoNext(): void {
  const i = entries.findIndex((e) => e.key === currentKey);
  if (i >= 0 && i < entries.length - 1) selectByKey(entries[i + 1]!.key);
}

function gotoPrev(): void {
  const i = entries.findIndex((e) => e.key === currentKey);
  if (i > 0) selectByKey(entries[i - 1]!.key);
}

function handlePointer(clientX: number, clientY: number): void {
  if (!game) return;
  const rect = canvas.getBoundingClientRect();
  const px = clientX - rect.left;
  const py = clientY - rect.top;

  if (game.status === "won" && winHitbox) {
    const hit = hitTestOverlay(winHitbox, px, py);
    if (hit === "next") {
      synth.click();
      gotoNext();
    }
    return;
  }

  if (isAnimating()) return;
  const { w, h } = viewSize();
  const t = fitView(game.level, w, h);
  const cell = pickCell(px, py, t);
  if (cell.x < 0 || cell.y < 0 || cell.x >= game.level.width || cell.y >= game.level.height) {
    return;
  }
  const arrow = findArrowAt(game, cell);
  if (!arrow) return;
  const before = arrow.progress;
  const result = tryPull(game, arrow.id);
  const after = arrow.progress;
  if (result.steps > 0) {
    startTween(arrow.id, before, after, result.escaped);
    if (result.escaped) synth.escape();
    else synth.whoosh(result.steps);
  } else {
    startShake(arrow.id, arrow.data.facing);
    synth.thud();
  }
  if (result.won) {
    winStart = performance.now();
    synth.win();
    ensureRAF();
  }
  updateStatus();
  render();
}

// --- wiring ----------------------------------------------------------------

for (const e of entries) {
  const opt = document.createElement("option");
  opt.value = e.key;
  opt.textContent = e.key.replace(/\.json$/, "");
  select.appendChild(opt);
}

select.addEventListener("change", () => selectByKey(select.value));
prevBtn.addEventListener("click", gotoPrev);
nextBtn.addEventListener("click", gotoNext);
resetBtn.addEventListener("click", () => {
  if (!game) return;
  resetGame(game);
  clearAnimations();
  winStart = null;
  updateStatus();
  render();
});
showPathsBox.addEventListener("change", render);
window.addEventListener("resize", resize);

canvas.addEventListener("click", (ev) => handlePointer(ev.clientX, ev.clientY));
canvas.addEventListener(
  "touchstart",
  (ev) => {
    if (ev.touches.length === 0) return;
    const t = ev.touches[0]!;
    handlePointer(t.clientX, t.clientY);
    ev.preventDefault();
  },
  { passive: false },
);

selectByKey(entries[0]!.key);
resize();
