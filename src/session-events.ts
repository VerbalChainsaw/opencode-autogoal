/**
 * session-events.ts — append-only JSONL record of live session activity.
 *
 * The server plugin calls `appendSessionEvent` after every tool call
 * (tool-start, tool-end) and after every meaningful agent message.
 * The standalone TUI control center's Live Session pane reads the
 * same file via `readSessionEvents` and shows the activity stream
 * newest-first.
 *
 * File: `.opencode/.session-events.jsonl` (gitignored). One JSON
 * object per line; corrupt lines are silently skipped on read. The
 * file is capped at MAX_EVENTS_BYTES (2 MB) and MAX_EVENTS_LINES
 * (5000) — when either is exceeded, the file is atomically trimmed
 * to the newest MAX_EVENTS_LINES lines (tmp + rename, matching the
 * existing `goal-archive.ts` / `goal-state.ts` atomic-write pattern).
 *
 * Appending is best-effort: any failure (missing directory, disk
 * full, permission denied) is swallowed and logged via console.warn
 * so a tool execution is never blocked by a write error. The events
 * file is a UX feature, not a correctness requirement.
 *
 * The trim check runs on every append — O(N) in the line count, but
 * the cap is small (5000 lines, ~50 bytes each = 250 KB steady
 * state, 2 MB hard cap) so the work is bounded and the read path
 * stays O(1) under the cap.
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

export const SESSION_EVENTS_FILE = ".opencode/.session-events.jsonl";
export const MAX_EVENTS_LINES = 5000;
export const MAX_EVENTS_BYTES = 2 * 1024 * 1024; // 2 MB

export type SessionEventKind = "tool-start" | "tool-end" | "message";

export interface SessionEvent {
  /** ms epoch when the event happened. */
  at: number;
  kind: SessionEventKind;
  /** Tool name for tool-start/tool-end; absent for message. */
  tool?: string;
  /** Tool arguments (sanitized; do not include secrets). */
  args?: Record<string, unknown>;
  /** Tool execution duration in ms (tool-end only). */
  durationMs?: number;
  /** Tool exit status (tool-end only). */
  ok?: boolean;
  /** One-line summary (≤120 chars), safe to display. */
  summary?: string;
}

function eventsPath(directory: string): string {
  return join(directory, SESSION_EVENTS_FILE);
}

/**
 * Append a session event to the JSONL log. Best-effort: any failure
 * (missing directory, disk full, permission denied) is silently
 * swallowed (logged via console.warn at most). The caller proceeds
 * as if the event was never recorded.
 *
 * After the append, if the file exceeds MAX_EVENTS_LINES or
 * MAX_EVENTS_BYTES, the file is atomically trimmed to the newest
 * MAX_EVENTS_LINES lines. The trim is also best-effort.
 */
export function appendSessionEvent(
  directory: string,
  ev: SessionEvent,
): void {
  try {
    const path = eventsPath(directory);
    const dir = dirname(path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    // Single-line JSON. JSON.stringify cannot produce a literal newline,
    // and we never accept user input that contains a literal newline
    // here (the server plugin only feeds it fields it controls), so
    // newline injection through the args is bounded by the serializer.
    appendFileSync(path, JSON.stringify(ev) + "\n", "utf-8");
    trimIfNeeded(path);
  } catch (err) {
    // Best-effort. Log at warn level; never throw. The auto-loop MUST
    // NOT fail a tool execution because the events log is full or
    // unwritable — the events file is a UX feature, not a correctness
    // requirement.
    try {
      console.warn(`[opencode-autogoal] session-events append failed: ${(err as Error).message}`);
    } catch { /* console unavailable — ignore */ }
  }
}

/**
 * Read the events log, returning the events newest-first. Corrupt
 * JSONL lines are silently skipped (with a console.warn so a user
 * inspecting logs can see the drop).
 *
 * The `limit` parameter caps the number of returned events; the
 * default of 200 is well under MAX_EVENTS_LINES and matches the
 * Live Session pane's render capacity. Pass a higher limit for
 * archival reads; the hard ceiling is MAX_EVENTS_LINES.
 */
export function readSessionEvents(
  directory: string,
  limit: number = 200,
): SessionEvent[] {
  const path = eventsPath(directory);
  if (!existsSync(path)) return [];
  const out: SessionEvent[] = [];
  try {
    const text = readFileSync(path, "utf-8");
    // Split on any line terminator. JSONL is canonical \n but tolerate
    // CRLF (Windows) by stripping a trailing \r. We do NOT split with a
    // regex that drops empty trailing entries (Node's `String.split`
    // would drop them anyway; we just iterate).
    const lines = text.split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      const line = lines[i];
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        if (isValidSessionEvent(parsed)) {
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
      console.warn(`[opencode-autogoal] session-events read failed: ${(err as Error).message}`);
    } catch { /* ignore */ }
    return [];
  }
  return out;
}

// ── internals ────────────────────────────────────────────────────────────

/** Defensive shape check: every field read downstream must be present
 *  and well-typed. A corrupt log line with `at: "yesterday"` is
 *  rejected here, not at the caller's render site. */
function isValidSessionEvent(v: unknown): v is SessionEvent {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  if (typeof r.at !== "number" || !Number.isFinite(r.at)) return false;
  if (r.kind !== "tool-start" && r.kind !== "tool-end" && r.kind !== "message") return false;
  if (r.tool !== undefined && typeof r.tool !== "string") return false;
  if (r.durationMs !== undefined && typeof r.durationMs !== "number") return false;
  if (r.ok !== undefined && typeof r.ok !== "boolean") return false;
  if (r.summary !== undefined && typeof r.summary !== "string") return false;
  if (r.args !== undefined && (typeof r.args !== "object" || r.args === null || Array.isArray(r.args))) {
    return false;
  }
  return true;
}

function warnSkipped(reason: string): void {
  try {
    console.warn(`[opencode-autogoal] session-events line skipped (${reason})`);
  } catch { /* ignore */ }
}

/** If the file exceeds the line cap or the byte cap, atomically
 *  rewrite it to the newest MAX_EVENTS_LINES lines. Best-effort. */
function trimIfNeeded(path: string): void {
  try {
    const stat = statSync(path);
    if (stat.size <= MAX_EVENTS_BYTES) {
      // Cheap fast path: byte cap not exceeded. But we still need the
      // line cap check, so we always read.
    }
    const text = readFileSync(path, "utf-8");
    const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
    if (lines.length <= MAX_EVENTS_LINES && stat.size <= MAX_EVENTS_BYTES) {
      return; // under both caps
    }
    // Keep the last MAX_EVENTS_LINES lines.
    const keep = lines.slice(-MAX_EVENTS_LINES).join("\n") + "\n";
    // Atomic rename: write tmp + rename. Same pattern as the other
    // atomic-write helpers in this repo. Tmp suffix includes a
    // random UUID so concurrent writers (extremely unlikely for
    // events but possible across multiple server-plugin instances)
    // don't collide.
    const tmp = `${path}.tmp.${process.pid}.${randomUUID()}`;
    writeFileSync(tmp, keep, "utf-8");
    renameSync(tmp, path);
  } catch (err) {
    try {
      console.warn(`[opencode-autogoal] session-events trim failed: ${(err as Error).message}`);
    } catch { /* ignore */ }
  }
}
