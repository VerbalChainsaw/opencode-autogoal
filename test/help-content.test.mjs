/**
 * help-content.test.mjs — E25 of the v0.7.0 plan.
 *
 * `buildHelpSections()` produces the categorized help data.
 * Three sections (Goal / Session / Nav), each with key/action
 * pairs. Used by the help overlay to render a paged, searchable
 * cheat sheet.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { buildHelpSections } from "../dist/help-content.js";

describe("buildHelpSections", () => {
  test("returns three sections: Goal, Session, Nav", () => {
    const sections = buildHelpSections();
    const labels = sections.map((s) => s.label);
    assert.deepEqual(labels, ["Goal", "Session", "Nav"]);
  });

  test("every section has a non-empty entries array", () => {
    const sections = buildHelpSections();
    for (const s of sections) {
      assert.ok(s.entries.length > 0, `section '${s.label}' should have at least one entry`);
      for (const e of s.entries) {
        assert.equal(typeof e.key, "string");
        assert.equal(typeof e.action, "string");
        assert.ok(e.key.length > 0);
        assert.ok(e.action.length > 0);
      }
    }
  });

  test("every section's keys are unique within the section", () => {
    // Two actions can share a key in different sections (e.g.,
    // 'q' in Goal means quit, 'q' in Nav means... whatever Nav
    // uses 'q' for). But within a section, keys must be
    // unique — otherwise the help text is ambiguous.
    const sections = buildHelpSections();
    for (const s of sections) {
      const keys = s.entries.map((e) => e.key);
      assert.equal(new Set(keys).size, keys.length, `section '${s.label}' has duplicate keys: ${keys.join(", ")}`);
    }
  });

  test("the v0.7.0 7 new actions are all present somewhere in the help", () => {
    const sections = buildHelpSections();
    const flatEntries = sections.flatMap((s) => s.entries);
    const allActions = flatEntries.map((e) => e.action).join(" ").toLowerCase();
    // The 7 v0.7.0 actions should appear in the help
    // (case-insensitive).
    assert.match(allActions, /archive/);
    assert.match(allActions, /template/);
    assert.match(allActions, /doctor/);
    assert.match(allActions, /open .opencode/);
    assert.match(allActions, /copy the full goal state/);
    assert.match(allActions, /redraw/);
  });

  test("the v0.6.0 keys (p, s, e, c, n, q, ?, ↑, ↓, Tab) are all present", () => {
    const sections = buildHelpSections();
    const flatKeys = sections.flatMap((s) => s.entries.map((e) => e.key));
    // The ↑ and ↓ keys are bundled into one entry ("↑ / ↓").
    // Check for the bundle string plus all the single keys.
    for (const k of ["p", "s", "e", "c", "n", "q", "?", "Tab"]) {
      assert.ok(flatKeys.includes(k), `v0.6.0 key '${k}' should be in the help`);
    }
    assert.ok(flatKeys.includes("↑ / ↓"), "the ↑ / ↓ bundle should be in the help");
  });
});
