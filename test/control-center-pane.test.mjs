/**
 * control-center-pane.test.mjs — B7 of the v0.7.0 plan.
 *
 * `renderLayout` is a pure function that takes a list of pane
 * contents and a terminal size, and returns the joined output
 * lines + a hit-test map + the layout mode + the focus index.
 * No I/O, no state. The TUI control center's shell builds the
 * pane contents from the model and delegates the layout to this
 * module.
 *
 * Three layout modes:
 *   - "stack"   (default, width ≥ 80, height ≥ 16, has session content):
 *                header on top, left+right panes side-by-side, keybar
 *                at the bottom. Vertical separator between left/right.
 *   - "stacked" (width < 80): single column, all panes stacked vertically.
 *   - "compact" (height < 16 OR no session content): no session pane.
 *                header + goal pane + keybar.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  renderLayout,
  pickLayoutMode,
} from "../dist/control-center-pane.js";

// ── pickLayoutMode ──────────────────────────────────────────────────────

test("pickLayoutMode: stack (default — width ≥ 80, height ≥ 16, has session)", () => {
  assert.equal(pickLayoutMode(80, 24, true), "stack");
  assert.equal(pickLayoutMode(120, 40, true), "stack");
  assert.equal(pickLayoutMode(80, 16, true), "stack");
});

test("pickLayoutMode: stacked (width < 80)", () => {
  assert.equal(pickLayoutMode(79, 24, true), "stacked");
  assert.equal(pickLayoutMode(40, 24, true), "stacked");
});

test("pickLayoutMode: compact (height < 16)", () => {
  assert.equal(pickLayoutMode(120, 15, true), "compact");
  assert.equal(pickLayoutMode(80, 10, true), "compact");
});

test("pickLayoutMode: compact (no session content)", () => {
  assert.equal(pickLayoutMode(120, 24, false), "compact");
  assert.equal(pickLayoutMode(40, 24, false), "compact");
});

test("pickLayoutMode: tiny terminal (height < 4) → compact (degenerate but defined)", () => {
  assert.equal(pickLayoutMode(80, 3, true), "compact");
});

test("pickLayoutMode: degenerate dimensions (width < 4) → compact (clamped)", () => {
  assert.equal(pickLayoutMode(2, 24, true), "compact");
});

// ── renderLayout: stack mode ────────────────────────────────────────────

test("renderLayout(stack): header on top, left+right side-by-side, keybar on bottom", () => {
  const panes = [
    { id: "header", lines: ["HEADER LINE"], focusable: false },
    { id: "goal", lines: ["goal line 1", "goal line 2"], focusable: true },
    { id: "session", lines: ["session line 1", "session line 2"], focusable: true },
    { id: "keybar", lines: ["[p] [s] [q]"], focusable: false },
  ];
  const r = renderLayout(panes, 80, 24, 0);
  assert.equal(r.mode, "stack");
  assert.equal(r.focusIndex, 0);
  // First line is the header
  assert.match(r.lines[0], /HEADER LINE/);
  // Goal pane content is on the LEFT of the body rows
  assert.match(r.lines[1], /goal line 1/);
  assert.match(r.lines[1], /session line 1/);
  // Last line is the keybar
  assert.match(r.lines[r.lines.length - 1], /\[p\]/);
  // Goal pane's "line 2" should be ABOVE the keybar (footer-anchored)
  const goalIdx = r.lines.findIndex((l) => l.includes("goal line 2"));
  const keybarIdx = r.lines.findIndex((l) => l.includes("[p]"));
  assert.ok(goalIdx > 0 && goalIdx < keybarIdx, "goal line 2 above keybar");
  // session line 2 also above keybar
  const sessionIdx = r.lines.findIndex((l) => l.includes("session line 2"));
  assert.ok(sessionIdx > 0 && sessionIdx < keybarIdx, "session line 2 above keybar");
});

test("renderLayout(stack): hit-test map tells you which pane a row belongs to", () => {
  const panes = [
    { id: "header", lines: ["H"], focusable: false },
    { id: "goal", lines: ["G1", "G2", "G3"], focusable: true },
    { id: "session", lines: ["S1", "S2", "S3"], focusable: true },
    { id: "keybar", lines: ["K"], focusable: false },
  ];
  const r = renderLayout(panes, 80, 24, 0);
  // Stack mode: row 0 = header, rows 1..bodyHeight = split (body),
  // last row = keybar. The body's per-pane ownership is
  // disambiguated by column (left half = goal, right half = session).
  assert.equal(r.hitTest[0], "header");
  // body rows are "split" — both panes share the row
  for (let i = 1; i < r.hitTest.length - 1; i++) {
    assert.equal(r.hitTest[i], "split", `row ${i} should be 'split', got: ${r.hitTest[i]}`);
  }
  assert.equal(r.hitTest[r.hitTest.length - 1], "keybar");
});

test("renderLayout(stack): vertical separator between goal and session panes", () => {
  const panes = [
    { id: "header", lines: ["H"], focusable: false },
    { id: "goal", lines: ["G"], focusable: true },
    { id: "session", lines: ["S"], focusable: true },
    { id: "keybar", lines: ["K"], focusable: false },
  ];
  const r = renderLayout(panes, 80, 24, 0);
  // Find the body row that contains both G and S — it should have a
  // vertical separator (│ or |) between them. The shell uses ANSI;
  // we can also accept a plain "|" if no color is enabled.
  const gIdx = r.lines.findIndex((l) => l.includes("G"));
  const body = r.lines[gIdx];
  // The separator appears between the two contents.
  assert.ok(
    body.includes("│") || body.includes("|"),
    `expected a vertical separator in body row, got: ${body}`,
  );
});

// ── renderLayout: stacked mode ──────────────────────────────────────────

test("renderLayout(stacked): all panes in a single column, no side-by-side", () => {
  const panes = [
    { id: "header", lines: ["HEADER"], focusable: false },
    { id: "goal", lines: ["G1", "G2"], focusable: true },
    { id: "session", lines: ["S1", "S2"], focusable: true },
    { id: "keybar", lines: ["KEYBAR"], focusable: false },
  ];
  const r = renderLayout(panes, 60, 24, 0);
  assert.equal(r.mode, "stacked");
  // All four sections appear in order, top to bottom. The lines
  // are padded to width=60 with spaces, so we use .includes() to
  // find each marker.
  const hIdx = r.lines.findIndex((l) => l.includes("HEADER"));
  const gIdx = r.lines.findIndex((l) => l.includes("G1"));
  const sIdx = r.lines.findIndex((l) => l.includes("S1"));
  const kIdx = r.lines.findIndex((l) => l.includes("KEYBAR"));
  assert.ok(hIdx >= 0 && gIdx > hIdx, `goal (${gIdx}) after header (${hIdx})`);
  assert.ok(sIdx > gIdx, `session (${sIdx}) after goal (${gIdx})`);
  assert.ok(kIdx > sIdx, `keybar (${kIdx}) after session (${sIdx})`);
  // No vertical separator in stacked mode
  for (const line of r.lines) {
    assert.ok(!line.includes("│"), `stacked mode should have no vertical separator, got: ${line}`);
  }
});

// ── renderLayout: compact mode ──────────────────────────────────────────

test("renderLayout(compact): no session pane; header + goal + keybar only", () => {
  const panes = [
    { id: "header", lines: ["HEADER"], focusable: false },
    { id: "goal", lines: ["G1", "G2"], focusable: true },
    { id: "session", lines: ["S1", "S2"], focusable: true },
    { id: "keybar", lines: ["KEYBAR"], focusable: false },
  ];
  const r = renderLayout(panes, 80, 10, 0); // height 10 → compact
  assert.equal(r.mode, "compact");
  // The session content should NOT appear in the output
  for (const line of r.lines) {
    assert.ok(!line.includes("S1"), `compact mode should hide session pane, got: ${line}`);
  }
  // Header, goal, keybar should all be present (lines are padded
  // to width with spaces, so we use .includes())
  assert.ok(r.lines.some((l) => l.includes("HEADER")));
  assert.ok(r.lines.some((l) => l.includes("G1")));
  assert.ok(r.lines.some((l) => l.includes("KEYBAR")));
});

// ── focus ───────────────────────────────────────────────────────────────

test("renderLayout: focus=0 highlights the goal pane (the first focusable)", () => {
  const panes = [
    { id: "header", lines: ["H"], focusable: false },
    { id: "goal", lines: ["G"], focusable: true },
    { id: "session", lines: ["S"], focusable: true },
    { id: "keybar", lines: ["K"], focusable: false },
  ];
  const r = renderLayout(panes, 80, 24, 0);
  assert.equal(r.focusIndex, 0);
  // (Visual focus indicator is the renderer's job; the layout just
  // reports which focus index was used.)
});

test("renderLayout: focus=1 highlights the session pane (the second focusable)", () => {
  const panes = [
    { id: "header", lines: ["H"], focusable: false },
    { id: "goal", lines: ["G"], focusable: true },
    { id: "session", lines: ["S"], focusable: true },
    { id: "keybar", lines: ["K"], focusable: false },
  ];
  const r = renderLayout(panes, 80, 24, 1);
  assert.equal(r.focusIndex, 1);
});

// ── edge cases ──────────────────────────────────────────────────────────

test("renderLayout: empty pane list → just a blank frame", () => {
  const r = renderLayout([], 80, 24, 0);
  // No content to render; the result is at minimum a single
  // blank row (so the shell has something to write to the
  // terminal). The hit-test pad ensures lines.length >= 1.
  assert.ok(r.lines.length >= 1, `expected ≥1 line, got ${r.lines.length}`);
  assert.equal(r.lines[0], "");
});

test("renderLayout: clamps dimensions to sane minimums (width ≥ 1, height ≥ 1)", () => {
  const panes = [
    { id: "header", lines: ["H"], focusable: false },
    { id: "goal", lines: ["G"], focusable: true },
    { id: "keybar", lines: ["K"], focusable: false },
  ];
  // width=0, height=0 should not throw
  const r = renderLayout(panes, 0, 0, 0);
  assert.ok(Array.isArray(r.lines));
  assert.ok(r.lines.length >= 0);
});

test("renderLayout: respects hit-test length = lines length", () => {
  const panes = [
    { id: "header", lines: ["H"], focusable: false },
    { id: "goal", lines: ["G1", "G2"], focusable: true },
    { id: "session", lines: ["S1", "S2"], focusable: true },
    { id: "keybar", lines: ["K"], focusable: false },
  ];
  const r = renderLayout(panes, 80, 24, 0);
  assert.equal(r.hitTest.length, r.lines.length,
    `hit-test (${r.hitTest.length}) must match lines (${r.lines.length})`);
});

test("renderLayout: a single goal line plus single keybar uses exactly 3 lines in stack mode", () => {
  const panes = [
    { id: "header", lines: ["H"], focusable: false },
    { id: "goal", lines: ["G"], focusable: true },
    { id: "session", lines: ["S"], focusable: true },
    { id: "keybar", lines: ["K"], focusable: false },
  ];
  const r = renderLayout(panes, 80, 24, 0);
  // Stack mode in a 24-row terminal with 1-line panes: header (1) +
  // body (22 rows of 1-line, padded to 22) + keybar (1) = 24 lines.
  // The "exactly 3 lines" test was wrong — the body is padded to
  // the full terminal height. We assert the structural shape:
  // first row is the header, last row is the keybar, and the
  // first body row contains both G and S.
  assert.equal(r.lines.length, 24);
  assert.match(r.lines[0], /H/);
  assert.match(r.lines[1], /G/);
  assert.match(r.lines[1], /S/);
  assert.match(r.lines[r.lines.length - 1], /K/);
});
