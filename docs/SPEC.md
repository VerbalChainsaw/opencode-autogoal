# opencode-autogoal — Specification

> **Reconstructed from:** CHANGELOG.md (v0.1.0–v0.7.0), `specs/*.md`, `src/*.ts`, test files
> **Status:** v0.7.0
> **Date:** 2026-06-13

---

## REQ-001: CLI Entry Point

**Status:** CONFIRMED (v0.1.0, CHANGELOG)

The package provides a CLI executable at `dist/cli.js` with entry `opencode-autogoal` in `package.json`.

**Flags:**
- `--dir <path>` — set project root (default: cwd)
- `--json` — output as JSON envelope (`{ok, kind, exitCode, message, state?}`)

**Exit codes:** 0=success, 1=user error, 2=precondition not met, 3=I/O error, 4=corrupt state

**Bare invocation in interactive TTY:** launches the TUI control center (`tui` command).

Acceptance:
- AC-001.1: `opencode-autogoal --help` prints help text.
- AC-001.2: `opencode-autogoal [--dir <path>] <command>` executes the command.
- AC-001.3: `--json` output is a single JSON line.
- AC-001.4: Bare `opencode-autogoal` in interactive terminal launches TUI.
- AC-001.5: Non-TTY bare invocation prints help.

---

## REQ-002: Goal State Management

**Status:** CONFIRMED (v0.1.0, CHANGELOG; core types in `src/goal-state.ts`)

A goal has: condition text, optional verification command, status (active/paused/achieved/cleared), creation timestamp, start timestamp, evaluation counter, token counter, last evaluation, evaluation history (capped at 10), constraints (maxTurns, maxTimeMinutes, maxTokens), and metadata (setBy, sessionId, steering, chain info, webhook).

**State file:** `.opencode/.goal-state.json` — atomic writes (temp file + rename).

**Validation:** `validateGoalState()` enforces shape, type, and bound checks. Oversize files (>256KB) are rejected as corrupt.

**Corrupt state handling:** Corrupt files are renamed to `.goal-state.json.corrupt.<ts>` for forensic recovery. The `ReadResult<T>` discriminated union (`absent | corrupt | ok`) surfaces the failure mode.

Acceptance:
- AC-002.1: State file is written atomically (never partial).
- AC-002.2: Invalid/missing state file is handled gracefully as "no goal."
- AC-002.3: Corrupt state file is quarantined (renamed).
- AC-002.4: Constraints are bounded: turns [1, 10000], time [1, 10000] min, tokens [1, 10000000].

---

## REQ-003: CLI Commands

**Status:** CONFIRMED (CHANGELOG, `src/cli.ts`)

| Command | Aliases | Description | Version |
|---------|---------|-------------|---------|
| `set <condition>` | — | Set a new goal | v0.1.0 |
| `view` | `status` | Show current goal | v0.1.0 |
| `tui` | — | Interactive TUI control center | v0.6.0 |
| `watch` | — | Live terminal dashboard (polling) | v0.5.0 |
| `doctor` | — | Health check | v0.5.0 |
| `pause` | — | Pause auto-loop | v0.1.0 |
| `resume` | — | Resume paused goal | v0.1.0 |
| `clear` | `stop`, `off`, `reset`, `none`, `cancel` | Clear goal | v0.1.0 |
| `restart` | — | Restart with same condition | v0.2.0 |
| `history` | — | Show last 10 evaluations | v0.4.0 |
| `template` | `use` | Goal templates | v0.4.0 |
| `turns <n>` | — | Set max turns | v0.2.0 |
| `time <n>` | — | Set max time | v0.2.0 |
| `tokens <n>` | — | Set max tokens | v0.2.0 |
| `condition <text>` | — | Edit goal condition | v0.2.0 |
| `steer <hint>` | — | Add steering note | v0.2.0 |
| `unsteer` | — | Clear steering notes | v0.2.0 |
| `handoff` | — | Create session handoff | v0.2.0 |
| `claim` | — | Claim pending handoff | v0.2.0 |
| `chain` | — | Goal chain commands | v0.4.0 |
| `archive` | — | List past outcomes | v0.5.0 |
| `stats` | — | Archive statistics | v0.5.0 |

