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
 * `computeProgress`) and the dials from `goal-state.ts` (readHandoff, etc.) —
 * we do NOT re-read the state file ourselves. The dashboard, the sidebar,
 * and the dials all funnel through the same primitives, so they cannot drift.
 *
 * ── What the view-model is ──────────────────────────────────────────────────
 * The host renders three slots. We expose three strings:
 *   - title:   one line, status-emoji + truncated condition (or "no goal")
 *   - content: a compact block — progress bar, turn/time counters, last-reason,
 *              tokens used, steering count, handoff indicator,
 *              last 3 evaluations strip
 *   - footer:  hints for the keymap commands that act on the goal
 *
 * Strings, not JSX, so the tests can assert exact byte output.
 *
 * ── Truncation policy ───────────────────────────────────────────────────────
 * - title: 60 chars, with "…" if truncated. Fits a 60-col sidebar.
 * - content: variable-height (the host decides the box height; we feed
 *   it as many lines as we have)
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
import {
  readHandoff,
  readGoalStateResult,
  sanitizeForPrompt,
  type GoalState,
} from "./goal-state.js";

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
  /** v0.4.2 — true when the state file was corrupt on this read (the
   *  reader quarantined it as `.goal-state.json.corrupt.<ts>`). The JSX
   *  layer needs no special handling — title/content carry the warning —
   *  but the flag lets tests and future renderers branch on it. Absent
   *  on the normal paths (optional, so existing JSX is unaffected). */
  corrupt?: boolean;
}

// ── Sanitization helpers ────────────────────────────────────────────────────

/**
 * Sanitize a string for sidebar display. Delegates to the canonical
 * `sanitizeForPrompt` in goal-state.ts so the auto-loop's prompt-injection
 * guard and the sidebar's display surface stay in lockstep. Drops C0/C1,
 * Unicode format chars (zero-width, bidi overrides, line/para
 * separators), collapses whitespace. Anything that survives the sanitizer
 * here is exactly what the agent would see in the next nudge.
 */
export function sanitizeForSidebar(s: string): string {
  return sanitizeForPrompt(s);
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
  // v0.4.0: chain prefix
  const prefix = (state.metadata.chainStep !== undefined && state.metadata.chainTotal !== undefined)
    ? `Step ${state.metadata.chainStep + 1}/${state.metadata.chainTotal}: `
    : "";
  return icon + prefix + body;
}

// ── Content ─────────────────────────────────────────────────────────────────

/** Number of recent evaluations to show in the sidebar strip. */
const EVAL_STRIP_COUNT = 3;

/** Truncate a reason string for compact display in the eval strip. */
function compactReason(s: string, maxLen: number = 36): string {
  return truncate(sanitizeForSidebar(s) || "(empty)", maxLen);
}

/**
 * Build the `sidebar_content` slot content. Multi-line block, joined with
 * "\n". Format (variable height; lines beyond the host's clip are lost):
 *
 *   Line 1:   progress bar (20 chars) + " <pct>%"
 *   Line 2:   "turns:  <used>/<max>     time: <elapsed>/<max>m"
 *   Line 3:   "tokens: <used>/<max>    last:  <reason>"  (or "—" if no eval)
 *   Line 4:   "steer:  <count> notes   ⤴ handoff"      (if steering or handoff)
 *   Line 5:   "──── eval history ────"                 (if any evaluations)
 *   Line 6+:  "  • <truncated reason>" × 3             (most recent first)
 *   Last:     "last edit: <ts>"                       (if condition was edited)
 *
 * Lines are fixed-width-ish: we right-pad the label to 7 chars and let
 * the value run to the line's natural length. The host's slot decides the
 * box width and will wrap or clip as it sees fit; we just feed it the
 * compact summary.
 */
export function buildSidebarContent(
  state: GoalState | null,
  progress: ProgressBar | null,
  handoff: { createdAt: string; note?: string } | null,
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

  // Re-compute progress here if the caller didn't pass one.
  const p = progress ?? computeProgress(state, now);

  const maxTurns = state.constraints.maxTurns;
  const maxTime = state.constraints.maxTimeMinutes;
  const maxTokens = state.constraints.maxTokens;

  const turnsLine =
    padLabel("turns") +
    `${state.turnsEvaluated}/${maxTurns}` +
    "    " +
    padLabel("time") +
    `${p.elapsedMinutes}/${maxTime}m`;

  const lastReason = state.lastEvaluation?.reason;
  const lastLine =
    padLabel("tokens") +
    `${formatNumber(state.tokensUsed)}/${formatNumber(maxTokens)}` +
    "    " +
    padLabel("last") +
    (lastReason ? compactReason(lastReason, 24) : "—");

  const lines: string[] = [];
  lines.push(`${p.bar} ${pctPad(p.pct)}%`);
  lines.push(turnsLine);
  lines.push(lastLine);

  // Optional line 4: steering count + handoff indicator
  const steeringCount = Array.isArray(state.metadata.steering) ? state.metadata.steering.length : 0;
  const hasHandoff = handoff !== null;
  if (steeringCount > 0 || hasHandoff) {
    const parts: string[] = [];
    if (steeringCount > 0) parts.push(`${steeringCount} steer note${steeringCount === 1 ? "" : "s"}`);
    if (hasHandoff) parts.push("⤴ handoff");
    lines.push(padLabel("ctrl") + parts.join("   "));
  }

  // Optional: last 3 evaluations
  const history = Array.isArray(state.evaluationHistory) ? state.evaluationHistory : [];
  if (history.length > 0) {
    lines.push("──── eval history ────");
    const recent = history.slice(-EVAL_STRIP_COUNT).reverse();
    for (const ev of recent) {
      const tag = ev.met ? "✓" : ev.blocked ? "!" : "·";
      lines.push(`  ${tag} ${compactReason(ev.reason || "(empty)", 48)}`);
    }
  }

  // Optional: last condition edit timestamp
  const editedAt = state.metadata.conditionEditedAt;
  if (typeof editedAt === "number" && editedAt > 0) {
    lines.push(`last edit: ${formatRelative(editedAt, now)}`);
  }

  return lines.join("\n");
}

