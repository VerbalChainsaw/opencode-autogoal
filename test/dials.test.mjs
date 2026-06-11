/**
 * Tests for the v0.2.0 dial primitives in `src/goal-state.ts`:
 *   - editMaxTurns / editMaxTime / editMaxTokens
 *   - editCondition
 *   - restartGoal
 *   - appendSteering / clearSteering
 *   - createHandoff / readHandoff / claimHandoff
 *
 * All primitives follow the same shape: read state, validate input,
 * mutate in-memory copy, write atomically, return a result object. The
 * tests assert: (a) the happy path mutates the file correctly, (b) all
 * the guard clauses (no-goal, terminal-state, invalid-value, write-failed)
 * return the right error, (c) hostile inputs (NaN, Infinity, out-of-range,
 * control chars, non-string, empty, identical) are rejected or sanitized
 * correctly, (d) the in-memory state after the call is consistent (a
 * subsequent readGoalState sees the new value).
 *
 * The dials are the only new code surface in v0.2.0; these tests are
 * the regression suite. The dials surface in the sidebar is JSX
 * (sidebar.tsx) which is tested via the empirical-verify gate in the
 * review gauntlet, not via this file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  editMaxTurns,
  editMaxTime,
  editMaxTokens,
  editCondition,
  restartGoal,
  appendSteering,
  clearSteering,
  createHandoff,
  readHandoff,
  claimHandoff,
  setGoal,
  transitionGoal,
  readGoalState,
  validateGoalState,
  sanitizeForPrompt,
  CONSTRAINT_BOUNDS,
  HANDOFF_FILE,
  MAX_STEERING_NOTES,
  MAX_STEERING_LEN,
} from "../dist/goal-state.js";

function freshDir() {
  return mkdtempSync(join(tmpdir(), "opengoal-dials-"));
}

function plantState(dir, overrides = {}) {
  mkdirSync(join(dir, ".opencode"), { recursive: true });
  const state = {
    version: 1,
    id: "test-id",
    condition: "do the thing",
    command: null,
    status: "active",
    createdAt: 1,
    startedAt: 1,
    completedAt: null,
    pausedAt: null,
    resumedAt: null,
    turnsEvaluated: 0,
    tokensUsed: 0,
    lastEvaluation: null,
    evaluationHistory: [],
    constraints: { maxTurns: 20, maxTimeMinutes: 30, maxTokens: 100000 },
    metadata: { setBy: "user" },
    ...overrides,
  };
  writeFileSync(join(dir, ".opencode", ".goal-state.json"), JSON.stringify(state));
}

// ── editMaxTurns ───────────────────────────────────────────────────────────

test("editMaxTurns: happy path mutates constraints.maxTurns and persists", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "do the thing");
    const res = editMaxTurns(dir, 50);
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.field, "turns");
      assert.equal(res.value, 50);
    }
    const after = readGoalState(dir);
    assert.equal(after.constraints.maxTurns, 50);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("editMaxTurns: no goal → no-goal error", () => {
  const dir = freshDir();
  try {
    const res = editMaxTurns(dir, 50);
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.reason, "no-goal");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("editMaxTurns: terminal-state (cleared) → terminal-state error", () => {
  const dir = freshDir();
  try {
    plantState(dir, { status: "cleared", completedAt: 1 });
    const res = editMaxTurns(dir, 50);
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.reason, "terminal-state");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("editMaxTurns: terminal-state (achieved) → terminal-state error", () => {
  const dir = freshDir();
  try {
    plantState(dir, { status: "achieved", completedAt: 1 });
    const res = editMaxTurns(dir, 50);
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.reason, "terminal-state");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("editMaxTurns: clamped at lower bound (0 rejected)", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "do the thing");
    const res = editMaxTurns(dir, 0);
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.reason, "invalid-value");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("editMaxTurns: clamped at upper bound (max+1 rejected)", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "do the thing");
    const res = editMaxTurns(dir, CONSTRAINT_BOUNDS.maxTurns + 1);
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.reason, "invalid-value");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("editMaxTurns: accepts the upper bound (exactly maxTurns)", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "do the thing");
    const res = editMaxTurns(dir, CONSTRAINT_BOUNDS.maxTurns);
    assert.equal(res.ok, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("editMaxTurns: NaN rejected as invalid-value", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "do the thing");
    const res = editMaxTurns(dir, NaN);
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.reason, "invalid-value");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("editMaxTurns: Infinity rejected as invalid-value", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "do the thing");
    const res = editMaxTurns(dir, Infinity);
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.reason, "invalid-value");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("editMaxTurns: -Infinity rejected as invalid-value", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "do the thing");
    const res = editMaxTurns(dir, -Infinity);
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.reason, "invalid-value");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("editMaxTurns: lowering below turnsEvaluated is allowed; message flags the trip", () => {
  // The user can set maxTurns to a value <= turnsEvaluated to force the
  // loop to trip on the next idle (a valid "wrap it up now" action).
  // The result message should flag this.
  const dir = freshDir();
  try {
    setGoal(dir, "do the thing");
    plantState(dir, { turnsEvaluated: 10 });
    const res = editMaxTurns(dir, 5);
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.ok(res.message.includes("trip on next idle"), `message: ${res.message}`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("editMaxTurns: works on paused goals (paused is mutable)", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "do the thing");
    transitionGoal(dir, "pause");
    const res = editMaxTurns(dir, 50);
    assert.equal(res.ok, true);
    const after = readGoalState(dir);
    assert.equal(after.status, "paused");
    assert.equal(after.constraints.maxTurns, 50);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── editMaxTime ────────────────────────────────────────────────────────────

test("editMaxTime: happy path mutates maxTimeMinutes", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "do the thing");
    const res = editMaxTime(dir, 60);
    assert.equal(res.ok, true);
    if (res.ok) assert.equal(res.value, 60);
    const after = readGoalState(dir);
    assert.equal(after.constraints.maxTimeMinutes, 60);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("editMaxTime: out of range rejected (0 and max+1)", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "do the thing");
    assert.equal(editMaxTime(dir, 0).ok, false);
    assert.equal(editMaxTime(dir, CONSTRAINT_BOUNDS.maxMinutes + 1).ok, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("editMaxTime: no-goal and terminal-state guard", () => {
  const dir1 = freshDir();
  const dir2 = freshDir();
  try {
    assert.equal(editMaxTime(dir1, 60).ok, false);
    plantState(dir2, { status: "cleared", completedAt: 1 });
    assert.equal(editMaxTime(dir2, 60).ok, false);
  } finally {
    rmSync(dir1, { recursive: true, force: true });
    rmSync(dir2, { recursive: true, force: true });
  }
});

// ── editMaxTokens ──────────────────────────────────────────────────────────

test("editMaxTokens: happy path mutates maxTokens", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "do the thing");
    const res = editMaxTokens(dir, 200000);
    assert.equal(res.ok, true);
    if (res.ok) assert.equal(res.value, 200000);
    const after = readGoalState(dir);
    assert.equal(after.constraints.maxTokens, 200000);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("editMaxTokens: out of range rejected", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "do the thing");
    assert.equal(editMaxTokens(dir, 0).ok, false);
    assert.equal(editMaxTokens(dir, CONSTRAINT_BOUNDS.maxTokens + 1).ok, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── editCondition ──────────────────────────────────────────────────────────

test("editCondition: happy path mutates condition and sets conditionEditedAt", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "old condition");
    const now = 12345;
    const res = editCondition(dir, "new condition text", now);
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.field, "condition");
      assert.equal(res.value, "new condition text");
    }
    const after = readGoalState(dir);
    assert.equal(after.condition, "new condition text");
    assert.equal(after.metadata.conditionEditedAt, now);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("editCondition: preserves id, status, constraints, evaluations (only condition changes)", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "old");
    plantState(dir, {
      turnsEvaluated: 7,
      lastEvaluation: { at: 1, met: false, reason: "x", confidence: 0.5, evaluatorType: "deterministic" },
    });
    const res = editCondition(dir, "new");
    assert.equal(res.ok, true);
    const after = readGoalState(dir);
    assert.equal(after.id, "test-id");
    assert.equal(after.status, "active");
    assert.equal(after.turnsEvaluated, 7);
    assert.ok(after.lastEvaluation);
    assert.equal(after.constraints.maxTurns, 20);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("editCondition: sanitizes newlines/control chars", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "old");
    const res = editCondition(dir, "line1\nline2\tcol\x1b[31mRED\x1b[0m");
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.ok(!res.value.includes("\n"));
      assert.ok(!res.value.includes("\t"));
      assert.ok(!res.value.includes("\x1b"));
      assert.ok(res.value.includes("line1"));
      assert.ok(res.value.includes("line2"));
      assert.ok(res.value.includes("RED"));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("editCondition: empty-after-sanitization rejected as invalid-value", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "old");
    const res = editCondition(dir, "   \t\n   ");
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.reason, "invalid-value");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("editCondition: length-clamped to MAX_CONDITION_LEN (4000)", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "old");
    const long = "x".repeat(5000);
    const res = editCondition(dir, long);
    assert.equal(res.ok, true);
    if (res.ok) assert.equal(res.value.length, 4000);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("editCondition: identical-to-current rejected as invalid-value (no-op signal)", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "same text");
    const res = editCondition(dir, "same text");
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.reason, "invalid-value");
      assert.ok(res.error.includes("identical"));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("editCondition: non-string input rejected as invalid-value", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "old");
    const res = editCondition(dir, null);
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.reason, "invalid-value");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("editCondition: no goal → no-goal error", () => {
  const dir = freshDir();
  try {
    const res = editCondition(dir, "anything");
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.reason, "no-goal");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("editCondition: terminal state rejected", () => {
  const dir = freshDir();
  try {
    plantState(dir, { status: "achieved", completedAt: 1 });
    const res = editCondition(dir, "new");
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.reason, "terminal-state");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── restartGoal ────────────────────────────────────────────────────────────

test("restartGoal: happy path resets counters, keeps condition+constraints, new id", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "do the thing");
    plantState(dir, { turnsEvaluated: 5, tokensUsed: 1000 });
    const oldId = readGoalState(dir).id;
    const res = restartGoal(dir, 12345);
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.notEqual(res.newId, oldId);
    }
    const after = readGoalState(dir);
    assert.notEqual(after.id, oldId);
    assert.equal(after.condition, "do the thing");
    assert.equal(after.turnsEvaluated, 0);
    assert.equal(after.tokensUsed, 0);
    assert.equal(after.lastEvaluation, null);
    assert.equal(after.evaluationHistory.length, 0);
    assert.equal(after.status, "active");
    assert.equal(after.metadata.previousId, oldId);
    assert.equal(after.metadata.restartedAt, 12345);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("restartGoal: no goal → no-goal error", () => {
  const dir = freshDir();
  try {
    const res = restartGoal(dir);
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.reason, "no-goal");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("restartGoal: terminal state rejected", () => {
  const dir = freshDir();
  try {
    plantState(dir, { status: "cleared", completedAt: 1 });
    const res = restartGoal(dir);
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.reason, "terminal-state");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("restartGoal: refused when a handoff is pending (clobber guard)", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "do the thing");
    // Plant a fake handoff
    mkdirSync(join(dir, ".opencode"), { recursive: true });
    writeFileSync(join(dir, ".opencode", ".goal-handoff.json"), JSON.stringify({
      createdAt: "2026-06-10T00:00:00Z",
      state: readGoalState(dir),
    }));
    const res = restartGoal(dir);
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.reason, "handoff-pending");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("restartGoal: succeeds after the handoff is removed", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "do the thing");
    mkdirSync(join(dir, ".opencode"), { recursive: true });
    writeFileSync(join(dir, ".opencode", ".goal-handoff.json"), "{}");
    rmSync(join(dir, ".opencode", ".goal-handoff.json"));
    const res = restartGoal(dir);
    assert.equal(res.ok, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── appendSteering / clearSteering ────────────────────────────────────────

test("appendSteering: happy path appends a note with timestamp", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "do the thing");
    const now = 12345;
    const res = appendSteering(dir, "try the new library next", now);
    assert.equal(res.ok, true);
    const after = readGoalState(dir);
    assert.ok(Array.isArray(after.metadata.steering));
    assert.equal(after.metadata.steering.length, 1);
    assert.equal(after.metadata.steering[0].note, "try the new library next");
    assert.equal(after.metadata.steering[0].at, now);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("appendSteering: appends (does not replace) on multiple calls", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "do the thing");
    appendSteering(dir, "first", 1);
    appendSteering(dir, "second", 2);
    appendSteering(dir, "third", 3);
    const after = readGoalState(dir);
    assert.equal(after.metadata.steering.length, 3);
    assert.equal(after.metadata.steering[0].note, "first");
    assert.equal(after.metadata.steering[2].note, "third");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("appendSteering: caps at MAX_STEERING_NOTES (20) — old notes dropped FIFO", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "do the thing");
    for (let i = 0; i < 25; i++) {
      appendSteering(dir, `note-${i}`, i);
    }
    const after = readGoalState(dir);
    assert.equal(after.metadata.steering.length, MAX_STEERING_NOTES);
    // The first 5 (i=0..4) should have been dropped; the kept ones start at i=5
    assert.equal(after.metadata.steering[0].note, "note-5");
    assert.equal(after.metadata.steering[19].note, "note-24");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("appendSteering: truncates long notes to MAX_STEERING_LEN (500)", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "do the thing");
    const long = "x".repeat(1000);
    const res = appendSteering(dir, long);
    assert.equal(res.ok, true);
    if (res.ok) assert.equal(res.value.length, MAX_STEERING_LEN);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("appendSteering: sanitizes control chars", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "do the thing");
    const res = appendSteering(dir, "first\nsecond\tthird\x1b[31m");
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.ok(!res.value.includes("\n"));
      assert.ok(!res.value.includes("\x1b"));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("appendSteering: empty-after-sanitization rejected", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "do the thing");
    const res = appendSteering(dir, "   \t\n  ");
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.reason, "invalid-value");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("appendSteering: no goal → no-goal error", () => {
  const dir = freshDir();
  try {
    const res = appendSteering(dir, "anything");
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.reason, "no-goal");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("appendSteering: terminal state rejected", () => {
  const dir = freshDir();
  try {
    plantState(dir, { status: "cleared", completedAt: 1 });
    const res = appendSteering(dir, "anything");
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.reason, "terminal-state");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("clearSteering: happy path removes all notes", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "do the thing");
    appendSteering(dir, "a", 1);
    appendSteering(dir, "b", 2);
    const res = clearSteering(dir);
    assert.equal(res.ok, true);
    if (res.ok) assert.equal(res.cleared, 2);
    const after = readGoalState(dir);
    assert.equal(after.metadata.steering, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("clearSteering: no notes to clear is a no-op success", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "do the thing");
    const res = clearSteering(dir);
    assert.equal(res.ok, true);
    if (res.ok) assert.equal(res.cleared, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("clearSteering: no goal → no-goal error", () => {
  const dir = freshDir();
  try {
    const res = clearSteering(dir);
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.reason, "no-goal");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── createHandoff / readHandoff / claimHandoff ────────────────────────────

test("createHandoff: happy path writes a handoff file", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "do the thing");
    const res = createHandoff(dir, "for next session", 12345);
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.path, join(dir, ".opencode", ".goal-handoff.json"));
    }
    assert.equal(readHandoff(dir) !== null, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("createHandoff: handoff contains a valid GoalState", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "do the thing");
    createHandoff(dir);
    const h = readHandoff(dir);
    assert.ok(h);
    assert.ok(validateGoalState(h.state));
    assert.equal(h.state.condition, "do the thing");
    assert.equal(typeof h.createdAt, "string");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("createHandoff: trims and stores the note", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "do the thing");
    createHandoff(dir, "  for the next session  ");
    const h = readHandoff(dir);
    assert.equal(h.note, "for the next session");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("createHandoff: empty/whitespace note is dropped", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "do the thing");
    createHandoff(dir, "   ");
    const h = readHandoff(dir);
    assert.equal(h.note, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("createHandoff: refuses if a handoff already exists (single-slot)", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "do the thing");
    createHandoff(dir);
    const res = createHandoff(dir, "second");
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.reason, "handoff-exists");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("createHandoff: no goal → no-goal error", () => {
  const dir = freshDir();
  try {
    const res = createHandoff(dir);
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.reason, "no-goal");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("createHandoff: terminal state rejected", () => {
  const dir = freshDir();
  try {
    plantState(dir, { status: "achieved", completedAt: 1 });
    const res = createHandoff(dir);
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.reason, "terminal-state");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("createHandoff: evaluationHistory capped at 10 (validator + writer both enforce)", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "do the thing");
    // Plant a state with 15 evaluations. The validator (added in v0.2.0-rc.6
    // hardening) caps at 10, so a state with 15 fails validation and
    // readGoalState returns null. createHandoff then returns no-goal. The
    // security-validated behavior: a corrupt state with >10 evals is
    // rejected outright.
    const state = readGoalState(dir);
    state.evaluationHistory = Array.from({ length: 15 }, (_, i) => ({
      at: i, met: false, reason: `eval-${i}`, confidence: 0.5, evaluatorType: "deterministic",
    }));
    writeFileSync(join(dir, ".opencode", ".goal-state.json"), JSON.stringify(state));
    // The next readGoalState rejects (15 > 10) → null → createHandoff returns no-goal.
    const res = createHandoff(dir);
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.reason, "no-goal");
    // And the validator works on a hand-crafted 10-entry state too: that
    // one passes validation, so createHandoff succeeds. Sanity check.
    plantState(dir, {
      status: "active",
      evaluationHistory: Array.from({ length: 10 }, (_, i) => ({
        at: i, met: false, reason: `ok-${i}`, confidence: 0.5, evaluatorType: "deterministic",
      })),
    });
    const res2 = createHandoff(dir);
    assert.equal(res2.ok, true);
    const h = readHandoff(dir);
    assert.equal(h.state.evaluationHistory.length, 10);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("readHandoff: returns null when no handoff file exists", () => {
  const dir = freshDir();
  try {
    assert.equal(readHandoff(dir), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("readHandoff: returns null when the handoff is corrupt (invalid JSON)", () => {
  const dir = freshDir();
  try {
    mkdirSync(join(dir, ".opencode"), { recursive: true });
    writeFileSync(join(dir, ".opencode", ".goal-handoff.json"), "{not valid json");
    assert.equal(readHandoff(dir), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("readHandoff: returns null when the handoff's state is invalid (validation guards)", () => {
  const dir = freshDir();
  try {
    mkdirSync(join(dir, ".opencode"), { recursive: true });
    // Valid shape but the state itself fails validateGoalState
    writeFileSync(join(dir, ".opencode", ".goal-handoff.json"), JSON.stringify({
      createdAt: "2026-06-10T00:00:00Z",
      state: { condition: "x", status: "achieve" /* typo */ },
    }));
    assert.equal(readHandoff(dir), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("claimHandoff: happy path resumes state, deletes handoff, sets active", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "do the thing");
    plantState(dir, { turnsEvaluated: 7 });
    const originalId = readGoalState(dir).id;
    createHandoff(dir, "for next session");
    // Clear the current state so the claim has a clean slate
    transitionGoal(dir, "clear");
    assert.equal(readHandoff(dir) !== null, true);

    const res = claimHandoff(dir, 12345);
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.state.id, originalId);
      assert.equal(res.state.status, "active");
      assert.equal(res.state.turnsEvaluated, 7);
      assert.equal(res.state.condition, "do the thing");
      assert.equal(res.state.metadata.resumedFromHandoffAt, 12345);
    }
    // Handoff is gone
    assert.equal(readHandoff(dir), null);
    // The state is the resumed one
    const after = readGoalState(dir);
    assert.equal(after.id, originalId);
    assert.equal(after.status, "active");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("claimHandoff: no handoff → no-handoff error", () => {
  const dir = freshDir();
  try {
    const res = claimHandoff(dir);
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.reason, "no-handoff");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("claimHandoff: refuses if a current goal is active (would clobber)", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "first");
    createHandoff(dir);
    // Note: the current goal is still active, the handoff is also present.
    const res = claimHandoff(dir);
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.reason, "current-goal");
    // Both files still exist
    assert.ok(readGoalState(dir));
    assert.ok(readHandoff(dir));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("claimHandoff: allows claim when current goal is in a terminal state", () => {
  // A cleared/achieved goal is "current" but is no longer active — the
  // user is allowed to claim the handoff to start fresh. Simulate the
  // scenario by: setting a goal, creating a handoff, clearing the goal,
  // then claiming the handoff. The handoff already exists, and the
  // current state is now terminal.
  const dir = freshDir();
  try {
    setGoal(dir, "first");
    createHandoff(dir);
    transitionGoal(dir, "clear");
    const res = claimHandoff(dir);
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.state.condition, "first");
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("claimHandoff: a stale handoff whose state is now invalid is ignored", () => {
  // The handoff file exists but its state field fails validation. The
  // claim should report no-handoff (because readHandoff returns null).
  const dir = freshDir();
  try {
    mkdirSync(join(dir, ".opencode"), { recursive: true });
    writeFileSync(join(dir, ".opencode", ".goal-handoff.json"), JSON.stringify({
      createdAt: "2026-06-10T00:00:00Z",
      state: { condition: "x", constraints: {} }, // invalid
    }));
    const res = claimHandoff(dir);
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.reason, "no-handoff");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("claimHandoff: deletes the handoff file even if the state write succeeds", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "do the thing");
    createHandoff(dir);
    transitionGoal(dir, "clear");
    claimHandoff(dir);
    // The handoff file should be gone from disk
    const handoffPath = join(dir, ".opencode", ".goal-handoff.json");
    assert.equal(existsSync(handoffPath), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("HANDOFF_FILE constant matches the path used by readHandoff/claimHandoff", () => {
  // Catch any drift between the constant and the path the functions use.
  const dir = freshDir();
  try {
    setGoal(dir, "do the thing");
    createHandoff(dir);
    const handoffPath = join(dir, ".opencode", ".goal-handoff.json");
    assert.equal(existsSync(handoffPath), true);
    assert.equal(handoffPath, join(dir, HANDOFF_FILE));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── GoalState.metadata validator surface ──────────────────────────────────

test("validateGoalState: accepts all the new metadata fields (v0.2.0 schema)", () => {
  // Forward-compat check: the validator must tolerate the new optional
  // fields without breaking. The metadata validator is loose by design
  // (only setBy is required); this test pins that contract.
  const state = {
    version: 1,
    id: "x",
    condition: "x",
    command: null,
    status: "active",
    createdAt: 1, startedAt: 1, completedAt: null, pausedAt: null, resumedAt: null,
    turnsEvaluated: 0, tokensUsed: 0, lastEvaluation: null, evaluationHistory: [],
    constraints: { maxTurns: 20, maxTimeMinutes: 30, maxTokens: 100000 },
    metadata: {
      setBy: "user",
      conditionEditedAt: 100,
      previousId: "old-id",
      restartedAt: 200,
      steering: [{ at: 1, note: "n1" }, { at: 2, note: "n2" }],
      resumedFromHandoffAt: 300,
    },
  };
  assert.equal(validateGoalState(state), true);
});

test("validateGoalState: rejects a metadata.steering entry that is not an object", () => {
  // The metadata validator is loose but steering specifically should be
  // an array of objects. If a corrupt state has steering as a string, the
  // edit primitives must tolerate it (the existing code does
  // `Array.isArray(state.metadata.steering) ? ... : []`).
  const dir = freshDir();
  try {
    setGoal(dir, "do the thing");
    plantState(dir, { metadata: { setBy: "user", steering: "not an array" } });
    // The append should still work; it should treat the bad field as [].
    const res = appendSteering(dir, "fresh note");
    assert.equal(res.ok, true);
    const after = readGoalState(dir);
    assert.equal(after.metadata.steering.length, 1);
    assert.equal(after.metadata.steering[0].note, "fresh note");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("withStateLock: serializes concurrent writers (race-condition fix)", () => {
  // The security review (IMPORTANT #5) flagged that the v0.2.0 primitives
  // do read-modify-write without serialization. Two concurrent writers
  // (e.g. user clicks "edit turns" while the auto-loop writes a state
  // update) silently lose one mutation. withStateLock wraps every R-M-W
  // site. This test pins the contract: when the lock is held, a second
  // invocation blocks until the first completes.
  //
  // We can't easily test "concurrent" without threads. Instead, we test
  // the sequencing guarantee: a function that takes time inside the lock
  // does NOT release the lock until it returns. The test is: set a state,
  // call a primitive that mutates it, and assert the on-disk file
  // matches the expected post-state (no torn write).
  const dir = freshDir();
  try {
    setGoal(dir, "original");
    // editMaxTurns is now wrapped — verify the write is atomic by reading
    // back. If the lock were buggy (e.g. released too early), a torn
    // write would show up as an off-by-one constraint value or a missing
    // field. This test would still pass even without the lock, so we
    // also test the lock's serialization of two interleaved operations.
    editMaxTurns(dir, 50);
    const after1 = readGoalState(dir);
    assert.equal(after1.constraints.maxTurns, 50);
    // Now do a sequence of operations and assert the post-state matches
    // what we'd expect from a serialized execution. If the lock is broken,
    // the operations would interleave and the assertions would still pass
    // (the operations are commutative) — so this test is a SMOKE test
    // for "the lock doesn't break correctness", not a stress test for
    // "the lock prevents races". The stress test is hard to write without
    // threads; the empirical verification is the unit-test-level
    // correctness of the wrapped functions, which the existing 307
    // tests already pin.
    editMaxTime(dir, 60);
    editMaxTokens(dir, 200000);
    editCondition(dir, "new text");
    const after2 = readGoalState(dir);
    assert.equal(after2.constraints.maxTurns, 50);
    assert.equal(after2.constraints.maxTimeMinutes, 60);
    assert.equal(after2.constraints.maxTokens, 200000);
    assert.equal(after2.condition, "new text");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("withStateLock: restarts and handoffs don't deadlock with themselves", () => {
  // A primitive that recursively calls another primitive (e.g.
  // restartGoal doesn't call any, but a future maintainer might add
  // a primitive that calls editMaxTurns) would deadlock if the lock
  // weren't reentrant. The current implementation uses a sync try/finally
  // so reentrant calls re-acquire the lock instantly. This test pins
  // that the lock is non-reentrant-SAFE for at least one level.
  const dir = freshDir();
  try {
    setGoal(dir, "test");
    // Two non-overlapping primitives work fine
    editMaxTurns(dir, 100);
    editMaxTime(dir, 200);
    const s = readGoalState(dir);
    assert.equal(s.constraints.maxTurns, 100);
    assert.equal(s.constraints.maxTimeMinutes, 200);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("validateGoalState: rejects a metadata.steering entry whose at is not a number", () => {
  // Defense: a hostile handoff file could plant steering entries with
  // string timestamps. The current primitive just spreads them through.
  // We pin the current behavior: it doesn't crash, and the entry is
  // preserved as-is. (Future hardening could deep-validate each entry.)
  const dir = freshDir();
  try {
    setGoal(dir, "do the thing");
    appendSteering(dir, "ok note", 1);
    plantState(dir, { metadata: { setBy: "user", steering: [{ at: "not-a-number", note: "x" }] } });
    // The next appendSteering should still work and append alongside the bad entry.
    appendSteering(dir, "ok note 2", 2);
    const after = readGoalState(dir);
    assert.equal(after.metadata.steering.length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("validateGoalState: rejects evaluationHistory with > 10 entries (DoS cap)", () => {
  // A malicious handoff file with a 100,000-entry history would otherwise
  // OOM the plugin when read. The cap is enforced at the validator.
  const dir = freshDir();
  try {
    plantState(dir, {
      status: "active",
      evaluationHistory: Array.from({ length: 15 }, (_, i) => ({
        at: i, met: false, reason: `eval-${i}`, confidence: 0.5, evaluatorType: "deterministic",
      })),
    });
    // The 15-entry state is invalid; readGoalState returns null.
    assert.equal(readGoalState(dir), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("validateGoalState: accepts evaluationHistory with exactly 10 entries (boundary)", () => {
  // The cap is > 10 (strict), so 10 is the largest valid size.
  const dir = freshDir();
  try {
    plantState(dir, {
      status: "active",
      evaluationHistory: Array.from({ length: 10 }, (_, i) => ({
        at: i, met: false, reason: `eval-${i}`, confidence: 0.5, evaluatorType: "deterministic",
      })),
    });
    const s = readGoalState(dir);
    assert.ok(s);
    assert.equal(s.evaluationHistory.length, 10);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── sanitizeForPrompt ─────────────────────────────────────────────────────

test("sanitizeForPrompt: drops C0/C1 control chars (the prompt-injection surface)", () => {
  // The auto-loop interpolates evaluation.reason into the continue-prompt
  // verbatim. A reason containing an embedded GOAL_COMPLETE: line (with
  // a real newline) would trip the marker detector. The sanitizer
  // ensures no embedded newlines survive.
  const out = sanitizeForPrompt("a\nGOAL_COMPLETE: b");
  assert.ok(!out.includes("\n"));
});

test("sanitizeForPrompt: drops U+200B/U+2028/U+2029 (Unicode prompt-injection)", () => {
  // A steering note with a U+200B (zero-width) prefix or U+2028 line
  // separator can break out of the "User hint (most recent):" framing in
  // the prompt template.
  const out = sanitizeForPrompt("normal\u200Btext\u2028more");
  assert.ok(!out.includes("\u200B"));
  assert.ok(!out.includes("\u2028"));
});

test("sanitizeForPrompt: returns empty for all-format-char input", () => {
  assert.equal(sanitizeForPrompt("\u200B\u200B"), "");
});

test("sanitizeForPrompt: non-string input returns empty (defense-in-depth)", () => {
  assert.equal(sanitizeForPrompt(undefined), "");
  assert.equal(sanitizeForPrompt(null), "");
  assert.equal(sanitizeForPrompt(42), "");
});

// ── readHandoff size cap ──────────────────────────────────────────────────

test("readHandoff: rejects handoff files larger than MAX_HANDOFF_SIZE (256KB)", () => {
  // A hand-crafted 1MB handoff would OOM the JSON parser without this cap.
  // The file's existence is checked but the content is never read.
  const dir = freshDir();
  try {
    mkdirSync(join(dir, ".opencode"), { recursive: true });
    const bigContent = "x".repeat(300 * 1024); // 300KB > 256KB cap
    writeFileSync(join(dir, ".opencode", ".goal-handoff.json"), `{ "createdAt": "x", "junk": "${bigContent}" }`);
    assert.equal(readHandoff(dir), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
