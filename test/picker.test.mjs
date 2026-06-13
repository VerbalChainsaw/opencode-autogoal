/**
 * picker.test.mjs — D18 of the v0.7.0 plan.
 *
 * `pickFromList` is a generic list-picker reducer used by the
 * A (archive), T (templates), and D (doctor) actions. The
 * user sees a list of items, navigates with ↑/↓, picks one
 * with Enter, or cancels with Esc. The reducer is pure
 * (no I/O, no state) so the keyboard logic is unit-testable
 * without a pseudo-terminal.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  pickReducer,
  initialPickState,
} from "../dist/picker.js";

// ── initial state ─────────────────────────────────────────────────────

describe("pickReducer: initial state", () => {
  test("initialPickState: cursor 0, not done", () => {
    const s = initialPickState(5);
    assert.equal(s.cursor, 0);
    assert.equal(s.done, null);
  });

  test("initialPickState: with itemCount=0, cursor is 0", () => {
    const s = initialPickState(0);
    assert.equal(s.cursor, 0);
  });
});

// ── up / down ─────────────────────────────────────────────────────────

describe("pickReducer: ↑/↓ move the cursor", () => {
  test("down moves the cursor down by 1", () => {
    const s0 = initialPickState(5);
    const s1 = pickReducer(s0, { kind: "down" });
    assert.equal(s1.cursor, 1);
  });

  test("up moves the cursor up by 1", () => {
    const s0 = { cursor: 2, done: null };
    const s1 = pickReducer(s0, { kind: "up" });
    assert.equal(s1.cursor, 1);
  });

  test("down at the bottom stays at the bottom (clamped)", () => {
    const s0 = { cursor: 4, done: null };
    const s1 = pickReducer(s0, { kind: "down", itemCount: 5 });
    assert.equal(s1.cursor, 4);
  });

  test("up at the top stays at the top (clamped)", () => {
    const s0 = { cursor: 0, done: null };
    const s1 = pickReducer(s0, { kind: "up" });
    assert.equal(s1.cursor, 0);
  });
});

// ── enter / esc ───────────────────────────────────────────────────────

describe("pickReducer: enter / esc", () => {
  test("enter sets done='selected' with the cursor as the chosen index", () => {
    const s0 = { cursor: 2, done: null };
    const s1 = pickReducer(s0, { kind: "enter" });
    assert.equal(s1.done, "selected");
    assert.equal(s1.cursor, 2);
  });

  test("esc sets done='cancelled'", () => {
    const s0 = { cursor: 1, done: null };
    const s1 = pickReducer(s0, { kind: "esc" });
    assert.equal(s1.done, "cancelled");
  });
});

// ── itemCount update (when the underlying list changes) ──────────────

describe("pickReducer: itemCount", () => {
  test("if the cursor is past the new itemCount, it clamps to itemCount-1", () => {
    const s0 = { cursor: 5, done: null };
    const s1 = pickReducer(s0, { kind: "down", itemCount: 3 });
    assert.equal(s1.cursor, 2);
  });
});
