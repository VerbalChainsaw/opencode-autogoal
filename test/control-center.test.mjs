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

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "dist");
const { applyAction, canRunInteractive, restoreTerminal } =
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
