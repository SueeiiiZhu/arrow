export interface Progress {
  lastKey: string | null;
  completed: Set<string>;
  /**
   * Per-user PRNG seed. Stable once written; consumed by shuffleByDifficulty
   * to give each player a different (but reproducible) intra-bucket order
   * while preserving the global easy→hard curve. Null on first launch.
   */
  shuffleSeed: number | null;
}

export interface ProgressStorage {
  read(): string | null;
  write(value: string): void;
}

export function loadProgress(storage: ProgressStorage): Progress {
  const raw = storage.read();
  if (!raw) return { lastKey: null, completed: new Set(), shuffleSeed: null };
  try {
    const obj = JSON.parse(raw);
    const lastKey = typeof obj.lastKey === "string" ? obj.lastKey : null;
    const completed: string[] = Array.isArray(obj.completed) ? obj.completed : [];
    const shuffleSeed =
      typeof obj.shuffleSeed === "number" && Number.isFinite(obj.shuffleSeed) && obj.shuffleSeed > 0
        ? obj.shuffleSeed >>> 0
        : null;
    return {
      lastKey,
      completed: new Set(completed.filter((x) => typeof x === "string")),
      shuffleSeed,
    };
  } catch {
    return { lastKey: null, completed: new Set(), shuffleSeed: null };
  }
}

export function saveProgress(storage: ProgressStorage, p: Progress): void {
  storage.write(
    JSON.stringify({
      lastKey: p.lastKey,
      completed: [...p.completed],
      shuffleSeed: p.shuffleSeed,
    }),
  );
}
