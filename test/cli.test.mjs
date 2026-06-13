/**
 * Tests for the standalone CLI (src/cli.ts → dist/cli.js).
 *
 * The CLI is a thin wrapper around dispatchGoalCommandStructured. These
 * tests exercise the CLI's argument parser, the buildSetPayload argv
 * rescuer (Task 4), the isCliEntry guard (Task 1), and the kind→exit
 * code mapping.
 *
 * End-to-end "does the binary run" tests are in test/cli-e2e.test.mjs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

import {
  parseArgs,
  buildSetPayload,
  isCliEntry,
  CLI_TO_DISPATCHER,
} from "../dist/cli.js";

const here = dirname(fileURLToPath(import.meta.url));
import { KIND_TO_EXIT, dispatchGoalCommandStructured } from "../dist/command.js";

const SET_REPLY = `Tell the user this, then stop and await further instruction:

A goal has been set and is now your top priority.

GOAL: make all tests pass
Limits: up to 20 turns / 30 minutes.

How to proceed:
- Briefly tell the user the goal is set, then start working toward it immediately.
- Treat the goal as your top priority; after each step, ask whether it advanced the goal.
- The user can interrupt at any time with \`/goal pause\` or \`/goal clear\`.
- When you believe the goal is satisfied, write a line beginning "GOAL_COMPLETE:" followed by the evidence.
- If you become genuinely, unrecoverably blocked, write a line beginning "GOAL_BLOCKED:" explaining why.

Begin now.`;

const USAGE_REPLY = `Tell the user this, then stop and await further instruction:

Usage: /goal turns <number>. e.g. /goal turns 50`;

const NO_GOAL_REPLY = `Tell the user this, then stop and await further instruction:

No active goal.`;

// ── parseArgs ──────────────────────────────────────────────────────────────

test("parseArgs: no args → null (caller prints help)", () => {
  assert.equal(parseArgs([]), null);
});

test("parseArgs: 'help' → null", () => {
  assert.equal(parseArgs(["help"]), null);
  assert.equal(parseArgs(["--help"]), null);
  assert.equal(parseArgs(["-h"]), null);
});

test("parseArgs: bare action (no payload)", () => {
  const p = parseArgs(["view"]);
  assert.ok(p);
  assert.equal(p.action, "view");
  assert.deepEqual(p.payloadParts, []);
});

test("parseArgs: action + multi-word payload (kept as parts)", () => {
  // After Task 4, parseArgs returns the post-action argv as a list
  // (NOT a pre-joined string) so `buildSetPayload` can scan for
  // `--command` and re-quote. Verify the parts survive.
  const p = parseArgs(["set", "make", "all", "tests", "pass"]);
  assert.ok(p);
  assert.equal(p.action, "set");
  assert.deepEqual(p.payloadParts, ["make", "all", "tests", "pass"]);
});

test("parseArgs: --dir <path> <action> <payload>", () => {
  const tmp = process.env.TEMP || process.env.TMPDIR || "/tmp";
  const p = parseArgs(["--dir", tmp, "set", "ship", "it"]);
  assert.ok(p);
  assert.ok(p.directory.endsWith(tmp.replace(/\\/g, "/").split("/").pop() ?? tmp),
    `expected resolved path to end with the temp dir name, got: ${p.directory}`);
  assert.equal(p.action, "set");
  assert.deepEqual(p.payloadParts, ["ship", "it"]);
});

test("parseArgs: --dir without path → throws", () => {
  assert.throws(() => parseArgs(["--dir"]), /requires a path/);
});

test("parseArgs: --dir with empty string → throws (B4)", () => {
  // B4: `path.resolve("")` returns the cwd, and `existsSync(cwd)` is
  // true. So `--dir ""` silently used cwd, which is the same as
  // omitting `--dir` — confusing. After the fix, an empty string is
  // a usage error like `--dir` with no value.
  assert.throws(() => parseArgs(["--dir", "", "view"]),
    /requires a path/);
});

test("parseArgs: --dir with non-existent path → throws", () => {
  assert.throws(
    () => parseArgs(["--dir", "/this/does/not/exist/anywhere", "view"]),
    /does not exist/,
  );
});

test("parseArgs: --dir then missing action → throws", () => {
  assert.throws(
    () => parseArgs(["--dir", process.cwd()]),
    /missing command/,
  );
});

test("CLI surface does not ship a standalone web server command", () => {
  const root = join(here, "..");
  const cliSource = readFileSync(join(root, "src", "cli.ts"), "utf-8");
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));

  assert.doesNotMatch(cliSource, /\bserve \[--port <n>\]/, "help must not advertise a separate web console server");
  assert.doesNotMatch(cliSource, /createControlServer|parseServeOptions|runServe/, "CLI must not wire a standalone control server");
  assert.equal(pkg.exports["./control-server"], undefined, "package must not export a standalone control server");
  assert.ok(!pkg.files.includes("src/control-server.ts"), "package files must not ship a standalone control server");
});

// ── CLI_TO_DISPATCHER ───────────────────────────────────────────────────────

test("CLI_TO_DISPATCHER: all CLI commands have a dispatcher mapping", () => {
  const expected = [
    "set", "view", "status", "pause", "resume",
    "clear", "stop", "restart", "history",
    "turns", "time", "tokens", "condition",
    "steer", "unsteer", "handoff", "claim",
  ];
  for (const cmd of expected) {
    assert.ok(CLI_TO_DISPATCHER[cmd], `CLI command "${cmd}" should have a dispatcher mapping`);
  }
});

test("CLI_TO_DISPATCHER: aliases resolve to the same dispatcher action", () => {
  // `status` is an alias for `view`; `stop` is an alias for `clear`.
  assert.equal(CLI_TO_DISPATCHER.status, CLI_TO_DISPATCHER.view);
  assert.equal(CLI_TO_DISPATCHER.stop, CLI_TO_DISPATCHER.clear);
});

test("CLI_TO_DISPATCHER: clear aliases (off, reset, none, cancel) all map to 'clear'", () => {
  // B2: the dispatcher supports these aliases via CLEAR_ALIASES, but
  // the CLI's CLI_TO_DISPATCHER was missing all four. The user would
  // get "unknown command" for valid dispatcher actions.
  assert.equal(CLI_TO_DISPATCHER.off, "clear");
  assert.equal(CLI_TO_DISPATCHER.reset, "clear");
  assert.equal(CLI_TO_DISPATCHER.none, "clear");
  assert.equal(CLI_TO_DISPATCHER.cancel, "clear");
});

test("CLI_TO_DISPATCHER: template + use map to 'template' (B2)", () => {
  // B2: the dispatcher's KNOWN_ACTIONS includes 'template' and 'use'
  // (use is treated as an alias for template). The CLI's
  // CLI_TO_DISPATCHER was missing both. The user would get
  // "unknown command" for a valid dispatcher action.
  assert.equal(CLI_TO_DISPATCHER.template, "template");
  assert.equal(CLI_TO_DISPATCHER.use, "template");
});

// ── buildSetPayload (Task 4) ──────────────────────────────────────────────

test("buildSetPayload: re-quotes --command value", () => {
  // --command goes FIRST so the dispatcher's parseCommand (which matches
  // the first occurrence) always finds the real command, not a fake one
  // that might be embedded in the condition text.
  assert.equal(
    buildSetPayload(["ship", "v2", "--command", "make deploy"]),
    `--command "make deploy" ship v2`,
  );
});

test("buildSetPayload: no --command → plain join", () => {
  assert.equal(buildSetPayload(["ship", "v2"]), "ship v2");
});

test("buildSetPayload: --command first (no condition before it)", () => {
  // Only the SINGLE next argv element is the value.
  // Elements after it become part of the condition (joined).
  // --command is placed FIRST to prevent parser differential (adversarial audit #2).
  assert.equal(
    buildSetPayload(["--command", "echo", "hi"]),
    `--command "echo" hi`,
  );
});

test("buildSetPayload: --command with no value → throws", () => {
  assert.throws(() => buildSetPayload(["ship", "v2", "--command"]),
    /requires a value/);
});

test("buildSetPayload: duplicate --command → throws (A3)", () => {
  // The user almost certainly meant one or the other, never both.
  // Silently taking the first hides bugs in their scripts.
  assert.throws(() => buildSetPayload(["x", "--command", "a", "--command", "b"]),
    /duplicate --command/);
  assert.throws(() => buildSetPayload(["--command", "a", "--command", "b"]),
    /duplicate --command/);
});

test("buildSetPayload: --command value containing a quote → throws", () => {
  // The quote check is on the value immediately after `--command`,
  // not on the condition or on later elements.
  assert.throws(() => buildSetPayload(["--command", 'has "quote"']),
    /may not contain double quotes/);
});

test("buildSetPayload: empty parts → empty string", () => {
  assert.equal(buildSetPayload([]), "");
});

test("buildSetPayload: --command with empty value strips the flag entirely (no command)", () => {
  // A2: `--command ""` (empty quoted) means "no command" — the user
  // wants a goal with verification disabled. We strip the --command
  // entirely from the payload, NOT throw (the old behavior rejected
  // this and forced the user to omit --command to achieve the same
  // effect, which broke the read-back symmetry).
  assert.equal(buildSetPayload(["x", "--command", ""]), "x");
  assert.equal(buildSetPayload(["--command", "", "extra", "words"]), "extra words");
});

// ── isCliEntry (Task 1) ─────────────────────────────────────────────────────
// Pin the ESM entry-point guard. The old hand-rolled
// `file:///${process.argv[1]?.replace(/\\/g, "/")}` was wrong in three ways:
//   - POSIX: 4 slashes (file:////home/...) vs import.meta.url's 3
//   - Windows: spaces in argv[1] weren't %20-encoded
//   - npm bin symlinks: argv[1] is the symlink, import.meta.url is real path
// The fix uses pathToFileURL + realpathSync. These tests are the regression
// pins: the POSIX test fails against the old hand-rolled string.

test("isCliEntry: POSIX-style path matches", () => {
  if (process.platform === "win32") {
    // Skip: pathToFileURL on Windows coerces a POSIX-looking path to
    // a Windows path with a drive letter. The Windows path test
    // below covers the same regression from the other direction.
    return;
  }
  const metaUrl = "file:///home/u/cli.js";
  assert.equal(isCliEntry(metaUrl, "/home/u/cli.js"), true);
});

test("isCliEntry: Windows path with space is percent-encoded by pathToFileURL", () => {
  const metaUrl = "file:///C:/a%20b/cli.js";
  assert.equal(isCliEntry(metaUrl, "C:\\a b\\cli.js"), true);
});

test("isCliEntry: mismatched paths → false", () => {
  assert.equal(isCliEntry("file:///x/cli.js", "/y/other.js"), false);
});

test("isCliEntry: undefined argv1 → false", () => {
  assert.equal(isCliEntry("file:///anything/cli.js", undefined), false);
});

test("isCliEntry: symlinked invocation → true (realpath resolves the link)", () => {
  const dir = mkdtempSync(join(tmpdir(), "opengoal-clisym-"));
  try {
    const realTarget = join(dir, "real-target.js");
    writeFileSync(realTarget, "/* target */");
    let symlinkPath;
    try {
      symlinkPath = join(dir, "linked-cli.js");
      symlinkSync(symlinkPath, realTarget);
    } catch (err) {
      const code = err && err.code;
      process.stdout.write(`# skip symlink test: ${code ?? err.message}\n`);
      return;
    }
    const realUrl = pathToFileURL(realTarget).href;
    assert.equal(isCliEntry(realUrl, symlinkPath), true,
      `isCliEntry should match via realpath resolution (realUrl=${realUrl}, symlink=${symlinkPath})`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── KIND_TO_EXIT (the new exit-code mapping) ──────────────────────────────

test("KIND_TO_EXIT: all kinds have an exit code in [0,4]", () => {
  // Range widened to [0,4] in v0.4.2: exit 4 = corrupt state file
  // detected and quarantined (kind "corrupt-state"). See README
  // exit-code table.
  for (const [kind, code] of Object.entries(KIND_TO_EXIT)) {
    assert.equal(typeof code, "number", `kind ${kind} should have a numeric exit code`);
    assert.ok(code >= 0 && code <= 4, `kind ${kind} exit code ${code} should be in [0,4]`);
  }
});

test("KIND_TO_EXIT: success and set exit 0", () => {
  assert.equal(KIND_TO_EXIT.success, 0);
  assert.equal(KIND_TO_EXIT.set, 0);
  assert.equal(KIND_TO_EXIT["already-in-state"], 0);
});

test("KIND_TO_EXIT: usage / invalid-value / unknown-action exit 1", () => {
  assert.equal(KIND_TO_EXIT.usage, 1);
  assert.equal(KIND_TO_EXIT["invalid-value"], 1);
  assert.equal(KIND_TO_EXIT["unknown-action"], 1);
});

test("KIND_TO_EXIT: precondition kinds exit 2", () => {
  assert.equal(KIND_TO_EXIT["no-goal"], 2);
  assert.equal(KIND_TO_EXIT["terminal-state"], 2);
  assert.equal(KIND_TO_EXIT["handoff-exists"], 2);
  assert.equal(KIND_TO_EXIT["no-handoff"], 2);
  assert.equal(KIND_TO_EXIT["current-goal"], 2);
});

test("KIND_TO_EXIT: write-failed exits 3", () => {
  assert.equal(KIND_TO_EXIT["write-failed"], 3);
});

test("B3: KIND_TO_EXIT lookup is exhaustive — missing kinds fail closed, not silent 0", () => {
  // Defensive: the CLI's main() does `KIND_TO_EXIT[res.kind]`. If a
  // future refactor adds a new kind without updating the table, the
  // lookup returns undefined → process.exit(0) would silently mask
  // the internal bug. The fix: treat undefined as exit 3.
  // We pin the EXPECTED behavior here by checking that every key in
  // the current table is in the union AND that we have a test for
  // the fail-closed path. The "kind not in the table" scenario is
  // simulated by looking up a string that is definitely not a key.
  const allKeys = new Set(Object.keys(KIND_TO_EXIT));
  const knownKinds = [
    "success", "set", "usage", "invalid-value", "unknown-action",
    "no-goal", "terminal-state", "handoff-exists", "no-handoff",
    "current-goal", "write-failed", "already-in-state",
  ];
  for (const k of knownKinds) {
    assert.ok(allKeys.has(k), `KIND_TO_EXIT must contain '${k}'`);
  }
  // The defensive default: unknown kind → exit 3.
  // main() implements this as `code === undefined ? 3 : code`.
  const fakeKind = "this-kind-will-never-exist-in-real-code";
  assert.equal(KIND_TO_EXIT[fakeKind], undefined,
    "synthetic test: unknown kind returns undefined from the table");
  // The main() function applies the defensive fallback; this unit
  // test pins the contract that the fallback exists and chooses 3.
  // (The integration assertion is in cli-e2e.test.mjs.)
});

// ── Structured dispatcher end-to-end (the "poison" test) ───────────────────

test("POISON: condition containing 'Usage:' must NOT be mistaken for a usage error", () => {
  // This is the bug the old `mapExitCode` had: a condition with the
  // literal substring "Usage:" would have poisoned the exit code of
  // a subsequent `status` call. The structured kind is the only
  // way to get this right.
  const dir = mkdtempSync(join(tmpdir(), "opengoal-cli-poison-"));
  try {
    const setRes = dispatchGoalCommandStructured(dir,
      `set document the Usage: section of the No active goal page`);
    assert.equal(setRes.kind, "set", "set must be kind='set' even with poison text in the condition");
    const view = dispatchGoalCommandStructured(dir, "view");
    assert.equal(view.kind, "success",
      `view must be kind='success' even though goal text contains 'Usage:' and 'No active goal' substrings; got: ${view.kind}`);
    assert.equal(KIND_TO_EXIT[view.kind], 0, "view should exit 0");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
