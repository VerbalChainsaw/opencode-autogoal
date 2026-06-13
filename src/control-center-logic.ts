/**
 * control-center-logic.ts — the PURE heart of the interactive TUI control
 * center. No I/O, no ANSI cursor moves, no timers — every function here is a
 * deterministic transform that the impure shell (control-center.ts) drives.
 * This split mirrors the existing tui-logic.ts / tui.tsx separation and is
 * what makes the TUI unit-testable without a pseudo-terminal.
 *
 * Four pieces:
 *   - buildControlModel : GoalStateResult (+ chain/handoff/now) → flat view model
 *   - renderFrame       : model + size + styler → array of content lines
 *   - keyToAction       : a keypress + mode + status → an Action (or null no-op)
 *   - reduceInput       : the inline line-editor reducer (char/backspace/cursor)
 */

import { presentGoalState, sanitizeForPrompt, type GoalStateResult } from "./gui.js";
import type { GoalStatus } from "./goal-state.js";
import { truncate, type Styler } from "./format.js";

export type ControlKind = "active" | "paused" | "achieved" | "cleared" | "corrupt" | "absent";

export interface ControlModel {
  kind: ControlKind;
  icon: string;
  statusLabel: string;
  condition: string;
  progressPct: number;
  turnsLabel: string;
  timeLabel: string;
  tokensLabel: string;
  lastReason: string | null;
  evalStrip: Array<{ met: boolean; blocked: boolean }>;
  steering: string[];
  chain: { current: number; total: number } | null;
  corruptArtifact: string | null;
  summary: string;
  command: string | null;
}

export interface BuildOpts {
  handoffPresent?: boolean;
  corruptArtifact?: string | null;
  now?: number;
}

/** Assemble a flat, display-ready model from a goal-state read result. Reuses
 *  `presentGoalState` so the dashboard, sidebar, and `watch` share one
 *  view-model truth; corrupt/absent get their own minimal shapes. */
export function buildControlModel(result: GoalStateResult, opts: BuildOpts = {}): ControlModel {
  const now = opts.now ?? Date.now();
  const blank: ControlModel = {
    kind: "absent", icon: "○", statusLabel: "No goal", condition: "", progressPct: 0,
    turnsLabel: "", timeLabel: "", tokensLabel: "", lastReason: null, evalStrip: [],
    steering: [], chain: null, corruptArtifact: null, summary: result.summary ?? "", command: null,
  };

  if (result.corrupt) {
    return { ...blank, kind: "corrupt", icon: "⚠", statusLabel: "Corrupt", corruptArtifact: opts.corruptArtifact ?? null };
  }
  if (!result.state) {
    return { ...blank, summary: result.summary || "No goal set." };
  }

  const s = result.state;
  const p = presentGoalState(s, opts.handoffPresent ?? false, now);
  const evalStrip = (s.evaluationHistory ?? []).slice(-3).map((e) => ({ met: !!e.met, blocked: !!e.blocked }));
  const steering = Array.isArray(s.metadata.steering)
    ? s.metadata.steering.map((n: { at: number; note: string }) => sanitizeForPrompt(n.note ?? ""))
    : [];

  return {
    kind: s.status as ControlKind,
    icon: p.icon,
    statusLabel: p.statusLabel,
    condition: sanitizeForPrompt(s.condition),
    progressPct: p.progressPct,
    turnsLabel: p.turnsLabel,
    timeLabel: p.timeLabel,
    tokensLabel: p.tokensLabel,
    lastReason: p.lastReason,
    evalStrip,
    steering,
    chain: p.chainStep,
    corruptArtifact: null,
    summary: result.summary ?? "",
    command: typeof s.command === "string" ? sanitizeForPrompt(s.command) : null,
  };
}

// ── Rendering ────────────────────────────────────────────────────────────────

function statusColor(st: Styler, kind: ControlKind): (s: string) => string {
  switch (kind) {
    case "active": return st.green;
    case "paused": return st.yellow;
    case "achieved": return st.cyan;
    case "cleared": return st.gray;
    case "corrupt": return st.red;
    default: return st.gray;
  }
}

