/**
 * Tests for goal-chain.ts — chain CRUD, advancement, edge cases.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function freshDir() { return mkdtempSync(join(tmpdir(), "opengoal-chain-")); }
function cleanDir(d) { try { rmSync(d, { recursive: true, force: true }); } catch {} }

const { createGoalChain, readGoalChain, advanceGoalChain, skipGoalChainStep, resetGoalChain, validateGoalChain } = await import("../dist/goal-chain.js");
const { readGoalState, writeGoalStateAtomic, createGoalState, DEFAULT_CONSTRAINTS } = await import("../dist/goal-state.js");

describe("createGoalChain", () => {
  it("writes chain file and sets step 0 as active goal", () => {
    const dir = freshDir();
    try {
      const res = createGoalChain(dir, [
        { condition: "step one", command: "npm run a" },
        { condition: "step two", maxTurns: 10 },
      ]);
      assert.equal(res.ok, true);
      assert.ok(res.chain);
      assert.equal(res.chain.steps.length, 2);
      assert.equal(res.chain.current, 0);
      assert.ok(res.state);
      assert.equal(res.state.metadata.chainId, res.chain.id);
      assert.equal(res.state.metadata.chainStep, 0);
      assert.equal(res.state.metadata.chainTotal, 2);

      const chain = readGoalChain(dir);
      assert.ok(chain);
      assert.equal(chain.id, res.chain.id);

      const state = readGoalState(dir);
      assert.ok(state);
      assert.equal(state.metadata.chainId, chain.id);
    } finally { cleanDir(dir); }
  });

  it("rejects empty steps array", () => {
    const dir = freshDir();
    try {
      const res = createGoalChain(dir, []);
      assert.equal(res.ok, false);
      assert.ok(res.error.includes("one step"));
    } finally { cleanDir(dir); }
  });

  it("rejects step with empty condition", () => {
    const dir = freshDir();
    try {
      const res = createGoalChain(dir, [{ condition: "" }]);
      assert.equal(res.ok, false);
    } finally { cleanDir(dir); }
  });
});

describe("advanceGoalChain", () => {
  it("auto-advances to step 1 on achievement", () => {
    const dir = freshDir();
    try {
      createGoalChain(dir, [
        { condition: "first" },
        { condition: "second" },
      ]);
      const res = advanceGoalChain(dir);
      assert.equal(res.ok, true);
      assert.ok(res.state);
      assert.equal(res.state.condition, "second");
      assert.equal(res.state.metadata.chainStep, 1);
    } finally { cleanDir(dir); }
  });

  it("completes chain after last step", () => {
    const dir = freshDir();
    try {
      createGoalChain(dir, [{ condition: "only step" }]);
      const res = advanceGoalChain(dir);
      assert.equal(res.ok, true);
      assert.equal(res.completed, true);
    } finally { cleanDir(dir); }
  });

  it("loops back to step 0 when onComplete=loop", () => {
    const dir = freshDir();
    try {
      createGoalChain(dir, [{ condition: "a" }, { condition: "b" }], { onComplete: "loop", maxCycles: 5 });
      // Advance past step 0
      let res = advanceGoalChain(dir);
      assert.equal(res.ok, true);
      assert.equal(res.state.condition, "b");
      // Advance past step 1 → loop to step 0
      res = advanceGoalChain(dir);
      assert.equal(res.ok, true);
      assert.equal(res.state.condition, "a");
      assert.equal(res.state.metadata.chainStep, 0);

      const chain = readGoalChain(dir);
      assert.ok(chain);
      assert.equal(chain.cycles, 1);
    } finally { cleanDir(dir); }
  });

  it("stops after maxCycles loops", () => {
    const dir = freshDir();
    try {
      createGoalChain(dir, [{ condition: "only" }], { onComplete: "loop", maxCycles: 2 });
      advanceGoalChain(dir); // cycle 0 complete, loop to cycle 1
      advanceGoalChain(dir); // cycle 1 complete → stopped (maxCycles=2 means 2 cycles, 0-indexed?)
      const res = advanceGoalChain(dir);
      assert.equal(res.ok, true);
      assert.equal(res.completed, true);
    } finally { cleanDir(dir); }
  });

  it("returns error when chainId doesn't match (override guard)", () => {
    const dir = freshDir();
    try {
      createGoalChain(dir, [{ condition: "first" }]);
      // Manually override the goal to break the chain link
      const st = readGoalState(dir);
      st.metadata.chainId = "manual-override";
      writeGoalStateAtomic(dir, st);
      const res = advanceGoalChain(dir);
      assert.equal(res.ok, false);
      assert.ok(res.error.includes("overridden"));
    } finally { cleanDir(dir); }
  });

  it("no chain → error", () => {
    const dir = freshDir();
    try {
      const res = advanceGoalChain(dir);
      assert.equal(res.ok, false);
    } finally { cleanDir(dir); }
  });
});

describe("skipGoalChainStep", () => {
  it("skips without achievement", () => {
    const dir = freshDir();
    try {
      createGoalChain(dir, [{ condition: "a" }, { condition: "b" }, { condition: "c" }]);
      const res = skipGoalChainStep(dir);
      assert.equal(res.ok, true);
      assert.equal(res.state.condition, "b");
    } finally { cleanDir(dir); }
  });
});

describe("resetGoalChain", () => {
  it("resets to step 0", () => {
    const dir = freshDir();
    try {
      createGoalChain(dir, [{ condition: "a" }, { condition: "b" }]);
      advanceGoalChain(dir); // now at step 1
      const res = resetGoalChain(dir);
      assert.equal(res.ok, true);
      assert.equal(res.state.condition, "a");
      assert.equal(res.state.metadata.chainStep, 0);

      const chain = readGoalChain(dir);
      assert.ok(chain);
      assert.equal(chain.current, 0);
      assert.equal(chain.cycles, 0);
    } finally { cleanDir(dir); }
  });
});

describe("validateGoalChain", () => {
  it("accepts a valid chain", () => {
    const c = { version: 1, id: "abc", steps: [{ condition: "x" }], current: 0, cycles: 0, maxCycles: 10, onComplete: "stop", metadata: { createdAt: 1, setBy: "user" } };
    assert.ok(validateGoalChain(c));
  });

  it("rejects missing steps", () => {
    assert.equal(validateGoalChain({ version: 1, id: "x", steps: [], current: 0, cycles: 0, maxCycles: 10, onComplete: "stop", metadata: { createdAt: 1, setBy: "user" } }), false);
  });

  it("rejects invalid current index", () => {
    const c = { version: 1, id: "x", steps: [{ condition: "x" }], current: 5, cycles: 0, maxCycles: 10, onComplete: "stop", metadata: { createdAt: 1, setBy: "user" } };
    assert.equal(validateGoalChain(c), false);
  });

  it("rejects step with empty condition", () => {
    const c = { version: 1, id: "x", steps: [{ condition: "" }], current: 0, cycles: 0, maxCycles: 10, onComplete: "stop", metadata: { createdAt: 1, setBy: "user" } };
    assert.equal(validateGoalChain(c), false);
  });
});

describe("sanitizeMetadata preserves chainId", () => {
  it("chainId, chainStep, chainTotal survive restartGoal", async () => {
    const { restartGoal } = await import("../dist/goal-state.js");
    const dir = freshDir();
    try {
      createGoalChain(dir, [{ condition: "restart me" }]);
      const res = restartGoal(dir);
      assert.equal(res.ok, true);
      const state = readGoalState(dir);
      assert.ok(state);
      assert.equal(state.metadata.chainId, readGoalChain(dir).id);
      assert.equal(state.metadata.chainStep, 0);
      assert.equal(state.metadata.chainTotal, 1);
    } finally { cleanDir(dir); }
  });
});
