/**
 * v0.5.x hard-bug regression suite. Runs against the BUILT output (dist/).
 *
 * Two correctness defects found in a deep re-audit:
 *
 *   BUG 1 — Paused time consumed the time budget. `checkConstraints`
 *           (server.ts) measures elapsed as `Date.now() - startedAt`, and
 *           `startedAt` was stamped once at creation and never moved on
 *           pause/resume. A goal paused for longer than `maxTimeMinutes`
 *           would self-clear ("Time limit reached") the instant it resumed —
 *           pause is meant to set a goal aside safely, not destroy it. The
 *           fix advances `startedAt` by the paused duration on resume, so the
 *           time budget only counts ACTIVE wall-clock. `createdAt` still
 *           records the true creation time.
 *
 *   BUG 2 — SSRF guard missed IPv4-mapped IPv6 loopback. `isLocalUrl`
 *           blocked localhost / 0.0.0.0 / [::1] / 127.0.0.0/8, but WHATWG
 *           URL normalizes `http://[::ffff:127.0.0.1]` to hostname
 *           `[::ffff:7f00:1]`, which slipped through, as did `[::]` (the
 *           IPv6 analog of the already-blocked 0.0.0.0). On a dual-stack
 *           host these reach loopback, bypassing the allowLocal gate.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const distPath = join(here, "..", "dist");

const { setGoalFields, transitionGoal, atomicToggle, readGoalState, createHandoff, claimHandoff } = await import(
  "file:///" + join(distPath, "goal-state.js").replace(/\\/g, "/"));
const { isLocalUrl } = await import("file:///" + join(distPath, "server.js").replace(/\\/g, "/"));

function freshDir() {
  return mkdtempSync(join(tmpdir(), "opengoal-hardbug-"));
}

// ── BUG 1: paused time must not consume the time budget ─────────────────────

describe("time budget excludes paused time (startedAt shifts forward on resume)", () => {
  it("transitionGoal resume advances startedAt by the paused duration", () => {
    const dir = freshDir();
    try {
      // Goal created at t=1000.
      setGoalFields(dir, { condition: "do the thing" }, { now: 1000 });
      const before = readGoalState(dir);
      assert.equal(before.startedAt, 1000);

      // Pause 1s in (t=2000), resume after a 60s pause (t=62000).
      transitionGoal(dir, "pause", 2000);
      transitionGoal(dir, "resume", 62000);

      const after = readGoalState(dir);
      // startedAt advances by the 60s pause so elapsed = now - startedAt
      // counts only active wall-clock.
      assert.equal(after.startedAt, 61000, "startedAt should advance by the 60s pause");
      // createdAt is the true creation time — unchanged.
      assert.equal(after.createdAt, 1000, "createdAt must remain the true creation time");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("multiple pause/resume cycles accumulate the excluded time", () => {
    const dir = freshDir();
    try {
      setGoalFields(dir, { condition: "do the thing" }, { now: 0 });
      // First pause: 10s (1000 → 11000).
      transitionGoal(dir, "pause", 1000);
      transitionGoal(dir, "resume", 11000);   // +10000
      // Second pause: 5s (20000 → 25000).
      transitionGoal(dir, "pause", 20000);
      transitionGoal(dir, "resume", 25000);    // +5000
      const after = readGoalState(dir);
      assert.equal(after.startedAt, 15000, "startedAt should advance by 10s + 5s = 15s total");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("atomicToggle resume advances startedAt by the paused duration", () => {
    const dir = freshDir();
    try {
      setGoalFields(dir, { condition: "do the thing" }, { now: 1000 });
      // Toggle to paused at t=2000, toggle back to active at t=62000.
      const t1 = atomicToggle(dir, 2000);
      assert.equal(t1.ok && t1.newStatus, "paused");
      const t2 = atomicToggle(dir, 62000);
      assert.equal(t2.ok && t2.newStatus, "active");
      const after = readGoalState(dir);
      assert.equal(after.startedAt, 61000, "startedAt should advance by the 60s pause");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a goal paused longer than maxTimeMinutes does NOT instantly exceed the budget on resume", () => {
    const dir = freshDir();
    try {
      // 1-minute time budget, created at t=0.
      setGoalFields(dir, { condition: "do the thing", maxMinutes: 1 }, { now: 0 });
      // Pause almost immediately (t=1000), resume 1 hour later (t=3_601_000).
      transitionGoal(dir, "pause", 1000);
      transitionGoal(dir, "resume", 3_601_000);
      const after = readGoalState(dir);
      // Effective elapsed at resume = startedAt should be ~now - 1000ms of
      // active time, NOT now - createdAt. So now() - startedAt ≈ 1000ms,
      // well under the 60_000ms budget.
      const effectiveElapsedAtResume = 3_601_000 - after.startedAt;
      assert.ok(
        effectiveElapsedAtResume < 60_000,
        `effective elapsed (${effectiveElapsedAtResume}ms) must be under the 60s budget; was the pause counted?`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── BUG 1b: claiming a handoff gives a fresh time budget ────────────────────
// A handoff is "for tomorrow's session". Claiming it after a long gap must
// not inherit the original startedAt (which would instantly trip the time
// budget on the first idle after claim — the same failure mode as BUG 1).

describe("claimHandoff resets the time budget (startedAt = claim time)", () => {
  it("resumed goal's startedAt is the claim time, not the original creation", () => {
    const dir = freshDir();
    try {
      // Goal created at t=0 with a 1-minute budget.
      setGoalFields(dir, { condition: "ship it", maxMinutes: 1 }, { now: 0 });
      // Hand it off at t=1000, clear so the claim has a clean slate.
      createHandoff(dir, "for tomorrow", 1000);
      transitionGoal(dir, "clear", 2000);
      // Claim an hour later.
      const res = claimHandoff(dir, 3_600_000);
      assert.equal(res.ok, true);
      const after = readGoalState(dir);
      assert.equal(after.startedAt, 3_600_000, "claim should reset startedAt to the claim time (fresh budget)");
      // createdAt stays the true origin so history/forensics are intact.
      assert.equal(after.createdAt, 0, "createdAt must remain the original creation time");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── BUG 2: SSRF guard blocks IPv4-mapped IPv6 loopback + [::] ────────────────

describe("isLocalUrl blocks IPv4-mapped IPv6 loopback and unspecified", () => {
  // Forms WHATWG URL produces / accepts that must be treated as local.
  it("blocks [::ffff:127.0.0.1] (dotted IPv4-mapped loopback)", () => {
    assert.equal(isLocalUrl("http://[::ffff:127.0.0.1]:8080/hook"), true);
  });
  it("blocks [::ffff:7f00:1] (hex-normalized IPv4-mapped loopback)", () => {
    assert.equal(isLocalUrl("http://[::ffff:7f00:1]/hook"), true);
  });
  it("blocks [::ffff:7f01:203] (127.1.2.3 mapped — full 127/8)", () => {
    assert.equal(isLocalUrl("http://[::ffff:7f01:203]/hook"), true);
  });
  it("blocks [::] (unspecified — IPv6 analog of 0.0.0.0)", () => {
    assert.equal(isLocalUrl("http://[::]:9999/hook"), true);
  });

  // Existing guarantees must still hold (no over-blocking).
  it("still blocks the canonical loopback forms", () => {
    assert.equal(isLocalUrl("http://localhost/hook"), true);
    assert.equal(isLocalUrl("http://127.0.0.1/hook"), true);
    assert.equal(isLocalUrl("http://[::1]/hook"), true);
    assert.equal(isLocalUrl("http://0.0.0.0/hook"), true);
  });
  it("does NOT block public / private-network hosts (CI use case)", () => {
    assert.equal(isLocalUrl("https://example.com/hook"), false);
    assert.equal(isLocalUrl("http://10.0.0.1/hook"), false);
    assert.equal(isLocalUrl("http://192.168.1.1/hook"), false);
    assert.equal(isLocalUrl("http://169.254.169.254/latest/"), false);
    // A non-loopback IPv4-mapped address must NOT be blocked.
    assert.equal(isLocalUrl("http://[::ffff:8.8.8.8]/hook"), false);
  });
});
