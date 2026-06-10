/** @jsxImportSource @opentui/solid */
/**
 * opencode-autogoal — TUI plugin (optional, terminal-only).
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ ⚠ TERMINAL-ONLY. The OpenCode DESKTOP (Electron) app does NOT load TUI    │
 * │ plugins — it is driven purely by the server plugin. This module is only   │
 * │ for people who also run OpenCode in a terminal; on Desktop it is inert.   │
 * │                                                                           │
 * │ ⚠ Shipped as SOURCE (the terminal host is Bun and compiles solid JSX).    │
 * │ It type-checks against @opencode-ai/plugin's TUI types and follows the    │
 * │ official spec, but cannot be executed outside a live OpenCode TUI — VERIFY │
 * │ there before relying on it.                                                │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * Enable via tui.json (separate from the server `plugin` array):
 *   { "plugin": ["opencode-autogoal/tui"] }
 *
 * Provides: /goal-dashboard (full-screen status page), /goal-toggle (pause↔resume),
 * /goal-clear, /goal-close. The persistent goal sidebar (a separate plugin
 * entry at `opencode-autogoal/sidebar`) is implemented in `./sidebar.tsx`;
 * this file is just the dashboard + keymap.
 *
 * The non-JSX logic (validated I/O, progress-bar math, file-watcher filter,
 * session-directory resolution) lives in `./tui-logic.ts` and is unit-tested.
 * This file is just JSX + hooks.
 */

import type { TuiPlugin, TuiPluginModule, TuiRouteCurrent, TuiPluginApi } from "@opencode-ai/plugin/tui";
import type { JSX } from "@opentui/solid";
import { createSignal, onCleanup, Show } from "solid-js";
import {
  readDashboardState,
  computeProgress,
  toggleGoal,
  clearGoal,
  isGoalStatePath,
  type GoalState,
} from "./tui-logic.js";

// ── Goal state view (reactive) ──────────────────────────────────────────────
// A small component-level hook that returns a live-updating accessor for the
// current goal state. Subscribes to the host's `file.watcher.updated` event
// stream and re-reads when the state file changes. The unsubscribe is wired
// via SolidJS's `onCleanup` so it fires on component unmount, not just on
// plugin dispose (the route might be navigated away from and back).

function useGoalState(api: TuiPluginApi, directory: string) {
  const [state, setState] = createSignal<GoalState | null>(null);

  const refresh = () => {
    setState(readDashboardState(directory).state);
  };
  refresh();

  const unsubscribe = api.event.on("file.watcher.updated", (evt) => {
    if (isGoalStatePath(evt.properties.file)) refresh();
  });
  onCleanup(() => unsubscribe());

  return state;
}

// ── Dashboard view (full-screen route) ──────────────────────────────────────
// A trimmed-down version of the goal status page; lives at the top level
// (navigated to via `/goal-dashboard`). flexGrow={1} fills the host's
// plugin-route container (app.tsx wraps `{plugin()}` in a flexGrow=1 column).
// Yoga collapses a box with no dimensions to zero, which is the "blank
// screen" symptom this layout is designed to avoid.

function DashboardView(props: { api: TuiPluginApi; directory: string }) {
  const state = useGoalState(props.api, props.directory);
  const theme = () => props.api.theme.current;

  return (
    <box flexGrow={1} flexDirection="column" backgroundColor={theme().backgroundPanel} padding={1} gap={1}>
      <text fg={theme().textMuted}>esc to close</text>
      <Show
        when={state()}
        fallback={<text fg={theme().text}>No active goal. Set one with /goal set "condition"</text>}
      >
        {(s) => {
          const progress = computeProgress(s());
          return (
            <>
              <text fg={theme().text}>🎯 ACTIVE GOAL{s().status === "paused" ? " (paused)" : ""}</text>
              <text fg={theme().text}>{s().condition}</text>
              <text fg={theme().text}>Progress: {s().turnsEvaluated}/{s().constraints.maxTurns} turns · {progress.elapsedMinutes}/{s().constraints.maxTimeMinutes}m</text>
              <text fg={theme().success}>{progress.bar} {progress.pct}%</text>
              <text fg={theme().textMuted}>Last: {s().lastEvaluation?.reason ?? "none yet"}</text>
              <text fg={theme().textMuted}>/goal-toggle · /goal-clear · /goal-close</text>
            </>
          );
        }}
      </Show>
    </box>
  );
}

