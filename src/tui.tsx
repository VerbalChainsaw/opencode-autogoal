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
 * Provides: /goal-dashboard (status page), /goal-toggle (pause↔resume), /goal-clear.
 *
 * The non-JSX logic (validated I/O, progress-bar math, toggle/clear decisions)
 * lives in `./tui-logic.ts` and is unit-tested. This file is just JSX + hooks.
 */

import type { TuiPlugin, TuiPluginModule, TuiRouteCurrent } from "@opencode-ai/plugin/tui";
import type { JSX } from "@opentui/solid";
import { readDashboardState, computeProgress, toggleGoal, clearGoal } from "./tui-logic.js";

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

  api.keymap.registerLayer({
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

  api.route.register([
    {
      name: "goal.dashboard",
      render: () => {
        const { state } = readDashboardState(directory);
        const theme = () => api.theme.current;
        let body: JSX.Element;
        if (!state) {
          body = <text fg={theme().text}>No active goal. Set one with /goal set "condition"</text>;
        } else {
          const progress = computeProgress(state);
          body = (
            <>
              <text fg={theme().text}>🎯 ACTIVE GOAL{state.status === "paused" ? " (paused)" : ""}</text>
              <text fg={theme().text}>{state.condition}</text>
              <text fg={theme().text}>Progress: {state.turnsEvaluated}/{state.constraints.maxTurns} turns · {progress.elapsedMinutes}/{state.constraints.maxTimeMinutes}m</text>
              <text fg={theme().success}>{progress.bar} {progress.pct}%</text>
              <text fg={theme().textMuted}>Last: {state.lastEvaluation?.reason ?? "none yet"}</text>
              <text fg={theme().textMuted}>/goal-toggle · /goal-clear · /goal-close</text>
            </>
          );
        }
        return (
          // flexGrow={1} fills the host's plugin-route container (app.tsx wraps
          // `{plugin()}` in a flexGrow=1 column). The previous version rendered
          // a box with no dimensions, which Yoga collapsed to zero — hence the
          // "blank screen" symptom.
          <box flexGrow={1} flexDirection="column" backgroundColor={theme().backgroundPanel} padding={1} gap={1}>
            <text fg={theme().textMuted}>esc to close</text>
            {body}
          </box>
        );
      },
    },
  ]);
};

const plugin: TuiPluginModule & { id: string } = { id: "goal.tui", tui };
export default plugin;
