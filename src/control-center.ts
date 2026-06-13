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
import { spawn } from "node:child_process";
import { join as pathJoin } from "node:path";
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
  sanitizeForPrompt,
} from "./goal-state.js";
import { readGoalStateSafe, createGoalWatcher } from "./gui.js";
import { readSessionEvents, type SessionEvent } from "./session-events.js";
import { readStepTimeline, type StepTimelineEvent } from "./step-timeline.js";
import { readGoalArchive, type ArchiveEntry } from "./goal-archive.js";
import { discoverTemplatesForUi, type TemplateSummary } from "./templates-view.js";
import { createStyler, supportsColor, truncate, type Styler } from "./format.js";
import { renderControlCenter, type ComposerControlModel } from "./control-center-pane.js";
import {
  drillReducer,
  initialDrillState,
  type DrillState,
} from "./control-center-history.js";
import { buildHelpSections } from "./help-content.js";
import { buildHelpOverlay } from "./help-overlay.js";
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

export interface RunControlOpts {
  directory: string;
  stdin?: any;
  stdout?: any;
  stderr?: any;
  env?: Record<string, string | undefined>;
  /** Exit hook (default `process.exit`). Injected so the quit/teardown path is
   *  observable in tests without killing the test process. */
  onExit?: (code: number) => void;
  /** v0.7.0 — readers seam. The shell's data sources (goal state,
   *  handoff, session events, step timeline, archive, templates)
   *  are all routed through this map. The default is the real
   *  filesystem-backed readers; tests inject fakes so the
   *  composer can be exercised without a workspace dir.
   *
   *  The seam is opt-in: callers that don't pass `readers` get
   *  the same behavior as v0.6.0 (live reads). Callers that DO
   *  pass `readers` get the v0.7.0 Live Session pane populated
   *  from the injected sources. */
  readers?: ControlCenterReaders;
  /** v0.7.0 — file-opener seam. The shell's L/O actions spawn
   *  a file manager on the platform's binary (explorer.exe
   *  / open / xdg-open). Tests inject a no-op so they don't
   *  spawn a real process. The default opens the .opencode/
   *  dir in the OS file manager (detached, unref'd). */
  fileOpener?: (path: string) => void;
}

/** v0.7.0 — the readers the shell uses to populate the three-pane
 *  composer. Each reader is `(directory) => result`. The directory
 *  is always passed (so the shell owns the path resolution; the
 *  readers are pure functions of the directory). */
export interface ControlCenterReaders {
  readGoalStateSafe: (directory: string) => ReturnType<typeof readGoalStateSafe>;
  readHandoff: (directory: string) => { createdAt: string; note?: string } | null;
  readSessionEvents: (directory: string) => SessionEvent[];
  readStepTimeline: (directory: string) => StepTimelineEvent[];
  readArchiveEntries: (directory: string) => ArchiveEntry[];
  discoverTemplatesForUi: (directory: string) => TemplateSummary[];
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

  // v0.7.0 — readers seam. Default to the real filesystem-backed
  // readers; tests inject the `readers` opt to drive the composer
  // without a workspace dir. The seam is the single source of truth
  // for what data the composer sees: goal state, handoff, session
  // events, step timeline, archive, templates. Future actions
  // (the A key for archive, the T key for templates) can read
  // archive + templates directly from this map.
  const readers: ControlCenterReaders = opts.readers ?? {
    readGoalStateSafe: (d) => readGoalStateSafe(d),
    readHandoff: (d) => {
      const r = readHandoffResult(d);
      return r.kind === "ok" ? { createdAt: r.value.createdAt, note: r.value.note } : null;
    },
    readSessionEvents: (d) => readSessionEvents(d, 50),
    readStepTimeline: (d) => readStepTimeline(d, 25),
    readArchiveEntries: (d) => readGoalArchive(d, 50).entries,
    discoverTemplatesForUi: (d) => discoverTemplatesForUi(d),
  };

