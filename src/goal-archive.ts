/**
 * Goal archive — append-only JSONL record of terminal goal outcomes.
 *
 * When a goal reaches a terminal state (achieved, cleared, or replaced),
 * the transition is recorded in `.opencode/goal-archive.jsonl`. One JSON
 * line per outcome, newest line appended. The file is capped at 1 MB:
 * when exceeded, it's atomically trimmed to the newest 200 lines (tmp +
 * rename, matching the existing atomic-write pattern).
 *
 * Archiving is best-effort: `appendGoalArchive` swallows all errors so a
 * full disk or permission failure cannot break a goal transition. The
 * archive is a bonus feature, not a correctness requirement.
 *
 * Imports only `type GoalState` from goal-state.js (type-only, erased at
 * build) so there is no runtime import cycle when goal-state.js imports
 * this module for the chokepoint wiring.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { GoalState } from "./goal-state.js";
import { writeGoalHistorySnapshot } from "./goal-history.js";

export const ARCHIVE_FILE = ".opencode/goal-archive.jsonl";
const MAX_ARCHIVE_SIZE = 1 * 1024 * 1024; // 1 MB
const TRIM_KEEP = 200;

export type ArchiveOutcome = "achieved" | "cleared" | "replaced";

export interface ArchiveEntry {
  archivedAt: number;
  outcome: ArchiveOutcome;
  state: GoalState;
}

function archivePath(directory: string): string {
  return join(directory, ARCHIVE_FILE);
}

/**
 * Append a terminal goal outcome to the archive. Best-effort: any failure
 * (missing directory, disk full, permission denied) is silently swallowed.
 * The caller proceeds as if archiving never happened.
 *
 * After the append, if the file exceeds MAX_ARCHIVE_SIZE, it's atomically
 * trimmed to the newest TRIM_KEEP lines. The trim is also best-effort.
 */
export function appendGoalArchive(
  directory: string,
  state: GoalState,
  outcome: ArchiveOutcome,
): void {
  try {
    const p = archivePath(directory);
    const dir = dirname(p);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const line =
      JSON.stringify({ archivedAt: Date.now(), outcome, state }) + "\n";
    appendFileSync(p, line, "utf-8");
    // Cap: trim atomically when the file grows too large.
    try {
      if (statSync(p).size > MAX_ARCHIVE_SIZE) {
        trimArchive(p);
      }
    } catch {
      // Best-effort — lose the cap but not the data.
    }
    writeGoalHistorySnapshot(directory);
  } catch {
    // Best-effort — archive failure must never break a goal transition.
  }
}

function trimArchive(p: string): void {
  try {
    const raw = readFileSync(p, "utf-8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    if (lines.length <= TRIM_KEEP) return;
    const kept = lines.slice(-TRIM_KEEP);
    const tmp = `${p}.tmp.${process.pid}.${Date.now()}.${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    writeFileSync(tmp, kept.join("\n") + "\n", "utf-8");
    renameSync(tmp, p);
  } catch {
    // Best-effort — the file stays oversize until the user intervenes.
  }
}

/**
 * Read the archive, newest entries first. Corrupt (unparseable or
 * misshapen) lines are silently skipped and counted in `skippedCorrupt`.
 * Reads are capped at 2× MAX_ARCHIVE_SIZE to guard against disk-bomb
 * files. Returns `{ entries: [], skippedCorrupt: 0 }` on any error.
 */
export function readGoalArchive(
  directory: string,
  limit: number = 10,
): { entries: ArchiveEntry[]; skippedCorrupt: number } {
  const p = archivePath(directory);
  if (!existsSync(p)) return { entries: [], skippedCorrupt: 0 };
  try {
    if (statSync(p).size > MAX_ARCHIVE_SIZE * 2) {
      return { entries: [], skippedCorrupt: 0 };
    }
    const raw = readFileSync(p, "utf-8");
    const lines = raw.split("\n");
    const entries: ArchiveEntry[] = [];
    let skippedCorrupt = 0;
    for (let i = lines.length - 1; i >= 0 && entries.length < limit; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const entry = JSON.parse(line);
        if (
          entry &&
          typeof entry.archivedAt === "number" &&
          typeof entry.outcome === "string" &&
          entry.state
        ) {
          entries.push(entry as ArchiveEntry);
        } else {
          skippedCorrupt++;
        }
      } catch {
        skippedCorrupt++;
      }
    }
    return { entries, skippedCorrupt };
  } catch {
    return { entries: [], skippedCorrupt: 0 };
  }
}
