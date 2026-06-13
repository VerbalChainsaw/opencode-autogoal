/**
 * control-center-pane.ts — pure layout primitive for the TUI control
 * center's three-pane shell.
 *
 * Takes a list of named regions (header / goal / session / keybar),
 * each with its content lines and a focusable flag, plus a terminal
 * size, and returns the joined output lines + a hit-test map + the
 * layout mode + the focus index. **No I/O, no state** — the TUI
 * shell builds the pane contents from the model and delegates the
 * layout to this module. This split mirrors the v0.6.0
 * `control-center-logic.ts` (pure) / `control-center.ts` (impure
 * shell) separation and is what makes the layout unit-testable
 * without a pseudo-terminal.
 *
 * ── LAYOUT MODES ─────────────────────────────────────────────────────────
 *
 * Three modes, selected by `pickLayoutMode(width, height, hasSession)`:
 *
 *   - "stack"   (default; width ≥ 80 AND height ≥ 16 AND hasSession):
 *     ┌─ header ──────────────────────────────────────┐
 *     │  GOAL pane (left, ~60% width) │ SESSION pane    │
 *     │  ...                          │  ...           │
 *     ├─ keybar ───────────────────────────────────────┤
 *     The two panes share the body rows, separated by a
 *     vertical rule (│). Hit-test: a click at (col < split) goes
 *     to the goal pane; (col ≥ split) goes to the session pane.
 *
 *   - "stacked" (width < 80):
 *     ┌─ header ──┐
 *     │ GOAL      │
 *     │ SESSION   │
 *     │ keybar    │
 *     Single column, no horizontal split. Hit-test: the row's
 *     owning pane.
 *
 *   - "compact" (height < 16 OR no session content):
 *     ┌─ header ──┐
 *     │ GOAL      │
 *     │ keybar    │
 *     Session pane omitted entirely. Matches the v0.6.0
 *     single-pane behavior for small terminals / no-data
 *     states. Hit-test: header / goal / keybar.
 *
 * ── HIT-TEST ────────────────────────────────────────────────────────────
 *
 * `hitTest` is a per-row array, one entry per output line. Each
 * entry is the PaneId that "owns" that row, or the literal string
 * "split" for a row whose pixels are shared between two panes
 * (only possible in stack mode at the vertical separator). A
 * future mouse handler can map a click at (col, row) to a pane
 * with one array lookup.
 *
 * ── FOCUS ───────────────────────────────────────────────────────────────
 *
 * The shell passes the current `focus` index (0-based into the
 * focusable panes). This module echoes it back in the result so
 * the caller can verify the focus index is in range. Visual focus
 * indication (highlight / dim) is the renderer's job — this
 * module is layout only.
 *
 * ── WHY NO TERMINAL WIDTH CALCULATION HERE? ────────────────────────────
 *
 * The caller (the shell) passes the terminal size. This module
 * does NOT call `stdout.columns` / `process.stdout` — it is pure
 * and the same input always produces the same output, which is
 * the property the tests depend on.
 *
 * ── NO NEW DEPENDENCIES ────────────────────────────────────────────────
 *
 * Zero new imports. The shell's existing `truncate` and
 * `createStyler` from `src/format.ts` are used by the renderer's
 * `renderFrame`, not by this layout primitive. This module only
 * does string joins and column math.
 */

import { truncate, type Styler } from "./format.js";
import type { SessionEvent } from "./session-events.js";
import type { StepTimelineEvent } from "./step-timeline.js";

export type PaneId = "header" | "goal" | "session" | "keybar";

export interface PaneContent {
  id: PaneId;
  /**
   * Lines of text this pane contributes. May be empty (e.g. a
   * "no live session" pane renders 1 placeholder line; a session
   * pane with no data contributes `["(no live session)"]`).
   */
  lines: string[];
  /**
   * True if the user can Tab to this pane. Header and keybar are
   * never focusable; goal and session are. The focus index is
   * 0-based into the FOCUSABLE panes only (header and keybar are
   * skipped).
   */
  focusable: boolean;
}

export type LayoutMode = "stack" | "stacked" | "compact";

export interface LayoutResult {
  /** All output lines, joined with "\n" by the shell. */
  lines: string[];
  /** The width that was used (the input, clamped to a minimum). */
  width: number;
  /** The height that was used (the input, clamped to a minimum). */
  height: number;
  /** Which mode was selected. */
  mode: LayoutMode;
  /** The 0-based focus index into the focusable panes (echoed back). */
  focusIndex: number;
  /**
   * Per-row pane ownership. `hitTest[i]` is the PaneId that
   * owns output line `i`, or "split" for a row whose pixels are
   * shared between two panes (only in stack mode at the vertical
   * separator). Length always equals `lines.length`.
   */
  hitTest: Array<PaneId | "split">;
}

