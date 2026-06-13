/**
 * render-control-center.test.mjs — B10 of the v0.7.0 plan.
 *
 * `renderControlCenter` is the shell-facing pure function that
 * composes the three-pane layout for the live TUI. It takes the
 * model + a few display-only options (events, timeline, chainStep)
 * and returns the lines to write to stdout. The shell owns the
 * raw-mode / alt-screen / keypress loop and delegates the layout
 * to this function.
 *
 * The contract: with empty events + empty timeline + null chainStep,
 * the layout falls back to "compact" mode (no session pane), so
 * the v0.7.0 wiring does NOT regress the v0.6.0 single-pane
 * experience. The three-pane shell appears automatically once
 * B11 starts populating events.
 *
 * With at least one event or timeline entry or a chainStep, the
 * layout uses "stack" mode (side-by-side goal + session panes).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { renderControlCenter } from "../dist/control-center-pane.js";
import { createStyler, visibleWidth } from "../dist/format.js";

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
    evaluationHistory: [],
    constraints: { maxTurns: 20, maxTimeMinutes: 30, maxTokens: 100000 },
    metadata: { setBy: "user" },
    ...over,
  };
}

// ── empty / compact mode (default) ───────────────────────────────────

describe("renderControlCenter: empty events → compact mode (no session pane)", () => {
  test("returns the full frame as an array of lines", () => {
    const out = renderControlCenter({
      model: { kind: "active", icon: "🎯", statusLabel: "Active", condition: "x", progressPct: 50,
               turnsLabel: "4/20 turns", timeLabel: "0m elapsed", tokensLabel: "1,234",
               lastReason: null, evalStrip: [], steering: [], chain: null,
               corruptArtifact: null, summary: "", command: null },
      events: [],
      timeline: [],
      chainStep: null,
      width: 80,
      height: 24,
      st: plain,
      focus: 0,
      now: 0,
    });
    assert.ok(Array.isArray(out.lines));
    assert.ok(out.lines.length > 0);
    // In compact mode, the session pane is omitted. The output
    // includes the goal state + keybar.
    assert.match(out.lines.join("\n"), /Active/);
    assert.match(out.lines.join("\n"), /\[q\]/i);
  });

  test("mode is 'compact' when no session data is present", () => {
    const out = renderControlCenter({
      model: { kind: "active", icon: "🎯", statusLabel: "Active", condition: "x", progressPct: 0,
               turnsLabel: "", timeLabel: "", tokensLabel: "",
               lastReason: null, evalStrip: [], steering: [], chain: null,
               corruptArtifact: null, summary: "", command: null },
      events: [], timeline: [], chainStep: null,
      width: 80, height: 24, st: plain, focus: 0, now: 0,
    });
    assert.equal(out.mode, "compact");
  });
});

// ── live data → stack mode (the three-pane shell) ─────────────────────

describe("renderControlCenter: with session events → stack mode (three panes)", () => {
  const baseModel = {
    kind: "active", icon: "🎯", statusLabel: "Active", condition: "make all tests pass",
    progressPct: 50, turnsLabel: "4/20 turns", timeLabel: "0m elapsed", tokensLabel: "1,234",
    lastReason: null, evalStrip: [], steering: [], chain: null,
    corruptArtifact: null, summary: "", command: null,
  };

  test("with one event, mode is 'stack' and the output includes both panes", () => {
    // Use a short event summary that fits in the right pane
    // (~30 cols at width=80 in stack mode).
    const out = renderControlCenter({
      model: baseModel,
      events: [{ at: 1, kind: "tool-end", tool: "bash", summary: "ok", ok: true, durationMs: 2100 }],
      timeline: [],
      chainStep: null,
      width: 80, height: 24, st: plain, focus: 0, now: 1,
    });
    assert.equal(out.mode, "stack");
    const text = out.lines.join("\n");
    // The goal pane (left) shows the status header
    assert.match(text, /make all tests pass/);
    // The session pane (right) shows the activity — tool name
    // and the activity section header.
    assert.match(text, /bash/);
    assert.match(text, /ACTIVITY/);
    // Vertical separator present in stack mode
    assert.ok(out.lines.some((l) => l.includes("│") || l.includes("|")), "expected vertical separator");
  });

  test("with chainStep, mode is 'stack' even when events + timeline are empty", () => {
    const out = renderControlCenter({
      model: baseModel,
      events: [], timeline: [], chainStep: { current: 0, total: 3 },
      width: 80, height: 24, st: plain, focus: 0, now: 0,
    });
    assert.equal(out.mode, "stack");
    const text = out.lines.join("\n");
    assert.match(text, /Chain step 1\/3|chain|1\/3/);
  });

  test("with timeline, mode is 'stack' and the timeline label appears", () => {
    const out = renderControlCenter({
      model: baseModel,
      events: [], timeline: [{ at: 1, turn: 0, label: "first turn", outcome: "in-progress" }],
      chainStep: null,
      width: 80, height: 24, st: plain, focus: 0, now: 1,
    });
    assert.equal(out.mode, "stack");
    assert.match(out.lines.join("\n"), /TIMELINE/);
  });
});

// ── output shape contract ─────────────────────────────────────────────

describe("renderControlCenter: output shape", () => {
  const baseModel = {
    kind: "active", icon: "🎯", statusLabel: "Active", condition: "x",
    progressPct: 0, turnsLabel: "", timeLabel: "", tokensLabel: "",
    lastReason: null, evalStrip: [], steering: [], chain: null,
    corruptArtifact: null, summary: "", command: null,
  };

  test("returns { lines, mode, width, height, focusIndex, hitTest }", () => {
    const out = renderControlCenter({
      model: baseModel, events: [], timeline: [], chainStep: null,
      width: 80, height: 24, st: plain, focus: 0, now: 0,
    });
    assert.ok(Array.isArray(out.lines));
    assert.ok(["stack", "stacked", "compact"].includes(out.mode));
    assert.equal(out.width, 80);
    assert.equal(out.height, 24);
    assert.equal(out.focusIndex, 0);
    assert.ok(Array.isArray(out.hitTest));
    assert.equal(out.hitTest.length, out.lines.length);
  });

  test("no line exceeds the given width", () => {
    const out = renderControlCenter({
      model: baseModel,
      events: [{ at: 1, kind: "tool-end", tool: "bash", summary: "a".repeat(200), ok: true }],
      timeline: [],
      chainStep: null,
      width: 50, height: 24, st: plain, focus: 0, now: 1,
    });
    for (const l of out.lines) {
      assert.ok(visibleWidth(l) <= 50, `line too wide: ${JSON.stringify(l)}`);
    }
  });

  test("hit-test for stack mode: row 0 = header, body = split, last = keybar", () => {
    const out = renderControlCenter({
      model: baseModel,
      events: [{ at: 1, kind: "tool-end", tool: "bash", summary: "X", ok: true }],
      timeline: [],
      chainStep: null,
      width: 80, height: 24, st: plain, focus: 0, now: 1,
    });
    assert.equal(out.mode, "stack");
    assert.equal(out.hitTest[0], "header");
    for (let i = 1; i < out.hitTest.length - 1; i++) {
      assert.equal(out.hitTest[i], "split", `row ${i}: ${out.hitTest[i]}`);
    }
    assert.equal(out.hitTest[out.hitTest.length - 1], "keybar");
  });
});