**NO standalone web server command** (`serve`). Locked by test in v0.6.1.

Acceptance:
- AC-003.1: All 22 commands dispatch correctly.
- AC-003.2: Exit codes follow the documented table.
- AC-003.3: `package.json` does not export `./control-server`.
- AC-003.4: `src/cli.ts` does not contain `serve` help text.

---

## REQ-004: OpenCode Plugin — Conversational Tools

**Status:** CONFIRMED (v0.1.0+, `src/server.ts`)

The server plugin registers tools:

| Tool | Function | Version |
|------|----------|---------|
| `set_goal` | Set a new goal | v0.1.0 |
| `goal_status` | Report current goal | v0.1.0 |
| `clear_goal` | Clear active goal | v0.1.0 |
| `pause_goal` | Pause auto-loop | v0.1.0 |
| `resume_goal` | Resume paused goal | v0.1.0 |
| `goal_get_state` | Read goal state as JSON string | v0.3.0 |
| `goal_turns` | Set max turns | v0.2.0 |
| `goal_time` | Set max time | v0.2.0 |
| `goal_tokens` | Set max tokens | v0.2.0 |
| `goal_condition` | Edit condition | v0.2.0 |
| `goal_steer` | Add steering note | v0.2.0 |
| `goal_clear_steering` | Clear steering | v0.2.0 |
| `goal_restart` | Restart goal | v0.2.0 |
| `goal_handoff` | Create handoff | v0.2.0 |
| `goal_claim` | Claim handoff | v0.2.0 |
| `goal_webhook` | Configure webhook | v0.4.0 |

Acceptance:
- AC-004.1: Each tool invokes the correct `goal-state.ts` primitive.
- AC-004.2: Tools return human-readable strings suitable for toasts.

---

## REQ-005: OpenCode Plugin — Auto-Loop

**Status:** CONFIRMED (v0.1.0+, `src/server.ts`)

The plugin listens for `session.idle` events, evaluates the goal condition, and auto-restarts the agent if the goal is not met.

**Evaluator types:**
- **Shell command** (`command` field): `child_process.exec`, 30s timeout, 1MB output cap, exit code 0 = met.
- **Verification (v0.4.0+):** Structured verification — `shell`, `http` (fetch URL, check status/body), `file` (check path exists/contains), `marker` (GOAL_COMPLETE signal).
- **Heuristic** (no command): `detectMarker()` scans for `GOAL_COMPLETE:` / `GOAL_BLOCKED:` lines in transcript, respecting code fence boundaries.

**Constraint enforcement:** max turns, max time (excludes paused intervals). Clears goal on limit reached.

**Blocked detection:** `GOAL_BLOCKED:` marker → pauses the goal automatically.

**Session error handling:** `session.error` event → pauses the goal.

Webhook POST on status transitions: active/paused/achieved/cleared. Loopback URL blocked by default.

Acceptance:
- AC-005.1: Auto-loop triggers on `session.idle` for active goals.
- AC-005.2: Shell verification runs with timeout and output cap.
- AC-005.3: HTTP verification checks status code and optional body regex.
- AC-005.4: File verification checks existence and optional content regex.
- AC-005.5: Marker detection respects code fence boundaries.
- AC-005.6: Constraint violations clear the goal.
- AC-005.7: GOAL_BLOCKED pauses the goal.
- AC-005.8: Session error pauses the goal.
- AC-005.9: Webhook fires on status transitions.

---

## REQ-006: OpenCode Plugin — Session Events & Step Timeline

**Status:** CONFIRMED (v0.7.0, `src/session-events.ts`, `src/step-timeline.ts`)

Two append-only JSONL files:

- `.opencode/.session-events.jsonl` — records tool execution events (tool-start, tool-end, message). Capped at 5000 lines / 2 MB.
- `.opencode/.step-timeline.jsonl` — records auto-loop evaluation events. Capped at 1000 lines / 1 MB.

Both are best-effort (failures silently swallowed). Trimmed atomically when caps exceeded.