/** Vertical separator used in stack mode between the goal and session panes. */
const SEP = "│";

// ── Mode selection ─────────────────────────────────────────────────────

/**
 * Pick the layout mode based on terminal size and whether the
 * session pane has content. Pure (no I/O).
 *
 *   - width < 4                 → "compact"  (can't fit a goal pane at all)
 *   - height < 16               → "compact"  (no room for two panes)
 *   - !hasSession               → "compact"  (no session data to show)
 *   - width < 80                → "stacked"  (too narrow for side-by-side)
 *   - otherwise                 → "stack"    (default)
 *
 * `pickLayoutMode` deliberately treats `hasSession=false` as
 * "compact" (not "stacked"), because the stacked mode would
 * show an empty section the user can't act on. The shell
 * passes `hasSession = (sessionPane.lines.length > 0)`.
 */
export function pickLayoutMode(
  width: number,
  height: number,
  hasSession: boolean,
): LayoutMode {
  if (width < 4) return "compact";
  if (height < 16) return "compact";
  if (!hasSession) return "compact";
  if (width < 80) return "stacked";
  return "stack";
}

// ── Main entry point ───────────────────────────────────────────────────

/**
 * Render the layout. Returns the joined output lines and a hit-test
 * map. Pure — the same input always produces the same output.
 *
 * The `panes` array is expected to be in top-to-bottom order for
 * the `stacked` and `compact` modes. For the `stack` mode, only
 * the first pane with id="header" is treated as the header, the
 * first "goal"-id pane is the left body, the first "session"-id
 * pane is the right body, and the first "keybar"-id pane is the
 * footer. (A future v0.7.x could support multiple goal panes
 * stacked vertically; v0.7.0 ships exactly one of each.)
 */
export function renderLayout(
  panes: ReadonlyArray<PaneContent>,
  width: number,
  height: number,
  focus: number,
): LayoutResult {
  // Clamp degenerate dimensions. A 0×0 terminal is treated as
  // a 1×1 frame (the shell adds the alt-screen and cursor
  // moves around our output, so even an empty result is safe).
  const w = Math.max(1, Math.floor(width));
  const h = Math.max(1, Math.floor(height));

  const header = findPane(panes, "header");
  const goal = findPane(panes, "goal");
  const session = findPane(panes, "session");
  const keybar = findPane(panes, "keybar");

  const hasSession = !!session && session.lines.length > 0;
  const mode = pickLayoutMode(w, h, hasSession);

  switch (mode) {
    case "stack": {
      return renderStack(header, goal, session!, keybar, w, h, focus);
    }
    case "stacked": {
      return renderStacked(header, goal, session, keybar, w, h, focus);
    }
    case "compact": {
      return renderCompact(header, goal, keybar, w, h, focus);
    }
  }
}

// ── Mode renderers ─────────────────────────────────────────────────────

function renderStack(
  header: PaneContent | undefined,
  goal: PaneContent | undefined,
  session: PaneContent,
  keybar: PaneContent | undefined,
  width: number,
  height: number,
  focus: number,
): LayoutResult {
  // The body is height - 2 rows (one for the header, one for the
  // keybar). If the body is non-positive (very small terminal),
  // fall back to compact — but pickLayoutMode should have already
  // caught that case. Defensive: clamp to at least 1 body row.
  const bodyHeight = Math.max(1, height - 2);
  const leftWidth = Math.max(4, Math.floor(width * 0.6) - 1);
  const rightWidth = Math.max(4, width - leftWidth - 3); // -1 for the separator, -2 for padding

  // Pad the goal and session lines to exactly `bodyHeight` rows.
  // The renderer's `truncate` is the right place to cut a line
  // that's too long, but THIS module just pads/truncates the row
  // count — the renderer can re-clamp widths if needed.
  const leftLines = padLines(goal?.lines ?? [], bodyHeight, "");
  const rightLines = padLines(session.lines, bodyHeight, "");

  const out: string[] = [];
  const hit: Array<PaneId | "split"> = [];

  // Header row
  const headerLine = (header?.lines[0] ?? "").slice(0, width).padEnd(width, " ");
  out.push(headerLine);
  hit.push("header");

  // Body rows
  for (let i = 0; i < bodyHeight; i++) {
    const left = (leftLines[i] ?? "").slice(0, leftWidth).padEnd(leftWidth, " ");
    const right = (rightLines[i] ?? "").slice(0, rightWidth).padEnd(rightWidth, " ");
    out.push(`${left} ${SEP} ${right}`);
    // The whole body row is "split" — it spans both panes. Future
    // mouse support can disambiguate by column. The shell's hit
    // test can also be refined to split rows into per-pane hits
    // (left half → "goal", right half → "session"), but for the
    // v0.7.0 keyboard-only path the "split" label is sufficient.
    hit.push("split");
  }

  // Keybar row
  const keybarLine = (keybar?.lines[0] ?? "").slice(0, width).padEnd(width, " ");
  out.push(keybarLine);
  hit.push("keybar");

  return {
    lines: out,
    width,
    height,
    mode: "stack",
    focusIndex: focus,
    hitTest: hit,
  };
}

