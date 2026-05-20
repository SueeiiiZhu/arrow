import assert from "node:assert/strict";
import test from "node:test";
import {
  consume,
  createFresh,
  defaultConfig,
  fromJSON,
  msToNextRegen,
  refill,
  tick,
} from "../dist/lives.js";

const cfg = { max: 5, regenIntervalMs: 1000 };
const t0 = 1_000_000;

test("createFresh starts at max with anchor=now", () => {
  const s = createFresh(cfg, t0);
  assert.equal(s.lives, 5);
  assert.equal(s.regenAnchor, t0);
});

test("defaultConfig has 5 max and 30 min interval", () => {
  assert.equal(defaultConfig.max, 5);
  assert.equal(defaultConfig.regenIntervalMs, 30 * 60_000);
});

test("tick at full keeps anchor pinned to now", () => {
  const s = createFresh(cfg, t0);
  const t = tick(s, cfg, t0 + 999);
  assert.equal(t.lives, 5);
  assert.equal(t.regenAnchor, t0 + 999);
});

test("tick partial elapse does not regen below threshold", () => {
  const s = { lives: 3, regenAnchor: t0 };
  const t = tick(s, cfg, t0 + 999);
  assert.deepEqual(t, s);
});

test("tick at exactly interval regens one", () => {
  const s = { lives: 3, regenAnchor: t0 };
  const t = tick(s, cfg, t0 + 1000);
  assert.equal(t.lives, 4);
  assert.equal(t.regenAnchor, t0 + 1000);
});

test("tick multi-interval regens multiple", () => {
  const s = { lives: 1, regenAnchor: t0 };
  const t = tick(s, cfg, t0 + 2500);
  assert.equal(t.lives, 3);
  assert.equal(t.regenAnchor, t0 + 2000);
});

test("tick caps at max, anchor reset to now once full", () => {
  const s = { lives: 4, regenAnchor: t0 };
  const t = tick(s, cfg, t0 + 5000);
  assert.equal(t.lives, 5);
  assert.equal(t.regenAnchor, t0 + 5000);
});

test("tick on backwards clock pins anchor to now", () => {
  const s = { lives: 3, regenAnchor: t0 };
  const t = tick(s, cfg, t0 - 1000);
  assert.equal(t.lives, 3);
  assert.equal(t.regenAnchor, t0 - 1000);
});

test("consume from full sets anchor to now", () => {
  const s = createFresh(cfg, t0);
  const { ok, state } = consume(s, cfg, t0);
  assert.equal(ok, true);
  assert.equal(state.lives, 4);
  assert.equal(state.regenAnchor, t0);
});

test("consume from partial keeps existing anchor", () => {
  const s = { lives: 3, regenAnchor: t0 };
  const { ok, state } = consume(s, cfg, t0 + 100);
  assert.equal(ok, true);
  assert.equal(state.lives, 2);
  assert.equal(state.regenAnchor, t0);
});

test("consume at 0 returns ok=false unchanged", () => {
  const s = { lives: 0, regenAnchor: t0 };
  const { ok, state } = consume(s, cfg, t0 + 100);
  assert.equal(ok, false);
  assert.equal(state.lives, 0);
});

test("consume reconciles pending regen before subtracting", () => {
  const s = { lives: 0, regenAnchor: t0 };
  const { ok, state } = consume(s, cfg, t0 + 1500);
  assert.equal(ok, true);
  assert.equal(state.lives, 0);
});

test("refill adds one and caps at max", () => {
  const s = { lives: 4, regenAnchor: t0 };
  const t = refill(s, cfg, t0 + 100, 1);
  assert.equal(t.lives, 5);
  assert.equal(t.regenAnchor, t0 + 100);
});

test("refill amount=2 adds two", () => {
  const s = { lives: 1, regenAnchor: t0 };
  const t = refill(s, cfg, t0 + 100, 2);
  assert.equal(t.lives, 3);
});

test("msToNextRegen returns null at full", () => {
  const s = createFresh(cfg, t0);
  assert.equal(msToNextRegen(s, cfg, t0 + 500), null);
});

test("msToNextRegen counts down within interval", () => {
  const s = { lives: 2, regenAnchor: t0 };
  assert.equal(msToNextRegen(s, cfg, t0 + 300), 700);
  assert.equal(msToNextRegen(s, cfg, t0 + 999), 1);
});

test("msToNextRegen across multiple intervals returns sub-interval remainder", () => {
  const s = { lives: 1, regenAnchor: t0 };
  // 2.5 intervals elapsed → 2 regens applied (lives 3), 500ms into next.
  assert.equal(msToNextRegen(s, cfg, t0 + 2500), 500);
});

test("fromJSON parses valid payload", () => {
  const t = fromJSON({ lives: 3, regenAnchor: t0 }, cfg, t0 + 1);
  assert.equal(t.lives, 3);
  assert.equal(t.regenAnchor, t0);
});

test("fromJSON clamps lives and defaults missing fields", () => {
  assert.equal(fromJSON({ lives: 99 }, cfg, t0).lives, 5);
  assert.equal(fromJSON({ lives: -1 }, cfg, t0).lives, 0);
  assert.equal(fromJSON({ lives: 3 }, cfg, t0).regenAnchor, t0);
  assert.equal(fromJSON(null, cfg, t0).lives, 5);
  assert.equal(fromJSON("nonsense", cfg, t0).lives, 5);
});
