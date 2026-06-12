/**
 * v0.4.2 — corrupt-state surfacing tests.
 *
 * v0.4.1 (C-2) made the readers quarantine corrupt state files
 * (rename to `<original>.corrupt.<ts>`) and return a tri-state
 * ReadResult, but every user surface still consumed the deprecated
 * null-collapsing shims — so a corrupt state file LOOKED like "no
 * goal set" in the CLI, the /goal view, the goal_status tool, and
 * the sidebar. These tests pin the v0.4.2 fix: the corrupt signal
 * reaches the user on every surface.
 *
 * Also pins C-3: the atomic-write tmp filenames carry a random
 * suffix (same-process same-ms collision fix), matching the
 * pattern templates.ts:199 already used.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  dispatchGoalCommandStructured,
  plainStatus,
  KIND_TO_EXIT,
} from "../dist/command.js";
import { listCorruptArtifacts } from "../dist/goal-state.js";
import { buildSidebarView } from "../dist/sidebar-logic.js";

const here = dirname(fileURLToPath(import.meta.url));

function freshDir() {
  return mkdtempSync(join(tmpdir(), "opengoal-v042-"));
}

/** Plant an unparseable goal-state file. */
function plantCorruptState(dir) {
  mkdirSync(join(dir, ".opencode"), { recursive: true });
  writeFileSync(join(dir, ".opencode", ".goal-state.json"), "{this is not json!");
}

function corruptArtifactsOnDisk(dir) {
  try {
    return readdirSync(join(dir, ".opencode")).filter((f) => f.includes(".corrupt."));
  } catch {
    return [];
  }
}

// ── Dispatcher: /goal view ──────────────────────────────────────────────────

test("view on corrupt state → kind corrupt-state, message names the quarantined file", () => {
  const dir = freshDir();
  try {
    plantCorruptState(dir);
    const res = dispatchGoalCommandStructured(dir, "view");
    assert.equal(res.kind, "corrupt-state");
    assert.match(res.message, /corrupt/i);
    assert.match(res.message, /\.goal-state\.json\.corrupt\.\d+/,
      "message should name the quarantined artifact so the user can find it");
    // The reader quarantined the file as a side effect.
    assert.equal(corruptArtifactsOnDisk(dir).length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("bare /goal on corrupt state → corrupt-state (same as view)", () => {
  const dir = freshDir();
  try {
    plantCorruptState(dir);
    const res = dispatchGoalCommandStructured(dir, "");
    assert.equal(res.kind, "corrupt-state");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("view AFTER quarantine → no-goal, but message still mentions the artifact", () => {
  const dir = freshDir();
  try {
    plantCorruptState(dir);
    dispatchGoalCommandStructured(dir, "view"); // first read quarantines
    const res = dispatchGoalCommandStructured(dir, "view"); // file now absent
    assert.equal(res.kind, "no-goal");
    assert.match(res.message, /quarantined|corrupt/i,
      "the durable artifact notice should survive the rename");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("view with clean empty dir → no-goal message UNCHANGED (no artifact noise)", () => {
  const dir = freshDir();
  try {
    const res = dispatchGoalCommandStructured(dir, "view");
    assert.equal(res.kind, "no-goal");
    assert.equal(res.message, 'No active goal. Set one with /goal set "<condition>".');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── Exit code contract ──────────────────────────────────────────────────────

test("KIND_TO_EXIT maps corrupt-state to 4 (new, documented exit code)", () => {
  assert.equal(KIND_TO_EXIT["corrupt-state"], 4);
});

// ── plainStatus (goal_status tool surface) ──────────────────────────────────

test("plainStatus on corrupt state mentions corruption, not 'no active goal'", () => {
  const dir = freshDir();
  try {
    plantCorruptState(dir);
    const out = plainStatus(dir);
    assert.match(out, /corrupt/i);
    assert.doesNotMatch(out, /^No active goal\. Ask to set one to start\.$/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── Sidebar ─────────────────────────────────────────────────────────────────

test("buildSidebarView on corrupt state → corrupt view, not empty-state", () => {
  const dir = freshDir();
  try {
    plantCorruptState(dir);
    const view = buildSidebarView(dir);
    assert.equal(view.hasGoal, false);
    assert.equal(view.corrupt, true);
    assert.match(view.title, /⚠/);
    assert.match(view.content, /corrupt/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("buildSidebarView on clean dir → corrupt flag absent/false (no regression)", () => {
  const dir = freshDir();
  try {
    const view = buildSidebarView(dir);
    assert.equal(view.hasGoal, false);
    assert.ok(!view.corrupt);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── listCorruptArtifacts ────────────────────────────────────────────────────

test("listCorruptArtifacts: empty dir → [], after quarantine → the artifact", () => {
  const dir = freshDir();
  try {
    assert.deepEqual(listCorruptArtifacts(dir), []);
    plantCorruptState(dir);
    dispatchGoalCommandStructured(dir, "view"); // triggers quarantine
    const arts = listCorruptArtifacts(dir);
    assert.equal(arts.length, 1);
    assert.match(arts[0], /^\.goal-state\.json\.corrupt\.\d+/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("listCorruptArtifacts: missing .opencode dir → [] (never throws)", () => {
  const dir = freshDir();
  try {
    assert.deepEqual(listCorruptArtifacts(dir), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── C-3: tmp-filename entropy (source-pattern, house style of tui-ux-fixes) ─

test("C-3: all atomic-write tmp names carry a random suffix", () => {
  const goalState = readFileSync(join(here, "..", "src", "goal-state.ts"), "utf-8");
  const goalChain = readFileSync(join(here, "..", "src", "goal-chain.ts"), "utf-8");
  const pattern = /\.tmp\.\$\{process\.pid\}\.\$\{Date\.now\(\)\}\.\$\{Math\.random\(\)/g;
  const bare = /\.tmp\.\$\{process\.pid\}\.\$\{Date\.now\(\)\}`/g;
  assert.equal((goalState.match(pattern) ?? []).length, 2,
    "both goal-state.ts tmp sites should have the random suffix");
  assert.equal((goalChain.match(pattern) ?? []).length, 1,
    "the goal-chain.ts tmp site should have the random suffix");
  assert.equal((goalState.match(bare) ?? []).length, 0, "no bare pid+Date tmp names left in goal-state.ts");
  assert.equal((goalChain.match(bare) ?? []).length, 0, "no bare pid+Date tmp names left in goal-chain.ts");
});
