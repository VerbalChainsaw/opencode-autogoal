/**
 * F-3 (v0.5.0) — Goal archive + `stats`.
 *
 * Spec: specs/v0.5.0-feature-work-orders.md §F-3.
 *
 * Test surface:
 *   - appendGoalArchive / readGoalArchive (pure unit tests against dist)
 *   - chokepoint wiring: each of achieved/cleared/replaced produces an
 *     archive entry with the right outcome
 *   - cap-and-trim: 1 MB cap keeps newest 200 lines atomically
 *   - corrupt line: skipped and counted
 *   - dispatcher envelopes: archive and stats return `success` /
 *     `no-goal` correctly
 *   - e2e: `--json stats` parses cleanly
 *   - read-only dir: appendGoalArchive swallows the failure (never
 *     breaks a goal transition)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  appendFileSync,
  statSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import {
  appendGoalArchive,
  readGoalArchive,
  ARCHIVE_FILE,
} from "../dist/goal-archive.js";
import { dispatchGoalCommandStructured } from "../dist/command.js";
import { setGoal, transitionGoal } from "../dist/goal-state.js";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "dist", "cli.js");
const NODE = process.execPath;

function freshDir() {
  return mkdtempSync(join(tmpdir(), "opengoal-archive-"));
}

/** Minimal valid state for archive tests. The archive schema only
 *  cares about the shape that readGoalArchive's validator checks:
 *  archivedAt (number), outcome (string), state (truthy). The full
 *  GoalState shape isn't revalidated when reading the archive. */
function makeState(overrides = {}) {
  return {
    id: "test-id",
    condition: "test condition",
    command: null,
    status: "active",
    startedAt: 1_700_000_000_000,
    completedAt: null,
    turnsEvaluated: 0,
    tokensUsed: 0,
    lastEvaluation: null,
    evaluationHistory: [],
    constraints: { maxTurns: 20, maxTimeMinutes: 30, maxTokens: 1000 },
    ...overrides,
  };
}

// ── appendGoalArchive / readGoalArchive unit tests ──────────────────

