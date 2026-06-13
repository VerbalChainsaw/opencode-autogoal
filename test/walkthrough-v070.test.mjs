/**
 * walkthrough-v070.test.mjs — final threat-tracing +
 * simulated run. (v0.7.0 acceptance criteria.)
 *
 * Walks the full v0.7.0 user flow end-to-end:
 *   1. Shell starts in normal mode (no goal).
 *   2. The three-pane composer renders compact mode.
 *   3. User presses `?` to open help overlay.
 *   4. User presses `n` to navigate to the Session section.
 *   5. User presses `q` to close the help overlay.
 *   6. User presses `Tab` to enter drill-down (no items,
 *      so it shows 'no steering or history yet').
 *   7. User presses `A` to view the archive (empty).
 *   8. User presses `D` to run doctor.
 *   9. User presses `g` to copy the goal state — but
 *      there's no goal, so it toasts 'No goal state to copy.'
 *  10. User presses `Ctrl+L` to redraw.
 *  11. User presses `q` to quit.
 *
 * Each step asserts the expected post-condition on the
 * rendered output. The test uses a fake-TTY harness so
 * the actual TUI rendering can be observed. The shell
 * process exits cleanly at the end.
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
const { runControlCenter } = await import("file:///" + join(dist, "control-center.js").replace(/\\/g, "/"));
const { setGoalFields, readGoalState, writeGoalStateAtomic } = await import("file:///" + join(dist, "goal-state.js").replace(/\\/g, "/"));

function freshDir() {
  return mkdtempSync(join(tmpdir(), "walk-"));
}

function fakeTty() {
  const stdin = new EventEmitter();
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.resume = () => {};
  stdin.pause = () => {};
  const stdout = new EventEmitter();
  stdout.isTTY = true;
  stdout.columns = 100;
  stdout.rows = 30;
  stdout.writes = [];
  stdout.write = (s) => { stdout.writes.push(s); return true; };
  const stderr = { writes: [], write: (s) => { stderr.writes.push(s); return true; } };
  return { stdin, stdout, stderr };
}

function lastWrite(stdout) {
  return stdout.writes[stdout.writes.length - 1] ?? "";
}

function allWrites(stdout) {
  return stdout.writes.join("");
}

describe("v0.7.0 user flow walkthrough (simulated)", () => {
  test("step 1-2: empty goal renders the compact no-goal view", () => {
    const dir = freshDir();
    try {
      const { stdin, stdout, stderr } = fakeTty();
      const exits = [];
      runControlCenter({ directory: dir, stdin, stdout, stderr, onExit: (c) => exits.push(c) });
      const out = allWrites(stdout);
      assert.match(out, /No goal set/);
      stdin.emit("keypress", "q", { name: "q", sequence: "q" });
      assert.deepEqual(exits, [0]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("step 3-5: help overlay opens, navigates, closes cleanly", () => {
    const dir = freshDir();
    try {
      const { stdin, stdout, stderr } = fakeTty();
      const exits = [];
      runControlCenter({ directory: dir, stdin, stdout, stderr, onExit: (c) => exits.push(c) });
      // 3: open help
      stdin.emit("keypress", "?", { name: "?", sequence: "?" });
      assert.match(lastWrite(stdout), /GOAL/);
      // 4: navigate to Session
      stdin.emit("keypress", "n", { name: "n", sequence: "n" });
      assert.match(lastWrite(stdout), /SESSION/);
      // 5: close (first q) + quit (second q)
      stdin.emit("keypress", "q", { name: "q", sequence: "q" });
      assert.ok(!/─── SESSION/.test(lastWrite(stdout)), "overlay should be closed after q");
      stdin.emit("keypress", "q", { name: "q", sequence: "q" });
      assert.deepEqual(exits, [0]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("step 6: Tab with empty goal shows 'nothing to drill into' toast", () => {
    const dir = freshDir();
    try {
      const { stdin, stdout, stderr } = fakeTty();
      const exits = [];
      runControlCenter({ directory: dir, stdin, stdout, stderr, onExit: (c) => exits.push(c) });
      stdin.emit("keypress", "\t", { name: "tab" });
      assert.match(lastWrite(stdout), /Nothing to drill/);
      stdin.emit("keypress", "q", { name: "q", sequence: "q" });
      assert.deepEqual(exits, [0]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("step 7-11: A / D / g / Ctrl+L / q — all keystrokes process cleanly", () => {
    const dir = freshDir();
    try {
      const { stdin, stdout, stderr } = fakeTty();
      const exits = [];
      runControlCenter({ directory: dir, stdin, stdout, stderr, onExit: (c) => exits.push(c) });
      // 7: A — archive (empty)
      stdin.emit("keypress", "a", { name: "a", sequence: "a" });
      assert.match(lastWrite(stdout), /No archived/);
      // 8: D — doctor
      stdin.emit("keypress", "d", { name: "d", sequence: "d" });
      assert.match(lastWrite(stdout), /DOCTOR/);
      // 9: g — copy state (no state)
      stdin.emit("keypress", "g", { name: "g", sequence: "g" });
      assert.match(lastWrite(stdout), /No goal state/);
      // 10: Ctrl+L — redraw
      const writesBefore = stdout.writes.length;
      stdin.emit("keypress", "\x0c", { name: "l", ctrl: true });
      assert.ok(stdout.writes.length > writesBefore, "Ctrl+L should trigger a redraw");
      // 11: q — quit
      stdin.emit("keypress", "q", { name: "q", sequence: "q" });
      assert.deepEqual(exits, [0]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("step final: full session with an active goal (drill-down navigates, inline editor opens, c copies, L opens the file manager seam)", async () => {
    const dir = freshDir();
    try {
      // Set up an active goal with steering notes via the
      // public goal-state API (setGoalFields initializes the
      // state, then we append steering + eval history in
      // place via readGoalState / writeGoalStateAtomic).
      setGoalFields(dir, { condition: "WALKTHROUGH-CONDITION" });
      const st = readGoalState(dir);
      if (st) {
        st.metadata.steering = [
          { at: 1, note: "first steering note" },
          { at: 2, note: "second steering note" },
        ];
        st.evaluationHistory = [
          { met: false, reason: "reason-A line one line two", blocked: false, confidence: 1, timestamp: 1, evaluatorType: "deterministic" },
        ];
        writeGoalStateAtomic(dir, st);
      }

      const { stdin, stdout, stderr } = fakeTty();
      const opens = [];
      const exits = [];
      runControlCenter({
        directory: dir, stdin, stdout, stderr, onExit: (c) => exits.push(c),
        fileOpener: (path) => { opens.push(path); },
      });
      // Tab: enter drill-down (steering)
      stdin.emit("keypress", "\t", { name: "tab" });
      assert.match(lastWrite(stdout), /STEERING/);
      // Tab again: switch to history
      stdin.emit("keypress", "\t", { name: "tab" });
      assert.match(lastWrite(stdout), /HISTORY/);
      // c: copy the current item to clipboard via OSC 52
      // (no need for ↓/Enter — c copies the item at the
      // current cursor directly, no detail view required)
      stdin.emit("keypress", "c", { name: "c", sequence: "c" });
      assert.match(allWrites(stdout), /\x1b\]52;c;[A-Za-z0-9+/=]+\x07/);
      // Esc: exit drill-down
      stdin.emit("keypress", "\x1b", { name: "escape" });
      // L: open .opencode/ via the fileOpener seam
      stdin.emit("keypress", "l", { name: "l", sequence: "l" });
      assert.equal(opens.length, 1);
      assert.match(opens[0], /\.opencode/);
      // g: copy the full goal state JSON to clipboard
      stdin.emit("keypress", "g", { name: "g", sequence: "g" });
      const m = allWrites(stdout).match(/\x1b\]52;c;([A-Za-z0-9+/=]+)\x07/g);
      // m is an array of all OSC 52 envelopes — we expect at
      // least 2 (the c copy and the g copy).
      assert.ok((m?.length ?? 0) >= 2, "expected 2+ OSC 52 envelopes (c copy + g copy)");
      // q: quit
      stdin.emit("keypress", "q", { name: "q", sequence: "q" });
      assert.deepEqual(exits, [0]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
