/**
 * Tests for the structured dispatcher result envelope (Task 3).
 *
 * The refactor: `dispatchGoalCommand` becomes a thin presenter over
 * `dispatchGoalCommandStructured`, which returns a typed envelope
 * `{ kind, message, agentExtras? }`. The CLI uses the envelope for
 * exit codes and clean output; the prose function (used by the
 * OpenCode agent) reproduces the byte-identical strings.
 *
 * These tests pin the envelope's kind-per-action mapping. The
 * prose-identity is covered separately in
 * `test/command-prose-identity.test.mjs`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dispatchGoalCommandStructured, KIND_TO_EXIT } from "../dist/command.js";
import { createHandoff } from "../dist/goal-state.js";

function freshDir() {
  return mkdtempSync(join(tmpdir(), "opengoal-env-"));
}

function plantActiveGoal(dir) {
  mkdirSync(join(dir, ".opencode"), { recursive: true });
  const state = {
    version: 1, id: "x", condition: "x", command: null, status: "active",
    createdAt: 1, startedAt: 1, completedAt: null, pausedAt: null, resumedAt: null,
    turnsEvaluated: 0, tokensUsed: 0, lastEvaluation: null, evaluationHistory: [],
    constraints: { maxTurns: 20, maxTimeMinutes: 30, maxTokens: 100000 },
    metadata: { setBy: "user" },
  };
  writeFileSync(join(dir, ".opencode", ".goal-state.json"), JSON.stringify(state));
}

// ── kind per action ─────────────────────────────────────────────────────────

test("envelope: set → kind='set' with agentExtras", () => {
  const dir = freshDir();
  try {
    const res = dispatchGoalCommandStructured(dir, "set capture-me");
    assert.equal(res.kind, "set");
    assert.match(res.message, /GOAL: capture-me/);
    assert.ok(res.agentExtras, "set must populate agentExtras");
    assert.match(res.agentExtras, /How to proceed:/);
    assert.match(res.agentExtras, /Begin now\.$/);
    // Pin the split: message is BEFORE the How to proceed block,
    // agentExtras is the agent-prompt scaffolding.
    assert.ok(!res.message.includes("How to proceed:"),
      `message must not contain 'How to proceed'; got: ${res.message}`);
    assert.ok(!res.message.includes("Begin now."),
      `message must not contain 'Begin now.'; got: ${res.message}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("envelope: view → kind='success', message is the status block", () => {
  const dir = freshDir();
  try {
    plantActiveGoal(dir);
    const res = dispatchGoalCommandStructured(dir, "view");
    assert.equal(res.kind, "success");
    assert.match(res.message, /Condition: x/);
    assert.equal(res.agentExtras, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("envelope: pause (active → paused) → kind='success'", () => {
  const dir = freshDir();
  try {
    plantActiveGoal(dir);
    const res = dispatchGoalCommandStructured(dir, "pause");
    assert.equal(res.kind, "success");
    assert.match(res.message, /Goal paused/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("envelope: turns abc → kind='usage'", () => {
  const dir = freshDir();
  try {
    plantActiveGoal(dir);
    const res = dispatchGoalCommandStructured(dir, "turns abc");
    assert.equal(res.kind, "usage");
    assert.match(res.message, /Usage: \/goal turns/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("envelope: pause (no goal) → kind='no-goal'", () => {
  const dir = freshDir();
  try {
    const res = dispatchGoalCommandStructured(dir, "pause");
    assert.equal(res.kind, "no-goal");
    assert.match(res.message, /No active goal/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("envelope: editMax* with invalid value → kind='invalid-value'", () => {
  const dir = freshDir();
  try {
    plantActiveGoal(dir);
    const res = dispatchGoalCommandStructured(dir, "turns 99999");
    assert.equal(res.kind, "invalid-value");
    // The primitive's message is "maxTurns must be in [1, 10000]."
    assert.match(res.message, /maxTurns must be in/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("envelope: handoff twice → kind='handoff-exists'", () => {
  const dir = freshDir();
  try {
    plantActiveGoal(dir);
    createHandoff(dir, "first");
    const res = dispatchGoalCommandStructured(dir, "handoff second");
    assert.equal(res.kind, "handoff-exists");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("envelope: claim with no handoff → kind='no-handoff'", () => {
  const dir = freshDir();
  try {
    const res = dispatchGoalCommandStructured(dir, "claim");
    assert.equal(res.kind, "no-handoff");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("envelope: claim with active goal → kind='current-goal'", () => {
  const dir = freshDir();
  try {
    plantActiveGoal(dir);
    createHandoff(dir, "pending");
    const res = dispatchGoalCommandStructured(dir, "claim");
    assert.equal(res.kind, "current-goal");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("envelope: editMax* on terminal goal → kind='terminal-state'", () => {
  const dir = freshDir();
  try {
    plantActiveGoal(dir);
    // Move to terminal state by clearing
    dispatchGoalCommandStructured(dir, "clear");
    const res = dispatchGoalCommandStructured(dir, "turns 50");
    assert.equal(res.kind, "terminal-state");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── Round 2 (R2-1): transitionGoal reason-field refactor ─────────────────

test("R2-1: clear with no goal → kind='no-goal' (was 'write-failed')", () => {
  // Bug: clear with no goal currently maps to kind='write-failed'
  // (exit 3) because the clear branch falls through without a
  // reason-switch. After R2-1 it maps to kind='no-goal' (exit 2).
  const dir = freshDir();
  try {
    const res = dispatchGoalCommandStructured(dir, "clear");
    assert.equal(res.kind, "no-goal", `clear with no goal should be 'no-goal', got: ${res.kind}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("R2-1: resume when already active → kind='already-in-state' (was 'write-failed')", () => {
  // Bug: resume from active → active returns "Goal is already active."
  // which currently falls through to write-failed. After R2-1 it
  // maps to already-in-state (exit 0; the no-op kind, mirroring
  // pause-from-paused).
  const dir = freshDir();
  try {
    plantActiveGoal(dir);
    const res = dispatchGoalCommandStructured(dir, "resume");
    assert.equal(res.kind, "already-in-state",
      `resume from active should be 'already-in-state', got: ${res.kind}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("R2-1: resume on an achieved goal → kind='terminal-state' (was 'write-failed')", () => {
  // Bug: "This goal was already achieved. Set a new goal instead." doesn't
  // match the old regex (it only checked "No active goal" and
  // "was cleared"). After R2-1 it maps to terminal-state (exit 2).
  const dir = freshDir();
  try {
    plantActiveGoal(dir);
    // Hand-edit the planted state to "achieved" status.
    mkdirSync(join(dir, ".opencode"), { recursive: true });
    const statePath = join(dir, ".opencode", ".goal-state.json");
    const cur = JSON.parse(readFileSync(statePath, "utf-8"));
    cur.status = "achieved";
    cur.completedAt = 1;
    writeFileSync(statePath, JSON.stringify(cur));
    const res = dispatchGoalCommandStructured(dir, "resume");
    assert.equal(res.kind, "terminal-state",
      `resume on achieved should be 'terminal-state', got: ${res.kind}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("R2-1: pause on cleared/achieved → kind='no-goal' (PIN already-correct)", () => {
  // The work order says this is already correct today via the regex
  // (the error "No active goal to pause." matches /No active goal/i).
  // Pin it so the R2-1 refactor (replacing regex with typed reason)
  // can't regress this case.
  const dir = freshDir();
  try {
    plantActiveGoal(dir);
    mkdirSync(join(dir, ".opencode"), { recursive: true });
    const statePath = join(dir, ".opencode", ".goal-state.json");
    const cur = JSON.parse(readFileSync(statePath, "utf-8"));
    cur.status = "cleared";
    cur.completedAt = 1;
    writeFileSync(statePath, JSON.stringify(cur));
    const res = dispatchGoalCommandStructured(dir, "pause");
    assert.equal(res.kind, "no-goal",
      `pause on cleared should be 'no-goal', got: ${res.kind}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── Adversarial A1: restart / handoff on terminal goal → kind='terminal-state' ──

test("A1: restart on cleared → kind='terminal-state' (was 'write-failed')", () => {
  // Bug: restartGoal returns reason='terminal-state' when the goal is
  // cleared/achieved, but the dispatcher's restart branch falls through
  // to write-failed because the terminal-state case isn't checked.
  const dir = freshDir();
  try {
    plantActiveGoal(dir);
    mkdirSync(join(dir, ".opencode"), { recursive: true });
    const statePath = join(dir, ".opencode", ".goal-state.json");
    const cur = JSON.parse(readFileSync(statePath, "utf-8"));
    cur.status = "cleared";
    cur.completedAt = 1;
    writeFileSync(statePath, JSON.stringify(cur));
    const res = dispatchGoalCommandStructured(dir, "restart");
    assert.equal(res.kind, "terminal-state",
      `restart on cleared should be 'terminal-state', got: ${res.kind}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("A1: handoff on cleared → kind='terminal-state' (was 'write-failed')", () => {
  // Bug: createHandoff returns reason='terminal-state' when the goal is
  // cleared/achieved, but the dispatcher's handoff branch falls through
  // to write-failed for the same reason as restart.
  const dir = freshDir();
  try {
    plantActiveGoal(dir);
    mkdirSync(join(dir, ".opencode"), { recursive: true });
    const statePath = join(dir, ".opencode", ".goal-state.json");
    const cur = JSON.parse(readFileSync(statePath, "utf-8"));
    cur.status = "achieved";
    cur.completedAt = 1;
    writeFileSync(statePath, JSON.stringify(cur));
    const res = dispatchGoalCommandStructured(dir, "handoff", "for-tomorrow");
    assert.equal(res.kind, "terminal-state",
      `handoff on achieved should be 'terminal-state', got: ${res.kind}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── The "poison" test: the bug this refactor kills ─────────────────────────

test("POISON: a condition containing 'Usage:' must NOT be mistaken for a usage error", () => {
  // The old `mapExitCode` regex-greps the human text. A goal condition
  // like 'document the Usage: section of the No active goal page'
  // would contain the literal "Usage:" substring and poison the exit
  // code of an otherwise-successful `status` call. The structured kind
  // is the only way to get this right.
  const dir = freshDir();
  try {
    const res = dispatchGoalCommandStructured(dir,
      `set document the Usage: section of the No active goal page`);
    assert.equal(res.kind, "set", "set must be kind='set' even with poison text in the condition");
    const view = dispatchGoalCommandStructured(dir, "view");
    assert.equal(view.kind, "success",
      `view must be kind='success' even though the goal text contains 'Usage:' and 'No active goal' substrings; got: ${view.kind}`);
    assert.equal(KIND_TO_EXIT[view.kind], 0, "view should exit 0");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── KIND_TO_EXIT coverage ───────────────────────────────────────────────────

test("KIND_TO_EXIT: all enum values have an exit code", () => {
  // Sanity: every kind in the enum has a non-undefined exit code.
  // Range widened to [0,4] in v0.4.2 (exit 4 = corrupt-state).
  for (const [kind, code] of Object.entries(KIND_TO_EXIT)) {
    assert.equal(typeof code, "number", `kind ${kind} should have a numeric exit code`);
    assert.ok(code >= 0 && code <= 4, `kind ${kind} exit code ${code} should be in [0,4]`);
  }
  // Spot-check the documented mappings.
  assert.equal(KIND_TO_EXIT.success, 0);
  assert.equal(KIND_TO_EXIT.set, 0);
  assert.equal(KIND_TO_EXIT.usage, 1);
  assert.equal(KIND_TO_EXIT["invalid-value"], 1);
  assert.equal(KIND_TO_EXIT["unknown-action"], 1);
  assert.equal(KIND_TO_EXIT["no-goal"], 2);
  assert.equal(KIND_TO_EXIT["terminal-state"], 2);
  assert.equal(KIND_TO_EXIT["handoff-exists"], 2);
  assert.equal(KIND_TO_EXIT["no-handoff"], 2);
  assert.equal(KIND_TO_EXIT["current-goal"], 2);
  assert.equal(KIND_TO_EXIT["write-failed"], 3);
});
