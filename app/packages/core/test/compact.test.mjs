import assert from "node:assert/strict";
import test from "node:test";
import { decodeCompact, loadLevel } from "../dist/index.js";

test("decodeCompact rebuilds RawLevelFile shape", () => {
  // 3x2 grid; arrow facing +x, path = [(0,0), (1,0), (2,0)] = cell idx 0,1,2.
  const raw = decodeCompact([3, 2, [[0, 0, 1, 2]]]);
  assert.equal(raw.width, 3);
  assert.equal(raw.height, 2);
  assert.equal(raw.coord_system, "row-major, origin top-left, y-down");
  assert.equal(raw.arrows.length, 1);
  const a = raw.arrows[0];
  assert.deepEqual(a.facing, [1, 0]);
  assert.deepEqual(a.start, [0, 0]);
  assert.deepEqual(a.path, [
    [0, 0],
    [1, 0],
    [2, 0],
  ]);
});

test("decodeCompact handles all four facings", () => {
  for (const [fcode, expected] of [
    [0, [1, 0]],
    [1, [0, 1]],
    [2, [-1, 0]],
    [3, [0, -1]],
  ]) {
    const raw = decodeCompact([2, 2, [[fcode, 0]]]);
    assert.deepEqual(raw.arrows[0].facing, expected);
  }
});

test("decodeCompact output feeds loadLevel", () => {
  // 2x2 with a 2-cell snake at (0,0)->(1,0), facing +y. cell idx 0,1.
  const raw = decodeCompact([2, 2, [[1, 0, 1]]]);
  const level = loadLevel(raw);
  assert.equal(level.width, 2);
  assert.equal(level.height, 2);
  assert.equal(level.arrows.length, 1);
});
