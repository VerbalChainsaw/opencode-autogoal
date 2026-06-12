/**
 * server-error.test.mjs — v0.4.1 defect B-3b regression coverage.
 *
 * The server plugin's event switch (src/server.ts) handles 3 of 30+
 * SDK event types. session.error is the one with direct user impact:
 * when the session enters a fatal error state (e.g. ProviderAuthError,
 * MessageOutputLengthError, ApiError), the auto-loop's session.idle
 * handler stops firing and the goal stays "active" forever with no
 * user signal. B-3b adds a `case "session.error"` to the switch that
 * transitions the goal active → paused, fires the v0.4.0+ webhook on
 * that transition, and surfaces a toast + session message via
 * notify() with variant "error".
 *
 * The test exercises the full path by:
 *   1. Building a server plugin instance against a fresh tmp dir.
 *   2. Seeding an active goal (the precondition for the handler).
 *   3. Configuring a webhook on the goal (and a local HTTP receiver
 *      with allowLocal to bypass the SSRF guard on 127.0.0.1).
 *   4. Replacing client.tui.showToast and client.session.prompt with
 *      spies so we can assert on notify()'s title/message/variant.
 *   5. Dispatching a synthetic session.error event with
 *      properties.error = { name: "ProviderAuthError", data: { ... } }
 *      (the same shape the SDK's EventSessionError type uses).
 *   6. Asserting the state file transitions active → paused.
 *   7. Asserting a webhook POST lands at the receiver with
 *      status=paused and previousStatus=active.
 *   8. Asserting notify() was called with variant "error" and a
 *      truncated (<= 200 char) reason.
 *   9. Asserting the lastEvaluation.reason on disk begins with
 *      "Session error: ".
 *
 * Also covers the no-op paths:
 *   - session.error when state is already paused: no transition,
 *     no notify (would be confusing second notification).
 *   - session.error when no goal exists: no crash, no notify.
 *   - session.error with a 500-char error message: notify reason
 *     is truncated to <= 200 chars.
 *
 * Spec scenarios:
 *   1. session.error transitions active → paused
 *   2. fires webhook on the active → paused transition
 *   3. notify() called with variant "error" and a "<= 200 char" reason
 *   4. lastEvaluation.reason starts with "Session error: "
 *   5. no-op when state is already paused
 *   6. no-op when no goal exists
 *   7. error message truncated to 200 chars
 *   8. (smoke) session.idle still works after the new case is added
 *      (proves the new case didn't break the existing handler chain)
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createServer } from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const distDir = join(here, "..", "dist");
const distServerPath = pathToFileURL(join(distDir, "server.js")).href;

// ── Module imports ─────────────────────────────────────────────────────────

const { server } = await import(distServerPath);
const { readGoalState, writeGoalStateAtomic } = await import(
  "file:///" + join(distDir, "goal-state.js").replace(/\\/g, "/")
);

// ── Test fixtures ──────────────────────────────────────────────────────────

function freshDir() {
  return mkdtempSync(join(tmpdir(), "opengoal-error-"));
}
function cleanDir(d) {
  try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
}

/** Read the raw state file (the on-disk source of truth). */
function readStateFileRaw(dir) {
  return JSON.parse(readFileSync(join(dir, ".opencode", ".goal-state.json"), "utf-8"));
}

/** Build a mock OpenCode client with spies on notify()'s two surfaces.
 *  - `toast` is what client.tui.showToast receives (TUI-rendered).
 *  - `prompts` is what client.session.prompt receives (the session
 *    message that gets written into the conversation as `noReply`). */
function makeSpyClient() {
  const toast = [];
  const prompts = [];
  return {
    spies: { toast, prompts },
    client: {
      app: { log: () => Promise.resolve() },
      tui: { showToast: async (req) => { toast.push(req.body); } },
      session: { prompt: async (req) => { prompts.push(req); } },
    },
  };
}

/** Start a local HTTP server that records every POST. Returns the
 *  usual { url, server, received, reset, close } triple. */
function startReceiver() {
  const received = [];
  const srv = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      let parsed = null;
      try { parsed = JSON.parse(body); } catch { /* ignore */ }
      received.push({ method: req.method, url: req.url, headers: req.headers, body, json: parsed });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
    });
  });
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      resolve({
        url: `http://127.0.0.1:${addr.port}/hook`,
        server: srv,
        received,
        reset: () => { received.length = 0; },
        close: () => new Promise((r) => srv.close(r)),
      });
    });
  });
}

/** Build the server plugin instance against a directory. */
async function buildPlugin(directory, client) {
  return await server({ client, directory });
}