  // v0.7.0 — file-opener. Default: spawn the platform's file
  // manager (detached, unref'd) on the .opencode/ dir. Tests
  // inject a no-op so they don't spawn a real process. We
  // use a sync-to-call, async-in-effect spawn: the function
  // returns synchronously after the spawn, and the child
  // process runs independently. The unref() ensures the
  // child doesn't keep the parent alive past the test.
  const fileOpener: (path: string) => void = opts.fileOpener ?? ((p: string) => {
    try {
      const cmd = process.platform === "darwin" ? "open"
        : process.platform === "win32" ? "explorer.exe"
        : "xdg-open";
      const child = spawn(cmd, [p], { detached: true, stdio: "ignore" });
      if (typeof child.unref === "function") child.unref();
    } catch (err) {
      // Spawn failed (e.g. missing binary on PATH). The
      // shell toasts the failure. We don't throw — a
      // failed open is not a fatal shell error.
      console.warn(`[opencode-autogoal] fileOpener spawn failed: ${(err as Error).message}`);
    }
  });

  let mode: Mode = "normal";
  let input: InputState = { value: "", cursor: 0, done: null };
  let promptField: PromptField = "set";
  let pendingAction: Action | null = null;
  // v0.7.0 — Block D overlay. The 7 new actions (A, T, D,
  // L, O, g, Ctrl+L) render an inline overlay at the top
  // of the screen. The handlers in onKey set this to a
  // pre-rendered string array; render() splices it into
  // the composer's output. Clearing it on any other keypress
  // makes the overlay a one-shot — press the key, see the
  // overlay, press any other key, see the goal pane again.
  let pendingOverlay: string[] | null = null;
  // v0.7.0 — categorized help overlay. The shell owns the
  // page (which section is showing) and the search query.
  // The renderer (buildHelpOverlay) is pure. `helpVisible`
  // is true when the overlay is shown; the page and query
  // are reset to defaults when the overlay opens.
  let helpPage = 0;
  let helpQuery = "";
  let toast = "";
  let helpVisible = false;
  let scrollOffset = 0;
  let restored = false;
  let watcher: { dispose: () => void } | null = null;
  // v0.7.0 — drill-down navigation state. The shell owns the
  // state and dispatches keypresses to the pure reducer in
  // control-center-history.ts. The mode 'drill' is a new
  // branch in `mode` (the existing four are 'normal' /
  // 'input' / 'confirm' / 'help' — see control-center-logic.ts).
  let drill: DrillState = initialDrillState("steering", 0);

  function statusForKeys(): "active" | "paused" | "achieved" | "cleared" | "absent" {
    const r = readers.readGoalStateSafe(directory);
    if (r.corrupt || !r.state) return "absent";
    return r.state.status;
  }

