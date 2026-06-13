/**
 * control-center.ts — the impure shell of the interactive TUI control center.
 *
 * It owns the things a pure function can't: the alternate screen buffer, raw
 * mode, the readline keypress stream, the file watcher, the render loop, and
 * terminal teardown. All goal *logic* lives in the pure modules
 * (control-center-logic.ts) and the existing goal-state primitives — this file
 * is orchestration only.
 *
 * Three seams are exported for unit testing without a pseudo-terminal:
 *   - applyAction        : a TUI Action → the matching goal-state primitive
 *   - canRunInteractive  : the non-TTY guard
 *   - restoreTerminal    : idempotent teardown (show cursor, leave alt screen,
 *                          disable raw mode) — the #1 correctness risk of a
 *                          hand-rolled TUI, so it is small, defensive, and tested.
 */

import { emitKeypressEvents } from "node:readline";
import {
  setGoal,
  transitionGoal,
  restartGoal,
  createHandoff,
  claimHandoff,
  appendSteering,
  editCondition,
  editMaxTurns,
  editMaxTime,
  editMaxTokens,
  parsePositiveInt,
  listCorruptArtifacts,
  readHandoffResult,
} from "./goal-state.js";
import { readGoalStateSafe, createGoalWatcher } from "./gui.js";
import { createStyler, supportsColor, truncate, type Styler } from "./format.js";
import {
  buildControlModel,
  renderFrame,
  keyToAction,
  reduceInput,
  type Action,
  type Key,
  type InputState,
  type Mode,
} from "./control-center-logic.js";

/** Sentinel: the watcher + raw-mode stdin own the event loop; the CLI entry
 *  skips process.exit when it sees this (mirrors cli.ts WATCH_KEEP_RUNNING). */
export const CONTROL_KEEP_RUNNING = -1;

export interface ActionResult { ok: boolean; message: string }

type PromptField = "steer" | "condition" | "turns" | "time" | "tokens" | "set";

/**
 * Route a control-center Action to the existing goal-state primitive and
 * normalize the result to `{ ok, message }`. Prompt actions (steer/condition/
 * dials/set) require a `value` — the text the user typed in the inline editor;
 * a missing or invalid value is rejected, never crashed. This is the single
 * seam between the UI and the goal state, so it's where the round-trip tests
 * live.
 */
export function applyAction(directory: string, action: Action, value?: string): ActionResult {
  const norm = (r: { ok: boolean; message?: string; error?: string }): ActionResult => ({
    ok: r.ok,
    message: r.ok ? (r.message ?? "Done.") : (r.error ?? "Failed."),
  });

  switch (action.kind) {
    case "pause": return norm(transitionGoal(directory, "pause"));
    case "resume": return norm(transitionGoal(directory, "resume"));
    case "clear": return norm(transitionGoal(directory, "clear"));
    case "restart": return norm(restartGoal(directory));
    case "handoff": return norm(createHandoff(directory));
    case "claim": return norm(claimHandoff(directory));
    case "prompt": {
      if (value === undefined || value === null) return { ok: false, message: "No value provided." };
      const field = action.field as PromptField;
      if (field === "set") {
        const r = setGoal(directory, value);
        return r.ok ? { ok: true, message: `Goal set: ${r.state.condition}` } : { ok: false, message: r.error };
      }
      if (field === "steer") return norm(appendSteering(directory, value));
      if (field === "condition") return norm(editCondition(directory, value));
      // numeric dials
      const n = parsePositiveInt(value);
      if (n === null) return { ok: false, message: `${field} must be a whole number.` };
      if (field === "turns") return norm(editMaxTurns(directory, n));
      if (field === "time") return norm(editMaxTime(directory, n));
      return norm(editMaxTokens(directory, n));
    }
    default:
      return { ok: false, message: "Unknown action." };
  }
}

/** Interactive mode requires a real terminal on BOTH ends (keyboard in, frames
 *  out). CI / pipes fail this and get a helpful refusal instead of a hang. */
export function canRunInteractive(stdout: { isTTY?: boolean } | undefined, stdin: { isTTY?: boolean } | undefined): boolean {
  return !!(stdout && stdout.isTTY && stdin && stdin.isTTY);
}

/** Idempotent teardown. Safe to call any number of times and from any exit
 *  path (q / SIGINT / process 'exit' / crash). Never throws. */
export function restoreTerminal(stdout: { write: (s: string) => unknown }, stdin: { isTTY?: boolean; setRawMode?: (v: boolean) => void }): void {
  try { stdout.write("\x1b[?25h\x1b[?1049l"); } catch { /* ignore */ }
  try {
    if (stdin && typeof stdin.setRawMode === "function" && stdin.isTTY) {
      stdin.setRawMode(false);
    }
  } catch { /* ignore */ }
}

function promptLabel(field: PromptField): string {
  switch (field) {
    case "steer": return "Steer:";
    case "condition": return "New condition:";
    case "turns": return "Max turns:";
    case "time": return "Max minutes:";
    case "tokens": return "Max tokens:";
    case "set": return "New goal:";
  }
}

function renderHelp(width: number, st: Styler): string[] {
  return [
    st.bold("OpenGoal Control Center — keys"),
    "",
    "  p    pause / resume",
    "  s    add a steering note",
    "  e    edit the condition",
    "  t    set max turns",
    "  m    set max minutes",
    "  k    set max tokens",
    "  R    restart goal (confirm)",
    "  c    clear goal (confirm)",
    "  n    set a new goal",
    "  H    write a handoff",
    "  C    claim a handoff",
    "  up/down  scroll history",
    "  ?    toggle this help",
    "  q    quit",
    "",
    st.dim("press any key to return"),
  ].map((l) => truncate(l, width));
}