function renderStacked(
  header: PaneContent | undefined,
  goal: PaneContent | undefined,
  session: PaneContent | undefined,
  keybar: PaneContent | undefined,
  width: number,
  height: number,
  focus: number,
): LayoutResult {
  // Single column. Each focusable section contributes its full
  // height; non-focusable sections (header, keybar) are one row
  // each. We aim to fill the height, but the renderer's scroll
  // path handles overflow.
  const sections: Array<{ pane: PaneContent | undefined; owner: PaneId }> = [
    { pane: header, owner: "header" },
    { pane: goal, owner: "goal" },
    { pane: session, owner: "session" },
    { pane: keybar, owner: "keybar" },
  ];
  const out: string[] = [];
  const hit: Array<PaneId | "split"> = [];
  for (const { pane, owner } of sections) {
    if (!pane) continue;
    for (const line of pane.lines) {
      out.push(line.slice(0, width).padEnd(width, " "));
      hit.push(owner);
    }
  }
  // Clamp to height by truncating the tail (the renderer will
  // scroll if needed, but for v0.7.0 we keep it simple).
  while (out.length > height) {
    out.pop();
    hit.pop();
  }
  // Pad to at least 1 line (so a 0-height terminal doesn't break
  // the caller's `lines.length === 0` invariant for the
  // empty-panes test — that test uses a real shell loop and
  // expects at minimum a blank line for the cursor to land on).
  if (out.length === 0) {
    out.push("");
    hit.push("header");
  }
  return {
    lines: out,
    width,
    height,
    mode: "stacked",
    focusIndex: focus,
    hitTest: hit,
  };
}

function renderCompact(
  header: PaneContent | undefined,
  goal: PaneContent | undefined,
  keybar: PaneContent | undefined,
  width: number,
  height: number,
  focus: number,
): LayoutResult {
  // Compact = no session pane. Header + goal + keybar. Same
  // single-column shape as stacked, but the session section
  // is omitted.
  const sections: Array<{ pane: PaneContent | undefined; owner: PaneId }> = [
    { pane: header, owner: "header" },
    { pane: goal, owner: "goal" },
    { pane: keybar, owner: "keybar" },
  ];
  const out: string[] = [];
  const hit: Array<PaneId | "split"> = [];
  for (const { pane, owner } of sections) {
    if (!pane) continue;
    for (const line of pane.lines) {
      out.push(line.slice(0, width).padEnd(width, " "));
      hit.push(owner);
    }
  }
  while (out.length > height) {
    out.pop();
    hit.pop();
  }
  if (out.length === 0) {
    out.push("");
    hit.push("header");
  }
  return {
    lines: out,
    width,
    height,
    mode: "compact",
    focusIndex: focus,
    hitTest: hit,
  };
}

// ── internals ───────────────────────────────────────────────────────────

function findPane(
  panes: ReadonlyArray<PaneContent>,
  id: PaneId,
): PaneContent | undefined {
  for (const p of panes) {
    if (p.id === id) return p;
  }
  return undefined;
}

/**
 * Pad or truncate `lines` to exactly `n` rows. Used to align the
 * left and right panes in stack mode so the body rows line up.
 * The renderer is responsible for truncating individual lines to
 * the pane's column width; this helper only handles the ROW count.
 */
function padLines(lines: ReadonlyArray<string>, n: number, fill: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    out.push(lines[i] ?? fill);
  }
  return out;
}

// ── buildSessionPane ─────────────────────────────────────────────────────

