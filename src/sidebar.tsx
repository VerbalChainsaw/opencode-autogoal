/** @jsxImportSource @opentui/solid */
/**
 * opencode-autogoal — SIDEBAR plugin (sibling to the dashboard).
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ WHAT THIS IS                                                             │
 * │ A second OpenCode TUI plugin that lives inside the host's session        │
 * │ sidebar — a persistent panel that shows the live goal state, progress,  │
 * │ and last-evaluation reason, without the user having to navigate to a    │
 * │ dashboard route. Different from the existing dashboard in tui.tsx:      │
 * │   - tui.tsx:  fullscreen route, navigate-to pattern (/goal-dashboard)   │
 * │   - sidebar: persistent panel, always-visible in every session          │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * The sidebar registers against the host's `sidebar_title`, `sidebar_content`,
 * and `sidebar_footer` slot map (`@opencode-ai/plugin/tui` SDK). The host
 * renders the three slots inside its own sidebar layout. We do not own the
 * box; we just supply the strings to fill it.
 *
 * ── DATA FLOW ───────────────────────────────────────────────────────────────
 *
 *   ┌──────────────┐     readGoalState       ┌──────────────────┐
 *   │  state file  │ ───────────────────────>│  tui-logic.ts    │
 *   │ .goal-state  │                         │  (validated)     │
 *   └──────────────┘                         └────────┬─────────┘
 *                                                     │
 *                                                     v
 *                                            ┌──────────────────┐
 *                                            │ sidebar-logic.ts │
 *                                            │ (pure view-model)│
 *                                            └────────┬─────────┘
 *                                                     │
 *                                                     v
 *                                            ┌──────────────────┐
 *                                            │   this file      │
 *                                            │  (JSX render)    │
 *                                            └──────────────────┘
 *
 * The slot props carry `session_id`. The state file is per-workspace, not
 * per-session; we resolve the workspace via `api.state.path.directory`.
 * Multi-workspace awareness is left to the host's slot props (it has the
 * session_id; we have the directory; the slot renders per-session).
 *
 * ── POLLING vs EVENT-DRIVEN ─────────────────────────────────────────────────
 *
 * The slot renders when the host calls its render fn. The host re-renders
 * the slot when:
 *   - The session changes
 *   - A new event fires (e.g. `session.idle`)
 *   - The user takes an action that might have invalidated the panel
 *
 * We do NOT poll on a timer — that would burn CPU and the host has its
 * own invalidation surface. If a future requirement needs a per-second
 * refresh, we'd subscribe to `api.client.event.subscribe(...)` to listen
 * for `goal.state.changed` (which the server plugin would emit; not yet
 * implemented in this repo). For now, the slot re-renders on host-driven
 * invalidation, which is "when the goal actually changes" in the common
 * case (the server plugin writes a new state file and the host's
 * file-watcher fires the slot).
 *
 * ── KEYMAP ──────────────────────────────────────────────────────────────────
 *
 * The sidebar does NOT register its own keymap. The existing tui.tsx
 * already registers `goal.toggle` / `goal.clear` / `goal.dashboard`. The
 * sidebar surfaces them in the footer as `/goal-toggle` and `/goal-clear`
 * hints — the user invokes them via the command palette, not via a
 * keychord bound by this plugin.
 *
 * ── DESKTOP NOTE ────────────────────────────────────────────────────────────
 *
 * The OpenCode Desktop (Electron) app does not load TUI plugins. This
 * sidebar, like tui.tsx, only renders when the user runs OpenCode in a
 * terminal. For the Desktop Goals tab, see `specs/desktop-ui-design.md`
 * (separate upstream PR in OpenCode's `packages/app`).
 *
 * Enable via your TUI config (`tui.json` or `~/.config/opencode/tui.json`):
 *   { "plugin": ["opencode-autogoal/tui", "opencode-autogoal/sidebar"] }
 */

import type { TuiPlugin, TuiPluginModule, TuiRouteCurrent } from "@opencode-ai/plugin/tui";
import type { JSX } from "@opentui/solid";

import { buildSidebarView, sanitizeForSidebar } from "./sidebar-logic.js";

const sidebar: TuiPlugin = async (api) => {
  const directory = api.state.path.directory;

  // Helper used by sidebar_content — re-derive the view-model on every
  // host invalidation. The host re-runs the slot's render fn when the
  // underlying state changes; we do not poll.
  function renderContent(): JSX.Element {
    const view = buildSidebarView(directory);
    const theme = () => api.theme.current;

    if (!view.hasGoal) {
      return (
        <box flexDirection="column" gap={1}>
          {view.content.split("\n").map((line) => (
            <text fg={theme().textMuted}>
              {line || " "}
            </text>
          ))}
        </box>
      );
    }

    // Active or paused — render the progress + counters + last reason.
    return (
      <box flexDirection="column" gap={1}>
        {view.content.split("\n").map((line, idx) => {
          // The first line is the progress bar; use the success color so
          // it pops. The remaining lines use the muted text color.
          const fg = idx === 0 ? theme().success : theme().textMuted;
          return (
            <text fg={fg}>
              {line || " "}
            </text>
          );
        })}
      </box>
    );
  }

  function renderTitle(): JSX.Element {
    const view = buildSidebarView(directory);
    const theme = () => api.theme.current;
    return (
      <text fg={view.isPaused ? theme().warning : theme().text}>
        {sanitizeForSidebar(view.title) || "🎯 goal"}
      </text>
    );
  }

  function renderFooter(): JSX.Element {
    const view = buildSidebarView(directory);
    const theme = () => api.theme.current;
    return (
      <text fg={theme().textMuted}>
        {sanitizeForSidebar(view.footer)}
      </text>
    );
  }

  // The host provides a dispose hook on the plugin object (per the
  // @opentui/core Plugin contract: `dispose?: () => void`). We use it
  // instead of `api.lifecycle.onDispose` because slot unregistration is
  // owned by the SDK — the host calls our dispose fn on plugin teardown.
  // (api.slots.register returns the assigned plugin id string, not a
  // dispose fn — the unregister happens via the plugin's dispose hook.)
  const dispose = api.slots.register({
    slots: {
      sidebar_title: () => renderTitle(),
      sidebar_content: () => renderContent(),
      sidebar_footer: () => renderFooter(),
    },
    dispose() {
      // No per-renderer teardown required — the Solid runtime will GC the
      // component closures when the host detaches the slot. We only need
      // to make sure we don't subscribe to anything that outlives the
      // plugin (we don't, currently).
    },
  });

  // `dispose` is the plugin id string — kept around for log diagnostics.
  void dispose;
};

export const Sidebar: TuiPluginModule = {
  id: "opencode-autogoal/sidebar",
  tui: sidebar,
};
export default Sidebar;

// TuiRouteCurrent is re-exported only to keep the import surface stable
// if a future maintainer adds a route-aware render (e.g. a "show dashboard"
// link in the footer). No current code paths use it; the import is a
// forward-compatible anchor.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export type _TuiRouteCurrentRef = TuiRouteCurrent;
