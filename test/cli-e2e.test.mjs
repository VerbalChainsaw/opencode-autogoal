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
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
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

test("e2e coverage: 'set \"\"' (empty condition) exits 2", () => {
  const r = runCli(freshDir(), ["set", ""]);
  assert.equal(r.status, 2, `expected exit 2; got: ${r.status}\nstdout: ${r.stdout}`);
  assert.match(r.stdout, /cannot be empty/i);
});

test("e2e coverage: 'set ' ' (whitespace condition) exits 2", () => {
  const r = runCli(freshDir(), ["set", " "]);
  assert.equal(r.status, 2, `expected exit 2; got: ${r.status}\nstdout: ${r.stdout}`);
  assert.match(r.stdout, /cannot be empty/i);
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
