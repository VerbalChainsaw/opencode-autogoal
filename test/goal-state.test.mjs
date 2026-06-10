/**
 * Regression suite for the consolidated core. Runs against the BUILT output
 * (`dist/goal-state.js`) so it exercises exactly what ships.
 *
 *   npm run build && node --test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  detectMarker,
  COMPLETE_RE,
  BLOCKED_RE,
  parseGoalInput,
  setGoal,
  setGoalFields,
  transitionGoal,
  readGoalState,
  formatStatus,
} from "../dist/goal-state.js";

function freshDir() {
  const d = mkdtempSync(join(tmpdir(), "opengoal-"));
  return d;
}

test("detectMarker: line-anchored, rejects chatter, accepts declarations", () => {
  assert.equal(detectMarker("once tests pass I'll write GOAL_COMPLETE: at the end", COMPLETE_RE), null);
  assert.equal(detectMarker("I should mention GOAL_BLOCKED: only when stuck", BLOCKED_RE), null);
  assert.equal(detectMarker("the plan: GOAL_COMPLETE is the marker", COMPLETE_RE), null);
  assert.equal(detectMarker("GOAL_COMPLETE: all 84 tests pass", COMPLETE_RE), "all 84 tests pass");
  assert.equal(detectMarker("   GOAL_COMPLETE:  indented  ", COMPLETE_RE), "indented");
  assert.equal(detectMarker("did work\nverified\nGOAL_COMPLETE: lint exits 0", COMPLETE_RE), "lint exits 0");
  assert.equal(detectMarker("GOAL_BLOCKED: missing API key", BLOCKED_RE), "missing API key");
  assert.equal(detectMarker("GOAL_COMPLETE:", COMPLETE_RE), "");
});

test("parseGoalInput: condition + constraints + command, quotes preserved", () => {
  const r = parseGoalInput('make the "smart" parser handle don\'t stop after 8 turns --command "npm test"');
  assert.ok(!("error" in r));
  assert.equal(r.condition, 'make the "smart" parser handle don\'t');
  assert.equal(r.command, "npm test");
  assert.equal(r.constraints.maxTurns, 8);
  assert.equal(r.constraints.maxTimeMinutes, 30);
  assert.equal(r.custom, true);
});

test("parseGoalInput: surrounding quotes are unwrapped, inner quotes preserved", () => {
  // Whole-string wrap is removed (the common `/goal set "x"` case)...
  assert.equal(parseGoalInput('"refactor the parser"').condition, "refactor the parser");
  assert.equal(parseGoalInput("'fix the bug'").condition, "fix the bug");
  // ...but inner quotes and multi-quote strings are left exactly as typed.
  assert.equal(parseGoalInput('make the "smart" parser work').condition, 'make the "smart" parser work');
  assert.equal(parseGoalInput('"a" and "b"').condition, '"a" and "b"');
  // Wrap + a flag: condition unwraps, command still parsed.
  const r = parseGoalInput('"fix the bug" --command "npm test"');
  assert.equal(r.condition, "fix the bug");
  assert.equal(r.command, "npm test");
});

test("parseGoalInput: empty + flags-only are rejected", () => {
  assert.ok("error" in parseGoalInput("   "));
  assert.ok("error" in parseGoalInput('--command "npm test"'));
});

test("parseGoalInput: token constraint with k multiplier", () => {
  const r = parseGoalInput("do thing stop after 50k tokens");
  assert.ok(!("error" in r));
  assert.equal(r.constraints.maxTokens, 50000);
});

test("setGoal → readGoalState → formatStatus round-trips", () => {
  const dir = freshDir();
  try {
    const res = setGoal(dir, "ship the feature stop after 6 turns --command \"node --version\"", { now: 1_000 });
    assert.equal(res.ok, true);
    assert.equal(res.replaced, null);
    assert.ok(existsSync(join(dir, ".opencode/.goal-state.json")));

    const state = readGoalState(dir);
    assert.equal(state.condition, "ship the feature");
    assert.equal(state.command, "node --version");
    assert.equal(state.constraints.maxTurns, 6);
    assert.equal(state.status, "active");

    const view = formatStatus(state, 1_000 + 120000); // +2 min
    assert.match(view, /Condition: ship the feature/);
    assert.match(view, /0\/6 turns, 2\/30 minutes/);
    assert.match(view, /Verification: `node --version`/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setGoal reports replaced when overwriting an active goal", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "first goal");
    const res = setGoal(dir, "second goal");
    assert.equal(res.replaced, "first goal");
    assert.equal(readGoalState(dir).condition, "second goal");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("transitionGoal: pause → resume → clear, with clean errors", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "do the thing");
    assert.equal(transitionGoal(dir, "pause").ok, true);
    assert.equal(transitionGoal(dir, "pause").error, "Goal is already paused.");
    assert.equal(transitionGoal(dir, "resume").ok, true);
    assert.equal(transitionGoal(dir, "resume").error, "Goal is already active.");
    assert.equal(transitionGoal(dir, "clear").ok, true);
    assert.equal(transitionGoal(dir, "resume").error, "This goal was cleared. Set a new goal instead.");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("transitionGoal: no state file → clean error", () => {
  const dir = freshDir();
  try {
    assert.equal(transitionGoal(dir, "clear").error, "No active goal to clear.");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setGoalFields: structured input (the tools' path) builds the right state", () => {
  const dir = freshDir();
  try {
    const res = setGoalFields(dir, { condition: "all tests pass", command: "npm test", maxTurns: 12, maxMinutes: 25 }, { now: 1 });
    assert.equal(res.ok, true);
    const s = readGoalState(dir);
    assert.equal(s.condition, "all tests pass");
    assert.equal(s.command, "npm test");
    assert.equal(s.constraints.maxTurns, 12);
    assert.equal(s.constraints.maxTimeMinutes, 25);
    assert.equal(s.constraints.maxTokens, 100000); // default retained
    assert.equal(s.status, "active");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setGoalFields: empty condition rejected, surrounding quotes unwrapped", () => {
  const dir = freshDir();
  try {
    assert.equal(setGoalFields(dir, { condition: "   " }).ok, false);
    setGoalFields(dir, { condition: '"wrapped condition"' });
    assert.equal(readGoalState(dir).condition, "wrapped condition");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setGoal from template seed merges with overrides", () => {
  const dir = freshDir();
  try {
    // Simulate the server's template path: seed from a template, override turns.
    const res = setGoal(dir, "the lint command exits with code 0 stop after 5 turns", {
      setBy: "template",
      seed: { command: "npm run lint", constraints: { maxTurns: 10, maxTimeMinutes: 15, maxTokens: 50000 } },
    });
    assert.equal(res.ok, true);
    const state = readGoalState(dir);
    assert.equal(state.command, "npm run lint");
    assert.equal(state.constraints.maxTurns, 5); // override wins
    assert.equal(state.constraints.maxTimeMinutes, 15); // seed retained
    assert.equal(state.metadata.setBy, "template");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
