/**
 * control-center.ts — the impure shell's TESTABLE seams: applyAction (routes a
 * TUI action to the existing goal-state primitives), canRunInteractive (the
 * non-TTY guard), and restoreTerminal (idempotent teardown). The render loop
 * itself needs a pty and is not unit-tested — the pure logic + these seams are
 * the contract.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "dist");
const { applyAction, canRunInteractive, restoreTerminal, runControlCenter, CONTROL_KEEP_RUNNING } =
  await import("file:///" + join(dist, "control-center.js").replace(/\\/g, "/"));
const { setGoalFields, readGoalState } =
  await import("file:///" + join(dist, "goal-state.js").replace(/\\/g, "/"));

function freshDir() {
  return mkdtempSync(join(tmpdir(), "opengoal-cc-"));
}

describe("applyAction routes to goal-state primitives", () => {
  test("pause transitions an active goal to paused", () => {
    const dir = freshDir();
    try {
      setGoalFields(dir, { condition: "do the thing" });
      const r = applyAction(dir, { kind: "pause" });
      assert.equal(r.ok, true);
      assert.equal(readGoalState(dir).status, "paused");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("steer prompt appends a steering note", () => {
    const dir = freshDir();
    try {
      setGoalFields(dir, { condition: "do the thing" });
      const r = applyAction(dir, { kind: "prompt", field: "steer" }, "focus the flaky suite");
      assert.equal(r.ok, true);
      assert.equal(readGoalState(dir).metadata.steering[0].note, "focus the flaky suite");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("set prompt creates a goal when none exists", () => {
    const dir = freshDir();
    try {
      const r = applyAction(dir, { kind: "prompt", field: "set" }, "ship the release");
      assert.equal(r.ok, true);
      assert.equal(readGoalState(dir).condition, "ship the release");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("turns prompt edits the constraint", () => {
    const dir = freshDir();
    try {
      setGoalFields(dir, { condition: "do the thing" });
      const r = applyAction(dir, { kind: "prompt", field: "turns" }, "50");
      assert.equal(r.ok, true);
      assert.equal(readGoalState(dir).constraints.maxTurns, 50);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("a non-numeric dial value is rejected, not crashed", () => {
    const dir = freshDir();
    try {
      setGoalFields(dir, { condition: "do the thing" });
      const r = applyAction(dir, { kind: "prompt", field: "turns" }, "not-a-number");
      assert.equal(r.ok, false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("a prompt action with no value is rejected", () => {
    const dir = freshDir();
    try {
      setGoalFields(dir, { condition: "do the thing" });
      const r = applyAction(dir, { kind: "prompt", field: "steer" });
      assert.equal(r.ok, false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("canRunInteractive", () => {
  test("requires both stdout and stdin to be TTYs", () => {
    assert.equal(canRunInteractive({ isTTY: true }, { isTTY: true }), true);
    assert.equal(canRunInteractive({ isTTY: false }, { isTTY: true }), false);
    assert.equal(canRunInteractive({ isTTY: true }, { isTTY: false }), false);
  });
});

describe("restoreTerminal", () => {
  test("shows the cursor, leaves the alt screen, disables raw mode — and is idempotent", () => {
    const writes = [];
    const stdout = { write: (s) => { writes.push(s); return true; } };
    let rawCalls = [];
    const stdin = { isTTY: true, setRawMode: (v) => { rawCalls.push(v); } };
    restoreTerminal(stdout, stdin);
    restoreTerminal(stdout, stdin); // second call must not throw
    const all = writes.join("");
    assert.match(all, /\x1b\[\?25h/);   // show cursor
    assert.match(all, /\x1b\[\?1049l/); // leave alt screen buffer
    assert.ok(rawCalls.every((v) => v === false), "setRawMode only ever disabled");
  });

  test("tolerates a stdin without setRawMode (non-TTY)", () => {
    const writes = [];
    const stdout = { write: (s) => { writes.push(s); return true; } };
    assert.doesNotThrow(() => restoreTerminal(stdout, {}));
  });
});

describe("runControlCenter terminal lifecycle", () => {
  function fakeTty() {
    const stdin = new EventEmitter();
    stdin.isTTY = true;
    stdin.setRawModeCalls = [];
    stdin.resumeCalls = 0;
    stdin.pauseCalls = 0;
    stdin.setRawMode = (v) => { stdin.setRawModeCalls.push(v); };
    stdin.resume = () => { stdin.resumeCalls += 1; };
    stdin.pause = () => { stdin.pauseCalls += 1; };
    const stdout = new EventEmitter();
    stdout.isTTY = true;
    stdout.columns = 80;
    stdout.rows = 24;
    stdout.writes = [];
    stdout.write = (s) => { stdout.writes.push(s); return true; };
    const stderr = { writes: [], write: (s) => { stderr.writes.push(s); return true; } };
    return { stdin, stdout, stderr };
  }

  test("enters raw mode, resumes stdin, and q exits through the injected hook", () => {
    const dir = freshDir();
    try {
      const { stdin, stdout, stderr } = fakeTty();
      const exits = [];
      const code = runControlCenter({ directory: dir, stdin, stdout, stderr, onExit: (c) => exits.push(c) });
      assert.equal(code, CONTROL_KEEP_RUNNING);
      assert.deepEqual(stdin.setRawModeCalls, [true]);
      assert.equal(stdin.resumeCalls, 1);

      stdin.emit("keypress", "q", { name: "q", sequence: "q" });

      assert.deepEqual(exits, [0]);
      assert.ok(stdin.setRawModeCalls.includes(false), "raw mode disabled on quit");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("escape exits from the no-goal panel and removes the keypress listener", () => {
    const dir = freshDir();
    try {
      const { stdin, stdout, stderr } = fakeTty();
      const exits = [];
      runControlCenter({ directory: dir, stdin, stdout, stderr, env: { NO_COLOR: "1" }, onExit: (c) => exits.push(c) });
      assert.match(stdout.writes.join(""), /No goal set/);
      assert.equal(stdin.listenerCount("keypress"), 1);

      stdin.emit("keypress", undefined, { name: "escape" });

      assert.deepEqual(exits, [0]);
      assert.equal(stdin.listenerCount("keypress"), 0);
      assert.ok(stdin.setRawModeCalls.includes(false), "raw mode disabled on Escape");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("ctrl-c exits even while the help overlay is visible", () => {
    const dir = freshDir();
    try {
      const { stdin, stdout, stderr } = fakeTty();
      const exits = [];
      runControlCenter({ directory: dir, stdin, stdout, stderr, onExit: (c) => exits.push(c) });

      stdin.emit("keypress", "?", { name: "?", sequence: "?" });
      stdin.emit("keypress", "\x03", { name: "c", sequence: "\x03", ctrl: true });

      assert.deepEqual(exits, [0]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("ctrl-c exits even while an inline prompt is open", () => {
    const dir = freshDir();
    try {
      const { stdin, stdout, stderr } = fakeTty();
      const exits = [];
      runControlCenter({ directory: dir, stdin, stdout, stderr, onExit: (c) => exits.push(c) });

      stdin.emit("keypress", "n", { name: "n", sequence: "n" });
      stdin.emit("keypress", "\x03", { name: "c", sequence: "\x03", ctrl: true });

      assert.deepEqual(exits, [0]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// ── B10: shell uses the three-pane composer (v0.7.0) ─────────────────────

import { readFileSync } from "node:fs";

describe("runControlCenter three-pane composer wiring (v0.7.0)", () => {
  function fakeTty() {
    const stdin = new EventEmitter();
    stdin.isTTY = true;
    stdin.setRawModeCalls = [];
    stdin.setRawMode = (v) => { stdin.setRawModeCalls.push(v); };
    stdin.resume = () => {};
    stdin.pause = () => {};
    const stdout = new EventEmitter();
    stdout.isTTY = true;
    stdout.columns = 80;
    stdout.rows = 24;
    stdout.writes = [];
    stdout.write = (s) => { stdout.writes.push(s); return true; };
    const stderr = { writes: [], write: (s) => { stderr.writes.push(s); return true; } };
    return { stdin, stdout, stderr };
  }

  test("shell renders through renderControlCenter (composer), not renderFrame", () => {
    // Source-level pin: a literal grep that catches accidental
    // reversion to the legacy path. The composer is the v0.7.0
    // three-pane shell; the legacy renderFrame is preserved for
    // the `watch` command and external callers.
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, "..", "src", "control-center.ts"), "utf-8");
    assert.match(src, /renderControlCenter\(/, "shell must call renderControlCenter");
  });

  test("no-goal view still shows 'No goal set' (composer compact mode)", () => {
    const dir = freshDir();
    try {
      const { stdin, stdout, stderr } = fakeTty();
      const exits = [];
      runControlCenter({ directory: dir, stdin, stdout, stderr, onExit: (c) => exits.push(c) });
      assert.match(stdout.writes.join(""), /No goal set/);
      stdin.emit("keypress", "q", { name: "q", sequence: "q" });
      assert.deepEqual(exits, [0]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("active goal view shows status + condition in the rendered output", () => {
    const dir = freshDir();
    try {
      // Seed an active goal so the composer renders the
      // active/paused/achieved/cleared branch.
      setGoalFields(dir, { condition: "make all tests pass" });
      const { stdin, stdout, stderr } = fakeTty();
      const exits = [];
      runControlCenter({ directory: dir, stdin, stdout, stderr, onExit: (c) => exits.push(c) });
      const out = stdout.writes.join("");
      assert.match(out, /make all tests pass/);
      assert.match(out, /\[q\]/i);
      stdin.emit("keypress", "q", { name: "q", sequence: "q" });
      assert.deepEqual(exits, [0]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
