/**
 * test/blocks-validate.test.mjs — validateBlocks() test suite.
 *
 * Covers spec §4.1: key validation, version, size caps, depth guards,
 * card limits, custom block rules, sequence checking, fallback synthesis.
 * Runs against the BUILT output (dist/).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "dist");
const { validateBlocks } =
  await import("file:///" + join(dist, "blocks", "validate.js").replace(/\\/g, "/"));
const { blocks } =
  await import("file:///" + join(dist, "blocks", "factories.js").replace(/\\/g, "/"));

// ── helpers ────────────────────────────────────────────────────────────────

function v(res) {
  return { valid: res.valid, errors: res.errors, blockCount: res.blocks.length };
}

describe("validateBlocks — valid inputs", () => {
  test("empty array returns valid, no errors", () => {
    const r = validateBlocks([]);
    assert.equal(r.valid, true);
    assert.equal(r.blocks.length, 0);
    assert.equal(r.errors.length, 0);
  });

  test("single text block passes", () => {
    const r = validateBlocks([blocks.text({ key: "msg", content: "hello" })]);
    assert.equal(r.valid, true);
    assert.equal(r.blocks.length, 1);
    assert.equal(r.errors.length, 0);
  });

  test("all 8 block types pass", () => {
    const r = validateBlocks([
      blocks.text({ key: "t1", content: "hello" }),
      blocks.statRow({ key: "s1", stats: [{ label: "X", value: 1 }] }),
      blocks.progress({ key: "p1", percent: 50 }),
      blocks.code({ key: "c1", language: "js", content: "console.log(1)" }),
      blocks.list({ key: "l1", variant: "unordered", items: [{ text: "a" }] }),
      blocks.table({ key: "tb1", columns: [{ key: "a", label: "A" }], rows: [{ a: 1 }] }),
      blocks.row({ key: "r1", children: [blocks.text({ content: "child" })] }),
      blocks.custom({ key: "cu1", id: "opencode-autogoal:widget", data: {}, fallbackText: "Widget" }),
    ]);
    assert.equal(r.valid, true);
    assert.equal(r.blocks.length, 8);
  });
});

describe("validateBlocks — key validation", () => {
  test("empty string key → key_invalid", () => {
    const r = validateBlocks([{ key: "", type: "text", version: 1, content: "x" }]);
    assert.equal(r.errors[0].error, "key_invalid");
  });

  test("key > 64 chars → key_invalid", () => {
    const r = validateBlocks([blocks.text({ key: "a".repeat(65), content: "x" })]);
    assert.equal(r.errors[0].error, "key_invalid");
  });

  test("key with special char → key_invalid_chars", () => {
    const r = validateBlocks([blocks.text({ key: "bad key", content: "x" })]);
    assert.equal(r.errors[0].error, "key_invalid_chars");
  });

  test("reserved key → key_reserved", () => {
    const r = validateBlocks([blocks.text({ key: "__proto__", content: "x" })]);
    assert.equal(r.errors[0].error, "key_reserved");
  });

  test("duplicate key → key_duplicate", () => {
    const r = validateBlocks([
      blocks.text({ key: "dup", content: "a" }),
      blocks.text({ key: "dup", content: "b" }),
    ]);
    assert.ok(r.errors.some((e) => e.error === "key_duplicate"));
    assert.equal(r.blocks.length, 1); // first one kept
  });
});

describe("validateBlocks — version validation", () => {
  test("version 0 → version_invalid", () => {
    const r = validateBlocks([blocks.text({ key: "k", version: 0, content: "x" })]);
    assert.equal(r.errors[0].error, "version_invalid");
  });

  test("version non-finite → version_invalid", () => {
    const r = validateBlocks([{ key: "k", type: "text", version: NaN, content: "x" }]);
    assert.equal(r.errors[0].error, "version_invalid");
  });
});

describe("validateBlocks — size caps", () => {
  test("text > 50KB → content_too_large", () => {
    const r = validateBlocks([blocks.text({ key: "big", content: "x".repeat(50001) })]);
    assert.equal(r.errors[0].error, "content_too_large");
  });

  test("code > 1MB → content_too_large", () => {
    const r = validateBlocks([blocks.code({ key: "big", language: "txt", content: "x".repeat(1000001) })]);
    assert.equal(r.errors[0].error, "content_too_large");
  });

  test("stat-row > 12 stats → too_many_stats", () => {
    const stats = Array.from({ length: 13 }, (_, i) => ({ label: `S${i}`, value: i }));
    const r = validateBlocks([blocks.statRow({ key: "s", stats })]);
    assert.equal(r.errors[0].error, "too_many_stats");
  });

  test("list > 200 items → too_many_items", () => {
    const items = Array.from({ length: 201 }, (_, i) => ({ text: `item-${i}` }));
    const r = validateBlocks([blocks.list({ key: "l", variant: "unordered", items })]);
    assert.equal(r.errors[0].error, "too_many_items");
  });

  test("table > 100 columns → too_many_columns", () => {
    const cols = Array.from({ length: 101 }, (_, i) => ({ key: `c${i}`, label: `C${i}` }));
    const r = validateBlocks([blocks.table({ key: "t", columns: cols, rows: [{ c0: "x" }] })]);
    assert.equal(r.errors[0].error, "too_many_columns");
  });

  test("table > 200 rows → too_many_rows", () => {
    const rows = Array.from({ length: 201 }, (_, i) => ({ a: i }));
    const r = validateBlocks([blocks.table({ key: "t", columns: [{ key: "a", label: "A" }], rows })]);
    assert.equal(r.errors[0].error, "too_many_rows");
  });

  test("row > 6 children → too_many_children", () => {
    const children = Array.from({ length: 7 }, (_, i) => blocks.text({ content: `c${i}` }));
    const r = validateBlocks([blocks.row({ key: "r", children })]);
    assert.equal(r.errors[0].error, "too_many_children");
  });
});

describe("validateBlocks — total blocks cap", () => {
  test("> 256 blocks → too_many_blocks (global)", () => {
    const many = Array.from({ length: 257 }, (_, i) => blocks.text({ key: `k${i}`, content: "x" }));
    const r = validateBlocks(many);
    assert.ok(r.errors.some((e) => e.error === "too_many_blocks"));
    assert.ok(r.errors.some((e) => e.key === "*"));
  });
});

describe("validateBlocks — row depth", () => {
  test("nested row → row_depth_exceeded", () => {
    const r = validateBlocks([blocks.row({
      key: "outer",
      children: [blocks.row({
        key: "inner",
        children: [blocks.text({ content: "deep" })],
      })],
    })]);
    assert.equal(r.errors[0].error, "row_depth_exceeded");
  });
});

describe("validateBlocks — custom block", () => {
  test("missing namespace → custom_id_not_namespaced", () => {
    const r = validateBlocks([blocks.custom({ key: "c", id: "nonamespaced", data: {}, fallbackText: "x" })]);
    assert.equal(r.errors[0].error, "custom_id_not_namespaced");
  });

  test("missing fallbackText → custom_missing_fallback", () => {
    const r = validateBlocks([blocks.custom({ key: "c", id: "ns:id", data: {}, fallbackText: "" })]);
    assert.equal(r.errors[0].error, "custom_missing_fallback");
  });
});

describe("validateBlocks — progress percent", () => {
  test("NaN percent → percent_invalid", () => {
    const r = validateBlocks([{ key: "p", type: "progress", version: 1, percent: NaN }]);
    assert.equal(r.errors[0].error, "percent_invalid");
  });

  test("-1 percent (indeterminate) passes", () => {
    const r = validateBlocks([blocks.progress({ key: "p", percent: -1 })]);
    assert.equal(r.valid, true);
  });
});

describe("validateBlocks — sequence ordering", () => {
  test("sequence not monotonic → sequence_not_monotonic", () => {
    const map = {
      get(key) { return this.store[key]; },
      set(key, seq) { this.store[key] = seq; },
      store: { "seq": 5 },
    };
    const r = validateBlocks([blocks.text({ key: "seq", content: "x" })], map);
    // The factory produces blocks without sequence, so no error here.
    // Test with explicit sequence:
    const r2 = validateBlocks([{ key: "seq", type: "text", version: 1, content: "x", sequence: 3 }], map);
    assert.equal(r2.errors[0].error, "sequence_not_monotonic");
  });
});

describe("validateBlocks — fallback synthesis", () => {
  test("all blocks invalid → fallback text block synthesized", () => {
    const r = validateBlocks([
      { key: "", type: "text", version: 1, content: "x" }, // invalid key
    ]);
    assert.equal(r.valid, false);
    assert.equal(r.blocks.length, 1);
    assert.equal(r.blocks[0].key, "_fallback");
    assert.equal(r.blocks[0].type, "text");
  });
});

describe("validateBlocks — sanitizeBlock", () => {
  test("strips reserved keys", async () => {
    const { sanitizeBlock } = await import("file:///" + join(dist, "blocks", "validate.js").replace(/\\/g, "/"));
    const cleaned = sanitizeBlock({ __proto__: "bad", safe: "ok", nested: { toString: "bad2", ok: "yes" } });
    assert.equal(cleaned.__proto__, undefined);
    assert.equal(cleaned.safe, "ok");
    assert.equal(cleaned.nested.toString, undefined);
    assert.equal(cleaned.nested.ok, "yes");
  });
});