export interface BuildSessionPaneOptions {
  /** Optional chain-step info (so the pane can show chain progress
   *  even when no events/timeline have been written yet). */
  chainStep?: { current: number; total: number } | null;
}

/**
 * Build the Live Session pane. Pure: takes the already-read
 * session events + step timeline (the shell does the I/O) and
 * returns the lines for the pane.
 *
 * Three states:
 *   1. No data (no events AND no timeline AND no chainStep) →
 *      a friendly "no live session" placeholder (one line).
 *   2. Live activity present → a compact list of the most
 *      recent events (newest first), with the step timeline
 *      below as a relative-time strip.
 *   3. Timeline-only → just the timeline.
 *
 * Width and height are the pane's allocated box. The pane
 * respects the width (no line overflow) and the height (when
 * both events and timeline are present, the activity feed
 * gets the top half and the timeline gets the bottom half).
 *
 * The pane returns AT MOST `height` lines. The layout module
 * pads shorter results up to the pane's full height with
 * blank rows.
 */
export function buildSessionPane(
  events: ReadonlyArray<SessionEvent>,
  timeline: ReadonlyArray<StepTimelineEvent>,
  width: number,
  height: number,
  st: Styler,
  now: number = Date.now(),
  opts: BuildSessionPaneOptions = {},
): string[] {
  const w = Math.max(1, Math.floor(width));
  const h = Math.max(1, Math.floor(height));

  // Empty / no-data state. When the model has a chainStep, the
  // session pane still shows a one-line chain progress hint so
  // the user knows the chain is in flight even before the first
  // event lands.
  const hasEvents = events.length > 0;
  const hasTimeline = timeline.length > 0;
  const chainStep = opts.chainStep ?? null;

  if (!hasEvents && !hasTimeline && !chainStep) {
    const msg = "No live session — start a goal to see activity here.";
    return [truncate(msg, w)];
  }

  // For chainStep-only state (rare in practice, but possible if
  // a chain was just started and the auto-loop hasn't fired yet),
  // show a one-line chain-progress message.
  if (!hasEvents && !hasTimeline && chainStep) {
    const msg = `Chain step ${chainStep.current + 1}/${chainStep.total} — waiting for first turn…`;
    return [truncate(msg, w)];
  }

  // Compute the split between activity feed and timeline. When
  // both are present, give each ~half the height. When only one
  // is present, it gets the full height.
  let activityHeight: number;
  let timelineHeight: number;
  if (hasEvents && hasTimeline) {
    activityHeight = Math.max(1, Math.floor(h / 2));
    timelineHeight = Math.max(1, h - activityHeight);
  } else if (hasEvents) {
    activityHeight = h;
    timelineHeight = 0;
  } else {
    activityHeight = 0;
    timelineHeight = h;
  }

  const out: string[] = [];

  // ── ACTIVITY FEED ─────────────────────────────────────────────────────
  if (hasEvents) {
    out.push(truncate("ACTIVITY", w));
    // The activity feed shows the most recent `activityHeight - 1`
    // events (one row is taken by the section header). Newest first.
    const slotCount = Math.max(0, activityHeight - 1);
    // events are already newest-first per the readSessionEvents
    // contract, but we don't trust that here — we re-sort by `at`
    // descending so a caller passing events in any order still
    // gets the right visual.
    const sorted = [...events].sort((a, b) => b.at - a.at);
    const visible = sorted.slice(0, slotCount);
    for (const ev of visible) {
      out.push(formatActivityLine(ev, w, st));
    }
  }

  // ── TIMELINE ──────────────────────────────────────────────────────────
  if (hasTimeline) {
    if (hasEvents) {
      // Spacer row between the two sections (only when both are shown).
      out.push("");
    }
    out.push(truncate("TIMELINE", w));
    const slotCount = Math.max(0, timelineHeight - 1 - (hasEvents ? 1 : 0));
    // timeline is also newest-first per the readStepTimeline contract,
    // but we re-sort defensively.
    const sorted = [...timeline].sort((a, b) => b.at - a.at);
    const visible = sorted.slice(0, slotCount);
    for (const step of visible) {
      out.push(formatTimelineLine(step, w, st, now));
    }
  }

  // Trim to height (defensive — should already be ≤ h but the
  // spacer row + section headers can push us one over).
  while (out.length > h) out.pop();
  return out;
}

// ── line formatters ─────────────────────────────────────────────────────

