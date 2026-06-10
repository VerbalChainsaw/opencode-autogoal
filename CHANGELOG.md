# Changelog

## 0.2.0-rc.1

**New: persistent goal sidebar (terminal TUI).**

The sidebar is a sibling TUI plugin (separate entry at `opencode-autogoal/sidebar`)
that registers against the OpenCode host's `sidebar_title` / `sidebar_content` /
`sidebar_footer` slot map. It shows the live goal state — status icon, condition,
progress bar, turn/time counters, last evaluation reason — in every session, without
the user having to navigate to a full-screen dashboard.

### What's new

- **`opencode-autogoal/sidebar` subpath export.** Opt-in. Enable by adding
  `"opencode-autogoal/sidebar"` to your `tui.json` `plugin` array, alongside
  the existing `opencode-autogoal/tui` (or on its own — the sidebar is
  independent of the dashboard).
- **`src/sidebar-logic.ts`** — pure view-model builder. No JSX, no SDK
  imports; same shape as `tui-logic.ts`. Reads via the validated
  `readDashboardState` + `computeProgress` from `tui-logic.ts`, so the
  sidebar and the dashboard can never see different states.
- **`src/sidebar.tsx`** — thin TUI plugin. Calls `api.slots.register()`,
  renders the three slots via a host-driven invalidation pattern (no
  polling, no per-second CPU burn).
- **Defensive view-model.** All condition / lastEvaluation strings are
  sanitized for newlines, control chars, and C1 escape sequences before
  they reach the sidebar's single-line title slot. A hostile state file
  cannot break the sidebar's box layout.
- **TUI dashboard refactor** (carried over from the prior in-flight work).
  `tui.tsx` now uses a `useGoalState` SolidJS hook that subscribes to the
  host's `file.watcher.updated` event stream and re-reads on state-file
  change. The dashboard's stale-on-load symptom is closed.

### Compatibility notes

- **Desktop users (Electron): no change.** The Desktop app does not load
  TUI plugins; the sidebar is terminal-only, same as the existing
  dashboard. The Desktop Goals tab is a separate upstream PR in
  OpenCode's `packages/app` (see `specs/desktop-ui-design.md`).
- **Dashboard users (`opencode-autogoal/tui`): no change.** The dashboard
  still works; its render path was refactored but the user-visible
  behavior is unchanged.
- **Server plugin users: no change.** The state file format is unchanged.

### New tests

- 36 new tests in `test/sidebar-logic.test.mjs` covering:
  - `sanitizeForSidebar`: newlines, tabs, C0 + C1 control chars, printable
    unicode (emoji + CJK), runs of spaces, trim, non-string defense
  - `truncate`: short, long, `maxLen=1`, `maxLen=0` defensive
  - `buildSidebarTitle`: no goal, active, paused, long-condition truncate,
    newline-in-condition, empty condition, control-char-only condition
  - `buildSidebarContent`: no goal block, 0%/50%/100% progress, counters
    formatting, lastEvaluation present + absent + sanitized, hostile
    numeric inputs (negative turns, zero constraints) — never crashes
  - `buildSidebarFooter`: shape, single-line invariant
  - `buildSidebarView` (top-level): no-state file, active, paused,
    terminal states (achieved/cleared), corrupt states (constraints:{},
    negative turnsEvaluated, long condition), time forwarding

**Total: 125 tests, all passing on Windows + Linux (CI matrix).**

## 0.1.2

**Robustness + correctness pass: 8 of the cycle-0 audit's BLOCKER + IMPORTANT findings closed.**

This is a behavior-changing release. The plugin's output is the same; the
internal state file, validation, and detection have all been tightened.
Anyone relying on the pre-0.1.2 quirks (e.g. crafting a state file with
`constraints: {}` for some reason) will see those states ignored. Users
typing goals interactively are unaffected.

### BLOCKER-level fixes

