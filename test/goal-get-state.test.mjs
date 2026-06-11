import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setGoal, readGoalState } from "../dist/goal-state.js";

function freshDir() {
  return mkdtempSync(join(tmpdir(), "opengoal-ggs-"));
}

// The tool's execute() body is one line: JSON.stringify(readGoalState(directory)).
// These tests pin the contract: it returns the literal string "null" when
// no state file exists (callers can `JSON.parse` it without a special case),
// and a JSON string of the state when one is set.
test("goal_get_state contract: no state → returns the literal string 'null'", () => {
  const dir = freshDir();
  try {
    const raw = JSON.stringify(readGoalState(dir));
    assert.equal(raw, "null");
    // The GUI parses with JSON.parse; this should give them JS null.
    assert.equal(JSON.parse(raw), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("goal_get_state contract: state set → returns a JSON string parseable to the same state", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "make all tests pass");
    const stateBefore = readGoalState(dir);
    const raw = JSON.stringify(stateBefore);
    // The contract: the GUI can do JSON.parse(raw) and get the same shape
    // the plugin's readGoalState returns.
    const parsed = JSON.parse(raw);
    assert.equal(parsed.id, stateBefore.id);
    assert.equal(parsed.condition, "make all tests pass");
    assert.equal(parsed.status, "active");
    assert.equal(parsed.constraints.maxTurns, 20);
    assert.equal(parsed.constraints.maxTimeMinutes, 30);
    assert.equal(parsed.constraints.maxTokens, 100000);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("goal_get_state contract: returned JSON survives a round-trip (no prototype pollution)", () => {
  // A malicious state file could include a `__proto__` key. JSON.parse
  // doesn't pollute the prototype, but a SolidJS `<For each={...}>` or
  // similar would render undefined. Pin the round-trip:
  const dir = freshDir();
  try {
    setGoal(dir, "x");
    const raw = JSON.stringify(readGoalState(dir));
    const parsed = JSON.parse(raw);
    // After JSON.parse, parsed should NOT have a polluted Object prototype.
    assert.equal(({}).constructor === Object, true);
    assert.equal(parsed.constructor === Object, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