  function render(): void {
    const r = readers.readGoalStateSafe(directory);
    const handoff = readers.readHandoff(directory);
    const handoffPresent = handoff !== null;
    const corruptArtifact = r.corrupt ? (listCorruptArtifacts(directory)[0] ?? null) : null;
    const width = stdout.columns ?? 80;
    const height = stdout.rows ?? 24;
    const now = Date.now();

    let lines: string[];
    if (helpVisible) {
      // v0.7.0 — categorized help overlay. The page and
      // query are owned by the shell; the renderer is a
      // pure function in help-overlay.ts.
      const sections = buildHelpSections();
      lines = buildHelpOverlay(sections, helpPage, helpQuery, width);
    } else {
      // v0.7.0 — the three-pane composer (`renderControlCenter`)
      // takes the model + the session events + the timeline +
      // the chain step and lays them out across the terminal.
      // The readers are the seam; tests inject fakes. The
      // composer's inline goal-pane renderer mirrors the legacy
      // buildGoalPane so the v0.6.0 single-pane experience is
      // preserved when the session pane has no data. The
      // legacy `renderFrame` is preserved for the `watch` command.
      const model = buildControlModel(r, { handoffPresent, corruptArtifact, now });
      const composerModel: ComposerControlModel = {
        kind: model.kind as ComposerControlModel["kind"],
        icon: model.icon,
        statusLabel: model.statusLabel,
        condition: model.condition,
        progressPct: model.progressPct,
        turnsLabel: model.turnsLabel,
        timeLabel: model.timeLabel,
        tokensLabel: model.tokensLabel,
        lastReason: model.lastReason,
        evalStrip: model.evalStrip,
        steering: model.steering,
        chain: model.chain,
        corruptArtifact: model.corruptArtifact,
        summary: model.summary,
        command: model.command,
      };
      const events = readers.readSessionEvents(directory);
      const timeline = readers.readStepTimeline(directory);
      const composer = renderControlCenter({
        model: composerModel,
        events,
        timeline,
        chainStep: model.chain,
        width,
        height: Math.max(4, height - 2),
        st,
        focus: 0,
        now,
      });
      lines = composer.lines;
    }

    // v0.7.0 — Block D overlay. The 7 new actions (A, T,
    // D, L, O, g, Ctrl+L) set `pendingOverlay` to a list
    // of pre-rendered lines. We splice them into the top
    // of the composer's output. The overlay is a one-shot:
    // it's cleared by the next render (any non-overlay
    // keystroke sets pendingOverlay to null). This keeps
    // the goal pane visible underneath and makes the
    // overlay a "flashed" view rather than a permanent
    // modal — a future v0.7.x can switch to a centered
    // modal that requires an explicit Esc.
    if (pendingOverlay) {
      const overlayWidth = Math.min(width, 80);
      for (let i = 0; i < pendingOverlay.length && i < lines.length; i++) {
        const line = pendingOverlay[i] ?? "";
        lines[i] = truncate(line, overlayWidth);
      }
      pendingOverlay = null;
    }

    // v0.7.0 — drill-down overlay. When the user is in
    // drill mode, render the active list (steering or
    // history) with the cursor highlighted and a hint at
    // the bottom. The overlay is a compact 5-row block at
    // the top of the screen so the goal pane stays visible
    // underneath. (A future v0.7.x can switch to a centered
    // modal; for v0.7.0 the inline overlay is the simplest
    // thing that works.)
    if (mode === "drill") {
      const r = readers.readGoalStateSafe(directory);
      const state = r.state;
      const lines2: string[] = [];
      lines2.push(truncate(`─── DRILL: ${drill.kind.toUpperCase()} ───`, width));
      // Build the items with their full (untruncated) content
      // so the detail view can render it.
      const items: Array<{ label: string; full: string }> = [];
      if (drill.kind === "steering" && state) {
        const steering = Array.isArray(state.metadata.steering) ? state.metadata.steering : [];
        for (const s of steering) {
          const note = sanitizeForPrompt(s.note ?? "");
          items.push({ label: note.slice(0, 60), full: note });
        }
      } else if (drill.kind === "history" && state) {
        const hist = Array.isArray(state.evaluationHistory) ? state.evaluationHistory : [];
        for (const e of hist) {
          const reason = sanitizeForPrompt(e.reason ?? "(empty)");
          const tag = e.met ? "✓" : e.blocked ? "!" : "·";
          items.push({
            label: `${tag} ${reason.slice(0, 60)}`,
            full: reason, // C15: untruncated for the detail view
          });
        }
      }
      const visibleStart = Math.max(0, Math.min(items.length - 1, drill.cursor - 2));
      const visibleEnd = Math.min(items.length, visibleStart + 7);
      for (let i = visibleStart; i < visibleEnd; i++) {
        const item = items[i];
        if (!item) continue;
        const cursor = i === drill.cursor ? "▶" : " ";
        lines2.push(truncate(`${cursor} ${item.label}`, width));
      }
      // C15 — full-reason detail view. When drill.detailOpen
      // is true, the line under the cursor shows the FULL
      // (untruncated) content. The shell's `c` keystroke
      // copies the full content to the clipboard via OSC 52
      // (C16).
      if (drill.detailOpen) {
        const item = items[drill.cursor];
        if (item) {
          // Wrap the full content to the terminal width. The
          // simplest split: line-break at width-3 (3 chars
          // for the "   " indent).
          const indent = "   ";
          const innerWidth = Math.max(1, width - indent.length);
          const full = item.full;
          if (full.length <= innerWidth) {
            lines2.push(truncate(`${indent}${full}`, width));
          } else {
            // Word-wrap (best-effort; falls back to char-split
            // for long unbreakable strings like a stack trace).
            const words = full.split(/\s+/);
            let line = "";
            for (const w of words) {
              if ((line + (line ? " " : "") + w).length <= innerWidth) {
                line = line ? line + " " + w : w;
              } else {
                if (line) lines2.push(truncate(`${indent}${line}`, width));
                line = w.length > innerWidth ? w.slice(0, innerWidth) : w;
              }
            }
            if (line) lines2.push(truncate(`${indent}${line}`, width));
          }
          // C16 hint — the `c` key copies the full content.
          lines2.push(truncate(`${indent}(press c to copy)`, width));
        } else {
          lines2.push(truncate(`   (no detail for this item — press Enter to act)`, width));
        }
      }
      // Render the drill overlay as the top of the screen;
      // the goal pane fills the rest. (Simple approach for
      // v0.7.0 — the composer renders the full frame, and we
      // overwrite the first N lines with the drill overlay.)
      for (let i = 0; i < lines2.length && i < lines.length; i++) {
        lines[i] = lines2[i];
      }
    }

    let bottom = "";
    if (mode === "input") bottom = `${promptLabel(promptField)} ${input.value}`;
    else if (mode === "confirm") bottom = toast;
    else if (toast) bottom = toast;

    stdout.write(`\x1b[2J\x1b[H${lines.join("\r\n")}\r\n\r\n${st.dim(truncate(bottom, width))}`);
  }

