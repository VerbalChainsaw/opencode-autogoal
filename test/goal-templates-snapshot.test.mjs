import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildTemplatesSnapshot,
  writeTemplatesSnapshot,
  templateLabel,
  GOAL_TEMPLATES_FILE,
} from "../dist/goal-templates-snapshot.js";

function freshDir() {
  return mkdtempSync(join(tmpdir(), "opengoal-templates-snap-"));
}

function plantUserTemplate(dir, name, tpl) {
  const goalsDir = join(dir, ".opencode", "goals");
  mkdirSync(goalsDir, { recursive: true });
  writeFileSync(join(goalsDir, `${name}.json`), JSON.stringify(tpl));
}

// ── templateLabel ───────────────────────────────────────────────────────────

test("templateLabel: derives a button label from the id", () => {
  assert.equal(templateLabel("fix-lint"), "Fix lint");
  assert.equal(templateLabel("fix-types"), "Fix types");
  assert.equal(templateLabel("pass-tests"), "Pass tests");
  assert.equal(templateLabel("my_custom_goal"), "My custom goal");
  // Degenerate ids fall back to the raw id rather than crashing.
  assert.equal(templateLabel(""), "");
});

// ── buildTemplatesSnapshot ────────────────────────────────────────────────────

test("buildTemplatesSnapshot: includes the three builtins with friendly labels", () => {
  const dir = freshDir();
  const snap = buildTemplatesSnapshot(dir);
  assert.equal(snap.version, 1);
  const byId = Object.fromEntries(snap.templates.map((t) => [t.id, t]));
  for (const id of ["fix-lint", "fix-types", "pass-tests"]) {
    assert.ok(byId[id], `expected builtin ${id}`);
    assert.equal(byId[id].builtin, true);
    assert.equal(byId[id].label, templateLabel(id));
    assert.equal(typeof byId[id].description, "string");
    assert.equal(typeof byId[id].condition, "string");
    assert.equal(byId[id].condition.length > 0, true);
  }
});

test("buildTemplatesSnapshot: surfaces a valid user template as a non-builtin button", () => {
  const dir = freshDir();
  plantUserTemplate(dir, "ship-it", {
    condition: "the deploy script exits 0 on {branch}",
    command: "npm run deploy -- --branch {branch}",
    description: "Ship the build",
    constraints: { maxTurns: 7, maxTimeMinutes: 12 },
    variables: { branch: { description: "Target branch", default: "main" } },
  });
  const snap = buildTemplatesSnapshot(dir);
  const user = snap.templates.find((t) => t.id === "ship-it");
  assert.ok(user, "user template should appear");
  assert.equal(user.builtin, false);
  assert.equal(user.label, "Ship it");
  assert.equal(user.description, "Ship the build");
  assert.equal(user.condition, "the deploy script exits 0 on {branch}");
  assert.equal(user.command, "npm run deploy -- --branch {branch}");
  assert.deepEqual(user.constraints, { maxTurns: 7, maxTimeMinutes: 12 });
  assert.deepEqual(user.variables, { branch: { description: "Target branch", default: "main" } });
});

test("buildTemplatesSnapshot: user templates override builtins with the same id", () => {
  const dir = freshDir();
  plantUserTemplate(dir, "fix-lint", {
    condition: "custom lint exits 0",
    command: "bun lint",
    description: "Custom lint",
  });
  const snap = buildTemplatesSnapshot(dir);
  const matches = snap.templates.filter((t) => t.id === "fix-lint");
  assert.equal(matches.length, 1);
  assert.equal(matches[0].builtin, false);
  assert.equal(matches[0].description, "Custom lint");
  assert.equal(matches[0].condition, "custom lint exits 0");
  assert.equal(matches[0].command, "bun lint");
});

test("buildTemplatesSnapshot: skips a corrupt user template (no condition)", () => {
  const dir = freshDir();
  plantUserTemplate(dir, "broken", { description: "no condition field" });
  const snap = buildTemplatesSnapshot(dir);
  assert.equal(snap.templates.find((t) => t.id === "broken"), undefined);
});

// ── writeTemplatesSnapshot (lazy gating) ──────────────────────────────────────

test("writeTemplatesSnapshot: does NOT create the file when there are no user templates", () => {
  const dir = freshDir();
  writeTemplatesSnapshot(dir);
  assert.equal(existsSync(join(dir, GOAL_TEMPLATES_FILE)), false);
});

test("writeTemplatesSnapshot: materializes the file when a user template exists", () => {
  const dir = freshDir();
  plantUserTemplate(dir, "ship-it", { condition: "the deploy script exits 0", description: "Ship the build" });
  writeTemplatesSnapshot(dir);
  const path = join(dir, GOAL_TEMPLATES_FILE);
  assert.ok(existsSync(path), "snapshot file should be written");
  const parsed = JSON.parse(readFileSync(path, "utf-8"));
  assert.equal(parsed.version, 1);
  assert.ok(parsed.templates.some((t) => t.id === "ship-it" && t.builtin === false));
  // Builtins ride along so the dock has the full set in one read.
  assert.ok(parsed.templates.some((t) => t.id === "pass-tests" && t.builtin === true));
});

test("writeTemplatesSnapshot: refreshes an existing file even with no user templates", () => {
  const dir = freshDir();
  const path = join(dir, GOAL_TEMPLATES_FILE);
  mkdirSync(join(dir, ".opencode"), { recursive: true });
  writeFileSync(path, JSON.stringify({ version: 1, templates: [{ id: "stale", label: "Stale", description: "", builtin: false }] }));
  writeTemplatesSnapshot(dir);
  const parsed = JSON.parse(readFileSync(path, "utf-8"));
  // The stale entry is gone; the file now reflects the actual (builtin-only) set.
  assert.equal(parsed.templates.find((t) => t.id === "stale"), undefined);
  assert.ok(parsed.templates.some((t) => t.id === "pass-tests"));
});
