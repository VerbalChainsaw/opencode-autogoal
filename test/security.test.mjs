/**
 * Security regression tests for the v0.2.0 hardening pass
 * (scratch/security-review-0.2.0-rc.6.md). Each test pins a specific finding's
 * fix so it can't regress. Runs against the built dist/.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  sanitizeMetadata,
  setGoal,
  createHandoff,
  claimHandoff,
  restartGoal,
  readGoalState,
  handoffPath,
  MAX_STATE_SIZE,
  MAX_STEERING_NOTES,
  MAX_STEERING_LEN,
} from "../dist/goal-state.js";

function freshDir() {
  return mkdtempSync(join(tmpdir(), "opengoal-sec-"));
}

function makeValidState(overrides = {}) {
  return {
    version: 1,
    id: "valid-id",
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
}

// ── #2/#15: metadata allowlist ──────────────────────────────────────────────

test("sanitizeMetadata: drops unknown/attacker keys, keeps the allowlist", () => {
  const out = sanitizeMetadata({
    setBy: "template",
    sessionId: "s1",
    previousId: "p1",
    restartedAt: 5,
    __proto__polluter: true,
    evilFlag: "rm -rf /",
    nested: { a: 1 },
  });
  assert.equal(out.setBy, "template");
  assert.equal(out.sessionId, "s1");
  assert.equal(out.previousId, "p1");
  assert.equal(out.restartedAt, 5);
  assert.equal("evilFlag" in out, false);
  assert.equal("nested" in out, false);
});

test("sanitizeMetadata: bad setBy falls back to 'user'; non-object → {setBy:'user'}", () => {
  assert.equal(sanitizeMetadata({ setBy: "hacker" }).setBy, "user");
  assert.deepEqual(sanitizeMetadata("not an object"), { setBy: "user" });
  assert.deepEqual(sanitizeMetadata(null), { setBy: "user" });
});

test("sanitizeMetadata: steering is shape-checked, count-capped, content-sanitized", () => {
  const many = Array.from({ length: MAX_STEERING_NOTES + 5 }, (_, i) => ({ at: i, note: `note ${i}` }));
  const out = sanitizeMetadata({ setBy: "user", steering: [...many, { at: 1, note: 123 }, "junk"] });
  assert.ok(out.steering.length <= MAX_STEERING_NOTES);
  assert.ok(out.steering.every((s) => typeof s.note === "string" && typeof s.at === "number"));
  // control chars stripped
  const ctrl = sanitizeMetadata({ setBy: "user", steering: [{ at: 1, note: "a\nb c" }] });
  assert.ok(!ctrl.steering[0].note.includes("\n"));
  assert.ok(!ctrl.steering[0].note.includes(" "));
  // over-long note capped
  const long = sanitizeMetadata({ setBy: "user", steering: [{ at: 1, note: "x".repeat(MAX_STEERING_LEN + 50) }] });
  assert.ok(long.steering[0].note.length <= MAX_STEERING_LEN);
});

test("claimHandoff: a planted handoff cannot carry forward attacker metadata keys (#2)", () => {
  const dir = freshDir();
  try {
    const evilState = makeValidState({ metadata: { setBy: "user", backdoor: "yes", allowExec: true } });
    mkdirSync(join(dir, ".opencode"), { recursive: true });
    writeFileSync(handoffPath(dir), JSON.stringify({ createdAt: new Date(1).toISOString(), state: evilState }));
    const res = claimHandoff(dir);
    assert.equal(res.ok, true);
    const resumed = readGoalState(dir);
    assert.equal("backdoor" in resumed.metadata, false);
    assert.equal("allowExec" in resumed.metadata, false);
    assert.equal(resumed.metadata.setBy, "user");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("restartGoal: drops attacker metadata keys read from a planted state file (#15)", () => {
  const dir = freshDir();
  try {
    const evil = makeValidState({ metadata: { setBy: "user", backdoor: "yes" } });
    mkdirSync(join(dir, ".opencode"), { recursive: true });
    writeFileSync(join(dir, ".opencode", ".goal-state.json"), JSON.stringify(evil));
    const res = restartGoal(dir);
    assert.equal(res.ok, true);
    const after = readGoalState(dir);
    assert.equal("backdoor" in after.metadata, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── #1: file-size DoS guard ─────────────────────────────────────────────────

test("readGoalState: an oversized state file is rejected (DoS guard #1)", () => {
  const dir = freshDir();
  try {
    mkdirSync(join(dir, ".opencode"), { recursive: true });
    const bloat = makeValidState({ condition: "x".repeat(MAX_STATE_SIZE + 1000) });
    writeFileSync(join(dir, ".opencode", ".goal-state.json"), JSON.stringify(bloat));
    assert.ok(statSync(join(dir, ".opencode", ".goal-state.json")).size > MAX_STATE_SIZE);
    assert.equal(readGoalState(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── #6/#10: handoff atomic write + note cap/sanitize ────────────────────────

test("createHandoff: note is length-capped and control-char-stripped (#10)", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "ship it");
    const res = createHandoff(dir, "line1\nline2 " + "y".repeat(MAX_STEERING_LEN + 100));
    assert.equal(res.ok, true);
    const payload = JSON.parse(readFileSync(handoffPath(dir), "utf-8"));
    assert.ok(!payload.note.includes("\n"));
    assert.ok(!payload.note.includes(" "));
    assert.ok(payload.note.length <= MAX_STEERING_LEN);
    // atomic write leaves no .tmp turds
    assert.equal(existsSync(handoffPath(dir) + ".tmp"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
