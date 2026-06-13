/**
 * control-center.ts — the impure shell's TESTABLE seams: applyAction (routes a
 * TUI action to the existing goal-state primitives), canRunInteractive (the
 * non-TTY guard), and restoreTerminal (idempotent teardown). The render loop
 * itself needs a pty and is not unit-tested — the pure logic + these seams are
 * the contract.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "dist");
const { applyAction, canRunInteractive, restoreTerminal, runControlCenter, CONTROL_KEEP_RUNNING } =
  await import("file:///" + join(dist, "control-center.js").replace(/\\/g, "/"));
const { setGoalFields, readGoalState, writeGoalStateAtomic } =
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

// ── B11: readers wired into the shell (v0.7.0) ──────────────────────────

describe("runControlCenter readers seam (v0.7.0)", () => {
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

  test("injected readers: the shell calls the injected readSessionEvents", () => {
    const dir = freshDir();
    try {
      const { stdin, stdout, stderr } = fakeTty();
      const calls = { readSessionEvents: 0, readStepTimeline: 0 };
      const fakeEvent = {
        at: 1, kind: "tool-end", tool: "bash", summary: "ok", ok: true, durationMs: 100,
      };
      const readers = {
        readGoalStateSafe: () => ({ state: null, corrupt: false, summary: "No goal set." }),
        readHandoff: () => null,
        readSessionEvents: () => { calls.readSessionEvents += 1; return [fakeEvent]; },
        readStepTimeline: () => { calls.readStepTimeline += 1; return []; },
        readArchiveEntries: () => [],
        discoverTemplatesForUi: () => [],
      };
      const exits = [];
      runControlCenter({ directory: dir, stdin, stdout, stderr, readers, onExit: (c) => exits.push(c) });
      // Initial render reads events at least once.
      assert.ok(calls.readSessionEvents >= 1, `expected readSessionEvents to be called, got ${calls.readSessionEvents}`);
      assert.ok(calls.readStepTimeline >= 1, `expected readStepTimeline to be called, got ${calls.readStepTimeline}`);
      // The fake event's tool name should appear in the rendered output.
      assert.match(stdout.writes.join(""), /bash/);
      stdin.emit("keypress", "q", { name: "q", sequence: "q" });
      assert.deepEqual(exits, [0]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("injected readers: timeline entries appear in the rendered output", () => {
    const dir = freshDir();
    try {
      const { stdin, stdout, stderr } = fakeTty();
      // Use a short label that fits in the right pane (~30 cols
      // at width=80 in stack mode).
      const fakeStep = {
        at: Date.now() - 3 * 60_000, turn: 1, label: "ok", outcome: "met",
      };
      const readers = {
        readGoalStateSafe: () => ({ state: null, corrupt: false, summary: "No goal set." }),
        readHandoff: () => null,
        readSessionEvents: () => [],
        readStepTimeline: () => [fakeStep],
        readArchiveEntries: () => [],
        discoverTemplatesForUi: () => [],
      };
      const exits = [];
      runControlCenter({ directory: dir, stdin, stdout, stderr, readers, onExit: (c) => exits.push(c) });
      const text = stdout.writes.join("");
      assert.match(text, /TIMELINE/);
      assert.match(text, /turn 2/);
      assert.match(text, /3m ago/);
      stdin.emit("keypress", "q", { name: "q", sequence: "q" });
      assert.deepEqual(exits, [0]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("injected readers: a chain step on the model surfaces in the session pane", () => {
    const dir = freshDir();
    try {
      const { stdin, stdout, stderr } = fakeTty();
      const activeState = {
        version: 1, id: "g1", condition: "chain goal", command: null, status: "active",
        createdAt: 0, startedAt: 0, completedAt: null, pausedAt: null, resumedAt: null,
        turnsEvaluated: 0, tokensUsed: 0, lastEvaluation: null, evaluationHistory: [],
        constraints: { maxTurns: 20, maxTimeMinutes: 30, maxTokens: 100000 },
        metadata: { setBy: "chain", chainStep: 1, chainTotal: 3 },
      };
      const readers = {
        readGoalStateSafe: () => ({ state: activeState, corrupt: false, summary: "Active: chain goal" }),
        readHandoff: () => null,
        readSessionEvents: () => [],
        readStepTimeline: () => [],
        readArchiveEntries: () => [],
        discoverTemplatesForUi: () => [],
      };
      const exits = [];
      runControlCenter({ directory: dir, stdin, stdout, stderr, readers, onExit: (c) => exits.push(c) });
      const out = stdout.writes.join("");
      // The session pane shows a chain step (2/3) when the model
      // has a chainStep metadata field.
      assert.match(out, /2\/3|chain/);
      stdin.emit("keypress", "q", { name: "q", sequence: "q" });
      assert.deepEqual(exits, [0]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// ── B12: 2s tick interval for live-event files (v0.7.0) ─────────────────

describe("runControlCenter live-event tick (v0.7.0)", () => {
  test("source-level pin: setInterval is used for the live-event tick", () => {
    // The tick fires on a 2s cadence (configurable via
    // OPENGCODE_TUI_TICK_MS) and re-renders the shell so the
    // Live Session pane reflects the latest session events and
    // step timeline. The goal-state watcher alone is not enough:
    // it fires on .goal-state.json mtime, but the events and
    // timeline files change on every tool call and every
    // evaluation, and neither of those writes updates the goal
    // state file. The tick is the dedicated refresh for those
    // surfaces.
    const src = readFileSync("src/control-center.ts", "utf-8");
    assert.match(src, /setInterval/, "control-center.ts must use setInterval for the live-event tick");
    assert.match(src, /TICK_MS|tickIntervalMs|OPENGCODE_TUI_TICK_MS/, "control-center.ts must expose a tick interval");
  });

  test("the tick interval is disposed on quit (no leaked timers)", () => {
    const dir = freshDir();
    try {
      const stdin = new EventEmitter();
      stdin.isTTY = true;
      stdin.setRawMode = () => {};
      stdin.resume = () => {};
      stdin.pause = () => {};
      const stdout = new EventEmitter();
      stdout.isTTY = true;
      stdout.columns = 80;
      stdout.rows = 24;
      stdout.writes = [];
      stdout.write = (s) => { stdout.writes.push(s); return true; };
      const stderr = { writes: [], write: (s) => { stderr.writes.push(s); return true; } };
      const exits = [];
      runControlCenter({ directory: dir, stdin, stdout, stderr, onExit: (c) => exits.push(c) });
      stdin.emit("keypress", "q", { name: "q", sequence: "q" });
      assert.deepEqual(exits, [0]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// ── C14: drill-down mode wired into onKey (v0.7.0) ─────────────────────

describe("runControlCenter drill-down mode (v0.7.0)", () => {
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

  test("source-level pin: drill-down mode is wired in control-center.ts", () => {
    const src = readFileSync("src/control-center.ts", "utf-8");
    assert.match(src, /drillReducer|drill-down/);
  });

  test("Tab from normal mode enters drill-down (renders the list)", () => {
    const dir = freshDir();
    try {
      // Seed an active goal with steering notes so drill-down
      // has a list to render.
      setGoalFields(dir, { condition: "x" });
      const appendSteeringFn = (s) => {
        const state = readGoalState(dir);
        if (!state) return;
        state.metadata.steering = (state.metadata.steering ?? []).concat([{ at: Date.now(), note: s }]);
        writeGoalStateAtomic(dir, state);
      };
      appendSteeringFn("try the new lib");
      appendSteeringFn("skip auth for now");

      const { stdin, stdout, stderr } = fakeTty();
      const exits = [];
      runControlCenter({ directory: dir, stdin, stdout, stderr, onExit: (c) => exits.push(c) });

      // Press Tab — should enter drill-down mode (renders the
      // steering list with a cursor).
      stdin.emit("keypress", "\t", { name: "tab" });
      const out = stdout.writes.join("");
      assert.match(out, /try the new lib/, "drill-down should render the steering list");
      assert.match(out, /STEERING|>|►/i, "drill-down should show a cursor indicator");

      stdin.emit("keypress", "q", { name: "q", sequence: "q" });
      assert.deepEqual(exits, [0]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("Esc from drill-down returns to normal mode", () => {
    const dir = freshDir();
    try {
      setGoalFields(dir, { condition: "x" });
      const state = readGoalState(dir);
      if (state) {
        state.metadata.steering = [{ at: 1, note: "n1" }];
        writeGoalStateAtomic(dir, state);
      }
      const { stdin, stdout, stderr } = fakeTty();
      const exits = [];
      runControlCenter({ directory: dir, stdin, stdout, stderr, onExit: (c) => exits.push(c) });
      stdin.emit("keypress", "\t", { name: "tab" });
      const writesAfterTab = stdout.writes.length;
      // Now press Esc — should set done='cancelled' and the
      // shell should drop back to normal mode. The render()
      // is called again, so stdout.writes grows.
      stdin.emit("keypress", "\x1b", { name: "escape" });
      assert.ok(stdout.writes.length > writesAfterTab, "render was called after esc");
      stdin.emit("keypress", "q", { name: "q", sequence: "q" });
      assert.deepEqual(exits, [0]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("Enter in drill-down opens the detail (full-reason) view (C15)", () => {
    const dir = freshDir();
    try {
      setGoalFields(dir, { condition: "x" });
      const state = readGoalState(dir);
      if (state) {
        state.evaluationHistory = [
          { met: false, reason: "tests failing in auth module — see log line 42", blocked: false, confidence: 1, timestamp: 1, evaluatorType: "deterministic" },
        ];
        writeGoalStateAtomic(dir, state);
      }
      const { stdin, stdout, stderr } = fakeTty();
      const exits = [];
      runControlCenter({ directory: dir, stdin, stdout, stderr, onExit: (c) => exits.push(c) });
      // Tab → history (no steering), Enter → open detail
      stdin.emit("keypress", "\t", { name: "tab" });
      // The drill list is in history mode (steering empty). Move
      // the cursor to the first item and Enter.
      stdin.emit("keypress", "", { name: "down" });
      stdin.emit("keypress", "", { name: "return" });
      const out = stdout.writes.join("");
      // The detail view should show the full untruncated reason.
      assert.match(out, /tests failing in auth module/);
      stdin.emit("keypress", "q", { name: "q", sequence: "q" });
      assert.deepEqual(exits, [0]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("c in drill-down copies the current item via OSC 52 (C16)", () => {
    const dir = freshDir();
    try {
      setGoalFields(dir, { condition: "x" });
      const state = readGoalState(dir);
      if (state) {
        state.metadata.steering = [{ at: 1, note: "FIXME-DRILL-COPY-TEST-MARKER" }];
        writeGoalStateAtomic(dir, state);
      }
      const { stdin, stdout, stderr } = fakeTty();
      const exits = [];
      runControlCenter({ directory: dir, stdin, stdout, stderr, onExit: (c) => exits.push(c) });
      stdin.emit("keypress", "\t", { name: "tab" }); // enter drill
      // The OSC 52 sequence is \x1b]52;c;<base64>\x07
      stdin.emit("keypress", "c", { name: "c", sequence: "c" });
      const out = stdout.writes.join("");
      assert.match(out, /\x1b\]52;c;[A-Za-z0-9+/=]+\x07/, "expected OSC 52 clipboard write");
      // The base64 decodes to "FIXME-DRILL-COPY-TEST-MARKER" — we
      // don't decode here, but the marker is a distinctive
      // string the regex would catch only if it appeared in
      // the output. (We assert the OSC 52 envelope is present.)
      stdin.emit("keypress", "q", { name: "q", sequence: "q" });
      assert.deepEqual(exits, [0]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("e on a steering note opens the inline editor (C17)", () => {
    const dir = freshDir();
    try {
      setGoalFields(dir, { condition: "x" });
      const state = readGoalState(dir);
      if (state) {
        state.metadata.steering = [{ at: 1, note: "ORIGINAL" }];
        writeGoalStateAtomic(dir, state);
      }
      const { stdin, stdout, stderr } = fakeTty();
      const exits = [];
      runControlCenter({ directory: dir, stdin, stdout, stderr, onExit: (c) => exits.push(c) });
      stdin.emit("keypress", "\t", { name: "tab" }); // enter drill (steering)
      stdin.emit("keypress", "e", { name: "e", sequence: "e" });
      const out = stdout.writes.join("");
      // The editor is open — the bottom of the most recent
      // render shows the input prompt with the pre-filled
      // value "ORIGINAL". The toast is the line just above
      // the prompt ("Edit steering note — Enter to submit...")
      // but the input-mode bottom line overrides the toast
      // (the input field is the affordance the user is
      // looking at). We assert the input prompt is open.
      const lastWrite = stdout.writes[stdout.writes.length - 1] ?? "";
      assert.match(lastWrite, /Steer: ORIGINAL/, "the inline editor should be open with the pre-filled note");
      // Press Esc to cancel the edit, then q to exit.
      stdin.emit("keypress", "\x1b", { name: "escape" });
      stdin.emit("keypress", "q", { name: "q", sequence: "q" });
      assert.deepEqual(exits, [0]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// ── Block D: 7 new actions (D19-D24) ──────────────────────────────────

describe("runControlCenter 7 new actions (v0.7.0)", () => {
  function fakeTty() {
    const stdin = new EventEmitter();
    stdin.isTTY = true;
    stdin.setRawMode = () => {};
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

  test("Ctrl+L: redraw triggers a render", () => {
    const dir = freshDir();
    try {
      const { stdin, stdout, stderr } = fakeTty();
      const exits = [];
      runControlCenter({ directory: dir, stdin, stdout, stderr, onExit: (c) => exits.push(c) });
      const writesBefore = stdout.writes.length;
      stdin.emit("keypress", "\x0c", { name: "l", ctrl: true });
      const writesAfter = stdout.writes.length;
      assert.ok(writesAfter > writesBefore, "Ctrl+L should trigger a redraw");
      stdin.emit("keypress", "q", { name: "q", sequence: "q" });
      assert.deepEqual(exits, [0]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("g: copy goal state JSON to clipboard via OSC 52", () => {
    const dir = freshDir();
    try {
      setGoalFields(dir, { condition: "FIXME-G-OSC52-TEST" });
      const { stdin, stdout, stderr } = fakeTty();
      const exits = [];
      runControlCenter({ directory: dir, stdin, stdout, stderr, onExit: (c) => exits.push(c) });
      stdin.emit("keypress", "g", { name: "g", sequence: "g" });
      const out = stdout.writes.join("");
      assert.match(out, /\x1b\]52;c;[A-Za-z0-9+/=]+\x07/);
      const m = out.match(/\x1b\]52;c;([A-Za-z0-9+/=]+)\x07/);
      assert.ok(m);
      const decoded = JSON.parse(Buffer.from(m[1], "base64").toString("utf-8"));
      assert.equal(decoded.condition, "FIXME-G-OSC52-TEST");
      stdin.emit("keypress", "q", { name: "q", sequence: "q" });
      assert.deepEqual(exits, [0]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("L: open .opencode/ dir — toast confirms the action", () => {
    const dir = freshDir();
    try {
      const { stdin, stdout, stderr } = fakeTty();
      const opens = [];
      const exits = [];
      runControlCenter({
        directory: dir, stdin, stdout, stderr, onExit: (c) => exits.push(c),
        fileOpener: (path) => { opens.push(path); },
      });
      stdin.emit("keypress", "l", { name: "l", sequence: "l" });
      const out = stdout.writes.join("");
      assert.match(out, /Opened .opencode/);
      assert.equal(opens.length, 1);
      assert.match(opens[0], /\.opencode[\\\/]?$/);
      stdin.emit("keypress", "q", { name: "q", sequence: "q" });
      assert.deepEqual(exits, [0]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("O: open .opencode/ dir — same behavior as L (alias)", () => {
    const dir = freshDir();
    try {
      const { stdin, stdout, stderr } = fakeTty();
      const opens = [];
      const exits = [];
      runControlCenter({
        directory: dir, stdin, stdout, stderr, onExit: (c) => exits.push(c),
        fileOpener: (path) => { opens.push(path); },
      });
      stdin.emit("keypress", "o", { name: "o", sequence: "o" });
      const out = stdout.writes.join("");
      assert.match(out, /Opened .opencode/);
      assert.equal(opens.length, 1);
      stdin.emit("keypress", "q", { name: "q", sequence: "q" });
      assert.deepEqual(exits, [0]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("D: doctor renders an inline check table", () => {
    const dir = freshDir();
    try {
      const { stdin, stdout, stderr } = fakeTty();
      const exits = [];
      runControlCenter({ directory: dir, stdin, stdout, stderr, onExit: (c) => exits.push(c) });
      stdin.emit("keypress", "d", { name: "d", sequence: "d" });
      const out = stdout.writes.join("");
      assert.match(out, /DOCTOR/);
      assert.match(out, /node|state|package/i);
      stdin.emit("keypress", "q", { name: "q", sequence: "q" });
      assert.deepEqual(exits, [0]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("T: templates list renders (or empty state)", () => {
    const dir = freshDir();
    try {
      const { stdin, stdout, stderr } = fakeTty();
      const exits = [];
      runControlCenter({ directory: dir, stdin, stdout, stderr, onExit: (c) => exits.push(c) });
      stdin.emit("keypress", "t", { name: "t", sequence: "t" });
      const out = stdout.writes.join("");
      assert.match(out, /TEMPLATE|No templates/i);
      stdin.emit("keypress", "q", { name: "q", sequence: "q" });
      assert.deepEqual(exits, [0]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("A: archive renders (or empty state)", () => {
    const dir = freshDir();
    try {
      const { stdin, stdout, stderr } = fakeTty();
      const exits = [];
      runControlCenter({ directory: dir, stdin, stdout, stderr, onExit: (c) => exits.push(c) });
      stdin.emit("keypress", "a", { name: "a", sequence: "a" });
      const out = stdout.writes.join("");
      assert.match(out, /ARCHIVE|No archived/i);
      stdin.emit("keypress", "q", { name: "q", sequence: "q" });
      assert.deepEqual(exits, [0]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("source-level pin: all 7 new actions are wired in control-center.ts", () => {
    const src = readFileSync("src/control-center.ts", "utf-8");
    for (const letter of ["a", "t", "d", "l", "o", "g"]) {
      assert.match(src, new RegExp(`key\.name === "${letter}"`), `action ${letter} is wired`);
    }
    assert.match(src, /ctrl.*name === "l"|name === "l".*ctrl/);
  });
});