/** Format a number with thousands separators (locale-independent — uses commas). */
function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return "0";
  return Math.trunc(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Format a timestamp as a relative time ("3m ago", "2h ago", "5d ago", or "just now"). */
function formatRelative(ts: number, now: number): string {
  const diff = now - ts;
  if (diff < 0) return "in the future";
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
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
 * The footer is the user's at-a-glance reference for the goal-loop
 * surface. It lists the four "quick action" commands the user reaches
 * for most often (steer, pause, jump out, jump back in) plus the
 * four dial commands. The CLI also exposes all of these; the README
 * has the mapping.
 *
 *   "q:  /goal-steer · /goal-toggle · /goal-clear · /goal-condition"
 *
 * If there's a pending handoff, we hint at /goal-claim.
 * If the current goal is active, /goal-toggle pauses it; if paused,
 * the same command resumes. The "pause/resume" line is intentionally
 * collapsed to a single "toggle" verb — the user can read the active
 * state from the title icon (🎯 vs ⏸).
 *
 * Truncated to 80 chars with "…" if the host's footer slot is narrower.
 */
export function buildSidebarFooter(directory: string, handoff: { createdAt: string; note?: string } | null = null): string {
  const base = "q:  /goal-steer · /goal-toggle · /goal-clear · /goal-condition";
  if (handoff) {
    return truncate(base + " · /goal-claim", FOOTER_MAX);
  }
  return truncate(base, FOOTER_MAX);
}

// ── Top-level view-model ────────────────────────────────────────────────────

/**
 * Build the full SidebarView for a given directory. Top-level entry point
 * the JSX layer calls. Returns:
 *   - hasGoal = false, isPaused = false  → empty-state view
 *   - hasGoal = true,  isPaused = false  → active goal view
 *   - hasGoal = true,  isPaused = true   → paused goal view
 *
 * Reads the handoff file (if any) so the sidebar can display the
 * handoff indicator without the JSX layer needing to know about it.
 *
 * The `now` parameter is forwarded to computeProgress for testability.
 */
export function buildSidebarView(directory: string, now: number = Date.now()): SidebarView {
  // v0.4.2 — surface a corrupt state file instead of rendering the
  // empty-state ("no goal") view, which silently hid the corruption.
  // This read is the one that quarantines the file (renames it to
  // `.goal-state.json.corrupt.<ts>`), so the corrupt view shows for one
  // render pass and subsequent passes see "absent" — by then the user
  // has the toast-equivalent warning and the artifact on disk. The
  // double read on the healthy path (this + readDashboardState below)
  // costs one extra file read per state change; the JSX layer's
  // mtime-keyed view cache makes that per-change, not per-frame.
  const stateResult = readGoalStateResult(directory);
  if (stateResult.kind === "corrupt") {
    return {
      title: truncate("⚠ GOAL — state file corrupt", TITLE_MAX),
      content: [
        "The goal state file was corrupt and has been",
        "quarantined as .goal-state.json.corrupt.<ts>",
        "in .opencode/ for inspection.",
        "",
        'Set a new goal with /goal set "<condition>".',
      ].join("\n"),
      footer: buildSidebarFooter(directory, null),
      hasGoal: false,
      isPaused: false,
      corrupt: true,
    };
  }
  const dashboard = readDashboardState(directory);
  const handoff = readHandoff(directory);
  const handoffView = handoff ? { createdAt: handoff.createdAt, note: handoff.note } : null;
  if (!dashboard.state) {
    return {
      title: buildSidebarTitle(null),
      content: buildSidebarContent(null, null, handoffView, now),
      footer: buildSidebarFooter(directory, handoffView),
      hasGoal: false,
      isPaused: false,
    };
  }
  const state = dashboard.state;
  const progress = computeProgress(state, now);
  return {
    title: buildSidebarTitle(state),
    content: buildSidebarContent(state, progress, handoffView, now),
    footer: buildSidebarFooter(directory, handoffView),
    hasGoal: true,
    isPaused: state.status === "paused",
  };
}
