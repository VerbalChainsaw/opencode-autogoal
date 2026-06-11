// One-off script to capture raw dispatcher output for the prose-identity
// test in Task 3. Run BEFORE refactoring the dispatcher.
//
// Usage: cd OpenGoal && node scripts/capture-dispatcher-prose.mjs
import { dispatchGoalCommand } from "../dist/command.js";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The dispatcher imports the primitives transitively. We just call
// dispatchGoalCommand with various argv-style strings and capture
// the raw output. No other imports needed (the state file is read
// by the dispatcher itself).

const dir = mkdtempSync(join(tmpdir(), "opengoal-prose-"));
try {
  // Plant a valid state file so the dispatcher's set/pause/etc. work.
  mkdirSync(join(dir, ".opencode"), { recursive: true });
  // We don't need to set a goal via the API; we just need the dispatcher
  // to think a goal exists. The capture script is read-only with respect
  // to the state shape — we plant a hand-crafted one and capture.
  const state = {
    version: 1, id: "x", condition: "x", command: null, status: "active",
    createdAt: 1, startedAt: 1, completedAt: null, pausedAt: null, resumedAt: null,
    turnsEvaluated: 0, tokensUsed: 0, lastEvaluation: null, evaluationHistory: [],
    constraints: { maxTurns: 20, maxTimeMinutes: 30, maxTokens: 100000 },
    metadata: { setBy: "user" },
  };
  writeFileSync(join(dir, ".opencode", ".goal-state.json"), JSON.stringify(state));

  const capture = (label, fn) => {
    const out = fn();
    process.stdout.write(`---BEGIN ${label}---\n`);
    process.stdout.write(out);
    process.stdout.write(`\n---END ${label}---\n\n`);
  };
  // Bare /goal: shows status
  capture("bare", () => dispatchGoalCommand(dir, ""));
  // view: shows status
  capture("view", () => dispatchGoalCommand(dir, "view"));
  // pause: active → paused
  capture("pause-from-active", () => dispatchGoalCommand(dir, "pause"));
  // pause again: now no-goal-style (paused → resume would succeed; we test that next)
  capture("pause-from-paused (no-op)", () => dispatchGoalCommand(dir, "pause"));
  // resume: paused → active
  capture("resume", () => dispatchGoalCommand(dir, "resume"));
  // turns abc: usage error
  capture("turns abc", () => dispatchGoalCommand(dir, "turns abc"));
  // unknown action
  capture("unknown", () => dispatchGoalCommand(dir, "zzz"));
  // set: special path (no relay wrapper)
  capture("set", () => dispatchGoalCommand(dir, "set capture-me"));
  // clear
  capture("clear", () => dispatchGoalCommand(dir, "clear"));
  // resume after clear: no-goal-style error
  capture("resume-cleared", () => dispatchGoalCommand(dir, "resume"));
} finally { rmSync(dir, { recursive: true, force: true }); }
