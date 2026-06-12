/**
 * v0.4.0 Phase 2 — Richer Verification
 *
 * Test suite for the new `Verification` discriminated union (shell/http/file/
 * marker) replacing the single `command` field on the goal state. The shape
 * is defined in `specs/v0.4.0-roadmap.md` lines 176–305 and the
 * implementation lives in `src/server.ts` (evaluateGoal dispatcher at
 * lines 159–171) and `src/goal-state.ts` (the Validation rules at
 * lines 224–233 and the Verification type at lines 37–42).
 *
 * The dispatcher and the per-type evaluators (`evaluateHttp`, `evaluateFile`,
 * `evaluateByTranscript`, `evaluateDeterministic`) live inside the closed-over
 * `server` factory function in server.ts and are NOT exported. We test them
 * the only way that's safe against drift: by invoking the real `dist/server.js`
 * factory with a minimal OpenCode client mock, calling the `set_goal` tool
 * to persist a goal with a verification object, and then firing a
 * `session.idle` event to drive the auto-loop. The state file on disk is the
 * observable side effect — we read it back to see whether the evaluation
 * classified the goal as met/not-met.
 *
 * The path-traversal guard inside `evaluateFile` (server.ts:194) is the one
 * defect we found during the trace — the original `relative()`-only check
 * was bypassable on Windows when the resolved path was on a different drive
 * (e.g. `D:\sensitive\file.txt` from a C: working directory). The fix
 * augments the check with `isAbsolute()` so cross-drive paths are also
 * blocked. The regression test pins the dist build to include `isAbsolute`.
 *
 * Tests:
 *   1.  validateGoalState accepts shell/http/file/marker
 *   2.  validateGoalState rejects invalid verification shapes
 *   3.  setGoalFields stores verification object verbatim
 *   4.  Backward compat: command field still works (no verification)
 *   5.  Both set: state stores both, dispatcher picks verification
 *   6.  Shell verification: exit 0 = met, exit 1 = not met
 *   7.  HTTP verification: 200 OK = met (via local server)
 *   8.  HTTP verification: 404 with expectStatus=200 = not met
 *   9.  HTTP verification: timeout = not met, reason includes "timed out"
 *  10.  HTTP verification: connection refused = not met, handled gracefully
 *  11.  HTTP verification: expectBody regex match = met
 *  12.  HTTP verification: expectBody regex no-match = not met
 *  13.  HTTP verification: timeoutMs field is read (custom timeout works)
 *  14.  File verification: exists, file present = met
 *  15.  File verification: exists, file absent = not met
 *  16.  File verification: exists=false, file absent = met
 *  17.  File verification: exists=false, file present = not met
 *  18.  File verification: contains regex match = met
 *  19.  File verification: contains regex no-match = not met
 *  20.  File verification: path traversal blocked (`../etc/passwd`)
 *  21.  File verification: absolute path outside directory blocked
 *  22.  File verification: cross-drive path blocked (Windows regression)
 *  23.  File verification: null byte in path handled gracefully
 *  24.  File verification: ENOENT caught gracefully (contains on missing file)
 *  25.  Marker verification: GOAL_COMPLETE: in transcript = met
 *  26.  Marker verification: no marker in transcript = not met
 *  27.  set_goal tool: stores a verification object correctly
 *  28.  Dispatcher source-audit: 4 cases (shell/http/file/marker)
 *  29.  Path-traversal regression: dist build contains isAbsolute check
 *  30.  setGoal with both command and verification: verification field present
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "node:http";

import { setGoalFields, readGoalState, validateGoalState } from "../dist/goal-state.js";

const here = dirname(fileURLToPath(import.meta.url));
const distDir = join(here, "..", "dist");
const distServerPath = pathToFileURL(join(distDir, "server.js")).href;

// ── Helpers ────────────────────────────────────────────────────────────────

function freshDir() {
  return mkdtempSync(join(tmpdir(), "opengoal-verify-"));
}

/** Read the state file's on-disk JSON (the source of truth for what the
 *  auto-loop actually sees). */
function readStateFileRaw(dir) {
  return JSON.parse(readFileSync(join(dir, ".opencode", ".goal-state.json"), "utf-8"));
}

/** Build a minimal mock OpenCode client. The four surface methods used by
 *  server.ts are app.log, tui.showToast, session.prompt, and
 *  session.messages. The test asserts observable side effects by reading
 *  the state file directly, so all four can be no-ops (with optional
 *  spy hooks for verification). */
function makeMockClient(opts = {}) {
  return {
    app: { log: () => Promise.resolve() },
    tui: { showToast: () => Promise.resolve() },
    session: {
      prompt: opts.prompt ?? (() => Promise.resolve()),
      messages: opts.messages ?? (() => Promise.resolve({ data: [] })),
    },
  };
}

