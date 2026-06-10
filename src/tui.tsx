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
 */

import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui";
import { readFileSync, writeFileSync, renameSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";

const STATE_FILE = ".opencode/.goal-state.json";

type GoalState = {
  condition: string;
  status: "active" | "paused" | "achieved" | "cleared";
  startedAt: number;
  pausedAt?: number | null;
  resumedAt?: number | null;
  completedAt?: number | null;
  turnsEvaluated: number;
  constraints: { maxTurns: number; maxTimeMinutes: number };
  lastEvaluation?: { reason: string } | null;
};

const tui: TuiPlugin = async (api) => {
  const statePath = join(api.state.path.directory, STATE_FILE);

  function readState(): GoalState | null {
    try {
      if (!existsSync(statePath)) return null;
      return JSON.parse(readFileSync(statePath, "utf-8")) as GoalState;
    } catch {
      return null;
    }
  }

  function writeState(state: GoalState): void {
    const tmp = `${statePath}.tmp.${process.pid}.${Date.now()}`;
    try {
      writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", "utf-8");
      renameSync(tmp, statePath);
    } catch {
      try { unlinkSync(tmp); } catch { /* ignore */ }
    }
  }

  function toggle(): void {
    const s = readState();
    if (!s || (s.status !== "active" && s.status !== "paused")) {
      api.ui.toast({ message: "No active goal to pause/resume", variant: "info" });
      return;
    }
    const now = Date.now();
    if (s.status === "active") { s.status = "paused"; s.pausedAt = now; }
    else { s.status = "active"; s.resumedAt = now; }
    writeState(s);
    api.ui.toast({ message: `Goal ${s.status}`, variant: "info" });
  }

  function clear(): void {
    const s = readState();
    if (!s || (s.status !== "active" && s.status !== "paused")) {
      api.ui.toast({ message: "No active goal to clear", variant: "info" });
      return;
    }
    s.status = "cleared";
    s.completedAt = Date.now();
    writeState(s);
    api.ui.toast({ message: "Goal cleared", variant: "warning" });
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
      { name: "goal.dashboard", title: "Goal: Dashboard", category: "Goal", namespace: "palette", slashName: "goal-dashboard", run() { api.route.navigate("goal.dashboard"); } },
      { name: "goal.toggle", title: "Goal: Pause / Resume", category: "Goal", namespace: "palette", slashName: "goal-toggle", run() { toggle(); } },
      { name: "goal.clear", title: "Goal: Clear", category: "Goal", namespace: "palette", slashName: "goal-clear", run() { confirmClear(); } },
    ],
    bindings: [],
  });

  api.route.register([
    {
      name: "goal.dashboard",
      render: () => {
        const s = readState();
        if (!s || (s.status !== "active" && s.status !== "paused")) {
          return (
            <box padding={1}>
              <text>No active goal. Set one with /goal set "&lt;condition&gt;"</text>
            </box>
          );
        }
        const elapsed = Math.round((Date.now() - s.startedAt) / 60000);
        const pct = Math.min(100, Math.round((s.turnsEvaluated / s.constraints.maxTurns) * 100));
        const filled = Math.round((pct / 100) * 20);
        const bar = "█".repeat(filled) + "░".repeat(20 - filled);
        return (
          <box flexDirection="column" gap={1} padding={1}>
            <text>🎯 ACTIVE GOAL{s.status === "paused" ? " (paused)" : ""}</text>
            <text>{s.condition}</text>
            <text>Progress: {s.turnsEvaluated}/{s.constraints.maxTurns} turns · {elapsed}/{s.constraints.maxTimeMinutes}m</text>
            <text>{bar} {pct}%</text>
            <text>Last: {s.lastEvaluation?.reason ?? "none yet"}</text>
            <text>/goal-toggle to pause/resume · /goal-clear to clear</text>
          </box>
        );
      },
    },
  ]);
};

const plugin: TuiPluginModule & { id: string } = { id: "goal.tui", tui };
export default plugin;
