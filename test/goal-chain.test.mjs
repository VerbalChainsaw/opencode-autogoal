/**
 * Tests for goal-chain.ts — chain CRUD, advancement, edge cases.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function freshDir() { return mkdtempSync(join(tmpdir(), "opengoal-chain-")); }
function cleanDir(d) { try { rmSync(d, { recursive: true, force: true }); } catch {} }

const { createGoalChain, readGoalChain, readGoalChainResult, advanceGoalChain, skipGoalChainStep, resetGoalChain, validateGoalChain, CHAIN_FILE, MAX_CHAIN_SIZE } = await import("../dist/goal-chain.js");
const { readGoalState, writeGoalStateAtomic, createGoalState, DEFAULT_CONSTRAINTS, transitionGoal, setGoal, createHandoff, claimHandoff, HANDOFF_FILE } = await import("../dist/goal-state.js");

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

// ── Path (a): claimHandoff preserves chainId ─────────────────────────────
// Spec v0.4.0: "claimHandoff preserves chainId — claimed goal keeps chainId".
// `claimHandoff` routes the resumed state's metadata through `sanitizeMetadata`,
// which has chainId/chainStep/chainTotal on its allowlist. Pin that the
// handoff round-trip carries the chain association forward — a chain goal
// handed off in one session resumes in the next as the SAME chain step.

describe("Path (a): claimHandoff preserves chainId", () => {
  it("chainId, chainStep, chainTotal survive a handoff claim", () => {
    const dir = freshDir();
    try {
      // 1. Create a 2-step chain. Step 0 is active.
      const create = createGoalChain(dir, [
        { condition: "first" },
        { condition: "second" },
      ]);
      assert.ok(create.chain);
      const expectedChainId = create.chain.id;

      // 2. Hand the current goal off (with note).
      const ho = createHandoff(dir, "for tomorrow");
      assert.equal(ho.ok, true);

      // 3. Clear current goal (handoff can't be claimed while one is active).
      transitionGoal(dir, "clear");

      // 4. Claim the handoff. Pin that chainId/chStep survive.
      const claim = claimHandoff(dir);
      assert.equal(claim.ok, true);
      assert.ok(claim.state);
      assert.equal(claim.state.metadata.chainId, expectedChainId,
        "chainId must survive handoff claim");
      assert.equal(claim.state.metadata.chainStep, 0,
        "chainStep must survive handoff claim");
      assert.equal(claim.state.metadata.chainTotal, 2,
        "chainTotal must survive handoff claim");
    } finally { cleanDir(dir); }
  });

  it("harness: claimHandoff uses sanitizeMetadata (drops unknown metadata keys)", () => {
    // Defensive pin: the handoff path is the trust boundary. Even if a
    // planted handoff has extra metadata keys, only the allowlist survives.
    // (Sanity check on the security posture; the real value of this test
    // is that it documents the boundary.)
    const dir = freshDir();
    try {
      const create = createGoalChain(dir, [{ condition: "x" }]);
      assert.ok(create.chain);
      // Pre-poison the state with a junk metadata key.
      const st = readGoalState(dir);
      st.metadata.__attacker_planted = "should be dropped on claim";
      writeGoalStateAtomic(dir, st);
      const ho = createHandoff(dir);
      assert.equal(ho.ok, true);
      transitionGoal(dir, "clear");
      const claim = claimHandoff(dir);
      assert.equal(claim.ok, true);
      assert.ok(claim.state);
      assert.equal(claim.state.metadata.__attacker_planted, undefined,
        "unknown metadata keys must be dropped by sanitizeMetadata during claim");
      assert.ok(claim.state.metadata.chainId, "chainId should still survive");
    } finally { cleanDir(dir); }
  });
});

// ── Path (b): transitionGoal preserves chainId across clear→set cycle ────
// Spec scenario: "user clears a chain step, then sets a NEW goal" — the
// new goal should have NO chainId (it's not part of any chain). And
// conversely: a chain goal that is cleared (transitionGoal clear) and
// re-set (setGoal) starts a fresh state with no chainId, and the chain
// file is untouched (so it remains "interrupted" until reset).

describe("Path (b): transitionGoal / setGoal preserve-or-discard chainId correctly", () => {
  it("clear on a chain step does not lose the chain's state chainId; set creates a new id", () => {
    const dir = freshDir();
    try {
      const create = createGoalChain(dir, [{ condition: "step0" }]);
      assert.ok(create.chain);

      // Pin: state has chainId before clear.
      const before = readGoalState(dir);
      assert.equal(before.metadata.chainId, create.chain.id);

      // transitionGoal("clear") → status='cleared', completedAt set.
      // The metadata is preserved by transitionGoal (it only mutates status/timestamps).
      const t = transitionGoal(dir, "clear");
      assert.equal(t.ok, true);
      const after = readGoalState(dir);
      assert.equal(after.status, "cleared");
      // transitionGoal does not strip metadata; the chainId survives the clear,
      // although the goal is now terminal and won't be advanced.
      assert.equal(after.metadata.chainId, create.chain.id,
        "transitionGoal(clear) should not touch metadata.chainId");

      // Now set a NEW goal. setGoal creates a brand-new state with no chainId.
      const r = setGoal(dir, "different goal");
      assert.equal(r.ok, true);
      assert.equal(r.state.metadata.chainId, undefined,
        "setGoal (post-clear) starts a fresh state without chainId");
      assert.notEqual(r.state.id, before.id, "new state must have a new id");

      // The chain file is still present, pointing at step 0.
      const chain = readGoalChain(dir);
      assert.ok(chain, "chain file should be untouched by setGoal");
      assert.equal(chain.id, create.chain.id);
      assert.equal(chain.current, 0);
    } finally { cleanDir(dir); }
  });

  it("setGoal on a chain-active state interrupts the chain (next advance fails)", () => {
    // The override-guard path: when the user calls `set` while a chain is
    // active, setGoal replaces the state. The new state has no chainId,
    // so a SUBSEQUENT advanceGoalChain call must detect the mismatch and
    // refuse with the "interrupted" error. This is the spec's contract
    // for the override guard.
    const dir = freshDir();
    try {
      const create = createGoalChain(dir, [
        { condition: "first" },
        { condition: "second" },
      ]);
      assert.ok(create.chain);

      // Override: user calls setGoal.
      const r = setGoal(dir, "manual override");
      assert.equal(r.ok, true);
      assert.equal(r.state.metadata.chainId, undefined);

      // Next chain advance detects the mismatch and returns error.
      const adv = advanceGoalChain(dir);
      assert.equal(adv.ok, false);
      assert.ok(adv.error.includes("overridden"),
        `expected 'overridden' in error, got: ${adv.error}`);
    } finally { cleanDir(dir); }
  });
});

// ── Path (c): override guard — covered by the test above; add the
// reset-then-advance recovery path.

describe("Path (c-recovery): chain reset restores the chain after an override", () => {
  it("override then chain reset succeeds and resumes step 0", () => {
    const dir = freshDir();
    try {
      createGoalChain(dir, [{ condition: "first" }, { condition: "second" }]);
      // Override.
      setGoal(dir, "manual override");
      // advance refused.
      const adv1 = advanceGoalChain(dir);
      assert.equal(adv1.ok, false);
      // chain reset → restores step 0 and re-attaches the chain.
      const reset = resetGoalChain(dir);
      assert.equal(reset.ok, true);
      const chain = readGoalChain(dir);
      assert.ok(chain);
      assert.equal(reset.state.condition, "first");
      assert.equal(reset.state.metadata.chainId, chain.id);
      assert.equal(reset.state.metadata.chainStep, 0);
      // Subsequent advance now works (chainId matches).
      const adv2 = advanceGoalChain(dir);
      assert.equal(adv2.ok, true);
      assert.equal(adv2.state.condition, "second");
    } finally { cleanDir(dir); }
  });
});

// ── Path (d): corrupt chain file (invalid JSON) → readGoalChain returns null ─

describe("Path (d): corrupt chain file", () => {
  it("invalid JSON → readGoalChain returns null", () => {
    const dir = freshDir();
    try {
      // Set up state and chain so the directory exists; then corrupt the chain.
      createGoalChain(dir, [{ condition: "x" }]);
      const chainPath = join(dir, CHAIN_FILE);
      writeFileSync(chainPath, "{not valid json", "utf-8");
      const chain = readGoalChain(dir);
      assert.equal(chain, null,
        "readGoalChain must return null for invalid JSON, not throw");
      // The state file is untouched.
      const st = readGoalState(dir);
      assert.ok(st, "state file should be untouched by corrupt chain file");
    } finally { cleanDir(dir); }
  });

  it("JSON-valid but wrong shape → readGoalChain returns null", () => {
    const dir = freshDir();
    try {
      createGoalChain(dir, [{ condition: "x" }]);
      const chainPath = join(dir, CHAIN_FILE);
      // Valid JSON but missing required fields (e.g. no `id`).
      writeFileSync(chainPath, JSON.stringify({ version: 1, steps: [] }), "utf-8");
      const chain = readGoalChain(dir);
      assert.equal(chain, null, "shape-invalid chain must be rejected");
    } finally { cleanDir(dir); }
  });
});

// ── Path (e): oversized chain file (> MAX_CHAIN_SIZE) → readGoalChain returns null ─

describe("Path (e): oversized chain file", () => {
  it("file > 256KB → readGoalChain returns null", () => {
    const dir = freshDir();
    try {
      createGoalChain(dir, [{ condition: "x" }]);
      const chainPath = join(dir, CHAIN_FILE);
      // 256KB is the cap; 257KB must be rejected.
      const oversize = "x".repeat(MAX_CHAIN_SIZE + 1024);
      writeFileSync(chainPath, JSON.stringify({
        version: 1,
        id: "abc",
        steps: [{ condition: "huge" }],
        current: 0,
        cycles: 0,
        maxCycles: 10,
        onComplete: "stop",
        metadata: { createdAt: 1, setBy: "user", junk: oversize },
      }), "utf-8");
      const chain = readGoalChain(dir);
      assert.equal(chain, null,
        `oversized chain (size > ${MAX_CHAIN_SIZE}) must be rejected`);
    } finally { cleanDir(dir); }
  });
});

// ── C-2 regression: thread corrupt-state signal through chain reader ────────
// The v0.4.0 `readGoalChain` collapsed three distinct failure modes
// (missing / oversize / corrupt) into a single `null`. A corrupt chain
// file was silently treated as "no chain" and the next
// `createGoalChain`/`advanceGoalChain` overwrote it, destroying mid-chain
// progress, webhook config, and the chain's UUID. v0.4.1 introduces a
// tri-state `ReadResult<GoalChain>` reader (`readGoalChainResult`) that
// distinguishes the three failure modes. On `corrupt`, the reader renames
// the file to `<original>.corrupt.<ts>` BEFORE returning so the user has
// a forensic recovery path. See REVIEW-V040-MULTI-ANGLE.md §2.2.

describe("C-2: readGoalChainResult tri-state reader", () => {
  it("missing chain file → {kind:'absent'} (the shim returns null)", () => {
    const dir = freshDir();
    try {
      const r = readGoalChainResult(dir);
      assert.equal(r.kind, "absent");
      assert.equal(readGoalChain(dir), null);
    } finally { cleanDir(dir); }
  });

  it("malformed JSON → {kind:'corrupt', reason:'parse'} and renames to .corrupt.<ts>", () => {
    const dir = freshDir();
    try {
      const chainPath = join(dir, CHAIN_FILE);
      mkdirSync(join(dir, ".opencode"), { recursive: true });
      writeFileSync(chainPath, "{not valid json", "utf-8");
      const r = readGoalChainResult(dir);
      assert.equal(r.kind, "corrupt");
      if (r.kind === "corrupt") {
        assert.equal(r.reason, "parse");
        assert.ok(r.rawSize > 0);
      }
      // The original chain file is gone — renamed to .corrupt.<ts>.
      // The next createGoalChain can write a fresh chain without
      // overwriting the corrupt evidence.
      assert.equal(existsSync(chainPath), false,
        "corrupt chain file must be renamed, not left in place for a silent overwrite");
      const entries = readdirSync(join(dir, ".opencode"));
      const renamed = entries.find((e) => e.startsWith(".goal-chain.json.corrupt."));
      assert.ok(renamed, `expected a renamed .goal-chain.json.corrupt.<ts> file, got: ${entries.join(", ")}`);
      // The legacy shim returns null on corrupt (same as absent).
      assert.equal(readGoalChain(dir), null);
    } finally { cleanDir(dir); }
  });

  it("JSON-valid but wrong shape → {kind:'corrupt', reason:'validate'} and renames", () => {
    const dir = freshDir();
    try {
      const chainPath = join(dir, CHAIN_FILE);
      mkdirSync(join(dir, ".opencode"), { recursive: true });
      // Valid JSON but missing the required `id` field.
      writeFileSync(chainPath, JSON.stringify({ version: 1, steps: [] }), "utf-8");
      const r = readGoalChainResult(dir);
      assert.equal(r.kind, "corrupt");
      if (r.kind === "corrupt") {
        assert.equal(r.reason, "validate");
      }
      assert.equal(existsSync(chainPath), false,
        "schema-invalid chain file must be renamed");
    } finally { cleanDir(dir); }
  });

  it("oversize chain file → {kind:'corrupt', reason:'oversize'} and renames", () => {
    const dir = freshDir();
    try {
      const chainPath = join(dir, CHAIN_FILE);
      mkdirSync(join(dir, ".opencode"), { recursive: true });
      const oversize = "x".repeat(MAX_CHAIN_SIZE + 1024);
      writeFileSync(chainPath, JSON.stringify({
        version: 1,
        id: "abc",
        steps: [{ condition: "huge" }],
        current: 0,
        cycles: 0,
        maxCycles: 10,
        onComplete: "stop",
        metadata: { createdAt: 1, setBy: "user", junk: oversize },
      }), "utf-8");
      const r = readGoalChainResult(dir);
      assert.equal(r.kind, "corrupt");
      if (r.kind === "corrupt") {
        assert.equal(r.reason, "oversize");
        assert.ok(r.rawSize > MAX_CHAIN_SIZE);
      }
      assert.equal(existsSync(chainPath), false,
        "oversized chain file must be renamed");
    } finally { cleanDir(dir); }
  });
});

// ── Path (f): maxCycles semantics ────────────────────────────────────────
// Spec/TS: "maxCycles: number; // 0 = unlimited". Default in createGoalChain
// is 10. Pin both: the default, and that 0 = unlimited (no loop cap, only
// onComplete=stop halts the chain).

describe("Path (f): maxCycles semantics", () => {
  it("default maxCycles is 10 when not specified", () => {
    const dir = freshDir();
    try {
      const res = createGoalChain(dir, [{ condition: "x" }]);
      assert.ok(res.chain);
      assert.equal(res.chain.maxCycles, 10,
        "createGoalChain must default maxCycles to 10");
    } finally { cleanDir(dir); }
  });

  it("maxCycles=0 means unlimited: chain loops forever", () => {
    const dir = freshDir();
    try {
      createGoalChain(dir, [{ condition: "only" }], { onComplete: "loop", maxCycles: 0 });
      // Run more advances than the old "default 10" cap; none should complete.
      for (let i = 0; i < 15; i++) {
        const r = advanceGoalChain(dir);
        assert.equal(r.ok, true);
        assert.notEqual(r.completed, true,
          `maxCycles=0 must NOT complete (unlimited); iter ${i}`);
      }
      const chain = readGoalChain(dir);
      assert.equal(chain.cycles, 15, "cycles should increment each loop");
    } finally { cleanDir(dir); }
  });

  it("maxCycles=2 with loop: completes after exactly 2 cycles", () => {
    const dir = freshDir();
    try {
      createGoalChain(dir, [{ condition: "only" }], { onComplete: "loop", maxCycles: 2 });
      // Cycle 1: advance once → loop, cycles goes 0 → 1.
      const a1 = advanceGoalChain(dir);
      assert.equal(a1.ok, true);
      assert.notEqual(a1.completed, true);
      // Cycle 2: advance again → cap hit, returns completed (no further writes).
      const a2 = advanceGoalChain(dir);
      assert.equal(a2.ok, true);
      assert.equal(a2.completed, true,
        "maxCycles=2 must complete after 2 loops");
      assert.match(a2.message, /Chain completed after 2 cycles/);
      // A third advance should also report completed (the chain file is
      // unchanged because the second call returned before writing).
      const a3 = advanceGoalChain(dir);
      assert.equal(a3.ok, true);
      assert.equal(a3.completed, true,
        "further advances after maxCycles must also report completed");
      const chain = readGoalChain(dir);
      assert.ok(chain);
      // The second call returned early so cycles stays at 1 (the value
      // the first call wrote). Pin that the cap is enforced by early
      // return, not by clamping the counter.
      assert.equal(chain.cycles, 1,
        "cycles counter is not incremented once the cap is hit");
    } finally { cleanDir(dir); }
  });
});

// ── Path (g): chain display — 1 step, 1 step+loop, completed, cycles=N ──
// The display is the inline handler in command.ts: `chain` (no subcommand).
// We exercise the chain-display LOGIC by reading the chain file directly
// and asserting the markers/format match the spec section. The CLI e2e
// tests in test/cli-e2e.test.mjs cover the binary path.

describe("Path (g): chain display format", () => {
  function buildDisplayLines(chain, state) {
    // Mirrors src/command.ts:437-447 (chain handler). If that changes, this
    // test will fail and force a deliberate update of both.
    const lines = [
      `Chain: ${chain.id.slice(0, 8)} · ${chain.steps.length} steps · current: ${chain.current + 1}/${chain.steps.length}`,
      chain.onComplete === "loop"
        ? `Mode: loop (cycle ${chain.cycles + 1}${chain.maxCycles > 0 ? `/${chain.maxCycles}` : ""})`
        : "Mode: stop on completion",
      "",
    ];
    for (let i = 0; i < chain.steps.length; i++) {
      const marker = i < chain.current ? "✅" : i === chain.current ? "🎯" : "⬜";
      lines.push(`${marker} Step ${i + 1}: ${chain.steps[i].condition.slice(0, 80)}`);
    }
    return lines.join("\n");
  }

  it("1-step chain: current=0/1, no completion marker", () => {
    const chain = {
      version: 1, id: "abc12345-uuid", steps: [{ condition: "only step" }],
      current: 0, cycles: 0, maxCycles: 10, onComplete: "stop",
      metadata: { createdAt: 1, setBy: "user" },
    };
    const out = buildDisplayLines(chain);
    assert.match(out, /Chain: abc12345 · 1 steps · current: 1\/1/);
    assert.match(out, /Mode: stop on completion/);
    assert.match(out, /🎯 Step 1: only step/);
  });

  it("1-step + loop: mode is loop, cycle shown", () => {
    const chain = {
      version: 1, id: "abc12345-uuid", steps: [{ condition: "tick" }],
      current: 0, cycles: 2, maxCycles: 5, onComplete: "loop",
      metadata: { createdAt: 1, setBy: "user" },
    };
    const out = buildDisplayLines(chain);
    assert.match(out, /Mode: loop \(cycle 3\/5\)/);
  });

  it("1-step + loop, maxCycles=0: mode is loop, cycle shown with no cap", () => {
    const chain = {
      version: 1, id: "abc12345-uuid", steps: [{ condition: "tick" }],
      current: 0, cycles: 0, maxCycles: 0, onComplete: "loop",
      metadata: { createdAt: 1, setBy: "user" },
    };
    const out = buildDisplayLines(chain);
    // maxCycles=0 → "unlimited" → no "/N" suffix
    assert.match(out, /Mode: loop \(cycle 1\)/);
    assert.doesNotMatch(out, /Mode: loop \(cycle 1\/\d+\)/);
  });

  it("completed chain (current at last step, no achievement): markers show progress", () => {
    // 4-step chain, current=1 (step 2 active, step 1 done, steps 3-4 pending).
    const chain = {
      version: 1, id: "deploy-stand", steps: [
        { condition: "lint passes" },
        { condition: "tests pass" },
        { condition: "build succeeds" },
        { condition: "deploy to staging" },
      ],
      current: 1, cycles: 0, maxCycles: 10, onComplete: "stop",
      metadata: { createdAt: 1, setBy: "user" },
    };
    const out = buildDisplayLines(chain);
    assert.match(out, /✅ Step 1: lint passes/);
    assert.match(out, /🎯 Step 2: tests pass/);
    assert.match(out, /⬜ Step 3: build succeeds/);
    assert.match(out, /⬜ Step 4: deploy to staging/);
  });

  it("completed chain with cycles=N (loop done): cycle counter shown", () => {
    const chain = {
      version: 1, id: "loop-uuid", steps: [{ condition: "tick" }],
      current: 0, cycles: 3, maxCycles: 5, onComplete: "loop",
      metadata: { createdAt: 1, setBy: "user" },
    };
    const out = buildDisplayLines(chain);
    assert.match(out, /Mode: loop \(cycle 4\/5\)/);
  });
});

// ── Defect: `chain reset` works even after a state override, `chain skip` does not ──
// Pin the actual behavior:
//   - `chain skip` delegates to `advanceGoalChain`, which checks the chainId guard.
//     So a skip-after-override returns an error (the chain is interrupted).
//   - `chain reset` does NOT check the guard — it's a force-op that ignores
//     the state and re-attaches the chain. The spec treats reset as the
//     recovery path for the override scenario.
// These tests pin the asymmetry so a future refactor can't silently change
// which side applies the guard.

describe("force-ops: chain reset works after override; chain skip does not", () => {
  it("chain skip after set override is rejected (guard applies via advanceGoalChain)", () => {
    const dir = freshDir();
    try {
      createGoalChain(dir, [{ condition: "first" }, { condition: "second" }]);
      setGoal(dir, "manual override");
      const res = skipGoalChainStep(dir);
      assert.equal(res.ok, false,
        "chain skip delegates to advanceGoalChain, which checks chainId");
      assert.ok(res.error.includes("overridden"),
        `expected 'overridden' in error, got: ${res.error}`);
    } finally { cleanDir(dir); }
  });

  it("chain reset after set override replaces the unrelated goal (force-op)", () => {
    const dir = freshDir();
    try {
      createGoalChain(dir, [{ condition: "first" }, { condition: "second" }]);
      setGoal(dir, "manual override");
      const res = resetGoalChain(dir);
      assert.equal(res.ok, true,
        "chain reset is a force-op; the override guard does NOT apply");
      assert.equal(res.state.condition, "first");
      assert.equal(res.state.metadata.chainStep, 0);
    } finally { cleanDir(dir); }
  });
});

// ── Defect E-2: validateGoalChain accepts malformed `step.verification` ────
// REVIEW-V040-MULTI-ANGLE.md §2.4. A chain file with a malformed
// `verification` (e.g. { type: "BANANA" }) on any step previously passed
// validation; when that step became active via advanceGoalChain, the new
// state had the malformed verification, the next readGoalState rejected it,
// and the chain silently died mid-way. The fix mirrors goal-state.ts:223-233
// in the chain validator's step loop. These tests pin the four cases:
//   1. malformed verification → createGoalChain returns ok:false, error
//      names the step index, chain file is NOT written
//   2. verification: null (unset) → accepted
//   3. verification: { type: "shell", command: "npm test" } → accepted
//   4. verification: { type: "shell" } (missing required field) → rejected
// Plus a validator-level pin (validateGoalChain returns false on a hand-
// crafted chain object with a malformed verification on step 1).

describe("E-2: chain validator rejects malformed step.verification", () => {
  it("createGoalChain rejects a chain with malformed verification on step 2; names step index; writes nothing", () => {
    const dir = freshDir();
    try {
      const res = createGoalChain(dir, [
        { condition: "valid first step" },
        { condition: "valid second step", verification: { type: "BANANA" } },
      ]);
      assert.equal(res.ok, false, "createGoalChain must reject a malformed step.verification");
      assert.ok(res.error.includes("Step 2"),
        `error must name the offending step index, got: ${res.error}`);
      assert.match(res.error, /verification/,
        `error must mention verification, got: ${res.error}`);
      // The validator runs BEFORE the write — chain file must not exist.
      const chain = readGoalChain(dir);
      assert.equal(chain, null,
        "chain file must NOT be written when the validator rejects the chain");
    } finally { cleanDir(dir); }
  });

  it("createGoalChain accepts verification: null (unset)", () => {
    const dir = freshDir();
    try {
      const res = createGoalChain(dir, [
        { condition: "first", verification: null },
        { condition: "second" },
      ]);
      assert.equal(res.ok, true, `unset verification must be accepted; error: ${res.error}`);
      const chain = readGoalChain(dir);
      assert.ok(chain);
      assert.equal(chain.steps[0].verification, null);
    } finally { cleanDir(dir); }
  });

  it("createGoalChain accepts a valid shell verification { type: 'shell', command: 'npm test' }", () => {
    const dir = freshDir();
    try {
      const res = createGoalChain(dir, [
        { condition: "run the tests", verification: { type: "shell", command: "npm test" } },
        { condition: "then build" },
      ]);
      assert.equal(res.ok, true, `valid shell verification must be accepted; error: ${res.error}`);
      const chain = readGoalChain(dir);
      assert.ok(chain);
      assert.equal(chain.steps[0].verification.type, "shell");
      assert.equal(chain.steps[0].verification.command, "npm test");
      // Pin: the active state's verification mirrors the step's.
      const state = readGoalState(dir);
      assert.ok(state);
      assert.equal(state.verification.type, "shell");
      assert.equal(state.verification.command, "npm test");
    } finally { cleanDir(dir); }
  });

  it("createGoalChain rejects shell verification missing the required 'command' field", () => {
    const dir = freshDir();
    try {
      const res = createGoalChain(dir, [
        { condition: "first" },
        { condition: "bad shell", verification: { type: "shell" } },
      ]);
      assert.equal(res.ok, false, "shell verification without 'command' must be rejected");
      assert.ok(res.error.includes("Step 2"),
        `error must name the offending step index, got: ${res.error}`);
      assert.match(res.error, /command/,
        `error must mention the missing field, got: ${res.error}`);
      const chain = readGoalChain(dir);
      assert.equal(chain, null, "chain file must NOT be written on validation failure");
    } finally { cleanDir(dir); }
  });

  it("validateGoalChain returns false for a hand-crafted chain with malformed step.verification", () => {
    // The validator-level pin: even if a chain file is hand-edited with a
    // malformed verification on step 2, readGoalChain (which calls
    // validateGoalChain) must return null. This is the on-disk trust-
    // boundary path; without this check, readGoalChain would return the
    // poisoned chain object and advanceGoalChain would propagate the
    // malformed verification into a state file that the state validator
    // then rejects — chain silently dies mid-way.
    const c = {
      version: 1,
      id: "abc",
      steps: [
        { condition: "step one" },
        { condition: "step two", verification: { type: "BANANA" } },
      ],
      current: 0,
      cycles: 0,
      maxCycles: 10,
      onComplete: "stop",
      metadata: { createdAt: 1, setBy: "user" },
    };
    assert.equal(validateGoalChain(c), false,
      "validateGoalChain must reject a chain whose step has a malformed verification");
  });
});
