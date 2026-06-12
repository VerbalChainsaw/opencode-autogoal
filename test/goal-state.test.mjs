/**
 * Regression suite for the consolidated core. Runs against the BUILT output
 * (`dist/goal-state.js`) so it exercises exactly what ships.
 *
 *   npm run build && node --test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
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
  readGoalStateResult,
  readGoalStateRawResult,
  readHandoff,
  readHandoffResult,
  createHandoff,
  formatStatus,
  validateGoalState,
  parseShellWords,
  CONSTRAINT_BOUNDS,
  DEFAULT_CONSTRAINTS,
  STATE_FILE,
  HANDOFF_FILE,
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

// ── B1 regression: code-block and quoted-example false positives ────────────
// Cycle-0 BLOCKER 1: the previous version (`/^\s*GOAL_COMPLETE\s*:\s*(.*)$/i`)
// tripped when the agent explained the protocol in a markdown code block or
// showed a documentation example. These cases must NOT trip. The new
// detector is code-fence-aware (markdown ``` and ~~~) AND limits leading
// whitespace to 0-3 chars (markdown's "indented code block" threshold is 4+).

test("detectMarker: code block with marker on its own line does NOT trip", () => {
  const text = "Here's how to mark complete:\n```\nGOAL_COMPLETE: tests pass\n```\nDone.";
  assert.equal(detectMarker(text, COMPLETE_RE), null);
});

test("detectMarker: tilde-fenced code block with marker does NOT trip", () => {
  const text = "~~~\nGOAL_BLOCKED: I'm not actually blocked\n~~~\n";
  assert.equal(detectMarker(text, BLOCKED_RE), null);
});

test("detectMarker: marker at line start in PROSE (outside fence) trips", () => {
  // The case the README claims is the safe one — and now it is.
  const text = "All done.\n\nGOAL_COMPLETE: tests pass";
  assert.equal(detectMarker(text, COMPLETE_RE), "tests pass");
});

test("detectMarker: a marker inside a fence is ignored, but a later marker outside is accepted", () => {
  const text = [
    "First I'll explain the protocol:",
    "```",
    "GOAL_COMPLETE: this is just an example",
    "```",
    "",
    "OK now I'll actually do the work.",
    "GOAL_COMPLETE: all tests pass",
  ].join("\n");
  assert.equal(detectMarker(text, COMPLETE_RE), "all tests pass");
});

test("detectMarker: marker inside an indented code block (4+ leading spaces) does NOT trip", () => {
  // Markdown: 4+ leading spaces = indented code block. The old regex
  // `/^\s*.../i` matched this; the new regex limits to 0-3 spaces.
  const text = "Here is an example:\n\n    GOAL_COMPLETE: indented example\n\nAll done.";
  assert.equal(detectMarker(text, COMPLETE_RE), null);
});

test("detectMarker: 1-3 leading spaces are still accepted (prose indent)", () => {
  assert.equal(detectMarker("   GOAL_COMPLETE:  3 spaces  ", COMPLETE_RE), "3 spaces");
  assert.equal(detectMarker(" GOAL_COMPLETE:  1 space  ", COMPLETE_RE), "1 space");
  assert.equal(detectMarker("GOAL_COMPLETE: no space", COMPLETE_RE), "no space");
});

test("detectMarker: marker is case-sensitive (lowercase does not trip)", () => {
  // The protocol in command.ts:60-61 says "GOAL_COMPLETE:" (uppercase).
  // The agent's spec is the spec; lowercase is a different word.
  assert.equal(detectMarker("goal_complete: lowercase\n", COMPLETE_RE), null);
  assert.equal(detectMarker("Goal_Complete: title case\n", COMPLETE_RE), null);
});

test("detectMarker: returns the LAST non-fenced match (agent's most recent statement)", () => {
  // Multiple markers; the last one outside any fence wins.
  const text = [
    "GOAL_COMPLETE: first attempt failed",
    "GOAL_COMPLETE: second attempt failed",
    "GOAL_COMPLETE: third attempt succeeded",
  ].join("\n");
  assert.equal(detectMarker(text, COMPLETE_RE), "third attempt succeeded");
});

test("detectMarker: deeply nested agent conversation with code blocks", () => {
  // Real-world shape: agent explores → shows example code → explains → writes marker.
  const text = [
    "Let me check the build status.",
    "```bash",
    "npm test",
    "```",
    "Output looked OK. Let me show what the protocol says:",
    "```",
    "GOAL_COMPLETE: the lint command exits 0",
    "```",
    "(That was just an example, not my actual completion signal.)",
    "GOAL_COMPLETE: all 84 tests pass, lint clean",
  ].join("\n");
  assert.equal(detectMarker(text, COMPLETE_RE), "all 84 tests pass, lint clean");
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

// ── Constraint clamping (v0.1.2) ───────────────────────────────────────────
// The clamp prevents the two failure modes cycle-0 found: 0 was accepted (goal
// immediately cleared on first idle), and 1e20 was accepted (silent infinite
// loop). Both fall back to the per-field default now.

test("parseConstraints: 0 turns falls back to the default (no immediate goal death)", () => {
  const r = parseGoalInput("do the thing stop after 0 turns");
  assert.equal(r.constraints.maxTurns, DEFAULT_CONSTRAINTS.maxTurns);
});

test("parseConstraints: 0 minutes falls back to the default", () => {
  const r = parseGoalInput("do the thing stop after 0 minutes");
  assert.equal(r.constraints.maxTimeMinutes, DEFAULT_CONSTRAINTS.maxTimeMinutes);
});

test("parseConstraints: 0 tokens / 0k tokens falls back to the default", () => {
  const r1 = parseGoalInput("do the thing stop after 0 tokens");
  const r2 = parseGoalInput("do the thing stop after 0k tokens");
  assert.equal(r1.constraints.maxTokens, DEFAULT_CONSTRAINTS.maxTokens);
  assert.equal(r2.constraints.maxTokens, DEFAULT_CONSTRAINTS.maxTokens);
});

test("parseConstraints: 1e20 turns falls back to the default (out-of-range, not a real limit)", () => {
  const r = parseGoalInput("do the thing stop after 99999999999999999999 turns");
  assert.equal(r.constraints.maxTurns, DEFAULT_CONSTRAINTS.maxTurns);
});

test("parseConstraints: above the upper bound falls back to the default (typo guardrail)", () => {
  // Rationale: a user who types 99999 turns almost certainly typo'd. Defaulting
  // to 20 is the conservative fallback; silently bumping to 10,000 would create
  // a multi-day goal the user didn't ask for.
  const r = parseGoalInput("do the thing stop after 99999 turns");
  assert.equal(r.constraints.maxTurns, DEFAULT_CONSTRAINTS.maxTurns);
});

test("parseConstraints: valid in-range values are preserved exactly", () => {
  const r = parseGoalInput("do the thing stop after 42 turns stop after 17 minutes stop after 500 tokens");
  assert.equal(r.constraints.maxTurns, 42);
  assert.equal(r.constraints.maxTimeMinutes, 17);
  assert.equal(r.constraints.maxTokens, 500);
});

test("parseConstraints: values at the upper bound are preserved exactly", () => {
  const r = parseGoalInput(
    `do the thing stop after ${CONSTRAINT_BOUNDS.maxTurns} turns ` +
    `stop after ${CONSTRAINT_BOUNDS.maxMinutes} minutes ` +
    `stop after ${CONSTRAINT_BOUNDS.maxTokens} tokens`
  );
  assert.equal(r.constraints.maxTurns, CONSTRAINT_BOUNDS.maxTurns);
  assert.equal(r.constraints.maxTimeMinutes, CONSTRAINT_BOUNDS.maxMinutes);
  assert.equal(r.constraints.maxTokens, CONSTRAINT_BOUNDS.maxTokens);
});

test("parseConstraints: just above the upper bound falls back to the default", () => {
  const r = parseGoalInput(`do the thing stop after ${CONSTRAINT_BOUNDS.maxTurns + 1} turns`);
  assert.equal(r.constraints.maxTurns, DEFAULT_CONSTRAINTS.maxTurns);
});

test("parseConstraints: out-of-range minutes falls back to the default", () => {
  const r = parseGoalInput("do the thing stop after 99999 minutes");
  assert.equal(r.constraints.maxTimeMinutes, DEFAULT_CONSTRAINTS.maxTimeMinutes);
});

// ── Deep validation (v0.1.2) ───────────────────────────────────────────────
// The old `validateGoalState` accepted `constraints: {}` and `command: [array]`,
// which produced silent infinite loops and silent command-coercion bugs at
// runtime. The deep validator now rejects both.

test("validateGoalState: accepts a full valid state", () => {
  const s = {
    version: 1, id: "abc", condition: "x", status: "active",
    createdAt: 1, startedAt: 1, completedAt: null, pausedAt: null, resumedAt: null,
    turnsEvaluated: 0, tokensUsed: 0, lastEvaluation: null, evaluationHistory: [],
    constraints: { maxTurns: 20, maxTimeMinutes: 30, maxTokens: 100000 },
    metadata: { setBy: "user" },
  };
  assert.equal(validateGoalState(s), true);
});

test("validateGoalState: rejects constraints with missing maxTurns (silent infinite loop trap)", () => {
  const s = {
    version: 1, id: "abc", condition: "x", status: "active",
    createdAt: 1, startedAt: 1, completedAt: null, pausedAt: null, resumedAt: null,
    turnsEvaluated: 0, tokensUsed: 0, lastEvaluation: null, evaluationHistory: [],
    constraints: { maxTimeMinutes: 30, maxTokens: 100000 },
    metadata: { setBy: "user" },
  };
  assert.equal(validateGoalState(s), false);
});

test("validateGoalState: rejects constraints: {} (the cycle-0 silent-infinite-loop case)", () => {
  const s = {
    version: 1, id: "abc", condition: "x", status: "active",
    createdAt: 1, startedAt: 1, completedAt: null, pausedAt: null, resumedAt: null,
    turnsEvaluated: 0, tokensUsed: 0, lastEvaluation: null, evaluationHistory: [],
    constraints: {},
    metadata: { setBy: "user" },
  };
  assert.equal(validateGoalState(s), false);
});

test("validateGoalState: rejects command as array (silent coercion bug in execAsync)", () => {
  const s = {
    version: 1, id: "abc", condition: "x", status: "active",
    createdAt: 1, startedAt: 1, completedAt: null, pausedAt: null, resumedAt: null,
    turnsEvaluated: 0, tokensUsed: 0, lastEvaluation: null, evaluationHistory: [],
    constraints: { maxTurns: 20, maxTimeMinutes: 30, maxTokens: 100000 },
    command: ["rm", "-rf", "/"],
    metadata: { setBy: "user" },
  };
  assert.equal(validateGoalState(s), false);
});

test("validateGoalState: rejects command as object", () => {
  const s = {
    version: 1, id: "abc", condition: "x", status: "active",
    createdAt: 1, startedAt: 1, completedAt: null, pausedAt: null, resumedAt: null,
    turnsEvaluated: 0, tokensUsed: 0, lastEvaluation: null, evaluationHistory: [],
    constraints: { maxTurns: 20, maxTimeMinutes: 30, maxTokens: 100000 },
    command: { shell: "rm -rf /" },
    metadata: { setBy: "user" },
  };
  assert.equal(validateGoalState(s), false);
});

test("validateGoalState: accepts command as string, null, or absent", () => {
  const base = {
    version: 1, id: "abc", condition: "x", status: "active",
    createdAt: 1, startedAt: 1, completedAt: null, pausedAt: null, resumedAt: null,
    turnsEvaluated: 0, tokensUsed: 0, lastEvaluation: null, evaluationHistory: [],
    constraints: { maxTurns: 20, maxTimeMinutes: 30, maxTokens: 100000 },
    metadata: { setBy: "user" },
  };
  assert.equal(validateGoalState({ ...base, command: "npm test" }), true);
  assert.equal(validateGoalState({ ...base, command: null }), true);
  assert.equal(validateGoalState({ ...base, command: undefined }), true);
});

test("validateGoalState: rejects negative turnsEvaluated (cycle-0 TUI crash case)", () => {
  const s = {
    version: 1, id: "abc", condition: "x", status: "active",
    createdAt: 1, startedAt: 1, completedAt: null, pausedAt: null, resumedAt: null,
    turnsEvaluated: -1, tokensUsed: 0, lastEvaluation: null, evaluationHistory: [],
    constraints: { maxTurns: 20, maxTimeMinutes: 30, maxTokens: 100000 },
    metadata: { setBy: "user" },
  };
  assert.equal(validateGoalState(s), false);
});

test("validateGoalState: rejects unknown status", () => {
  const s = {
    version: 1, id: "abc", condition: "x", status: "achieve", // typo
    createdAt: 1, startedAt: 1, completedAt: null, pausedAt: null, resumedAt: null,
    turnsEvaluated: 0, tokensUsed: 0, lastEvaluation: null, evaluationHistory: [],
    constraints: { maxTurns: 20, maxTimeMinutes: 30, maxTokens: 100000 },
    metadata: { setBy: "user" },
  };
  assert.equal(validateGoalState(s), false);
});

test("validateGoalState: rejects non-array evaluationHistory", () => {
  const s = {
    version: 1, id: "abc", condition: "x", status: "active",
    createdAt: 1, startedAt: 1, completedAt: null, pausedAt: null, resumedAt: null,
    turnsEvaluated: 0, tokensUsed: 0, lastEvaluation: null,
    evaluationHistory: "not-an-array",
    constraints: { maxTurns: 20, maxTimeMinutes: 30, maxTokens: 100000 },
    metadata: { setBy: "user" },
  };
  assert.equal(validateGoalState(s), false);
});

test("validateGoalState: rejects constraints with values below the lower bound (0 turns)", () => {
  const s = {
    version: 1, id: "abc", condition: "x", status: "active",
    createdAt: 1, startedAt: 1, completedAt: null, pausedAt: null, resumedAt: null,
    turnsEvaluated: 0, tokensUsed: 0, lastEvaluation: null, evaluationHistory: [],
    constraints: { maxTurns: 0, maxTimeMinutes: 30, maxTokens: 100000 },
    metadata: { setBy: "user" },
  };
  assert.equal(validateGoalState(s), false);
});

// readGoalState returns null for a hand-crafted corrupt state file (defense in
// depth — a state file written by an older plugin version, a hand-edited state
// file, or a power-cut partial write should all be ignored rather than crash).
test("readGoalState: returns null for a hand-crafted corrupt state file", () => {
  const dir = freshDir();
  try {
    const statePath = join(dir, ".opencode", ".goal-state.json");
    mkdirSync(join(dir, ".opencode"), { recursive: true });
    writeFileSync(statePath, JSON.stringify({
      version: 1, id: "x", condition: "x", status: "active",
      createdAt: 1, startedAt: 1, completedAt: null, pausedAt: null, resumedAt: null,
      turnsEvaluated: 0, tokensUsed: 0, lastEvaluation: null, evaluationHistory: [],
      constraints: {}, // the cycle-0 silent-infinite-loop case
      metadata: { setBy: "user" },
    }));
    assert.equal(readGoalState(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readGoalState: round-trips a goal whose constraints were clamped to the default", () => {
  const dir = freshDir();
  try {
    // 0 turns → clamped to default 20.
    const res = setGoal(dir, "do thing stop after 0 turns", { now: 1 });
    assert.equal(res.ok, true);
    const s = readGoalState(dir);
    assert.equal(s.constraints.maxTurns, DEFAULT_CONSTRAINTS.maxTurns);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── POSIX word-splitting (v0.1.2) ────────────────────────────────────────────
// `parseShellWords` is a portable, no-shell-grammar view of what the user
// typed. Used for debug logging in `evaluateDeterministic` and as the
// foundation for a future `verificationShell: "none"` opt-in.

test("parseShellWords: simple command splits on whitespace", () => {
  assert.deepEqual(parseShellWords("npm test"), ["npm", "test"]);
  assert.deepEqual(parseShellWords("  leading   and   trailing  "), ["leading", "and", "trailing"]);
});

test("parseShellWords: single quotes are literal (no backslash interpretation)", () => {
  assert.deepEqual(parseShellWords("echo 'hello world'"), ["echo", "hello world"]);
  assert.deepEqual(parseShellWords("echo 'back\\slash and $dollar'"), ["echo", "back\\slash and $dollar"]);
});

test("parseShellWords: double quotes allow backslash escapes", () => {
  assert.deepEqual(parseShellWords('echo "hello world"'), ["echo", "hello world"]);
  assert.deepEqual(parseShellWords('echo "with \\"escaped\\" quote"'), ["echo", 'with "escaped" quote']);
});

test("parseShellWords: backslash outside quotes preserves next char", () => {
  assert.deepEqual(parseShellWords("echo back\\slash"), ["echo", "backslash"]);
  assert.deepEqual(parseShellWords("echo \\$HOME"), ["echo", "$HOME"]);
});

test("parseShellWords: preserves metacharacters verbatim (the user wants the shell to interpret them)", () => {
  // The point of the helper: argv tokens are the same on every platform.
  // The shell's pipe/redirect/&& handling is up to the runtime shell.
  assert.deepEqual(parseShellWords("npm test 2>&1 | tee log.txt"), ["npm", "test", "2>&1", "|", "tee", "log.txt"]);
  assert.deepEqual(parseShellWords("make && make test"), ["make", "&&", "make", "test"]);
});

test("parseShellWords: real-world template commands parse as expected", () => {
  assert.deepEqual(parseShellWords("npm run lint"), ["npm", "run", "lint"]);
  assert.deepEqual(parseShellWords("npx tsc --noEmit"), ["npx", "tsc", "--noEmit"]);
  assert.deepEqual(parseShellWords("npm test"), ["npm", "test"]);
  // The cycle-0 case: a maliciously-crafted command with quotes that
  // would tokenize differently on POSIX sh vs cmd.exe.
  assert.deepEqual(parseShellWords('"echo" "hi"'), ["echo", "hi"]);
});

test("parseShellWords: empty string returns empty array", () => {
  assert.deepEqual(parseShellWords(""), []);
  assert.deepEqual(parseShellWords("   "), []);
});

test("parseShellWords: unbalanced quote is a literal char (graceful degradation, not a throw)", () => {
  // A real shell would error. The helper's job is to give a *portable* view
  // of argv; if the user typed a malformed command, we surface what we have
  // rather than crashing. The runtime shell (exec) will report the error.
  assert.deepEqual(parseShellWords("echo 'unterminated"), ["echo", "unterminated"]);
  assert.deepEqual(parseShellWords('echo "unterminated'), ["echo", "unterminated"]);
});

// ── C-2 regression: thread corrupt-state signal through readers ──────────────
// The v0.4.0 readers (`readGoalState`, `readHandoff`) collapsed three
// distinct failure modes (missing / oversize / corrupt) into a single
// `null`. A corrupt `.goal-state.json` was silently treated as "no goal"
// and the next `setGoal` overwrote it, destroying recoverable evidence.
// v0.4.1 fixes this by introducing a tri-state `ReadResult<T>` reader
// (`readGoalStateResult`, `readHandoffResult`) that distinguishes the
// three failure modes. On `corrupt`, the reader renames the file to
// `<original>.corrupt.<ts>` BEFORE returning so the user has a forensic
// recovery path. See REVIEW-V040-MULTI-ANGLE.md §2.2.

// Pin: no state file → ReadResult is `absent`. The "no goal set" case.
test("C-2: readGoalStateResult returns {kind:'absent'} for missing state file", () => {
  const dir = freshDir();
  try {
    const r = readGoalStateResult(dir);
    assert.equal(r.kind, "absent");
    // The deprecated shim `readGoalState` returns null for the same case.
    assert.equal(readGoalState(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Pin: empty state file (size 0) is treated as `absent` (not `corrupt`).
// The GUI's readGoalStateSafe pre-check surfaces a dedicated "empty"
// summary for this case; the core reader collapses it into `absent` to
// match the pre-v0.4.1 behavior. The existing GUI test suite pins the
// empty-file summary string.
test("C-2: readGoalStateResult returns {kind:'absent'} for empty (size 0) state file", () => {
  const dir = freshDir();
  try {
    const statePath = join(dir, STATE_FILE);
    mkdirSync(join(dir, ".opencode"), { recursive: true });
    writeFileSync(statePath, "", "utf-8");
    const r = readGoalStateResult(dir);
    assert.equal(r.kind, "absent");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Pin: malformed JSON in the state file → ReadResult is
// `{kind:'corrupt', reason:'parse'}`, AND the file is renamed to
// `<original>.corrupt.<ts>` best-effort. The next setGoal can then
// write a fresh state without overwriting the corrupt evidence. This
// is the v0.4.1 C-2 fix.
test("C-2: readGoalStateResult returns {kind:'corrupt', reason:'parse'} and renames for malformed JSON", () => {
  const dir = freshDir();
  try {
    const statePath = join(dir, STATE_FILE);
    mkdirSync(join(dir, ".opencode"), { recursive: true });
    writeFileSync(statePath, "{{{not valid json}}}", "utf-8");
    const r = readGoalStateResult(dir);
    assert.equal(r.kind, "corrupt");
    if (r.kind === "corrupt") {
      assert.equal(r.reason, "parse");
      assert.ok(r.rawSize > 0, "rawSize should reflect the corrupt file's actual size");
    }
    // The reader has renamed the file. The original path is gone.
    assert.equal(existsSync(statePath), false,
      "the corrupt state file must be renamed, not left in place for a silent overwrite");
    // The renamed file exists in the same directory, with a `.corrupt.<ts>` suffix.
    const dirEntries = readdirSync(join(dir, ".opencode"));
    const renamed = dirEntries.find((e) => e.startsWith(".goal-state.json.corrupt."));
    assert.ok(renamed, `expected a renamed .goal-state.json.corrupt.<ts> file, got entries: ${dirEntries.join(", ")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Pin: JSON-valid but schema-invalid state file → ReadResult is
// `{kind:'corrupt', reason:'validate'}`, AND the file is renamed. A
// hand-crafted state file with a missing `constraints.maxTurns` (the
// cycle-0 silent-infinite-loop case) is the canonical example.
test("C-2: readGoalStateResult returns {kind:'corrupt', reason:'validate'} and renames for schema-invalid state", () => {
  const dir = freshDir();
  try {
    const statePath = join(dir, STATE_FILE);
    mkdirSync(join(dir, ".opencode"), { recursive: true });
    // JSON-valid but missing the required `constraints.maxTurns`.
    writeFileSync(statePath, JSON.stringify({
      version: 1, id: "x", condition: "x", status: "active",
      createdAt: 1, startedAt: 1, completedAt: null, pausedAt: null, resumedAt: null,
      turnsEvaluated: 0, tokensUsed: 0, lastEvaluation: null, evaluationHistory: [],
      constraints: {}, // the cycle-0 silent-infinite-loop case
      metadata: { setBy: "user" },
    }), "utf-8");
    const r = readGoalStateResult(dir);
    assert.equal(r.kind, "corrupt");
    if (r.kind === "corrupt") {
      assert.equal(r.reason, "validate");
    }
    assert.equal(existsSync(statePath), false,
      "schema-invalid state file must be renamed, not silently overwritten on next setGoal");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Pin: oversized state file (> MAX_STATE_SIZE = 256KB) → ReadResult is
// `{kind:'corrupt', reason:'oversize'}`, AND the file is renamed.
test("C-2: readGoalStateResult returns {kind:'corrupt', reason:'oversize'} and renames for >256KB state file", () => {
  const dir = freshDir();
  try {
    const statePath = join(dir, STATE_FILE);
    mkdirSync(join(dir, ".opencode"), { recursive: true });
    // JSON-valid schema; the file just happens to be > 256KB.
    const junk = "x".repeat(300_000);
    writeFileSync(statePath, JSON.stringify({
      version: 1, id: "x", condition: junk.slice(0, 1000), status: "active",
      createdAt: 1, startedAt: 1, completedAt: null, pausedAt: null, resumedAt: null,
      turnsEvaluated: 0, tokensUsed: 0, lastEvaluation: null, evaluationHistory: [],
      constraints: { maxTurns: 20, maxTimeMinutes: 30, maxTokens: 100000 },
      metadata: { setBy: "user", junk },
    }), "utf-8");
    const r = readGoalStateResult(dir);
    assert.equal(r.kind, "corrupt");
    if (r.kind === "corrupt") {
      assert.equal(r.reason, "oversize");
      assert.ok(r.rawSize > 256 * 1024, `rawSize should be > 256KB, got ${r.rawSize}`);
    }
    assert.equal(existsSync(statePath), false,
      "oversized state file must be renamed, not silently overwritten");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Pin: readGoalStateRawResult (used by persistGoal to inspect the existing
// state's status / webhook for replacement decisions) returns the same
// tri-state ReadResult, but with NO "validate" reason (the validator is
// bypassed). On parse error, the file is also renamed.
test("C-2: readGoalStateRawResult returns {kind:'corrupt', reason:'parse'} and renames for malformed JSON", () => {
  const dir = freshDir();
  try {
    const statePath = join(dir, STATE_FILE);
    mkdirSync(join(dir, ".opencode"), { recursive: true });
    writeFileSync(statePath, "not json at all", "utf-8");
    const r = readGoalStateRawResult(dir);
    assert.equal(r.kind, "corrupt");
    if (r.kind === "corrupt") {
      assert.equal(r.reason, "parse");
    }
    assert.equal(existsSync(statePath), false,
      "the corrupt raw-state file must be renamed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Pin: setGoal after a corrupt state file works normally and creates a
// fresh state. This is the C-2 end-to-end regression: the user had a
// corrupt .goal-state.json (e.g. a partial write from a crashed prior
// process), runs /goal set, and the new state is created without
// throwing or hanging. The corrupt file has been renamed to
// `.corrupt.<ts>` by the reader, so the evidence is preserved.
test("C-2: setGoal after a corrupt state file works normally and creates fresh state", () => {
  const dir = freshDir();
  try {
    const statePath = join(dir, STATE_FILE);
    mkdirSync(join(dir, ".opencode"), { recursive: true });
    writeFileSync(statePath, "garbage", "utf-8");
    // The reader runs inside persistGoal (called from setGoal). It
    // renames the corrupt file and returns the `corrupt` ReadResult;
    // persistGoal then proceeds to writeGoalStateAtomic, which creates
    // a fresh tmp + rename. The new state is at the original path.
    const res = setGoal(dir, "fresh goal after corruption", { now: 1_000 });
    assert.equal(res.ok, true);
    const fresh = readGoalState(dir);
    assert.ok(fresh, "fresh state must be readable from the original path");
    assert.equal(fresh.condition, "fresh goal after corruption");
    // The original corrupt file is gone (renamed); the new state is at
    // the canonical path. A forensic read of the directory should find
    // the `.corrupt.<ts>` file.
    const entries = readdirSync(join(dir, ".opencode"));
    const renamed = entries.find((e) => e.startsWith(".goal-state.json.corrupt."));
    assert.ok(renamed, `expected the corrupt file to be preserved as .corrupt.<ts>, got: ${entries.join(", ")}`);
    // And the new state file is at the original canonical path.
    const canonical = entries.find((e) => e === ".goal-state.json");
    assert.ok(canonical, "the fresh state file must be at the canonical .goal-state.json path");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Pin: readHandoffResult returns the same tri-state ReadResult for the
// handoff file. Missing → absent. Malformed JSON → corrupt + rename.
// This is the v0.4.1 C-2 fix for the handoff file (the v0.4.0 cycle had
// the same silent-corruption bug for handoffs).
test("C-2: readHandoffResult returns {kind:'absent'} for missing handoff, {kind:'corrupt', reason:'parse'} for malformed, with rename", () => {
  const dir = freshDir();
  try {
    // No handoff file: absent.
    const a = readHandoffResult(dir);
    assert.equal(a.kind, "absent");
    // Write a malformed handoff file: corrupt + rename.
    const handoffPath = join(dir, HANDOFF_FILE);
    mkdirSync(join(dir, ".opencode"), { recursive: true });
    writeFileSync(handoffPath, "not a valid handoff", "utf-8");
    const c = readHandoffResult(dir);
    assert.equal(c.kind, "corrupt");
    if (c.kind === "corrupt") {
      assert.equal(c.reason, "parse");
    }
    assert.equal(existsSync(handoffPath), false,
      "the corrupt handoff file must be renamed");
    // The legacy shim still returns null for both cases.
    assert.equal(readHandoff(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

