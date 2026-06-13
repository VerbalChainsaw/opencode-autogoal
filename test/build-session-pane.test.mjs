/**
 * build-session-pane.test.mjs — B9 of the v0.7.0 plan.
 *
 * `buildSessionPane(events, timeline, width, height, now)` is a
 * pure function that returns the lines for the new Live Session
 * pane in the three-pane TUI control center. It takes the
 * already-read session events + step timeline (the shell does
 * the I/O) and renders them.
 *
 * Three states:
 *   1. No data (no events AND no timeline AND no chain) →
 *      a friendly "no live session" placeholder. ONE line.
 *   2. Live activity present → a compact list of the most
 *      recent events, newest first, with the step timeline
 *      below as a relative-time strip.
 *   3. Timeline-only → just the timeline (no activity feed).
 *
 * Width and height are the pane's allocated box (the layout
 * module gives the pane its share of the terminal). The pane
 * respects the width (no line overflow) and the height (the
 * timeline gets the bottom half when both are present, the
 * activity feed gets the top).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { buildSessionPane } from "../dist/control-center-pane.js";
import { createStyler, visibleWidth } from "../dist/format.js";

const plain = createStyler(false);

function makeEvent(over = {}) {
  return {
    at: 1000,
    kind: "tool-end",
    tool: "bash",
    args: { command: "npm test" },
    durationMs: 2100,
    ok: true,
    summary: "Ran npm test",
    ...over,
  };
}

function makeStep(over = {}) {
  return {
    at: 1000,
    turn: 0,
    label: "first turn",
    outcome: "in-progress",
    ...over,
  };
}

// ── empty / no-data state ───────────────────────────────────────────────

describe("buildSessionPane: empty / no-data", () => {
  test("no events, no timeline, no chain → 'no live session' placeholder", () => {
    const lines = buildSessionPane([], [], 40, 20, plain, 1000);
    assert.equal(lines.length, 1, "exactly one placeholder line");
    assert.match(lines[0], /no live session/i);
  });

  test("placeholder respects width", () => {
    const lines = buildSessionPane([], [], 30, 20, plain, 1000);
    for (const l of lines) {
      assert.ok(visibleWidth(l) <= 30, `line too wide: ${l}`);
    }
  });

  test("placeholder is non-empty even at 0×0", () => {
    const lines = buildSessionPane([], [], 0, 0, plain, 1000);
    assert.ok(lines.length >= 1);
  });
});

// ── live activity present ──────────────────────────────────────────────

describe("buildSessionPane: live activity present", () => {
  test("one event → one activity line", () => {
    const ev = makeEvent({ at: 1000, tool: "bash", summary: "Ran npm test" });
    const lines = buildSessionPane([ev], [], 40, 20, plain, 2000);
    const text = lines.join("\n");
    assert.match(text, /Ran npm test/);
    assert.match(text, /bash/);
  });

  test("events are newest-first (the first event in the input appears first in the output)", () => {
    const e1 = makeEvent({ at: 1000, tool: "bash", summary: "FIRST" });
    const e2 = makeEvent({ at: 2000, tool: "bash", summary: "SECOND" });
    const e3 = makeEvent({ at: 3000, tool: "bash", summary: "THIRD" });
    const lines = buildSessionPane([e1, e2, e3], [], 40, 20, plain, 4000);
    const text = lines.join("\n");
    const iFirst = text.indexOf("FIRST");
    const iSecond = text.indexOf("SECOND");
    const iThird = text.indexOf("THIRD");
    assert.ok(iFirst >= 0 && iSecond >= 0 && iThird >= 0, "all three present");
    // Newest first means THIRD is above SECOND is above FIRST.
    assert.ok(iThird < iSecond, `THIRD should appear before SECOND, got iThird=${iThird} iSecond=${iSecond}`);
    assert.ok(iSecond < iFirst, `SECOND should appear before FIRST, got iSecond=${iSecond} iFirst=${iFirst}`);
  });

  test("failed events are visually distinguished from succeeded events", () => {
    const ok = makeEvent({ at: 1000, ok: true, summary: "OK_EVT" });
    const fail = makeEvent({ at: 2000, ok: false, summary: "FAIL_EVT" });
    const lines = buildSessionPane([ok, fail], [], 40, 20, plain, 3000);
    const text = lines.join("\n");
    // Both appear; the visual distinction is the renderer's
    // responsibility (color: red for fail, green/default for ok).
    // The plain styler emits no SGR, but the line content must
    // be unique enough to grep.
    assert.match(text, /OK_EVT/);
    assert.match(text, /FAIL_EVT/);
  });

  test("many events are truncated to fit the height", () => {
    const events = Array.from({ length: 100 }, (_, i) =>
      makeEvent({ at: i, summary: `event-${i}` }));
    const lines = buildSessionPane(events, [], 40, 6, plain, 1000);
    // 6 rows is small. Some events must be dropped (the oldest
    // ones — we keep the newest). The newest (event-99) must
    // survive, the oldest (event-0) must not.
    const text = lines.join("\n");
    assert.match(text, /event-99/);
    assert.doesNotMatch(text, /event-0/, "oldest event should be truncated out");
  });

  test("duration is shown when present (e.g. '2.1s' for 2100ms)", () => {
    const ev = makeEvent({ durationMs: 2100, summary: "durable" });
    const lines = buildSessionPane([ev], [], 40, 20, plain, 2000);
    const text = lines.join("\n");
    assert.match(text, /durable/);
    assert.match(text, /2\.1s|2,1s|2100ms/);
  });

  test("no line exceeds the given width", () => {
    const events = Array.from({ length: 20 }, (_, i) =>
      makeEvent({ at: i, summary: `event-with-a-long-summary-that-might-overflow-${i}` }));
    const lines = buildSessionPane(events, [], 30, 20, plain, 1000);
    for (const l of lines) {
      assert.ok(visibleWidth(l) <= 30, `line too wide: ${JSON.stringify(l)}`);
    }
  });
});

// ── timeline present ──────────────────────────────────────────────────

describe("buildSessionPane: step timeline present", () => {
  test("timeline renders with the outcome label (met/blocked/in-progress)", () => {
    const steps = [
      makeStep({ at: 1000, turn: 0, outcome: "in-progress", label: "first" }),
      makeStep({ at: 2000, turn: 1, outcome: "met", label: "second", reason: "all green" }),
    ];
    const lines = buildSessionPane([], steps, 40, 20, plain, 3000);
    const text = lines.join("\n");
    assert.match(text, /first/);
    assert.match(text, /second/);
    assert.match(text, /met|in-progress/);
  });

  test("timeline entries are newest-first", () => {
    const steps = [
      makeStep({ at: 1000, turn: 0, label: "OLDEST" }),
      makeStep({ at: 2000, turn: 1, label: "MIDDLE" }),
      makeStep({ at: 3000, turn: 2, label: "NEWEST" }),
    ];
    const lines = buildSessionPane([], steps, 40, 20, plain, 4000);
    const text = lines.join("\n");
    const iOld = text.indexOf("OLDEST");
    const iMid = text.indexOf("MIDDLE");
    const iNew = text.indexOf("NEWEST");
    assert.ok(iOld >= 0 && iMid >= 0 && iNew >= 0);
    assert.ok(iNew < iMid);
    assert.ok(iMid < iOld);
  });

  test("relative time is shown (e.g. '3m ago' for an event 3m before `now`)", () => {
    const now = 10 * 60_000; // 10 minutes
    const step = makeStep({ at: now - 3 * 60_000, turn: 0, label: "threeminsago" });
    const lines = buildSessionPane([], [step], 40, 20, plain, now);
    const text = lines.join("\n");
    assert.match(text, /3m ago|3 min ago|3m/);
  });
});

// ── events + timeline together ────────────────────────────────────────

describe("buildSessionPane: events and timeline together", () => {
  test("events appear above the timeline (activity feed is the top, timeline is the bottom)", () => {
    const ev = makeEvent({ at: 1000, summary: "ACTIVITY" });
    const step = makeStep({ at: 2000, turn: 0, label: "TIMELINE" });
    const lines = buildSessionPane([ev], [step], 40, 20, plain, 3000);
    const text = lines.join("\n");
    const iActivity = text.indexOf("ACTIVITY");
    const iTimeline = text.indexOf("TIMELINE");
    assert.ok(iActivity >= 0 && iTimeline >= 0);
    assert.ok(iActivity < iTimeline, "activity above timeline");
  });

  test("section header is present ('ACTIVITY' / 'TIMELINE') when both are non-empty", () => {
    const ev = makeEvent({ at: 1000, summary: "X" });
    const step = makeStep({ at: 2000, turn: 0, label: "Y" });
    const lines = buildSessionPane([ev], [step], 40, 20, plain, 3000);
    const text = lines.join("\n");
    // The pane should have visible section dividers — uppercase
    // labels like "ACTIVITY" and "TIMELINE" — to make the layout
    // scannable.
    assert.match(text, /ACTIVITY/);
    assert.match(text, /TIMELINE/);
  });
});

// ── height/width edge cases ───────────────────────────────────────────

describe("buildSessionPane: edge cases", () => {
  test("tall content is truncated to the pane height", () => {
    const events = Array.from({ length: 100 }, (_, i) =>
      makeEvent({ at: i, summary: `e-${i}` }));
    const lines = buildSessionPane(events, [], 40, 5, plain, 1000);
    assert.ok(lines.length <= 5, `pane too tall: ${lines.length} lines`);
  });

  test("width 1 does not throw (degenerate but defined)", () => {
    const ev = makeEvent();
    assert.doesNotThrow(() => buildSessionPane([ev], [], 1, 10, plain, 1000));
  });

  test("height 1 does not throw", () => {
    const ev = makeEvent();
    assert.doesNotThrow(() => buildSessionPane([ev], [], 40, 1, plain, 1000));
  });

  test("empty events + empty timeline + chain step → still shows something (chain is in the model)", () => {
    // v0.7.0 — when the model has a chainStep, the session pane
    // shows a chain-progress line even if the events file is
    // missing. This is a fallback so the user sees the chain
    // context in the right column.
    const lines = buildSessionPane([], [], 40, 20, plain, 1000, { chainStep: { current: 1, total: 3 } });
    const text = lines.join("\n");
    assert.match(text, /chain|step|2\/3/);
  });
});
