/**
 * templates-view.test.mjs — A5 of the v0.7.0 plan.
 *
 * `discoverTemplates` already exists in `src/templates.ts` and is
 * imported by the CLI's `template list` command. The v0.7.0 control
 * center needs a UI-friendly variant: builtins first, user
 * templates second, both sorted alphabetically. The wrapper lives
 * in `src/templates-view.ts` so the sort/ordering policy is in one
 * place (and testable) instead of inline in the TUI shell.
 *
 * The existing `template list` CLI behavior is the source of truth
 * for "what's discoverable"; the wrapper just re-orders.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { discoverTemplatesForUi } from "../dist/templates-view.js";

function freshDir() {
  return mkdtempSync(join(tmpdir(), "opengoal-templates-view-"));
}

// ── no templates available ──────────────────────────────────────────────

test("discoverTemplatesForUi: returns only builtins when no user templates dir", () => {
  const dir = freshDir();
  try {
    const out = discoverTemplatesForUi(dir);
    // All entries must be marked builtin=true (no user dir exists).
    assert.ok(out.length > 0, "should have at least the built-in templates");
    for (const t of out) {
      assert.equal(t.builtin, true, `expected all builtin when no user dir, got: ${t.name}`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── user templates override ordering ────────────────────────────────────

test("discoverTemplatesForUi: builtins come before user templates", () => {
  const dir = freshDir();
  try {
    mkdirSync(join(dir, ".opencode", "goals"), { recursive: true });
    writeFileSync(join(dir, ".opencode", "goals", "zebra.json"), JSON.stringify({
      description: "zebra user template",
      condition: "zebra condition",
    }));
    writeFileSync(join(dir, ".opencode", "goals", "alpha.json"), JSON.stringify({
      description: "alpha user template",
      condition: "alpha condition",
    }));
    const out = discoverTemplatesForUi(dir);
    // The first batch is all builtins (sorted), then all user templates (sorted).
    const firstUserIdx = out.findIndex((t) => !t.builtin);
    assert.ok(firstUserIdx > 0, "builtins should come before user templates");
    // Everything before firstUserIdx is builtin; everything from there is user.
    for (let i = 0; i < firstUserIdx; i++) {
      assert.equal(out[i].builtin, true, `index ${i} (${out[i].name}) should be builtin`);
    }
    for (let i = firstUserIdx; i < out.length; i++) {
      assert.equal(out[i].builtin, false, `index ${i} (${out[i].name}) should be user`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("discoverTemplatesForUi: user templates are sorted alphabetically by name", () => {
  const dir = freshDir();
  try {
    mkdirSync(join(dir, ".opencode", "goals"), { recursive: true });
    writeFileSync(join(dir, ".opencode", "goals", "zebra.json"), JSON.stringify({ description: "z", condition: "z" }));
    writeFileSync(join(dir, ".opencode", "goals", "alpha.json"), JSON.stringify({ description: "a", condition: "a" }));
    writeFileSync(join(dir, ".opencode", "goals", "mango.json"), JSON.stringify({ description: "m", condition: "m" }));
    const out = discoverTemplatesForUi(dir);
    const userOnly = out.filter((t) => !t.builtin);
    assert.deepEqual(userOnly.map((t) => t.name), ["alpha", "mango", "zebra"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("discoverTemplatesForUi: builtins are sorted alphabetically by name", () => {
  const dir = freshDir();
  try {
    const out = discoverTemplatesForUi(dir);
    const builtinOnly = out.filter((t) => t.builtin);
    const names = builtinOnly.map((t) => t.name);
    const sorted = [...names].sort();
    assert.deepEqual(names, sorted, `builtins not sorted: ${names.join(", ")}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("discoverTemplatesForUi: invalid user templates are silently skipped", () => {
  const dir = freshDir();
  try {
    mkdirSync(join(dir, ".opencode", "goals"), { recursive: true });
    // Missing condition (required field)
    writeFileSync(join(dir, ".opencode", "goals", "broken.json"), JSON.stringify({ description: "no condition" }));
    // Valid
    writeFileSync(join(dir, ".opencode", "goals", "good.json"), JSON.stringify({ description: "ok", condition: "ok" }));
    // Garbage JSON
    writeFileSync(join(dir, ".opencode", "goals", "garbage.json"), "{not valid json");
    const out = discoverTemplatesForUi(dir);
    const userOnly = out.filter((t) => !t.builtin);
    assert.deepEqual(userOnly.map((t) => t.name), ["good"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("discoverTemplatesForUi: returns TemplateSummary shape (name, description, builtin, source)", () => {
  const dir = freshDir();
  try {
    const out = discoverTemplatesForUi(dir);
    assert.ok(out.length > 0);
    const t = out[0];
    assert.equal(typeof t.name, "string");
    assert.equal(typeof t.description, "string");
    assert.equal(typeof t.builtin, "boolean");
    // v0.7.0 — the source field tells the TUI renderer whether to render
    // a "builtin" badge. For builtins, source = "builtin". For user
    // templates, source = "user".
    assert.ok(t.source === "builtin" || t.source === "user");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
