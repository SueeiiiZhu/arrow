import assert from "node:assert/strict";
import test from "node:test";
import { loadProgress, saveProgress } from "../dist/index.js";

function memStorage() {
  let buf = null;
  return {
    read: () => buf,
    write: (v) => {
      buf = v;
    },
    _peek: () => buf,
  };
}

test("loadProgress returns empty defaults when storage is empty", () => {
  const s = memStorage();
  const p = loadProgress(s);
  assert.equal(p.lastKey, null);
  assert.equal(p.completed.size, 0);
});

test("loadProgress recovers gracefully from malformed JSON", () => {
  const s = memStorage();
  s.write("{not json");
  const p = loadProgress(s);
  assert.equal(p.lastKey, null);
  assert.equal(p.completed.size, 0);
});

test("loadProgress drops non-string entries from completed[]", () => {
  const s = memStorage();
  s.write(JSON.stringify({ lastKey: "a.json", completed: ["a.json", 42, null, "b.json"] }));
  const p = loadProgress(s);
  assert.equal(p.lastKey, "a.json");
  assert.deepEqual([...p.completed].sort(), ["a.json", "b.json"]);
});

test("saveProgress + loadProgress round-trip preserves data", () => {
  const s = memStorage();
  const original = { lastKey: "level-7.json", completed: new Set(["a", "b", "c"]) };
  saveProgress(s, original);
  const restored = loadProgress(s);
  assert.equal(restored.lastKey, "level-7.json");
  assert.deepEqual([...restored.completed].sort(), ["a", "b", "c"]);
});

test("loadProgress treats non-string lastKey as null", () => {
  const s = memStorage();
  s.write(JSON.stringify({ lastKey: 123, completed: ["x"] }));
  const p = loadProgress(s);
  assert.equal(p.lastKey, null);
  assert.deepEqual([...p.completed], ["x"]);
});