/** Start the server plugin factory with the mock client + directory.
 *  Returns the plugin's hook object (the `event` handler is the auto-loop
 *  entry point). The hooks object has `.tool`, `.event`, `.config`,
 *  `.command.execute.before`, `.experimental.session.compacting` — the test
 *  code accesses `.tool.set_goal.execute` and `.event` to drive the
 *  auto-loop. */
async function startServer(dir, clientOpts = {}) {
  const mod = await import(distServerPath);
  const plugin = mod.default;
  const client = makeMockClient(clientOpts);
  const server = await plugin.server({ client, directory: dir });
  return { server, client };
}

/** Drive the auto-loop by firing a session.idle event. The factory's
 *  isEvaluating / debounce fields are closed over, so we re-create the
 *  factory for each test to keep them fresh (the tests are sequential;
 *  cross-test state isn't a concern). */
async function fireIdle(hooks, sessionId = "test-session") {
  await hooks.event({
    event: { type: "session.idle", properties: { sessionID: sessionId } },
  });
}

/** Tiny HTTP server for HTTP verification tests. Responds with the
 *  configured status + body. The port is exposed via the returned URL. */
function startHttpServer({ status = 200, body = "", sleepMs = 0 } = {}) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (sleepMs > 0) setTimeout(() => endResponse(), sleepMs);
      else endResponse();
      function endResponse() {
        res.statusCode = status;
        res.setHeader("Content-Type", "text/plain");
        res.end(body);
      }
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

// ── 1. validateGoalState accepts the 4 verification shapes ──────────────

test("validateGoalState: accepts valid shell verification", () => {
  const s = {
    version: 1, id: "a", condition: "x", status: "active",
    createdAt: 1, startedAt: 1, completedAt: null, pausedAt: null, resumedAt: null,
    turnsEvaluated: 0, tokensUsed: 0, lastEvaluation: null, evaluationHistory: [],
    constraints: { maxTurns: 20, maxTimeMinutes: 30, maxTokens: 100000 },
    verification: { type: "shell", command: "npm test" },
    metadata: { setBy: "user" },
  };
  assert.equal(validateGoalState(s), true);
});

test("validateGoalState: accepts valid http verification (all optional fields)", () => {
  const s = {
    version: 1, id: "a", condition: "x", status: "active",
    createdAt: 1, startedAt: 1, completedAt: null, pausedAt: null, resumedAt: null,
    turnsEvaluated: 0, tokensUsed: 0, lastEvaluation: null, evaluationHistory: [],
    constraints: { maxTurns: 20, maxTimeMinutes: 30, maxTokens: 100000 },
    verification: { type: "http", url: "https://example.com", expectStatus: 201, expectBody: "ok", timeoutMs: 5000 },
    metadata: { setBy: "user" },
  };
  assert.equal(validateGoalState(s), true);
});

test("validateGoalState: accepts valid file verification", () => {
  const s = {
    version: 1, id: "a", condition: "x", status: "active",
    createdAt: 1, startedAt: 1, completedAt: null, pausedAt: null, resumedAt: null,
    turnsEvaluated: 0, tokensUsed: 0, lastEvaluation: null, evaluationHistory: [],
    constraints: { maxTurns: 20, maxTimeMinutes: 30, maxTokens: 100000 },
    verification: { type: "file", path: "./dist/out.js", exists: true, contains: "module.exports" },
    metadata: { setBy: "user" },
  };
  assert.equal(validateGoalState(s), true);
});

test("validateGoalState: accepts valid marker verification (no extra fields)", () => {
  const s = {
    version: 1, id: "a", condition: "x", status: "active",
    createdAt: 1, startedAt: 1, completedAt: null, pausedAt: null, resumedAt: null,
    turnsEvaluated: 0, tokensUsed: 0, lastEvaluation: null, evaluationHistory: [],
    constraints: { maxTurns: 20, maxTimeMinutes: 30, maxTokens: 100000 },
    verification: { type: "marker" },
    metadata: { setBy: "user" },
  };
  assert.equal(validateGoalState(s), true);
});

// ── 2. validateGoalState rejects invalid verification shapes ─────────────

test("validateGoalState: rejects unknown verification type", () => {
  const s = {
    version: 1, id: "a", condition: "x", status: "active",
    createdAt: 1, startedAt: 1, completedAt: null, pausedAt: null, resumedAt: null,
    turnsEvaluated: 0, tokensUsed: 0, lastEvaluation: null, evaluationHistory: [],
    constraints: { maxTurns: 20, maxTimeMinutes: 30, maxTokens: 100000 },
    verification: { type: "bogus" },
    metadata: { setBy: "user" },
  };
  assert.equal(validateGoalState(s), false);
});

test("validateGoalState: rejects shell without command", () => {
  const s = {
    version: 1, id: "a", condition: "x", status: "active",
    createdAt: 1, startedAt: 1, completedAt: null, pausedAt: null, resumedAt: null,
    turnsEvaluated: 0, tokensUsed: 0, lastEvaluation: null, evaluationHistory: [],
    constraints: { maxTurns: 20, maxTimeMinutes: 30, maxTokens: 100000 },
    verification: { type: "shell" },
    metadata: { setBy: "user" },
  };
  assert.equal(validateGoalState(s), false);
});