export interface RunControlOpts {
  directory: string;
  stdin?: any;
  stdout?: any;
  stderr?: any;
  env?: Record<string, string | undefined>;
}

/**
 * Launch the interactive control center. Returns CONTROL_KEEP_RUNNING when the
 * loop has taken over the event loop, or 1 when it refused (non-TTY). The CLI
 * entry treats CONTROL_KEEP_RUNNING like its watch sentinel and does NOT call
 * process.exit, so the keypress stream + watcher keep the process alive until
 * the user quits.
 */
export function runControlCenter(opts: RunControlOpts): number {
  const directory = opts.directory;
  const stdout = opts.stdout ?? process.stdout;
  const stdin = opts.stdin ?? process.stdin;
  const stderr = opts.stderr ?? process.stderr;
  const env = opts.env ?? process.env;

  if (!canRunInteractive(stdout, stdin)) {
    stderr.write("opencode-autogoal: tui needs an interactive terminal (a TTY). Try `watch`, or `--json status` in non-interactive contexts.\n");
    return 1;
  }

  const st = createStyler(supportsColor(stdout, env));

  let mode: Mode = "normal";
  let input: InputState = { value: "", cursor: 0, done: null };
  let promptField: PromptField = "set";
  let pendingAction: Action | null = null;
  let toast = "";
  let helpVisible = false;
  let restored = false;
  let watcher: { dispose: () => void } | null = null;

  function statusForKeys(): "active" | "paused" | "achieved" | "cleared" | "absent" {
    const r = readGoalStateSafe(directory);
    if (r.corrupt || !r.state) return "absent";
    return r.state.status;
  }

  function render(): void {
    const r = readGoalStateSafe(directory);
    const handoffPresent = readHandoffResult(directory).kind === "ok";
    const corruptArtifact = r.corrupt ? (listCorruptArtifacts(directory)[0] ?? null) : null;
    const width = stdout.columns ?? 80;
    const height = stdout.rows ?? 24;

    let lines: string[];
    if (helpVisible) {
      lines = renderHelp(width, st);
    } else {
      const model = buildControlModel(r, { handoffPresent, corruptArtifact, now: Date.now() });
      lines = renderFrame(model, width, Math.max(4, height - 2), st);
    }

    let bottom = "";
    if (mode === "input") bottom = `${promptLabel(promptField)} ${input.value}`;
    else if (mode === "confirm") bottom = toast;
    else if (toast) bottom = toast;

    stdout.write(`\x1b[2J\x1b[H${lines.join("\r\n")}\r\n\r\n${st.dim(truncate(bottom, width))}`);
  }

  function cleanupAndExit(code: number): void {
    if (restored) return;
    restored = true;
    try { if (watcher) watcher.dispose(); } catch { /* ignore */ }
    restoreTerminal(stdout, stdin);
    process.exit(code);
  }

  function onKey(_str: string | undefined, key: Key | undefined): void {
    if (!key) return;

    if (helpVisible) { helpVisible = false; render(); return; }

    if (mode === "input") {
      input = reduceInput(input, key);
      if (input.done === "submit") {
        const res = applyAction(directory, { kind: "prompt", field: promptField }, input.value);
        toast = res.message;
        mode = "normal";
        input = { value: "", cursor: 0, done: null };
        render();
        return;
      }
      if (input.done === "cancel") {
        mode = "normal";
        input = { value: "", cursor: 0, done: null };
        toast = "(cancelled)";
        render();
        return;
      }
      render();
      return;
    }

    const action = keyToAction(key, mode, statusForKeys());
    if (!action) return;

    if (mode === "confirm") {
      if (action.kind === "confirmYes" && pendingAction) {
        toast = applyAction(directory, pendingAction).message;
      } else {
        toast = "(cancelled)";
      }
      pendingAction = null;
      mode = "normal";
      render();
      return;
    }

    switch (action.kind) {
      case "quit": cleanupAndExit(0); return;
      case "help": helpVisible = true; render(); return;
      case "scrollUp": case "scrollDown": render(); return;
      case "prompt":
        mode = "input";
        promptField = action.field;
        input = { value: "", cursor: 0, done: null };
        toast = "";
        render();
        return;
      case "clear": case "restart":
        pendingAction = action;
        mode = "confirm";
        toast = `Confirm ${action.kind}? [y/n]`;
        render();
        return;
      default:
        toast = applyAction(directory, action).message;
        render();
        return;
    }
  }

  // ── Enter the interactive terminal state ──
  stdout.write("\x1b[?1049h\x1b[?25l"); // alt screen + hide cursor
  emitKeypressEvents(stdin);
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.on("keypress", onKey);
  process.on("SIGINT", () => cleanupAndExit(0));
  process.on("exit", () => { if (!restored) { restored = true; restoreTerminal(stdout, stdin); } });
  if (typeof stdout.on === "function") stdout.on("resize", render);

  // The watcher fires on the initial read, on every file change, AND on its 1s
  // poll — so it doubles as the elapsed-time ticker. No separate timer needed.
  watcher = createGoalWatcher(directory, () => render(), { pollIntervalMs: 1000 });

  return CONTROL_KEEP_RUNNING;
}