const tui: TuiPlugin = async (api) => {
  const directory = api.state.path.directory;

  function toggle(): void {
    const res = toggleGoal(directory);
    if (res.ok) {
      api.ui.toast({ message: `Goal ${res.newStatus}`, variant: "info" });
    } else if (res.reason === "no-goal") {
      api.ui.toast({ message: "No active goal to pause/resume", variant: "info" });
    } else {
      api.ui.toast({ message: `Could not change goal: ${res.error ?? "unknown error"}`, variant: "error" });
    }
  }

  function clear(): void {
    const res = clearGoal(directory);
    if (res.ok) {
      api.ui.toast({ message: "Goal cleared", variant: "warning" });
    } else if (res.reason === "no-goal") {
      api.ui.toast({ message: "No active goal to clear", variant: "info" });
    } else {
      api.ui.toast({ message: `Could not clear goal: ${res.error ?? "unknown error"}`, variant: "error" });
    }
  }

  function confirmClear(): void {
    api.ui.dialog.replace(() =>
      api.ui.DialogConfirm({
        title: "Clear goal?",
        message: "This stops the auto-loop and clears the current goal.",
        onConfirm: () => { clear(); api.ui.dialog.clear(); },
        onCancel: () => api.ui.dialog.clear(),
      })
    );
  }

  const keymapDispose = api.keymap.registerLayer({
    commands: [
      {
        name: "goal.dashboard",
        title: "Goal: Dashboard",
        category: "Goal",
        namespace: "palette",
        slashName: "goal-dashboard",
        run() {
          // Stash the current route so close can return to it (the diff-viewer pattern).
          const returnRoute = api.route.current;
          api.route.navigate("goal.dashboard", { returnRoute });
        },
      },
      {
        name: "goal.dashboard.close",
        title: "Goal: Close dashboard",
        category: "Goal",
        namespace: "palette",
        slashName: "goal-close",
        run() {
          // No-op when not on our route (esc is bound globally).
          if (api.route.current.name !== "goal.dashboard") return;
          const params = api.route.current.params as { returnRoute?: TuiRouteCurrent } | undefined;
          const ret = params?.returnRoute;
          if (ret?.name === "session" && "params" in ret && ret.params?.sessionID) {
            api.route.navigate("session", { sessionID: ret.params.sessionID });
          } else {
            api.route.navigate("home");
          }
        },
      },
      { name: "goal.toggle", title: "Goal: Pause / Resume", category: "Goal", namespace: "palette", slashName: "goal-toggle", run() { toggle(); } },
      { name: "goal.clear", title: "Goal: Clear", category: "Goal", namespace: "palette", slashName: "goal-clear", run() { confirmClear(); } },
    ],
    bindings: [
      { key: "esc", cmd: "goal.dashboard.close", desc: "Close goal dashboard" },
    ],
  });

  const routeDispose = api.route.register([
    {
      name: "goal.dashboard",
      render: () => <DashboardView api={api} directory={directory} />,
    },
  ]);

  // Plugin reload safety: register disposers so a hot-reload (config change,
  // workspace switch) doesn't leave duplicate commands and double-registered
  // bindings. `registerLayer` and `route.register` both return dispose
  // functions (the opencode TUI plugin API contract); wrap them for
  // `lifecycle.onDispose` so they fire on plugin teardown.
  const disposers: Array<() => void> = [];
  if (typeof keymapDispose === "function") disposers.push(keymapDispose);
  if (typeof routeDispose === "function") disposers.push(routeDispose);
  api.lifecycle.onDispose(() => {
    for (const d of disposers) {
      try { d(); } catch { /* swallow — another disposal may have already run */ }
    }
  });
};

const plugin: TuiPluginModule & { id: string } = { id: "goal.tui", tui };
export default plugin;
