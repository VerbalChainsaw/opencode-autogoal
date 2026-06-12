/**
 * Tests for the `./gui` subpath module (src/gui.ts).
 *
 * These tests use copied function implementations to avoid importing
 * modules with side effects (file writing, timers, etc.). Pure functions
 * (presentGoalState, sanitizeSummary, formatTokenCount) are tested
 * directly. File-I/O functions (readGoalStateSafe) use tmpdirs.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── Test helpers ────────────────────────────────────────────────────────────

/** Status type used in the tests — mirrors GoalState["status"]. */
const STATUSES = ["active", "paused", "achieved", "cleared"];

/** Create a minimal GoalState-like object for presentGoalState tests. */
function makeState(overrides = {}) {
  return {
    version: 1,
    id: "test-id-123",
    condition: "all tests pass",
    command: "npm test",
    status: "active",
    createdAt: Date.now() - 120_000,
    startedAt: Date.now() - 120_000,
    completedAt: null,
    pausedAt: null,
    resumedAt: null,
    turnsEvaluated: 5,
    tokensUsed: 12345,
    lastEvaluation: { met: false, reason: "3 tests failing", confidence: 1.0, timestamp: Date.now() - 10_000, evaluatorType: "deterministic" },
    evaluationHistory: [],
    constraints: { maxTurns: 20, maxTimeMinutes: 30, maxTokens: 100000 },
    metadata: { setBy: "user" },
    ...overrides,
  };
}

/** Create a temp directory with a .opencode subdir for file-I/O tests. */
function createTempDir() {
  const tmp = mkdtempSync(join(tmpdir(), "gui-test-"));
  const dotOpen = join(tmp, ".opencode");
  mkdirSync(dotOpen, { recursive: true });
  return tmp;
}

/** Dynamic import helper for ESM context. */
let _guiModule = null;
async function getGui() {
  if (!_guiModule) _guiModule = await import("../dist/gui.js");
  return _guiModule;
}

