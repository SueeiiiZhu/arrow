import {
  createGame,
  findArrowAt,
  loadLevel,
  resetGame,
  tryPull,
  validateLevel,
  type GameState,
  type RawLevelFile,
} from "@ea/core";
import { drawGame, fitView, pickCell } from "@ea/renderer";

// --- animation state ---------------------------------------------------------

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

// Vite glob: every neutral level JSON bundled at build time.
const levelModules = import.meta.glob<RawLevelFile>(
  "../../../levels_data/*.json",
  { eager: true, import: "default" },
);

interface Entry {
  key: string;
  name: string;
  raw: RawLevelFile;
}

const entries: Entry[] = Object.entries(levelModules)
  .map(([path, raw]) => {
    const file = path.split("/").pop()!;
    return { key: file, name: file.replace(/^\d+__/, "").replace(/\.json$/, ""), raw };
  })
  .sort((a, b) => a.key.localeCompare(b.key));

const select = document.getElementById("level-select") as HTMLSelectElement;
const showPathsBox = document.getElementById("show-paths") as HTMLInputElement;
const meta = document.getElementById("meta") as HTMLSpanElement;
const status = document.getElementById("status") as HTMLSpanElement;
const prevBtn = document.getElementById("prev-btn") as HTMLButtonElement;
const nextBtn = document.getElementById("next-btn") as HTMLButtonElement;
const resetBtn = document.getElementById("reset-btn") as HTMLButtonElement;
const canvas = document.getElementById("board") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;

for (const e of entries) {
  const opt = document.createElement("option");
  opt.value = e.key;
  opt.textContent = e.name;
  select.appendChild(opt);
}

let game: GameState | null = null;

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

  drawGame(ctx as any, game, t, {
    showPaths: showPathsBox.checked,
    progressOverride,
    shakeOffsets,
    drawEscapedIds,
  });
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
    status.style.color = "#e2e8f0";
  }
}

function selectLevel(key: string): void {
  const entry = entries.find((e) => e.key === key);
  if (!entry) return;
  const level = loadLevel(entry.raw);
  const err = validateLevel(level);
  meta.textContent = err
    ? `[校验失败] ${err}`
    : `${level.width}×${level.height}  ${level.arrows.length} 箭头  (${entries.indexOf(entry) + 1}/${entries.length})`;
  game = createGame(level);
  clearAnimations();
  select.value = key;
  updateStatus();
  render();
}

function handlePointer(clientX: number, clientY: number): void {
  if (!game || game.status === "won" || isAnimating()) return;
  const rect = canvas.getBoundingClientRect();
  const px = clientX - rect.left;
  const py = clientY - rect.top;
  const { w, h } = viewSize();
  const t = fitView(game.level, w, h);
  const cell = pickCell(px, py, t);
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
  const result = tryPull(game, arrow.id);
  const after = arrow.progress;
  if (result.steps > 0) {
    startTween(arrow.id, before, after, result.escaped);
  } else {
    startShake(arrow.id, arrow.data.facing);
  }
  updateStatus();
  render();
}

select.addEventListener("change", () => selectLevel(select.value));
showPathsBox.addEventListener("change", render);
window.addEventListener("resize", resize);

prevBtn.addEventListener("click", () => {
  const i = entries.findIndex((e) => e.key === select.value);
  if (i > 0) selectLevel(entries[i - 1]!.key);
});
nextBtn.addEventListener("click", () => {
  const i = entries.findIndex((e) => e.key === select.value);
  if (i >= 0 && i < entries.length - 1) selectLevel(entries[i + 1]!.key);
});
resetBtn.addEventListener("click", () => {
  if (!game) return;
  resetGame(game);
  clearAnimations();
  updateStatus();
  render();
});

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

if (entries.length > 0) selectLevel(entries[0]!.key);
resize();
