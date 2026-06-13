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
import type { TuiPlugin, TuiPluginModule, TuiRouteCurrent, TuiPluginApi, TuiThemeCurrent } from "@opencode-ai/plugin/tui";
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
import {
  handleTurnsSubmit,
  handleTimeSubmit,
  handleTokensSubmit,
  handleConditionSubmit,
  handleSteerSubmit,
  handleClearSteeringSubmit,
  handleRestartSubmit,
  handleHandoffSubmit,
  handleClaimSubmit,
  turnsPlaceholder,
  timePlaceholder,
  tokensPlaceholder,
  conditionPlaceholder,
  steerPlaceholder,
  handoffNotePlaceholder,
} from "./tui-dials-logic.js";
import { setGoalFields } from "./goal-state.js";

// ── Goal state view (reactive) ──────────────────────────────────────────────
// A small component-level hook that returns a live-updating accessor for the
// current goal state. Subscribes to the host's `file.watcher.updated` event
// stream and re-reads when the state file changes. The unsubscribe is wired
// via SolidJS's `onCleanup` so it fires on component unmount, not just on
// plugin dispose (the route might be navigated away from and back).

function useGoalState(api: TuiPluginApi, directory: string) {
  const [state, setState] = createSignal<GoalState | null>(null);

  // FIX-20: coalesce file-watcher events. The auto-loop in server.ts can
  // fire 3+ writeGoalStateAtomic calls per session.idle (constraint check,
  // evaluation record, status change). Without coalescing, each event
  // triggers a fresh file read + a SolidJS re-render — N logical state
  // changes produce 3N events and 3N re-renders. We coalesce by deferring
  // the actual re-read to the next microtask via queueMicrotask, which
  // batches all events that fire within the same tick into a single
  // re-read. The semantics: the dashboard always shows the latest state
  // after the synchronous tick, regardless of how many events fired.
  let pending = false;
  const refresh = () => {
    if (pending) return;
    pending = true;
    queueMicrotask(() => {
      pending = false;
      setState(readDashboardState(directory).state);
    });
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

// Shared dashboard footer — slash-command hints + Esc-to-close affordance.
// Extracted to eliminate the copy-paste between the no-goal fallback and the
// active/paused view (FIX-2). The original bug class: a previous maintainer
// added the active/paused view's footer but forgot the Esc hint, leaving
// users with a goal set "stuck" in the dashboard. With this component,
// every branch that shows the footer is automatically up to date.
//
// The two text elements are intentionally identical (same wording, same
// color) — the visual redundancy is by design, since this is the user's
// exit affordance.
function DashboardFooter(props: { theme: () => TuiThemeCurrent }) {
  const t = props.theme;
  return (
    <>
      <text fg={t().textMuted}>alt+g dashboard · alt+s steer · alt+p pause/resume · alt+n set</text>
      <text fg={t().textMuted}>/goal-toggle · /goal-clear · /goal-close</text>
      <text fg={t().textMuted}>(press esc to close this panel)</text>
    </>
  );
}

function DashboardView(props: { api: TuiPluginApi; directory: string }) {
  const state = useGoalState(props.api, props.directory);
  const theme = () => props.api.theme.current;

  return (
    <box flexGrow={1} flexDirection="column" backgroundColor={theme().backgroundPanel} padding={1} gap={1}>
      <text fg={theme().text}>esc to close</text>
      <Show
        when={state()}
        fallback={
          // Wrap the fallback text in its own box so Yoga doesn't
          // collapse the parent (which would produce a "black screen"
          // when there's no goal and no JSX child has a measurable
          // intrinsic size). The backgroundColor on the inner box
          // matches the host's panel color so the wrapping is
          // visually invisible unless the user looks for it.
          <box flexGrow={1} flexDirection="column" backgroundColor={theme().backgroundPanel} padding={1} gap={1}>
            <text fg={theme().text}>No active goal.</text>
            <text fg={theme().textMuted}>Set one with /goal set "condition"</text>
            <DashboardFooter theme={theme} />
          </box>
        }
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
              <DashboardFooter theme={theme} />
            </>
          );
        }}
      </Show>
    </box>
  );
}

