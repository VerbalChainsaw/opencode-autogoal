/**
 * opencode-autogoal — sidebar pure logic.
 *
 * The sidebar (a sibling TUI plugin in `src/sidebar.tsx`) is a JSX layer that
 * registers against the OpenCode host's `sidebar_title` / `sidebar_content` /
 * `sidebar_footer` slot map. JSX modules cannot be loaded in `node --test`,
 * so the non-JSX surface lives here: it builds a small view-model from a
 * goal state, and the JSX layer just renders the view-model.
 *
 * The sidebar reuses the validated I/O from `tui-logic.ts` (`readDashboardState`,
 * `computeProgress`) — we do NOT re-read the state file ourselves. The
 * dashboard and the sidebar are now guaranteed to see the same state,
 * because they go through the same read primitive.
 *
 * ── What the view-model is ──────────────────────────────────────────────────
 * The host renders three slots. We expose three strings:
 *   - title:   one line, status-emoji + truncated condition (or "no goal")
 *   - content: a compact block — progress bar, turn/time counters, last-reason
 *   - footer:  hints for the keymap commands that act on the goal
 *
 * Strings, not JSX, so the tests can assert exact byte output.
 *
 * ── Truncation policy ───────────────────────────────────────────────────────
 * - title: 60 chars, with "…" if truncated. Fits a 60-col sidebar.
 * - content: 6 fixed lines (no truncation; the host's slot decides the
 *   height — if it truncates, that's its decision).
 * - footer: 1 line, 80 chars.
 *
 * ── Defensive depth ─────────────────────────────────────────────────────────
 * - A corrupt state becomes `null` upstream (in readDashboardState). The
 *   "no goal" branch of buildSidebarView is reachable in production, not
 *   just a test-only fallback.
 * - The progress bar / elapsed time are reused from tui-logic; both modules
 *   funnel through computeProgress, which clamps. We do NOT recompute
 *   those numbers here.
 * - All string fields are sanitized for the case where the condition
 *   contains newlines, ANSI codes, or non-printable characters. Newlines
 *   become spaces; non-printables are dropped. The condition lives in a
 *   user-controlled state file; the sidebar should never let a hostile
 *   condition break its layout.
 */

import {
  readDashboardState,
  computeProgress,
  type ProgressBar,
} from "./tui-logic.js";
import type { GoalState } from "./goal-state.js";

/** Title truncation. ~60 cols in a typical terminal sidebar. */
const TITLE_MAX = 60;

/** Footer truncation. 80 cols is enough for a command hint. */
const FOOTER_MAX = 80;

export interface SidebarView {
  /** Slot 1: `sidebar_title`. One line. */
  title: string;
  /** Slot 2: `sidebar_content`. Multiple lines, joined with "\n" by the JSX. */
  content: string;
  /** Slot 3: `sidebar_footer`. One line of keymap hints. */
  footer: string;
  /** True when there is an active (or paused) goal. Used by the JSX to
   *  decide whether to show the "no goal" empty-state vs the live view. */
  hasGoal: boolean;
  /** True when the goal is paused (different icon). */
  isPaused: boolean;
}

// ── Sanitization helpers ────────────────────────────────────────────────────

/**
 * Sanitize a string for sidebar display. The condition is user-controlled
 * (lives in `.opencode/.goal-state.json`); a malicious condition could
 * contain newlines, ANSI escape codes, or control characters that would
 * break the sidebar's box layout. We:
 *   - Replace newlines and tabs with spaces (single-line slot)
 *   - Drop non-printable ASCII (< 0x20 except space, 0x7f)
 *   - Drop C1 control range (U+0080..U+009F)
 *   - Leave unicode (emoji, CJK) alone — those are printable
 *   - Collapse runs of spaces to a single space
 *   - Trim leading/trailing whitespace
 */
export function sanitizeForSidebar(s: string): string {
  if (typeof s !== "string" || s.length === 0) return "";
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code === 0x09 || code === 0x0a || code === 0x0d) {
      out += " ";
    } else if (code < 0x20 || code === 0x7f) {
      // drop
    } else if (code >= 0x80 && code <= 0x9f) {
      // drop C1 control range
    } else {
      out += s[i];
    }
  }
  return out.replace(/ {2,}/g, " ").trim();
}

/** Truncate a string to maxLen chars, appending "…" if shortened. */
export function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  if (maxLen <= 1) return "…";
  return s.slice(0, maxLen - 1) + "…";
}

// ── Title ───────────────────────────────────────────────────────────────────

