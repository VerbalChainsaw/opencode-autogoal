/**
 * picker.ts — pure list-picker reducer (D18 of the v0.7.0 plan).
 *
 * A tiny state machine for the "navigate a list, pick one"
 * pattern used by the A (archive), T (templates), and D
 * (doctor) actions. The user sees a list of items, navigates
 * with ↑/↓, picks one with Enter, or cancels with Esc. The
 * reducer is pure (no I/O, no state) so the keyboard logic
 * is unit-testable without a pseudo-terminal.
 *
 * Mirrors the v0.7.0 control-center-history.ts drill reducer
 * but with a simpler contract (no detail view, no kind switch,
 * no item-by-item edit). The picker's job is to give the
 * shell a "the user picked index N" signal; the shell then
 * acts on it (e.g. copy an archive entry to the clipboard,
 * apply a template, run a doctor check).
 *
 * ── ACTION SHAPE ─────────────────────────────────────────────────────
 *
 * The action carries an `itemCount` field for the down/up
 * transitions so the reducer can clamp the cursor at the
 * boundary. The shell dispatches `{ kind: "down",
 * itemCount: 5 }` when the list size is known. When the
 * list size changes (e.g. a template was added), the shell
 * re-dispatches with the new itemCount.
 */
export interface PickState {
  /** 0-based cursor into the active list. Clamped to [0, itemCount-1]. */
  cursor: number;
  /** The shell's "act on this" signal. Cleared by the shell
   *  after each dispatch. */
  done: "selected" | "cancelled" | null;
}

export type PickAction =
  | { kind: "up" }
  | { kind: "down"; itemCount?: number }
  | { kind: "enter" }
  | { kind: "esc" }
  | { kind: string; [k: string]: unknown }; // forward-compatible unknown actions

export function initialPickState(itemCount: number): PickState {
  // The initial state always starts at cursor 0. The shell
  // is responsible for not opening a picker on an empty list
  // (the keystrokes just won't fire a selection).
  return { cursor: 0, done: null };
}

export function pickReducer(state: PickState, action: PickAction): PickState {
  // Type guard: the union-narrowing switch above doesn't
  // know that the default branch's `action` is the catch-all
  // string variant (TypeScript widens it to `string` after
  // the discriminant cases). We re-narrow explicitly.
  const kind = (typeof action === "object" && action !== null && "kind" in action && typeof (action as { kind: unknown }).kind === "string")
    ? (action as { kind: string }).kind
    : "unknown";
  if (kind === "unknown") return state;
  switch (kind) {
    case "up":
      return { ...state, cursor: Math.max(0, state.cursor - 1) };
    case "down": {
      // itemCount is optional on the down action. The shell
      // passes it when the list size is known; tests and
      // simple callers can omit it. When absent, the cursor
      // grows unbounded (the shell clamps at the rendering
      // layer, and the up case clamps on the way back).
      const itemCount = (action as { itemCount?: number }).itemCount;
      if (typeof itemCount === "number" && Number.isFinite(itemCount)) {
        return {
          ...state,
          cursor: Math.max(0, Math.min(itemCount - 1, state.cursor + 1)),
        };
      }
      return { ...state, cursor: state.cursor + 1 };
    }
    case "enter":
      return { ...state, done: "selected" };
    case "esc":
      return { ...state, done: "cancelled" };
    default:
      // Unknown / future action — no-op.
      return state;
  }
}
