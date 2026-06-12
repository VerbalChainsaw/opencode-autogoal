/**
 * End-to-end CLI tests: spawn the compiled `dist/cli.js` as a child
 * process, send commands, verify stdout + exit codes. These tests
 * exercise the real binary path the way a user would: `opencode-autogoal set ...`
 *
 * The tests are cross-platform (Windows / macOS / Linux) and use Node's
 * `node:child_process` to invoke the binary with the project's bundled
 * Node interpreter.
 *
 * Each test uses a fresh temp dir so the state file is isolated.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "dist", "cli.js");
const NODE = process.execPath; // bundled Node, guarantees version match

function freshDir() {
  return mkdtempSync(join(tmpdir(), "opengoal-cli-e2e-"));
}

function runCli(cwd, args) {
  return spawnSync(NODE, [CLI, ...args], {
    cwd,
    encoding: "utf-8",
    timeout: 10_000,
  });
}

// ── Smoke ─────────────────────────────────────────────────────────────────

test("CLI binary exists and is executable", () => {
  // If this fails, `npm run build` wasn't run before `npm test`.
  const r = runCli(freshDir(), ["help"]);
  assert.equal(r.status, 0, `help should exit 0, got: ${r.status}\nstderr: ${r.stderr}`);
  assert.match(r.stdout, /opencode-autogoal/);
  assert.match(r.stdout, /Commands:/);
});

test("CLI help exits 0 and prints the help block", () => {
  const r = runCli(freshDir(), ["help"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage: opencode-autogoal/);
  assert.match(r.stdout, /set <condition>/);
  assert.match(r.stdout, /status/);
  assert.match(r.stdout, /turns <n>/);
});

// ── Real workflow ─────────────────────────────────────────────────────────

test("CLI: set → status → turns 50 → status, in a fresh dir", () => {
  const dir = freshDir();
  try {
    const r1 = runCli(dir, ["set", "make all tests pass"]);
    assert.equal(r1.status, 0, `set should exit 0, stderr: ${r1.stderr}`);
    assert.match(r1.stdout, /A goal has been set/);
    assert.match(r1.stdout, /GOAL: make all tests pass/);
    assert.doesNotMatch(r1.stdout, /Tell the user this/,
      `set output should not contain the agent-prompt relay wrapper`);

    const r2 = runCli(dir, ["status"]);
    assert.equal(r2.status, 0);
    assert.match(r2.stdout, /Condition: make all tests pass/);
    assert.match(r2.stdout, /Status: active/);
    assert.match(r2.stdout, /Progress: 0\/20 turns/);

    const r3 = runCli(dir, ["turns", "50"]);
    assert.equal(r3.status, 0);
    assert.match(r3.stdout, /Max turns: 20 → 50/);

    const r4 = runCli(dir, ["status"]);
    assert.equal(r4.status, 0);
    assert.match(r4.stdout, /Progress: 0\/50 turns/,
      `max-turns update should be reflected in subsequent status`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("CLI: 'status' is an alias for 'view'", () => {
  const dir = freshDir();
  try {
    runCli(dir, ["set", "x"]);
    const r1 = runCli(dir, ["view"]);
    const r2 = runCli(dir, ["status"]);
    assert.equal(r1.status, 0);
    assert.equal(r2.status, 0);
    assert.equal(r1.stdout, r2.stdout,
      `view and status should produce identical output`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── Exit codes ────────────────────────────────────────────────────────────

test("CLI: 'turns abc' exits 1 (usage error)", () => {
  const dir = freshDir();
  try {
    runCli(dir, ["set", "x"]);
    const r = runCli(dir, ["turns", "abc"]);
    assert.equal(r.status, 1, `expected exit 1, got: ${r.status}\nstdout: ${r.stdout}`);
    assert.match(r.stdout, /Usage: \/goal turns/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("CLI: 'unknown_cmd' exits 1 and prints help", () => {
  const r = runCli(freshDir(), ["unknown_cmd"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown command "unknown_cmd"/);
  assert.match(r.stderr, /Usage: opencode-autogoal/);
});

test("CLI: 'pause' with no goal exits 2 (no-goal)", () => {
  const r = runCli(freshDir(), ["pause"]);
  assert.equal(r.status, 2, `expected exit 2, got: ${r.status}\nstdout: ${r.stdout}`);
  assert.match(r.stdout, /No active goal/);
});

// ── R2-1: transitionGoal reason-field refactor e2e ───────────────────────

test("R2-1 e2e: 'clear' with no goal exits 2 (no-goal), not 3 (write-failed)", () => {
  // Before R2-1, the clear branch fell through to write-failed (exit 3)
  // because there was no reason-switch. After R2-1 it maps to no-goal
  // (exit 2) — the same kind the pause branch already had.
  const r = runCli(freshDir(), ["clear"]);
  assert.equal(r.status, 2,
    `expected exit 2 for 'clear' with no goal; got: ${r.status}\nstdout: ${r.stdout}`);
  assert.match(r.stdout, /No active goal/);
});

test("R2-1 e2e: 'resume' when already active exits 0 (already-in-state, no-op)", () => {
  // Before R2-1, "Goal is already active." fell through to write-failed
  // (exit 3). After R2-1 it maps to already-in-state (exit 0) — the
  // no-op kind, mirroring pause-from-paused.
  const dir = freshDir();
  try {
    runCli(dir, ["set", "x"]); // active
    const r = runCli(dir, ["resume"]);
    assert.equal(r.status, 0,
      `expected exit 0 for 'resume' when already active (no-op); got: ${r.status}\nstdout: ${r.stdout}`);
    assert.match(r.stdout, /already active/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── Adversarial A1: restart / handoff on terminal goal exit 2 ──────────────

test("A1 e2e: 'restart' on cleared goal exits 2 (terminal-state, not 3)", () => {
  const dir = freshDir();
  try {
    runCli(dir, ["set", "x"]);
    runCli(dir, ["clear"]);
    const r = runCli(dir, ["restart"]);
    assert.equal(r.status, 2,
      `expected exit 2 for 'restart' on cleared; got: ${r.status}\nstdout: ${r.stdout}`);
    assert.match(r.stdout, /Cannot restart a cleared goal/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("A1 e2e: 'handoff' on cleared goal exits 2 (terminal-state, not 3)", () => {
  const dir = freshDir();
  try {
    runCli(dir, ["set", "y"]);
    runCli(dir, ["clear"]);
    const r = runCli(dir, ["handoff", "for-tomorrow"]);
    assert.equal(r.status, 2,
      `expected exit 2 for 'handoff' on cleared; got: ${r.status}\nstdout: ${r.stdout}`);
    assert.match(r.stdout, /Cannot handoff/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── Adversarial A2 / A3: --command edge cases ─────────────────────────────

test("A2 e2e: 'set x --command \"\"' (empty quoted) → no command, not error", () => {
  // A2: the user wants a goal with no verification command. The
  // shell strips the quotes, buildSetPayload sees an empty value,
  // strips the --command flag entirely. Goal is stored with
  // command=null (the primitive's "no command" representation).
  const dir = freshDir();
  try {
    const r = runCli(dir, ["set", "x", "--command", ""]);
    assert.equal(r.status, 0,
      `expected exit 0 for 'set x --command ""'; got: ${r.status}\nstdout: ${r.stdout}`);
    const statePath = join(dir, ".opencode", ".goal-state.json");
    const state = JSON.parse(readFileSync(statePath, "utf-8"));
    assert.equal(state.condition, "x");
    assert.equal(state.command, null, `expected command=null for empty --command; got: ${JSON.stringify(state.command)}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("A3 e2e: duplicate --command → exit 1 (usage error, not silent first)", () => {
  // A3: the second --command was previously silently treated as
  // condition text, producing a goal like condition="x --command b"
  // command="a". Now it errors with a clear "duplicate" message.
  const dir = freshDir();
  try {
    const r = runCli(dir, ["set", "x", "--command", "a", "--command", "b"]);
    assert.equal(r.status, 1,
      `expected exit 1 for duplicate --command; got: ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(r.stderr, /duplicate --command/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── Obs 3: e2e coverage of dispatcher precondition paths ─────────────────

test("e2e coverage: 'view' with no goal exits 2 (no-goal)", () => {
  // The unit test covers this; e2e covers the binary's exit code.
  const r = runCli(freshDir(), ["view"]);
  assert.equal(r.status, 2, `expected exit 2; got: ${r.status}\nstdout: ${r.stdout}`);
  assert.match(r.stdout, /No active goal/);
});

test("e2e coverage: 'set \"\"' (empty condition) exits 1 (invalid-value)", () => {
  // C-1 fix: an empty condition is a bad-user-input failure (the user
  // typed nothing or only whitespace). The dispatcher's typed `reason`
  // switches to kind:"invalid-value" → CLI exit 1, NOT kind:"no-goal"
  // → CLI exit 2. The previous behavior collapsed all 3 set-failure
  // causes (invalid value, too-long, write-failed) to kind:"no-goal",
  // which is wrong on every count.
  const r = runCli(freshDir(), ["set", ""]);
  assert.equal(r.status, 1, `expected exit 1; got: ${r.status}\nstdout: ${r.stdout}`);
  assert.match(r.stdout, /cannot be empty/i);
});

test("e2e coverage: 'set ' ' (whitespace condition) exits 1 (invalid-value)", () => {
  // C-1 fix: whitespace-only is also a bad-user-input failure. Same
  // kind:"invalid-value" → exit 1 mapping as the empty-condition case.
  const r = runCli(freshDir(), ["set", " "]);
  assert.equal(r.status, 1, `expected exit 1; got: ${r.status}\nstdout: ${r.stdout}`);
  assert.match(r.stdout, /cannot be empty/i);
});

// ── C-1: SetResult discriminated union — exit-code regression tests ───────
//
// DEFECT (REVIEW-V040-MULTI-ANGLE.md §2.1, Track C): `SetResult` was the
// only "result object" interface in the codebase still using the
// pre-refactor pattern (optional `error`/`state`/`replaced` fields, no
// discriminant). `setGoal` returned three distinct failure causes —
// invalid value (CLI exit 1), too-long value (CLI exit 1), and disk-write
// failure (CLI exit 3) — all collapsed to `kind: "no-goal"` (CLI exit 2)
// by the dispatcher. Scripts that branch on exit code got the wrong
// answer for every `set` failure.
//
// POST-FIX: `SetResult` is a discriminated union with a typed `reason`.
// The dispatcher switches on `reason` directly:
//   - "invalid-value"  → kind: "invalid-value" → CLI exit 1
//   - "write-failed"   → kind: "write-failed"  → CLI exit 3
//   - OK branch        → kind: "set"           → CLI exit 0
//
// The two existing 'set ""' / 'set " "' tests above were flipped from
// exit-2 to exit-1 (they asserted the buggy behavior). The tests below
// are the explicit C-1 regression markers, with cross-references to the
// review document.

test("C-1 e2e: 'set \"\"' exits 1 (invalid-value, NOT no-goal exit 2)", () => {
  // REGRESSION: prior to v0.4.1, the dispatcher collapsed all `set`
  // failures to kind:"no-goal" (CLI exit 2) because `SetResult` had no
  // `reason` field and the dispatcher couldn't tell "user typed nothing"
  // (exit 1) from "disk full" (exit 3). The C-1 fix added a typed
  // `reason: "invalid-value" | "write-failed"` discriminant. This test
  // pins the post-fix behavior: an empty condition is bad user input,
  // not "no active goal", so it must exit 1.
  const r = runCli(freshDir(), ["set", ""]);
  assert.equal(r.status, 1,
    `C-1 REGRESSION: 'set ""' should exit 1 (invalid-value); ` +
    `got: ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  // The error message identifies it as a set failure (not "No active goal").
  assert.match(r.stdout, /Goal not set|cannot be empty/i);
  assert.doesNotMatch(r.stdout, /No active goal/,
    `C-1: 'set ""' must NOT print "No active goal" — that's the no-goal kind`);
});

test("C-1 e2e: 'set <x>' against a non-directory .opencode exits 3 (write-failed, NOT no-goal exit 2)", () => {
  // REGRESSION: prior to v0.4.1, a write failure during `set` was
  // reported as kind:"no-goal" (CLI exit 2). The C-1 fix maps
  // `SetResult.reason === "write-failed"` to kind:"write-failed" (CLI
  // exit 3) so scripts can distinguish "user typed something but the
  // disk is broken" (exit 3) from "there's no active goal" (exit 2).
  //
  // Cross-platform reproduction: replace `<dir>/.opencode` (which the
  // writer expects to be a directory) with a regular file. The
  // `writeGoalStateAtomic` writer does:
  //   1. mkdirSync(<dir>/.opencode, { recursive: true })   — skipped
  //      (existsSync returns true for the file)
  //   2. writeFileSync(<dir>/.opencode/.goal-state.json.tmp.XXX, ...)
  //      — fails: on Linux ENOTDIR, on Windows ENOENT.
  // The error is caught by `persistGoal` and returned as
  // `{ ok: false, reason: "write-failed", error: "Failed to write state: ..." }`.
  // The dispatcher then maps to kind:"write-failed" → CLI exit 3.
  //
  // This approach is portable (works on Linux, macOS, Windows) and
  // doesn't require chmod/icacls, which is brittle in CI and on
  // permission-less filesystems.
  const dir = freshDir();
  try {
    // Replace `<dir>/.opencode` with a regular file BEFORE invoking the CLI.
    // The CLI will try to create `<dir>/.opencode/.goal-state.json` and
    // fail because `.opencode` isn't a directory.
    writeFileSync(join(dir, ".opencode"), "i am a regular file, not a directory", "utf-8");
    assert.equal(statSync(join(dir, ".opencode")).isDirectory(), false,
      "test fixture: .opencode must be a regular file, not a directory");

    const r = runCli(dir, ["set", "this should fail because .opencode is a file"]);
    assert.equal(r.status, 3,
      `C-1 REGRESSION: 'set' with non-directory .opencode should exit 3 (write-failed); ` +
      `got: ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    // The error message should include "Failed to write state" (the
    // persistGoal path's prose) and NOT the "No active goal" no-goal kind.
    assert.match(r.stdout, /Failed to write state/,
      `expected 'Failed to write state' in stdout; got: ${r.stdout}`);
    assert.doesNotMatch(r.stdout, /No active goal/,
      `C-1: write failure must NOT print "No active goal" — that's the no-goal kind`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── B2: CLI missing actions that the dispatcher supports ────────────────

test("B2 e2e: 'cancel' (alias for clear) clears the active goal", () => {
  // B2: the dispatcher's CLEAR_ALIASES includes "cancel" but the CLI
  // didn't map it, so `opencode-autogoal cancel` returned "unknown
  // command". After the fix, it should clear the active goal.
  const dir = freshDir();
  try {
    runCli(dir, ["set", "x"]);
    const r = runCli(dir, ["cancel"]);
    assert.equal(r.status, 0,
      `expected exit 0 for 'cancel' on active; got: ${r.status}\nstderr: ${r.stderr}`);
    assert.match(r.stdout, /cleared/i);
    // Followed by a no-op: clearing again is a no-goal
    const r2 = runCli(dir, ["cancel"]);
    assert.equal(r2.status, 2, `second cancel should be no-goal (exit 2), got: ${r2.status}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("B2 e2e: 'off' (alias for clear) clears the active goal", () => {
  const dir = freshDir();
  try {
    runCli(dir, ["set", "x"]);
    const r = runCli(dir, ["off"]);
    assert.equal(r.status, 0, `expected exit 0; got: ${r.status}\nstderr: ${r.stderr}`);
    assert.match(r.stdout, /cleared/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("B2 e2e: 'reset' and 'none' (aliases for clear) work", () => {
  for (const alias of ["reset", "none"]) {
    const dir = freshDir();
    try {
      runCli(dir, ["set", "x"]);
      const r = runCli(dir, [alias]);
      assert.equal(r.status, 0,
        `expected exit 0 for '${alias}' on active; got: ${r.status}\nstderr: ${r.stderr}`);
      assert.match(r.stdout, /cleared/i);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test("B2 e2e: 'template fix-lint' sets a goal from a built-in template", () => {
  // The dispatcher supports `template <name>` (and `use <name>` as an
  // alias). The CLI was missing both mappings. After the fix, the
  // built-in `fix-lint` template should set a goal.
  const dir = freshDir();
  try {
    const r = runCli(dir, ["template", "fix-lint"]);
    assert.equal(r.status, 0,
      `expected exit 0 for 'template fix-lint'; got: ${r.status}\nstderr: ${r.stderr}`);
    assert.match(r.stdout, /A goal has been set/);
    assert.match(r.stdout, /GOAL:/);
    const state = JSON.parse(readFileSync(join(dir, ".opencode", ".goal-state.json"), "utf-8"));
    assert.equal(state.status, "active");
    // Templates set metadata.setBy = "template" so the agent can
    // distinguish template-set goals from user-typed ones.
    assert.equal(state.metadata?.setBy, "template",
      `template-set goal should have setBy=template; got: ${state.metadata?.setBy}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("B2 e2e: 'use <name>' is an alias for 'template <name>'", () => {
  const dir = freshDir();
  try {
    const r = runCli(dir, ["use", "fix-lint"]);
    assert.equal(r.status, 0,
      `expected exit 0 for 'use fix-lint'; got: ${r.status}\nstderr: ${r.stderr}`);
    assert.match(r.stdout, /A goal has been set/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("B2 e2e: 'template nonexistent' exits 1 (usage)", () => {
  // The dispatcher returns kind='usage' for unknown template names.
  // After B2, the CLI must reach the dispatcher and surface that.
  const dir = freshDir();
  try {
    const r = runCli(dir, ["template", "this-template-does-not-exist"]);
    assert.equal(r.status, 1, `expected exit 1; got: ${r.status}\nstderr: ${r.stderr}`);
    assert.match(r.stdout, /not found/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("B2 e2e: 'template bad/name' (path traversal) is rejected with usage", () => {
  // The dispatcher validates template names: only [A-Za-z0-9_-]+ is
  // allowed. Path traversal attempts like '../etc/x' must be
  // rejected before they hit the filesystem. B2 made the CLI reach
  // the dispatcher for template actions; this pins the safety.
  const dir = freshDir();
  try {
    const r = runCli(dir, ["template", "../etc/passwd"]);
    assert.equal(r.status, 1, `expected exit 1; got: ${r.status}\nstderr: ${r.stderr}`);
    assert.match(r.stdout, /Invalid template name/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── --dir flag ────────────────────────────────────────────────────────────

test("CLI: --dir <path> operates on a different directory's state file", () => {
  const dirA = freshDir();
  const dirB = freshDir();
  try {
    // Set a goal in dirA
    runCli(dirA, ["set", "goal for A"]);
    // Set a goal in dirB (using --dir)
    runCli(dirB, ["set", "goal for B"]);
    // Verify each dir's state is independent
    const rA = runCli(dirA, ["status"]);
    const rB = runCli(dirB, ["status"]);
    assert.match(rA.stdout, /goal for A/);
    assert.match(rB.stdout, /goal for B/);
    assert.doesNotMatch(rA.stdout, /goal for B/);
    assert.doesNotMatch(rB.stdout, /goal for A/);
  } finally {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
});

test("CLI: --dir with non-existent path exits 1 with error", () => {
  const r = runCli(freshDir(), ["--dir", "/this/does/not/exist/anywhere", "view"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /does not exist/);
});

// ── The "external tool" use case ───────────────────────────────────────────

test("CLI: another tool can observe the goal's state by reading the state file", () => {
  // The README's value-prop: external tools can drive the goal loop
  // via the CLI and observe state via the state file. This is the
  // "looper agent for other software" foundation.
  const dir = freshDir();
  try {
    // After Task 4, --command takes the SINGLE next argv element as
    // the value (the user's shell already grouped multi-word commands
    // into one arg). The CLI re-quotes it for the dispatcher's parser.
    runCli(dir, ["set", "external driver test", "--command", "echo done"]);
    // Read the state file directly (any external tool can do this)
    const statePath = join(dir, ".opencode", ".goal-state.json");
    const state = JSON.parse(readFileSync(statePath, "utf-8"));
    assert.equal(state.condition, "external driver test");
    assert.equal(state.command, "echo done");
    assert.equal(state.status, "active");
    // The external tool can ALSO drive actions
    const r = runCli(dir, ["turns", "200"]);
    assert.equal(r.status, 0);
    const after = JSON.parse(readFileSync(statePath, "utf-8"));
    assert.equal(after.constraints.maxTurns, 200,
      "CLI-driven turn update should be reflected in the state file");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── v0.4.0 Phase 1: chain CLI ─────────────────────────────────────────────
// End-to-end tests for the `chain` subcommand family. These complement
// the unit tests in test/goal-chain.test.mjs by exercising the binary
// path (CLI → dispatcher → chain primitives).

function writeChainJson(dir, content) {
  const path = join(dir, "chain.json");
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content), "utf-8");
  return path;
}

test("chain e2e: 'chain start <json-file>' reads the file and sets step 0 active", () => {
  const dir = freshDir();
  try {
    const jsonPath = writeChainJson(dir, [
      { condition: "first" },
      { condition: "second", maxTurns: 10 },
      { condition: "third" },
    ]);
    const r = runCli(dir, ["chain", "start", jsonPath]);
    assert.equal(r.status, 0, `expected exit 0; got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(r.stdout, /Chain started with 3 steps/);
    assert.match(r.stdout, /Step 1\/3: first/);

    // Verify state + chain files on disk
    const statePath = join(dir, ".opencode", ".goal-state.json");
    const state = JSON.parse(readFileSync(statePath, "utf-8"));
    assert.equal(state.status, "active");
    assert.equal(state.condition, "first");
    assert.ok(state.metadata.chainId, "chainId must be set on the active state");
    assert.equal(state.metadata.chainStep, 0);
    assert.equal(state.metadata.chainTotal, 3);
    // step 2 in the JSON had maxTurns:10; not active yet, so the active state
    // uses the DEFAULT (20). Pin that overrides only apply to their own step.
    assert.equal(state.constraints.maxTurns, 20);

    const chainPath = join(dir, ".opencode", ".goal-chain.json");
    const chain = JSON.parse(readFileSync(chainPath, "utf-8"));
    assert.equal(chain.steps.length, 3);
    assert.equal(chain.current, 0);
    assert.equal(chain.id, state.metadata.chainId);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("chain e2e: 'chain' (no subcommand) prints current chain + progress", () => {
  const dir = freshDir();
  try {
    const jsonPath = writeChainJson(dir, [
      { condition: "alpha" },
      { condition: "beta" },
      { condition: "gamma" },
    ]);
    runCli(dir, ["chain", "start", jsonPath]);
    const r = runCli(dir, ["chain"]);
    assert.equal(r.status, 0, `expected exit 0; got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(r.stdout, /Chain: [0-9a-f]{8} · 3 steps · current: 1\/3/);
    assert.match(r.stdout, /Mode: stop on completion/);
    assert.match(r.stdout, /🎯 Step 1: alpha/);
    assert.match(r.stdout, /⬜ Step 2: beta/);
    assert.match(r.stdout, /⬜ Step 3: gamma/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("chain e2e: 'chain skip' advances to next step without achievement", () => {
  const dir = freshDir();
  try {
    const jsonPath = writeChainJson(dir, [
      { condition: "a" },
      { condition: "b" },
      { condition: "c" },
    ]);
    runCli(dir, ["chain", "start", jsonPath]);
    // Skip from step 1 to step 2
    const r1 = runCli(dir, ["chain", "skip"]);
    assert.equal(r1.status, 0, `expected exit 0; got ${r1.status}\nstdout: ${r1.stdout}\nstderr: ${r1.stderr}`);
    assert.match(r1.stdout, /Step 2\/3: b/);
    const state = JSON.parse(readFileSync(join(dir, ".opencode", ".goal-state.json"), "utf-8"));
    assert.equal(state.condition, "b");
    assert.equal(state.metadata.chainStep, 1);
    // Skip from step 2 to step 3
    const r2 = runCli(dir, ["chain", "skip"]);
    assert.equal(r2.status, 0);
    assert.match(r2.stdout, /Step 3\/3: c/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("chain e2e: 'chain reset' returns to step 0 (from any step)", () => {
  const dir = freshDir();
  try {
    const jsonPath = writeChainJson(dir, [
      { condition: "x" },
      { condition: "y" },
    ]);
    runCli(dir, ["chain", "start", jsonPath]);
    runCli(dir, ["chain", "skip"]); // now at step 2
    const r = runCli(dir, ["chain", "reset"]);
    assert.equal(r.status, 0, `expected exit 0; got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(r.stdout, /Chain reset to step 1\/2/);
    const state = JSON.parse(readFileSync(join(dir, ".opencode", ".goal-state.json"), "utf-8"));
    assert.equal(state.condition, "x");
    assert.equal(state.metadata.chainStep, 0);
    const chain = JSON.parse(readFileSync(join(dir, ".opencode", ".goal-chain.json"), "utf-8"));
    assert.equal(chain.current, 0);
    assert.equal(chain.cycles, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("chain e2e: 'chain start' with non-existent path → exit 1 (invalid-value)", () => {
  const dir = freshDir();
  try {
    const r = runCli(dir, ["chain", "start", "does-not-exist.json"]);
    assert.equal(r.status, 1, `expected exit 1; got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    // Updated to match the new explicit existsSync guard in command.ts:454
    // (red-team audit: chain start size cap). The guard fires a clean
    // "Chain file not found" message instead of the catch-all "Failed to
    // read chain file" with an ENOENT suffix.
    assert.match(r.stdout, /Chain file not found/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("chain e2e: 'chain start' with malformed JSON → exit 1 (invalid-value)", () => {
  const dir = freshDir();
  try {
    const jsonPath = writeChainJson(dir, "{not valid json");
    const r = runCli(dir, ["chain", "start", jsonPath]);
    assert.equal(r.status, 1, `expected exit 1; got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(r.stdout, /Failed to read chain file/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("chain e2e: 'chain start' with JSON object (not array) → exit 1", () => {
  // The dispatcher explicitly checks Array.isArray — a top-level object is
  // not a valid chain (chain is an array of steps).
  const dir = freshDir();
  try {
    const jsonPath = writeChainJson(dir, { condition: "not-an-array" });
    const r = runCli(dir, ["chain", "start", jsonPath]);
    assert.equal(r.status, 1, `expected exit 1; got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(r.stdout, /must contain a JSON array of steps/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("chain e2e: 'chain start' with empty array → exit 1 (chain has no steps)", () => {
  const dir = freshDir();
  try {
    const jsonPath = writeChainJson(dir, []);
    const r = runCli(dir, ["chain", "start", jsonPath]);
    assert.equal(r.status, 1, `expected exit 1; got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    // createGoalChain returns "Chain must have at least one step."
    assert.match(r.stdout, /at least one step/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("chain e2e: 'chain start' with step missing condition → exit 1", () => {
  const dir = freshDir();
  try {
    const jsonPath = writeChainJson(dir, [{ maxTurns: 5 }, { condition: "ok" }]);
    const r = runCli(dir, ["chain", "start", jsonPath]);
    assert.equal(r.status, 1, `expected exit 1; got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(r.stdout, /condition cannot be empty/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Red-team audit regression: chain start MUST cap the file size before
// readFileSync. A 50MB JSON file would otherwise be read into memory
// (~100MB heap delta) and parsed before being rejected by the per-step
// condition cap. The size cap fires first.
test("chain e2e: 'chain start' oversized file (>256KB) is rejected with size error, no allocation", () => {
  const dir = freshDir();
  try {
    // Build a 300KB JSON file whose outer shape is valid (it's an array of
    // step objects). The single step has an absurdly long condition that
    // would normally fail the per-step cap AFTER being parsed in. The size
    // cap must fire FIRST.
    const step = { condition: "a".repeat(300 * 1024) };
    const big = "[" + JSON.stringify(step) + "]";
    const jsonPath = join(dir, "huge.json");
    writeFileSync(jsonPath, big, "utf-8");
    assert.ok(statSync(jsonPath).size > 256 * 1024, "test fixture must exceed the 256KB cap");

    const r = runCli(dir, ["chain", "start", jsonPath]);
    assert.equal(r.status, 1, `expected exit 1; got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    // The size-cap error mentions "too large" (matches the cap ordering in
    // command.ts:458). If we instead see a "condition must be N chars" error,
    // the size cap fired AFTER the parse — the bug is back.
    assert.match(r.stdout, /too large/i, `expected size-cap error first; got: ${r.stdout}`);
    assert.doesNotMatch(r.stdout, /condition must be/i, "size cap must fire before the per-step condition cap");
    // The state file must NOT exist (cap fires before any write).
    const statePath = join(dir, ".opencode", ".goal-state.json");
    assert.equal(existsSync(statePath), false, "oversized chain must not create a state file");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("chain e2e: 'chain' (no subcommand) with no active chain → exit 2 (no-goal)", () => {
  const r = runCli(freshDir(), ["chain"]);
  assert.equal(r.status, 2, `expected exit 2; got ${r.status}\nstdout: ${r.stdout}`);
  assert.match(r.stdout, /No active chain/);
});

test("chain e2e: 'chain skip' with no active chain → exit 2 (no-goal)", () => {
  const r = runCli(freshDir(), ["chain", "skip"]);
  assert.equal(r.status, 2, `expected exit 2; got ${r.status}\nstdout: ${r.stdout}`);
  assert.match(r.stdout, /No active chain/);
});

test("chain e2e: 'chain reset' with no active chain → exit 2 (no-goal)", () => {
  const r = runCli(freshDir(), ["chain", "reset"]);
  assert.equal(r.status, 2, `expected exit 2; got ${r.status}\nstdout: ${r.stdout}`);
  assert.match(r.stdout, /No active chain/);
});

test("chain e2e: full workflow — start → skip → skip → reset → status", () => {
  // End-to-end smoke of the chain lifecycle through the CLI binary.
  const dir = freshDir();
  try {
    const jsonPath = writeChainJson(dir, [
      { condition: "lint" },
      { condition: "test" },
      { condition: "build" },
    ]);
    // start
    const r1 = runCli(dir, ["chain", "start", jsonPath]);
    assert.equal(r1.status, 0);
    // skip (step 1 → step 2)
    const r2 = runCli(dir, ["chain", "skip"]);
    assert.equal(r2.status, 0);
    assert.match(r2.stdout, /Step 2\/3: test/);
    // skip (step 2 → step 3)
    const r3 = runCli(dir, ["chain", "skip"]);
    assert.equal(r3.status, 0);
    assert.match(r3.stdout, /Step 3\/3: build/);
    // skip past last step → chain completes
    const r4 = runCli(dir, ["chain", "skip"]);
    assert.equal(r4.status, 0);
    assert.match(r4.stdout, /All chain steps completed/);
    // reset → back to step 0
    const r5 = runCli(dir, ["chain", "reset"]);
    assert.equal(r5.status, 0);
    assert.match(r5.stdout, /Chain reset to step 1\/3/);
    // chain display shows step 1 active
    const r6 = runCli(dir, ["chain"]);
    assert.equal(r6.status, 0);
    assert.match(r6.stdout, /current: 1\/3/);
    assert.match(r6.stdout, /🎯 Step 1: lint/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── v0.4.1 E-1: chain start promotes pre-chain webhook ────────────────────
//
// DEFECT (Track E, §2.3 of REVIEW-V040-MULTI-ANGLE.md): The D6 spec
// added `{ webhook: "from-state" }` as a `createGoalChain` option, and
// the API + 11 e2e tests cover it. But `command.ts:466` called
// `createGoalChain(directory, steps)` with no webhook option. The
// pre-chain state's webhook was never promoted to the chain, so
// step 0's state had no `metadata.webhook` and the achieved transition
// did not fire a webhook.
//
// The CLI doesn't expose a `webhook` command (the `goal_webhook` tool
// is plugin-internal), so this test seeds the state file directly
// with `metadata.webhook` set — the same on-disk shape that the
// `goal_webhook` tool would produce. The chain start CLI must then
// promote that webhook onto the chain.
//
// PRE-FIX: chain.webhook === undefined (CLI doesn't pass the option)
//          → this assertion fails.
// POST-FIX: chain.webhook.url === "https://hook.example.invalid/test"
//          → this assertion passes.

test("chain e2e (E-1 regression): 'chain start' promotes pre-chain state's webhook to the chain", () => {
  const dir = freshDir();
  try {
    // 1. Set a goal via the CLI (this writes a clean state file).
    const r1 = runCli(dir, ["set", "ship the v0.4.1 patch"]);
    assert.equal(r1.status, 0, `set should exit 0; got ${r1.status}\nstderr: ${r1.stderr}`);

    // 2. Seed `metadata.webhook` into the state file directly. The
    //    shape mirrors what `goal_webhook` (server.ts:757) would
    //    produce: { url, on, allowLocal }.
    const PRE_CHAIN_WEBHOOK = {
      url: "https://hook.example.invalid/test",
      on: ["achieved", "cleared"],
      allowLocal: false,
    };
    const statePath = join(dir, ".opencode", ".goal-state.json");
    const state = JSON.parse(readFileSync(statePath, "utf-8"));
    state.metadata.webhook = PRE_CHAIN_WEBHOOK;
    writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");

    // Sanity: the seed is on disk before we start the chain.
    const before = JSON.parse(readFileSync(statePath, "utf-8"));
    assert.equal(before.metadata.webhook.url, PRE_CHAIN_WEBHOOK.url,
      "pre-chain webhook must be on disk before chain start");

    // 3. Start a chain via the CLI. The CLI's chain-start handler at
    //    command.ts:466 must pass `{ webhook: "from-state" }` so the
    //    pre-chain state webhook is promoted.
    const jsonPath = writeChainJson(dir, [
      { condition: "first step" },
      { condition: "second step" },
    ]);
    const r2 = runCli(dir, ["chain", "start", jsonPath]);
    assert.equal(r2.status, 0, `chain start should exit 0; got ${r2.status}\nstdout: ${r2.stdout}\nstderr: ${r2.stderr}`);
    assert.match(r2.stdout, /Chain started with 2 steps/);

    // 4. THE REGRESSION ASSERTION: the chain file's `webhook` field
    //    must equal the pre-chain state's webhook. Pre-fix code passes
    //    no webhook option, so `chain.webhook` is undefined and this
    //    assertion fails.
    const chainPath = join(dir, ".opencode", ".goal-chain.json");
    const chain = JSON.parse(readFileSync(chainPath, "utf-8"));
    assert.ok(chain.webhook,
      `E-1 REGRESSION: chain.webhook must be promoted from pre-chain state; ` +
      `chain: ${JSON.stringify(chain, null, 2)}`);
    assert.equal(chain.webhook.url, PRE_CHAIN_WEBHOOK.url,
      `chain.webhook.url must match the pre-chain state; got: ${chain.webhook.url}`);
    assert.deepEqual(chain.webhook.on, PRE_CHAIN_WEBHOOK.on,
      `chain.webhook.on must match the pre-chain state; got: ${JSON.stringify(chain.webhook.on)}`);
    assert.equal(chain.webhook.allowLocal, PRE_CHAIN_WEBHOOK.allowLocal,
      `chain.webhook.allowLocal must match the pre-chain state; got: ${chain.webhook.allowLocal}`);

    // 5. The active state's `metadata.webhook` must also carry the
    //    webhook (this is what `fireWebhook` in server.ts reads).
    //    The D6 fix at goal-chain.ts:223-233 projects `chain.webhook`
    //    onto the step state via `applyChainWebhookToState`.
    const step0 = JSON.parse(readFileSync(statePath, "utf-8"));
    assert.ok(step0.metadata.webhook,
      `step 0 state.metadata.webhook must be set (D6 projection); got: ${JSON.stringify(step0.metadata)}`);
    assert.equal(step0.metadata.webhook.url, PRE_CHAIN_WEBHOOK.url);
    assert.equal(step0.metadata.chainStep, 0);
    assert.equal(step0.metadata.chainTotal, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
