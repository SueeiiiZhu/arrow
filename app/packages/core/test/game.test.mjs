// Unit tests for `@ea/core` — the snake-walk rules in particular.
// Run with: pnpm --filter @ea/core test
//
// Tests import from ../dist/ so the package must be built first; that step
// is wired into the npm `pretest` script.

import assert from "node:assert/strict";
import test from "node:test";
import {
  bodyCellsAt,
  cellKey,
  createGame,
  findArrowAt,
  resetGame,
  tryPull,
  validateLevel,
} from "../dist/index.js";

// --- Fixture helpers --------------------------------------------------------

function arrowRightEdge2(x0) {
  // Length-2 arrow facing +x, head at (x0,0) extending past +x.
  // path: [(x0,0), (x0-1,0)]   facing: (+1,0)
  return {
    start: { x: x0, y: 0 },
    facing: { x: 1, y: 0 },
    path: [
      { x: x0, y: 0 },
      { x: x0 - 1, y: 0 },
    ],
  };
}

function levelOf(width, height, arrows) {
  return { width, height, arrows };
}

// --- Single arrow on 1D track -----------------------------------------------

test("single 3-cell arrow escapes off the right edge in one pull", () => {
  // Grid 3x1, arrow occupies all cells, head at (2,0), facing +x.
  const level = levelOf(3, 1, [
    {
      start: { x: 2, y: 0 },
      facing: { x: 1, y: 0 },
      path: [
        { x: 2, y: 0 },
        { x: 1, y: 0 },
        { x: 0, y: 0 },
      ],
    },
  ]);
  assert.equal(validateLevel(level), null, "fixture should validate");
  const game = createGame(level);
  const r = tryPull(game, 0);
  assert.equal(r.escaped, true, "arrow escaped");
  assert.equal(r.won, true, "win flips when last arrow escapes");
  assert.equal(game.status, "won");
  assert.ok(r.steps >= 3, `expected >= 3 steps to clear length-3 arrow, got ${r.steps}`);
});

test("pull on already-escaped arrow is a no-op (steps=0, not won twice)", () => {
  const level = levelOf(3, 1, [
    {
      start: { x: 2, y: 0 },
      facing: { x: 1, y: 0 },
      path: [
        { x: 2, y: 0 },
        { x: 1, y: 0 },
        { x: 0, y: 0 },
      ],
    },
  ]);
  const game = createGame(level);
  tryPull(game, 0); // wins
  const again = tryPull(game, 0);
  assert.deepEqual(again, { steps: 0, escaped: false, won: false });
});

// --- Two arrows, blocking ---------------------------------------------------

test("trailing arrow is blocked by leading arrow's body, escapes once cleared", () => {
  // Grid 4x1. A at right with body [(3,0),(2,0)], B at left with body [(1,0),(0,0)].
  // B's head extension target is (2,0) — occupied by A — so B is initially blocked.
  const level = levelOf(4, 1, [arrowRightEdge2(3), arrowRightEdge2(1)]);
  assert.equal(validateLevel(level), null);
  const game = createGame(level);

  // Pull B first — blocked.
  const r1 = tryPull(game, 1);
  assert.equal(r1.steps, 0, "B blocked while A occupies (2,0)");
  assert.equal(r1.escaped, false);
  assert.equal(r1.won, false);
  assert.equal(game.arrows[1].progress, 0);

  // Pull A — escapes.
  const r2 = tryPull(game, 0);
  assert.equal(r2.escaped, true);
  assert.equal(r2.won, false, "B still on the board");

  // Pull B again — now unblocked, escapes too. Win flips.
  const r3 = tryPull(game, 1);
  assert.equal(r3.escaped, true);
  assert.equal(r3.won, true);
  assert.equal(game.status, "won");
});

test("resetGame restores initial state across multiple arrows", () => {
  const level = levelOf(4, 1, [arrowRightEdge2(3), arrowRightEdge2(1)]);
  const game = createGame(level);
  tryPull(game, 0);
  assert.equal(game.arrows[0].escaped, true);
  resetGame(game);
  for (const a of game.arrows) {
    assert.equal(a.progress, 0);
    assert.equal(a.escaped, false);
  }
  assert.equal(game.status, "playing");
});

// --- Bent path snake-walk ---------------------------------------------------

test("L-shaped arrow follows its own path when pulled (snake-walk)", () => {
  // Grid 3x3. Arrow start=(0,2), facing=(0,+1), path goes (0,2)→(0,1)→(1,1)→(2,1).
  // facing == -(path[1]-path[0]) = -((0,1)-(0,2)) = -(0,-1) = (0,+1).
  // Head extension goes (0,2) → (0,3) → off-grid.
  const level = levelOf(3, 3, [
    {
      start: { x: 0, y: 2 },
      facing: { x: 0, y: 1 },
      path: [
        { x: 0, y: 2 },
        { x: 0, y: 1 },
        { x: 1, y: 1 },
        { x: 2, y: 1 },
      ],
    },
  ]);
  assert.equal(validateLevel(level), null);
  const game = createGame(level);

  // Body cells at progress 0: head=(0,2), then path[1..3].
  const k0 = bodyCellsAt(level.arrows[0], 0);
  assert.deepEqual(k0[0], { x: 0, y: 2 });
  assert.deepEqual(k0[3], { x: 2, y: 1 });

  // At progress 1 the snake slides along its own bend:
  //   head extends to path[0] + 1*facing = (0,3) (off-grid),
  //   segment 1 → (0,2), segment 2 → (0,1), segment 3 → (1,1).
  const k1 = bodyCellsAt(level.arrows[0], 1);
  assert.deepEqual(k1[0], { x: 0, y: 3 });
  assert.deepEqual(k1[1], { x: 0, y: 2 });
  assert.deepEqual(k1[2], { x: 0, y: 1 });
  assert.deepEqual(k1[3], { x: 1, y: 1 });

  // Fractional progress between 0 and 1 interpolates linearly.
  const kHalf = bodyCellsAt(level.arrows[0], 0.5);
  assert.equal(kHalf[1].x, 0, "segment 1 stays on x=0 between (0,1) and (0,2)");
  assert.ok(
    Math.abs(kHalf[1].y - 1.5) < 1e-9,
    `segment 1 y should be 1.5 mid-tween, got ${kHalf[1].y}`,
  );

  // Full pull escapes.
  const r = tryPull(game, 0);
  assert.equal(r.escaped, true);
  assert.equal(r.won, true);
});

// --- findArrowAt ------------------------------------------------------------

test("findArrowAt picks up the arrow whose in-grid body cell matches", () => {
  const level = levelOf(4, 1, [arrowRightEdge2(3), arrowRightEdge2(1)]);
  const game = createGame(level);
  const hitA = findArrowAt(game, { x: 3, y: 0 });
  assert.equal(hitA?.id, 0);
  const hitB = findArrowAt(game, { x: 0, y: 0 });
  assert.equal(hitB?.id, 1);
  const miss = findArrowAt(game, { x: 5, y: 5 });
  assert.equal(miss, null, "outside grid → no arrow");
});

test("cellKey is stable", () => {
  assert.equal(cellKey(3, 7), "3,7");
});
