import assert from "node:assert/strict";
import test from "node:test";
import { loadLevel, loadOriginalLevel, validateLevel } from "../dist/index.js";

test("loadLevel decodes a RawLevelFile into LevelData", () => {
  const raw = {
    width: 3,
    height: 1,
    coord_system: "row-major, origin top-left, y-down",
    arrows: [
      {
        start: [2, 0],
        facing: [1, 0],
        path: [
          [2, 0],
          [1, 0],
          [0, 0],
        ],
      },
    ],
  };
  const lvl = loadLevel(raw);
  assert.equal(lvl.width, 3);
  assert.equal(lvl.arrows.length, 1);
  assert.deepEqual(lvl.arrows[0].start, { x: 2, y: 0 });
  assert.equal(lvl.arrows[0].path.length, 3);
});

test("loadOriginalLevel reconstructs path from row-major Indices", () => {
  // 3x1 grid → indices 0,1,2 are (0,0),(1,0),(2,0).
  const raw = {
    XSize: 3,
    YSize: 1,
    Arrows: [{ X: 2, Y: 0, Dx: 1, Dy: 0, BendCount: 0, Indices: [2, 1, 0] }],
  };
  const lvl = loadOriginalLevel(raw);
  assert.equal(lvl.width, 3);
  assert.deepEqual(lvl.arrows[0].path[0], { x: 2, y: 0 });
  assert.deepEqual(lvl.arrows[0].path[2], { x: 0, y: 0 });
});

test("validateLevel accepts a well-formed fixture", () => {
  const lvl = {
    width: 3,
    height: 1,
    arrows: [
      {
        start: { x: 2, y: 0 },
        facing: { x: 1, y: 0 },
        path: [
          { x: 2, y: 0 },
          { x: 1, y: 0 },
          { x: 0, y: 0 },
        ],
      },
    ],
  };
  assert.equal(validateLevel(lvl), null);
});

test("validateLevel rejects path[0] ≠ start", () => {
  const lvl = {
    width: 3,
    height: 1,
    arrows: [
      {
        start: { x: 0, y: 0 },
        facing: { x: 1, y: 0 },
        path: [
          { x: 2, y: 0 },
          { x: 1, y: 0 },
        ],
      },
    ],
  };
  const err = validateLevel(lvl);
  assert.match(err, /path\[0\] != start/);
});

test("validateLevel rejects out-of-bounds path cells", () => {
  const lvl = {
    width: 2,
    height: 1,
    arrows: [
      {
        start: { x: 1, y: 0 },
        facing: { x: 1, y: 0 },
        path: [
          { x: 1, y: 0 },
          { x: 0, y: 0 },
          { x: -1, y: 0 },
        ],
      },
    ],
  };
  const err = validateLevel(lvl);
  assert.match(err, /out of bounds/);
});

test("validateLevel rejects non-adjacent path steps", () => {
  const lvl = {
    width: 3,
    height: 1,
    arrows: [
      {
        start: { x: 2, y: 0 },
        facing: { x: 1, y: 0 },
        path: [
          { x: 2, y: 0 },
          { x: 0, y: 0 }, // skips (1,0)
        ],
      },
    ],
  };
  const err = validateLevel(lvl);
  assert.match(err, /non-adjacent/);
});

test("validateLevel rejects facing that is not -first_step", () => {
  const lvl = {
    width: 3,
    height: 1,
    arrows: [
      {
        start: { x: 2, y: 0 },
        facing: { x: 0, y: 1 }, // wrong; should be (+1,0)
        path: [
          { x: 2, y: 0 },
          { x: 1, y: 0 },
        ],
      },
    ],
  };
  const err = validateLevel(lvl);
  assert.match(err, /facing != -first_step/);
});