  const exit = opts.onExit ?? ((code: number) => process.exit(code));
  const onSigint = () => cleanupAndExit(0);
  const onProcessExit = () => {
    if (!restored) {
      restored = true;
      restoreTerminal(stdout, stdin);
    }
  };
  const onResize = () => render();

  function cleanupAndExit(code: number): void {
    if (restored) return;
    restored = true;
    try { if (watcher) watcher.dispose(); } catch { /* ignore */ }
    try { if (typeof stdin.off === "function") stdin.off("keypress", onKey); } catch { /* ignore */ }
    try { if (typeof process.off === "function") process.off("SIGINT", onSigint); } catch { /* ignore */ }
    try { if (typeof process.off === "function") process.off("exit", onProcessExit); } catch { /* ignore */ }
    try { if (typeof stdout.off === "function") stdout.off("resize", onResize); } catch { /* ignore */ }
    try { if (typeof stdin.pause === "function") stdin.pause(); } catch { /* ignore */ }
    restoreTerminal(stdout, stdin);
    exit(code);
  }

  function onKey(_str: string | undefined, key: Key | undefined): void {
    if (!key) return;
    if (key.ctrl && key.name === "c") { cleanupAndExit(0); return; }

    if (helpVisible) {
      // v0.7.0 — help overlay. Esc and q close. n / p
      // navigate pages. Any printable key (other than the
      // page nav and quit keys) is appended to the search
      // query. Backspace removes the last query char.
      if (key.name === "escape" || key.name === "q") {
        helpVisible = false;
        helpPage = 0;
        helpQuery = "";
        render();
        return;
      }
      if (key.name === "n" && !key.ctrl) {
        const sections = buildHelpSections();
        helpPage = Math.min(sections.length - 1, helpPage + 1);
        render();
        return;
      }
      if (key.name === "p" && !key.ctrl) {
        helpPage = Math.max(0, helpPage - 1);
        render();
        return;
      }
      if (key.name === "backspace") {
        helpQuery = helpQuery.slice(0, -1);
        render();
        return;
      }
      if (key.name === "/" && helpQuery === "") {
        // `/` opens the search field. The next typed
        // characters become the query. (v0.7.0 keeps the
        // model simple: typing / starts a search, typing
        // more refines, backspace removes.)
        helpQuery = "/";
        render();
        return;
      }
      if (key.sequence && key.sequence.length === 1 && /[a-zA-Z0-9 ]/.test(key.sequence)) {
        // Append a printable char to the query. The search
        // filters case-insensitively on substring match.
        helpQuery = (helpQuery === "/" ? "" : helpQuery) + key.sequence;
        render();
        return;
      }
      // Other keys (arrow keys, function keys, etc.) are
      // ignored while the help overlay is open.
      return;
    }

    // v0.7.0 — drill-down mode. Handles Tab (enter/exit
    // drill-down), ↑/↓ (cursor), Enter (open detail / select),
    // Esc (exit). The reducer is pure (control-center-history.ts);
    // the shell owns the mode + state + the side effects when
    // done='selected' (e.g. opens the inline editor for a
    // steering note). C15-C17 wire those side effects.
    if (mode === "drill") {
      // `q` is the universal exit — even from drill-down. The
      // user expects to be able to quit the control center at
      // any time.
      if (key.name === "q" || (key.ctrl && key.name === "c")) {
        cleanupAndExit(0);
        return;
      }
      if (key.name === "escape") {
        drill = drillReducer(drill, { kind: "esc" });
        if (drill.done === "cancelled") {
          drill = { ...drill, done: null };
          mode = "normal";
          toast = "(drill-down cancelled)";
        }
        render();
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        drill = drillReducer(drill, { kind: "enter" });
        if (drill.done === "selected") {
          // The first Enter opens the detail (drill.detailOpen
          // becomes true). The second Enter on the same item
          // commits the selection (drill.done === "selected").
          // v0.7.0: clear the done flag and stay in drill-down.
          // A future v0.7.x can act on the selection (e.g. open
          // the inline editor for the selected steering note
          // — see C17 for the auto-open path).
          drill = { ...drill, done: null };
        }
        render();
        return;
      }
      if (key.name === "up" || key.name === "pageup") {
        drill = drillReducer(drill, { kind: "up" });
        render();
        return;
      }
      if (key.name === "down" || key.name === "pagedown") {
        drill = drillReducer(drill, { kind: "down" });
        render();
        return;
      }
      if (key.name === "tab") {
        drill = drillReducer(drill, { kind: "tab" });
        render();
        return;
      }
      // C16 — `c` in drill-down copies the current item's
      // full content to the clipboard via OSC 52. The OSC
      // 52 sequence is the standard terminal clipboard
      // write — most modern terminals (including Windows
      // Terminal, iTerm2, gnome-terminal, kitty) honor it.
      if (key.name === "c" && !key.ctrl) {
        const r = readers.readGoalStateSafe(directory);
        const state = r.state;
        let full = "";
        if (state) {
          if (drill.kind === "steering") {
            const arr = Array.isArray(state.metadata.steering) ? state.metadata.steering : [];
            const item = arr[drill.cursor];
            if (item) full = sanitizeForPrompt(item.note ?? "");
          } else if (drill.kind === "history") {
            const arr = Array.isArray(state.evaluationHistory) ? state.evaluationHistory : [];
            const item = arr[drill.cursor];
            if (item) full = sanitizeForPrompt(item.reason ?? "");
          }
        }
        if (full) {
          // OSC 52: \x1b]52;c;<base64>\x07. The base64
          // encoding of a UTF-8 string. We use Buffer to be
          // correct for non-ASCII (the sanitizer ensures the
          // string is mostly ASCII, but a defensive encoding
          // path is cheap).
          const b64 = Buffer.from(full, "utf-8").toString("base64");
          stdout.write(`\x1b]52;c;${b64}\x07`);
          toast = "Copied to clipboard.";
        } else {
          toast = "Nothing to copy.";
        }
        render();
        return;
      }
      // C17 — `e` in drill-down opens the inline editor for
      // the current steering note (only when the active
      // list is "steering" and the cursor is on a real
      // item). The editor is the same prompt mode the
      // v0.6.0 standalone TUI uses for `s`; the difference
      // is the pre-fill: the v0.7.0 editor pre-fills the
      // existing note text so the user can edit it.
      if (key.name === "e") {
        const r = readers.readGoalStateSafe(directory);
        const state = r.state;
        if (state && drill.kind === "steering") {
          const arr = Array.isArray(state.metadata.steering) ? state.metadata.steering : [];
          const item = arr[drill.cursor];
          if (item) {
            // Switch to input mode, pre-fill with the note text.
            // C17 uses the existing promptField='steer' path but
            // with a pre-filled input value. The submit handler
            // appendSteering's, but the v0.7.0 detail flow
            // appends with an [edit:] prefix to make the trail
            // explicit. (For v0.7.0 we just call appendSteering
            // with the new value; the [edit:] prefix is a v0.7.x
            // refinement.)
            input = { value: item.note ?? "", cursor: (item.note ?? "").length, done: null };
            mode = "input";
            promptField = "steer";
            toast = "Edit steering note — Enter to submit, Esc to cancel.";
            render();
            return;
          }
        }
        toast = "No editable item at cursor.";
        render();
        return;
      }
      // Any other key in drill-down is ignored (the user has
      // narrowed the keyboard surface to ↑/↓/Enter/Esc/Tab/c/e).
      return;
    }

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

    // v0.7.0 — Tab from normal mode enters drill-down. We
    // intercept the key here (before keyToAction, which is
    // action-based) and route it to the drill-down flow.
    // The shell picks the initial kind (steering first, falls
    // back to history) based on what's non-empty in the
    // current goal state. The itemCount is the size of the
    // chosen list so the reducer can clamp the cursor.
    if (key.name === "tab" && mode === "normal") {
      const r = readers.readGoalStateSafe(directory);
      const state = r.state;
      const steering = state && Array.isArray(state.metadata.steering) ? state.metadata.steering : [];
      const history = state && Array.isArray(state.evaluationHistory) ? state.evaluationHistory : [];
      let kind: "steering" | "history";
      let itemCount: number;
      if (steering.length > 0) {
        kind = "steering"; itemCount = steering.length;
      } else if (history.length > 0) {
        kind = "history"; itemCount = history.length;
      } else {
        // No drill-down content available — toast and stay
        // in normal mode. The user can dismiss with Esc.
        toast = "Nothing to drill into — no steering or history yet.";
        render();
        return;
      }
      drill = initialDrillState(kind, itemCount);
      mode = "drill";
      toast = `[drill] ${kind} (${itemCount} items) — ↑/↓ to navigate, Esc to exit`;
      render();
      return;
    }

    // v0.7.0 — the 7 new actions (D19-D24). These are NOT
    // routed through keyToAction (which is the v0.6.0 action
    // table) — they're keystroke-driven shell effects that
    // sit alongside the existing p/s/e/R/c/n/H/C/↑/↓/Tab
    // keys. Each action sets `pendingOverlay` to a list of
    // pre-rendered lines; render() splices them into the
    // composer's output. The overlay is cleared by any
    // subsequent keystroke (or by the tick — v0.7.0 uses a
    // short timeout so the user sees the overlay but the
    // goal pane is back after a few seconds).
    //
    // A — view goal archive. (D19)
    if (key.name === "a" && !key.ctrl) {
      const entries = readers.readArchiveEntries(directory);
      if (entries.length === 0) {
        toast = "No archived goals yet.";
      } else {
        const lines2: string[] = [];
        lines2.push(`─── ARCHIVE (${entries.length}) ───`);
        for (let i = 0; i < Math.min(entries.length, 5); i++) {
          const e = entries[i];
          if (!e) continue;
          const date = new Date(e.archivedAt).toISOString().replace("T", " ").slice(0, 19);
          const cond = sanitizeForPrompt(e.state.condition).slice(0, 40);
          lines2.push(`  ${date}  ${e.outcome}  ${cond}`);
        }
        pendingOverlay = lines2;
        toast = "Archive shown above. (Full list: opencode-autogoal archive.)";
      }
      render();
      return;
    }
    // T — view templates list. (D20)
    if (key.name === "t" && !key.ctrl) {
      const templates = readers.discoverTemplatesForUi(directory);
      if (templates.length === 0) {
        toast = "No templates available.";
      } else {
        const lines2: string[] = [];
        lines2.push(`─── TEMPLATES (${templates.length}) ───`);
        for (let i = 0; i < Math.min(templates.length, 5); i++) {
          const t = templates[i];
          if (!t) continue;
          const tag = t.source === "builtin" ? "B" : "U";
          lines2.push(`  [${tag}] ${t.name}  ${t.description.slice(0, 40)}`);
        }
        pendingOverlay = lines2;
        toast = "Templates shown above. (Apply: opencode-autogoal template use <name>.)";
      }
      render();
      return;
    }
    // D — run doctor (inline modal). v0.7.0 ships a small
    // check surface; a future v0.7.x can wire the full
    // runDoctor() output. (D21)
    if (key.name === "d" && !key.ctrl) {
      const r = readers.readGoalStateSafe(directory);
      const lines2: string[] = [];
      lines2.push("─── DOCTOR ───");
      lines2.push(`  goal state: ${r.state ? "present" : "absent"}`);
      lines2.push(`  corrupt:    ${r.corrupt ? "yes (quarantined)" : "no"}`);
      lines2.push(`  node:       ${process.versions.node}`);
      lines2.push(`  package:    0.7.0`);
      pendingOverlay = lines2;
      toast = "Doctor checks shown above. (Full check: opencode-autogoal doctor.)";
      render();
      return;
    }
    // L — open .opencode/ dir. The fileOpener seam is the
    // injected function (or the default platform spawn). (D22)
    if (key.name === "l" && !key.ctrl) {
      const target = pathJoin(directory, ".opencode");
      try {
        fileOpener(target);
        toast = `Opened .opencode/ in ${process.platform} file manager.`;
      } catch (err) {
        toast = `Failed to open .opencode/: ${(err as Error).message}`;
      }
      render();
      return;
    }
    // O — same as L in v0.7.0 (alias). (D22)
    if (key.name === "o" && !key.ctrl) {
      const target = pathJoin(directory, ".opencode");
      try {
        fileOpener(target);
        toast = `Opened .opencode/ in ${process.platform} file manager.`;
      } catch (err) {
        toast = `Failed to open .opencode/: ${(err as Error).message}`;
      }
      render();
      return;
    }
    // g — copy full goal state JSON to clipboard via OSC 52. (D23)
    if (key.name === "g" && !key.ctrl) {
      const r = readers.readGoalStateSafe(directory);
      if (r.state) {
        try {
          const json = JSON.stringify(r.state, null, 2);
          const b64 = Buffer.from(json, "utf-8").toString("base64");
          stdout.write(`\x1b]52;c;${b64}\x07`);
          toast = "Copied goal state JSON to clipboard.";
        } catch (err) {
          toast = `Copy failed: ${(err as Error).message}`;
        }
      } else {
        toast = "No goal state to copy.";
      }
      render();
      return;
    }
    // Ctrl+L — redraw without re-reading state. (D24)
    if (key.ctrl && key.name === "l") {
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
      case "help": helpVisible = true; helpPage = 0; helpQuery = ""; render(); return;
      case "scrollUp": scrollOffset = Math.max(0, scrollOffset - 1); render(); return;
      case "scrollDown": scrollOffset += 1; render(); return;
      case "prompt":
        scrollOffset = 0;
        mode = "input";
        promptField = action.field;
        input = { value: "", cursor: 0, done: null };
        toast = "";
        render();
        return;
      case "clear": case "restart":
        scrollOffset = 0;
        pendingAction = action;
        mode = "confirm";
        toast = `Confirm ${action.kind}? [y/n]`;
        render();
        return;
      default:
        scrollOffset = 0;
        toast = applyAction(directory, action).message;
        render();
        return;
    }
  }

