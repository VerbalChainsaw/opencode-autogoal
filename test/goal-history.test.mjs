import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendGoalArchive } from "../dist/goal-archive.js";
import { readGoalHistorySnapshot } from "../dist/goal-history.js";

test("readGoalHistorySnapshot derives pill + drawer data from archived runs", () => {
  const dir = mkdtempSync(join(tmpdir(), "goal-history-"));
  mkdirSync(join(dir, ".opencode"), { recursive: true });

  appendGoalArchive(
    dir,
    {
      id: "goal-1",
      condition: "make auth tests pass",
      command: "npm test",
      status: "achieved",
      startedAt: 1_700_000_000_000,
      completedAt: 1_700_000_600_000,
      turnsEvaluated: 4,
      tokensUsed: 9000,
      lastEvaluation: {
        met: true,
        reason: "npm test exited 0",
        confidence: 1,
        timestamp: 1_700_000_600_000,
        evaluatorType: "deterministic",
      },
      evaluationHistory: [
        {
          met: false,
          reason: "2 tests failing",
          confidence: 1,
          timestamp: 1_700_000_100_000,
          evaluatorType: "deterministic",
        },
        {
          met: false,
          reason: "1 test failing",
          confidence: 1,
          timestamp: 1_700_000_300_000,
          evaluatorType: "deterministic",
        },
        {
          met: true,
          reason: "green",
          confidence: 1,
          timestamp: 1_700_000_600_000,
          evaluatorType: "deterministic",
        },
      ],
      constraints: { maxTurns: 12, maxTimeMinutes: 20, maxTokens: 100000 },
      metadata: { setBy: "template", templateName: "pass-tests" },
    },
    "achieved",
  );

  const snapshot = readGoalHistorySnapshot(dir);
  assert.equal(snapshot.runs.length, 1);
  assert.equal(snapshot.runs[0].summary.status, "success");
  assert.equal(snapshot.runs[0].summary.successCount, 1);
  assert.equal(snapshot.runs[0].summary.failureCount, 2);
  assert.equal(snapshot.runs[0].detail.cycles.length, 3);
  assert.equal(
    snapshot.runs[0].detail.template.reuseCommand,
    'set "make auth tests pass" --command "npm test"',
  );
});