Acceptance:
- AC-006.1: Server emits session events on tool execute.
- AC-006.2: Server emits timeline events on evaluation.
- AC-006.3: Files are trimmed atomically at cap.
- AC-006.4: Corrupt lines are silently skipped on read.

---

## REQ-007: TUI Control Center

**Status:** CONFIRMED (v0.6.0–v0.7.0, `src/control-center.ts`, `src/control-center-logic.ts`, `src/control-center-pane.ts`, `src/control-center-history.ts`, `src/help-content.ts`, `src/help-overlay.ts`, `src/picker.ts`)

Interactive terminal UI launched via `tui` command or bare `opencode-autogoal` in TTY.

**Features (v0.6.0):**
- Keyboard-driven: p=toggle pause, s=steer, e=edit condition, t/turns, m/time, k/tokens, n=new goal, c=clear, R=restart, q/ctrl-c/esc=quit
- Inline editor for prompt fields (steer, condition, dials, set)
- Scroll support (`↑/↓`)
- Goal pane: status, condition, progress, steering list, eval history strip
- Confirm dialogs for destructive actions

**Features (v0.7.0):**
- Three-pane layout: goal (left) + session (right) in stack mode; single-column stacked mode (<80 width); compact mode (<16 height or no session)
- Live session pane: activity feed (tool calls) + step timeline (evaluations) — refreshed via 2s setInterval tick
- Drill-down mode (Tab): browse history, evaluations, steering list; select to view detail; `c` to OSC 52 copy; `e` to inline edit
- A=archive picker, T=templates picker, D=inline doctor
- L/O=open `.opencode/` in OS file manager
- g=copy full goal state JSON to clipboard (OSC 52)
- Ctrl+L=redraw screen
- `?`=categorized help overlay (n/p paginate, typing filters)
- `authors` seam for injection in tests (readers, fileOpener, onExit)

**Layout modes:** stack (side-by-side ≥80w), stacked (single-column), compact (no session pane). Pure `control-center-pane.ts`.

**History drill-down:** reducer-based (`control-center-history.ts`): Tab to enter, ↑/↓ to navigate, Enter for detail view, Esc to exit.

**Picker:** reducer-based (`picker.ts`): ↑/↓ navigation with itemCount clamping, Enter to select.

Acceptance:
- AC-007.1: TUI launches with bare `opencode-autogoal` in TTY.
- AC-007.2: All key bindings dispatch correct actions.
- AC-007.3: Three-pane layout adapts to terminal size.
- AC-007.4: Drill-down mode shows history items.
- AC-007.5: Help overlay opens and paginates.
- AC-007.6: `Ctrl+L` redraws. `q`/Esc quits.

---

## REQ-008: GUI Integration

**Status:** CONFIRMED (v0.3.0+, `src/gui.ts`, `docs/gui-integration.md`)

`src/gui.ts` exports:

- `readGoalStateSafe(directory)` — returns `{state, corrupt, summary}`. Never throws. Sanitizes strings for display. Preserves corrupt signal.
- `createGoalWatcher(directory, callback, options?)` — watches `.opencode/.goal-state.json` for changes via `fs.watch` + polling fallback. Returns `{dispose, refresh}`.
- `presentGoalState(state, handoffPresent, now)` — returns `{icon, statusLabel, progressPct, turnsLabel, timeLabel, tokensLabel, lastReason, steeringCount, hasHandoff, summaryLine, chainStep}`.
- `validateGoalState()` — re-exported from `goal-state.ts`.
- `sanitizeForPrompt()` — re-exported from `goal-state.ts`.

Documented contract at `docs/gui-integration.md`: polling at 2s recommended, tool-based mutation, corrupt-state signaling.

Acceptance:
- AC-008.1: `readGoalStateSafe` never throws.
- AC-008.2: `createGoalWatcher` fires on file change + initial read.
- AC-008.3: `presentGoalState` returns display-ready structure.

---

## REQ-009: Goal Chains

**Status:** CONFIRMED (v0.4.0, `src/goal-chain.ts`)

File-backed step sequencer at `.opencode/.goal-chain.json`. Steps auto-advance on achievement. Chain webhook config re-projects to current step's metadata.

