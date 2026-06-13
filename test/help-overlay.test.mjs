/**
 * help-overlay.test.mjs — E25 of the v0.7.0 plan.
 *
 * `buildHelpOverlay()` renders a section of the help content
 * for the overlay. Pure: takes the sections, current page
 * index, search query, and width, and returns an array of
 * lines. The shell owns the page/search state; the overlay
 * just renders.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { buildHelpSections } from "../dist/help-content.js";
import { buildHelpOverlay } from "../dist/help-overlay.js";

describe("buildHelpOverlay", () => {
  test("returns the section header as the first line", () => {
    const sections = buildHelpSections();
    const out = buildHelpOverlay(sections, 0, "", 80);
    assert.match(out[0], /GOAL|Goal/i);
  });

  test("renders each entry as `key: action` on its own line", () => {
    const sections = buildHelpSections();
    const out = buildHelpOverlay(sections, 0, "", 80);
    // The first section (Goal) has a known entry. Find the
    // 'p' / pause entry by searching for "Pause" or "pause".
    const pauseLine = out.find((l) => /pause/i.test(l));
    assert.ok(pauseLine, "should render a pause entry");
    assert.match(pauseLine, /\bp\b/);
  });

  test("respects the page index — page 1 shows the second section's content", () => {
    const sections = buildHelpSections();
    const out0 = buildHelpOverlay(sections, 0, "", 80);
    const out1 = buildHelpOverlay(sections, 1, "", 80);
    assert.notEqual(out0[0], out1[0], "different pages should show different content");
  });

  test("search query filters entries (case-insensitive substring match)", () => {
    const sections = buildHelpSections();
    const allOut = buildHelpOverlay(sections, 0, "", 80);
    const filteredOut = buildHelpOverlay(sections, 0, "pause", 80);
    // The filtered output is at most the same length as the
    // unfiltered output (the section header line is always
    // present, so it can be at most 1 line longer than the
    // matching entries).
    assert.ok(filteredOut.length < allOut.length, `filtered output should be shorter (got ${filteredOut.length} vs ${allOut.length})`);
    // Every entry line (skip the header + the pagination
    // hint at the bottom) in the filtered output should
    // match the query (case-insensitive).
    for (let i = 1; i < filteredOut.length - 1; i++) {
      const l = filteredOut[i];
      assert.match((l ?? "").toLowerCase(), /pause/);
    }
  });

  test("search query that matches nothing shows a 'no matches' line", () => {
    const sections = buildHelpSections();
    const out = buildHelpOverlay(sections, 0, "zXyQ-no-match", 80);
    // The overlay always renders the section header, so
    // the "no matches" line is the second line.
    assert.ok(out.length >= 2);
    assert.match(out[0] ?? "", /GOAL/);
    assert.match(out[1] ?? "", /no match/i);
  });

  test("out-of-range page index clamps to the last page", () => {
    const sections = buildHelpSections();
    const last = sections.length - 1;
    const lastLabel = (sections[last]?.label ?? "").toUpperCase();
    const out = buildHelpOverlay(sections, 999, "", 80);
    assert.match(out[0] ?? "", new RegExp(lastLabel));
  });

  test("lines respect the width (no line exceeds it)", () => {
    const sections = buildHelpSections();
    for (const l of buildHelpOverlay(sections, 0, "", 40)) {
      assert.ok(l.length <= 40, `line too wide: ${l}`);
    }
  });
});
