/**
 * Tests for the TUI dashboard's pure logic layer.
 *
 * The TUI itself (`src/tui.tsx`) is JSX and runs inside the OpenCode TUI host;
 * it can't be loaded in `node --test`. The pure logic layer (`src/tui-logic.ts`)
 * can be — and these tests exercise the exact same `readDashboardState`,
 * `computeProgress`, `toggleGoal`, and `clearGoal` that `tui.tsx` calls.
 *
 * The cycle-0 review found three TUI bugs that this suite guards against:
 *   1. RangeError on a corrupt state with negative turnsEvaluated
 *   2. Silent error swallow in the old writeState
 *   3. State desync between TUI's readState and the server's readGoalState
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  readDashboardState,
  computeProgress,
  toggleGoal,
  clearGoal,
  isGoalStatePath,
  resolveSessionDirectory,
} from "../dist/tui-logic.js";
import { setGoal, readGoalState } from "../dist/goal-state.js";

function freshDir() {
  return mkdtempSync(join(tmpdir(), "opengoal-tui-"));
}

function plantCorruptState(dir, payload) {
  mkdirSync(join(dir, ".opencode"), { recursive: true });
  writeFileSync(join(dir, ".opencode", ".goal-state.json"), JSON.stringify(payload));
}

const VALID_STATE = () => ({
  version: 1, id: "test-id", condition: "ship the feature", command: null,
  status: "active",
  createdAt: 1, startedAt: 1, completedAt: null, pausedAt: null, resumedAt: null,
  turnsEvaluated: 0, tokensUsed: 0, lastEvaluation: null, evaluationHistory: [],
  constraints: { maxTurns: 20, maxTimeMinutes: 30, maxTokens: 100000 },
  metadata: { setBy: "user" },
});

// ── readDashboardState ──────────────────────────────────────────────────────

test("readDashboardState: no state file → null", () => {
  const dir = freshDir();
  try {
    assert.equal(readDashboardState(dir).state, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("readDashboardState: active goal → returns the state", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "do the thing");
    const view = readDashboardState(dir);
    assert.ok(view.state);
    assert.equal(view.state.status, "active");
    assert.equal(view.state.condition, "do the thing");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("readDashboardState: paused goal → returns the state (visible in dashboard)", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "do the thing");
    const s = readGoalState(dir);
    s.status = "paused";
    s.pausedAt = Date.now();
    writeFileSync(join(dir, ".opencode", ".goal-state.json"), JSON.stringify(s));
    const view = readDashboardState(dir);
    assert.ok(view.state);
    assert.equal(view.state.status, "paused");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("readDashboardState: achieved goal → returns the state (terminal goals stay viewable)", () => {
  const dir = freshDir();
  try {
    plantCorruptState(dir, { ...VALID_STATE(), status: "achieved" });
    // v0.5.1: terminal (achieved/cleared) goals remain viewable in the
    // dashboard/sidebar instead of blanking the moment a goal finishes.
    const view = readDashboardState(dir);
    assert.ok(view.state);
    assert.equal(view.state.status, "achieved");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("readDashboardState: cleared goal → returns the state (terminal goals stay viewable)", () => {
  const dir = freshDir();
  try {
    plantCorruptState(dir, { ...VALID_STATE(), status: "cleared" });
    const view = readDashboardState(dir);
    assert.ok(view.state);
    assert.equal(view.state.status, "cleared");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("readDashboardState: hand-crafted corrupt state (constraints:{}) → null (no crash)", () => {
  // The cycle-0 silent-infinite-loop case. The TUI's old readState would have
  // returned this object and the dashboard would have computed pct = NaN, then
  // crashed on `"█".repeat(NaN)`. The new readDashboardState calls the
  // validated readGoalState which returns null.
  const dir = freshDir();
  try {
    plantCorruptState(dir, {
      version: 1, id: "x", condition: "x", status: "active",
      createdAt: 1, startedAt: 1, completedAt: null, pausedAt: null, resumedAt: null,
      turnsEvaluated: 0, tokensUsed: 0, lastEvaluation: null, evaluationHistory: [],
      constraints: {}, metadata: { setBy: "user" },
    });
    assert.equal(readDashboardState(dir).state, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("readDashboardState: hand-crafted corrupt state (negative turnsEvaluated) → null (no crash)", () => {
  // The cycle-0 TUI crash case. The old readState would have returned this
  // and computeProgress would have produced `"█".repeat(-1)` → RangeError.
  const dir = freshDir();
  try {
    plantCorruptState(dir, { ...VALID_STATE(), turnsEvaluated: -1 });
    assert.equal(readDashboardState(dir).state, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("readDashboardState: command as array → null (server-side exec coercion bug guard)", () => {
  const dir = freshDir();
  try {
    plantCorruptState(dir, { ...VALID_STATE(), command: ["rm", "-rf", "/"] });
    assert.equal(readDashboardState(dir).state, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── computeProgress ─────────────────────────────────────────────────────────

test("computeProgress: 0% at start", () => {
  const s = { ...VALID_STATE(), turnsEvaluated: 0, constraints: { ...VALID_STATE().constraints, maxTurns: 20 } };
  const p = computeProgress(s, s.startedAt);
  assert.equal(p.pct, 0);
  assert.equal(p.filledBlocks, 0);
  assert.equal(p.bar.length, 20);
  assert.equal(p.bar, "░".repeat(20));
  assert.equal(p.elapsedMinutes, 0);
});

test("computeProgress: 100% at max", () => {
  const s = { ...VALID_STATE(), turnsEvaluated: 20, constraints: { ...VALID_STATE().constraints, maxTurns: 20 } };
  const p = computeProgress(s, s.startedAt);
  assert.equal(p.pct, 100);
  assert.equal(p.filledBlocks, 20);
  assert.equal(p.bar, "█".repeat(20));
});

test("computeProgress: 50% halfway", () => {
  const s = { ...VALID_STATE(), turnsEvaluated: 10, constraints: { ...VALID_STATE().constraints, maxTurns: 20 } };
  const p = computeProgress(s, s.startedAt);
  assert.equal(p.pct, 50);
  assert.equal(p.filledBlocks, 10);
  assert.equal(p.bar, "█".repeat(10) + "░".repeat(10));
});

test("computeProgress: clamps turnsEvaluated > maxTurns to 100%", () => {
  // Possible if maxTurns is lowered between evaluations. No crash, no negative bar.
  const s = { ...VALID_STATE(), turnsEvaluated: 999, constraints: { ...VALID_STATE().constraints, maxTurns: 20 } };
  const p = computeProgress(s, s.startedAt);
  assert.equal(p.pct, 100);
  assert.equal(p.filledBlocks, 20);
  assert.equal(p.bar, "█".repeat(20));
});

test("computeProgress: never produces a negative-length bar even with degenerate inputs (defense-in-depth)", () => {
  // Defense in depth — readDashboardState's validator already rejects this, but
  // if a future code path passes a state with extreme values, the bar must
  // still be 20 chars wide and contain no negative-repeats.
  const s = { ...VALID_STATE(), turnsEvaluated: -1000, constraints: { ...VALID_STATE().constraints, maxTurns: 1 } };
  const p = computeProgress(s, s.startedAt);
  assert.equal(p.bar.length, 20);
  assert.ok(!p.bar.includes("undefined"));
  assert.ok(!p.bar.includes("NaN"));
});

test("computeProgress: elapsed minutes is non-negative even if now < startedAt (clock skew)", () => {
  const s = { ...VALID_STATE(), startedAt: 1000, turnsEvaluated: 0, constraints: { ...VALID_STATE().constraints, maxTurns: 20 } };
  // `now` < `startedAt` shouldn't happen in production (NTP clock went backward).
  // The dashboard should still render — clamped at 0.
  const p = computeProgress(s, 500);
  assert.equal(p.elapsedMinutes, 0);
});

// ── toggleGoal / clearGoal ──────────────────────────────────────────────────

test("toggleGoal: active → paused, returns ok with newStatus=paused", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "do the thing");
    const res = toggleGoal(dir);
    assert.equal(res.ok, true);
    if (res.ok) assert.equal(res.newStatus, "paused");
    assert.equal(readGoalState(dir).status, "paused");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("toggleGoal: paused → active, returns ok with newStatus=active", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "do the thing");
    toggleGoal(dir); // active → paused
    const res = toggleGoal(dir); // paused → active
    assert.equal(res.ok, true);
    if (res.ok) assert.equal(res.newStatus, "active");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("toggleGoal: no state file → { ok: false, reason: no-goal } (not a silent success toast)", () => {
  const dir = freshDir();
  try {
    const res = toggleGoal(dir);
    assert.deepEqual(res, { ok: false, reason: "no-goal" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("toggleGoal: achieved goal → { ok: false, reason: no-goal } (terminal state)", () => {
  const dir = freshDir();
  try {
    plantCorruptState(dir, { ...VALID_STATE(), status: "achieved" });
    const res = toggleGoal(dir);
    assert.equal(res.ok, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("clearGoal: active → cleared, returns ok", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "do the thing");
    const res = clearGoal(dir);
    assert.equal(res.ok, true);
    const s = readGoalState(dir);
    assert.equal(s.status, "cleared");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("clearGoal: no state file → { ok: false, reason: no-goal }", () => {
  const dir = freshDir();
  try {
    const res = clearGoal(dir);
    assert.deepEqual(res, { ok: false, reason: "no-goal" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── Cross-validation: TUI and server read the same state ────────────────────
// Cycle-0 finding #10: the TUI's own readState could diverge from the
// server's readGoalState (a corrupt state that one accepted and the other
// rejected). The new design has the TUI call the SAME readGoalState. This
// test asserts the two are in lockstep: hand-craft a state, observe the
// TUI's readDashboardState and the server's readGoalState agree.

test("TUI and server agree on which states are valid (no readState drift)", () => {
  const dir = freshDir();
  try {
    // A state the TUI's old readState would have accepted but the server's
    // readGoalState would have rejected: status is a typo. The new design
    // shares readGoalState between them, so they MUST agree.
    plantCorruptState(dir, { ...VALID_STATE(), status: "achieve" });
    const tui = readDashboardState(dir).state;
    const server = readGoalState(dir);
    assert.equal(tui, null);
    assert.equal(server, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── isGoalStatePath ─────────────────────────────────────────────────────────
// The file-watcher predicate. Used by the dashboard's `useGoalState` hook to
// filter host-emitted `file.watcher.updated` events to only our state file.
// A regression here would either:
//   - silently stop the dashboard from refreshing (false negatives), or
//   - fire on unrelated files and thrash the renderer (false positives).
// The predicate is `path.endsWith(".goal-state.json")`.

test("isGoalStatePath: bare filename → true", () => {
  assert.equal(isGoalStatePath(".goal-state.json"), true);
});

test("isGoalStatePath: full absolute path → true", () => {
  assert.equal(isGoalStatePath("/home/user/project/.opencode/.goal-state.json"), true);
});

test("isGoalStatePath: Windows path → true", () => {
  assert.equal(isGoalStatePath("C:\\Users\\zerop\\project\\.opencode\\.goal-state.json"), true);
});

test("isGoalStatePath: prefix in the middle → true (suffix match, not equality)", () => {
  // Pin the current behavior: endsWith, not ===. A refactor to strict
  // equality would break the file-watcher's filter (the host sends the
  // full path, not just the basename).
  assert.equal(isGoalStatePath("/tmp/attacker.goal-state.json"), true);
  assert.equal(isGoalStatePath("prefix.goal-state.json"), true);
});

test("isGoalStatePath: similar-but-wrong filenames → false", () => {
  assert.equal(isGoalStatePath(".goal-state.json.bak"), false);
  assert.equal(isGoalStatePath(".goal-state-json"), false);
  assert.equal(isGoalStatePath(".goal-state.jsonx"), false);
  assert.equal(isGoalStatePath(""), false);
});

test("isGoalStatePath: non-string input → false (defense-in-depth)", () => {
  assert.equal(isGoalStatePath(null), false);
  assert.equal(isGoalStatePath(undefined), false);
  assert.equal(isGoalStatePath(42), false);
  assert.equal(isGoalStatePath({}), false);
});

// ── resolveSessionDirectory ────────────────────────────────────────────────
// Per-workspace directory resolution. The TUI's `useGoalState` does NOT
// currently use this — it reads `api.state.path.directory` directly. This
// is a known limitation: in multi-workspace OpenCode, the TUI shows the
// global default's goal state, not the per-session goal. The function
// exists for future use; the doc-comment in tui-logic.ts is the contract.

test("resolveSessionDirectory: undefined session → default", () => {
  assert.equal(resolveSessionDirectory(undefined, "/default"), "/default");
});

test("resolveSessionDirectory: null session → default", () => {
  assert.equal(resolveSessionDirectory(null, "/default"), "/default");
});

test("resolveSessionDirectory: session with explicit directory → session", () => {
  assert.equal(resolveSessionDirectory({ directory: "/x" }, "/default"), "/x");
});

test("resolveSessionDirectory: session with empty string directory → default (falsy)", () => {
  // `||` coerces empty string to the default. Pin this — a refactor to
  // `??` would let an empty-string session directory through.
  assert.equal(resolveSessionDirectory({ directory: "" }, "/default"), "/default");
});

test("resolveSessionDirectory: session with no directory field → default", () => {
  assert.equal(resolveSessionDirectory({}, "/default"), "/default");
});

// TUI does NOT currently use resolveSessionDirectory (known limitation).
// Pin the design: the dashboard reads `api.state.path.directory` directly.
test("TUI uses global directory, not resolveSessionDirectory (known limitation)", () => {
  const here = import.meta.url;
  // Source-pattern test: tui.tsx reads api.state.path.directory, not
  // resolveSessionDirectory. A future maintainer wiring multi-workspace
  // support should update this test alongside.
  const tuiSrc = readFileSync(
    join(dirname(fileURLToPath(here)), "..", "src", "tui.tsx"),
    "utf-8",
  );
  assert.match(tuiSrc, /api\.state\.path\.directory/);
  assert.equal(
    tuiSrc.includes("resolveSessionDirectory"),
    false,
    "tui.tsx should NOT import resolveSessionDirectory; that's the multi-workspace TODO",
  );
});