- **Marker false-positives in code blocks and quoted examples** (B1). The
  `GOAL_COMPLETE:` / `GOAL_BLOCKED:` marker detector was tripping whenever
  the agent explained the protocol in a markdown code block (a line
  starting `GOAL_COMPLETE: ...` inside ```` ``` ```` or `~~~` fences).
  The detector is now fence-aware — lines inside fenced code blocks are
  ignored, lines indented 4+ spaces (markdown's "indented code block"
  threshold) are ignored, and the marker is case-sensitive (lowercase
  `goal_complete:` does NOT trip). See `test/goal-state.test.mjs` for
  the regression suite. The README claim that "the agent merely *talking
  about* the protocol won't trip the goal" is now true (it was a
  documentation lie before).

- **`0` accepted for constraint limits → goal immediately cleared on first
  idle** (B2). `parseConstraints` now clamps to `[1, 10_000]` for turns
  and minutes, `[1, 10_000_000]` for tokens. Out-of-range values fall
  back to the per-field default rather than the user-typed-but-invalid
  number, so a typo can't silently kill a goal. The cycle-0 case
  `stop after 99999 turns` no longer produces a 99999-turn goal; it
  falls back to the default 20.

- **`validateGoalState` accepted `constraints: {}` → silent infinite
  loop** (B5). The validator now deep-checks every field the runtime
  reads: `constraints` must have all 3 numeric fields, `command` must
  be `string | null | undefined` (not array, not object), `status` must
  be one of the 4 known values, `turnsEvaluated`/`tokensUsed` must be
  non-negative numbers, `evaluationHistory` must be an array. A
  hand-crafted or power-cut-partial state file is now rejected with a
  clean "no state" result rather than crashing later in `execAsync`.

- **TUI dashboard crashed on a corrupt state file** (B4). The TUI had its
  own `readState`/`writeState` that bypassed validation, re-implemented
  the I/O, and silently swallowed write errors. The TUI now imports
  the validated `readGoalState` and `transitionGoal` from
  `goal-state.ts`; a new `src/tui-logic.ts` module owns the dashboard's
  read/decision surface (progress-bar math, toggle/clear) and is
  fully unit-tested. The old failure modes (RangeError on negative
  turns, silent toast on write failure, TUI/server state drift) are
  closed.

### IMPORTANT-level fixes

- **`command.execute.before` replaced `output.parts` wholesale** (I9).
  The hook now appends its text part rather than replacing the array,
  preserving any preamble parts the host put in. The cast
  `as unknown as (typeof output.parts)[number]` is preserved (the host
  fills the id/sessionID/messageID) but the cast is no longer load-
  bearing for the whole parts array.

- **Event handler was a chain of string `event.type === "..."` checks**
  (I8). Replaced with a `switch` on the discriminated union. The SDK
  exports a closed union, so a future SDK addition forces a compile
  error here — the agent won't silently miss new event types.

- **`parseShellWords` exposed for cross-platform command diagnostics**
  (I6). The cycle-0 audit found that `child_process.exec` uses
  `/bin/sh -c` on POSIX and `cmd.exe /d /s /c` on Windows, so a
  `--command` string can tokenize differently on the two. The plugin
  still uses `exec` (users want shell semantics — pipes, redirects,
  `&&`), but the new `parseShellWords` helper gives a portable argv
  view that the plugin logs at debug level. This is also the
  foundation for a future `verificationShell: "none"` opt-in for
  security-sensitive environments. See SECURITY.md for the cross-
  shell discussion.

### Platform hygiene

- **Stale `opencode-autogoal-0.1.0.tgz` deleted.** It predated the v0.1.1
  permission-prompt fix and was missing `dist/permissions.{js,d.ts}`;
  any consumer following the README's "smoke-test the packaged tarball"
  path would have installed a broken v0.1.0.
- **`prepack: "npm run build"` added** so `npm pack` always reflects
  current source. The README's smoke-test path now works.
- **`CHANGELOG.md` and `SECURITY.md` now ship in the tarball** (added
  to the `files` array). Consumers can see what changed and where to
  report vulns without visiting the repo.
- **`package-lock.json` no longer gitignored + CI uses `npm ci`** with
  `cache: 'npm'`. CI installs are now reproducible.
- **`tui.json` cleaned up** (dropped the dead `plugin_enabled` field
  with a misleading comment; documented the dev-vs-consumer subpath
  difference).
- **Orphan `test-bugfixes.ps1` and `test-scripts.ps1` deleted.** They
  referenced the deleted legacy `.opencode/skills/goal/scripts/*`
  files. The Node test suite is the canonical test surface.

### New tests

- 8 new tests for `parseShellWords` (POSIX word splitting, quoting,
  backslash escapes, edge cases)
- 9 new tests for the marker detector (code-fence awareness,
  case-sensitivity, prose indent, last-match-wins, deeply nested
  conversations)
- 8 new tests for `validateGoalState` (every rejected shape, every
  accepted shape)
- 7 new tests for the constraint clamp (0, 1e20, in-range, upper
  bound, just-above, fallback behavior)
- 21 new tests for the TUI logic layer (read/toggle/clear against
  validated I/O, cross-validation with the server)

**Total: 88 tests, all passing on Windows + Linux (CI matrix).**

### Unverified-in-source contracts (known risks)

The cycle-0 audit flagged two hooks whose contracts cannot be verified
from source — they only fire against a live OpenCode runtime. The code
is defensive (the cast at `server.ts:308` is documented) but the
SMOKE-TEST path in the README is the actual verification:

- `command.execute.before` — the cast `as unknown as (typeof
  output.parts)[number]` is the documented contract (the host fills
  the part's id/sessionID/messageID). If OpenCode changes this, the
  cast becomes a runtime error rather than a typecheck error.
- `experimental.session.compacting` — the `output.context: string[]`
  shape is verified at the type level; the host's rendering of the
  string is not.

## 0.1.1

**Fix: the auto-loop no longer collides with tool-permission prompts.**

A session can go idle *while waiting for the user to approve a tool
permission*. In 0.1.0 the loop would inject its "continue" nudge anyway,
which started a new turn and orphaned the pending request — surfacing
as **"permission request not found"** and an agent that churned
(re-building, re-editing) instead of waiting.

0.1.1 tracks open permission requests via the `permission.updated` /
`permission.replied` events and **skips evaluation/nudging while any
permission is open** for that session. If a reply never arrives, the
loop simply pauses for that session — failing safe. (New
`PendingPermissions` helper, unit-tested.)

Reminder (unchanged behavior worth repeating): an active goal steers
every turn until it's met. Prefer `--command` goals (deterministic),
keep conditions specific, and use `/goal pause` or `/goal clear` the
moment it drifts.

## 0.1.0

Initial release.

- Conversational tools (`set_goal` / `goal_status` / `clear_goal` /
  `pause_goal` / `resume_goal`) — set goals by talking to OpenCode.
- `/goal` command + a `session.idle` auto-loop.
- Deterministic `--command` verification (exit 0 = met) and a read-only
  `GOAL_COMPLETE` / `GOAL_BLOCKED` completion protocol.
- Turn/time limits, built-in + project templates, pause/resume/clear.
- Cross-platform TypeScript core; ships compiled `dist/`; zero
  installed deps beyond the OpenCode plugin API.
