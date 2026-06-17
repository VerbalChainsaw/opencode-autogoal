/**
 * TUI dashboard logic — pure, validated, unit-tested.
 *
 * This module owns the non-JSX surface of the TUI plugin: validated reads of
 * the goal state file, the progress-bar math, and the toggle/clear/confirm
 * decision functions. It exists separately from `tui.tsx` so the logic can
 * be exercised in a Node test runner without spinning up a JSX host.
 *
 * Everything that touches the state file is delegated to `goal-state.ts`
 * (which has the validated `readGoalState` + `transitionGoal` primitives).
 * This file does NOT re-implement the I/O — that was the cycle-0 bug class
 * (TUI's own readState bypassed validation, the TUI's own writeState silently
 * swallowed errors, and the two surfaces could drift apart).
 *
 * The shape exposed to the JSX layer is intentionally narrow: just
 * `readDashboardState`, `computeProgress`, `toggleGoal`, `clearGoal`. Each
 * returns a result object the JSX layer renders / toasts.
 */

import {
  readGoalState,
  transitionGoal,
  atomicToggle,
  type GoalState,
} from "./goal-state.js";

// Re-export GoalState so callers (e.g. tui.tsx, sidebar.tsx) can import the
// canonical type from a single place. tui-logic.ts is the public surface for
// the JSX layers; goal-state.ts is the engine.
export type { GoalState };

// ── Path / file-name constants ──────────────────────────────────────────────
// The state file name is part of the plugin's public contract (the upstream
// Desktop sidebar reads it too). Single source of truth, imported wherever
// a file watcher predicate needs to identify the state file.

export const STATE_FILE_NAME = ".goal-state.json";

/** True if `path` ends with the state file name. Used by the file-watcher
 *  subscription to filter the host's stream to just our file. */
export function isGoalStatePath(path: string): boolean {
  if (typeof path !== "string") return false;
  return path.endsWith(STATE_FILE_NAME);
}

// ── Multi-workspace directory resolution ────────────────────────────────────
// Goal state is per-workspace, not per-session. In a multi-workspace OpenCode,
// `api.state.path.directory` is the global default; the per-session directory
// (when the slot has a `session_id` prop) takes precedence. This helper makes
// the rule explicit and unit-testable; the JSX layer just calls it.

export function resolveSessionDirectory(
  session: { directory?: string } | undefined | null,
  defaultDirectory: string
): string {
  return session?.directory || defaultDirectory;
}

// ── Dashboard view-model ────────────────────────────────────────────────────
// A trimmed view of the goal state for the dashboard. We re-export only the
// fields the dashboard reads so a future schema change in the canonical
// GoalState doesn't silently break the JSX layer.

export interface DashboardView {
  /** Active or paused; null means "no goal to display". */
  state: GoalState | null;
}

export function readDashboardState(directory: string): DashboardView {
  const state = readGoalState(directory);
  if (!state) return { state: null };
  // v0.5.1: allow achieved/cleared states to be viewed in the TUI,
  // so the sidebar doesn't just "go blank" the moment a goal finishes.
  return { state };
}

// ── Progress math (extracted from the original render() so it's testable) ───
// The original dashboard computed `elapsed`/`pct`/`filled`/`bar` inline in the
// render function; the only behavior it had was clamping the bar to [0, 20]
// characters and the percentage to [0, 100]. Extracting it lets us assert
// the bounds directly (cycle-0 TUI crash: a corrupt state with negative
// turnsEvaluated produced a `Math.round(-1)` value that broke `"█".repeat(-1)`).

export interface ProgressBar {
  elapsedMinutes: number;
  pct: number;          // [0, 100]
  filledBlocks: number; // [0, 20]
  bar: string;          // 20 chars of "█" + "░"
}

export function computeProgress(state: GoalState, now: number = Date.now()): ProgressBar {
  // All inputs are validated by readGoalState (which calls validateGoalState)
  // before they reach this function, so a negative turnsEvaluated or a missing
  // constraints.maxTurns cannot reach here in production. The clamps below
  // are defense-in-depth — the dashboard should never NaN, never throw, and
  // never render a negative-length bar.
  const maxTurns = Math.max(1, state.constraints.maxTurns);
  const turns = Math.max(0, state.turnsEvaluated);
  const pct = Math.min(100, Math.max(0, Math.round((turns / maxTurns) * 100)));
  const filledBlocks = Math.min(20, Math.max(0, Math.round((pct / 100) * 20)));
  const filled = "█".repeat(filledBlocks);
  const empty = "░".repeat(20 - filledBlocks);
  const elapsedMinutes = Math.max(0, Math.round((now - state.startedAt) / 60_000));
  return { elapsedMinutes, pct, filledBlocks, bar: filled + empty };
}

// ── Toggle / clear / confirm ────────────────────────────────────────────────
// These mirror the server plugin's `transitionGoal` transitions. They do NOT
// re-implement the I/O; they delegate. The difference from the previous
// implementation: the new helpers return a result object the JSX layer can
// surface in a toast (success or error), instead of the old "always toast
// 'success' even when the write failed" anti-pattern.

export type ToggleResult =
  | { ok: true; newStatus: "active" | "paused"; message: string }
  | { ok: false; reason: "no-goal" | "terminal-state"; error?: string }
  | { ok: false; reason: "write-failed"; error: string };

export function toggleGoal(directory: string, now: number = Date.now()): ToggleResult {
  // Delegate to atomicToggle — the read-decide-write is a single atomic
  // write turn. Closes the read-outside-write race that caused user
  // mashing of /goal-toggle to lose half its keypresses.
  const res = atomicToggle(directory, now);
  if (res.ok) return { ok: true, newStatus: res.newStatus, message: res.message };
  // Atomic toggle distinguishes "no goal" from "terminal state" — preserve that
  // distinction in the result type. The `error` field is omitted on
  // no-goal/terminal-state (no upstream message to relay) and required on
  // write-failed (the caller wants the underlying error string).
  if (res.reason === "terminal-state") {
    return { ok: false, reason: "terminal-state", error: res.error };
  }
  if (res.reason === "write-failed") {
    return { ok: false, reason: "write-failed", error: res.error ?? "Failed to write state." };
  }
  return { ok: false, reason: "no-goal" };
}

export type ClearResult =
  | { ok: true }
  | { ok: false; reason: "no-goal" | "write-failed"; error?: string };

export function clearGoal(directory: string, now: number = Date.now()): ClearResult {
  // Delegate to transitionGoal which reads and writes in a single atomic
  // write turn. Previously this function had a pre-check (read outside
  // the write) that raced with concurrent state changes — removed in the
  // adversarial audit.
  const res = transitionGoal(directory, "clear", now);
  if (res.ok) return { ok: true };
  if (res.reason === "no-goal" || res.reason === "terminal-state") {
    return { ok: false, reason: "no-goal" };
  }
  return { ok: false, reason: "write-failed", error: res.error };
}