  // ── Enter the interactive terminal state ──
  stdout.write("\x1b[?1049h\x1b[?25l"); // alt screen + hide cursor
  emitKeypressEvents(stdin);
  if (stdin.isTTY) stdin.setRawMode(true);
  if (typeof stdin.resume === "function") stdin.resume();
  stdin.on("keypress", onKey);
  process.on("SIGINT", onSigint);
  process.on("exit", onProcessExit);
  if (typeof stdout.on === "function") stdout.on("resize", onResize);

  // The watcher fires on the initial read, on every file change, AND on its 1s
  // poll — so it doubles as the elapsed-time ticker. No separate timer needed.
  watcher = createGoalWatcher(directory, () => render(), { pollIntervalMs: 1000 });

  // v0.7.0 — the live-event tick. The goal-state watcher above
  // fires on .goal-state.json mtime, but the events and timeline
  // files (`.session-events.jsonl`, `.step-timeline.jsonl`)
  // change on every tool call and every evaluation, and neither
  // of those writes updates the goal state file. The tick is
  // the dedicated refresh for those surfaces — it fires on a
  // 2s cadence (configurable via OPENGCODE_TUI_TICK_MS, clamped
  // to [250, 30000]) and re-renders the shell. The 2s default
  // matches the recommended dashboard refresh for human-perceived
  // liveness without burning CPU.
  const tickMs = (() => {
    const raw = Number(process.env.OPENGCODE_TUI_TICK_MS);
    if (!Number.isFinite(raw)) return 2000;
    return Math.max(250, Math.min(30_000, Math.trunc(raw)));
  })();
  const tickHandle: { id: ReturnType<typeof setInterval> | null } = { id: null };
  tickHandle.id = setInterval(() => {
    // Re-render. The readers are the seam; the data flow is
    // already wired (B11). The tick is just a periodic trigger.
    try { render(); } catch { /* never let a render error kill the tick */ }
  }, tickMs);
  // Make sure the tick doesn't keep the process alive past the
  // last user action. (Same as the watcher's pattern.)
  if (typeof (tickHandle.id as any)?.unref === "function") {
    (tickHandle.id as any).unref();
  }

  // v0.7.0 — extended cleanup: dispose the tick on quit. The
  // existing cleanupAndExit already disposes the watcher; the
  // tick is a separate interval that needs its own clearInterval.
  // Wrap the original cleanup path so the test for "no leaked
  // timers" stays valid.
  const originalCleanup = cleanupAndExit;
  // The original cleanupAndExit is hoisted via function
  // declaration in the file; we can't reassign it. Instead, the
  // SIGINT/process-exit paths already remove their own
  // listeners; we just need to clear the tick interval. The
  // simplest hook: add a separate process.on("exit") that
  // clears the tick if the watcher disposal hasn't already
  // run. Idempotent — clearInterval on a non-existent id is a
  // no-op.
  const clearTick = () => {
    if (tickHandle.id !== null) {
      try { clearInterval(tickHandle.id); } catch { /* ignore */ }
      tickHandle.id = null;
    }
  };
  process.on("exit", clearTick);

  return CONTROL_KEEP_RUNNING;
}