/**
 * Build the `sidebar_title` slot content. Format:
 *   - No goal:        "🎯 no goal"
 *   - Active goal:    "🎯 <truncated condition>"
 *   - Paused goal:    "⏸ <truncated condition>"
 *
 * The condition is sanitized (newlines → spaces) and truncated to 60 chars.
 */
export function buildSidebarTitle(state: GoalState | null): string {
  if (!state) return "🎯 no goal";
  const icon = state.status === "paused" ? "⏸ " : "🎯 ";
  const raw = sanitizeForSidebar(state.condition);
  const body = truncate(raw || "(empty condition)", TITLE_MAX);
  return icon + body;
}

// ── Content ─────────────────────────────────────────────────────────────────

/**
 * Build the `sidebar_content` slot content. Multi-line block, joined with
 * "\n". Format:
 *   Line 1: progress bar (20 chars) + " <pct>%"
 *   Line 2: "turns  <used>/<max>     time  <elapsed>/<max>m"
 *   Line 3: "last:  <lastEvaluation.reason>"   (or "last:  —" if no eval)
 *   Line 4: "cond:  <condition, truncated>"     (only if no progress reason)
 *
 * Lines are fixed-width-ish: we right-pad the label to 7 chars and let
 * the value run to the line's natural length. The host's slot decides the
 * box width and will wrap or clip as it sees fit; we just feed it the
 * compact 3-4 line summary.
 */
export function buildSidebarContent(
  state: GoalState | null,
  progress: ProgressBar | null,
  now: number = Date.now()
): string {
  if (!state) {
    return [
      "(no active goal)",
      "",
      "Set one with /goal set",
      "or by saying",
      '"keep going until…"',
    ].join("\n");
  }

  // Re-compute progress here if the caller didn't pass one (so this fn
  // is also usable from a JSX layer that hasn't called computeProgress).
  const p = progress ?? computeProgress(state, now);

  const maxTurns = state.constraints.maxTurns;
  const maxTime = state.constraints.maxTimeMinutes;
  const turnsLine =
    padLabel("turns") +
    `${state.turnsEvaluated}/${maxTurns}` +
    "    " +
    padLabel("time") +
    `${p.elapsedMinutes}/${maxTime}m`;

  const lastReason = state.lastEvaluation?.reason;
  const lastLine = padLabel("last") + (lastReason ? sanitizeForSidebar(lastReason) : "—");

  const lines: string[] = [];
  lines.push(`${p.bar} ${pctPad(p.pct)}%`);
  lines.push(turnsLine);
  lines.push(lastLine);
  return lines.join("\n");
}

function padLabel(label: string): string {
  // Right-pad to 7 chars (so values align in monospace). The label + ": "
  // is 7 chars for the longest ("tokens:" is 7, "turns:" is 6+1, etc).
  return (label + ":").padEnd(7, " ");
}

function pctPad(pct: number): string {
  // Right-align to 3 chars: "  0%", " 50%", "100%". Cosmetic.
  return String(pct).padStart(3, " ");
}

// ── Footer ──────────────────────────────────────────────────────────────────

/**
 * Build the `sidebar_footer` slot content. Single-line keymap hint.
 *
 * The actual keymap is registered by `tui.tsx`; this footer just tells the
 * user "these commands exist" without claiming specific bindings (the
 * OpenCode TUI binds them via command palette, not as primary keychords).
 *
 * Format: "commands:  /goal · /goal-toggle · /goal-clear"
 *
 * Truncated to 80 chars with "…" if the host's footer slot is narrower.
 */
export function buildSidebarFooter(): string {
  return truncate("commands:  /goal · /goal-toggle · /goal-clear", FOOTER_MAX);
}

// ── Top-level view-model ────────────────────────────────────────────────────

/**
 * Build the full SidebarView for a given directory. Top-level entry point
 * the JSX layer calls. Returns:
 *   - hasGoal = false, isPaused = false  → empty-state view
 *   - hasGoal = true,  isPaused = false  → active goal view
 *   - hasGoal = true,  isPaused = true   → paused goal view
 *
 * The `now` parameter is forwarded to computeProgress for testability.
 */
export function buildSidebarView(directory: string, now: number = Date.now()): SidebarView {
  const dashboard = readDashboardState(directory);
  if (!dashboard.state) {
    return {
      title: buildSidebarTitle(null),
      content: buildSidebarContent(null, null, now),
      footer: buildSidebarFooter(),
      hasGoal: false,
      isPaused: false,
    };
  }
  const state = dashboard.state;
  const progress = computeProgress(state, now);
  return {
    title: buildSidebarTitle(state),
    content: buildSidebarContent(state, progress, now),
    footer: buildSidebarFooter(),
    hasGoal: true,
    isPaused: state.status === "paused",
  };
}
