/**
 * opencode-autogoal — GUI integration helpers.
 *
 * This module provides the framework piece for GUI consumers (e.g. the
 * OpenCode Desktop "Goals" tab). It exports:
 *
 *   - `readGoalStateSafe(directory)`: wraps readGoalState with validation
 *     and returns a clean result object (never throws).
 *   - `createGoalWatcher(directory, callback)`: watches the goal state file
 *     for changes via fs.watch with a polling fallback. Returns a disposer.
 *   - `presentGoalState(state)`: formats a GoalState for display in a GUI
 *     context (icon, progress percentage, elapsed time, summary lines).
 *
 * These are the "blessed" API for any GUI layer that wants to render goal
 * state without hand-rolling polling, validation, and formatting.
 *
 * See docs/gui-integration.md for the full data contract.
 */

import {
  readGoalState,
  validateGoalState,
  sanitizeForPrompt,
  type GoalState,
  type GoalStatus,
} from "./goal-state.js";
import { watch, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// ── Re-exports ──────────────────────────────────────────────────────────────
// GUI consumers need access to the canonical validator and sanitizer.
export { validateGoalState } from "./goal-state.js";
export { sanitizeForPrompt } from "./goal-state.js";

// ── Safe read ───────────────────────────────────────────────────────────────

export interface GoalStateResult {
  /** The parsed and validated goal state, or null if no/missing/corrupt file. */
  state: GoalState | null;
  /** True when the state file existed but failed validation (corrupt). */
  corrupt: boolean;
  /** Human-readable description of the result. */
  summary: string;
}

/**
 * Read the goal state file and return a structured result. NEVER throws.
 * The caller gets `{ state, corrupt, summary }` — no try/catch needed.
 *
 * - state=null, corrupt=false → no state file (empty state).
 * - state=null, corrupt=true  → state file exists but is corrupt.
 * - state=GoalState           → valid state, terminal or not.
 */
export function readGoalStateSafe(directory: string): GoalStateResult {
  try {
    const path = join(directory, ".opencode", ".goal-state.json");
    if (!existsSync(path)) {
      return { state: null, corrupt: false, summary: "No goal set." };
    }
    const raw = readGoalState(directory);
    if (!raw) {
      // File existed at line 56 but may have been deleted by now
      // (TOCTOU). readGoalState returns null for both corrupt and
      // missing. Check existence again, handling ENOENT gracefully.
      try {
        const stat = statSync(path);
        if (stat.size === 0) {
          return { state: null, corrupt: false, summary: "Goal state file is empty." };
        }
      } catch {
        // statSync threw (likely ENOENT: file deleted between existsSync
        // and now). Treat as "no goal" — a missing file is less alarming
        // than a false "corrupt" signal. The next poll/watch will correct.
        return { state: null, corrupt: false, summary: "No goal set." };
      }
      // File exists, has content, but readGoalState rejected it (corrupt)
      return { state: null, corrupt: true, summary: "Goal state file is corrupt or oversized." };
    }
    return {
      state: raw,
      corrupt: false,
      summary: raw.status === "achieved"
        ? "Goal achieved."
        : raw.status === "cleared"
          ? "Goal cleared."
          : raw.status === "paused"
            ? `Goal paused: ${raw.condition.slice(0, 60)}`
            : `Active: ${raw.condition.slice(0, 60)}`,
    };
  } catch {
    return { state: null, corrupt: true, summary: "Failed to read goal state." };
  }
}

// ── File watcher ────────────────────────────────────────────────────────────

export type GoalStateListener = (result: GoalStateResult) => void;

export interface GoalWatcher {
  /** Stop watching. Idempotent — safe to call multiple times. */
  dispose: () => void;
  /** Force an immediate re-read and callback invocation. */
  refresh: () => void;
}

/**
 * Watch the goal state file for changes. Uses `fs.watch` as the primary
 * mechanism with a polling fallback (fs.watch is unreliable on some
 * platforms — NFS, WSL, Docker mounts). The callback fires on every
 * change AND on the initial read.
 *
 * The poll interval defaults to 2000ms (matching the spec's recommended
 * 2s polling interval in docs/gui-integration.md). Pass a different value
 * via `options.pollIntervalMs`.
 *
 * Returns a `GoalWatcher` with `dispose()` and `refresh()`.
 *
 * Usage:
 *   const w = createGoalWatcher("/path/to/project", (result) => {
 *     if (result.state) { renderActive(result.state); }
 *     else if (result.corrupt) { renderError(); }
 *     else { renderEmpty(); }
 *   });
 *   // later: w.dispose();
 */
export function createGoalWatcher(
  directory: string,
  callback: GoalStateListener,
  options?: { pollIntervalMs?: number },
): GoalWatcher {
  const pollInterval = options?.pollIntervalMs ?? 2000;
  let disposed = false;
  let watchHandle: ReturnType<typeof watch> | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  function readAndNotify() {
    if (disposed) return;
    try {
      const result = readGoalStateSafe(directory);
      callback(result);
    } catch {
      // Silent — the read function should never throw, but guard anyway.
    }
  }

  // Initial read
  readAndNotify();

  // Primary: fs.watch (fast, but unreliable on some platforms)
  const statePath = join(directory, ".opencode", ".goal-state.json");
  try {
    watchHandle = watch(statePath, (eventType) => {
      if (eventType === "change" || eventType === "rename") {
        readAndNotify();
      }
    });
  } catch {
    watchHandle = null; // watch failed; rely on polling fallback
  }

  // Fallback: polling interval
  pollTimer = setInterval(readAndNotify, pollInterval);

  return {
    dispose: () => {
      disposed = true;
      if (watchHandle) {
        try { watchHandle.close(); } catch { /* ignore */ }
        watchHandle = null;
      }
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    },
    refresh: () => {
      readAndNotify();
    },
  };
}

// ── Presenter ───────────────────────────────────────────────────────────────

export interface GoalPresentation {
  /** Icon/emoji representing the current status. */
  icon: string;
  /** Human-readable status label. */
  statusLabel: string;
  /** Progress percentage [0, 100]. */
  progressPct: number;
  /** "N/M turns" string. */
  turnsLabel: string;
  /** "Xm elapsed" string. */
  timeLabel: string;
  /** Formatted tokens string with thousands separators. */
  tokensLabel: string;
  /** The last evaluation reason (truncated to 120 chars), or null. */
  lastReason: string | null;
  /** Number of steering notes. */
  steeringCount: number;
  /** True when there's an unclaimed handoff (caller reads handoff separately). */
  hasHandoff: boolean;
  /** One-line summary suitable for a tooltip or header. */
  summaryLine: string;
}

/**
 * Present a GoalState as a flat structure suitable for GUI rendering.
 * All string fields are sanitized for display (no control chars,
 * no bidi overrides).
 *
 * Pass `handoffPresent=true` to set the handoff indicator.
 */
export function presentGoalState(
  state: GoalState,
  handoffPresent: boolean = false,
  now: number = Date.now(),
): GoalPresentation {
  const c = state.constraints;
  const turnsPct = c.maxTurns > 0
    ? Math.min(100, Math.round((state.turnsEvaluated / c.maxTurns) * 100))
    : 0;
  const elapsedMin = Math.max(0, Math.round((now - state.startedAt) / 60_000));
  const timePct = c.maxTimeMinutes > 0
    ? Math.min(100, Math.round((elapsedMin / c.maxTimeMinutes) * 100))
    : 0;
  const pct = Math.max(turnsPct, timePct);

  const statusLabel = statusToLabel(state.status);
  const icon = statusToIcon(state.status);
  const steeringCount = Array.isArray(state.metadata.steering)
    ? state.metadata.steering.length
    : 0;

  const lastReason = state.lastEvaluation?.reason
    ? sanitizeSummary(state.lastEvaluation.reason).slice(0, 120) || null
    : null;

  const summaryLine = `${icon} ${statusLabel}: ${sanitizeSummary(state.condition).slice(0, 80)} — ${state.turnsEvaluated}/${c.maxTurns} turns`;

  return {
    icon,
    statusLabel,
    progressPct: Math.min(100, Math.max(0, pct)),
    turnsLabel: `${state.turnsEvaluated}/${c.maxTurns} turns`,
    timeLabel: `${elapsedMin}m elapsed`,
    tokensLabel: formatTokenCount(state.tokensUsed),
    lastReason,
    steeringCount,
    hasHandoff: handoffPresent,
    summaryLine,
  };
}

// ── Internal helpers ────────────────────────────────────────────────────────

function statusToIcon(status: GoalStatus): string {
  switch (status) {
    case "active": return "🎯";
    case "paused": return "⏸";
    case "achieved": return "✅";
    case "cleared": return "🗑";
    default: return "❓"; // defensive: unknown status (shouldn't reach here after validation)
  }
}

function statusToLabel(status: GoalStatus): string {
  switch (status) {
    case "active": return "Active";
    case "paused": return "Paused";
    case "achieved": return "Achieved";
    case "cleared": return "Cleared";
    default: return "Unknown"; // defensive: unknown status
  }
}

/** Sanitize a string for display in the goal summary. Delegates to the
 *  canonical sanitizeForPrompt so the GUI display surface and the
 *  prompt-injection guard stay in lockstep (adversarial audit finding #3). */
function sanitizeSummary(s: string): string {
  return sanitizeForPrompt(s);
}

function formatTokenCount(n: number): string {
  if (!Number.isFinite(n)) return "0";
  return Math.trunc(n).toLocaleString();
}