test("validateGoalState: rejects http without url", () => {
  const s = {
    version: 1, id: "a", condition: "x", status: "active",
    createdAt: 1, startedAt: 1, completedAt: null, pausedAt: null, resumedAt: null,
    turnsEvaluated: 0, tokensUsed: 0, lastEvaluation: null, evaluationHistory: [],
    constraints: { maxTurns: 20, maxTimeMinutes: 30, maxTokens: 100000 },
    verification: { type: "http" },
    metadata: { setBy: "user" },
  };
  assert.equal(validateGoalState(s), false);
});

test("validateGoalState: rejects file without path", () => {
  const s = {
    version: 1, id: "a", condition: "x", status: "active",
    createdAt: 1, startedAt: 1, completedAt: null, pausedAt: null, resumedAt: null,
    turnsEvaluated: 0, tokensUsed: 0, lastEvaluation: null, evaluationHistory: [],
    constraints: { maxTurns: 20, maxTimeMinutes: 30, maxTokens: 100000 },
    verification: { type: "file" },
    metadata: { setBy: "user" },
  };
  assert.equal(validateGoalState(s), false);
});

test("validateGoalState: rejects verification as array (not plain object)", () => {
  const s = {
    version: 1, id: "a", condition: "x", status: "active",
    createdAt: 1, startedAt: 1, completedAt: null, pausedAt: null, resumedAt: null,
    turnsEvaluated: 0, tokensUsed: 0, lastEvaluation: null, evaluationHistory: [],
    constraints: { maxTurns: 20, maxTimeMinutes: 30, maxTokens: 100000 },
    verification: ["shell", "npm test"],
    metadata: { setBy: "user" },
  };
  assert.equal(validateGoalState(s), false);
});

test("validateGoalState: accepts absent verification (backward compat with v0.3.0 state)", () => {
  const s = {
    version: 1, id: "a", condition: "x", status: "active",
    createdAt: 1, startedAt: 1, completedAt: null, pausedAt: null, resumedAt: null,
    turnsEvaluated: 0, tokensUsed: 0, lastEvaluation: null, evaluationHistory: [],
    constraints: { maxTurns: 20, maxTimeMinutes: 30, maxTokens: 100000 },
    command: "npm test",
    metadata: { setBy: "user" },
  };
  assert.equal(validateGoalState(s), true);
});

// ── 3. setGoalFields stores verification verbatim ───────────────────────

