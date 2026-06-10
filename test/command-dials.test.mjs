/**
 * Tests for the v0.2.0+ dial commands in the /goal dispatcher.
 *
 * Each dial is a thin wrapper around a `goal-state` primitive. The
 * dispatcher parses the argument, calls the primitive, and relays the
 * result. The tests exercise the parsing, the result relay, the error
 * cases, and the help-text fallback.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dispatchGoalCommand } from "../dist/command.js";
import { readGoalState, editMaxTurns, appendSteering } from "../dist/goal-state.js";

function freshDir() {
  return mkdtempSync(join(tmpdir(), "opengoal-dialcmd-"));
}

function setupGoal(dir) {
  dispatchGoalCommand(dir, 'set "do the thing"');
}

// ── /goal turns ────────────────────────────────────────────────────────────

test("/goal turns 50: updates maxTurns", () => {
  const dir = freshDir();
  try {
    setupGoal(dir);
    const out = dispatchGoalCommand(dir, "turns 50");
    assert.match(out, /Max turns: 20 → 50/);
    assert.equal(readGoalState(dir).constraints.maxTurns, 50);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("/goal turns abc: returns usage hint", () => {
  const dir = freshDir();
  try {
    setupGoal(dir);
    const out = dispatchGoalCommand(dir, "turns abc");
    assert.match(out, /Usage: \/goal turns/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("/goal turns (no arg): returns usage hint", () => {
  const dir = freshDir();
  try {
    setupGoal(dir);
    const out = dispatchGoalCommand(dir, "turns");
    assert.match(out, /Usage: \/goal turns/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("/goal turns 0: clamped-rejection error relayed to user", () => {
  const dir = freshDir();
  try {
    setupGoal(dir);
    const out = dispatchGoalCommand(dir, "turns 0");
    // The primitive's error message is specific: "maxTurns must be in [1, 10000]."
    assert.match(out, /maxTurns must be in/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── /goal time ─────────────────────────────────────────────────────────────

test("/goal time 60: updates maxTimeMinutes", () => {
  const dir = freshDir();
  try {
    setupGoal(dir);
    const out = dispatchGoalCommand(dir, "time 60");
    assert.match(out, /Max time: 30 → 60/);
    assert.equal(readGoalState(dir).constraints.maxTimeMinutes, 60);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("/goal time abc: usage hint", () => {
  const dir = freshDir();
  try {
    setupGoal(dir);
    const out = dispatchGoalCommand(dir, "time abc");
    assert.match(out, /Usage: \/goal time/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── /goal tokens ───────────────────────────────────────────────────────────

test("/goal tokens 200000: updates maxTokens", () => {
  const dir = freshDir();
  try {
    setupGoal(dir);
    const out = dispatchGoalCommand(dir, "tokens 200000");
    assert.match(out, /Max tokens: 100000 → 200000/);
    assert.equal(readGoalState(dir).constraints.maxTokens, 200000);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── /goal condition ───────────────────────────────────────────────────────

test('/goal condition "new text": updates condition', () => {
  const dir = freshDir();
  try {
    setupGoal(dir);
    const out = dispatchGoalCommand(dir, 'condition "new text"');
    assert.match(out, /Condition updated/);
    assert.equal(readGoalState(dir).condition, "new text");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('/goal condition (no arg): usage hint', () => {
  const dir = freshDir();
  try {
    setupGoal(dir);
    const out = dispatchGoalCommand(dir, "condition");
    assert.match(out, /Usage: \/goal condition/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('/goal condition "same text": identical rejection', () => {
  const dir = freshDir();
  try {
    setupGoal(dir);
    const out = dispatchGoalCommand(dir, 'condition "do the thing"');
    assert.match(out, /identical/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── /goal steer ────────────────────────────────────────────────────────────

test('/goal steer "try lib X": appends steering note', () => {
  const dir = freshDir();
  try {
    setupGoal(dir);
    const out = dispatchGoalCommand(dir, 'steer "try lib X next"');
    assert.match(out, /Steering note added/);
    const after = readGoalState(dir);
    assert.equal(after.metadata.steering.length, 1);
    assert.equal(after.metadata.steering[0].note, "try lib X next");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('/goal steer (no arg): usage hint', () => {
  const dir = freshDir();
  try {
    setupGoal(dir);
    const out = dispatchGoalCommand(dir, "steer");
    assert.match(out, /Usage: \/goal steer/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('/goal steer with control chars is sanitized', () => {
  const dir = freshDir();
  try {
    setupGoal(dir);
    const out = dispatchGoalCommand(dir, 'steer "line1\nline2\x1b[31m"');
    assert.match(out, /Steering note added/);
    const after = readGoalState(dir);
    assert.ok(!after.metadata.steering[0].note.includes("\n"));
    assert.ok(!after.metadata.steering[0].note.includes("\x1b"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── /goal unsteer ──────────────────────────────────────────────────────────

test("/goal unsteer: clears all steering notes", () => {
  const dir = freshDir();
  try {
    setupGoal(dir);
    appendSteering(dir, "n1");
    appendSteering(dir, "n2");
    const out = dispatchGoalCommand(dir, "unsteer");
    assert.match(out, /Cleared 2/);
    assert.equal(readGoalState(dir).metadata.steering, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("/goal unsteer with no notes: tells the user there were none", () => {
  const dir = freshDir();
  try {
    setupGoal(dir);
    const out = dispatchGoalCommand(dir, "unsteer");
    assert.match(out, /No steering notes/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── /goal restart ──────────────────────────────────────────────────────────

test("/goal restart: gives a new id, preserves condition", () => {
  const dir = freshDir();
  try {
    setupGoal(dir);
    const oldId = readGoalState(dir).id;
    const out = dispatchGoalCommand(dir, "restart");
    assert.match(out, /Goal restarted/);
    assert.notEqual(readGoalState(dir).id, oldId);
    assert.equal(readGoalState(dir).condition, "do the thing");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("/goal restart with no goal: error relayed", () => {
  const dir = freshDir();
  try {
    const out = dispatchGoalCommand(dir, "restart");
    assert.match(out, /No active goal/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── /goal handoff ──────────────────────────────────────────────────────────

test("/goal handoff with note: creates handoff", () => {
  const dir = freshDir();
  try {
    setupGoal(dir);
    const out = dispatchGoalCommand(dir, 'handoff "for next session"');
    assert.match(out, /Handoff written/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("/goal handoff (no note): creates handoff", () => {
  const dir = freshDir();
  try {
    setupGoal(dir);
    const out = dispatchGoalCommand(dir, "handoff");
    assert.match(out, /Handoff written/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("/goal handoff twice: refuses the second", () => {
  const dir = freshDir();
  try {
    setupGoal(dir);
    dispatchGoalCommand(dir, "handoff");
    const out = dispatchGoalCommand(dir, "handoff");
    assert.match(out, /already pending/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── /goal claim ────────────────────────────────────────────────────────────

test("/goal claim with handoff: resumes state", () => {
  const dir = freshDir();
  try {
    setupGoal(dir);
    dispatchGoalCommand(dir, "handoff");
    dispatchGoalCommand(dir, "clear");
    const out = dispatchGoalCommand(dir, "claim");
    assert.match(out, /Handoff claimed/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("/goal claim with no handoff: error", () => {
  const dir = freshDir();
  try {
    const out = dispatchGoalCommand(dir, "claim");
    assert.match(out, /No handoff/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── /goal help / unknown action ────────────────────────────────────────────
// Note: the dispatcher's "Unknown /goal action" branch is currently
// unreachable because every first-word in KNOWN_ACTIONS has a handler.
// It's defensive code: if a future maintainer adds a verb to KNOWN_ACTIONS
// without wiring a handler, the user gets a clear error rather than a
// silent fall-through. We don't test the branch directly because we can't
// trigger it without breaking the parser. Instead, the help-text fallback
// is covered by the "Usage: /goal turns" tests above.

// ── No goal, dial commands: each reports no-goal ──────────────────────────

test("/goal turns with no goal: no-goal error", () => {
  const dir = freshDir();
  try {
    const out = dispatchGoalCommand(dir, "turns 50");
    assert.match(out, /No active goal/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("/goal time with no goal: no-goal error", () => {
  const dir = freshDir();
  try {
    const out = dispatchGoalCommand(dir, "time 60");
    assert.match(out, /No active goal/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("/goal tokens with no goal: no-goal error", () => {
  const dir = freshDir();
  try {
    const out = dispatchGoalCommand(dir, "tokens 200000");
    assert.match(out, /No active goal/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("/goal restart with no goal: no-goal error", () => {
  const dir = freshDir();
  try {
    const out = dispatchGoalCommand(dir, "restart");
    assert.match(out, /No active goal/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── Dispatcher locksstep with primitive: handler and primitive accept same range ─

test("/goal turns accepts what editMaxTurns accepts (consistency)", () => {
  const dir = freshDir();
  try {
    setupGoal(dir);
    for (const v of [1, 50, 1000, 10000]) {
      // Reset the goal because each call mutates
      setupGoal(dir);
      const out = dispatchGoalCommand(dir, `turns ${v}`);
      assert.match(out, /Max turns/);
      setupGoal(dir);
      assert.equal(editMaxTurns(dir, v).ok, true);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
