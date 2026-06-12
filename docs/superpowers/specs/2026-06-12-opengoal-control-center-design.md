# OpenGoal Control Center — zero-dep interactive TUI (v0.6.0, part 1)

**Status**: approved (time-boxed build). **Baseline**: `main` after the
time-budget/SSRF fixes (821 tests green). **Audience**: implementer.

## Goal

Evolve the read-only `watch` frame into a full-screen, keyboard-driven
**control center** for the goal loop. Pure ANSI + raw-mode stdin, **zero new
runtime dependencies** (Node built-ins only), runs in any terminal. Plus a
polish pass on the line CLI. Smart agent/model routing is explicitly OUT
(sub-project 2, its own spec).

## Why zero-dep

The package is primarily an OpenCode plugin installed into other people's
environments; every dependency becomes theirs. It must "load under Node OR
Bun, anywhere." `watch` already proves a polished zero-dep live dashboard;
interactivity just adds raw-mode input + a render loop on top of the
`presentGoalState` view-model.

## Architecture

Mirror the repo's pure-logic / render split (`tui-logic.ts` vs `tui.tsx`).

### `src/control-center-logic.ts` — PURE (the heavily-tested heart)
- `buildControlModel(stateResult, chain, handoff, archive, now): ControlModel`
  — assembles a flat view model (reuses `presentGoalState`).
- `renderFrame(model, width, height, theme): string[]` — content lines with
  inline SGR; NO cursor moves / NO I/O. Width-clamped, height-aware.
- `keyToAction(key, mode, status): Action | null` — table-driven; actions
  invalid for the current status return null (no-op).
- `reduceInput(inputState, key): InputState` — hand-rolled mini line editor
  (char / backspace / left-right / submit / cancel) for steer/condition/dial/
  set prompts.
- `Action` is a discriminated union: `{kind:'pause'|'resume'|'clear'|'restart'
  |'handoff'|'claim'|'quit'|'help'|'scrollUp'|'scrollDown'}` or
  `{kind:'prompt', field:'steer'|'condition'|'turns'|'time'|'tokens'|'set'}`.

### `src/control-center.ts` — thin impure shell
Owns: alt-screen enter/leave (`\x1b[?1049h`/`l`), cursor hide/show, raw mode
(`readline.emitKeypressEvents` + `setRawMode`), the keypress wiring, the
`createGoalWatcher` subscription, resize + 1s elapsed-tick timers,
`restoreTerminal()`, and routing actions to the EXISTING goal-state
primitives (`transitionGoal`, `appendSteering`, `editCondition`, `editMax*`,
`restartGoal`, `createHandoff`, `claimHandoff`, `setGoalFields`). No new goal
logic — an interactive skin over what exists.

### `src/format.ts` — zero-dep color/table (line-CLI polish)
Theme-aware SGR (honors `NO_COLOR` + non-TTY → empty codes), status glyphs,
an aligned-table renderer. Applied ONLY at CLI-owned, non-dispatcher
boundaries.

## Layout & panels (vertical, reflow to size)
Header (status pill · condition · chain step) → progress bar
(`max(turns%,time%)`) + `turns·time·tokens` → last-evaluation + last-3-evals
strip (✓/!/·) → steering notes → chain + scrollable archive when present →
context-sensitive key footer.

## Keybindings
`p` pause/resume · `s` steer · `e` edit condition · `t`/`m`/`k`
turns/time/tokens · `R` restart (confirm) · `c` clear (confirm) · `n` new
goal · `H` handoff · `C` claim · `↑/↓/PgUp/PgDn` scroll · `?` help · `q`/`Esc`
quit. Destructive actions get a yes/no confirm modal; text actions enter the
inline line editor (Enter submit, Esc cancel).

## CLI integration
- New action `tui`; bare `opencode-autogoal` in a TTY ALSO launches it.
  `--help`/`help`/non-TTY → help (unchanged). Handled in `main()` before the
  dispatcher (like `watch`/`doctor`), long-running, `WATCH_KEEP_RUNNING`
  sentinel, SIGINT → `restoreTerminal()` → exit 0.
- Non-TTY `tui`: refuse with a message pointing at `watch`/`--json status`,
  exit 1.
- Line-CLI polish applied to: colored `doctor` table, richer `watch`,
  sectioned/colored `--help`, and color on the `cli.ts` human-mode write path
  guarded by `TTY && !--json`.

## Hard constraints (do not break)
- `--json` envelope and the prose-identity-pinned `dispatchGoalCommand`
  strings stay byte-for-byte. Color is a presentation wrapper at the CLI
  boundary, NEVER baked into dispatcher `message`s.
- `docs-drift.test.mjs` pins docs-vs-code claims — update it with any
  README/help changes.
- Clean teardown is sacred: SIGINT / `q` / crash / `process.on("exit")` all
  run one idempotent `restoreTerminal()` so the terminal is never left wedged.
- All state text routed through `sanitizeForPrompt` before reaching a frame
  line (strips control/bidi/format chars that would corrupt the ANSI layout).

## Testing (house style: import from `dist/`, temp dirs, `finally` cleanup)
- `renderFrame` per state (active/paused/achieved/cleared/corrupt/absent):
  key substrings, width clamp, height fit, and NO stray `\x1b` except theme
  SGR.
- `keyToAction` full table incl. disabled-by-status; `reduceInput` line
  editor; `buildControlModel` assembly.
- `format.ts`: table alignment, `NO_COLOR` → no SGR, non-TTY → no SGR.
- Guards: `tui` non-TTY exits with message; `restoreTerminal()` idempotent.
- Interactive end-to-end needs a pty (not added) — pure-logic coverage is the
  contract, same as `watch`/`renderWatchFrame`.

## Ship
Version bump to 0.6.0, CHANGELOG entry, README section (TUI + screenshots/
asciicast optional), `package.json` `files[]` already ships `dist/` wholesale.
`npm run build` + `npm test` + `npm pack` smoke before any publish.

## Out of scope (sub-project 2, separate spec)
Smart agent/model assignment ("route task X to agent/model Y"). The action
API + view-model here are designed so a Routing panel and an `assign` action
slot in later without rework.
