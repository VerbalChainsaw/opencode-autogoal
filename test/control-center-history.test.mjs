/**
 * control-center-history.test.mjs — C13 of the v0.7.0 plan.
 *
 * The drill-down reducer is the pure heart of the new "intuitive"
 * half of the control center. The user presses Tab to enter
 * drill-down mode, ↑/↓ to move a cursor through a list, Enter
 * to select an item, Esc to exit. The reducer is pure (no I/O,
 * no state) so the keyboard logic is unit-testable without a
 * pseudo-terminal.
 *
 * Two kinds of lists are drill-down navigable:
 *   - the steering note list (when the goal has steering)
 *   - the evaluation history (always present when the goal
 *     has any evaluations)
 *
 * The reducer is shared between both via the `kind` discriminator
 * — the same ↑/↓/Enter/Esc/Tab transitions apply, the only
 * difference is which list the cursor is bound to.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  drillReducer,
  initialDrillState,
} from "../dist/control-center-history.js";

// ── initial state ─────────────────────────────────────────────────────

describe("drillReducer: initial state", () => {
  test("initialDrillState('steering'): cursor 0, no selection, not in detail", () => {
    const s = initialDrillState("steering", 5);
    assert.equal(s.kind, "steering");
    assert.equal(s.cursor, 0);
    assert.equal(s.done, null);
    assert.equal(s.detailOpen, false);
  });

  test("initialDrillState('history'): cursor 0, no selection, not in detail", () => {
    const s = initialDrillState("history", 3);
    assert.equal(s.kind, "history");
    assert.equal(s.cursor, 0);
    assert.equal(s.done, null);
    assert.equal(s.detailOpen, false);
  });

  test("initialDrillState: with itemCount=0, the cursor is 0 and the list is empty", () => {
    const s = initialDrillState("steering", 0);
    assert.equal(s.cursor, 0);
  });
});

// ── up / down ─────────────────────────────────────────────────────────

describe("drillReducer: ↑/↓ move the cursor", () => {
  test("down moves the cursor down by 1", () => {
    const s0 = initialDrillState("history", 5);
    const s1 = drillReducer(s0, { kind: "down" });
    assert.equal(s1.cursor, 1);
  });

  test("up moves the cursor up by 1", () => {
    const s0 = { kind: "history", cursor: 2, itemCount: 5, done: null, detailOpen: false };
    const s1 = drillReducer(s0, { kind: "up" });
    assert.equal(s1.cursor, 1);
  });

  test("down at the bottom stays at the bottom (no wrap)", () => {
    const s0 = { kind: "history", cursor: 4, itemCount: 5, done: null, detailOpen: false };
    const s1 = drillReducer(s0, { kind: "down" });
    assert.equal(s1.cursor, 4, "cursor should not wrap past the last item");
  });

  test("up at the top stays at the top (no wrap)", () => {
    const s0 = { kind: "history", cursor: 0, itemCount: 5, done: null, detailOpen: false };
    const s1 = drillReducer(s0, { kind: "up" });
    assert.equal(s1.cursor, 0, "cursor should not wrap above the first item");
  });

  test("down on an empty list is a no-op (cursor stays at 0)", () => {
    const s0 = initialDrillState("steering", 0);
    const s1 = drillReducer(s0, { kind: "down" });
    assert.equal(s1.cursor, 0);
  });
});

// ── enter / esc ───────────────────────────────────────────────────────

describe("drillReducer: enter / esc", () => {
  test("enter on a normal item opens the detail view (does not set done)", () => {
    const s0 = { kind: "history", cursor: 1, itemCount: 5, done: null, detailOpen: false };
    const s1 = drillReducer(s0, { kind: "enter" });
    assert.equal(s1.detailOpen, true);
    assert.equal(s1.done, null);
  });

  test("enter when the detail is already open sets done='selected' (so the shell can act)", () => {
    const s0 = { kind: "history", cursor: 1, done: null, detailOpen: true };
    const s1 = drillReducer(s0, { kind: "enter" });
    assert.equal(s1.done, "selected");
    // detailOpen stays true — the shell consumes the done flag
    // and clears it on the next dispatch.
  });

  test("esc closes the detail view (when open) and sets done='cancelled'", () => {
    const s0 = { kind: "history", cursor: 1, done: null, detailOpen: true };
    const s1 = drillReducer(s0, { kind: "esc" });
    assert.equal(s1.detailOpen, false);
    assert.equal(s1.done, "cancelled");
  });

  test("esc on a normal (non-detail) state sets done='cancelled' (exits drill-down)", () => {
    const s0 = { kind: "history", cursor: 1, itemCount: 5, done: null, detailOpen: false };
    const s1 = drillReducer(s0, { kind: "esc" });
    assert.equal(s1.done, "cancelled");
    assert.equal(s1.detailOpen, false);
  });
});

// ── tab (switch kind) ────────────────────────────────────────────────

describe("drillReducer: tab switches the list", () => {
  test("tab from 'steering' switches to 'history' (resets cursor to 0)", () => {
    const s0 = { kind: "steering", cursor: 2, itemCount: 5, done: null, detailOpen: false };
    const s1 = drillReducer(s0, { kind: "tab" });
    assert.equal(s1.kind, "history");
    assert.equal(s1.cursor, 0);
    assert.equal(s1.detailOpen, false);
  });

  test("tab from 'history' switches to 'steering'", () => {
    const s0 = { kind: "history", cursor: 3, itemCount: 5, done: null, detailOpen: false };
    const s1 = drillReducer(s0, { kind: "tab" });
    assert.equal(s1.kind, "steering");
    assert.equal(s1.cursor, 0);
  });

  test("tab while detail is open closes the detail (does not switch kind)", () => {
    // When the user is in the detail view, Tab is interpreted
    // as "close the detail, then on a future Tab switch kind".
    // v0.7.0 — simpler: Tab from detail closes the detail
    // (cursor unchanged). A subsequent Tab switches kind.
    const s0 = { kind: "history", cursor: 2, done: null, detailOpen: true };
    const s1 = drillReducer(s0, { kind: "tab" });
    assert.equal(s1.detailOpen, false);
    assert.equal(s1.kind, "history", "tab from detail closes the detail but does NOT switch kind");
  });
});

// ── unknown actions are no-ops (defensive) ───────────────────────────

describe("drillReducer: unknown actions", () => {
  test("a string action that's not in the union is a no-op (returns equivalent state)", () => {
    const s0 = { kind: "history", cursor: 1, itemCount: 5, done: null, detailOpen: false };
    const s1 = drillReducer(s0, { kind: "unknown-future-action" });
    assert.deepEqual(s1, s0);
  });
});

// ── immutability ─────────────────────────────────────────────────────

describe("drillReducer: immutability", () => {
  test("the reducer returns a NEW state object (does not mutate the input)", () => {
    const s0 = { kind: "history", cursor: 1, itemCount: 5, done: null, detailOpen: false };
    const s1 = drillReducer(s0, { kind: "down" });
    assert.notEqual(s0, s1, "state must be a new object");
    assert.equal(s0.cursor, 1, "input state must not be mutated");
    assert.equal(s1.cursor, 2);
  });
});
