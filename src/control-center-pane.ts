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
