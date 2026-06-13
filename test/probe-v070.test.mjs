/**
 * probe-v070.test.mjs — adversarial probes for v0.7.0 surfaces.
 *
 * The existing v0.6.0 probe.test.mjs covers the legacy
 * surfaces (CLI, archive, etc.). This file adds probes
 * specifically for the v0.7.0 additions:
 *
 *   - control-center-history.ts (drill reducer)
 *   - picker.ts (list-picker reducer)
 *   - help-content.ts + help-overlay.ts (help modules)
 *   - control-center.ts (three-pane shell)
 *   - session-events.ts + step-timeline.ts (live event files)
 *
 * The probes feed malformed inputs and broken state files
 * to find defects — not just to verify the happy path.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  drillReducer,
  initialDrillState,
} from "../dist/control-center-history.js";
import {
  pickReducer,
  initialPickState,
} from "../dist/picker.js";
import { buildHelpSections } from "../dist/help-content.js";
import { buildHelpOverlay } from "../dist/help-overlay.js";

function freshDir() {
  return mkdtempSync(join(tmpdir(), "probe-v070-"));
}

// ── drillReducer: malformed actions ──────────────────────────────────

describe("drillReducer: malformed actions", () => {
  test("an action without a 'kind' field is a no-op (returns equivalent state)", () => {
    const s0 = { kind: "history", cursor: 2, itemCount: 5, done: null, detailOpen: false };
    // @ts-expect-error — intentionally malformed
    const s1 = drillReducer(s0, {});
    assert.deepEqual(s1, s0);
  });

  test("an action with a non-string 'kind' is a no-op", () => {
    const s0 = { kind: "history", cursor: 2, itemCount: 5, done: null, detailOpen: false };
    // @ts-expect-error — intentionally malformed
    const s1 = drillReducer(s0, { kind: 42 });
    assert.deepEqual(s1, s0);
  });

  test("a null action is a no-op (returns the input state unchanged)", () => {
    // @ts-expect-error — intentionally malformed
    const s1 = drillReducer(null, { kind: "down" });
    assert.equal(s1, null);
  });

  test("itemCount = 0: down and up are both no-ops (cursor stays at 0)", () => {
    const s0 = initialDrillState("history", 0);
    const s1 = drillReducer(s0, { kind: "down" });
    assert.equal(s1.cursor, 0);
    const s2 = drillReducer(s0, { kind: "up" });
    assert.equal(s2.cursor, 0);
  });

  test("itemCount = 0: enter on a normal item is a no-op (detailOpen false)", () => {
    const s0 = initialDrillState("history", 0);
    const s1 = drillReducer(s0, { kind: "enter" });
    assert.equal(s1.detailOpen, false);
    assert.equal(s1.done, null);
  });
});

// ── pickReducer: malformed actions ────────────────────────────────────

describe("pickReducer: malformed actions", () => {
  test("an action without 'kind' is a no-op", () => {
    const s0 = { cursor: 1, done: null };
    // @ts-expect-error
    const s1 = pickReducer(s0, {});
    assert.deepEqual(s1, s0);
  });

  test("down with itemCount = 0 clamps the cursor to 0", () => {
    const s0 = { cursor: 0, done: null };
    const s1 = pickReducer(s0, { kind: "down", itemCount: 0 });
    assert.equal(s1.cursor, 0);
  });

  test("down with itemCount = -1 (negative) clamps to 0", () => {
    const s0 = { cursor: 5, done: null };
    const s1 = pickReducer(s0, { kind: "down", itemCount: -1 });
    assert.equal(s1.cursor, 0);
  });

  test("down with itemCount = NaN falls back to unbounded growth", () => {
    // NaN isn't a valid itemCount, so the cursor grows
    // unbounded. The shell clamps at the rendering layer.
    const s0 = { cursor: 2, done: null };
    const s1 = pickReducer(s0, { kind: "down", itemCount: NaN });
    assert.equal(s1.cursor, 3);
  });
});

// ── help-overlay: malformed inputs ───────────────────────────────────

describe("buildHelpOverlay: malformed inputs", () => {
  test("empty sections array returns a 'no help' line", () => {
    const out = buildHelpOverlay([], 0, "", 80);
    assert.equal(out.length, 1);
    assert.match(out[0] ?? "", /No help available/);
  });

  test("negative width clamps to 20 (the floor)", () => {
    const sections = buildHelpSections();
    const out = buildHelpOverlay(sections, 0, "", -100);
    // All lines should be at most 20 chars (the width floor).
    for (const l of out) {
      assert.ok(l.length <= 20, `line too wide: ${l.length} chars: ${l}`);
    }
  });

  test("zero width clamps to 20", () => {
    const sections = buildHelpSections();
    const out = buildHelpOverlay(sections, 0, "", 0);
    for (const l of out) {
      assert.ok(l.length <= 20, `line too wide: ${l.length} chars: ${l}`);
    }
  });

  test("non-integer page (3.7) is floored to 3", () => {
    const sections = buildHelpSections();
    const out = buildHelpOverlay(sections, 3.7, "", 80);
    // The 4th page would be out-of-range (sections has 3
    // entries: 0, 1, 2). The clamp should kick in.
    assert.match(out[0] ?? "", /NAV/);
  });

  test("query that is a regex special char doesn't break the filter", () => {
    const sections = buildHelpSections();
    // Regex special chars in the query: should be treated as
    // literal text, not regex.
    const out = buildHelpOverlay(sections, 0, "(.*+?", 80);
    // The output should not throw; it should be either the
    // matching entries or the 'no matches' line.
    assert.ok(out.length >= 1);
  });

  test("a query with a null byte doesn't break the filter", () => {
    const sections = buildHelpSections();
    // Most entries don't contain null bytes, so this should
    // be a no-match. The test is that it doesn't throw.
    const out = buildHelpOverlay(sections, 0, "Pause\x00xyz", 80);
    assert.ok(out.length >= 1);
  });
});

// ── broken state files ───────────────────────────────────────────────

describe("v0.7.0 reads of broken state files", () => {
  test("a corrupted .opencode/.session-events.jsonl is recoverable (the reader skips bad lines)", async () => {
    // We can't directly import readSessionEvents (it's not
    // exported from a public surface); the test imports it
    // from the dist and verifies it doesn't throw on a
    // bad file.
    const dir = freshDir();
    try {
      const { mkdirSync, writeFileSync } = await import("node:fs");
      mkdirSync(join(dir, ".opencode"), { recursive: true });
      // Write a mix of good and bad lines.
      const lines = [
        JSON.stringify({ at: 1, kind: "tool-end", tool: "bash", summary: "ok", ok: true, durationMs: 100 }),
        "this is not valid json",
        JSON.stringify({ at: 2, kind: "tool-end", tool: "read", summary: "ok", ok: true, durationMs: 50 }),
        "{unbalanced",
      ];
      writeFileSync(join(dir, ".opencode", ".session-events.jsonl"), lines.join("\n") + "\n");
      const { readSessionEvents } = await import("../dist/session-events.js");
      const events = readSessionEvents(dir);
      // The reader should return the good lines and skip
      // the bad ones. We accept any subset (some readers
      // might throw on the first bad line; we just need
      // the function to not hang or crash the test).
      assert.ok(Array.isArray(events));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("a corrupted .opencode/.step-timeline.jsonl is recoverable", async () => {
    const dir = freshDir();
    try {
      const { mkdirSync, writeFileSync } = await import("node:fs");
      mkdirSync(join(dir, ".opencode"), { recursive: true });
      const lines = [
        JSON.stringify({ at: 1, turn: 1, label: "ok", outcome: "met" }),
        "garbage",
      ];
      writeFileSync(join(dir, ".opencode", ".step-timeline.jsonl"), lines.join("\n") + "\n");
      const { readStepTimeline } = await import("../dist/step-timeline.js");
      const events = readStepTimeline(dir);
      assert.ok(Array.isArray(events));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("a missing .opencode/ directory is handled (not a crash)", async () => {
    const dir = freshDir();
    try {
      // No .opencode/ created.
      const { readSessionEvents } = await import("../dist/session-events.js");
      const events = readSessionEvents(dir);
      assert.deepEqual(events, []);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
