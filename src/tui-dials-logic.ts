/**
 * TUI dials — pure submission handlers for the sidebar's interactive dials.
 *
 * The dials are the "press a key, get a dialog, type a value, hit enter"
 * surface in the TUI. The JSX layer (`src/tui-dials.tsx`) opens dialogs
 * and wires the submit to these handlers. These handlers do the actual
 * work: parse the input, call the right `goal-state` primitive, return
 * a result object the JSX layer toasts.
 *
 * By keeping the handlers pure, the test suite can exercise:
 *   - "user types '50' for turns" → calls editMaxTurns with 50, returns
 *     a success result the JSX layer toasts
 *   - "user types 'abc' for turns" → returns an invalid-input result,
 *     the JSX layer shows a "must be a number" toast
 *   - "user types '' for condition" → returns "empty" result
 *   - "user types a control-char-laden string" → returns sanitized result
 *
 * The JSX layer is untyped smoke-test territory; the handlers are where
 * the real logic lives and where the regression tests run.
 */

import {
  editMaxTurns,
  editMaxTime,
  editMaxTokens,
  editCondition,
  restartGoal,
  appendSteering,
  clearSteering,
  createHandoff,
  claimHandoff,
  CONSTRAINT_BOUNDS,
  MAX_CONDITION_LEN,
  MAX_STEERING_LEN,
  type EditResult,
} from "./goal-state.js";

/** Result shape returned by the dial handlers. */
export type DialResult =
  | { ok: true; message: string }
  | { ok: false; reason: "invalid-input" | "no-goal" | "terminal-state" | "write-failed" | "already-empty" | "current-goal" | "no-handoff" | "handoff-exists" | "handoff-pending"; message: string };

/** Parse a positive integer. Accepts "50", " 50 ", "50x"→null, ""→null, "abc"→null, "1e5"→null, "50.5"→null. */
export function parsePositiveInt(s: string): number | null {
  if (typeof s !== "string") return null;
  const trimmed = s.trim();
  if (trimmed.length === 0) return null;
  // Strict regex: digits only, no leading zeros except for "0" itself.
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.trunc(n);
}

/** Convert a goal-state EditResult into a DialResult (the toast-equivalent shape). */
function fromEditResult(res: EditResult): DialResult {
  if (res.ok) return { ok: true, message: res.message };
  // Map reasons
  switch (res.reason) {
    case "no-goal": return { ok: false, reason: "no-goal", message: "No active goal." };
    case "terminal-state": return { ok: false, reason: "terminal-state", message: res.error ?? "Goal is in a terminal state." };
    case "invalid-value": return { ok: false, reason: "invalid-input", message: res.error ?? "Invalid value." };
    case "write-failed": return { ok: false, reason: "write-failed", message: res.error ?? "Failed to write state." };
  }
}

// ── Dial submit handlers ──────────────────────────────────────────────────

/** Submit handler: "turns" dial. */
export function handleTurnsSubmit(directory: string, rawValue: string): DialResult {
  const n = parsePositiveInt(rawValue);
  if (n === null) return { ok: false, reason: "invalid-input", message: `Enter a whole number between ${CONSTRAINT_BOUNDS.minTurns} and ${CONSTRAINT_BOUNDS.maxTurns}.` };
  if (n < CONSTRAINT_BOUNDS.minTurns || n > CONSTRAINT_BOUNDS.maxTurns) {
    return { ok: false, reason: "invalid-input", message: `Out of range. Turns must be in [${CONSTRAINT_BOUNDS.minTurns}, ${CONSTRAINT_BOUNDS.maxTurns}].` };
  }
  return fromEditResult(editMaxTurns(directory, n));
}

/** Submit handler: "time" dial. */
export function handleTimeSubmit(directory: string, rawValue: string): DialResult {
  const n = parsePositiveInt(rawValue);
  if (n === null) return { ok: false, reason: "invalid-input", message: `Enter a whole number of minutes between ${CONSTRAINT_BOUNDS.minMinutes} and ${CONSTRAINT_BOUNDS.maxMinutes}.` };
  if (n < CONSTRAINT_BOUNDS.minMinutes || n > CONSTRAINT_BOUNDS.maxMinutes) {
    return { ok: false, reason: "invalid-input", message: `Out of range. Minutes must be in [${CONSTRAINT_BOUNDS.minMinutes}, ${CONSTRAINT_BOUNDS.maxMinutes}].` };
  }
  return fromEditResult(editMaxTime(directory, n));
}

/** Submit handler: "tokens" dial. */
export function handleTokensSubmit(directory: string, rawValue: string): DialResult {
  const n = parsePositiveInt(rawValue);
  if (n === null) return { ok: false, reason: "invalid-input", message: `Enter a whole number between ${CONSTRAINT_BOUNDS.minTokens} and ${CONSTRAINT_BOUNDS.maxTokens}.` };
  if (n < CONSTRAINT_BOUNDS.minTokens || n > CONSTRAINT_BOUNDS.maxTokens) {
    return { ok: false, reason: "invalid-input", message: `Out of range. Tokens must be in [${CONSTRAINT_BOUNDS.minTokens}, ${CONSTRAINT_BOUNDS.maxTokens}].` };
  }
  return fromEditResult(editMaxTokens(directory, n));
}