Acceptance:
- AC-009.1: Chain auto-advances on goal achievement.
- AC-009.2: Chain completion fires webhook.

---

## REQ-010: Goal Archive

**Status:** CONFIRMED (v0.5.0, `src/goal-archive.ts`)

Append-only JSONL file at `.opencode/goal-archive.jsonl`. Records achieved, cleared, and replaced outcomes. Capped at 1 MB / trimmed to newest 200 lines. `archive` lists newest 10; `stats` shows aggregated totals.

Acceptance:
- AC-010.1: Archive records outcomes at all three chokepoints (achieved, cleared, replaced).
- AC-010.2: Archive is trimmed atomically at cap.
- AC-010.3: `archive` and `stats` commands display correct data.

---

## REQ-011: Goal Templates

**Status:** CONFIRMED (v0.4.0, `src/templates.ts`)

Built-in templates (fix-lint, fix-types, all-tests-pass, code-review) plus user templates in `.opencode/goals/<name>.json`. `template list/export/import` commands. Template variables for parameterized conditions.

Acceptance:
- AC-011.1: Built-in templates are discoverable.
- AC-011.2: User templates override builtins.
- AC-011.3: Template variables are resolved.

---

## REQ-012: Webhook Notifications

**Status:** CONFIRMED (v0.4.0, `src/server.ts` `fireWebhook`)

Status transition webhooks via `goal_webhook` tool. POSTs JSON to configured URL on status changes. Localhost URLs blocked by default. Control chars sanitized in payload.

Acceptance:
- AC-012.1: Webhook fires on active/paused/achieved/cleared transitions.
- AC-012.2: Loopback URLs are blocked unless `allowLocal` is set.

---

## REQ-013: No Standalone Web Server

**Status:** CONFIRMED (v0.6.1, CHANGELOG)

The CLI does NOT ship a `serve` command or any standalone HTTP server. The Desktop Goals panel belongs in OpenCode's `packages/app`, not as a third-party web server. Locked by test in `test/cli.test.mjs`.

Acceptance:
- AC-013.1: `src/cli.ts` does not contain `serve` command handling.
- AC-013.2: `package.json` does not export `./control-server`.
- AC-013.3: Test `cli.test.mjs` asserts the no-web-server invariant.

---

## REQ-014: Security Model

**Status:** CONFIRMED (`SECURITY.md`, code)

- State file is a trust boundary (contains user-controlled strings and the verification command).
- All user-controlled strings routed through `sanitizeForPrompt` before prompt injection or display.
- Webhook payload is sanitized.
- Path traversal guard in file verification.
- SSRF guard in webhook (loopback blocked by default).
- Atomic writes prevent partial-file reads.

Acceptance:
- AC-014.1: `sanitizeForPrompt` strips C0/C1/Unicode-format chars.
- AC-014.2: Verification commands have timeout and output cap.
- AC-014.3: File verification blocks path traversal.

---

## REQ-015: Sidebar Plugin (OpenCode Desktop)

**Status:** CONFIRMED (v0.3.0+, `src/sidebar-logic.ts`, `src/sidebar.tsx`)

SolidJS sidebar component for OpenCode Desktop. Shows goal status, progress bar, eval strip, steering count, handoff indicator. Dials via slash commands. Keyboard shortcuts: alt+g dashboard, alt+p pause/resume, alt+s steer, alt+n set, alt+c clear.

Acceptance:
- AC-015.1: Sidebar renders goal state when available.
- AC-015.2: Keyboard shortcuts dispatch correct actions.

---

## REQ-016: TUI Dashboard (OpenCode Terminal)

**Status:** CONFIRMED (v0.1.0+, `src/tui.tsx`, `src/tui-logic.ts`, `src/tui-dials-logic.ts`)

OpenTUI-based terminal dashboard for OpenCode terminal users. Goal status, progress, dials, historical eval strip. Keyboard navigation.

Acceptance:
- AC-016.1: TUI dashboard renders in OpenCode terminal.
- AC-016.2: Dials work via keyboard.

---

## INFERRED Requirements (from code behavior)

These are requirements deduced from source code and tests, not explicitly documented in CHANGELOG or specs.

