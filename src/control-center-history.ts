/**
 * control-center-history.ts — pure drill-down navigation reducer
 * (C13 of the v0.7.0 plan).
 *
 * The drill-down reducer is the pure heart of the new
 * "intuitive" half of the control center. The user presses
 * Tab to enter drill-down mode, ↑/↓ to move a cursor through
 * a list, Enter to select an item (which opens a detail
 * view), Enter again to commit the selection (sets
 * `done: "selected"`), and Esc to exit (sets `done:
 * "cancelled"`). The reducer is pure (no I/O, no state) so
 * the keyboard logic is unit-testable without a
 * pseudo-terminal.
 *
 * Two kinds of lists are drill-down navigable:
 *   - "steering"  — the steering note list (when the goal
 *                   has steering notes)
 *   - "history"   — the evaluation history (always present
 *                   when the goal has any evaluations)
 *
 * The reducer is shared between both via the `kind`
 * discriminator — the same ↑/↓/Enter/Esc/Tab transitions
 * apply, the only difference is which list the cursor is
 * bound to. The shell owns the list rendering and the
 * "what does selected mean for this list" logic (the reducer
 * is purely a navigation state machine).
 *
 * ── TWO-LEVEL DETAIL ───────────────────────────────────────────────
 *
 * The reducer is a tiny finite-state machine:
 *   normal   → enter   → detail
 *   detail   → enter   → selected (caller consumes; detail
 *                          stays open until esc clears it)
 *   *        → esc     → cancelled (caller consumes)
 *   *        → tab     → switch kind (close detail first if open)
 *
 * The shell reads `done` after each dispatch, acts on it
 * (e.g. opens the inline editor for a selected steering
 * note), and clears the flag before the next dispatch.
 *
 * ── WHY THIS IS PURE ──────────────────────────────────────────────
 *
 * The reducer has no I/O, no Date.now(), no randomness.
 * The same input always produces the same output. The
 * caller (the shell) owns the side effects: reading the
 * goal state, opening the detail view, copying to the
 * clipboard, etc. This is the same shape as the v0.6.0
 * `reduceInput` (line editor) and the v0.6.0 `keyToAction`
 * (key-to-action dispatcher): pure state machine, impure
 * shell. It is what makes the test file so short.
 *
 * ── ZERO NEW DEPENDENCIES ─────────────────────────────────────────
 *
 * No imports beyond what the file needs (none, actually —
 * it's a pure state machine). The shape mirrors the v0.6.0
 * `Mode` and `Action` types in control-center-logic.ts.
 */

export type DrillKind = "steering" | "history";

export type DrillDone = "selected" | "cancelled" | null;

export interface DrillState {
  kind: DrillKind;
  /** 0-based cursor into the active list. Clamped to [0, itemCount-1]
   *  by the reducer on every down/up dispatch. */
  cursor: number;
  /** The size of the active list. The shell updates this
   *  whenever the underlying list changes (e.g. when the
   *  user switches from 'steering' to 'history' and the
   *  history list has a different size). The reducer uses
   *  this to clamp the cursor at the boundary. */
  itemCount: number;
  /** The shell's "act on this" signal. Cleared by the shell
   *  after each dispatch. */
  done: DrillDone;
  /** True when the user is in the detail view of the
   *  current item. The shell renders the detail view when
   *  this is true. */
  detailOpen: boolean;
}

export type DrillAction =
  | { kind: "up" }
  | { kind: "down" }
  | { kind: "enter" }
  | { kind: "esc" }
  | { kind: "tab" }
  | { kind: string; [k: string]: unknown }; // forward-compatible unknown actions

/**
 * Build the initial drill-down state. The shell calls this
 * when the user enters drill-down mode (Tab from normal).
 *
 * The `itemCount` parameter is the size of the active list.
 * The reducer uses it to clamp the cursor at the boundary
 * (down at the bottom stays at the bottom, up at the top
 * stays at the top). The shell updates `itemCount` whenever
 * the list size changes (e.g. on a kind switch).
 */
export function initialDrillState(kind: DrillKind, itemCount: number): DrillState {
  return { kind, cursor: 0, itemCount, done: null, detailOpen: false };
}

/**
 * Pure reducer. Returns a NEW state object (does not mutate
 * the input). Unknown actions are no-ops (return an
 * equivalent state).
 *
 * The shell's "act on done" pattern:
 *   1. dispatch a key (e.g. { kind: "enter" })
 *   2. check the new state's `done` field
 *   3. if `done` is "selected" or "cancelled", act on it
 *      (open detail, copy to clipboard, exit drill-down)
 *   4. dispatch a synthetic "clear" action (or just set
 *      `done: null` directly) before the next user key
 */
export function drillReducer(state: DrillState, action: DrillAction): DrillState {
  // Defensive: a null/undefined state is a no-op (returns
  // the same null/undefined). This is the contract the
  // v0.7.0 test probe checks — a misbehaving caller
  // shouldn't crash the shell.
  if (!state || typeof state !== "object") return state;
  switch (action.kind) {
    case "up":
      return { ...state, cursor: Math.max(0, state.cursor - 1) };
    case "down":
      // Clamp at the list's last index (itemCount - 1). The
      // max with 0 handles the "empty list" case (itemCount=0
      // → max(0, -1) → 0). The shell is responsible for not
      // opening drill-down on an empty list, but a defensive
      // clamp costs nothing and prevents a future caller from
      // accidentally letting the cursor go to -1.
      return {
        ...state,
        cursor: Math.max(0, Math.min(state.itemCount - 1, state.cursor + 1)),
      };
    case "enter":
      if (state.detailOpen) {
        // Second Enter on the same item commits the
        // selection. The shell reads `done === "selected"`
        // and acts (e.g. opens the inline editor for the
        // selected steering note).
        return { ...state, done: "selected" };
      }
      // Defensive: on an empty list, enter is a no-op.
      // The shell doesn't open drill-down on empty lists,
      // but if a caller does, the reducer shouldn't open
      // a "detail" of nothing.
      if (state.itemCount <= 0) return state;
      return { ...state, detailOpen: true };
    case "esc":
      // Esc closes the detail (if open) AND exits
      // drill-down. The shell reads `done === "cancelled"`
      // and restores the normal-mode render.
      return { ...state, detailOpen: false, done: "cancelled" };
    case "tab":
      if (state.detailOpen) {
        // Tab from the detail view closes the detail
        // (does not switch kind — the user is in the middle
        // of inspecting an item, switching kind would lose
        // their place). A subsequent Tab switches kind.
        return { ...state, detailOpen: false };
      }
      return {
        ...state,
        kind: state.kind === "steering" ? "history" : "steering",
        cursor: 0,
        detailOpen: false,
      };
    default:
      // Unknown / future action — no-op (returns an
      // equivalent state). The shell can pass through any
      // action it wants; the reducer is a closed set of
      // transitions.
      return state;
  }
}
