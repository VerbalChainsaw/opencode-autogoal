/**
 * format.ts — zero-dep color/theme/table primitives for the CLI + TUI.
 * Runs against the BUILT output (dist/format.js).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "dist");
const { createStyler, supportsColor, visibleWidth, truncate, padEnd, renderTable } =
  await import("file:///" + join(dist, "format.js").replace(/\\/g, "/"));

describe("createStyler", () => {
  test("disabled styler returns text unchanged", () => {
    const s = createStyler(false);
    assert.equal(s.red("x"), "x");
    assert.equal(s.bold("hi"), "hi");
    assert.equal(s.green("ok"), "ok");
  });
  test("enabled styler wraps in SGR with PRECISE resets (composable)", () => {
    // Precise resets (39 = default fg, 22 = normal intensity) instead of a
    // blanket 0 so a styled span nested inside another style doesn't wipe the
    // outer attribute.
    const s = createStyler(true);
    assert.equal(s.red("x"), "\x1b[31mx\x1b[39m");
    assert.equal(s.bold("x"), "\x1b[1mx\x1b[22m");
    assert.equal(s.dim("x"), "\x1b[2mx\x1b[22m");
  });
  test("empty string passes through with no codes", () => {
    assert.equal(createStyler(true).red(""), "");
  });
});

describe("supportsColor", () => {
  test("TTY + no NO_COLOR → true", () => {
    assert.equal(supportsColor({ isTTY: true }, {}), true);
  });
  test("NO_COLOR set (any value, even empty) → false", () => {
    assert.equal(supportsColor({ isTTY: true }, { NO_COLOR: "" }), false);
    assert.equal(supportsColor({ isTTY: true }, { NO_COLOR: "1" }), false);
  });
  test("non-TTY → false", () => {
    assert.equal(supportsColor({ isTTY: false }, {}), false);
    assert.equal(supportsColor(undefined, {}), false);
  });
});

describe("visibleWidth", () => {
  test("ignores SGR codes", () => {
    assert.equal(visibleWidth("\x1b[31mhi\x1b[0m"), 2);
  });
  test("counts plain code points", () => {
    assert.equal(visibleWidth("hello"), 5);
    assert.equal(visibleWidth(""), 0);
  });
});

describe("truncate", () => {
  test("leaves short strings alone", () => {
    assert.equal(truncate("hi", 5), "hi");
  });
  test("truncates with an ellipsis at the width", () => {
    assert.equal(truncate("hello", 3), "he…");
    assert.equal(visibleWidth(truncate("hello", 3)), 3);
  });
  test("width 0 or negative → empty", () => {
    assert.equal(truncate("hello", 0), "");
  });
});

describe("padEnd", () => {
  test("pads to width", () => {
    assert.equal(padEnd("hi", 5), "hi   ");
  });
  test("does not shrink longer strings", () => {
    assert.equal(padEnd("hello", 3), "hello");
  });
});

describe("renderTable", () => {
  test("aligns columns with a 2-space gutter and trims trailing space", () => {
    const lines = renderTable([["a", "bb"], ["ccc", "d"]]);
    assert.deepEqual(lines, ["a    bb", "ccc  d"]);
  });
  test("empty rows → empty array", () => {
    assert.deepEqual(renderTable([]), []);
  });
});
