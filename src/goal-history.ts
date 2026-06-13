import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sanitizeForPrompt, type GoalState } from "./goal-state.js";

const ARCHIVE_FILE = ".opencode/goal-archive.jsonl";
const MAX_ARCHIVE_SIZE = 2 * 1024 * 1024;
const DEFAULT_LIMIT = 200;

export const GOAL_HISTORY_FILE = ".opencode/goal-history.json";

type ArchiveOutcome = "achieved" | "cleared" | "replaced";

interface ArchiveEntry {
  archivedAt: number;
  outcome: ArchiveOutcome;
  state: GoalState;
}

export interface GoalRunSummary {
  goalID: string;
  title: string;
  status: "success" | "failure" | "mixed";
  outcome: ArchiveOutcome;
  turns: number;
  elapsedMs: number;
  successCount: number;
  failureCount: number;
  archivedAt: number;
}

export interface GoalRunDetail {
  latestReason: string;
  cycles: Array<{ turn: number; met: boolean; reason: string; at: number }>;
  template: {
    source: "template" | "manual";
    label: string;
    reuseCommand: string;
    canGenerate: boolean;
  };
}

export interface GoalHistorySnapshot {
  version: 1;
  runs: Array<{
    summary: GoalRunSummary;
    detail: GoalRunDetail;
  }>;
}

function archivePath(directory: string): string {
  return join(directory, ARCHIVE_FILE);
}

function historyPath(directory: string): string {
  return join(directory, GOAL_HISTORY_FILE);
}

function sanitizeInline(value: string | null | undefined): string {
  return sanitizeForPrompt(value ?? "").replace(/"/g, "").trim();
}

function templateLabel(state: GoalState): string {
  const metadata = state.metadata as GoalState["metadata"] & { templateName?: unknown };
  if (typeof metadata.templateName === "string" && metadata.templateName.trim().length > 0) {
    return sanitizeForPrompt(metadata.templateName).slice(0, 120);
  }
  return state.metadata.setBy === "template" ? "Template run" : "Ad hoc run";
}

function buildReuseCommand(state: GoalState): string {
  const condition = sanitizeInline(state.condition);
  const command = typeof state.command === "string" ? sanitizeInline(state.command) : "";
  if (command.length > 0) {
    return `set "${condition}" --command "${command}"`;
  }
  return `set "${condition}"`;
}

function buildRun(entry: ArchiveEntry) {
  const cycles = (entry.state.evaluationHistory ?? []).map((evaluation, index) => ({
    turn: index + 1,
    met: evaluation.met,
    reason: sanitizeForPrompt(evaluation.reason ?? "").slice(0, 240),
    at: evaluation.timestamp,
  }));
  const successCount = cycles.filter((cycle) => cycle.met).length;
  const failureCount = cycles.length - successCount;
  const status: GoalRunSummary["status"] =
    entry.outcome === "achieved" ? "success" : successCount > 0 ? "mixed" : "failure";

  const templateSource: GoalRunDetail["template"]["source"] =
    entry.state.metadata.setBy === "template" ? "template" : "manual";

  return {
    summary: {
      goalID: entry.state.id,
      title: sanitizeForPrompt(entry.state.condition).slice(0, 140),
      status,
      outcome: entry.outcome,
      turns: entry.state.turnsEvaluated,
      elapsedMs: Math.max(0, (entry.state.completedAt ?? entry.archivedAt) - entry.state.startedAt),
      successCount,
      failureCount,
      archivedAt: entry.archivedAt,
    },
    detail: {
      latestReason: sanitizeForPrompt(entry.state.lastEvaluation?.reason ?? "").slice(0, 240),
      cycles,
      template: {
        source: templateSource,
        label: templateLabel(entry.state),
        reuseCommand: buildReuseCommand(entry.state),
        canGenerate: false,
      },
    },
  };
}

function readArchiveEntries(directory: string, limit: number = DEFAULT_LIMIT): ArchiveEntry[] {
  const path = archivePath(directory);
  if (!existsSync(path)) return [];
  try {
    if (statSync(path).size > MAX_ARCHIVE_SIZE) return [];
    const raw = readFileSync(path, "utf-8");
    const lines = raw.split("\n");
    const entries: ArchiveEntry[] = [];
    for (let index = lines.length - 1; index >= 0 && entries.length < limit; index--) {
      const line = lines[index]!.trim();
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        if (
          parsed &&
          typeof parsed.archivedAt === "number" &&
          typeof parsed.outcome === "string" &&
          parsed.state &&
          typeof parsed.state.id === "string"
        ) {
          entries.push(parsed as ArchiveEntry);
        }
      } catch {
        // Best-effort: corrupt lines are skipped, matching archive readers elsewhere.
      }
    }
    return entries;
  } catch {
    return [];
  }
}

function isGoalHistorySnapshot(value: unknown): value is GoalHistorySnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as { version?: unknown; runs?: unknown };
  return snapshot.version === 1 && Array.isArray(snapshot.runs);
}

export function buildGoalHistorySnapshot(entries: ArchiveEntry[]): GoalHistorySnapshot {
  return {
    version: 1,
    runs: entries.map((entry) => buildRun(entry)),
  };
}

export function writeGoalHistorySnapshot(directory: string): void {
  const snapshot = buildGoalHistorySnapshot(readArchiveEntries(directory));
  const path = historyPath(directory);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(tmp, JSON.stringify(snapshot, null, 2) + "\n", "utf-8");
  renameSync(tmp, path);
}

export function readGoalHistorySnapshot(directory: string): GoalHistorySnapshot {
  const path = historyPath(directory);
  const fallback = buildGoalHistorySnapshot(readArchiveEntries(directory));
  if (!existsSync(path)) return fallback;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return isGoalHistorySnapshot(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}
