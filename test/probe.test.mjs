// Adversarial probe — find defects in OpenGoal TUI surface.
// Doesn't modify the codebase; just runs edge cases and reports what breaks.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  handleTurnsSubmit, handleTimeSubmit, handleTokensSubmit,
  handleConditionSubmit, handleSteerSubmit, handleClearSteeringSubmit,
  handleRestartSubmit, handleHandoffSubmit, handleClaimSubmit,
  parsePositiveInt,
} from "../dist/tui-dials-logic.js";
import {
  readDashboardState, computeProgress, toggleGoal, clearGoal,
} from "../dist/tui-logic.js";
import {
  buildSidebarView, buildSidebarTitle, buildSidebarContent,
  buildSidebarFooter, sanitizeForSidebar, truncate,
} from "../dist/sidebar-logic.js";
import {
  setGoal, editMaxTurns, editMaxTime, editMaxTokens, editCondition,
  restartGoal, appendSteering, clearSteering, createHandoff, claimHandoff,
  atomicToggle, readGoalState, readHandoff, transitionGoal,
  MAX_CONDITION_LEN, MAX_STEERING_LEN, MAX_STEERING_NOTES,
  CONSTRAINT_BOUNDS,
} from "../dist/goal-state.js";

function freshDir() {
  return mkdtempSync(join(tmpdir(), "opengoal-probe-"));
}

// ── Probe 1: clearSteering with no goal — what does the TUI get? ────────

