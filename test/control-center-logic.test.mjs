/**
 * control-center-logic.ts — the PURE heart of the interactive TUI control
 * center. Runs against the BUILT output (dist/). The impure shell
 * (control-center.ts: alt-screen, raw mode, watcher) is not unit-tested —
 * these pure functions are the contract, same as renderWatchFrame for `watch`.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "dist");
const { buildControlModel, renderFrame, buildGoalPane, keyToAction, reduceInput } =
  await import("file:///" + join(dist, "control-center-logic.js").replace(/\\/g, "/"));
const { createStyler, visibleWidth } = await import("file:///" + join(dist, "format.js").replace(/\\/g, "/"));

const plain = createStyler(false);

function makeState(over = {}) {
  return {
    version: 1,
    id: "abcd1234-0000-0000-0000-000000000000",
    condition: "make all tests pass",
    command: "npm test",
    status: "active",
    createdAt: 0,
    startedAt: 0,
    completedAt: null,
    pausedAt: null,
    resumedAt: null,
    turnsEvaluated: 4,
    tokensUsed: 1234,
    lastEvaluation: { met: false, reason: "2 tests failing", confidence: 1, timestamp: 0, evaluatorType: "deterministic" },
    evaluationHistory: [
      { met: false, reason: "5 failing", confidence: 1, timestamp: 0, evaluatorType: "deterministic" },
      { met: false, reason: "2 failing", confidence: 1, timestamp: 0, evaluatorType: "deterministic" },
    ],
    constraints: { maxTurns: 20, maxTimeMinutes: 30, maxTokens: 100000 },
    metadata: { setBy: "user" },
    ...over,
  };
}
const okResult = (state) => ({ state, corrupt: false, summary: "" });

// ── buildControlModel ───────────────────────────────────────────────────────
describe("buildControlModel", () => {
  test("active goal → kind active, condition + progress carried", () => {
    const m = buildControlModel(okResult(makeState()), { now: 600000 }); // 10m elapsed
    assert.equal(m.kind, "active");
    assert.equal(m.condition, "make all tests pass");
    assert.equal(m.turnsLabel, "4/20 turns");
    assert.equal(m.lastReason, "2 tests failing");
    assert.ok(m.progressPct >= 0 && m.progressPct <= 100);
  });
  test("paused goal → kind paused", () => {
    const m = buildControlModel(okResult(makeState({ status: "paused" })), {});
    assert.equal(m.kind, "paused");
  });
  test("corrupt result → kind corrupt, names the artifact", () => {
    const m = buildControlModel({ state: null, corrupt: true, summary: "bad" }, { corruptArtifact: ".goal-state.json.corrupt.9" });
    assert.equal(m.kind, "corrupt");
    assert.equal(m.corruptArtifact, ".goal-state.json.corrupt.9");
  });
  test("absent result → kind absent", () => {
    const m = buildControlModel({ state: null, corrupt: false, summary: "No goal set." }, {});
    assert.equal(m.kind, "absent");
  });
  test("steering notes and eval strip are carried", () => {
    const m = buildControlModel(okResult(makeState({ metadata: { setBy: "user", steering: [{ at: 1, note: "focus flaky" }] } })), {});
    assert.deepEqual(m.steering, ["focus flaky"]);
    assert.equal(m.evalStrip.length, 2);
    assert.equal(m.evalStrip[0].met, false);
  });
  test("chain step is carried when present", () => {
    const m = buildControlModel(okResult(makeState({ metadata: { setBy: "chain", chainStep: 1, chainTotal: 3 } })), {});
    assert.deepEqual(m.chain, { current: 1, total: 3 });
  });
  test("condition is sanitized (control chars stripped)", () => {
    const m = buildControlModel(okResult(makeState({ condition: "do the​ thing" })), {});
    assert.equal(m.condition, "do the thing");
  });
});

// ── renderFrame ─────────────────────────────────────────────────────────────
describe("renderFrame", () => {
  test("active frame shows status, condition, progress and a key footer", () => {
    const m = buildControlModel(okResult(makeState()), { now: 600000 });
    const lines = renderFrame(m, 60, 24, plain);
    const text = lines.join("\n");
    assert.match(text, /Active/);
    assert.match(text, /make all tests pass/);
    assert.match(text, /%/);            // progress percent
    assert.match(text, /\[q\]/i);       // quit key in footer
    assert.match(text, /\[p\]/i);       // pause key in footer
  });
  test("no line exceeds the given width", () => {
    const m = buildControlModel(okResult(makeState({ condition: "x".repeat(200) })), {});
    const lines = renderFrame(m, 40, 24, plain);
    for (const l of lines) assert.ok(visibleWidth(l) <= 40, `line too wide: ${JSON.stringify(l)}`);
  });
  test("frame fits within the given height", () => {
    const m = buildControlModel(okResult(makeState()), {});
    const lines = renderFrame(m, 60, 10, plain);
    assert.ok(lines.length <= 10, `expected <=10 lines, got ${lines.length}`);
  });
  test("scroll offset exposes clipped body lines while preserving the footer", () => {
    const steering = Array.from({ length: 8 }, (_, i) => ({ at: i, note: `note-${i}` }));
    const m = buildControlModel(okResult(makeState({ metadata: { setBy: "user", steering } })), {});
    const top = renderFrame(m, 60, 8, plain, 0).join("\n");
    const scrolled = renderFrame(m, 60, 8, plain, 99).join("\n");
    assert.doesNotMatch(top, /note-7/);
    assert.match(scrolled, /note-7/);
    assert.match(scrolled, /\[q\]/i);
  });
  test("plain styler emits NO ansi escapes", () => {
    const m = buildControlModel(okResult(makeState()), {});
    const lines = renderFrame(m, 60, 24, plain);
    for (const l of lines) assert.ok(!l.includes("\x1b"), `unexpected escape in: ${JSON.stringify(l)}`);
  });
  test("absent state renders a 'no goal' panel with a set hint", () => {
    const m = buildControlModel({ state: null, corrupt: false, summary: "No goal set." }, {});
    const text = renderFrame(m, 60, 24, plain).join("\n");
    assert.match(text, /[Nn]o goal/);
    assert.match(text, /\[n\]/i);   // 'new goal' key offered
  });
  test("corrupt state renders a warning naming the artifact", () => {
    const m = buildControlModel({ state: null, corrupt: true, summary: "x" }, { corruptArtifact: ".goal-state.json.corrupt.9" });
    const text = renderFrame(m, 70, 24, plain).join("\n");
    assert.match(text, /corrupt/i);
    assert.match(text, /\.goal-state\.json\.corrupt\.9/);
  });
});

// ── keyToAction ─────────────────────────────────────────────────────────────
describe("keyToAction (normal mode)", () => {
  const k = (name, extra = {}) => ({ name, ...extra });
  test("p pauses an active goal, resumes a paused one", () => {
    assert.deepEqual(keyToAction(k("p"), "normal", "active"), { kind: "pause" });
    assert.deepEqual(keyToAction(k("p"), "normal", "paused"), { kind: "resume" });
  });
  test("p is a no-op on a terminal/absent goal", () => {
    assert.equal(keyToAction(k("p"), "normal", "achieved"), null);
    assert.equal(keyToAction(k("p"), "normal", "absent"), null);
  });
  test("s/e/t/m/k open prompts on a mutable goal", () => {
    assert.deepEqual(keyToAction(k("s"), "normal", "active"), { kind: "prompt", field: "steer" });
    assert.deepEqual(keyToAction(k("e"), "normal", "paused"), { kind: "prompt", field: "condition" });
    assert.deepEqual(keyToAction(k("t"), "normal", "active"), { kind: "prompt", field: "turns" });
    assert.deepEqual(keyToAction(k("m"), "normal", "active"), { kind: "prompt", field: "time" });
    assert.deepEqual(keyToAction(k("k"), "normal", "active"), { kind: "prompt", field: "tokens" });
  });
  test("n opens the set-goal prompt even with no goal", () => {
    assert.deepEqual(keyToAction(k("n"), "normal", "absent"), { kind: "prompt", field: "set" });
  });
  test("destructive keys return their intent (shell adds confirm)", () => {
    assert.deepEqual(keyToAction(k("c"), "normal", "active"), { kind: "clear" });
    assert.deepEqual(keyToAction({ name: "R", shift: true }, "normal", "active"), { kind: "restart" });
  });
  test("scroll + help + quit", () => {
    assert.deepEqual(keyToAction(k("up"), "normal", "active"), { kind: "scrollUp" });
    assert.deepEqual(keyToAction(k("down"), "normal", "active"), { kind: "scrollDown" });
    assert.deepEqual(keyToAction(k("?"), "normal", "active"), { kind: "help" });
    assert.deepEqual(keyToAction(k("q"), "normal", "active"), { kind: "quit" });
    assert.deepEqual(keyToAction(k("escape"), "normal", "active"), { kind: "quit" });
    assert.deepEqual(keyToAction(k("c", { ctrl: true }), "normal", "active"), { kind: "quit" });
  });
  test("unknown key → null", () => {
    assert.equal(keyToAction(k("z"), "normal", "active"), null);
  });
  test("confirm mode maps y/n", () => {
    assert.deepEqual(keyToAction(k("y"), "confirm", "active"), { kind: "confirmYes" });
    assert.deepEqual(keyToAction(k("n"), "confirm", "active"), { kind: "confirmNo" });
    assert.deepEqual(keyToAction(k("escape"), "confirm", "active"), { kind: "confirmNo" });
  });
});

// ── reduceInput (the inline line editor) ────────────────────────────────────
describe("reduceInput", () => {
  const start = { value: "", cursor: 0, done: null };
  test("appends printable characters", () => {
    let s = start;
    for (const ch of "hi") s = reduceInput(s, { name: ch, sequence: ch });
    assert.equal(s.value, "hi");
    assert.equal(s.cursor, 2);
    assert.equal(s.done, null);
  });
  test("backspace deletes before the cursor", () => {
    let s = { value: "hello", cursor: 5, done: null };
    s = reduceInput(s, { name: "backspace" });
    assert.equal(s.value, "hell");
    assert.equal(s.cursor, 4);
  });
  test("left/right move the cursor within bounds", () => {
    let s = { value: "ab", cursor: 2, done: null };
    s = reduceInput(s, { name: "left" });
    assert.equal(s.cursor, 1);
    s = reduceInput(s, { name: "left" });
    s = reduceInput(s, { name: "left" });
    assert.equal(s.cursor, 0); // clamped
    s = reduceInput(s, { name: "right" });
    assert.equal(s.cursor, 1);
  });
  test("insert respects cursor position", () => {
    let s = { value: "ac", cursor: 1, done: null };
    s = reduceInput(s, { name: "b", sequence: "b" });
    assert.equal(s.value, "abc");
    assert.equal(s.cursor, 2);
  });
  test("enter submits, escape cancels", () => {
    assert.equal(reduceInput({ value: "x", cursor: 1, done: null }, { name: "return" }).done, "submit");
    assert.equal(reduceInput({ value: "x", cursor: 1, done: null }, { name: "escape" }).done, "cancel");
  });
  test("ignores control keys it doesn't handle", () => {
    const s = reduceInput(start, { name: "f5" });
    assert.deepEqual(s, start);
  });
});

// ── B8: buildGoalPane extracted from renderFrame ───────────────────────

describe("buildGoalPane", () => {
  test("buildGoalPane is exported", () => {
    assert.equal(typeof buildGoalPane, "function");
  });

  test("buildGoalPane: active model produces the same first lines as renderFrame", () => {
    const m = buildControlModel(okResult(makeState()), { now: 600000 });
    const pane = buildGoalPane(m, 60, 24, plain, 0);
    const frame = renderFrame(m, 60, 24, plain, 0);
    // The pane is the *body* of the frame (without the keybar footer
    // and scroll-fit). For the active/paused/achieved/cleared kinds,
    // renderFrame is the pane plus the fit() scroll. For a model
    // that doesn't trigger the scroll-anchor path (steering > 0
    // triggers the anchor), the pane is identical to the frame.
    // The contract: buildGoalPane returns an array of lines, the
    // first few of which match renderFrame's first few lines (the
    // status header, progress bar, counters).
    assert.ok(pane.length > 0, "pane should have at least one line");
    assert.equal(pane[0], frame[0], "first line should match the frame's first line");
  });

  test("buildGoalPane: paused/active/achieved/cleared all produce non-empty output", () => {
    for (const status of ["active", "paused", "achieved", "cleared"]) {
      const m = buildControlModel(okResult(makeState({ status })), { now: 600000 });
      const pane = buildGoalPane(m, 60, 24, plain, 0);
      assert.ok(pane.length > 0, `${status} pane should be non-empty`);
    }
  });

  test("buildGoalPane: scroll offset does not affect the line content, only the slice", () => {
    // buildGoalPane returns the full pane; the renderer's `fit`
    // applies the scroll. The pane itself is scroll-independent.
    // (This is a structural property: a future block B10 wiring
    // can apply fit/scroll at the layout level instead.)
    const m = buildControlModel(okResult(makeState({ metadata: { setBy: "user", steering: [
      { at: 1, note: "a" }, { at: 2, note: "b" }, { at: 3, note: "c" },
    ] } })), {});
    const a = buildGoalPane(m, 60, 24, plain, 0);
    const b = buildGoalPane(m, 60, 24, plain, 5);
    // Same content (the scroll is applied by fit(), not by the pane).
    assert.deepEqual(a, b);
  });

  test("buildGoalPane: respects width (no line exceeds the given width)", () => {
    const m = buildControlModel(okResult(makeState({ condition: "x".repeat(200) })), {});
    const pane = buildGoalPane(m, 40, 24, plain, 0);
    for (const l of pane) {
      assert.ok(visibleWidth(l) <= 40, `pane line too wide: ${JSON.stringify(l)}`);
    }
  });

  test("buildGoalPane: no line exceeds the given height (the pane is bounded)", () => {
    const m = buildControlModel(okResult(makeState()), {});
    const pane = buildGoalPane(m, 60, 10, plain, 0);
    assert.ok(pane.length <= 10, `pane should fit in 10 rows, got ${pane.length}`);
  });

  test("buildGoalPane: footer (keybar hint) is included in the pane", () => {
    // The pane carries the keybar text so the layout module can
    // pass it to renderLayout as the 'keybar' pane content. The
    // keybar is the LAST line of the active/paused/achieved/cleared
    // pane (renderFrame's scroll-fit preserves it).
    const m = buildControlModel(okResult(makeState()), {});
    const pane = buildGoalPane(m, 60, 24, plain, 0);
    const last = pane[pane.length - 1];
    assert.match(last, /\[q\]/i, `expected footer with [q], got: ${last}`);
    assert.match(last, /\[p\]/i, `expected footer with [p], got: ${last}`);
  });
});

