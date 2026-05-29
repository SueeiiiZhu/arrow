export interface Progress {
  lastKey: string | null;
  completed: Set<string>;
  /**
   * Per-user PRNG seed. Stable once written; consumed by shuffleByDifficulty
   * to give each player a different (but reproducible) intra-bucket order
   * while preserving the global easy→hard curve. Null on first launch.
   */
  shuffleSeed: number | null;
  /** Remaining hint uses. Refilled via rewarded video (备案: 提示次数有限). */
  hints: number;
  /** Soft currency. Earned on win and via rewarded video (备案: 货币系统). */
  coins: number;
  /** Settings panel — 备案: 设置系统. */
  settings: { sfx: boolean; vibrate: boolean; showPaths: boolean };
}

export const DEFAULT_HINTS = 3;
const DEFAULT_SETTINGS = { sfx: true, vibrate: true, showPaths: true };

export interface ProgressStorage {
  read(): string | null;
  write(value: string): void;
}

function freshProgress(): Progress {
  return {
    lastKey: null,
    completed: new Set(),
    shuffleSeed: null,
    hints: DEFAULT_HINTS,
    coins: 0,
    settings: { ...DEFAULT_SETTINGS },
  };
}

export function loadProgress(storage: ProgressStorage): Progress {
  const raw = storage.read();
  if (!raw) return freshProgress();
  try {
    const obj = JSON.parse(raw);
    const lastKey = typeof obj.lastKey === "string" ? obj.lastKey : null;
    const completed: string[] = Array.isArray(obj.completed) ? obj.completed : [];
    const shuffleSeed =
      typeof obj.shuffleSeed === "number" && Number.isFinite(obj.shuffleSeed) && obj.shuffleSeed > 0
        ? obj.shuffleSeed >>> 0
        : null;
    const hints =
      typeof obj.hints === "number" && Number.isFinite(obj.hints) && obj.hints >= 0
        ? Math.floor(obj.hints)
        : DEFAULT_HINTS;
    const coins =
      typeof obj.coins === "number" && Number.isFinite(obj.coins) && obj.coins >= 0
        ? Math.floor(obj.coins)
        : 0;
    const rawSettings =
      obj.settings && typeof obj.settings === "object"
        ? (obj.settings as Record<string, unknown>)
        : {};
    const settings = {
      sfx: typeof rawSettings.sfx === "boolean" ? rawSettings.sfx : DEFAULT_SETTINGS.sfx,
      vibrate:
        typeof rawSettings.vibrate === "boolean" ? rawSettings.vibrate : DEFAULT_SETTINGS.vibrate,
      showPaths:
        typeof rawSettings.showPaths === "boolean"
          ? rawSettings.showPaths
          : DEFAULT_SETTINGS.showPaths,
    };
    return {
      lastKey,
      completed: new Set(completed.filter((x) => typeof x === "string")),
      shuffleSeed,
      hints,
      coins,
      settings,
    };
  } catch {
    return freshProgress();
  }
}

export function saveProgress(storage: ProgressStorage, p: Progress): void {
  storage.write(
    JSON.stringify({
      lastKey: p.lastKey,
      completed: [...p.completed],
      shuffleSeed: p.shuffleSeed,
      hints: p.hints,
      coins: p.coins,
      settings: p.settings,
    }),
  );
}