### REQ-I001: Handoff System

**Status:** INFERRED (from `src/goal-state.ts` `createHandoff`, `claimHandoff`)

A handoff file at `.opencode/.goal-handoff.json` preserves goal state for resumption in a future session. `handoff` CLI command writes it; `claim` reads and resumes. Handoff files have size caps and validation.

### REQ-I002: Compaction Hook

**Status:** INFERRED (from `src/server.ts`)

The plugin listens for `experimental.session.compacting` events and re-injects the goal context, ensuring the goal survives OpenCode session compaction.

### REQ-I003: Pre-commit Hook (tools/guard-spec-ref.sh)

**Status:** INFERRED (from untracked `tools/` directory)

A pre-commit hook that blocks commits touching `src/` without a `specs/` reference in the commit message. Not yet committed to the repo.

### REQ-I004: AGENTS.md Standing Rules

**Status:** INFERRED (from untracked `AGENTS.md` at repo root)

9-rule document: "the spec wins," "host integration = host-consumed artifacts," "wrong-surface commits are mined not reverted," etc. Not yet committed to the repo.

---

## REQ-017: RenderBlock Protocol (Server-Side Emission)

**Status:** CONFIRMED (feature/desktop-blocks-integration, `src/blocks/`)

The server plugin emits typed RenderBlock arrays via `ctx.metadata()` for the OpenCode Desktop BlockRenderer to render as rich tool output cards. Per `specs/render-protocol-design.md` §2-4.

### REQ-017.1: Block Types

**Status:** CONFIRMED

`src/blocks/types.ts` defines all 8 block types per spec §2:
`text`, `stat-row`, `progress`, `code`, `list`, `table`, `row`, `custom`.
Plus `BlockAction` type per §2.3, `BlockValidationError` per §4.1,
and `ValidatedBlocks` result type.

### REQ-017.2: Validation

**Status:** CONFIRMED

`src/blocks/validate.ts` implements `validateBlocks()` per spec §4.1:
key validation, version validation, size caps, cardinality limits,
row depth guard, custom block namespace check, sequence monotonicity,
fallback block synthesis when all blocks invalid, and prototype
pollution defense (`sanitizeBlock`).

### REQ-017.3: Factory API

**Status:** CONFIRMED

`src/blocks/factories.ts` exports `blocks.text()`, `blocks.statRow()`,
`blocks.progress()`, `blocks.code()`, `blocks.list()`, `blocks.table()`,
`blocks.row()`, `blocks.custom()`, and `blocks.action()`. Mirrors the
planned `import { blocks } from "@opencode-ai/sdk/blocks"` API.

### REQ-017.4: Goal-State Mapping

**Status:** CONFIRMED

`src/blocks/goal-blocks.ts` maps GoalState → RenderBlock arrays:
- `buildGoalStatusBlocks(state, handoff, now)` — status header, stat row,
  progress bar, last evaluation, eval history list, steering list,
  chain indicator, handoff indicator
- `buildGoalTransitionBlocks(state, action)` — transition confirmation
  with stat row

### REQ-017.5: Tool Integration

**Status:** CONFIRMED

`src/server.ts` calls `ctx.metadata({ metadata: { blocks } })` on:
- `goal_status` — goal status display blocks
- `clear_goal`, `pause_goal`, `resume_goal`, `goal_restart` — transition confirmation blocks

All calls guarded by `emitBlocks()` which checks `typeof ctx.metadata === "function"`
and wraps in try/catch — silently degrades on older SDKs and test harnesses.

Acceptance:
- AC-017.1: All 8 block types match spec definitions.
- AC-017.2: `validateBlocks` catches invalid keys, oversized content, duplicate keys, exceeded caps.
- AC-017.3: `blocks.*` factory helpers produce valid blocks.
- AC-017.4: `buildGoalStatusBlocks` produces blocks with correct keys and types.
- AC-017.5: Block emission does not break backward compatibility (string tool returns preserved).
- AC-017.6: Tests cover validation, goal-status blocks, and transition blocks.
- AC-017.7: 1053 baseline + 42 new = 1095 total tests pass.