/** Format one activity-feed line. Shape: `bash   2.1s   Ran npm test`. */
function formatActivityLine(ev: SessionEvent, width: number, st: Styler): string {
  const tool = (ev.tool ?? "?").slice(0, 12);
  const duration = typeof ev.durationMs === "number" && Number.isFinite(ev.durationMs)
    ? formatDuration(ev.durationMs)
    : "";
  const summary = (ev.summary ?? "").slice(0, width);
  const okTag = ev.ok === true ? "✓" : ev.ok === false ? "✗" : "·";
  // Color the ok-tag: red for failed, green for ok, dim for unknown.
  // (Plain styler emits no SGR; this is a no-op for the test path.)
  const tag = ev.ok === false ? st.red(okTag) : ev.ok === true ? st.green(okTag) : st.dim(okTag);
  // Compose: tag + tool + duration + summary, separated by spaces.
  // We hand-format the prefix with a fixed width so the tool names
  // line up in the visual.
  const prefix = `${tag} ${tool.padEnd(12)} ${duration.padStart(6)}`;
  const prefixWidth = visibleWidth(prefix);
  const remaining = Math.max(0, width - prefixWidth - 1);
  return truncate(`${prefix} ${summary.slice(0, remaining)}`, width);
}

/** Format one timeline line. Shape: `3m ago  turn 2  met  tests run`. */
function formatTimelineLine(
  step: StepTimelineEvent,
  width: number,
  st: Styler,
  now: number,
): string {
  const relTime = formatRelative(step.at, now);
  const turnTag = `turn ${step.turn + 1}`;
  // Outcome tag, color-coded (plain styler is a no-op).
  const outcomeTag = step.outcome === "met"
    ? st.green("met")
    : step.outcome === "blocked"
      ? st.red("blocked")
      : st.dim("·");
  const label = step.label.slice(0, Math.max(0, width - 24));
  return truncate(`${relTime.padStart(7)}  ${turnTag}  ${outcomeTag}  ${label}`, width);
}

/** "2.1s" / "850ms" / "1m 30s". For activity-feed display. */
function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.floor((ms % 60_000) / 1000);
  return `${min}m ${sec}s`;
}