const tui: TuiPlugin = async (api) => {
  const directory = api.state.path.directory;

  // ── Dialog-stack ownership guard ─────────────────────────────────────────
  // The OpenCode TUI allows multiple plugins to use the same dialog stack.
  // If we blindly call `api.ui.dialog.replace`, we silently clobber a
  // foreign plugin's dialog. If WE have a dialog open and the user
  // triggers another dial, we silently clobber our own (and drop any
  // input they typed). Both cases are silent failures.
  //
  // Fix: track our own open state with `ourDialogOpen`. When the user
  // triggers a second open, refuse and toast a clear message. The host's
  // `onClose` callback (passed to `dialog.replace`) fires when our
  // dialog is dismissed, so we use it to clear the flag.
  //
  // Known limitation: we cannot detect a foreign plugin's dialog. If
  // another plugin's dialog is on the stack, our `replace` still
  // clobbers it. The host SDK (`TuiDialogStack.depth`) exposes the
  // stack depth but no per-dialog ownership info, so this is the best
  // we can do without host support.
  let ourDialogOpen = false;

  // FIX-18: toast debouncing. Without this, a user mashing a keybind
  // (e.g. spamming /goal-toggle 100 times) would queue 100 toasts in the
  // host's UI. The map keyed by `${variant}|${message}` tracks when
  // each unique toast was last shown; we suppress a repeat within a
  // 500ms window. The window is short enough to feel instant for distinct
  // toasts but long enough to absorb a key-mash burst.
  //
  // The map can otherwise grow unbounded (each distinct message+variant
  // pair adds a key that never expires). We prune stale entries (older
  // than the debounce window) whenever the map crosses a soft cap, so
  // memory stays bounded under long-running sessions.
  const TOAST_DEBOUNCE_MS = 500;
  const TOAST_MAP_SOFT_CAP = 50;
  const toastLastShown: Map<string, number> = new Map();
  function debouncedToast(input: { message: string; variant?: "info" | "success" | "warning" | "error"; duration?: number; title?: string }): void {
    const key = `${input.variant ?? "info"}|${input.message}`;
    const now = Date.now();
    const last = toastLastShown.get(key) ?? 0;
    if (now - last < TOAST_DEBOUNCE_MS) return;
    // Prune stale entries before adding the new one. O(n) but n is
    // bounded by the soft cap and the prune keeps the steady-state size
    // in the dozens at most.
    if (toastLastShown.size > TOAST_MAP_SOFT_CAP) {
      for (const [k, t] of toastLastShown) {
        if (now - t >= TOAST_DEBOUNCE_MS) toastLastShown.delete(k);
      }
    }
    toastLastShown.set(key, now);
    api.ui.toast(input);
  }

  function safeReplaceDialog(render: () => JSX.Element): boolean {
    if (ourDialogOpen) {
      debouncedToast({ message: "Close the current dialog first.", variant: "info" });
      return false;
    }
    ourDialogOpen = true;
    api.ui.dialog.replace(render, () => {
      ourDialogOpen = false;
    });
    return true;
  }

  function toggle(): void {
    const res = toggleGoal(directory);
    if (res.ok) {
      debouncedToast({ message: `Goal ${res.newStatus}`, variant: "info" });
    } else if (res.reason === "no-goal") {
      debouncedToast({ message: "No active goal to pause/resume", variant: "info" });
    } else {
      debouncedToast({ message: `Could not change goal: ${res.error ?? "unknown error"}`, variant: "error" });
    }
  }

  function clear(): void {
    const res = clearGoal(directory);
    if (res.ok) {
      debouncedToast({ message: "Goal cleared", variant: "warning" });
    } else if (res.reason === "no-goal") {
      debouncedToast({ message: "No active goal to clear", variant: "info" });
    } else {
      debouncedToast({ message: `Could not clear goal: ${res.error ?? "unknown error"}`, variant: "error" });
    }
  }

  function confirmClear(): void {
    safeReplaceDialog(() =>
      api.ui.DialogConfirm({
        title: "Clear goal?",
        message: "This stops the auto-loop and clears the current goal.",
        onConfirm: () => { clear(); api.ui.dialog.clear(); },
        onCancel: () => api.ui.dialog.clear(),
      })
    );
  }

  // ── Dial command openers ────────────────────────────────────────────────
  // Each dial opens a DialogPrompt; on confirm we call the typed handler
  // from tui-dials-logic.ts, toast the result, and clear the dialog.
  // The dialog is the "fire-and-forget" form (no busy state) because the
  // underlying primitives are all sync and fast (sub-ms file writes).

  function openPrompt(opts: {
    title: string;
    placeholder?: string;
    initialValue?: string;
    onSubmit: (value: string) => { ok: boolean; message: string };
  }): void {
    safeReplaceDialog(() =>
      api.ui.DialogPrompt({
        title: opts.title,
        placeholder: opts.placeholder,
        value: opts.initialValue,
        onConfirm: (value: string) => {
          const res = opts.onSubmit(value);
          debouncedToast({
            message: res.message,
            variant: res.ok ? "success" : "error",
            duration: res.ok ? 3000 : 5000,
          });
          api.ui.dialog.clear();
        },
        onCancel: () => api.ui.dialog.clear(),
      })
    );
  }

  function openTurnsDial(): void {
    openPrompt({
      title: "Set max turns",
      placeholder: turnsPlaceholder(directory),
      onSubmit: (v) => handleTurnsSubmit(directory, v),
    });
  }

  function openTimeDial(): void {
    openPrompt({
      title: "Set max time (minutes)",
      placeholder: timePlaceholder(directory),
      onSubmit: (v) => handleTimeSubmit(directory, v),
    });
  }

  function openTokensDial(): void {
    openPrompt({
      title: "Set max tokens",
      placeholder: tokensPlaceholder(directory),
      onSubmit: (v) => handleTokensSubmit(directory, v),
    });
  }

  function openConditionDial(): void {
    const current = readDashboardState(directory);
    // Capture the current state.id for optimistic-concurrency control
    // (FIX-10). If the id changes by the time the user submits (because
    // another session issued `/goal set`), the primitive refuses with
    // "stale-snapshot" and the user is told to re-review.
    const capturedId = current.state?.id;
    openPrompt({
      title: "Edit goal condition",
      placeholder: conditionPlaceholder(directory),
      initialValue: current.state?.condition ?? "",
      onSubmit: (v) => handleConditionSubmit(directory, v, capturedId),
    });
  }

  function openSteerDial(): void {
    openPrompt({
      title: "Steer the next attempt",
      placeholder: steerPlaceholder(directory),
      onSubmit: (v) => handleSteerSubmit(directory, v),
    });
  }

  function openSetGoalDial(): void {
    openPrompt({
      title: "Set a new goal",
      placeholder: "make all tests pass",
      onSubmit: (v) => {
        const res = setGoalFields(directory, { condition: v });
        return {
          ok: res.ok,
          message: res.ok ? `Goal set: ${res.state.condition}` : (res.error ?? "Goal not set."),
        };
      },
    });
  }

  function openHandoffDial(): void {
    openPrompt({
      title: "Handoff to a future session",
      placeholder: handoffNotePlaceholder(directory),
      onSubmit: (v) => handleHandoffSubmit(directory, v.trim() || undefined),
    });
  }

  function runClearSteering(): void {
    const res = handleClearSteeringSubmit(directory);
    debouncedToast({ message: res.message, variant: res.ok ? "info" : "error" });
  }

  function runRestart(): void {
    // Confirm before clobbering counters.
    safeReplaceDialog(() =>
      api.ui.DialogConfirm({
        title: "Restart goal?",
        message: "This clears counters, evaluations, and gives a new id. The condition and constraints are kept.",
        onConfirm: () => {
          const res = handleRestartSubmit(directory);
          debouncedToast({
            message: res.message,
            variant: res.ok ? "success" : "error",
          });
          api.ui.dialog.clear();
        },
        onCancel: () => api.ui.dialog.clear(),
      })
    );
  }

  function runClaim(): void {
    const res = handleClaimSubmit(directory);
    debouncedToast({
      message: res.message,
      variant: res.ok ? "success" : "error",
      duration: res.ok ? 4000 : 5000,
    });
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

      // ── Dials (v0.2.0+) ───────────────────────────────────────────────
      { name: "goal.dial.turns", title: "Goal: Set max turns", category: "Goal: Dials", namespace: "palette", slashName: "goal-turns", run() { openTurnsDial(); } },
      { name: "goal.dial.time", title: "Goal: Set max time (min)", category: "Goal: Dials", namespace: "palette", slashName: "goal-time", run() { openTimeDial(); } },
      { name: "goal.dial.tokens", title: "Goal: Set max tokens", category: "Goal: Dials", namespace: "palette", slashName: "goal-tokens", run() { openTokensDial(); } },
      { name: "goal.dial.condition", title: "Goal: Edit condition", category: "Goal: Dials", namespace: "palette", slashName: "goal-condition", run() { openConditionDial(); } },
      { name: "goal.dial.steer", title: "Goal: Steer next attempt", category: "Goal: Dials", namespace: "palette", slashName: "goal-steer", run() { openSteerDial(); } },
      { name: "goal.dial.set", title: "Goal: Set new goal", category: "Goal", namespace: "palette", slashName: "goal-set", run() { openSetGoalDial(); } },
      { name: "goal.dial.clear-steering", title: "Goal: Clear steering notes", category: "Goal: Dials", namespace: "palette", slashName: "goal-clear-steering", run() { runClearSteering(); } },
      { name: "goal.dial.restart", title: "Goal: Restart (same condition)", category: "Goal: Dials", namespace: "palette", slashName: "goal-restart", run() { runRestart(); } },
      { name: "goal.dial.handoff", title: "Goal: Handoff to future session", category: "Goal: Dials", namespace: "palette", slashName: "goal-handoff", run() { openHandoffDial(); } },
      { name: "goal.dial.claim", title: "Goal: Claim handoff", category: "Goal: Dials", namespace: "palette", slashName: "goal-claim", run() { runClaim(); } },
    ],
    bindings: [
      { key: "alt+g", cmd: "goal.dashboard", desc: "Open goal dashboard" },
      { key: "alt+p", cmd: "goal.toggle", desc: "Pause/resume goal" },
      { key: "alt+s", cmd: "goal.dial.steer", desc: "Steer next attempt" },
      { key: "alt+n", cmd: "goal.dial.set", desc: "Set a new goal" },
      { key: "alt+c", cmd: "goal.clear", desc: "Clear goal" },
      // Bind Escape to close the dashboard, but with `preventDefault: false`
      // and `fallthrough: true` so the key event ALSO reaches the
      // host's other Esc listeners (notably the command palette, which
      // uses Esc to dismiss). Without these, the plugin's Esc binding
      // consumes the key event for the dashboard, and the host's
      // command-palette Esc-to-close handler never fires — leaving the
      // user "stuck" inside an open command palette with no way to
      // back out except Ctrl-C.
      { key: "escape", cmd: "goal.dashboard.close", desc: "Close goal dashboard", preventDefault: false, fallthrough: true },
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
  //
  // Idempotency: the host may call `onDispose` more than once (hot-reload,
  // multi-init, plugin unload + reload). The `disposed` flag prevents the
  // second call from re-running already-disposed functions and tripping
  // the swallow path. The try/catch is retained for the first run because
  // the host's keymap/route APIs can throw if their internal state was
  // already torn down by a prior lifecycle event.
  const disposers: Array<() => void> = [];
  if (typeof keymapDispose === "function") disposers.push(keymapDispose);
  if (typeof routeDispose === "function") disposers.push(routeDispose);
  let disposed = false;
  api.lifecycle.onDispose(() => {
    if (disposed) return;
    disposed = true;
    for (const d of disposers) {
      try {
        d();
      } catch {
        // Best-effort. The host's keymap/route APIs may have already torn
        // down their internal state (e.g. on hot-reload). A throw here
        // would prevent later disposers from running and leak handlers,
        // so we swallow and continue.
      }
    }
  });
};

const plugin: TuiPluginModule & { id: string } = { id: "opencode-autogoal/tui", tui };
export default plugin;
