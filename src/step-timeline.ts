/**
 * step-timeline.ts — append-only JSONL record of per-turn evaluations.
 *
 * The server plugin calls `appendStepTimelineEvent` after every
 * session.idle evaluation. The standalone TUI control center's Live
 * Session pane reads the same file via `readStepTimeline` and shows
 * the timeline (relative timestamps) below the live activity stream.
 *
 * File: `.opencode/.step-timeline.jsonl` (gitignored). One JSON object
 * per line; corrupt lines are silently skipped on read. The file is
 * capped at MAX_TIMELINE_BYTES (1 MB) and MAX_TIMELINE_LINES (1000) —
 * when either is exceeded, the file is atomically trimmed to the
 * newest MAX_TIMELINE_LINES lines (tmp + rename, matching the
 * existing `goal-archive.ts` / `session-events.ts` atomic-write
 * pattern).
 *
 * Appending is best-effort: any failure (missing directory, disk
 * full, permission denied) is swallowed (logged via console.warn) so
 * a tool execution is never blocked by a write error.
 *
 * No third-party imports — only Node builtins.
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
import { randomUUID } from "node:crypto";

export const STEP_TIMELINE_FILE = ".opencode/.step-timeline.jsonl";
export const MAX_TIMELINE_LINES = 1000;
export const MAX_TIMELINE_BYTES = 1 * 1024 * 1024; // 1 MB

export type StepOutcome = "met" | "blocked" | "in-progress";

export interface StepTimelineEvent {
  /** ms epoch when the evaluation happened. */
  at: number;
  /** 0-based turn index in the goal's run. */
  turn: number;
  /** One-line label (≤80 chars), safe to display. */
  label: string;
  outcome: StepOutcome;
  /** Optional reason (≤240 chars), only set when outcome is met or blocked. */
  reason?: string;
}

function timelinePath(directory: string): string {
  return join(directory, STEP_TIMELINE_FILE);
}

/**
 * Append a step-timeline event to the JSONL log. Best-effort: any
 * failure (missing directory, disk full, permission denied) is
 * silently swallowed (logged via console.warn). The caller proceeds
 * as if the event was never recorded.
 *
 * After the append, if the file exceeds MAX_TIMELINE_LINES or
 * MAX_TIMELINE_BYTES, the file is atomically trimmed to the newest
 * MAX_TIMELINE_LINES lines.
 */
export function appendStepTimelineEvent(
  directory: string,
  ev: StepTimelineEvent,
): void {
  try {
    const path = timelinePath(directory);
    const dir = dirname(path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    appendFileSync(path, JSON.stringify(ev) + "\n", "utf-8");
    trimIfNeeded(path);
  } catch (err) {
    try {
      console.warn(`[opencode-autogoal] step-timeline append failed: ${(err as Error).message}`);
    } catch { /* ignore */ }
  }
}

/**
 * Read the timeline log, returning events newest-first. Corrupt
 * JSONL lines are silently skipped (with a console.warn).
 *
 * The `limit` parameter caps the number of returned events; the
 * default of 50 matches the Live Session pane's render capacity
 * (the timeline is shorter than the activity stream). Pass a higher
 * limit for archival reads; the hard ceiling is MAX_TIMELINE_LINES.
 */
export function readStepTimeline(
  directory: string,
  limit: number = 50,
): StepTimelineEvent[] {
  const path = timelinePath(directory);
  if (!existsSync(path)) return [];
  const out: StepTimelineEvent[] = [];
  try {
    const text = readFileSync(path, "utf-8");
    const lines = text.split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      const line = lines[i];
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        if (isValidStepTimelineEvent(parsed)) {
          out.push(parsed);
        } else {
          warnSkipped("schema-invalid");
        }
      } catch {
        warnSkipped("parse-error");
      }
    }
  } catch (err) {
    try {
      console.warn(`[opencode-autogoal] step-timeline read failed: ${(err as Error).message}`);
    } catch { /* ignore */ }
    return [];
  }
  return out;
}

// ── internals ────────────────────────────────────────────────────────────

/** Defensive shape check. A corrupt log line with `outcome: 'maybe'`
 *  is rejected here, not at the caller's render site. */
function isValidStepTimelineEvent(v: unknown): v is StepTimelineEvent {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  if (typeof r.at !== "number" || !Number.isFinite(r.at)) return false;
  if (typeof r.turn !== "number" || !Number.isFinite(r.turn) || r.turn < 0) return false;
  if (typeof r.label !== "string") return false;
  if (r.outcome !== "met" && r.outcome !== "blocked" && r.outcome !== "in-progress") return false;
  if (r.reason !== undefined && typeof r.reason !== "string") return false;
  return true;
}

function warnSkipped(reason: string): void {
  try {
    console.warn(`[opencode-autogoal] step-timeline line skipped (${reason})`);
  } catch { /* ignore */ }
}

function trimIfNeeded(path: string): void {
  try {
    const stat = statSync(path);
    const text = readFileSync(path, "utf-8");
    const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
    if (lines.length <= MAX_TIMELINE_LINES && stat.size <= MAX_TIMELINE_BYTES) {
      return; // under both caps
    }
    const keep = lines.slice(-MAX_TIMELINE_LINES).join("\n") + "\n";
    const tmp = `${path}.tmp.${process.pid}.${randomUUID()}`;
    writeFileSync(tmp, keep, "utf-8");
    renameSync(tmp, path);
  } catch (err) {
    try {
      console.warn(`[opencode-autogoal] step-timeline trim failed: ${(err as Error).message}`);
    } catch { /* ignore */ }
  }
}
