import assert from "node:assert/strict";
import test from "node:test";
import { ensureShuffleSeed, shuffleByDifficulty } from "../dist/index.js";

function makeKey(w, h, i) {
  return `${String(i).padStart(5, "0")}__[${w}x${h}]_[10]_[Basic].json`;
}

test("shuffleByDifficulty preserves the full set", () => {
  const keys = [];
  for (let i = 0; i < 50; i++) keys.push(makeKey(5 + i, 5 + i, i));
  const out = shuffleByDifficulty(keys, 1);
  assert.equal(out.length, keys.length);
  assert.deepEqual([...out].sort(), [...keys].sort());
});

test("shuffleByDifficulty is deterministic per seed", () => {
  const keys = Array.from({ length: 30 }, (_, i) => makeKey(10, 10 + (i % 5), i));
  const a = shuffleByDifficulty(keys, 42);
  const b = shuffleByDifficulty(keys, 42);
  assert.deepEqual(a, b);
});

test("shuffleByDifficulty bucket sequence is monotonic in difficulty", () => {
  // 100 keys, scores 10..1000 (10*i+10). 5 buckets of 20 → bucket means strictly ascending.
  const keys = Array.from({ length: 100 }, (_, i) => makeKey(1, i + 1, i));
  const out = shuffleByDifficulty(keys, 7);
  const parse = (k) => {
    const m = k.match(/\[(\d+)x(\d+)\]/);
    return Number(m[1]) * Number(m[2]);
  };
  const bucketSize = Math.ceil(out.length / 5);
  let prevMax = -1;
  for (let b = 0; b < 5; b++) {
    const slice = out.slice(b * bucketSize, (b + 1) * bucketSize);
    const min = Math.min(...slice.map(parse));
    const max = Math.max(...slice.map(parse));
    assert.ok(min > prevMax, `bucket ${b} min ${min} should be > prev max ${prevMax}`);
    prevMax = max;
  }
});

test("shuffleByDifficulty actually permutes within bucket", () => {
  // 20 keys of identical difficulty → same bucket. Shuffle must reorder ≥ half.
  const keys = Array.from({ length: 20 }, (_, i) => makeKey(10, 10, i));
  const out = shuffleByDifficulty(keys, 123);
  let moved = 0;
  for (let i = 0; i < keys.length; i++) if (out[i] !== keys[i]) moved++;
  assert.ok(moved >= 10, `expected ≥10 keys to move, got ${moved}`);
});

test("ensureShuffleSeed mints a seed when null and is idempotent", () => {
  const p = { lastKey: null, completed: new Set(), shuffleSeed: null };
  const s = ensureShuffleSeed(p);
  assert.equal(typeof s, "number");
  assert.ok(s > 0 && s <= 0xffffffff);
  assert.equal(p.shuffleSeed, s);
  // Second call must return the same value (no re-mint).
  assert.equal(ensureShuffleSeed(p), s);
});
