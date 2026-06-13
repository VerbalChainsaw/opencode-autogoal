/**
 * test/blocks-goal-blocks.test.mjs — goal-state → RenderBlock mapping tests.
 *
 * Verifies that buildGoalStatusBlocks and buildGoalTransitionBlocks produce
 * correctly-typed blocks with valid keys, expected cardinalities, and
 * appropriate content. Blocks pass validateBlocks as defense-in-depth.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "dist");
const { buildGoalStatusBlocks, buildGoalTransitionBlocks } =
  await import("file:///" + join(dist, "blocks", "goal-blocks.js").replace(/\\/g, "/"));
const { validateBlocks } =
  await import("file:///" + join(dist, "blocks", "validate.js").replace(/\\/g, "/"));
const { setGoalFields, readGoalState } =
  await import("file:///" + join(dist, "goal-state.js").replace(/\\/g, "/"));

function freshDir() {
  return mkdtempSync(join(tmpdir(), "opengoal-bg-"));
}

function activeGoal(dir) {
  setGoalFields(dir, { condition: "make all tests pass", command: "npm test" });
  return readGoalState(dir);
}

describe("buildGoalStatusBlocks — shape", () => {
  test("returns an array of RenderBlocks", () => {
    const dir = freshDir();
    try {
      const state = activeGoal(dir);
      const blocks = buildGoalStatusBlocks(state);
      assert.ok(Array.isArray(blocks));
      assert.ok(blocks.length >= 3); // header + stat-row + progress minimum
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("all blocks have valid keys that pass validateBlocks", () => {
    const dir = freshDir();
    try {
      const state = activeGoal(dir);
      const blocks = buildGoalStatusBlocks(state);
      const v = validateBlocks(blocks);
      assert.equal(v.valid, true, `validation errors: ${JSON.stringify(v.errors)}`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("contains a text header block with condition", () => {
    const dir = freshDir();
    try {
      const state = activeGoal(dir);
      const blocks = buildGoalStatusBlocks(state);
      const header = blocks.find((b) => b.type === "text" && b.key === "goal-header");
      assert.ok(header);
      assert.ok(header.content.includes("make all tests pass"));
      assert.ok(header.content.includes("Active"));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("contains a stat-row block with turns/time/tokens", () => {
    const dir = freshDir();
    try {
      const state = activeGoal(dir);
      const blocks = buildGoalStatusBlocks(state);
      const statsBlock = blocks.find((b) => b.type === "stat-row");
      assert.ok(statsBlock);
      assert.equal(statsBlock.stats.length, 3);
      assert.equal(statsBlock.stats[0].label, "Turns");
      assert.equal(statsBlock.stats[1].label, "Time");
      assert.equal(statsBlock.stats[2].label, "Tokens");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("contains a progress block", () => {
    const dir = freshDir();
    try {
      const state = activeGoal(dir);
      const blocks = buildGoalStatusBlocks(state);
      const progress = blocks.find((b) => b.type === "progress");
      assert.ok(progress);
      assert.ok(progress.percent >= 0);
      assert.ok(progress.percent <= 100);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("buildGoalStatusBlocks — evaluation history", () => {
  test("with 3 evaluations → list block with 3 items", () => {
    const dir = freshDir();
    try {
      const state = activeGoal(dir);
      state.evaluationHistory = [
        { met: false, reason: "3 fail", confidence: 1, timestamp: 1, evaluatorType: "deterministic" },
        { met: false, reason: "2 fail", confidence: 1, timestamp: 2, evaluatorType: "deterministic" },
        { met: true, reason: "all pass", confidence: 1, timestamp: 3, evaluatorType: "deterministic" },
      ];
      const blocks = buildGoalStatusBlocks(state);
      const evalList = blocks.find((b) => b.type === "list");
      assert.ok(evalList, "should have eval list block");
      assert.equal(evalList.items.length, 3);
      // First item should show "?" (met:false, not blocked)
      assert.ok(evalList.items[0].text.includes("·"));
      // Last item should show checkmark (met:true)
      assert.ok(evalList.items[2].text.includes("✓"));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("with no evaluations → no list block", () => {
    const dir = freshDir();
    try {
      const state = activeGoal(dir);
      state.evaluationHistory = [];
      const blocks = buildGoalStatusBlocks(state);
      const evalList = blocks.find((b) => b.type === "list");
      assert.equal(evalList, undefined);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("buildGoalStatusBlocks — steering", () => {
  test("with steering notes → list block", () => {
    const dir = freshDir();
    try {
      const state = activeGoal(dir);
      state.metadata.steering = [
        { at: 1, note: "focus flaky tests" },
        { at: 2, note: "check auth module" },
      ];
      const blocks = buildGoalStatusBlocks(state);
      const steerList = blocks.find((b) => b.type === "list" && b.key === "goal-steering");
      assert.ok(steerList);
      assert.equal(steerList.items.length, 2);
      assert.equal(steerList.items[0].text, "focus flaky tests");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("buildGoalStatusBlocks — chain", () => {
  test("with chain metadata → chain indicator text block", () => {
    const dir = freshDir();
    try {
      const state = activeGoal(dir);
      state.metadata.chainStep = 1;
      state.metadata.chainTotal = 3;
      const blocks = buildGoalStatusBlocks(state);
      const chainBlock = blocks.find((b) => b.key === "goal-chain");
      assert.ok(chainBlock);
      assert.equal(chainBlock.type, "text");
      assert.ok(chainBlock.content.length > 0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("buildGoalStatusBlocks — handoff", () => {
  test("with handoff → handoff indicator text block", () => {
    const dir = freshDir();
    try {
      const state = activeGoal(dir);
      const blocks = buildGoalStatusBlocks(state, true);
      const handoff = blocks.find((b) => b.key === "goal-handoff");
      assert.ok(handoff);
      assert.ok(handoff.content.includes("Handoff pending"));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("without handoff → no handoff block", () => {
    const dir = freshDir();
    try {
      const state = activeGoal(dir);
      const blocks = buildGoalStatusBlocks(state, false);
      const handoff = blocks.find((b) => b.key === "goal-handoff");
      assert.equal(handoff, undefined);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("buildGoalStatusBlocks — paused goal", () => {
  test("paused goal shows paused status", () => {
    const dir = freshDir();
    try {
      const state = activeGoal(dir);
      state.status = "paused";
      const blocks = buildGoalStatusBlocks(state);
      const header = blocks.find((b) => b.type === "text" && b.key === "goal-header");
      assert.ok(header.content.includes("Paused"));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("buildGoalTransitionBlocks", () => {
  test("pause transition produces blocks with action label", () => {
    const dir = freshDir();
    try {
      const state = activeGoal(dir);
      const blocks = buildGoalTransitionBlocks(state, "pause");
      const v = validateBlocks(blocks);
      assert.equal(v.valid, true);
      const header = blocks.find((b) => b.type === "text");
      assert.ok(header.content.includes("Goal paused"));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("clear transition produces blocks with action label", () => {
    const dir = freshDir();
    try {
      const state = activeGoal(dir);
      const blocks = buildGoalTransitionBlocks(state, "clear");
      const v = validateBlocks(blocks);
      assert.equal(v.valid, true);
      const header = blocks.find((b) => b.type === "text");
      assert.ok(header.content.includes("Goal cleared"));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("restart transition produces blocks with stat row", () => {
    const dir = freshDir();
    try {
      const state = activeGoal(dir);
      const blocks = buildGoalTransitionBlocks(state, "restart");
      const statsBlock = blocks.find((b) => b.type === "stat-row");
      assert.ok(statsBlock);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("unknown action uses generic label", () => {
    const dir = freshDir();
    try {
      const state = activeGoal(dir);
      const blocks = buildGoalTransitionBlocks(state, "nonexist");
      const header = blocks.find((b) => b.type === "text");
      assert.ok(header.content.includes("Goal nonexist"));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