function footerFor(kind: ControlKind): string {
  if (kind === "active" || kind === "paused") {
    return "[p]ause [s]teer [e]dit [R]estart [c]lear [?]help [q]uit";
  }
  if (kind === "absent") return "[n]ew goal [C]laim [?]help [q]uit";
  return "[n]ew goal [?]help [q]uit";
}

/** Trim the frame to at most `height` lines, always preserving the footer
 *  (last line) so the keybar never scrolls off. */
function fit(lines: string[], height: number): string[] {
  if (height <= 0) return [];
  if (lines.length <= height) return lines;
  if (height === 1) return [lines[lines.length - 1]!];
  return [...lines.slice(0, height - 1), lines[lines.length - 1]!];
}

/**
 * Render the control model into content lines, each clamped to `width` and
 * styled via `st` (pass `createStyler(false)` for plain output). Whole lines
 * are colorized — never partial spans — so clamping can never sever an SGR
 * sequence. The shell adds the cursor moves / alt-screen around these lines.
 */
export function renderFrame(model: ControlModel, width: number, height: number, st: Styler): string[] {
  const lines: string[] = [];
  const push = (text: string, color?: (s: string) => string): void => {
    const clamped = truncate(text ?? "", width);
    lines.push(color ? color(clamped) : clamped);
  };

  if (model.kind === "corrupt") {
    push(`${model.icon} Goal state file is corrupt`, st.red);
    if (model.summary) push(model.summary, st.dim);
    if (model.corruptArtifact) push(`Quarantined: ${model.corruptArtifact}`, st.dim);
    push("");
    push("Press [n] to set a new goal.");
    push("");
    push(footerFor("corrupt"), st.dim);
    return fit(lines, height);
  }

  if (model.kind === "absent") {
    push(`${model.icon} No goal set.`, st.dim);
    push("");
    push("Press [n] to set a new goal.");
    push("");
    push(footerFor("absent"), st.dim);
    return fit(lines, height);
  }

  // active / paused / achieved / cleared
  push(`${model.icon} ${model.statusLabel}  ${model.condition}`, statusColor(st, model.kind));
  push("");
  const barW = Math.max(4, Math.min(width - 8, 30));
  const filled = Math.max(0, Math.min(barW, Math.round((model.progressPct / 100) * barW)));
  push(`${"█".repeat(filled)}${"░".repeat(barW - filled)} ${model.progressPct}%`);
  push(`${model.turnsLabel} · ${model.timeLabel} · ${model.tokensLabel} tokens`, st.dim);
  push(`Last: ${model.lastReason ?? "none yet"}`);
  if (model.evalStrip.length) {
    push(`Evals: ${model.evalStrip.map((e) => (e.blocked ? "!" : e.met ? "✓" : "·")).join(" ")}`, st.dim);
  }
  if (model.command) push(`Verify: ${model.command}`, st.dim);
  if (model.chain) push(`Chain: step ${model.chain.current + 1}/${model.chain.total}`, st.dim);
  if (model.steering.length) {
    push("");
    push(`Steering (${model.steering.length}):`, st.bold);
    for (const note of model.steering) push(`  • ${note}`);
  }
  push("");
  push(footerFor(model.kind), st.dim);
  return fit(lines, height);
}

// ── Key → action ─────────────────────────────────────────────────────────────

export type Mode = "normal" | "input" | "confirm";

export type Action =
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "clear" }
  | { kind: "restart" }
  | { kind: "handoff" }
  | { kind: "claim" }
  | { kind: "scrollUp" }
  | { kind: "scrollDown" }
  | { kind: "help" }
  | { kind: "quit" }
  | { kind: "confirmYes" }
  | { kind: "confirmNo" }
  | { kind: "prompt"; field: "steer" | "condition" | "turns" | "time" | "tokens" | "set" };

export interface Key {
  name?: string;
  sequence?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
}

/** The single printable character a key represents, honoring shift, or null
 *  for control/navigation keys. Falls back to `name` when `sequence` is absent
 *  (the test harness supplies bare `{name}` keys; real readline supplies both). */