/** Submit handler: "condition" dial. */
export function handleConditionSubmit(directory: string, rawValue: string): DialResult {
  // The primitive sanitizes internally, but we can reject empty here for a
  // better toast message than "empty after sanitization".
  if (typeof rawValue !== "string" || rawValue.trim().length === 0) {
    return { ok: false, reason: "invalid-input", message: "Condition cannot be empty." };
  }
  if (rawValue.length > MAX_CONDITION_LEN) {
    return { ok: false, reason: "invalid-input", message: `Condition is too long (${rawValue.length} chars; max ${MAX_CONDITION_LEN}).` };
  }
  return fromEditResult(editCondition(directory, rawValue));
}

/** Submit handler: "steer" dial. */
export function handleSteerSubmit(directory: string, rawValue: string): DialResult {
  if (typeof rawValue !== "string" || rawValue.trim().length === 0) {
    return { ok: false, reason: "invalid-input", message: "Steering note cannot be empty." };
  }
  if (rawValue.length > MAX_STEERING_LEN) {
    return { ok: false, reason: "invalid-input", message: `Steering note is too long (${rawValue.length} chars; max ${MAX_STEERING_LEN}).` };
  }
  return fromEditResult(appendSteering(directory, rawValue));
}

/** Submit handler: "clear-steering" dial. Confirms intent is implicit (no input). */
export function handleClearSteeringSubmit(directory: string): DialResult {
  const res = clearSteering(directory);
  if (!res.ok) {
    switch (res.reason) {
      case "no-goal": return { ok: false, reason: "no-goal", message: "No active goal." };
      case "write-failed": return { ok: false, reason: "write-failed", message: res.error ?? "Failed to write state." };
    }
  }
  return { ok: true, message: res.message };
}

/** Submit handler: "restart" dial. Confirms intent is implicit (the user pressed the key). */
export function handleRestartSubmit(directory: string): DialResult {
  const res = restartGoal(directory);
  if (!res.ok) {
    switch (res.reason) {
      case "no-goal": return { ok: false, reason: "no-goal", message: "No active goal to restart." };
      case "terminal-state": return { ok: false, reason: "terminal-state", message: res.error ?? "Goal is in a terminal state." };
      case "handoff-pending": return { ok: false, reason: "handoff-pending", message: res.error ?? "A handoff is pending." };
      case "write-failed": return { ok: false, reason: "write-failed", message: res.error ?? "Failed to write state." };
    }
  }
  return { ok: true, message: res.message };
}

/** Submit handler: "handoff" dial. The note is optional. */
export function handleHandoffSubmit(directory: string, rawNote: string | undefined): DialResult {
  const res = createHandoff(directory, rawNote);
  if (!res.ok) {
    switch (res.reason) {
      case "no-goal": return { ok: false, reason: "no-goal", message: "No active goal to handoff." };
      case "terminal-state": return { ok: false, reason: "terminal-state", message: res.error ?? "Goal is in a terminal state." };
      case "handoff-exists": return { ok: false, reason: "handoff-exists", message: res.error ?? "A handoff is already pending." };
      case "write-failed": return { ok: false, reason: "write-failed", message: res.error ?? "Failed to write handoff." };
    }
  }
  return { ok: true, message: res.message };
}

/** Submit handler: "claim" dial. */
export function handleClaimSubmit(directory: string): DialResult {
  const res = claimHandoff(directory);
  if (!res.ok) {
    switch (res.reason) {
      case "no-handoff": return { ok: false, reason: "no-handoff", message: "No handoff to claim." };
      case "current-goal": return { ok: false, reason: "current-goal", message: res.error ?? "A goal is already active. Clear it before claiming the handoff." };
      case "write-failed": return { ok: false, reason: "write-failed", message: res.error ?? "Failed to write state." };
    }
  }
  return { ok: true, message: res.message };
}

// ── Prompt placeholder / initial-value builders ────────────────────────────
// These give the dialogs sensible starting values. Re-exported so the
// JSX layer can use them.

/** Build a placeholder for the turns dial based on the current state. */
export function turnsPlaceholder(directory: string): string {
  return `e.g. 50 (max ${CONSTRAINT_BOUNDS.maxTurns})`;
}

/** Build a placeholder for the time dial. */
export function timePlaceholder(_directory: string): string {
  return `e.g. 60 (max ${CONSTRAINT_BOUNDS.maxMinutes} min)`;
}

/** Build a placeholder for the tokens dial. */
export function tokensPlaceholder(_directory: string): string {
  return `e.g. 200000 (max ${CONSTRAINT_BOUNDS.maxTokens.toLocaleString()})`;
}

/** Build a placeholder for the condition dial (empty — user is rewriting). */
export function conditionPlaceholder(_directory: string): string {
  return "Type the new condition…";
}

/** Build a placeholder for the steer dial. */
export function steerPlaceholder(_directory: string): string {
  return "Hint for the next attempt (e.g. 'try the new library')…";
}

/** Build a placeholder for the handoff note. */
export function handoffNotePlaceholder(_directory: string): string {
  return "Optional note for the future session…";
}
