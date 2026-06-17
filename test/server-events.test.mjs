/**
 * server-events.test.mjs — A3 + A4 of the v0.7.0 plan.
 *
 * The server plugin writes two new JSONL files after every relevant
 * event:
 *   - `.opencode/.session-events.jsonl` — every tool call (start/end)
 *   - `.opencode/.step-timeline.jsonl` — every session.idle evaluation
 *
 * These tests exercise the two **pure helper functions** that the
 * hooks delegate to. The helpers are exported from `dist/server.js`
 * so the test can call them directly with synthetic input/output
 * objects (no live OpenCode plugin host needed).
 *
 * The hook wiring (the actual `tool.execute.after` / `session.idle`
 * entries in the Plugin object) is a source-level grep test below.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync, existsSync, readFileSync as rf } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const serverSrc = readFileSync(join(here, "..", "src", "server.ts"), "utf-8");

// ── A3: recordToolEvent helper ──────────────────────────────────────────

test("server.ts: exports recordToolEvent(directory, input, output)", async () => {
  const { recordToolEvent } = await import("../dist/server.js");
  assert.equal(typeof recordToolEvent, "function", "recordToolEvent must be exported");
});

test("recordToolEvent: writes a tool-end event to session-events.jsonl", async () => {
  const { recordToolEvent } = await import("../dist/server.js");
  const dir = mkdtempSync(join(tmpdir(), "opengoal-rec-"));
  try {
    recordToolEvent(dir, {
      tool: "bash",
      sessionID: "ses_1",
      callID: "call_1",
      args: { command: "npm test" },
    }, {
      title: "Ran npm test",
      output: "PASS 42 tests",
      metadata: { exitCode: 0, durationMs: 2100 },
    });
    const path = join(dir, ".opencode", ".session-events.jsonl");
    assert.ok(existsSync(path), "session-events.jsonl must be created");
    const lines = rf(path, "utf-8").split("\n").filter((l) => l.length > 0);
    assert.equal(lines.length, 1, "exactly one event after one call");
    const ev = JSON.parse(lines[0]);
    assert.equal(ev.kind, "tool-end");
    assert.equal(ev.tool, "bash");
    assert.equal(ev.args.callID, "call_1", "callID is propagated via args.callID");
    assert.equal(ev.args.command, "npm test", "original tool args are preserved");
    assert.equal(ev.ok, true);
    assert.equal(ev.durationMs, 2100);
    assert.ok(typeof ev.summary === "string" && ev.summary.length > 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("recordToolEvent: failed tool records ok=false", async () => {
  const { recordToolEvent } = await import("../dist/server.js");
  const dir = mkdtempSync(join(tmpdir(), "opengoal-rec-"));
  try {
    recordToolEvent(dir, {
      tool: "bash",
      sessionID: "ses_1",
      callID: "call_2",
      args: { command: "false" },
    }, {
      title: "Ran false",
      output: "(no output)",
      metadata: { exitCode: 1, durationMs: 50 },
    });
    const path = join(dir, ".opencode", ".session-events.jsonl");
    const lines = rf(path, "utf-8").split("\n").filter((l) => l.length > 0);
    const ev = JSON.parse(lines[0]);
    assert.equal(ev.ok, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("recordToolEvent: swallows errors (best-effort — never throws)", async () => {
  const { recordToolEvent } = await import("../dist/server.js");
  // Pass a directory the helper can't write to: a file (not a dir) at the
  // path it would try to create. The helper must NOT throw.
  const dir = mkdtempSync(join(tmpdir(), "opengoal-rec-"));
  try {
    // Create .opencode as a file so mkdirSync(.opencode, { recursive: true })
    // would either fail (Windows) or succeed-but-then-fail-write (POSIX).
    // The simplest portable approach: use a path with NUL byte — fs APIs
    // throw, and the helper must swallow it.
    const badDir = "\0not-a-real-path";
    assert.doesNotThrow(() => recordToolEvent(badDir, {
      tool: "bash",
      sessionID: "s",
      callID: "c",
      args: {},
    }, { title: "t", output: "o", metadata: {} }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("recordToolEvent: hooks are wired in server.ts (source-level pin)", () => {
  // The 'tool.execute.after' hook MUST call recordToolEvent. This is
  // a source-pattern pin that catches accidental removal during a
  // refactor.
  assert.match(
    serverSrc,
    /"tool\.execute\.after"\s*:\s*async[^{]*\{[^}]*recordToolEvent/m,
    "server.ts must wire tool.execute.after to recordToolEvent",
  );
});

// ── A4: recordStepEvaluation helper ─────────────────────────────────────

test("server.ts: exports recordStepEvaluation(directory, turnIndex, evaluation)", async () => {
  const { recordStepEvaluation } = await import("../dist/server.js");
  assert.equal(typeof recordStepEvaluation, "function", "recordStepEvaluation must be exported");
});

test("detectConstraintStop: reports the time limit when elapsed minutes hit the cap", async () => {
  const { detectConstraintStop } = await import("../dist/server.js");
  const now = Date.now();
  const result = detectConstraintStop({
    version: 1,
    id: "goal-1",
    condition: "ship it",
    command: null,
    status: "active",
    createdAt: now - 31 * 60_000,
    startedAt: now - 31 * 60_000,
    completedAt: null,
    pausedAt: null,
    turnsEvaluated: 5,
    tokensUsed: 0,
    lastEvaluation: null,
    evaluationHistory: [],
    constraints: { maxTurns: 20, maxTimeMinutes: 30, maxTokens: 100000 },
    metadata: {},
  });
  assert.equal(result.exceeded, true);
  assert.match(result.reason, /Time limit reached/);
});

test("recordStepEvaluation: writes a met event to step-timeline.jsonl", async () => {
  const { recordStepEvaluation } = await import("../dist/server.js");
  const dir = mkdtempSync(join(tmpdir(), "opengoal-rec-"));
  try {
    recordStepEvaluation(dir, {
      at: 1000,
      turn: 3,
      label: "tests run",
      evaluation: { met: true, reason: "all 42 passed", blocked: false, evaluatorType: "deterministic" },
    });
    const path = join(dir, ".opencode", ".step-timeline.jsonl");
    assert.ok(existsSync(path));
    const lines = rf(path, "utf-8").split("\n").filter((l) => l.length > 0);
    assert.equal(lines.length, 1);
    const ev = JSON.parse(lines[0]);
    assert.equal(ev.turn, 3);
    assert.equal(ev.outcome, "met");
    assert.equal(ev.label, "tests run");
    assert.equal(ev.reason, "all 42 passed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("recordStepEvaluation: blocked outcome", async () => {
  const { recordStepEvaluation } = await import("../dist/server.js");
  const dir = mkdtempSync(join(tmpdir(), "opengoal-rec-"));
  try {
    recordStepEvaluation(dir, {
      at: 1000,
      turn: 1,
      label: "lint",
      evaluation: { met: false, reason: "5 errors", blocked: true, evaluatorType: "heuristic" },
    });
    const path = join(dir, ".opencode", ".step-timeline.jsonl");
    const lines = rf(path, "utf-8").split("\n").filter((l) => l.length > 0);
    const ev = JSON.parse(lines[0]);
    assert.equal(ev.outcome, "blocked");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("recordStepEvaluation: not-met (but not blocked) maps to in-progress", async () => {
  const { recordStepEvaluation } = await import("../dist/server.js");
  const dir = mkdtempSync(join(tmpdir(), "opengoal-rec-"));
  try {
    recordStepEvaluation(dir, {
      at: 1000,
      turn: 2,
      label: "build",
      evaluation: { met: false, reason: "compiling", blocked: false, evaluatorType: "heuristic" },
    });
    const path = join(dir, ".opencode", ".step-timeline.jsonl");
    const lines = rf(path, "utf-8").split("\n").filter((l) => l.length > 0);
    const ev = JSON.parse(lines[0]);
    assert.equal(ev.outcome, "in-progress");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("recordStepEvaluation: swallowed write errors (best-effort)", async () => {
  const { recordStepEvaluation } = await import("../dist/server.js");
  const badDir = "\0not-a-real-path";
  assert.doesNotThrow(() => recordStepEvaluation(badDir, {
    at: 1, turn: 0, label: "x",
    evaluation: { met: false, reason: "", blocked: false, evaluatorType: "heuristic" },
  }));
});
