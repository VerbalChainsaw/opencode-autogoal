/**
 * v0.4.0 patch regression test — D6.
 *
 * BUG (D6): When a user configures a webhook and starts a chain, the
 * webhook only fires on step 0's achievement. Steps 1, 2, ... have no
 * `metadata.webhook` because `advanceGoalChain` rebuilt each new step's
 * state via `createGoalState` (which does not copy webhook fields) and
 * only set `metadata.chainId`, `.chainStep`, `.chainTotal` — silently
 * dropping the webhook on every advance.
 *
 * FIX: The chain itself owns the webhook config (`chain.webhook`).
 * On every step-creation path (create / advance / skip / reset), the
 * chain projects its webhook onto the new step's `metadata.webhook`.
 * The `goal_webhook` tool, when the active goal is in a chain, routes
 * the user's update through `setChainWebhook` so the chain stays the
 * source of truth.
 *
 * These tests pin the fix at two levels:
 *
 *   (a) UNIT — direct state-file check after `advanceGoalChain` /
 *       `resetGoalChain` / `skipGoalChainStep`. Fast and deterministic;
 *       fails on a 3-step chain because steps 1 and 2 would have no
 *       `state.metadata.webhook`.
 *
 *   (b) E2E — full auto-loop cycle with a real `node:http` receiver.
 *       Drives the chain through step 0 → step 1 → step 2 and asserts
 *       the receiver gets TWO POSTs (one per achievement, before the
 *       auto-loop's advance). Without the fix, only ONE POST would
 *       land — the one fired before step 0's advance.
 *
 * Regression confidence: if any of `createGoalChain`, `advanceGoalChain`,
 * `resetGoalChain`, or `skipGoalChainStep` stop projecting
 * `chain.webhook` onto the new step's metadata, the unit tests fail.
 * If the projection is correct but the auto-loop's `fireWebhook` stops
 * reading from the state, the e2e test fails.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, rmSync, readFileSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "node:http";

const here = dirname(fileURLToPath(import.meta.url));
const distDir = join(here, "..", "dist");
const distServerPath = pathToFileURL(join(distDir, "server.js")).href;

const { server } = await import(distServerPath);
const {
  writeGoalStateAtomic,
} = await import("file:///" + join(distDir, "goal-state.js").replace(/\\/g, "/"));
const {
  createGoalChain, advanceGoalChain, resetGoalChain, skipGoalChainStep,
  setChainWebhook, validateGoalChain, sanitizeChainWebhook, CHAIN_FILE,
} = await import("file:///" + join(distDir, "goal-chain.js").replace(/\\/g, "/"));

// ── Test fixtures ─────────────────────────────────────────────────────────

function freshDir() {
  return mkdtempSync(join(tmpdir(), "opengoal-d6-"));
}
function cleanDir(d) {
  try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
}

function mockClient() {
  return {
    app: { log: async () => {} },
    tui: { showToast: async () => {} },
    session: {
      prompt: async () => ({ data: null }),
      messages: async () => ({ data: [] }),
    },
  };
}

async function buildPlugin(directory) {
  // Each `server()` invocation creates a fresh closure with
  // `lastEvaluationTime: 0` and `isEvaluating: false`, so successive
  // sessions.idle events on a new plugin instance bypass the
  // 5-second evaluation debounce. This is the same trick the v0.4.0
  // e2e test (c) uses for its single-pass advance.
  return await server({ client: mockClient(), directory });
}

function readStateFileRaw(dir) {
  return JSON.parse(readFileSync(join(dir, ".opencode", ".goal-state.json"), "utf-8"));
}
function readChainFileRaw(dir) {
  return JSON.parse(readFileSync(join(dir, CHAIN_FILE), "utf-8"));
}

/** Start a local HTTP receiver that records every POST it receives.
 *  Returns { url, server, received, reset, close }. The server runs on
 *  127.0.0.1:<random port> (covered by the SSRF guard unless
 *  allowLocal=true is set in the webhook config). */
function startReceiver() {
  const received = [];
  const srv = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      let parsed = null;
      try { parsed = JSON.parse(body); } catch { /* leave as text */ }
      received.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body,
        json: parsed,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
    });
  });
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const url = `http://127.0.0.1:${addr.port}/hook`;
      resolve({
        url,
        server: srv,
        received,
        reset: () => { received.length = 0; },
        close: () => new Promise((r) => srv.close(r)),
      });
    });
  });
}