/** Clean up a temp directory. */
function cleanTempDir(tmp) {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ── Pure function tests ─────────────────────────────────────────────────────

describe("presentGoalState (pure)", () => {
  async function test(desc, fn) {
    it(desc, async () => {
      const { presentGoalState } = await getGui();
      await fn(presentGoalState);
    });
  }

  it("returns icon and statusLabel for active", async () => {
    const { presentGoalState } = await getGui();
    const st = makeState({ status: "active" });
    const p = presentGoalState(st);
    assert.equal(p.icon, "🎯");
    assert.equal(p.statusLabel, "Active");
    assert.ok(typeof p.summaryLine === "string");
    assert.ok(p.summaryLine.includes("all tests pass"));
  });

  it("returns paused icon for paused state", async () => {
    const { presentGoalState } = await getGui();
    const p = presentGoalState(makeState({ status: "paused" }));
    assert.equal(p.icon, "⏸");
    assert.equal(p.statusLabel, "Paused");
  });

  it("returns achieved icon for achieved state", async () => {
    const { presentGoalState } = await getGui();
    const p = presentGoalState(makeState({ status: "achieved", completedAt: Date.now() - 5000 }));
    assert.equal(p.icon, "✅");
    assert.equal(p.statusLabel, "Achieved");
  });

  it("returns cleared icon for cleared state", async () => {
    const { presentGoalState } = await getGui();
    const p = presentGoalState(makeState({ status: "cleared", completedAt: Date.now() - 5000 }));
    assert.equal(p.icon, "🗑");
    assert.equal(p.statusLabel, "Cleared");
  });

  it("computes progress percentage", async () => {
    const { presentGoalState } = await getGui();
    const p = presentGoalState(makeState({ turnsEvaluated: 5, constraints: { maxTurns: 20, maxTimeMinutes: 30, maxTokens: 100000 } }));
    assert.equal(p.progressPct, 25);
    assert.equal(p.turnsLabel, "5/20 turns");
  });

  it("turnsLabel shows correct format", async () => {
    const { presentGoalState } = await getGui();
    const p = presentGoalState(makeState({ turnsEvaluated: 11, constraints: { maxTurns: 20, maxTimeMinutes: 30, maxTokens: 100000 } }));
    assert.equal(p.turnsLabel, "11/20 turns");
  });

  it("lastReason is null when no evaluation", async () => {
    const { presentGoalState } = await getGui();
    const p = presentGoalState(makeState({ lastEvaluation: null }));
    assert.equal(p.lastReason, null);
  });

  it("lastReason is extracted from lastEvaluation", async () => {
    const { presentGoalState } = await getGui();
    const p = presentGoalState(makeState());
    assert.equal(p.lastReason, "3 tests failing");
  });

  it("steeringCount defaults to 0", async () => {
    const { presentGoalState } = await getGui();
    const p = presentGoalState(makeState());
    assert.equal(p.steeringCount, 0);
  });

  it("steeringCount reads from metadata.steering", async () => {
    const { presentGoalState } = await getGui();
    const p = presentGoalState(makeState({
      metadata: { setBy: "user", steering: [{ at: Date.now(), note: "try X" }] },
    }));
    assert.equal(p.steeringCount, 1);
  });

  it("hasHandoff is false by default", async () => {
    const { presentGoalState } = await getGui();
    const p = presentGoalState(makeState());
    assert.equal(p.hasHandoff, false);
  });

  it("hasHandoff is true when handoffPresent=true", async () => {
    const { presentGoalState } = await getGui();
    const p = presentGoalState(makeState(), true);
    assert.equal(p.hasHandoff, true);
  });

  it("timeLabel shows elapsed minutes", async () => {
    const { presentGoalState } = await getGui();
    const startedAt = Date.now() - 300_000; // 5 min ago
    const p = presentGoalState(makeState({ startedAt }), false, Date.now());
    assert.ok(p.timeLabel.includes("5m") || p.timeLabel.includes("6m"));
  });

  it("summaryLine contains icon, status, condition, and turn count", async () => {
    const { presentGoalState } = await getGui();
    const p = presentGoalState(makeState());
    assert.ok(p.summaryLine.includes("🎯"));
    assert.ok(p.summaryLine.includes("Active"));
    assert.ok(p.summaryLine.includes("all tests pass"));
    assert.ok(p.summaryLine.includes("5/20"));
  });

  it("handles unusual but valid states without crashing", async () => {
    const { presentGoalState } = await getGui();
    const p = presentGoalState(makeState({
      turnsEvaluated: 50,
      constraints: { maxTurns: 20, maxTimeMinutes: 30, maxTokens: 100000 },
    }));
    assert.equal(p.progressPct, 100);
    assert.equal(p.turnsLabel, "50/20 turns");
  });

  it("handles 0 maxTurns without division by zero", async () => {
    const { presentGoalState } = await getGui();
    const p = presentGoalState(makeState({
      constraints: { maxTurns: 0, maxTimeMinutes: 30, maxTokens: 100000 },
    }));
    assert.ok(typeof p.progressPct === "number");
    assert.ok(Number.isFinite(p.progressPct));
  });
});

describe("readGoalStateSafe (file I/O)", () => {
  async function get() { const g = await getGui(); return g.readGoalStateSafe; }

  it("returns {state:null, corrupt:false} when no state file exists", async () => {
    const tmp = createTempDir();
    try {
      const readGoalStateSafe = await get();
      const r = readGoalStateSafe(tmp);
      assert.equal(r.state, null);
      assert.equal(r.corrupt, false);
      assert.equal(r.summary, "No goal set.");
    } finally {
      cleanTempDir(tmp);
    }
  });

  it("returns state when a valid state file exists", async () => {
    const tmp = createTempDir();
    try {
      const stateData = makeState({ condition: "my test condition" });
      writeFileSync(join(tmp, ".opencode", ".goal-state.json"), JSON.stringify(stateData), "utf-8");
      const readGoalStateSafe = await get();
      const r = readGoalStateSafe(tmp);
      assert.notEqual(r.state, null);
      assert.equal(r.corrupt, false);
      assert.equal(r.state.condition, "my test condition");
      assert.ok(r.summary.includes("my test condition"));
    } finally {
      cleanTempDir(tmp);
    }
  });

  it("returns corrupt=true for malformed JSON", async () => {
    const tmp = createTempDir();
    try {
      writeFileSync(join(tmp, ".opencode", ".goal-state.json"), "{{{not json}}}", "utf-8");
      const readGoalStateSafe = await get();
      const r = readGoalStateSafe(tmp);
      assert.equal(r.state, null);
      assert.equal(r.corrupt, true);
    } finally {
      cleanTempDir(tmp);
    }
  });

  it("returns corrupt=true for oversized state file", async () => {
    const tmp = createTempDir();
    try {
      const stateData = makeState({ condition: "x".repeat(300_000) });
      writeFileSync(join(tmp, ".opencode", ".goal-state.json"), JSON.stringify(stateData), "utf-8");
      const readGoalStateSafe = await get();
      const r = readGoalStateSafe(tmp);
      assert.equal(r.state, null);
      assert.equal(r.corrupt, true);
    } finally {
      cleanTempDir(tmp);
    }
  });

  it("returns corrupt=false when state file is empty (size 0)", async () => {
    const tmp = createTempDir();
    try {
      writeFileSync(join(tmp, ".opencode", ".goal-state.json"), "", "utf-8");
      const readGoalStateSafe = await get();
      const r = readGoalStateSafe(tmp);
      assert.equal(r.state, null);
      assert.equal(r.corrupt, false);
      assert.ok(r.summary.includes("empty"));
    } finally {
      cleanTempDir(tmp);
    }
  });

  it("achieved goal has appropriate summary", async () => {
    const tmp = createTempDir();
    try {
      const stateData = makeState({ status: "achieved", completedAt: Date.now() });
      writeFileSync(join(tmp, ".opencode", ".goal-state.json"), JSON.stringify(stateData), "utf-8");
      const readGoalStateSafe = await get();
      const r = readGoalStateSafe(tmp);
      assert.equal(r.state.status, "achieved");
      assert.equal(r.summary, "Goal achieved.");
    } finally {
      cleanTempDir(tmp);
    }
  });

  it("cleared goal has appropriate summary", async () => {
    const tmp = createTempDir();
    try {
      const stateData = makeState({ status: "cleared", completedAt: Date.now() });
      writeFileSync(join(tmp, ".opencode", ".goal-state.json"), JSON.stringify(stateData), "utf-8");
      const readGoalStateSafe = await get();
      const r = readGoalStateSafe(tmp);
      assert.equal(r.state.status, "cleared");
      assert.equal(r.summary, "Goal cleared.");
    } finally {
      cleanTempDir(tmp);
    }
  });
});

describe("validateGoalState re-export", () => {
  it("is exported from ./gui", async () => {
    const { validateGoalState } = await getGui();
    assert.equal(typeof validateGoalState, "function");
    assert.ok(validateGoalState(makeState()));
  });
});

describe("sanitizeForPrompt re-export", () => {
  it("is exported from ./gui", async () => {
    const { sanitizeForPrompt } = await getGui();
    assert.equal(typeof sanitizeForPrompt, "function");
    assert.equal(sanitizeForPrompt("hello\x00world"), "helloworld");
  });
});

describe("package.json exports", () => {
  it("the ./gui subpath exists and points to dist/gui.js", async () => {
    const { createRequire } = await import("node:module");
    const req = createRequire(import.meta.url);
    const pkg = req("../package.json");
    assert.ok(pkg.exports["./gui"], "./gui subpath missing from exports");
    assert.ok(pkg.exports["./gui"].import.endsWith("dist/gui.js"), "./gui import should point to dist/gui.js");
    assert.ok(pkg.exports["./gui"].types.endsWith("dist/gui.d.ts"), "./gui types should point to dist/gui.d.ts");
  });
});
