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
  parsePositiveInt,
  CONSTRAINT_BOUNDS,
  MAX_CONDITION_LEN,
  MAX_STEERING_LEN,
  type EditResult,
} from "./goal-state.js";

/** Result shape returned by the dial handlers. */
export type DialResult =
  | { ok: true; message: string }
  | { ok: false; reason: "invalid-input" | "no-goal" | "terminal-state" | "write-failed" | "already-empty" | "current-goal" | "no-handoff" | "handoff-exists" | "handoff-pending"; message: string };

// Re-export parsePositiveInt so the existing tests (which import it from
// "../dist/tui-dials-logic.js") continue to work. The implementation lives
// in goal-state.ts — single source of truth.
export { parsePositiveInt } from "./goal-state.js";

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

/**
 * Generic handler for numeric dials (turns / time / tokens). Replaces the
 * three copy-pasted bodies that had identical structure: parse → bounds
 * check → call primitive → map result. Collapses ~27 lines of duplicated
 * code into 3 short callers + this helper.
 *
 * The `bounds` parameter names a CONSTRAINT_BOUNDS key (e.g. "minTurns" pairs
 * with "maxTurns"). The error messages reference both bounds by reading
 * them at call time, so the values stay in sync with the primitive's clamp.
 */
function handleNumericDial(
  directory: string,
  rawValue: string,
  primitive: (dir: string, n: number) => EditResult,
  boundsKey: "minTurns" | "minMinutes" | "minTokens",
  unit: string,
): DialResult {
  const min = CONSTRAINT_BOUNDS[boundsKey];
  // Pure lookup — no regex, no cast. Each min-key maps deterministically
  // to its max-key counterpart in CONSTRAINT_BOUNDS.
  const MAX_KEY_MAP = {
    minTurns: "maxTurns",
    minMinutes: "maxMinutes",
    minTokens: "maxTokens",
  } as const satisfies Record<typeof boundsKey, keyof typeof CONSTRAINT_BOUNDS>;
  const maxKey = MAX_KEY_MAP[boundsKey];
  const max = CONSTRAINT_BOUNDS[maxKey];

  const n = parsePositiveInt(rawValue);
  if (n === null) {
    return { ok: false, reason: "invalid-input", message: `Enter a whole number of ${unit} between ${min} and ${max}.` };
  }
  if (n < min || n > max) {
    return { ok: false, reason: "invalid-input", message: `Out of range. ${unit.charAt(0).toUpperCase() + unit.slice(1)} must be in [${min}, ${max}].` };
  }
  return fromEditResult(primitive(directory, n));
}

/** Generic handler for string dials (condition / steer). Replaces 2 copy-pasted bodies. */
function handleStringDial(
  directory: string,
  rawValue: string,
  primitive: (dir: string, s: string) => EditResult,
  maxLen: number,
  noun: string,
): DialResult {
  if (typeof rawValue !== "string" || rawValue.trim().length === 0) {
    return { ok: false, reason: "invalid-input", message: `${noun} cannot be empty.` };
  }
  if (rawValue.length > maxLen) {
    return { ok: false, reason: "invalid-input", message: `${noun} is too long (${rawValue.length} chars; max ${maxLen}).` };
  }
  return fromEditResult(primitive(directory, rawValue));
}

/** Submit handler: "turns" dial. */
export function handleTurnsSubmit(directory: string, rawValue: string): DialResult {
  return handleNumericDial(directory, rawValue, editMaxTurns, "minTurns", "turns");
}

/** Submit handler: "time" dial. */
export function handleTimeSubmit(directory: string, rawValue: string): DialResult {
  return handleNumericDial(directory, rawValue, editMaxTime, "minMinutes", "minutes");
}

/** Submit handler: "tokens" dial. */
export function handleTokensSubmit(directory: string, rawValue: string): DialResult {
  return handleNumericDial(directory, rawValue, editMaxTokens, "minTokens", "tokens");
}

/**
 * Submit handler: "condition" dial.
 *
 * Accepts an optional `expectedId` for optimistic-concurrency control
 * (FIX-10). When the TUI opens the condition dial it captures the
 * current state.id; if the id has changed by the time the user submits
 * (because another session issued `/goal set`), the primitive refuses
 * with "stale-snapshot" and the user is told to re-review.
 *
 * We can't reuse the generic `handleStringDial` here because
 * `editCondition` has its `expectedId` parameter at the 4th position
 * (after `now`); the helper would put it at the 3rd position which
 * is `now`. So we inline the empty/length checks and call the
 * primitive directly.
 */
export function handleConditionSubmit(directory: string, rawValue: string, expectedId?: string): DialResult {
  if (typeof rawValue !== "string" || rawValue.trim().length === 0) {
    return { ok: false, reason: "invalid-input", message: "Condition cannot be empty." };
  }
  if (rawValue.length > MAX_CONDITION_LEN) {
    return { ok: false, reason: "invalid-input", message: `Condition is too long (${rawValue.length} chars; max ${MAX_CONDITION_LEN}).` };
  }
  return fromEditResult(editCondition(directory, rawValue, Date.now(), expectedId));
}

/** Submit handler: "steer" dial. */
export function handleSteerSubmit(directory: string, rawValue: string): DialResult {
  return handleStringDial(directory, rawValue, appendSteering, MAX_STEERING_LEN, "Steering note");
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
