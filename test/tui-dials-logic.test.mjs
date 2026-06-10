/**
 * Tests for the TUI dial submission handlers in `src/tui-dials-logic.ts`.
 *
 * The JSX layer (`src/tui-dials.tsx`) opens dialogs and routes the user's
 * input to these handlers. The handlers parse + validate + call the
 * right `goal-state` primitive + return a result. The tests exercise
 * the handlers directly so we don't need a JSX host.
 *
 * Coverage: parsePositiveInt, all 8 dial submit handlers, the placeholder
 * builders. Hostile inputs (NaN, empty, non-string, control chars, out-of-
 * range, identical-to-current) all map to ok:false with a useful message.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  handleTurnsSubmit,
  handleTimeSubmit,
  handleTokensSubmit,
  handleConditionSubmit,
  handleSteerSubmit,
  handleClearSteeringSubmit,
  handleRestartSubmit,
  handleHandoffSubmit,
  handleClaimSubmit,
  turnsPlaceholder,
  timePlaceholder,
  tokensPlaceholder,
  conditionPlaceholder,
  steerPlaceholder,
  handoffNotePlaceholder,
  parsePositiveInt,
} from "../dist/tui-dials-logic.js";
import {
  setGoal,
  transitionGoal,
  readGoalState,
  editMaxTurns,
  appendSteering,
  createHandoff,
  MAX_CONDITION_LEN,
  MAX_STEERING_LEN,
} from "../dist/goal-state.js";

function freshDir() {
  return mkdtempSync(join(tmpdir(), "opengoal-dialsh-"));
}

// ── parsePositiveInt ──────────────────────────────────────────────────────

test("parsePositiveInt: '50' → 50", () => {
  assert.equal(parsePositiveInt("50"), 50);
});

test("parsePositiveInt: '  50  ' → 50 (trimmed)", () => {
  assert.equal(parsePositiveInt("  50  "), 50);
});

test("parsePositiveInt: '0' → 0 (it's a positive int per the regex; the caller bounds-checks)", () => {
  // The caller (handleTurnsSubmit etc.) checks against CONSTRAINT_BOUNDS.
  // parsePositiveInt just enforces the syntactic shape.
  assert.equal(parsePositiveInt("0"), 0);
});

test("parsePositiveInt: 'abc' → null", () => {
  assert.equal(parsePositiveInt("abc"), null);
});

test("parsePositiveInt: '' → null", () => {
  assert.equal(parsePositiveInt(""), null);
});

test("parsePositiveInt: '50x' → null (must be all-digits)", () => {
  assert.equal(parsePositiveInt("50x"), null);
});

test("parsePositiveInt: '50.5' → null (no decimals)", () => {
  assert.equal(parsePositiveInt("50.5"), null);
});

test("parsePositiveInt: '1e5' → null (no scientific notation)", () => {
  assert.equal(parsePositiveInt("1e5"), null);
});

test("parsePositiveInt: '-5' → null (no negatives)", () => {
  assert.equal(parsePositiveInt("-5"), null);
});

test("parsePositiveInt: '  ' → null (whitespace-only)", () => {
  assert.equal(parsePositiveInt("  "), null);
});

test("parsePositiveInt: non-string input → null (defense-in-depth)", () => {
  assert.equal(parsePositiveInt(null), null);
  assert.equal(parsePositiveInt(undefined), null);
  assert.equal(parsePositiveInt(50), null);
});

// ── handleTurnsSubmit ─────────────────────────────────────────────────────

test("handleTurnsSubmit: valid number → calls editMaxTurns and returns ok", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "do the thing");
    const res = handleTurnsSubmit(dir, "50");
    assert.equal(res.ok, true);
    if (res.ok) assert.ok(res.message.includes("50"));
    assert.equal(readGoalState(dir).constraints.maxTurns, 50);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("handleTurnsSubmit: invalid (non-numeric) → ok:false with helpful message", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "do the thing");
    const res = handleTurnsSubmit(dir, "abc");
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.reason, "invalid-input");
      assert.ok(res.message.toLowerCase().includes("whole number"));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("handleTurnsSubmit: out-of-range (above max) → ok:false with range message", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "do the thing");
    const res = handleTurnsSubmit(dir, "999999");
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.reason, "invalid-input");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("handleTurnsSubmit: out-of-range (below min) → ok:false with range message", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "do the thing");
    const res = handleTurnsSubmit(dir, "0");
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.reason, "invalid-input");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("handleTurnsSubmit: no-goal → ok:false no-goal", () => {
  const dir = freshDir();
  try {
    const res = handleTurnsSubmit(dir, "50");
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.reason, "no-goal");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("handleTurnsSubmit: terminal-state → ok:false terminal-state", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "do the thing");
    transitionGoal(dir, "clear");
    const res = handleTurnsSubmit(dir, "50");
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.reason, "terminal-state");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── handleTimeSubmit ──────────────────────────────────────────────────────

test("handleTimeSubmit: valid → ok", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "do the thing");
    const res = handleTimeSubmit(dir, "60");
    assert.equal(res.ok, true);
    assert.equal(readGoalState(dir).constraints.maxTimeMinutes, 60);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("handleTimeSubmit: invalid → ok:false invalid-input", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "do the thing");
    const res = handleTimeSubmit(dir, "abc");
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.reason, "invalid-input");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("handleTimeSubmit: out-of-range above → ok:false", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "do the thing");
    const res = handleTimeSubmit(dir, "999999");
    assert.equal(res.ok, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── handleTokensSubmit ────────────────────────────────────────────────────

test("handleTokensSubmit: valid → ok", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "do the thing");
    const res = handleTokensSubmit(dir, "200000");
    assert.equal(res.ok, true);
    assert.equal(readGoalState(dir).constraints.maxTokens, 200000);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("handleTokensSubmit: invalid → ok:false", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "do the thing");
    const res = handleTokensSubmit(dir, "abc");
    assert.equal(res.ok, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("handleTokensSubmit: out-of-range above → ok:false", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "do the thing");
    const res = handleTokensSubmit(dir, "99999999");
    assert.equal(res.ok, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── handleConditionSubmit ─────────────────────────────────────────────────

test("handleConditionSubmit: valid → ok", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "old");
    const res = handleConditionSubmit(dir, "new condition");
    assert.equal(res.ok, true);
    assert.equal(readGoalState(dir).condition, "new condition");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("handleConditionSubmit: empty → ok:false invalid-input", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "old");
    const res = handleConditionSubmit(dir, "");
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.reason, "invalid-input");
      assert.ok(res.message.toLowerCase().includes("empty"));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("handleConditionSubmit: whitespace-only → ok:false", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "old");
    const res = handleConditionSubmit(dir, "   \t\n  ");
    assert.equal(res.ok, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("handleConditionSubmit: too long → ok:false", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "old");
    const res = handleConditionSubmit(dir, "x".repeat(MAX_CONDITION_LEN + 1));
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.reason, "invalid-input");
      assert.ok(res.message.toLowerCase().includes("long"));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("handleConditionSubmit: control chars pass through to the sanitizer", () => {
  // The handler doesn't reject control chars — the primitive sanitizes
  // them. The test pins this behavior.
  const dir = freshDir();
  try {
    setGoal(dir, "old");
    const res = handleConditionSubmit(dir, "line1\nline2\x1b[31m");
    assert.equal(res.ok, true);
    const after = readGoalState(dir);
    assert.ok(!after.condition.includes("\n"));
    assert.ok(!after.condition.includes("\x1b"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("handleConditionSubmit: identical to current → ok:false", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "same text");
    const res = handleConditionSubmit(dir, "same text");
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.reason, "invalid-input");
      assert.ok(res.message.includes("identical"));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── handleSteerSubmit ─────────────────────────────────────────────────────

test("handleSteerSubmit: valid → ok, note persisted", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "do the thing");
    const res = handleSteerSubmit(dir, "try the new lib");
    assert.equal(res.ok, true);
    const after = readGoalState(dir);
    assert.equal(after.metadata.steering.length, 1);
    assert.equal(after.metadata.steering[0].note, "try the new lib");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("handleSteerSubmit: empty → ok:false", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "do the thing");
    const res = handleSteerSubmit(dir, "");
    assert.equal(res.ok, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("handleSteerSubmit: too long → ok:false", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "do the thing");
    const res = handleSteerSubmit(dir, "x".repeat(MAX_STEERING_LEN + 1));
    assert.equal(res.ok, false);
    if (!res.ok) assert.ok(res.message.toLowerCase().includes("long"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("handleSteerSubmit: control chars sanitized", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "do the thing");
    const res = handleSteerSubmit(dir, "first\nsecond");
    assert.equal(res.ok, true);
    if (res.ok) assert.ok(!res.message.includes("\n"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── handleClearSteeringSubmit ─────────────────────────────────────────────

test("handleClearSteeringSubmit: with notes → ok, count cleared", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "do the thing");
    appendSteering(dir, "a");
    appendSteering(dir, "b");
    const res = handleClearSteeringSubmit(dir);
    assert.equal(res.ok, true);
    if (res.ok) assert.ok(res.message.includes("2"));
    assert.equal(readGoalState(dir).metadata.steering, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("handleClearSteeringSubmit: no notes → ok with 'no notes' message", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "do the thing");
    const res = handleClearSteeringSubmit(dir);
    assert.equal(res.ok, true);
    if (res.ok) assert.ok(res.message.toLowerCase().includes("no"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── handleRestartSubmit ──────────────────────────────────────────────────

test("handleRestartSubmit: active goal → ok, new id", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "do the thing");
    const oldId = readGoalState(dir).id;
    const res = handleRestartSubmit(dir);
    assert.equal(res.ok, true);
    assert.notEqual(readGoalState(dir).id, oldId);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("handleRestartSubmit: no goal → ok:false no-goal", () => {
  const dir = freshDir();
  try {
    const res = handleRestartSubmit(dir);
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.reason, "no-goal");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("handleRestartSubmit: handoff pending → ok:false handoff-pending", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "do the thing");
    createHandoff(dir);
    const res = handleRestartSubmit(dir);
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.reason, "handoff-pending");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── handleHandoffSubmit ───────────────────────────────────────────────────

test("handleHandoffSubmit: with note → ok", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "do the thing");
    const res = handleHandoffSubmit(dir, "for the next session");
    assert.equal(res.ok, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("handleHandoffSubmit: without note → ok", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "do the thing");
    const res = handleHandoffSubmit(dir, undefined);
    assert.equal(res.ok, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("handleHandoffSubmit: empty note is treated as no note", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "do the thing");
    const res = handleHandoffSubmit(dir, "   ");
    assert.equal(res.ok, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("handleHandoffSubmit: no goal → ok:false no-goal", () => {
  const dir = freshDir();
  try {
    const res = handleHandoffSubmit(dir, "x");
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.reason, "no-goal");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("handleHandoffSubmit: second handoff refused", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "do the thing");
    createHandoff(dir);
    const res = handleHandoffSubmit(dir, "x");
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.reason, "handoff-exists");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── handleClaimSubmit ─────────────────────────────────────────────────────

test("handleClaimSubmit: with handoff + cleared goal → ok, state resumed", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "do the thing");
    createHandoff(dir);
    transitionGoal(dir, "clear");
    const res = handleClaimSubmit(dir);
    assert.equal(res.ok, true);
    if (res.ok) assert.ok(res.message.includes("Resumed"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("handleClaimSubmit: no handoff → ok:false no-handoff", () => {
  const dir = freshDir();
  try {
    const res = handleClaimSubmit(dir);
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.reason, "no-handoff");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("handleClaimSubmit: current active goal → ok:false current-goal", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "first");
    createHandoff(dir);
    const res = handleClaimSubmit(dir);
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.reason, "current-goal");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── Placeholder builders ──────────────────────────────────────────────────

test("turnsPlaceholder: includes the max bound for context", () => {
  const dir = freshDir();
  try {
    const p = turnsPlaceholder(dir);
    assert.ok(p.includes("50"));
    assert.ok(p.toLowerCase().includes("max"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timePlaceholder: includes the max bound for context", () => {
  const dir = freshDir();
  try {
    const p = timePlaceholder(dir);
    assert.ok(p.includes("60"));
    assert.ok(p.toLowerCase().includes("max"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("tokensPlaceholder: includes the max bound, formatted with toLocaleString", () => {
  const dir = freshDir();
  try {
    const p = tokensPlaceholder(dir);
    assert.ok(p.includes("200"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("conditionPlaceholder: doesn't reference any specific value", () => {
  const dir = freshDir();
  try {
    const p = conditionPlaceholder(dir);
    assert.ok(p.toLowerCase().includes("condition") || p.toLowerCase().includes("type"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("steerPlaceholder: hints at steering/hint semantics", () => {
  const dir = freshDir();
  try {
    const p = steerPlaceholder(dir);
    assert.ok(p.toLowerCase().includes("hint") || p.toLowerCase().includes("next"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("handoffNotePlaceholder: hints at the note being optional", () => {
  const dir = freshDir();
  try {
    const p = handoffNotePlaceholder(dir);
    assert.ok(p.toLowerCase().includes("optional") || p.toLowerCase().includes("note"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── editMaxTurns regression: handler + primitive are in lockstep ─────────

test("handler accepts what the primitive accepts (consistency lockstep)", () => {
  // Pin the contract: any value handleTurnsSubmit accepts, editMaxTurns
  // also accepts. Any value editMaxTurns rejects for invalid-value,
  // handleTurnsSubmit also rejects. The handler does the syntactic
  // pre-check AND the range check; the primitive does the range check.
  const dir = freshDir();
  try {
    setGoal(dir, "do");
    // 1..maxTurns
    for (const v of [1, 50, 1000, 10000]) {
      assert.equal(editMaxTurns(dir, v).ok, true, `primitive should accept ${v}`);
      setGoal(dir, "do");
      assert.equal(handleTurnsSubmit(dir, String(v)).ok, true, `handler should accept ${v}`);
    }
    // 0 and 10001 rejected by both
    for (const v of [0, 10001, -1]) {
      assert.equal(editMaxTurns(dir, v).ok, false, `primitive should reject ${v}`);
      setGoal(dir, "do");
      assert.equal(handleTurnsSubmit(dir, String(v)).ok, false, `handler should reject ${v}`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
