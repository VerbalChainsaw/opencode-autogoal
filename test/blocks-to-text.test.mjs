/**
 * test/blocks-to-text.test.mjs — blockToText / blockToTextForLLM tests.
 *
 * Covers spec §9.1–9.2: plain-text conversion for all 8 block types,
 * LLM-safe wrapping, truncation, ANSI stripping, and error fallback.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "dist");
const { blockToText, blocksToText, blockToTextForLLM, blocksToTextForLLM } =
  await import("file:///" + join(dist, "blocks", "to-text.js").replace(/\\/g, "/"));
const { blocks } =
  await import("file:///" + join(dist, "blocks", "factories.js").replace(/\\/g, "/"));

describe("blockToText — single blocks", () => {
  test("text: returns content verbatim", () => {
    const b = blocks.text({ key: "t", content: "hello world" });
    assert.equal(blockToText(b), "hello world");
  });

  test("text: empty content → empty string", () => {
    const b = blocks.text({ key: "t", content: "" });
    assert.equal(blockToText(b), "");
  });

  test("stat-row: formats as label: value | ...", () => {
    const b = blocks.statRow({ key: "s", stats: [
      { label: "Turns", value: "5/20" },
      { label: "Time", value: "10m" },
    ]});
    assert.equal(blockToText(b), "Turns: 5/20 | Time: 10m");
  });

  test("progress: shows percent and label", () => {
    const b = blocks.progress({ key: "p", percent: 55, label: "Building" });
    assert.equal(blockToText(b), "[55%] Building");
  });

  test("progress: indeterminate (-1)", () => {
    const b = blocks.progress({ key: "p", percent: -1 });
    assert.equal(blockToText(b), "[-1%] ");
  });

  test("code: shows title + content", () => {
    const b = blocks.code({ key: "c", language: "js", title: "main.js", content: "console.log(1)" });
    assert.ok(blockToText(b).startsWith("main.js:\n"));
    assert.ok(blockToText(b).includes("console.log(1)"));
  });

  test("list unordered: bullet points", () => {
    const b = blocks.list({ key: "l", variant: "unordered", items: [
      { text: "first" },
      { text: "second" },
    ]});
    assert.equal(blockToText(b), "• first\n• second");
  });

  test("list ordered: numbers", () => {
    const b = blocks.list({ key: "l", variant: "ordered", items: [
      { text: "alpha" },
      { text: "beta" },
    ]});
    assert.equal(blockToText(b), "1. alpha\n2. beta");
  });

  test("list checkbox: checked/unchecked", () => {
    const b = blocks.list({ key: "l", variant: "checkbox", items: [
      { text: "done", checked: true },
      { text: "todo", checked: false },
    ]});
    assert.equal(blockToText(b), "☑ done\n☐ todo");
  });

  test("table: markdown table format", () => {
    const b = blocks.table({
      key: "t",
      columns: [{ key: "name", label: "Name" }, { key: "val", label: "Value" }],
      rows: [{ name: "x", val: 1 }, { name: "y", val: 2 }],
    });
    const text = blockToText(b);
    assert.ok(text.includes("| Name | Value |"));
    assert.ok(text.includes("| x | 1 |"));
    assert.ok(text.includes("| y | 2 |"));
  });

  test("table: with caption", () => {
    const b = blocks.table({
      key: "t", caption: "Results",
      columns: [{ key: "a", label: "A" }],
      rows: [{ a: 1 }],
    });
    assert.ok(blockToText(b).startsWith("Results\n"));
  });

  test("row: joins children with |", () => {
    const b = blocks.row({
      key: "r",
      children: [
        blocks.text({ content: "left" }),
        blocks.text({ content: "right" }),
      ],
    });
    assert.equal(blockToText(b), "left | right");
  });

  test("custom: fallbackText", () => {
    const b = blocks.custom({ key: "cu", id: "ns:w", data: {}, fallbackText: "Widget here" });
    assert.equal(blockToText(b), "Widget here");
  });

  test("custom: no fallback → default label", () => {
    const b = { key: "cu", type: "custom", version: 1, id: "ns:w", data: {}, fallbackText: "" };
    assert.equal(blockToText(b), "");
  });

  test("unknown type → safe fallback", () => {
    const b = { key: "u", type: "bogus", version: 1 };
    assert.ok(blockToText(b).includes("Unknown block"));
  });
});

describe("blocksToText — arrays", () => {
  test("joins multiple blocks with newlines", () => {
    const result = blocksToText([
      blocks.text({ content: "hello" }),
      blocks.text({ content: "world" }),
    ]);
    assert.equal(result, "hello\nworld");
  });
});

describe("blockToTextForLLM", () => {
  test("wraps in <tool-output> markers", () => {
    const b = blocks.text({ key: "msg", content: "hello" });
    const result = blockToTextForLLM(b);
    assert.ok(result.includes('<tool-output type="text" key="msg">'));
    assert.ok(result.includes("hello"));
    assert.ok(result.includes("</tool-output>"));
  });

  test("strips ANSI escape sequences", () => {
    const b = blocks.text({ key: "ansi", content: "\x1b[32mgreen\x1b[0m text" });
    const result = blockToTextForLLM(b);
    assert.ok(!result.includes("\x1b[32m"));
    assert.ok(!result.includes("\x1b[0m"));
    assert.ok(result.includes("green"));
  });

  test("strips zero-width characters", () => {
    const b = blocks.text({ key: "zw", content: "hello\u200Bworld" });
    const result = blockToTextForLLM(b);
    assert.ok(!result.includes("\u200B"));
    assert.ok(result.includes("helloworld"));
  });

  test("strips bidi override characters", () => {
    const b = blocks.text({ key: "bidi", content: "text\u202Ertl" });
    const result = blockToTextForLLM(b);
    assert.ok(!result.includes("\u202E"));
    assert.ok(result.includes("textrtl"));
  });

  test("truncates at 50KB", () => {
    const b = blocks.text({ key: "big", content: "x".repeat(60000) });
    const result = blockToTextForLLM(b);
    assert.ok(result.length <= 51000); // includes wrapper markers
    assert.ok(result.includes("(truncated)"));
  });
});

describe("blocksToTextForLLM", () => {
  test("joins multiple LLM-formatted blocks", () => {
    const result = blocksToTextForLLM([
      blocks.text({ key: "a", content: "first" }),
      blocks.statRow({ key: "s", stats: [{ label: "X", value: 1 }] }),
    ]);
    assert.ok(result.includes("first"));
    assert.ok(result.includes("X: 1"));
    assert.ok(result.split("</tool-output>").length === 3); // 2 blocks + trailing
  });
});
