/**
 * help-content.ts — categorized help data for the v0.7.0 TUI
 * control center. (E25 of the plan.)
 *
 * Three sections: Goal (the goal state and its actions),
 * Session (the live session pane and drill-down), and Nav
 * (the navigation keys: help, quit, drill, redraw).
 *
 * The shell reads this via `buildHelpSections()` and feeds it
 * to the help overlay renderer (`help-overlay.ts`). The data
 * here is the SOURCE OF TRUTH for which keys are bound to
 * which actions — adding a new key to the shell without
 * updating this file is a regression the help-overlay test
 * will catch.
 *
 * The shape mirrors the v0.7.0 `buildSessionPane` /
 * `buildHelpOverlay` / `PickerState` pattern: pure data,
 * no I/O, no state. The test surface in `help-content.test.mjs`
 * asserts: three sections with non-empty entries, keys unique
 * within a section, and the v0.7.0 7 new actions are all
 * present.
 */

export interface HelpEntry {
  /** The key (or key chord) that triggers the action. */
  key: string;
  /** Human-readable description of what the key does. */
  action: string;
}

export interface HelpSection {
  /** Section label (e.g. "Goal", "Session", "Nav"). */
  label: string;
  /** Entries in display order. The order matches the
   *  order the user is most likely to need them. */
  entries: HelpEntry[];
}

export function buildHelpSections(): HelpSection[] {
  return [
    {
      label: "Goal",
      entries: [
        { key: "p", action: "Pause / resume the active goal" },
        { key: "s", action: "Add a steering note" },
        { key: "e", action: "Edit the goal condition" },
        { key: "R", action: "Restart (same condition, fresh id)" },
        { key: "c", action: "Clear the goal (with confirm)" },
        { key: "n", action: "Set a new goal" },
        { key: "H", action: "Write a handoff for a future session" },
        { key: "C", action: "Claim a pending handoff" },
        { key: "t", action: "Set max turns (dial)" },
        { key: "m", action: "Set max minutes (dial)" },
        { key: "k", action: "Set max tokens (dial)" },
      ],
    },
    {
      label: "Session",
      entries: [
        { key: "Tab", action: "Drill into steering list or eval history" },
        { key: "↑ / ↓", action: "Navigate the active list (drill mode)" },
        { key: "Enter", action: "Open detail / select the current item" },
        { key: "c", action: "Copy the current item to clipboard (OSC 52)" },
        { key: "e", action: "Edit the current steering note" },
        { key: "Esc", action: "Exit drill-down (or close detail)" },
        { key: "A", action: "View the goal archive" },
        { key: "T", action: "View the templates list" },
        { key: "D", action: "Run doctor (inline health check)" },
        { key: "L", action: "Open .opencode/ in the file manager" },
        { key: "O", action: "Open .opencode/ (alias for L)" },
        { key: "g", action: "Copy the full goal state JSON to clipboard" },
      ],
    },
    {
      label: "Nav",
      entries: [
        { key: "?", action: "Show this help overlay" },
        { key: "/", action: "Search the help" },
        { key: "n", action: "Next help page (when overlay is open)" },
        { key: "p", action: "Previous help page (when overlay is open)" },
        { key: "Esc", action: "Close the help overlay" },
        { key: "q", action: "Quit the control center" },
        { key: "Ctrl+L", action: "Redraw (no re-read)" },
        { key: "Ctrl+C", action: "Quit the control center" },
      ],
    },
  ];
}