function effectiveChar(key: Key): string | null {
  if (typeof key.sequence === "string" && key.sequence.length === 1) {
    const code = key.sequence.charCodeAt(0);
    if (code >= 0x20 && code !== 0x7f) return key.sequence;
  }
  if (typeof key.name === "string" && key.name.length === 1) {
    return key.shift ? key.name.toUpperCase() : key.name;
  }
  return null;
}

/**
 * Map a keypress to an Action given the UI mode and the goal's status. Returns
 * null for unbound keys and for actions that don't apply to the current status
 * (e.g. pausing an already-achieved goal) — the shell treats null as a no-op.
 * ctrl-c always quits, in any mode, as a hard escape hatch.
 */
export function keyToAction(key: Key, mode: Mode, status: GoalStatus | "absent"): Action | null {
  if (key.ctrl && key.name === "c") return { kind: "quit" };

  if (mode === "confirm") {
    const ch = effectiveChar(key);
    if (ch && ch.toLowerCase() === "y") return { kind: "confirmYes" };
    if ((ch && ch.toLowerCase() === "n") || key.name === "escape") return { kind: "confirmNo" };
    return null;
  }

  if (mode === "input") return null; // text handled by reduceInput

  // normal mode — navigation/control keys by name first
  switch (key.name) {
    case "up": case "pageup": return { kind: "scrollUp" };
    case "down": case "pagedown": return { kind: "scrollDown" };
    case "escape": return { kind: "quit" };
  }

  const mutable = status === "active" || status === "paused";
  const ch = effectiveChar(key);
  if (ch === null) return null;
  switch (ch) {
    case "q": return { kind: "quit" };
    case "?": return { kind: "help" };
    case "p": return status === "active" ? { kind: "pause" } : status === "paused" ? { kind: "resume" } : null;
    case "s": return mutable ? { kind: "prompt", field: "steer" } : null;
    case "e": return mutable ? { kind: "prompt", field: "condition" } : null;
    case "t": return mutable ? { kind: "prompt", field: "turns" } : null;
    case "m": return mutable ? { kind: "prompt", field: "time" } : null;
    case "k": return mutable ? { kind: "prompt", field: "tokens" } : null;
    case "c": return mutable ? { kind: "clear" } : null;
    case "n": return { kind: "prompt", field: "set" };
    case "H": return mutable ? { kind: "handoff" } : null;
    case "C": return { kind: "claim" };
    case "R": return mutable ? { kind: "restart" } : null;
    default: return null;
  }
}

// ── Inline line editor ───────────────────────────────────────────────────────

export interface InputState {
  value: string;
  cursor: number;
  done: "submit" | "cancel" | null;
}

/** Pure reducer for the bottom-of-screen text prompt (steer/condition/dials/
 *  set). Handles printable insertion at the cursor, backspace, left/right, and
 *  submit/cancel; unhandled keys return the state unchanged. */
export function reduceInput(state: InputState, key: Key): InputState {
  if (key.name === "return" || key.name === "enter") return { ...state, done: "submit" };
  if (key.name === "escape") return { ...state, done: "cancel" };
  if (key.name === "backspace") {
    if (state.cursor === 0) return state;
    const value = state.value.slice(0, state.cursor - 1) + state.value.slice(state.cursor);
    return { value, cursor: state.cursor - 1, done: null };
  }
  if (key.name === "left") return { ...state, cursor: Math.max(0, state.cursor - 1) };
  if (key.name === "right") return { ...state, cursor: Math.min(state.value.length, state.cursor + 1) };

  const ch = (typeof key.sequence === "string" && key.sequence.length === 1)
    ? key.sequence
    : (typeof key.name === "string" && key.name.length === 1 ? key.name : null);
  if (ch !== null) {
    const code = ch.charCodeAt(0);
    if (code >= 0x20 && code !== 0x7f) {
      const value = state.value.slice(0, state.cursor) + ch + state.value.slice(state.cursor);
      return { value, cursor: state.cursor + 1, done: null };
    }
  }
  return state;
}