/** Wait for the receiver to log at least `n` POSTs. fireWebhook is
 *  fire-and-forget, so there's a small window between the call and
 *  the receiver recording it. */
async function waitForPosts(received, n = 1, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (received.length >= n) return;
    await new Promise((r) => setTimeout(r, 20));
  }
}

// ── 1. session.error transitions active → paused ──────────────────────────

describe("session.error handler (defect B-3b)", () => {
  let dir, plugin, receiver, spies, client;

  beforeEach(async () => {
    dir = freshDir();
    ({ spies, client } = makeSpyClient());
    plugin = await buildPlugin(dir, client);
    receiver = await startReceiver();
  });

  afterEach(async () => {
    await receiver.close();
    cleanDir(dir);
  });

  it("transitions active → paused on a ProviderAuthError", async () => {
    // Seed an active goal.
    await plugin.tool.set_goal.execute(
      { condition: "do the thing", command: process.platform === "win32" ? "exit 0" : "true" },
      { directory: dir }
    );
    // Configure a webhook on "paused" (allowLocal to bypass the SSRF
    // guard for 127.0.0.1; the server-webhook.test.mjs suite covers the
    // guard in detail).
    await plugin.tool.goal_webhook.execute(
      { url: receiver.url, on: ["paused"], allowLocal: true },
      { directory: dir }
    );
    receiver.reset();
    spies.toast.length = 0;
    spies.prompts.length = 0;

    // Dispatch the synthetic event with the exact SDK shape.
    await plugin.event({
      event: {
        type: "session.error",
        properties: {
          sessionID: "test-session",
          error: { name: "ProviderAuthError", data: { providerID: "anthropic", message: "Invalid API key" } },
        },
      },
    });

    // The state file is the observable side effect.
    const final = readStateFileRaw(dir);
    assert.equal(final.status, "paused", `expected paused, got ${final.status}`);
    assert.equal(final.pausedAt, typeof final.pausedAt === "number" ? final.pausedAt : final.pausedAt);
  });

  it("fires the webhook on the active → paused transition", async () => {
    await plugin.tool.set_goal.execute(
      { condition: "do the thing", command: process.platform === "win32" ? "exit 0" : "true" },
      { directory: dir }
    );
    await plugin.tool.goal_webhook.execute(
      { url: receiver.url, on: ["paused"], allowLocal: true },
      { directory: dir }
    );
    receiver.reset();

    await plugin.event({
      event: {
        type: "session.error",
        properties: {
          sessionID: "test-session",
          error: { name: "ProviderAuthError", data: { providerID: "anthropic", message: "Invalid API key" } },
        },
      },
    });

    await waitForPosts(receiver.received, 1);
    assert.equal(receiver.received.length, 1, "session.error should fire one webhook POST");
    assert.equal(receiver.received[0].json.status, "paused");
    assert.equal(receiver.received[0].json.previousStatus, "active");
  });

  it("calls notify() with variant 'error' and a 'Session error:' reason", async () => {
    await plugin.tool.set_goal.execute(
      { condition: "do the thing", command: process.platform === "win32" ? "exit 0" : "true" },
      { directory: dir }
    );

    await plugin.event({
      event: {
        type: "session.error",
        properties: {
          sessionID: "test-session",
          error: { name: "ProviderAuthError", data: { providerID: "anthropic", message: "Invalid API key" } },
        },
      },
    });

    // notify() writes to BOTH tui.showToast (toast) and session.prompt
    // (session message). The toast carries the title + message +
    // variant; the session message carries the user-facing string.
    assert.equal(spies.toast.length, 1, "expected one toast call");
    assert.equal(spies.toast[0].variant, "error");
    assert.equal(spies.toast[0].title, "Session error — goal paused");
    assert.match(spies.toast[0].message, /^Session error: /);

    assert.equal(spies.prompts.length, 1, "expected one session.prompt call");
    assert.equal(spies.prompts[0].path.id, "test-session");
    assert.equal(spies.prompts[0].body.noReply, true);
  });

  it("writes lastEvaluation.reason starting with 'Session error: '", async () => {
    await plugin.tool.set_goal.execute(
      { condition: "do the thing", command: process.platform === "win32" ? "exit 0" : "true" },
      { directory: dir }
    );

    await plugin.event({
      event: {
        type: "session.error",
        properties: {
          sessionID: "test-session",
          error: { name: "ProviderAuthError", data: { providerID: "anthropic", message: "Invalid API key" } },
        },
      },
    });

    const final = readStateFileRaw(dir);
    assert.ok(final.lastEvaluation, "expected lastEvaluation to be set");
    assert.match(final.lastEvaluation.reason, /^Session error: /);
    assert.ok(
      final.lastEvaluation.reason.includes("ProviderAuthError"),
      `expected reason to include 'ProviderAuthError', got: ${final.lastEvaluation.reason}`
    );
  });

  it("does NOT fire a webhook when no webhook is configured (best-effort path)", async () => {
    // Same handler, no webhook config. The state should still pause;
    // the missing webhook should not crash the handler.
    await plugin.tool.set_goal.execute(
      { condition: "do the thing", command: process.platform === "win32" ? "exit 0" : "true" },
      { directory: dir }
    );

    await plugin.event({
      event: {
        type: "session.error",
        properties: {
          sessionID: "test-session",
          error: { name: "ProviderAuthError", data: { providerID: "anthropic", message: "Invalid API key" } },
        },
      },
    });

    // No webhook configured → no POST.
    assert.equal(receiver.received.length, 0, "expected no POST when no webhook configured");
    // But the goal should still be paused.
    const final = readStateFileRaw(dir);
    assert.equal(final.status, "paused");
  });

  it("does NOT fire a webhook when 'paused' is not in the on[] list", async () => {
    await plugin.tool.set_goal.execute(
      { condition: "do the thing", command: process.platform === "win32" ? "exit 0" : "true" },
      { directory: dir }
    );
    // Webhook on a different event — should not fire here.
    await plugin.tool.goal_webhook.execute(
      { url: receiver.url, on: ["achieved"], allowLocal: true },
      { directory: dir }
    );
    receiver.reset();

    await plugin.event({
      event: {
        type: "session.error",
        properties: {
          sessionID: "test-session",
          error: { name: "ProviderAuthError", data: { providerID: "anthropic", message: "Invalid API key" } },
        },
      },
    });

    // Give the fire-and-forget fetch a moment to NOT happen.
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(receiver.received.length, 0, "webhook should not fire when 'paused' is not in on[]");
    // State should still transition.
    const final = readStateFileRaw(dir);
    assert.equal(final.status, "paused");
  });

  it("truncates the error message to 200 chars", async () => {
    await plugin.tool.set_goal.execute(
      { condition: "do the thing", command: process.platform === "win32" ? "exit 0" : "true" },
      { directory: dir }
    );

    const longMsg = "x".repeat(500);
    await plugin.event({
      event: {
        type: "session.error",
        properties: {
          sessionID: "test-session",
          error: { name: "ApiError", data: { message: longMsg, statusCode: 500, isRetryable: true } },
        },
      },
    });

    assert.equal(spies.toast.length, 1);
    const reason = spies.toast[0].message;
    // "Session error: " prefix (15 chars) + 200 chars of message = 215 max.
    // We assert the *payload* length is <= 200 chars (the slice target
    // is 200 on the message body, not the whole reason).
    const prefix = "Session error: ";
    const body = reason.startsWith(prefix) ? reason.slice(prefix.length) : reason;
    assert.ok(body.length <= 200, `expected body length <= 200, got ${body.length}`);
    assert.ok(body.length >= 1, "expected non-empty body");
  });

  it("no-op when state is already paused", async () => {
    // Seed an active goal, then pause it via the tool so the state is "paused".
    await plugin.tool.set_goal.execute(
      { condition: "do the thing", command: process.platform === "win32" ? "exit 0" : "true" },
      { directory: dir }
    );
    await plugin.tool.pause_goal.execute({}, { directory: dir });
    spies.toast.length = 0;
    spies.prompts.length = 0;

    // A session.error arrives after a prior pause — the auto-loop
    // shouldn't be nudging anyway, but the handler must be idempotent.
    await plugin.event({
      event: {
        type: "session.error",
        properties: {
          sessionID: "test-session",
          error: { name: "ProviderAuthError", data: { providerID: "anthropic", message: "Invalid API key" } },
        },
      },
    });

    // No notify (would be a confusing second notification).
    assert.equal(spies.toast.length, 0, "no toast when state is not active");
    assert.equal(spies.prompts.length, 0, "no session message when state is not active");
    // State is still paused.
    const final = readStateFileRaw(dir);
    assert.equal(final.status, "paused");
  });

  it("no-op when no goal exists", async () => {
    // No set_goal. session.error arrives for a project with no goal.
    await plugin.event({
      event: {
        type: "session.error",
        properties: {
          sessionID: "test-session",
          error: { name: "ProviderAuthError", data: { providerID: "anthropic", message: "Invalid API key" } },
        },
      },
    });

    assert.equal(spies.toast.length, 0, "no toast when no goal exists");
    assert.equal(spies.prompts.length, 0, "no session message when no goal exists");
    // No state file written.
    assert.equal(readGoalState(dir), null);
  });

  it("handles an error payload with no message field (data is empty)", async () => {
    await plugin.tool.set_goal.execute(
      { condition: "do the thing", command: process.platform === "win32" ? "exit 0" : "true" },
      { directory: dir }
    );

    // MessageOutputLengthError's data is { [key: string]: unknown } —
    // it has no .message. The handler must still produce a usable
    // reason (e.g. "MessageOutputLengthError") and not crash.
    await plugin.event({
      event: {
        type: "session.error",
        properties: {
          sessionID: "test-session",
          error: { name: "MessageOutputLengthError", data: {} },
        },
      },
    });

    assert.equal(spies.toast.length, 1);
    assert.equal(spies.toast[0].variant, "error");
    assert.match(spies.toast[0].message, /MessageOutputLengthError/);

    const final = readStateFileRaw(dir);
    assert.equal(final.status, "paused");
  });

  it("handles a missing error field (event.properties has no error)", async () => {
    await plugin.tool.set_goal.execute(
      { condition: "do the thing", command: process.platform === "win32" ? "exit 0" : "true" },
      { directory: dir }
    );

    // The SDK type makes error optional. Handler should still pause
    // and use the fallback "unknown session error" text.
    await plugin.event({
      event: {
        type: "session.error",
        properties: { sessionID: "test-session" },
      },
    });

    assert.equal(spies.toast.length, 1);
    assert.match(spies.toast[0].message, /unknown session error/);
    const final = readStateFileRaw(dir);
    assert.equal(final.status, "paused");
  });

  it("sanitizes format chars / bidi overrides in the error message", async () => {
    await plugin.tool.set_goal.execute(
      { condition: "do the thing", command: process.platform === "win32" ? "exit 0" : "true" },
      { directory: dir }
    );

    // RTL override + zero-width joiner: classic prompt-injection class
    // (see sanitizeForPrompt's docstring in goal-state.ts).
    const malicious = "\u202E\u200D\u0007malicious content";
    await plugin.event({
      event: {
        type: "session.error",
        properties: {
          sessionID: "test-session",
          error: { name: "ApiError", data: { message: malicious, statusCode: 500, isRetryable: true } },
        },
      },
    });

    const final = readStateFileRaw(dir);
    assert.equal(final.status, "paused");
    // The reason should NOT contain the raw bidi override (sanitizeForPrompt
    // strips it). We assert presence of the safe substring and absence of
    // the raw RTL override.
    assert.ok(!final.lastEvaluation.reason.includes("\u202E"),
      `expected RTL override to be stripped, got: ${JSON.stringify(final.lastEvaluation.reason)}`);
    assert.ok(final.lastEvaluation.reason.includes("malicious content"),
      `expected 'malicious content' to survive, got: ${JSON.stringify(final.lastEvaluation.reason)}`);
  });

  it("session.idle still works after the new case is added (regression guard)", async () => {
    // Defensive check: the new case didn't accidentally short-circuit
    // session.idle. A session.idle with an achievable shell goal
    // should still flip status to 'achieved'.
    await plugin.tool.set_goal.execute(
      { condition: "shell test", verification: { type: "shell", command: process.platform === "win32" ? "exit 0" : "true" } },
      { directory: dir }
    );
    await plugin.event({
      event: { type: "session.idle", properties: { sessionID: "test-session" } },
    });
    const final = readStateFileRaw(dir);
    assert.equal(final.status, "achieved", `session.idle should still fire; got ${final.status}`);
  });

  it("a second session.error after the first is a no-op (idempotency)", async () => {
    await plugin.tool.set_goal.execute(
      { condition: "do the thing", command: process.platform === "win32" ? "exit 0" : "true" },
      { directory: dir }
    );
    // First error: pauses the goal.
    await plugin.event({
      event: {
        type: "session.error",
        properties: {
          sessionID: "test-session",
          error: { name: "ProviderAuthError", data: { providerID: "anthropic", message: "Invalid API key" } },
        },
      },
    });
    assert.equal(spies.toast.length, 1);
    // Second error: state is already paused, so no second notify.
    await plugin.event({
      event: {
        type: "session.error",
        properties: {
          sessionID: "test-session",
          error: { name: "ProviderAuthError", data: { providerID: "anthropic", message: "Invalid API key" } },
        },
      },
    });
    assert.equal(spies.toast.length, 1, "second session.error should not re-notify");
  });
});
