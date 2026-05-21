/**
 * Player-facing level ordering.
 *
 * The raw `ALL_KEYS` array generated at build time is in filename order
 * (00001…03548 = the APK's authored difficulty curve). To give returning
 * players some freshness without throwing the curve out, we:
 *   1. parse a difficulty score from the filename ([WxH] → grid area),
 *   2. sort keys into N equal-size quantile buckets (easy → hard),
 *   3. deterministically shuffle within each bucket using a per-user seed
 *      (so each player sees a stable but personal order).
 *
 * Result: bucket sequence is monotonic in difficulty, intra-bucket order
 * is reproducible per seed. lastKey / completed in Progress still work
 * unchanged because they key by string, not by index.
 */

import type { Progress } from "./progress.js";

const BUCKETS = 5;

function parseDifficulty(key: string): number {
  const m = key.match(/\[(\d+)x(\d+)\]/);
  if (!m) return 0;
  return Number(m[1]) * Number(m[2]);
}

// mulberry32 — small, fast, well-mixed 32-bit PRNG. Adequate for shuffle.
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffleByDifficulty(keys: readonly string[], seed: number): string[] {
  const scored = keys.map((k, i) => ({ k, d: parseDifficulty(k), i }));
  scored.sort((a, b) => a.d - b.d || a.i - b.i);
  const bucketSize = Math.ceil(scored.length / BUCKETS);
  const rng = mulberry32(seed);
  for (let b = 0; b < BUCKETS; b++) {
    const lo = b * bucketSize;
    const hi = Math.min(lo + bucketSize, scored.length);
    for (let i = hi - 1; i > lo; i--) {
      const j = lo + Math.floor(rng() * (i - lo + 1));
      const tmp = scored[i]!;
      scored[i] = scored[j]!;
      scored[j] = tmp;
    }
  }
  return scored.map((s) => s.k);
}

/**
 * Returns the seed in `progress`, generating + assigning one if absent.
 * Caller is responsible for persisting `progress` after this returns.
 */
export function ensureShuffleSeed(progress: Progress): number {
  if (progress.shuffleSeed != null) return progress.shuffleSeed;
  let seed = 0;
  while (seed === 0) seed = (Math.random() * 0xffffffff) >>> 0;
  progress.shuffleSeed = seed;
  return seed;
}