/** "3m ago" / "2h ago" / "5d ago" / "just now". For timeline display. */
function formatRelative(at: number, now: number): string {
  const diff = now - at;
  if (diff < 0) return "in future";
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

// ── visibleWidth (re-exported from format) ──────────────────────────────

// We need visibleWidth for the prefix-width calculation above.
// Re-import it locally so this file's exports stay self-contained.
import { visibleWidth } from "./format.js";

// ── renderControlCenter (the composer) ──────────────────────────────────

/**
 * The control-model shape consumed by the composer. It's a
 * superset of the legacy `ControlModel` (from
 * control-center-logic.ts) so the shell can pass its existing
 * `buildControlModel` output unchanged.
 *
 * Defined inline (not imported from control-center-logic.ts)
 * to avoid an import cycle: the pane module is a leaf, the
 * shell is the integrator.
 */
export interface ComposerControlModel {
  kind: "active" | "paused" | "achieved" | "cleared" | "corrupt" | "absent";
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

export interface RenderControlCenterOptions {
  model: ComposerControlModel;
  events: ReadonlyArray<SessionEvent>;
  timeline: ReadonlyArray<StepTimelineEvent>;
  chainStep: { current: number; total: number } | null;
  width: number;
  height: number;
  st: Styler;
  focus: number;
  now: number;
}

/**
 * Compose the three-pane shell. Pure. Returns the joined lines
 * to write to stdout + the layout mode + the hit-test map.
 *
 * The composer does FIVE things:
 *   1. Renders the header line (the title row).
 *   2. Renders the goal pane via `buildGoalPane` from
 *      control-center-logic.ts (the existing legacy body).
 *   3. Renders the session pane via `buildSessionPane` (this
 *      module).
 *   4. Renders the keybar line (the footer hints).
 *   5. Delegates the layout to `renderLayout` (this module).
 *
 * Note: in this commit the composer renders the goal pane
 * INLINE rather than importing `buildGoalPane` from
 * control-center-logic.ts, to keep the pane module free of the
 * legacy logic module's deps (its `truncate` import is
 * already pulling in format.ts; pulling goal-state's
 * `sanitizeForPrompt` would couple them). The shell owns
 * the goal-pane composition in the production path; the
 * composer here accepts a pre-rendered goal pane via the
 * `goalPaneLines` option when the caller wants to use the
 * legacy `buildGoalPane` directly.
 *
 * Wait — the comment above describes a v0.7.1+ shape. For
 * v0.7.0, the composer renders the goal pane BODY (status
 * header, progress bar, counters, last reason, eval strip,
 * command, chain, steering, keybar) inline using the same
 * format the legacy `buildGoalPane` uses, so the v0.7.0
 * TUI control center is fully self-contained. The shell's
 * `renderFrame` import is unchanged (the v0.6.0 path still
 * works for the `watch` command and any external caller).
 */
export function renderControlCenter(opts: RenderControlCenterOptions): LayoutResult {
  const { model, events, timeline, chainStep, width, height, st, focus, now } = opts;
  const w = Math.max(1, Math.floor(width));
  const h = Math.max(1, Math.floor(height));

  // 1. Header line — the status icon + label + condition.
  const headerText = `${model.icon} ${model.statusLabel}  ${model.condition}`.slice(0, w);

  // 2. Goal pane body (status + progress + counters + last + evals +
  //    command + chain + steering + keybar). Inline rendering
  //    matches the legacy `buildGoalPane` so the visual is
  //    identical to v0.6.0 when the session pane is empty.
  const goalPane = buildGoalPaneBody(model, w, st);

  // 3. Session pane — activity feed + timeline. When there's no
  // session data, pass an empty pane so the layout picks
  // "compact" mode (no session pane shown). When there IS data,
  // buildSessionPane returns ≥1 line including section headers,
  // so the layout uses "stack" mode.
  const hasSessionData = events.length > 0 || timeline.length > 0 || chainStep !== null;
  const sessionPane = hasSessionData
    ? buildSessionPane(events, timeline, w, h, st, now, { chainStep: chainStep ?? undefined })
    : [];

  // 4. Keybar line — the footer hint.
  const keybarText = footerFor(model.kind).slice(0, w);

  // 5. Layout.
  return renderLayout(
    [
      { id: "header", lines: [headerText], focusable: false },
      { id: "goal", lines: goalPane, focusable: true },
      { id: "session", lines: sessionPane, focusable: true },
      { id: "keybar", lines: [keybarText], focusable: false },
    ],
    w, h, focus,
  );
}

// ── goal pane body (inline, mirrors legacy buildGoalPane) ──────────────

/**
 * Render the goal pane body. Inline so the pane module doesn't
 * import from `control-center-logic.ts` (which would create a
 * circular dep through goal-state.ts). The shell's `buildGoalPane`
 * import in `control-center-logic.ts` remains the canonical
 * legacy path; this helper is the v0.7.0 three-pane shell's
 * composer.
 */
function buildGoalPaneBody(model: ComposerControlModel, width: number, st: Styler): string[] {
  const lines: string[] = [];
  const push = (text: string, color?: (s: string) => string): void => {
    const clamped = truncate(text ?? "", width);
    lines.push(color ? color(clamped) : clamped);
  };

  // Status header (redundant with the layout header; included
  // for the compact / stacked modes where the layout header
  // is on row 0 and the goal pane is below). The shell can
  // suppress this with a flag in v0.7.x if it wants to dedupe.
  if (model.kind === "corrupt" || model.kind === "absent") {
    push(`${model.icon} ${model.statusLabel}`, st.dim);
    if (model.summary) push(model.summary, st.dim);
    if (model.corruptArtifact) push(`Quarantined: ${model.corruptArtifact}`, st.dim);
    push("");
    push("Press [n] to set a new goal.");
    push("");
    return lines;
  }

  // active / paused / achieved / cleared
  push(`${model.icon} ${model.statusLabel}  ${model.condition}`, statusColorInline(st, model.kind));
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
  return lines;
}

/** Status → styler color mapping. Mirrors control-center-logic's
 *  statusColor but inlined to keep the pane module independent. */
function statusColorInline(st: Styler, kind: ComposerControlModel["kind"]): (s: string) => string {
  switch (kind) {
    case "active": return st.green;
    case "paused": return st.yellow;
    case "achieved": return st.cyan;
    case "cleared": return st.gray;
    case "corrupt": return st.red;
    default: return st.gray;
  }
}

/** Footer keybar text by model kind. Mirrors control-center-logic's
 *  footerFor but inlined to keep the pane module independent. */
function footerFor(kind: ComposerControlModel["kind"]): string {
  if (kind === "active" || kind === "paused") {
    return "[p]ause [s]teer [e]dit [R]estart [c]lear [?]help [q]uit";
  }
  if (kind === "absent") return "[n]ew goal [C]laim [?]help [q]uit";
  return "[n]ew goal [?]help [q]uit";
}