async function waitForPosts(received, n = 1, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (received.length >= n) return;
    await new Promise((r) => setTimeout(r, 20));
  }
}

// ─────────────────────────────────────────────────────────────────────────
// (a) UNIT — D6 webhook projection onto each step's state
// ─────────────────────────────────────────────────────────────────────────

describe("D6 — chain step states inherit chain.webhook", () => {
  let dir;
  beforeEach(() => { dir = freshDir(); });
  afterEach(() => cleanDir(dir));

  const WEBHOOK = {
    url: "https://example.invalid/hook",
    on: ["achieved", "cleared"],
    allowLocal: false,
  };

  it("createGoalChain: webhook at chain start lands on step 0's state", () => {
    // Seed the chain with a chain-level webhook via the create opts.
    const create = createGoalChain(dir, [
      { condition: "step zero" },
      { condition: "step one" },
      { condition: "step two" },
    ], { webhook: WEBHOOK });

    assert.equal(create.ok, true);
    assert.ok(create.chain);
    assert.ok(create.chain.webhook, "chain.webhook must be set on the chain object");
    assert.equal(create.chain.webhook.url, WEBHOOK.url);

    // Step 0's state inherits the chain's webhook.
    const step0 = readStateFileRaw(dir);
    assert.equal(step0.metadata.chainStep, 0);
    assert.ok(step0.metadata.webhook,
      `step 0 state.metadata.webhook must be set (D6 fix); got: ${JSON.stringify(step0.metadata)}`);
    assert.equal(step0.metadata.webhook.url, WEBHOOK.url);
    assert.deepEqual(step0.metadata.webhook.on, WEBHOOK.on);
  });

  it("createGoalChain: 'webhook: from-state' promotes a pre-chain state webhook to the chain", () => {
    // Pre-existing workflow: set_goal → goal_webhook → chain start.
    // The user's webhook should be promoted to the chain and inherited
    // by step 0's state. We build a state file with a webhook set on
    // it (the pre-chain shape) and then start a chain with the
    // "from-state" seed.
    const presetState = {
      version: 1,
      id: "preset-id",
      condition: "pre-chain goal",
      command: null,
      verification: null,
      status: "active",
      createdAt: Date.now(),
      startedAt: Date.now(),
      completedAt: null,
      pausedAt: null,
      resumedAt: null,
      turnsEvaluated: 0,
      tokensUsed: 0,
      lastEvaluation: null,
      evaluationHistory: [],
      constraints: { maxTurns: 20, maxTimeMinutes: 30, maxTokens: 100000 },
      metadata: {
        setBy: "user",
        webhook: { ...WEBHOOK },
      },
    };
    writeGoalStateAtomic(dir, presetState);

    const create = createGoalChain(dir, [
      { condition: "first chain step" },
      { condition: "second chain step" },
    ], { webhook: "from-state" });

    assert.equal(create.ok, true);
    assert.ok(create.chain.webhook,
      `chain must inherit webhook from pre-chain state; chain: ${JSON.stringify(create.chain)}`);
    assert.equal(create.chain.webhook.url, WEBHOOK.url);
    // Step 0 state carries the same webhook.
    const step0 = readStateFileRaw(dir);
    assert.equal(step0.metadata.webhook.url, WEBHOOK.url);
  });

  it("advanceGoalChain: webhook projects onto step 1, step 2, ... (THE D6 FIX)", () => {
    const create = createGoalChain(dir, [
      { condition: "step zero" },
      { condition: "step one" },
      { condition: "step two" },
    ], { webhook: WEBHOOK });
    assert.equal(create.ok, true);

    // Advance 0 → 1.
    const adv1 = advanceGoalChain(dir);
    assert.equal(adv1.ok, true);
    const state1 = readStateFileRaw(dir);
    assert.equal(state1.metadata.chainStep, 1);
    assert.ok(state1.metadata.webhook,
      `step 1 state.metadata.webhook must be set (D6 fix); got: ${JSON.stringify(state1.metadata)}`);
    assert.equal(state1.metadata.webhook.url, WEBHOOK.url);
    assert.deepEqual(state1.metadata.webhook.on, WEBHOOK.on);

    // Advance 1 → 2.
    const adv2 = advanceGoalChain(dir);
    assert.equal(adv2.ok, true);
    const state2 = readStateFileRaw(dir);
    assert.equal(state2.metadata.chainStep, 2);
    assert.ok(state2.metadata.webhook,
      `step 2 state.metadata.webhook must be set (D6 fix); got: ${JSON.stringify(state2.metadata)}`);
    assert.equal(state2.metadata.webhook.url, WEBHOOK.url);
  });

  it("skipGoalChainStep: webhook projects onto the skipped-over step", () => {
    const create = createGoalChain(dir, [
      { condition: "step zero" },
      { condition: "step one" },
      { condition: "step two" },
    ], { webhook: WEBHOOK });
    assert.equal(create.ok, true);

    const skip = skipGoalChainStep(dir); // 0 → 1
    assert.equal(skip.ok, true);
    const state1 = readStateFileRaw(dir);
    assert.equal(state1.metadata.chainStep, 1);
    assert.ok(state1.metadata.webhook,
      `step 1 state.metadata.webhook must be set after skip; got: ${JSON.stringify(state1.metadata)}`);
    assert.equal(state1.metadata.webhook.url, WEBHOOK.url);
  });

  it("resetGoalChain: webhook projects onto the rebuilt step 0", () => {
    const create = createGoalChain(dir, [
      { condition: "step zero" },
      { condition: "step one" },
    ], { webhook: WEBHOOK });
    assert.equal(create.ok, true);

    // Advance to step 1, then reset to step 0.
    advanceGoalChain(dir);
    const reset = resetGoalChain(dir);
    assert.equal(reset.ok, true);
    const state0 = readStateFileRaw(dir);
    assert.equal(state0.metadata.chainStep, 0);
    assert.ok(state0.metadata.webhook,
      `step 0 state.metadata.webhook must be set after reset; got: ${JSON.stringify(state0.metadata)}`);
    assert.equal(state0.metadata.webhook.url, WEBHOOK.url);
  });

  it("setChainWebhook: updates chain.webhook AND re-projects onto current state", () => {
    // Start a chain WITHOUT a webhook.
    const create = createGoalChain(dir, [
      { condition: "step zero" },
      { condition: "step one" },
    ]);
    assert.equal(create.ok, true);
    assert.equal(create.chain.webhook, undefined,
      `chain should start without a webhook; got: ${JSON.stringify(create.chain.webhook)}`);

    // Add a webhook via setChainWebhook. The chain file updates AND
    // the current step's state metadata re-projects to the new value.
    const newWh = { url: "https://new.example.invalid/hook", on: ["achieved"], allowLocal: true };
    const r = setChainWebhook(dir, newWh);
    assert.equal(r.ok, true);
    assert.deepEqual(r.webhook, newWh);

    // On-disk chain file has the new webhook.
    const chainOnDisk = readChainFileRaw(dir);
    assert.equal(chainOnDisk.webhook.url, newWh.url);

    // Current step's state has the new webhook.
    const state = readStateFileRaw(dir);
    assert.ok(state.metadata.webhook,
      `state.metadata.webhook must be set after setChainWebhook; got: ${JSON.stringify(state.metadata)}`);
    assert.equal(state.metadata.webhook.url, newWh.url);

    // After advance, the new step STILL has the webhook (chain-level
    // config wins, not the per-step value from before the change).
    const adv = advanceGoalChain(dir);
    assert.equal(adv.ok, true);
    const state1 = readStateFileRaw(dir);
    assert.equal(state1.metadata.chainStep, 1);
    assert.ok(state1.metadata.webhook,
      `step 1 webhook must be the post-setChainWebhook value, not the original; got: ${JSON.stringify(state1.metadata.webhook)}`);
    assert.equal(state1.metadata.webhook.url, newWh.url);
  });

  it("setChainWebhook(null) clears the chain's webhook AND the current state", () => {
    const create = createGoalChain(dir, [
      { condition: "step zero" },
    ], { webhook: WEBHOOK });
    assert.equal(create.ok, true);

    const clr = setChainWebhook(dir, null);
    assert.equal(clr.ok, true);
    assert.equal(clr.webhook, null);

    const chainOnDisk = readChainFileRaw(dir);
    assert.equal(chainOnDisk.webhook, undefined,
      `chain.webhook should be cleared on disk; got: ${JSON.stringify(chainOnDisk.webhook)}`);

    const state = readStateFileRaw(dir);
    assert.equal(state.metadata.webhook, undefined,
      `state.metadata.webhook should be cleared; got: ${JSON.stringify(state.metadata.webhook)}`);
  });

  it("setChainWebhook: rejects malformed webhook (invalid URL, no valid 'on' statuses)", () => {
    const create = createGoalChain(dir, [{ condition: "x" }]);
    assert.equal(create.ok, true);

    // Bad URL.
    const bad1 = setChainWebhook(dir, { url: "ftp://nope/", on: ["achieved"] });
    assert.equal(bad1.ok, false);
    assert.ok(bad1.error, "should return an error message");

    // Empty 'on' list.
    const bad2 = setChainWebhook(dir, { url: "https://ok.example/", on: [] });
    assert.equal(bad2.ok, false);

    // 'on' with all invalid statuses.
    const bad3 = setChainWebhook(dir, { url: "https://ok.example/", on: ["nope", "nada"] });
    assert.equal(bad3.ok, false);

    // 'on' with at least one valid survives (the others are filtered out).
    const ok = setChainWebhook(dir, { url: "https://ok.example/", on: ["nope", "achieved"] });
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.webhook.on, ["achieved"]);
  });

  it("validateGoalChain rejects a chain file with malformed webhook", () => {
    // A poisoned .goal-chain.json with a webhook that fails
    // sanitizeChainWebhook should be rejected on read. This is the
    // trust boundary: a planted chain file cannot smuggle a malformed
    // webhook past validation.
    const poisoned = {
      version: 1,
      id: "abc",
      steps: [{ condition: "x" }],
      current: 0,
      cycles: 0,
      maxCycles: 10,
      onComplete: "stop",
      metadata: { createdAt: 1, setBy: "user" },
      webhook: { url: "ftp://not-allowed/", on: ["achieved"] },
    };
    assert.equal(validateGoalChain(poisoned), false,
      "validateGoalChain must reject a chain file with a non-http(s) webhook URL");

    // Sanity: a clean webhook passes.
    const clean = { ...poisoned, webhook: { url: "https://ok.example/", on: ["achieved"] } };
    assert.equal(validateGoalChain(clean), true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// (b) E2E — full auto-loop cycle with a real HTTP receiver
//
// Without the D6 fix, this test fails on the second auto-loop pass:
// the receiver gets exactly 1 POST (for step 0's achievement), but
// the chain advances to step 1 whose state has no metadata.webhook.
// On step 1's achievement, fireWebhook in server.ts reads the now-
// undefined webhook config and returns early — the second POST never
// lands.
//
// With the D6 fix, the chain owns the webhook config and projects it
// onto every step's state, so step 1's achievement also fires.
// ─────────────────────────────────────────────────────────────────────────

describe("D6 — 3-step chain fires webhook on every step's achievement", () => {
  let dir, receiver;
  beforeEach(async () => {
    dir = freshDir();
    receiver = await startReceiver();
  });
  afterEach(async () => {
    await receiver.close();
    cleanDir(dir);
  });

  it("steps 0 and 1 each fire one POST; step 2's state carries the webhook (would fire on next achieve)", async () => {
    // 1. 3-step chain. Each step has a shell verification that exits 0.
    //    No webhook at create time — we set it via setChainWebhook
    //    (this exercises the post-create update path).
    const create = createGoalChain(dir, [
      {
        condition: "D6 step zero",
        verification: { type: "shell", command: "node -e \"process.exit(0)\"" },
      },
      {
        condition: "D6 step one",
        verification: { type: "shell", command: "node -e \"process.exit(0)\"" },
      },
      {
        condition: "D6 step two",
        verification: { type: "shell", command: "node -e \"process.exit(0)\"" },
      },
    ]);
    assert.equal(create.ok, true);

    // 2. Set the chain-level webhook AFTER chain start. The D6 fix
    //    re-projects this onto step 0's state immediately.
    const wh = { url: receiver.url, on: ["achieved"], allowLocal: true };
    const r = setChainWebhook(dir, wh);
    assert.equal(r.ok, true, `setChainWebhook should succeed; got: ${r.error}`);

    // Sanity: step 0's state on disk has the webhook.
    const state0 = readStateFileRaw(dir);
    assert.equal(state0.metadata.webhook.url, receiver.url,
      `step 0 state should have webhook set; got: ${JSON.stringify(state0.metadata.webhook)}`);

    // 3. Drive the first auto-loop pass: step 0 verifies (exit 0),
    //    flips to "achieved", fires the webhook (POST #1), then
    //    advances to step 1. After this, state.chainStep = 1.
    receiver.reset();
    const plugin1 = await buildPlugin(dir);
    await plugin1.event({
      event: { type: "session.idle", properties: { sessionID: "d6-cycle-1" } },
    });
    await waitForPosts(receiver.received, 1);
    assert.equal(receiver.received.length, 1,
      `expected 1 POST after first advance, got ${receiver.received.length}`);
    const post1 = receiver.received[0];
    assert.equal(post1.json.status, "achieved");
    assert.equal(post1.json.condition, "D6 step zero",
      `POST #1 should be for step 0's condition; got: ${post1.json.condition}`);

    // 4. THE D6 ASSERTION: state for step 1 must carry the chain's
    //    webhook. Without the fix, this would be undefined and the
    //    second auto-loop's fireWebhook call would no-op.
    const state1 = readStateFileRaw(dir);
    assert.equal(state1.metadata.chainStep, 1,
      `chainStep should be 1 after first advance; got: ${state1.metadata.chainStep}`);
    assert.equal(state1.condition, "D6 step one");
    assert.ok(state1.metadata.webhook,
      `D6 REGRESSION: step 1 state.metadata.webhook must be set, otherwise the second auto-loop's fireWebhook returns early and step 1's achievement is silently lost. Got: ${JSON.stringify(state1.metadata)}`);
    assert.equal(state1.metadata.webhook.url, receiver.url);

    // 5. Drive the second auto-loop pass: step 1 verifies, flips to
    //    "achieved", fires the webhook (POST #2 — the one D6 protects),
    //    advances to step 2.
    const plugin2 = await buildPlugin(dir);
    await plugin2.event({
      event: { type: "session.idle", properties: { sessionID: "d6-cycle-2" } },
    });
    await waitForPosts(receiver.received, 2);
    assert.equal(receiver.received.length, 2,
      `D6 REGRESSION: expected 2 POSTs after two advances, got ${receiver.received.length}. ` +
      `If this is 1, the chain-level webhook is not projecting onto step 1's state.`);
    const post2 = receiver.received[1];
    assert.equal(post2.json.status, "achieved");
    assert.equal(post2.json.condition, "D6 step one",
      `POST #2 should be for step 1's condition; got: ${post2.json.condition}`);

    // 6. Final on-disk state: chainStep=2, condition="D6 step two",
    //    and step 2's state still carries the webhook (would fire on
    //    step 2's achievement too).
    const state2 = readStateFileRaw(dir);
    assert.equal(state2.metadata.chainStep, 2);
    assert.equal(state2.condition, "D6 step two");
    assert.ok(state2.metadata.webhook,
      `step 2 state should also carry the webhook; got: ${JSON.stringify(state2.metadata)}`);
    assert.equal(state2.metadata.webhook.url, receiver.url);
  });

  it("createGoalChain with 'webhook' opts: chain-level config fires on step 0's achievement, projects onto step 1's state", async () => {
    // 2-step chain. The webhook is passed at create time, so the
    // chain-level config is in place from the start.
    const create = createGoalChain(dir, [
      {
        condition: "D6 inline step zero",
        verification: { type: "shell", command: "node -e \"process.exit(0)\"" },
      },
      {
        condition: "D6 inline step one",
        verification: { type: "shell", command: "node -e \"process.exit(0)\"" },
      },
    ], {
      webhook: { url: receiver.url, on: ["achieved"], allowLocal: true },
    });
    assert.equal(create.ok, true);
    assert.ok(create.chain.webhook,
      `chain.webhook must be set when passed at create time; got: ${JSON.stringify(create.chain)}`);

    // First auto-loop: step 0 → achieved → POST → advance to step 1.
    receiver.reset();
    const plugin1 = await buildPlugin(dir);
    await plugin1.event({
      event: { type: "session.idle", properties: { sessionID: "d6-inline-1" } },
    });
    await waitForPosts(receiver.received, 1);
    assert.equal(receiver.received.length, 1,
      `expected 1 POST after first advance, got ${receiver.received.length}`);

    // Pin the D6 projection: step 1's state has the webhook.
    const state1 = readStateFileRaw(dir);
    assert.equal(state1.metadata.chainStep, 1);
    assert.ok(state1.metadata.webhook,
      `D6 REGRESSION: step 1 state must carry the chain-level webhook; got: ${JSON.stringify(state1.metadata)}`);
    assert.equal(state1.metadata.webhook.url, receiver.url);
  });
});
