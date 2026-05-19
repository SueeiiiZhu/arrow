export interface Progress {
  lastKey: string | null;
  completed: Set<string>;
}

export interface ProgressStorage {
  read(): string | null;
  write(value: string): void;
}

export function loadProgress(storage: ProgressStorage): Progress {
  const raw = storage.read();
  if (!raw) return { lastKey: null, completed: new Set() };
  try {
    const obj = JSON.parse(raw);
    const lastKey = typeof obj.lastKey === "string" ? obj.lastKey : null;
    const completed: string[] = Array.isArray(obj.completed) ? obj.completed : [];
    return { lastKey, completed: new Set(completed.filter((x) => typeof x === "string")) };
  } catch {
    return { lastKey: null, completed: new Set() };
  }
}

export function saveProgress(storage: ProgressStorage, p: Progress): void {
  storage.write(
    JSON.stringify({
      lastKey: p.lastKey,
      completed: [...p.completed],
    }),
  );
}
