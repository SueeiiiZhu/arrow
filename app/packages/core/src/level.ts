import type {
  ArrowData,
  LevelData,
  OriginalLevelFile,
  RawLevelFile,
  Vec2,
} from "./types.js";

/** Decode the neutral on-disk format. */
export function loadLevel(raw: RawLevelFile): LevelData {
  return {
    width: raw.width,
    height: raw.height,
    arrows: raw.arrows.map((a) => ({
      start: { x: a.start[0], y: a.start[1] },
      facing: { x: a.facing[0], y: a.facing[1] },
      path: a.path.map(([x, y]) => ({ x, y })),
    })),
  };
}

/** Decode an APK-format level (XSize/YSize/Arrows/Indices). Useful for
 *  re-importing without going through the python conversion step. */
export function loadOriginalLevel(raw: OriginalLevelFile): LevelData {
  const W = raw.XSize;
  const H = raw.YSize;
  const arrows: ArrowData[] = raw.Arrows.map((a) => {
    const path: Vec2[] = a.Indices.map((idx) => ({
      x: idx % W,
      y: Math.floor(idx / W),
    }));
    return {
      start: { x: a.X, y: a.Y },
      facing: { x: a.Dx, y: a.Dy },
      path,
    };
  });
  return { width: W, height: H, arrows };
}

/** Convert (x,y) ↔ 1D cell index (row-major). */
export function idx(x: number, y: number, width: number): number {
  return y * width + x;
}
export function unidx(i: number, width: number): Vec2 {
  return { x: i % width, y: Math.floor(i / width) };
}

/** Validate an in-memory level is internally consistent. Returns null on
 *  success, or a string describing the first violation. Useful for editor
 *  tooling and unit tests. */
export function validateLevel(level: LevelData): string | null {
  const { width: W, height: H, arrows } = level;
  for (let i = 0; i < arrows.length; i++) {
    const a = arrows[i]!;
    if (a.path.length === 0) return `arrow#${i}: empty path`;
    const p0 = a.path[0]!;
    if (p0.x !== a.start.x || p0.y !== a.start.y) {
      return `arrow#${i}: path[0] != start`;
    }
    for (const p of a.path) {
      if (p.x < 0 || p.x >= W || p.y < 0 || p.y >= H) {
        return `arrow#${i}: path cell out of bounds (${p.x},${p.y})`;
      }
    }
    for (let k = 1; k < a.path.length; k++) {
      const prev = a.path[k - 1]!;
      const cur = a.path[k]!;
      const dx = cur.x - prev.x;
      const dy = cur.y - prev.y;
      const adj =
        (Math.abs(dx) === 1 && dy === 0) || (dx === 0 && Math.abs(dy) === 1);
      if (!adj) return `arrow#${i}: non-adjacent step at ${k}`;
    }
    // facing should be negation of first step
    if (a.path.length >= 2) {
      const step = {
        x: a.path[1]!.x - a.path[0]!.x,
        y: a.path[1]!.y - a.path[0]!.y,
      };
      if (a.facing.x !== -step.x || a.facing.y !== -step.y) {
        return `arrow#${i}: facing != -first_step (facing=${a.facing.x},${a.facing.y} step=${step.x},${step.y})`;
      }
    }
  }
  return null;
}