test("setGoalFields: stores the verification object verbatim", () => {
  const dir = freshDir();
  try {
    const v = { type: "shell", command: "echo hi" };
    const res = setGoalFields(dir, { condition: "test", verification: v });
    assert.equal(res.ok, true);
    const onDisk = readStateFileRaw(dir);
    assert.deepEqual(onDisk.verification, v);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("setGoalFields: stores null verification (explicitly off)", () => {
  const dir = freshDir();
  try {
    setGoalFields(dir, { condition: "test", verification: null });
    const onDisk = readStateFileRaw(dir);
    assert.equal(onDisk.verification, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── 4. Backward compat: command field still works ────────────────────────

test("setGoalFields: command field still works (backward compat), no verification", () => {
  const dir = freshDir();
  try {
    setGoalFields(dir, { condition: "test", command: "npm test" });
    const onDisk = readStateFileRaw(dir);
    assert.equal(onDisk.command, "npm test");
    assert.equal(onDisk.verification, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── 5. Both command and verification: both stored, dispatcher picks verification ──

test("setGoalFields: both command and verification stored (dispatcher picks verification at runtime)", () => {
  const dir = freshDir();
  try {
    setGoalFields(dir, { condition: "test", command: "old-style", verification: { type: "shell", command: "new-style" } });
    const onDisk = readStateFileRaw(dir);
    assert.equal(onDisk.command, "old-style");
    assert.deepEqual(onDisk.verification, { type: "shell", command: "new-style" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── 6. Shell verification end-to-end through the auto-loop ───────────────

test("evaluateGoal: shell verification exit 0 → goal achieved", async () => {
  const dir = freshDir();
  let server;
  try {
    ({ server } = await startServer(dir));
    await server.tool.set_goal.execute(
      { condition: "shell test", verification: { type: "shell", command: process.platform === "win32" ? "exit 0" : "true" } },
      { directory: dir }
    );
    await fireIdle(server);
    const final = readStateFileRaw(dir);
    assert.equal(final.status, "achieved", `expected achieved, got ${final.status}; reason=${final.lastEvaluation?.reason}`);
    assert.equal(final.lastEvaluation.met, true);
    assert.equal(final.lastEvaluation.evaluatorType, "deterministic");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("evaluateGoal: shell verification exit 1 → goal not met", async () => {
  const dir = freshDir();
  let server;
  try {
    ({ server } = await startServer(dir));
    await server.tool.set_goal.execute(
      { condition: "shell test fail", verification: { type: "shell", command: process.platform === "win32" ? "exit 1" : "false" } },
      { directory: dir }
    );
    await fireIdle(server);
    const final = readStateFileRaw(dir);
    assert.equal(final.status, "active", `expected active (not met), got ${final.status}; reason=${final.lastEvaluation?.reason}`);
    assert.equal(final.lastEvaluation.met, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("evaluateGoal: backward compat — `command` field alone (no verification) works", async () => {
  const dir = freshDir();
  let server;
  try {
    ({ server } = await startServer(dir));
    // Set the goal via the structured path (no verification, only command).
    // This mirrors the v0.3.0 user-typed path and exercises the
    // dispatcher fallback "if (!v) and state.command → evaluateDeterministic".
    await server.tool.set_goal.execute(
      { condition: "legacy command", command: process.platform === "win32" ? "exit 0" : "true" },
      { directory: dir }
    );
    await fireIdle(server);
    const final = readStateFileRaw(dir);
    assert.equal(final.status, "achieved", `expected achieved; reason=${final.lastEvaluation?.reason}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── 7–13. HTTP verification ──────────────────────────────────────────────

test("evaluateGoal: http 200 OK → goal achieved", async () => {
  const dir = freshDir();
  let server, http;
  try {
    ({ server } = await startServer(dir));
    http = await startHttpServer({ status: 200, body: "ok" });
    await server.tool.set_goal.execute(
      { condition: "http test", verification: { type: "http", url: http.url } },
      { directory: dir }
    );
    await fireIdle(server);
    const final = readStateFileRaw(dir);
    assert.equal(final.status, "achieved", `expected achieved; reason=${final.lastEvaluation?.reason}`);
    assert.match(final.lastEvaluation.reason, /HTTP 200 OK/);
  } finally {
    if (http) await http.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("evaluateGoal: http 404 with expectStatus=200 → goal not met", async () => {
  const dir = freshDir();
  let server, http;
  try {
    ({ server } = await startServer(dir));
    http = await startHttpServer({ status: 404, body: "missing" });
    await server.tool.set_goal.execute(
      { condition: "http 404", verification: { type: "http", url: http.url, expectStatus: 200 } },
      { directory: dir }
    );
    await fireIdle(server);
    const final = readStateFileRaw(dir);
    assert.equal(final.status, "active", `expected active (not met); reason=${final.lastEvaluation?.reason}`);
    assert.equal(final.lastEvaluation.met, false);
    assert.match(final.lastEvaluation.reason, /HTTP 404/);
  } finally {
    if (http) await http.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("evaluateGoal: http timeout (no listener, unreachable) → goal not met, handled gracefully", async () => {
  const dir = freshDir();
  let server;
  try {
    ({ server } = await startServer(dir));
    // 127.0.0.1:1 is reserved + unbound on every platform — connect refused
    // (not timeout). To exercise the timeout path we use the lowest reasonable
    // timeoutMs against an unroutable address (TEST-NET-1, RFC 5737) which
    // will hit the abort timeout reliably. The 1ms timeout against the
    // unreachable address trips the AbortSignal before the connect succeeds.
    const unreachableUrl = "http://192.0.2.1:81";
    await server.tool.set_goal.execute(
      { condition: "http timeout", verification: { type: "http", url: unreachableUrl, timeoutMs: 1 } },
      { directory: dir }
    );
    await fireIdle(server);
    const final = readStateFileRaw(dir);
    assert.equal(final.status, "active", `expected active (not met); reason=${final.lastEvaluation?.reason}`);
    assert.equal(final.lastEvaluation.met, false);
    // The HTTP catch returns "HTTP check failed: <err.message>". AbortError
    // names the timeout explicitly as "fetch failed" or "The operation was
    // aborted" or similar. The defensive check: reason must mention a known
    // failure-mode substring (timeout/abort/fail/connect).
    const reason = final.lastEvaluation.reason;
    assert.ok(
      /timed out|abort|fail|connect|undone|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH/i.test(reason),
      `expected failure reason to mention timeout/connect failure, got: ${reason}`,
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("evaluateGoal: http connection refused (closed port) → goal not met, handled gracefully", async () => {
  const dir = freshDir();
  let server;
  try {
    ({ server } = await startServer(dir));
    // Find a free port and immediately close it — connect() will be refused.
    const tmpServer = createServer();
    const port = await new Promise((resolve) =>
      tmpServer.listen(0, "127.0.0.1", () => resolve(tmpServer.address().port)),
    );
    await new Promise((r) => tmpServer.close(r));
    await server.tool.set_goal.execute(
      { condition: "http refused", verification: { type: "http", url: `http://127.0.0.1:${port}`, timeoutMs: 2000 } },
      { directory: dir }
    );
    await fireIdle(server);
    const final = readStateFileRaw(dir);
    assert.equal(final.status, "active", `expected active; reason=${final.lastEvaluation?.reason}`);
    assert.equal(final.lastEvaluation.met, false);
    assert.match(final.lastEvaluation.reason, /HTTP check failed/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("evaluateGoal: http expectBody regex match → met", async () => {
  const dir = freshDir();
  let server, http;
  try {
    ({ server } = await startServer(dir));
    http = await startHttpServer({ status: 200, body: "package status: READY" });
    await server.tool.set_goal.execute(
      { condition: "http body match", verification: { type: "http", url: http.url, expectBody: "READY" } },
      { directory: dir }
    );
    await fireIdle(server);
    const final = readStateFileRaw(dir);
    assert.equal(final.status, "achieved", `expected achieved; reason=${final.lastEvaluation?.reason}`);
  } finally {
    if (http) await http.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("evaluateGoal: http expectBody regex no-match → not met", async () => {
  const dir = freshDir();
  let server, http;
  try {
    ({ server } = await startServer(dir));
    http = await startHttpServer({ status: 200, body: "package status: NOT_READY" });
    await server.tool.set_goal.execute(
      { condition: "http body no match", verification: { type: "http", url: http.url, expectBody: "^READY$" } },
      { directory: dir }
    );
    await fireIdle(server);
    const final = readStateFileRaw(dir);
    assert.equal(final.status, "active", `expected active; reason=${final.lastEvaluation?.reason}`);
    assert.match(final.lastEvaluation.reason, /Body didn't match/);
  } finally {
    if (http) await http.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("evaluateGoal: http custom timeoutMs (50ms against slow server) → timeout path", async () => {
  const dir = freshDir();
  let server, http;
  try {
    ({ server } = await startServer(dir));
    // Server sleeps 500ms before responding. A 50ms client timeout MUST trip
    // before the server responds. This pins that the `timeoutMs` field is
    // actually read (not silently ignored or read from the wrong field).
    http = await startHttpServer({ status: 200, body: "ok", sleepMs: 500 });
    await server.tool.set_goal.execute(
      { condition: "http custom timeout", verification: { type: "http", url: http.url, timeoutMs: 50 } },
      { directory: dir }
    );
    await fireIdle(server);
    const final = readStateFileRaw(dir);
    assert.equal(final.status, "active", `expected active; reason=${final.lastEvaluation?.reason}`);
    assert.equal(final.lastEvaluation.met, false);
    // The reason should reflect an abort / timeout / failure of some kind.
    assert.match(final.lastEvaluation.reason, /HTTP check failed/);
  } finally {
    if (http) await http.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 14–24. File verification ────────────────────────────────────────────

test("evaluateGoal: file exists, file present → met", async () => {
  const dir = freshDir();
  let server;
  try {
    ({ server } = await startServer(dir));
    writeFileSync(join(dir, "present.txt"), "ok");
    await server.tool.set_goal.execute(
      { condition: "file present", verification: { type: "file", path: "./present.txt" } },
      { directory: dir }
    );
    await fireIdle(server);
    const final = readStateFileRaw(dir);
    assert.equal(final.status, "achieved", `expected achieved; reason=${final.lastEvaluation?.reason}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("evaluateGoal: file exists, file absent → not met", async () => {
  const dir = freshDir();
  let server;
  try {
    ({ server } = await startServer(dir));
    await server.tool.set_goal.execute(
      { condition: "file absent", verification: { type: "file", path: "./missing.txt" } },
      { directory: dir }
    );
    await fireIdle(server);
    const final = readStateFileRaw(dir);
    assert.equal(final.status, "active", `expected active; reason=${final.lastEvaluation?.reason}`);
    assert.match(final.lastEvaluation.reason, /File not found/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("evaluateGoal: file exists=false, file absent → met", async () => {
  const dir = freshDir();
  let server;
  try {
    ({ server } = await startServer(dir));
    await server.tool.set_goal.execute(
      { condition: "file should not exist", verification: { type: "file", path: "./nope.txt", exists: false } },
      { directory: dir }
    );
    await fireIdle(server);
    const final = readStateFileRaw(dir);
    assert.equal(final.status, "achieved", `expected achieved; reason=${final.lastEvaluation?.reason}`);
    assert.match(final.lastEvaluation.reason, /absent/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("evaluateGoal: file exists=false, file present → not met", async () => {
  const dir = freshDir();
  let server;
  try {
    ({ server } = await startServer(dir));
    writeFileSync(join(dir, "still-here.txt"), "ok");
    await server.tool.set_goal.execute(
      { condition: "file should not exist but does", verification: { type: "file", path: "./still-here.txt", exists: false } },
      { directory: dir }
    );
    await fireIdle(server);
    const final = readStateFileRaw(dir);
    assert.equal(final.status, "active", `expected active; reason=${final.lastEvaluation?.reason}`);
    assert.match(final.lastEvaluation.reason, /expected absent/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("evaluateGoal: file contains regex match → met", async () => {
  const dir = freshDir();
  let server;
  try {
    ({ server } = await startServer(dir));
    // No trailing newline so the `^...$` regex matches the full file content.
    // (A trailing \n is the typical "real" case but the regex is anchored
    // and would not match a newline-terminated body — the test pins the
    // intent of `^...$` (full match) against the actual behavior.)
    writeFileSync(join(dir, "build.txt"), "build: SUCCESS");
    await server.tool.set_goal.execute(
      { condition: "build success", verification: { type: "file", path: "./build.txt", contains: "^build: SUCCESS$" } },
      { directory: dir }
    );
    await fireIdle(server);
    const final = readStateFileRaw(dir);
    assert.equal(final.status, "achieved", `expected achieved; reason=${final.lastEvaluation?.reason}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("evaluateGoal: file contains regex no-match → not met", async () => {
  const dir = freshDir();
  let server;
  try {
    ({ server } = await startServer(dir));
    writeFileSync(join(dir, "build.txt"), "build: FAILED\n");
    await server.tool.set_goal.execute(
      { condition: "build success", verification: { type: "file", path: "./build.txt", contains: "^build: SUCCESS$" } },
      { directory: dir }
    );
    await fireIdle(server);
    const final = readStateFileRaw(dir);
    assert.equal(final.status, "active", `expected active; reason=${final.lastEvaluation?.reason}`);
    assert.match(final.lastEvaluation.reason, /Content doesn't match/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("evaluateGoal: file path traversal (../) → not met, blocked", async () => {
  const dir = freshDir();
  let server;
  try {
    ({ server } = await startServer(dir));
    await server.tool.set_goal.execute(
      { condition: "evil", verification: { type: "file", path: "../../../etc/passwd" } },
      { directory: dir }
    );
    await fireIdle(server);
    const final = readStateFileRaw(dir);
    assert.equal(final.status, "active", `expected active; reason=${final.lastEvaluation?.reason}`);
    assert.match(final.lastEvaluation.reason, /Path traversal blocked/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("evaluateGoal: file absolute path outside directory → not met, blocked", async () => {
  const dir = freshDir();
  let server;
  try {
    ({ server } = await startServer(dir));
    // The exact absolute path the spec example uses. `resolve()` normalizes
    // the input; `relative()` then sees the resolved path is outside the
    // directory and the guard blocks it.
    const isWin = process.platform === "win32";
    const absOutside = isWin ? "C:\\Windows\\System32\\drivers\\etc\\hosts" : "/etc/hosts";
    await server.tool.set_goal.execute(
      { condition: "evil abs", verification: { type: "file", path: absOutside } },
      { directory: dir }
    );
    await fireIdle(server);
    const final = readStateFileRaw(dir);
    assert.equal(final.status, "active", `expected active; reason=${final.lastEvaluation?.reason}`);
    assert.match(final.lastEvaluation.reason, /Path traversal blocked/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("evaluateGoal: file cross-drive path (Windows regression) → blocked", async () => {
  // This test pins the v0.4.0 Phase 2 hardening fix. Before the fix, the
  // guard was `relative(directory, resolved).startsWith("..")` only.
  // On Windows, `relative("C:\\proj", "D:\\sensitive\\x")` returns the
  // absolute D: path verbatim — which does NOT start with ".." — so the
  // check passed and the read happened. The fix augments with `isAbsolute`.
  if (process.platform !== "win32") {
    // POSIX `relative()` returns `../../d/x` for a different drive, which
    // DOES start with `..` and is caught by the original guard. The cross-
    // drive bypass is a Windows-only defect, so the test is a no-op on POSIX.
    return;
  }
  const dir = freshDir();
  let server;
  try {
    ({ server } = await startServer(dir));
    // Pick a drive letter that doesn't exist on the test box. Even if the
    // drive is missing, the `relative()` call still returns the absolute
    // path verbatim (the bypass is in the `relative()` semantics, not the
    // file system), so the guard trips the same way it would for a real
    // D: drive.
    const crossDrive = "Z:\\sensitive\\file.txt";
    await server.tool.set_goal.execute(
      { condition: "evil cross-drive", verification: { type: "file", path: crossDrive } },
      { directory: dir }
    );
    await fireIdle(server);
    const final = readStateFileRaw(dir);
    assert.equal(final.status, "active", `expected active; reason=${final.lastEvaluation?.reason}`);
    assert.match(final.lastEvaluation.reason, /Path traversal blocked/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("evaluateGoal: file null byte in path → handled gracefully (read fails closed)", async () => {
  const dir = freshDir();
  let server;
  try {
    ({ server } = await startServer(dir));
    // A null byte trips Node's low-level path validators in fs.existsSync /
    // fs.readFileSync with "must be a string without null bytes" — the
    // catch in evaluateFile turns that into met:false, which is the right
    // fail-closed default.
    await server.tool.set_goal.execute(
      { condition: "evil null", verification: { type: "file", path: "./subdir\u0000../etc/passwd" } },
      { directory: dir }
    );
    await fireIdle(server);
    const final = readStateFileRaw(dir);
    assert.equal(final.status, "active", `expected active; reason=${final.lastEvaluation?.reason}`);
    // Either "File check failed" (Node's null-byte rejection surfaced) or
    // "File not found" (the partial path doesn't resolve) — both are
    // safe fail-closed outcomes.
    assert.ok(
      /File check failed|File not found|Path traversal blocked/i.test(final.lastEvaluation.reason),
      `expected fail-closed reason, got: ${final.lastEvaluation.reason}`,
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("evaluateGoal: file contains check on missing file (ENOENT) → not met, caught gracefully", async () => {
  const dir = freshDir();
  let server;
  try {
    ({ server } = await startServer(dir));
    await server.tool.set_goal.execute(
      { condition: "missing with contains", verification: { type: "file", path: "./never-was.txt", contains: "anything" } },
      { directory: dir }
    );
    await fireIdle(server);
    const final = readStateFileRaw(dir);
    assert.equal(final.status, "active", `expected active; reason=${final.lastEvaluation?.reason}`);
    // The pre-existence check fires first: "File not found" (deterministic,
    // no exception path needed). The contains-regex is a second-stage check
    // that runs only on existing files.
    assert.match(final.lastEvaluation.reason, /File not found/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── 25–26. Marker verification (transcript-driven) ─────────────────────

test("evaluateGoal: marker verification — GOAL_COMPLETE in transcript → met", async () => {
  const dir = freshDir();
  let server;
  try {
    ({ server } = await startServer(dir, {
      messages: () => Promise.resolve({
        data: [{
          info: { role: "assistant" },
          parts: [{ type: "text", text: "All done.\nGOAL_COMPLETE: tests pass" }],
        }],
      }),
    }));
    await server.tool.set_goal.execute(
      { condition: "marker test", verification: { type: "marker" } },
      { directory: dir }
    );
    await fireIdle(server);
    const final = readStateFileRaw(dir);
    assert.equal(final.status, "achieved", `expected achieved; reason=${final.lastEvaluation?.reason}`);
    assert.match(final.lastEvaluation.reason, /Agent reported completion/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("evaluateGoal: marker verification — no GOAL_COMPLETE in transcript → not met", async () => {
  const dir = freshDir();
  let server;
  try {
    ({ server } = await startServer(dir, {
      messages: () => Promise.resolve({
        data: [{
          info: { role: "assistant" },
          parts: [{ type: "text", text: "Still working on it." }],
        }],
      }),
    }));
    await server.tool.set_goal.execute(
      { condition: "marker test", verification: { type: "marker" } },
      { directory: dir }
    );
    await fireIdle(server);
    const final = readStateFileRaw(dir);
    assert.equal(final.status, "active", `expected active; reason=${final.lastEvaluation?.reason}`);
    assert.match(final.lastEvaluation.reason, /No GOAL_COMPLETE signal/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── 27. set_goal tool end-to-end stores verification object ──────────────

test("set_goal tool: stores a verification object (shell, http, file, marker) correctly", async () => {
  const dir = freshDir();
  let server;
  try {
    ({ server } = await startServer(dir));
    const verifications = [
      { type: "shell", command: "echo x" },
      { type: "http", url: "https://example.com", expectStatus: 200, timeoutMs: 5000 },
      { type: "file", path: "./out", exists: true, contains: "module" },
      { type: "marker" },
    ];
    for (const v of verifications) {
      const ctx = { directory: dir };
      const r = await server.tool.set_goal.execute(
        { condition: `test ${v.type}`, verification: v },
        ctx,
      );
      assert.ok(typeof r === "string" && r.length > 0, `set_goal returned an unexpected value for ${v.type}: ${JSON.stringify(r)}`);
      const onDisk = readStateFileRaw(dir);
      assert.deepEqual(onDisk.verification, v, `verification round-trip mismatch for ${v.type}`);
      // Clear before the next iteration so set_goal doesn't report a replace.
      server.tool.clear_goal.execute({}, ctx);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── 28. Dispatcher source audit ─────────────────────────────────────────

test("evaluateGoal dispatcher: 4-case switch on v.type covers shell/http/file/marker", () => {
  // The switch is closed over inside the server factory. We can only
  // assert it exists with the right shape by reading the source file
  // and the dist (per the same pattern as server-dials.test.mjs).
  const src = readFileSync(join(here, "..", "src", "server.ts"), "utf-8");
  const dist = readFileSync(join(distDir, "server.js"), "utf-8");
  // The switch has exactly 4 cases; we don't pin the order (the JS engine
  // would catch a missing one via exhaustiveness once the verification
  // union is in scope) but we pin the case labels.
  for (const t of ["shell", "http", "file", "marker"]) {
    const re = new RegExp(`case\\s+["']${t}["']\\s*:`);
    assert.ok(re.test(src), `src/server.ts missing dispatcher case "${t}"`);
    assert.ok(re.test(dist), `dist/server.js missing dispatcher case "${t}"`);
  }
  // The default "no verification" branch is the fallback (state.command or
  // transcript-marker). Pin the v.type dispatch and the fallback.
  assert.match(src, /const v = state\.verification;/);
  assert.match(src, /if \(!v\) \{/);
});

test("evaluateGoal dispatcher: HTTP timeout reads from verification.timeoutMs with default 10_000", () => {
  const src = readFileSync(join(here, "..", "src", "server.ts"), "utf-8");
  const dist = readFileSync(join(distDir, "server.js"), "utf-8");
  // Pin the exact field name + default. The spec line 240 says
  // `verification.timeoutMs ?? 10_000` — if a future refactor reads
  // from a different field, this test fails.
  assert.match(src, /v\.timeoutMs\s*\?\?\s*10[_]?000/);
  assert.match(dist, /\.timeoutMs\s*\?\?\s*10[_]?000/);
  // AbortSignal.timeout is the timeout carrier (spec line 240).
  assert.match(src, /AbortSignal\.timeout\(/);
  assert.match(dist, /AbortSignal\.timeout\(/);
});

// ── 29. Path-traversal regression: dist contains isAbsolute check ───────

test("evaluateFile path-traversal guard: dist contains isAbsolute() check (Windows cross-drive fix)", () => {
  // Regression pin for the v0.4.0 Phase 2 hardening. The original guard
  // `relative(directory, resolved).startsWith("..")` was bypassable on
  // Windows when the resolved path was on a different drive (the
  // absolute path would come back verbatim from `relative()`). The fix
  // adds `|| isAbsolute(rel)`. This test pins the fix is present in dist.
  const dist = readFileSync(join(distDir, "server.js"), "utf-8");
  // Locate the evaluateFile function body. The function name + import of
  // node:path + relative() call are all in the same function scope.
  const evalFileStart = dist.search(/async function evaluateFile\b/);
  assert.ok(evalFileStart >= 0, "evaluateFile not found in dist/server.js");
  // Read the next ~50 lines of the function body. (The body is short —
  // import, resolve, traversal guard, existsSync, readFileSync, return.)
  const snippet = dist.slice(evalFileStart, evalFileStart + 2000);
  // The fix: the function imports `isAbsolute` from node:path, AND the
  // guard uses it (`|| isAbsolute(rel)` or equivalent).
  assert.match(snippet, /isAbsolute/, "evaluateFile must use isAbsolute() to close the Windows cross-drive traversal bypass");
  // The traversal reason text ("Path traversal blocked") is the user-visible
  // signal — must still appear.
  assert.match(snippet, /Path traversal blocked/);
});

test("evaluateFile: source contains both startsWith(\"..\") and isAbsolute in the guard", () => {
  // The same regression pin on the source file, not just the dist. If a
  // future refactor rewrites the guard and only keeps one of the two
  // checks, the cross-drive defect re-opens.
  const src = readFileSync(join(here, "..", "src", "server.ts"), "utf-8");
  const evalFileStart = src.search(/async function evaluateFile\b/);
  assert.ok(evalFileStart >= 0, "evaluateFile not found in src/server.ts");
  const snippet = src.slice(evalFileStart, evalFileStart + 2500);
  // Pin both the `startsWith("..")` substring and the `isAbsolute(rel)` call.
  // The exact source line is:
  //   if (rel.startsWith("..") || isAbsolute(rel)) {
  assert.match(snippet, /startsWith\("\.\."\)/);
  assert.match(snippet, /isAbsolute\(rel\)/);
});

// ── 30. setGoal with both command and verification ──────────────────────

test("setGoal: both command and verification stored; dispatcher picks verification at runtime", async () => {
  // We exercise this end-to-end: set with both, then trigger the auto-loop
  // and assert the result matches the `verification` semantics (not the
  // `command` semantics). If the dispatcher ever regresses to "command
  // wins", this test catches it.
  const dir = freshDir();
  let server;
  try {
    ({ server } = await startServer(dir));
    await server.tool.set_goal.execute(
      {
        condition: "both",
        // The command exits non-zero (so the command path would say
        // "not met") and the verification is shell:exit 0 (so the
        // verification path says "met"). If command wins, the goal
        // stays active; if verification wins, it becomes achieved.
        command: process.platform === "win32" ? "exit 1" : "false",
        verification: { type: "shell", command: process.platform === "win32" ? "exit 0" : "true" },
      },
      { directory: dir }
    );
    await fireIdle(server);
    const final = readStateFileRaw(dir);
    assert.equal(final.status, "achieved", `verification should win, but status is ${final.status}; reason=${final.lastEvaluation?.reason}`);
    // Both fields are preserved on disk.
    assert.equal(final.command, process.platform === "win32" ? "exit 1" : "false");
    assert.deepEqual(final.verification, { type: "shell", command: process.platform === "win32" ? "exit 0" : "true" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