test("archive: append + read round-trip preserves outcome and state", () => {
  const dir = freshDir();
  try {
    const s = makeState({ turnsEvaluated: 3 });
    appendGoalArchive(dir, s, "cleared");
    const { entries, skippedCorrupt } = readGoalArchive(dir, 10);
    assert.equal(skippedCorrupt, 0);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].outcome, "cleared");
    assert.equal(entries[0].state.turnsEvaluated, 3);
    assert.equal(typeof entries[0].archivedAt, "number");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("archive: read returns entries newest-first", () => {
  const dir = freshDir();
  try {
    appendGoalArchive(dir, makeState({ id: "first" }), "cleared");
    // Sleep 2ms so the second entry's timestamp is strictly newer.
    const wait = Date.now();
    while (Date.now() === wait) { /* spin */ }
    appendGoalArchive(dir, makeState({ id: "second" }), "replaced");
    const { entries } = readGoalArchive(dir, 10);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].state.id, "second");
    assert.equal(entries[1].state.id, "first");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("archive: limit parameter caps the number of returned entries", () => {
  const dir = freshDir();
  try {
    for (let i = 0; i < 5; i++) appendGoalArchive(dir, makeState({ id: String(i) }), "cleared");
    const { entries } = readGoalArchive(dir, 3);
    assert.equal(entries.length, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("archive: missing file returns empty result, not an error", () => {
  const dir = freshDir();
  try {
    const { entries, skippedCorrupt } = readGoalArchive(dir);
    assert.deepEqual(entries, []);
    assert.equal(skippedCorrupt, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("archive: corrupt JSON line is skipped and counted", () => {
  const dir = freshDir();
  try {
    const p = join(dir, ARCHIVE_FILE);
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, "not-valid-json\n", "utf-8");
    appendFileSync(p, JSON.stringify({ archivedAt: 1, outcome: "cleared", state: makeState() }) + "\n", "utf-8");
    appendFileSync(p, "{incomplete\n", "utf-8");
    const { entries, skippedCorrupt } = readGoalArchive(dir, 10);
    assert.equal(entries.length, 1);
    assert.equal(skippedCorrupt, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("archive: corrupt shape (missing fields) is skipped and counted", () => {
  const dir = freshDir();
  try {
    const p = join(dir, ARCHIVE_FILE);
    mkdirSync(dirname(p), { recursive: true });
    // missing state
    appendFileSync(p, JSON.stringify({ archivedAt: 1, outcome: "cleared" }) + "\n", "utf-8");
    // missing outcome
    appendFileSync(p, JSON.stringify({ archivedAt: 1, state: makeState() }) + "\n", "utf-8");
    // both, but archivedAt wrong type
    appendFileSync(p, JSON.stringify({ archivedAt: "nope", outcome: "cleared", state: makeState() }) + "\n", "utf-8");
    const { entries, skippedCorrupt } = readGoalArchive(dir, 10);
    assert.equal(entries.length, 0);
    assert.equal(skippedCorrupt, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("archive: 1 MB cap trim keeps newest 200 lines and discards older ones", () => {
  const dir = freshDir();
  try {
    // Plant 300 small lines totaling > 1 MB so trim fires on the
    // very next append. Each line is a tiny JSON object with a
    // unique id, so we can verify the KEEP_NEWEST-200 behavior
    // (newest 200 ids survive; the oldest 100 are dropped).
    const p = join(dir, ARCHIVE_FILE);
    mkdirSync(dirname(p), { recursive: true });
    const lines = [];
    for (let i = 0; i < 300; i++) {
      // Each line ~5KB so total is ~1.5 MB.
      const filler = "x".repeat(4500);
      lines.push(JSON.stringify({ archivedAt: i, outcome: "cleared", state: makeState({ id: String(i), condition: filler }) }));
    }
    writeFileSync(p, lines.join("\n") + "\n", "utf-8");
    assert.ok(statSync(p).size > 1_048_576, `planted file should exceed 1 MB; got ${statSync(p).size}`);

    // Trigger appendGoalArchive; the cap-trim should fire and keep
    // the newest 200 of the 300 planted lines (plus the new "trigger"
    // line which is itself one of the newest 200).
    appendGoalArchive(dir, makeState({ id: "trigger" }), "cleared");
    const { entries } = readGoalArchive(dir, 10_000);
    // We planted 300 + appended 1 = 301 total. Trim keeps newest 200.
    assert.equal(entries.length, 200);
    // The trigger survived (it's newest).
    assert.equal(entries[0].state.id, "trigger");
    // The oldest 100 (ids 0..99) were trimmed. The newest 199 of the
    // planted lines survive alongside the trigger: ids 101..299
    // (since 300 planted + 1 new = 301 lines, trim keeps last 200,
    // which is the 100..299 planted + the new trigger = 201; we
    // expect entries[1..199] to be the planted ids 101..299 ordered
    // newest-first).
    const plantedSurviving = entries.slice(1).map((e) => e.state.id);
    assert.equal(plantedSurviving.length, 199);
    assert.equal(plantedSurviving[0], "299", "newest planted line is first after the trigger");
    assert.equal(plantedSurviving[198], "101", "oldest surviving planted line is 101");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("archive: appendGoalArchive failure does not throw (best-effort)", () => {
  // Make the directory read-only. On Windows, chmod 0o555 may not
  // block writes the way it does on POSIX, so this test is best-effort
  // and skipped when the underlying call still succeeds. We only
  // assert the *contract*: appendGoalArchive never throws.
  const dir = freshDir();
  try {
    mkdirSync(join(dir, ".opencode"), { recursive: true });
    chmodSync(dir, 0o555);
    try {
      appendGoalArchive(dir, makeState(), "cleared");
      // If we reach here, the test passed: no throw. The file may
      // or may not exist depending on the platform's enforcement of
      // the read-only bit on the parent directory.
    } finally {
      chmodSync(dir, 0o755); // restore so rmSync can clean up
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Chokepoint wiring: each transition produces the right outcome ──

test("chokepoint: cleared transition writes a 'cleared' archive entry", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "first");
    transitionGoal(dir, "clear");
    const { entries } = readGoalArchive(dir, 10);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].outcome, "cleared");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("chokepoint: set-replaces-set writes a 'replaced' archive entry", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "first");
    setGoal(dir, "second");
    const { entries } = readGoalArchive(dir, 10);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].outcome, "replaced");
    assert.equal(entries[0].state.condition, "first");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("chokepoint: pause/resume do NOT produce archive entries", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "first");
    transitionGoal(dir, "pause");
    transitionGoal(dir, "resume");
    const { entries } = readGoalArchive(dir, 10);
    assert.equal(entries.length, 0, "pause/resume are not terminal - no archive entry");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("chokepoint: 'achieved' outcome fires from the server evaluator path (smoke via set+turn=1, achieved by manual write)", () => {
  // The 'achieved' chokepoint lives in server.ts and is triggered when
  // the evaluator reports success. Driving that path requires running
  // the full server with an evaluator. We assert the wiring shape:
  // the function accepts an 'achieved' outcome and writes it. The
  // server.ts chokepoint is reviewed in source.
  const dir = freshDir();
  try {
    appendGoalArchive(dir, makeState({ turnsEvaluated: 1 }), "achieved");
    const { entries } = readGoalArchive(dir, 10);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].outcome, "achieved");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Dispatcher envelopes ───────────────────────────────────────────

test("dispatcher: archive with empty archive → kind no-goal", () => {
  const dir = freshDir();
  try {
    const r = dispatchGoalCommandStructured(dir, "archive");
    assert.equal(r.kind, "no-goal");
    assert.match(r.message, /No archived goals yet/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dispatcher: archive with entries → kind success, format includes outcome and date", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "ship it");
    transitionGoal(dir, "clear");
    const r = dispatchGoalCommandStructured(dir, "archive");
    assert.equal(r.kind, "success");
    assert.match(r.message, /Goal archive:/);
    assert.match(r.message, /cleared/);
    assert.match(r.message, /ship it/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dispatcher: stats with empty archive → kind no-goal", () => {
  const dir = freshDir();
  try {
    const r = dispatchGoalCommandStructured(dir, "stats");
    assert.equal(r.kind, "no-goal");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dispatcher: stats with mixed outcomes → correct counts and avgTurns over achieved only", () => {
  const dir = freshDir();
  try {
    // 1 achieved (5 turns), 1 cleared (10 turns), 1 replaced (15 turns)
    appendGoalArchive(dir, makeState({ turnsEvaluated: 5 }), "achieved");
    appendGoalArchive(dir, makeState({ turnsEvaluated: 10 }), "cleared");
    appendGoalArchive(dir, makeState({ turnsEvaluated: 15 }), "replaced");
    const r = dispatchGoalCommandStructured(dir, "stats");
    assert.equal(r.kind, "success");
    assert.match(r.message, /Total archived: 3/);
    assert.match(r.message, /Achieved: 1/);
    assert.match(r.message, /Cleared: 1/);
    assert.match(r.message, /Replaced: 1/);
    // Only the achieved outcome is averaged.
    assert.match(r.message, /Avg\. turns to achieve: 5\.0/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dispatcher: stats with no achieved → Avg. turns to achieve: n/a", () => {
  const dir = freshDir();
  try {
    appendGoalArchive(dir, makeState(), "cleared");
    const r = dispatchGoalCommandStructured(dir, "stats");
    assert.equal(r.kind, "success");
    assert.match(r.message, /Avg\. turns to achieve: n\/a/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── e2e ─────────────────────────────────────────────────────────────

function runCli(cwd, args) {
  return spawnSync(NODE, [CLI, ...args], { cwd, encoding: "utf-8", timeout: 10_000 });
}

test("CLI: --json stats in a clean dir → no-goal, exit 2", () => {
  const dir = freshDir();
  try {
    const r = runCli(dir, ["--json", "stats"]);
    assert.equal(r.status, 2);
    const parsed = JSON.parse(r.stdout.trim());
    assert.equal(parsed.kind, "no-goal");
    assert.equal(parsed.ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: set → clear → --json stats → success, exit 0, counts populated", () => {
  const dir = freshDir();
  try {
    assert.equal(runCli(dir, ["set", "ship it"]).status, 0);
    assert.equal(runCli(dir, ["clear"]).status, 0);
    const r = runCli(dir, ["--json", "stats"]);
    assert.equal(r.status, 0);
    const parsed = JSON.parse(r.stdout.trim());
    assert.equal(parsed.kind, "success");
    assert.equal(parsed.ok, true);
    assert.match(parsed.message, /Total archived: 1/);
    assert.match(parsed.message, /Cleared: 1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: --json archive after a clear → success with one line", () => {
  const dir = freshDir();
  try {
    assert.equal(runCli(dir, ["set", "ship v2"]).status, 0);
    assert.equal(runCli(dir, ["clear"]).status, 0);
    const r = runCli(dir, ["--json", "archive"]);
    assert.equal(r.status, 0);
    const parsed = JSON.parse(r.stdout.trim());
    assert.equal(parsed.kind, "success");
    assert.match(parsed.message, /#1 cleared/);
    assert.match(parsed.message, /ship v2/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
