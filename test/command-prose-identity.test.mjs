/**
 * Prose-identity test for `dispatchGoalCommand` (Task 3 + R2).
 *
 * The work order's hard rule: "existing prose output of `dispatchGoalCommand`
 * must remain byte-identical." This test pins that contract by capturing
 * the current output strings and asserting equality after every refactor.
 *
 * Captured by `scripts/capture-dispatcher-prose.mjs` against the
 * unmodified build, before any restructuring. If a future change to
 * `command.ts` shifts the prose (whitespace, wording, order), this
 * test fails with a clear diff and forces the author to update the
 * expected strings deliberately.
 *
 * Note: this test does NOT use the CLI (`dist/cli.js`); the CLI uses
 * `dispatchGoalCommandStructured` directly (NOT the prose function),
 * because the CLI consumer doesn't want the conversational relay
 * wrapper. We test the raw dispatcher output, which is the
 * OpenCode-agent surface.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dispatchGoalCommand } from "../dist/command.js";

function freshDir() {
  return mkdtempSync(join(tmpdir(), "opengoal-prose-"));
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

const RELAY = "Tell the user this, then stop and await further instruction:\n\n";

test("prose: bare /goal shows status (relay-wrapped)", () => {
  const dir = freshDir();
  try {
    plantActiveGoal(dir);
    const out = dispatchGoalCommand(dir, "");
    // The "X/30 minutes" substring depends on Date.now() at runtime.
    // We assert the rest of the prose byte-identical and the minutes
    // part is a non-negative integer.
    assert.match(out, new RegExp(`^${escapeForRegex(RELAY)}Condition: x\nStatus: active\nProgress: 0/20 turns, \\d+/30 minutes\nLast evaluation: none yet$`));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("prose: view shows status (relay-wrapped)", () => {
  const dir = freshDir();
  try {
    plantActiveGoal(dir);
    const out = dispatchGoalCommand(dir, "view");
    assert.match(out, new RegExp(`^${escapeForRegex(RELAY)}Condition: x\nStatus: active\nProgress: 0/20 turns, \\d+/30 minutes\nLast evaluation: none yet$`));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("prose: pause from active → success (relay-wrapped)", () => {
  const dir = freshDir();
  try {
    plantActiveGoal(dir);
    const out = dispatchGoalCommand(dir, "pause");
    assert.equal(out, `${RELAY}Goal paused. Resume with \`/goal resume\`.`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("prose: pause from paused → no-op (relay-wrapped)", () => {
  const dir = freshDir();
  try {
    plantActiveGoal(dir);
    dispatchGoalCommand(dir, "pause"); // active → paused
    const out = dispatchGoalCommand(dir, "pause"); // paused → no-op
    assert.equal(out, `${RELAY}Goal is already paused.`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("prose: resume from paused → BARE (no relay wrapper)", () => {
  // The bare resume path is special: the dispatcher returns the
  // "continue working toward it now" briefing verbatim, without the
  // relay wrapper. The work order explicitly notes this as one of
  // the two non-relayed success paths the refactor must preserve.
  const dir = freshDir();
  try {
    plantActiveGoal(dir);
    dispatchGoalCommand(dir, "pause"); // active → paused
    const out = dispatchGoalCommand(dir, "resume"); // paused → active
    assert.equal(out, `Goal resumed — continue working toward it now:\n\nGOAL: x`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("prose: turns abc → usage error (relay-wrapped)", () => {
  const dir = freshDir();
  try {
    plantActiveGoal(dir);
    const out = dispatchGoalCommand(dir, "turns abc");
    assert.equal(out, `${RELAY}Usage: /goal turns <number>. e.g. /goal turns 50`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("prose: unknown action falls through to set (current behavior)", () => {
  // The dispatcher's `isAction` check is `KNOWN_ACTIONS.has(firstWord)`.
  // For "zzz" that's false, so action becomes "set" with payload "zzz".
  // The dispatcher then calls setGoal(dir, "zzz"), which sets a new
  // goal with condition "zzz". The output is the set reply (BARE,
  // not relay-wrapped). The work order's "unknown-action" kind is
  // reserved for an explicit future fallthrough; today's behavior
  // is to treat unknown as set, and the prose-identity test pins that.
  const dir = freshDir();
  try {
    plantActiveGoal(dir);
    const out = dispatchGoalCommand(dir, "zzz");
    assert.match(out, /^A goal has been set and is now your top priority\./);
    assert.match(out, /\nGOAL: zzz\n/);
    assert.match(out, /\nBegin now\.$/);
    // Set is BARE — no relay wrapper
    assert.ok(!out.startsWith(RELAY),
      `set reply must NOT have the relay wrapper; got: ${out.slice(0, 50)}...`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("prose: set is BARE (no relay wrapper, with full briefing)", () => {
  const dir = freshDir();
  try {
    const out = dispatchGoalCommand(dir, "set capture-me");
    assert.match(out, /^A goal has been set and is now your top priority\./);
    assert.match(out, /\nGOAL: capture-me\n/);
    assert.match(out, /\nHow to proceed:\n/);
    assert.match(out, /\nBegin now\.$/);
    assert.ok(!out.startsWith(RELAY),
      `set reply must NOT have the relay wrapper; got: ${out.slice(0, 50)}...`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("prose: clear (relay-wrapped)", () => {
  const dir = freshDir();
  try {
    plantActiveGoal(dir);
    const out = dispatchGoalCommand(dir, "clear");
    assert.equal(out, `${RELAY}Goal cleared. 0 turns were evaluated before clearing.`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("prose: resume after clear (relay-wrapped)", () => {
  const dir = freshDir();
  try {
    plantActiveGoal(dir);
    dispatchGoalCommand(dir, "clear");
    const out = dispatchGoalCommand(dir, "resume");
    assert.equal(out, `${RELAY}This goal was cleared. Set a new goal instead.`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── helper ──────────────────────────────────────────────────────────────────

/** Escape a string for safe use inside a `new RegExp(...)`. */
function escapeForRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