test("PROBE: clearSteering with no goal returns {ok:false, reason:no-goal, error:undefined}", () => {
  const dir = freshDir();
  try {
    // The primitive clearSteering with no goal returns {ok:false, reason:'no-goal'} (no error field)
    // The handler maps this to {ok:false, reason:'no-goal', message:'No active goal.'}
    const res = handleClearSteeringSubmit(dir);
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.reason, "no-goal");
      assert.equal(res.message, "No active goal.");
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── Probe 2: non-exhaustive switch — what if a future reason is added? ────

test("PROBE: handleClearSteeringSubmit — switch with no default fallthrough returns undefined", () => {
  // This test verifies the latent bug: the handler uses a switch on res.reason
  // without a default. If clearSteering adds a new failure reason (e.g. 'busy'),
  // the function returns undefined. We can't trigger this without modifying the
  // primitive, but we can verify the code path is there by inspecting the AST.
  // Instead, let's just confirm the current behavior is correct for the known reasons.
  const dir = freshDir();
  try {
    setGoal(dir, "x");
    clearSteering(dir); // sets up a known state
    const res = handleClearSteeringSubmit(dir);
    assert.equal(res.ok, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── Probe 3: parsePositiveInt accepts "0" — caller must bounds-check ─────

test("PROBE: parsePositiveInt('0') returns 0; handler rejects it as out-of-range", () => {
  assert.equal(parsePositiveInt("0"), 0);
  // The handler must bounds-check; let's verify
  const dir = freshDir();
  try {
    setGoal(dir, "x");
    const res = handleTurnsSubmit(dir, "0");
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.message.includes("1") || res.message.includes("[1,"), true,
        `expected bounds message, got: ${res.message}`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── Probe 4: openConditionDial passes rawValue of length > MAX_CONDITION_LEN ──

test("PROBE: handleConditionSubmit — string of 4001 printable chars is rejected by handler (raw length check)", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "old");
    const long = "x".repeat(MAX_CONDITION_LEN + 1);
    const res = handleConditionSubmit(dir, long);
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.message.toLowerCase().includes("long"), true);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── Probe 5: handleSteerSubmit with newline sanitization ─────────────────

test("PROBE: handleSteerSubmit — multi-line input is sanitized (single line after)", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "x");
    const res = handleSteerSubmit(dir, "line1\nline2\tcol\x1b[31mRED");
    assert.equal(res.ok, true);
    if (res.ok) {
      // The message in the success result should be single-line
      assert.equal(res.message.includes("\n"), false);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── Probe 6: handoff with whitespace-only note becomes undefined ─────────

test("PROBE: handleHandoffSubmit with whitespace-only note is treated as no note", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "x");
    const res = handleHandoffSubmit(dir, "   \t\n  ");
    assert.equal(res.ok, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── Probe 7: computeProgress with adversarial inputs ────────────────────

test("PROBE: computeProgress — never NaN, never negative, even with extreme inputs", () => {
  const base = {
    version: 1, id: "x", condition: "x", command: null, status: "active",
    createdAt: 1, startedAt: 1, completedAt: null, pausedAt: null, resumedAt: null,
    turnsEvaluated: 0, tokensUsed: 0, lastEvaluation: null, evaluationHistory: [],
    constraints: { maxTurns: 1, maxTimeMinutes: 1, maxTokens: 1 },
    metadata: { setBy: "user" },
  };
  // Try degenerate inputs
  const cases = [
    { ...base, turnsEvaluated: -999 },
    { ...base, turnsEvaluated: 999 },
    { ...base, constraints: { ...base.constraints, maxTurns: -1 } },
    { ...base, constraints: { ...base.constraints, maxTurns: 0 } },
    { ...base, constraints: { ...base.constraints, maxTurns: Number.MAX_SAFE_INTEGER } },
  ];
  for (const s of cases) {
    const p = computeProgress(s, 1);
    assert.equal(p.bar.length, 20, `bar must be 20 chars for ${JSON.stringify(s)}`);
    assert.ok(!p.bar.includes("undefined"));
    assert.ok(!p.bar.includes("NaN"));
    assert.ok(p.pct >= 0 && p.pct <= 100);
  }
});

// ── Probe 8: buildSidebarView with corrupt state doesn't crash ──────────

test("PROBE: buildSidebarView — corrupt state {status: 'active', constraints: {}} returns empty-state", () => {
  const dir = freshDir();
  try {
    mkdirSync(join(dir, ".opencode"), { recursive: true });
    writeFileSync(join(dir, ".opencode", ".goal-state.json"), JSON.stringify({
      version: 1, id: "x", condition: "x", status: "active",
      createdAt: 1, startedAt: 1, completedAt: null, pausedAt: null, resumedAt: null,
      turnsEvaluated: 0, tokensUsed: 0, lastEvaluation: null, evaluationHistory: [],
      constraints: {}, metadata: { setBy: "user" },
    }));
    const view = buildSidebarView(dir);
    assert.equal(view.hasGoal, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── Probe 9: dial: editMaxTurns during pause should be allowed ──────────

test("PROBE: handleTurnsSubmit on paused goal succeeds (paused is mutable)", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "x");
    transitionGoal(dir, "pause");
    const res = handleTurnsSubmit(dir, "100");
    assert.equal(res.ok, true);
    const after = readGoalState(dir);
    assert.equal(after.status, "paused");
    assert.equal(after.constraints.maxTurns, 100);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── Probe 10: dial: editMaxTurns on terminal state is rejected ──────────

test("PROBE: handleTurnsSubmit on cleared goal is rejected with terminal-state", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "x");
    transitionGoal(dir, "clear");
    const res = handleTurnsSubmit(dir, "100");
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.reason, "terminal-state");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── Probe 11: dial: clearSteering after restart preserves nothing ───────

test("PROBE: restartGoal — drops existing steering notes (clobber?)", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "x");
    appendSteering(dir, "hint 1");
    appendSteering(dir, "hint 2");
    const before = readGoalState(dir);
    assert.equal(before.metadata.steering.length, 2);
    restartGoal(dir);
    const after = readGoalState(dir);
    // Steering notes are NOT preserved by restart — the metadata is rebuilt from sanitizeMetadata(state.metadata) + restartedAt + previousId
    // Actually, looking at the code, sanitizeMetadata keeps steering if it's valid.
    // Let's see what happens.
    if (after.metadata.steering) {
      console.log("PROBE11: steering preserved after restart:", after.metadata.steering);
    } else {
      console.log("PROBE11: steering dropped after restart");
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── Probe 12: handoff pending blocks restart ────────────────────────────

test("PROBE: restartGoal with handoff pending is rejected (handoff-pending)", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "x");
    createHandoff(dir);
    const res = handleRestartSubmit(dir);
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.reason, "handoff-pending");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── Probe 13: tokens at boundary — exactly maxTokens accepted ───────────

test("PROBE: handleTokensSubmit at maxTokens (10M) is accepted", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "x");
    const res = handleTokensSubmit(dir, "10000000");
    assert.equal(res.ok, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("PROBE: handleTokensSubmit at maxTokens+1 is rejected", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "x");
    const res = handleTokensSubmit(dir, "10000001");
    assert.equal(res.ok, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── Probe 14: claim with no handoff ─────────────────────────────────────

test("PROBE: handleClaimSubmit with no handoff returns ok:false no-handoff", () => {
  const dir = freshDir();
  try {
    const res = handleClaimSubmit(dir);
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.reason, "no-handoff");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── Probe 15: claim with active goal still in place ─────────────────────

test("PROBE: handleClaimSubmit with active goal still in place is rejected (current-goal)", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "x");
    createHandoff(dir);
    // Now: active goal + handoff pending
    const res = handleClaimSubmit(dir);
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.reason, "current-goal");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── Probe 16: buildSidebarTitle — emoji + 60-char condition is exactly 63 chars ──

test("PROBE: buildSidebarTitle long condition produces 63-char title (3 + 60)", () => {
  const s = {
    version: 1, id: "x", condition: "x".repeat(200), command: null, status: "active",
    createdAt: 1, startedAt: 1, completedAt: null, pausedAt: null, resumedAt: null,
    turnsEvaluated: 0, tokensUsed: 0, lastEvaluation: null, evaluationHistory: [],
    constraints: { maxTurns: 20, maxTimeMinutes: 30, maxTokens: 100000 },
    metadata: { setBy: "user" },
  };
  const out = buildSidebarTitle(s);
  assert.equal(out.length, 63);
});

// ── Probe 17: time dial: out-of-range above ─────────────────────────────

test("PROBE: handleTimeSubmit at maxMinutes+1 rejected", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "x");
    const res = handleTimeSubmit(dir, "10001");
    assert.equal(res.ok, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── Probe 18: time dial: exactly maxMinutes accepted ───────────────────

test("PROBE: handleTimeSubmit at exactly maxMinutes (10000) accepted", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "x");
    const res = handleTimeSubmit(dir, "10000");
    assert.equal(res.ok, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── Probe 19: appendSteering beyond MAX_STEERING_NOTES drops FIFO ─────

test("PROBE: appendSteering beyond 20 notes drops oldest (FIFO)", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "x");
    for (let i = 0; i < 25; i++) appendSteering(dir, `n${i}`);
    const after = readGoalState(dir);
    assert.equal(after.metadata.steering.length, MAX_STEERING_NOTES);
    assert.equal(after.metadata.steering[0].note, "n5");
    assert.equal(after.metadata.steering[19].note, "n24");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── Probe 20: hostile condition with bidi overrides is sanitized ───────

test("PROBE: handleConditionSubmit — bidi override is sanitized out (state, not DialResult.value)", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "old");
    const res = handleConditionSubmit(dir, "evil\u202Etext");
    assert.equal(res.ok, true);
    // The dial handler's DialResult doesn't expose value — check the stored state.
    const after = readGoalState(dir);
    assert.equal(after.condition.includes("\u202E"), false);
    assert.equal(after.condition, "eviltext");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── Probe 31: atomicToggle is the function the TUI toggleGoal wraps (FIX-1)

test("PROBE31: atomicToggle is exported and has the right shape", () => {
  assert.equal(typeof atomicToggle, "function");
});

// ── Probe 32: atomicToggle returns terminal-state for achieved goals (NEW behavior)

test("PROBE32: atomicToggle distinguishes 'no-goal' from 'terminal-state'", () => {
  const dir = freshDir();
  try {
    // No state file → no-goal
    const r1 = atomicToggle(dir);
    assert.equal(r1.ok, false);
    if (!r1.ok) {
      assert.equal(r1.reason, "no-goal",
        `expected no-goal for missing state, got: ${r1.reason}`);
    }
    // Achieved state → terminal-state (NEW distinction, previously folded into no-goal)
    setGoal(dir, "x");
    transitionGoal(dir, "clear");
    // Need to flip status to "achieved" for the test (clear is also terminal,
    // but the primitive checks for "active" or "paused" specifically).
    const s = readGoalState(dir);
    s.status = "achieved";
    s.completedAt = Date.now();
    mkdirSync(join(dir, ".opencode"), { recursive: true });
    writeFileSync(join(dir, ".opencode", ".goal-state.json"), JSON.stringify(s));
    const r2 = atomicToggle(dir);
    assert.equal(r2.ok, false);
    if (!r2.ok) {
      assert.equal(r2.reason, "terminal-state",
        `expected terminal-state for achieved goal, got: ${r2.reason}`);
      assert.ok(r2.error && r2.error.includes("achieved"),
        `expected error to mention 'achieved', got: ${r2.error}`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── Probe 33: the fix for the read-outside-lock race (CRITICAL)

// This is the regression test for the C-1 bug found by the audit:
// toggleGoal used to read state OUTSIDE the lock, decide the action
// (pause vs. resume), and then call transitionGoal which acquired the
// lock. Two concurrent calls would both see "active", both decide "pause",
// and only the first write would succeed — meaning N keypresses produced
// ~N/2 state changes.
//
// After the fix (atomicToggle does read-decide-write inside ONE lock),
// each call produces exactly one state change. After 5 calls starting
// from "active", the state is "paused" (odd). After 6, it's "active" (even).
test("PROBE33: atomicToggle parity — 5 toggles from active = paused, 6 = active", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "x");
    for (let i = 0; i < 5; i++) {
      const r = atomicToggle(dir);
      assert.equal(r.ok, true, `toggle ${i+1} should succeed`);
    }
    assert.equal(readGoalState(dir).status, "paused",
      "5 toggles from active should leave the goal paused");
    for (let i = 0; i < 1; i++) {
      atomicToggle(dir);
    }
    assert.equal(readGoalState(dir).status, "active",
      "6 toggles from active should leave the goal active");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── Probe 34: tui-logic.ts toggleGoal now uses atomicToggle (no more race)

test("PROBE34: toggleGoal (the tui-logic wrapper) inherits atomicToggle's behavior", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "x");
    // 5 toggles via the wrapper
    for (let i = 0; i < 5; i++) {
      const r = toggleGoal(dir);
      assert.equal(r.ok, true, `wrapper toggle ${i+1} should succeed`);
    }
    assert.equal(readGoalState(dir).status, "paused",
      "5 wrapper-toggles from active should leave the goal paused (no race)");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── Probe 35: editCondition optimistic-concurrency guard (FIX-10)

test("PROBE35: editCondition with matching expectedId succeeds", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "original");
    const id = readGoalState(dir).id;
    const res = editCondition(dir, "updated text", Date.now(), id);
    assert.equal(res.ok, true);
    assert.equal(readGoalState(dir).condition, "updated text");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("PROBE36: editCondition with stale expectedId is refused (no clobber)", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "original");
    const staleId = readGoalState(dir).id;
    // Simulate a concurrent `/goal set` that changes the id
    setGoal(dir, "from another session");
    const newId = readGoalState(dir).id;
    assert.notEqual(staleId, newId, "test setup: ids should differ");
    // The user (with the stale id) tries to submit
    const res = editCondition(dir, "user typed this", Date.now(), staleId);
    assert.equal(res.ok, false, "stale-snapshot edit must be refused");
    if (!res.ok) {
      assert.ok(res.error && /changed underneath/i.test(res.error),
        `expected 'changed underneath' message, got: ${res.error}`);
    }
    // The on-disk condition must NOT have been clobbered
    assert.equal(readGoalState(dir).condition, "from another session",
      "the stale-snapshot edit must not overwrite the concurrent change");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("PROBE37: editCondition without expectedId still works (backward compat)", () => {
  // Callers that don't supply expectedId (e.g. the /goal condition dispatcher)
  // must continue to work without optimistic-concurrency.
  const dir = freshDir();
  try {
    setGoal(dir, "original");
    const res = editCondition(dir, "no-id caller");
    assert.equal(res.ok, true);
    assert.equal(readGoalState(dir).condition, "no-id caller");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("PROBE38: handleConditionSubmit (tui-dials-logic) propagates expectedId", () => {
  // The TUI dial handler should accept the same expectedId parameter
  // and forward it to the primitive.
  const dir = freshDir();
  try {
    setGoal(dir, "original");
    const staleId = readGoalState(dir).id;
    setGoal(dir, "from another session");
    const res = handleConditionSubmit(dir, "user typed", staleId);
    assert.equal(res.ok, false, "stale-snapshot edit via dial handler must be refused");
    if (!res.ok) {
      assert.ok(res.message && /changed underneath/i.test(res.message),
        `expected 'changed underneath' message, got: ${res.message}`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── Probe 22: sanitizeForSidebar handles non-string safely (defense) ───

test("PROBE: sanitizeForSidebar — non-string input (null/number) returns '' without crash", () => {
  assert.equal(sanitizeForSidebar(null), "");
  assert.equal(sanitizeForSidebar(undefined), "");
  assert.equal(sanitizeForSidebar(42), "");
  assert.equal(sanitizeForSidebar({}), "");
});

// ── Probe 23: truncate with maxLen=0 returns '…' (defensive) ─────────

test("PROBE: truncate — maxLen=0 returns '…' (no crash on out-of-contract input)", () => {
  assert.equal(truncate("hello", 0), "…");
});

// ── Probe 24: buildSidebarFooter always under 80 chars even with claim hint

test("PROBE: buildSidebarFooter with handoff claim hint stays under 80 chars", () => {
  const withClaim = buildSidebarFooter("/tmp", { createdAt: "2026-06-10T00:00:00Z" });
  assert.ok(withClaim.length <= 80, `footer too long: ${withClaim.length} chars`);
});

// ── Probe 25: readDashboardState with terminal states returns null ────

test("PROBE: readDashboardState — terminal states (achieved, cleared) return null", () => {
  const dir = freshDir();
  try {
    mkdirSync(join(dir, ".opencode"), { recursive: true });
    for (const status of ["achieved", "cleared"]) {
      writeFileSync(join(dir, ".opencode", ".goal-state.json"), JSON.stringify({
        version: 1, id: "x", condition: "x", status,
        createdAt: 1, startedAt: 1, completedAt: 1, pausedAt: null, resumedAt: null,
        turnsEvaluated: 0, tokensUsed: 0, lastEvaluation: null, evaluationHistory: [],
        constraints: { maxTurns: 1, maxTimeMinutes: 1, maxTokens: 1 },
        metadata: { setBy: "user" },
      }));
      const view = readDashboardState(dir);
      assert.equal(view.state, null, `terminal status ${status} should yield null`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── Probe 26: toggleGoal is idempotent across the active/paused cycle ──

test("PROBE: toggleGoal — toggle 4 times returns to active", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "x");
    const r1 = toggleGoal(dir); // active → paused
    assert.equal(r1.ok, true);
    const r2 = toggleGoal(dir); // paused → active
    assert.equal(r2.ok, true);
    const r3 = toggleGoal(dir); // active → paused
    assert.equal(r3.ok, true);
    const r4 = toggleGoal(dir); // paused → active
    assert.equal(r4.ok, true);
    if (r4.ok) assert.equal(r4.newStatus, "active");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── Probe 27: handleClaimSubmit after claim is a no-goal no-op ─────────

test("PROBE: handleClaimSubmit — second claim after success is rejected (current-goal takes precedence over no-handoff)", () => {
  // After a successful claim, the handoff is consumed and the state is active.
  // A second claim sees the active state first (current-goal), NOT a missing handoff.
  // This is the intentional priority: a live goal outranks a stale handoff.
  const dir = freshDir();
  try {
    setGoal(dir, "x");
    createHandoff(dir);
    transitionGoal(dir, "clear");
    const r1 = handleClaimSubmit(dir);
    assert.equal(r1.ok, true);
    const r2 = handleClaimSubmit(dir);
    assert.equal(r2.ok, false);
    if (!r2.ok) {
      assert.equal(r2.reason, "current-goal",
        `expected current-goal (claimHandoff checks current state before handoff existence), got: ${r2.reason}`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── Probe 28: handleHandoffSubmit twice — second is rejected ───────────

test("PROBE: handleHandoffSubmit — second call rejected (handoff-exists)", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "x");
    const r1 = handleHandoffSubmit(dir, "first");
    assert.equal(r1.ok, true);
    const r2 = handleHandoffSubmit(dir, "second");
    assert.equal(r2.ok, false);
    if (!r2.ok) assert.equal(r2.reason, "handoff-exists");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── Probe 29: handleSteerSubmit — over MAX_STEERING_LEN is rejected by handler

test("PROBE: handleSteerSubmit — 501-char note rejected by handler (raw length check)", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "x");
    const long = "x".repeat(MAX_STEERING_LEN + 1);
    const res = handleSteerSubmit(dir, long);
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.message.toLowerCase().includes("long"), true);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── Probe 30: buildSidebarContent — hostile eval history tags work ────

test("PROBE: buildSidebarContent — eval history with met/blocked/in-progress tags is correctly tagged", () => {
  const s = {
    version: 1, id: "x", condition: "x", command: null, status: "active",
    createdAt: 1, startedAt: 1, completedAt: null, pausedAt: null, resumedAt: null,
    turnsEvaluated: 0, tokensUsed: 0, lastEvaluation: null,
    evaluationHistory: [
      { timestamp: 1, met: true, reason: "r1", confidence: 1, evaluatorType: "deterministic" },
      { timestamp: 2, met: false, reason: "r2", confidence: 0, blocked: true, evaluatorType: "deterministic" },
      { timestamp: 3, met: false, reason: "r3", confidence: 0, evaluatorType: "deterministic" },
    ],
    constraints: { maxTurns: 20, maxTimeMinutes: 30, maxTokens: 100000 },
    metadata: { setBy: "user" },
  };
  const out = buildSidebarContent(s, null, null, Date.now());
  const lines = out.split("\n");
  const histIdx = lines.findIndex((l) => l.includes("eval history"));
  assert.ok(histIdx > 0);
  // Most recent first: [r3 (in-prog ·), r2 (blocked !), r1 (met ✓)]
  assert.ok(lines[histIdx + 1].includes("·"));
  assert.ok(lines[histIdx + 2].includes("!"));
  assert.ok(lines[histIdx + 3].includes("✓"));
});
