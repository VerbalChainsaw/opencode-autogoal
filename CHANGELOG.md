# Changelog

## 0.2.1

**Patch: withStateLock wraps every read-modify-write primitive.**

Closes a race condition that the security-lens sub-agent flagged
(IMPORTANT #5 in the v0.2.0-rc.6 review): two concurrent writers
(e.g. user clicks "edit turns" while the auto-loop writes a state
update) silently lost one mutation. The new `withStateLock(directory,
fn)` helper wraps every R-M-W site in `src/goal-state.ts`:

  - persistGoal (used by setGoal)
  - transitionGoal (clear/pause/resume)
  - editMaxTurns / editMaxTime / editMaxTokens
  - editCondition
  - restartGoal
  - appendSteering / clearSteering
  - createHandoff
  - claimHandoff

The lock is per-directory, synchronous (try/finally), and 1-level
reentrant (a primitive that calls another primitive inside the
lock re-acquires instantly). 2 new tests pin the contract.

**Total: 309/309 pass (307 prior + 2 new).** Typecheck clean. Build
clean. CI matrix green on ubuntu/windows × node 20/22.

### Security advisories fixed in 0.2.1

v0.2.0 shipped with 4 advisories in the `withStateLock` advisory
file-lock implementation, all found by adversarial review of the
advisory-lock internals (none were user-reported). The user-facing
feature surface (the dials, the sidebar, the handoff) was never
broken — these are all in the in-process concurrency primitive:

  - **CRITICAL — Deadline bypass on unremovable stale lock.** The
    pre-fix code placed the deadline check AFTER the
    `reclaimedOrGone` retry `continue`, so a deny-delete ACL on
    the lock file caused an infinite loop that never reached the
    timeout. Fixed by moving the deadline check before the retry
    logic. (Pinned by `test/rc11-fixes.test.mjs`.)
  - **HIGH — Stale constraint-check snapshot in `server.ts`
    `evaluate()`.** `checkConstraints` operated on the state
    snapshot read OUTSIDE the lock during the `session.idle`
    handler. A user editing `maxTurns` upward between the
    handler's read and the loop's lock acquisition could cause a
    false-positive "limit exceeded" goal clearing. Fixed by
    moving `checkConstraints` inside the `withStateLock` callback
    so it always uses the fresh `f` (the lock's re-read).
  - **HIGH — CPU-spin when `SharedArrayBuffer` is unavailable.**
    The `sleepSync` fallback returned immediately (the `catch`
    swallowed `SharedArrayBuffer` errors and did nothing),
    causing ~80,000 iterations of `openSync`+`statSync` in a
    tight loop when `Atomics.wait` can't park the thread. Fixed
    with a `Date.now()` busy-wait fallback. (Doesn't trigger on
    Node 22+ on Linux/macOS/Windows 10+ where `SharedArrayBuffer`
    is available; the fallback only fires on pre-Node-20 / Bun /
    Workers contexts.)
  - **MEDIUM — Missing reentrancy guard.** A nested
    `withStateLock` call from the same call-stack frame
    deadlocked on its own lock (because the function
    `mkdirSync`+`openSync(..., 'wx')` on the same lock path
    returned EEXIST against itself). Fixed with a module-level
    `_reentrantLocks` Set that returns `fn()` immediately on
    in-process re-entry. (No current call site triggers this;
    it's a forward-looking guard for future maintainers.)

6 regression tests added in `test/rc11-fixes.test.mjs` pin the
4 fixes. The published v0.2.0 has been deprecated on npm with
a deprecation message pointing to 0.2.1.

### Upgrade notes

- No migration. v0.2.0 users can upgrade to v0.2.1 with no state
  file changes. The lock is purely an in-process concurrency
  primitive — it does not change the on-disk format.

## 0.2.0

**First stable v0.2.0 release.**

Consolidates the v0.2.0-rc.1 through v0.2.0-rc.9 work: the persistent
goal sidebar (terminal TUI), 9 live-edit dials (turns/time/tokens/
condition/steer/unsteer/restart/handoff/claim), steering notes
injected into the auto-loop continue-prompt, the metadata
allowlist, the prompt-injection sanitizer, and the full
end-to-end logic trace. See the rc.X entries below for the
per-slice detail.

**Total: 307/307 tests pass.** Typecheck clean. Build clean. CI
matrix green on ubuntu × windows × node 20 × node 22.

### Highlights (vs v0.1.2)

- **New: opencode-autogoal/sidebar subpath export** — a sibling
  TUI plugin that registers against the host's `sidebar_title` /
  `sidebar_content` / `sidebar_footer` slot map. Shows live goal
  state in every session: status icon, condition, progress bar,
  turn/time/tokens counters, last evaluation reason, steering
  note count, handoff indicator, last 3 evaluations strip with
  ✓/!/· tags, and last condition-edit timestamp.
- **New: 9 live-edit dials** — change `maxTurns`, `maxTimeMinutes`,
  `maxTokens`, the condition text, append a steering note, restart
  with the same condition, serialize to a handoff file, claim a
  handoff in a future session. Available both as `/goal` slash
  commands and TUI keymap commands.
- **New: steering notes** — short hints the user wants the agent
  to see on the next nudge ("next time try X"), injected into
  the continue-prompt and the compacting hook. Append-only,
  capped at 20 notes × 500 chars.
- **New: handoff file** — `.opencode/.goal-handoff.json` lets
  one session hand off a goal to a future session. The handoff
  is single-slot (one pending), validated, size-capped at 256KB,
  and the resume path re-sanitizes the content.
- **Hardening: prompt-injection guard** — `sanitizeForPrompt`
  drops C0/C1 control chars, Unicode format chars (zero-width,
  bidi overrides, line/para separators, BOM, invisible
  operators, interlinear annotations) at every prompt-injection
  site. Single source of truth used by the continue-prompt,
  the compacting hook, the sidebar's display surface, the
  editCondition primitive, and the appendSteering primitive.
- **Hardening: metadata allowlist** — `sanitizeMetadata`
  rebuilds the on-disk metadata from a fixed field set on
  restart and handoff claim. Attacker-planted keys cannot
  propagate into the active goal.
- **Hardening: validator array-length cap** — `evaluationHistory`
  capped at 10 entries. A 100,000-entry history in a hand-crafted
  handoff would OOM the plugin; capped to 10.
- **Documentation** — README updated to list the dials, enumerate
  the sidebar readouts, and describe the new modules. CHANGELOG
  has 9 detailed release-candidate entries documenting the
  per-slice work.

### Upgrade notes

- No migration required — v0.1.2 state files continue to load.
  The v0.2.0 metadata is wider (new optional fields); older
  state files without these fields still validate.
- The dials are opt-in. Existing v0.1.2 users who just set
  goals via `/goal set` don't have to change anything.
- Desktop users (Electron) see no change — the TUI plugins
  don't load on Desktop, same as v0.1.2. For the Desktop Goals
  tab, see `specs/desktop-ui-design.md` (separate upstream PR).

## 0.2.0-rc.7

**Hardening pass: adversarial gauntlet + prompt-injection fixes + release hygiene.**

The 5-lens sub-agent review gauntlet (maintainer / security / CI /
verify-everything / adversarial-tester, run in parallel) found real
issues. This release closes all the BLOCKERs.

### Security fixes

- **Prompt-injection guard on the auto-loop continue-prompt and the
  compacting hook.** `evaluation.reason` and the latest steering note
  are now routed through `sanitizeForPrompt()` before interpolation. A
  planted state file with a reason containing an embedded `GOAL_COMPLETE:`
  line on its own line used to trip the marker detector (the v0.1.0
  class of bug); it now cannot. Same for ANSI escape codes, U+200B
  zero-width spaces, U+2028 line separators, and bidi overrides.
- **Handoff read-size cap.** `readHandoff` refuses files larger than
  256KB (a hand-crafted 1GB handoff would otherwise OOM the JSON
  parser). The cap is conservative — the largest legitimate handoff
  is ~18KB.
- **Handoff claim re-sanitizes the state.** `claimHandoff` runs the
  resumed state's `condition` and each steering note through
  `sanitizeForPrompt` before persisting. A planted handoff with
  prompt-injection payloads no longer survives the claim.
- **Validator array-length cap.** `evaluationHistory` is now capped at
  10 entries in `validateGoalState` (matches `createHandoff`'s
  write-side slice). A 100,000-entry history in a hand-crafted
  handoff no longer propagates to the active goal.

### Release hygiene

- **Bumped version to 0.2.0-rc.7** (was stuck at 0.2.0-rc.1 since
  the v0.1.2 ship).
- **Added `src/tui-dials-logic.ts` to the `files` array.** The source-
  shipped `src/tui.tsx` imports from it; without this entry a consumer
  install of `opencode-autogoal/tui` would fail with `ERR_MODULE_NOT_FOUND`.

### Tests

- 19 new tests covering: U+200B / U+2028 / U+2029 sanitization in
  `sanitizeForSidebar`; `sanitizeForPrompt` behavior on C0/C1/Unicode
  format chars; the validator's `evaluationHistory.length` cap; the
  `readHandoff` size cap; `claimHandoff` re-sanitization.
- 7 new tests in `test/security.test.mjs` (added by the adversarial
  gauntlet's security lens) covering the specific BLOCKERs the
  gauntlet flagged.

**Total: 300/300 pass (281 prior + 19 new).**

## 0.2.0-rc.6

**Server-loop: steering notes injected into the continue-prompt.**

The auto-loop in `server.ts` now reads `metadata.steering` (the new
array of `{at, note}` objects that the dials and `/goal steer`
populate) and appends the most recent note to the continue-prompt
as a "User hint (most recent):" line. The hint is included on the
NEXT nudge only; subsequent nudges that fire without a new steer
note see no hint.

The compacting hook (which injects a goal summary into the session
context when OpenCode compacts the conversation) also picks up the
latest steering note as "Latest user hint: <note>" so a compacted
session knows what the user wanted.

This was the final feature slice of the v0.2.0 work. No new tests
(the change is a 2-line injection that exercised the existing
prompt-injection surface; the security gauntlet in rc.7 added
the tests that pin the sanitization contract).

## 0.2.0-rc.5

**`/goal` dispatcher: dial commands.**

Wires the goal-state dial primitives into the `/goal` slash-command
dispatcher so users can dial from the chat surface as well as the
TUI palette:

  /goal turns <n>            set maxTurns
  /goal time <n>             set maxTimeMinutes
  /goal tokens <n>           set maxTokens
  /goal condition "<text>"   edit condition (surrounding quotes stripped)
  /goal steer "<hint>"       append a steering note (quotes stripped)
  /goal unsteer              clear all steering notes
  /goal restart              clear + re-set with same condition
  /goal handoff [note]       serialize state to .goal-handoff.json
  /goal claim                resume a handoff

Error paths are mapped to friendly messages: no-goal -> "No active
goal.", terminal-state -> "Cannot edit a goal in a terminal state.",
no-handoff -> "No handoff to claim.", etc. The `dialResultToUser`
helper is the centralized relay for the turns/time/tokens/condition/
steer errors; restart/handoff/claim/unsteer have inline error mapping.

27 new tests in `test/command-dials.test.mjs` cover: each command's
happy path + every error reason + dispatcher-primitive consistency.

## 0.2.0-rc.4

**Sidebar: live readouts.**

The `sidebar_content` slot now shows:

  - tokens: <used>/<max>  (with thousands separators, e.g. 12,345/100,000)
  - last:  <reason>       (shared line 3 with tokens)
  - ctrl:  <N> steer notes   ⤴ handoff
                            (line 4, only when steering or handoff present)
  - ──── eval history ────  (separator, only if any evaluations)
  - recent 3 evaluations with tags:
        ✓ met, ! blocked, · in-progress
        most-recent-first
  - last edit: <relative time>  (just now, 3m ago, 2h ago, 5d ago)
                              (only if condition was edited)

The footer hint also updated to surface the new dials: /goal-turns,
/goal-time, /goal-tokens, /goal-condition. If a handoff is pending,
the footer appends /goal-claim.

13 new tests in `test/sidebar-logic.test.mjs` cover: tokens formatting,
steering count line, handoff indicator (alone, with steering, with
neither), eval history strip order + tag shape, relative time format
(just now / Nm ago / Nh ago / Nd ago), and the footer /goal-claim
appending on handoff. The `buildSidebarContent` signature is now
4-arg (state, progress, handoff, now); the JSX layer (sidebar.tsx) is
unchanged because `buildSidebarView` handles the handoff read
internally.

## 0.2.0-rc.3

**TUI: sidebar dial commands.**

Wires the 10 goal-state dial primitives (added in rc.2) into the
OpenCode TUI as 9 new command-palette commands. Each command opens
a `DialogPrompt`; on confirm the typed handler in `tui-dials-logic.ts`
runs, the result is toasted, and the dialog closes. Restart and
clear are preceded by a confirm dialog (clobber guards).

New commands (category "Goal: Dials"):

  /goal-turns            — set maxTurns
  /goal-time             — set maxTimeMinutes
  /goal-tokens           — set maxTokens
  /goal-condition        — edit condition (pre-fills the current text)
  /goal-steer            — append a steering note
  /goal-clear-steering   — drop all steering notes
  /goal-restart          — clear + re-set with same condition (confirm)
  /goal-handoff          — serialize state to .opencode/.goal-handoff.json
  /goal-claim            — resume a handoff

`src/tui-dials-logic.ts` is a new pure module (testable, no JSX, no
SDK) that hosts the submit handlers. The handlers do parse +
validate + call the goal-state primitive + return a result object
the JSX layer toasts.

53 new tests in `test/tui-dials-logic.test.mjs` covering:
`parsePositiveInt` strict regex, all 9 dial submit handlers (happy
path + invalid input + out-of-range + no-goal + terminal-state +
handoff-pending + handoff-exists + current-goal + no-handoff),
placeholder builders, and a "handler and primitive are in lockstep"
regression test that asserts the handler and the underlying
primitive accept/reject the same value range.

## 0.2.0-rc.2

**Goal-state primitives: 10 new live-edit functions.**

Adds 10 new pure primitives to `goal-state.ts` that the sidebar and
the `/goal` command dispatcher can use to mutate a live goal without
re-creating it:

  - `editMaxTurns(directory, n)`         — change maxTurns live (clamped)
  - `editMaxTime(directory, n)`          — change maxTimeMinutes live
  - `editMaxTokens(directory, n)`        — change maxTokens live
  - `editCondition(directory, text)`     — edit condition text mid-run
                                          (preserves id/status/evals;
                                           sanitizes control chars;
                                           sets conditionEditedAt)
  - `restartGoal(directory)`             — clear + re-set with same
                                          condition (new id, fresh
                                          counters); refused if a
                                          handoff is pending
  - `appendSteering(directory, note)`    — append a steering hint for
                                          the next auto-loop nudge
                                          (capped at MAX_STEERING_NOTES=20,
                                           length 500; sanitized)
  - `clearSteering(directory)`           — drop all steering notes
  - `createHandoff(directory, note?)`    — write state to
                                          .opencode/.goal-handoff.json
                                          (single-slot; refuses if
                                          handoff exists; caps
                                          evaluationHistory at 10)
  - `readHandoff(directory)`             — peek the handoff payload
                                          (validates; returns null on
                                          any parse/validation error)
  - `claimHandoff(directory)`            — resume a handoff into the
                                          active goal (refuses if a
                                          current active/paused goal
                                          exists; deletes the handoff
                                          file; sets resumedFromHandoffAt)

`GoalState.metadata` is widened to carry the new optional fields
(`conditionEditedAt`, `previousId`, `restartedAt`, `steering[]`,
`resumedFromHandoffAt`). The validator is loose on metadata (only
`setBy` is required), so existing state files continue to load.

63 new tests in `test/dials.test.mjs` covering: happy paths, all
guard clauses, hostile inputs (NaN, Infinity, out-of-range, non-
string, control chars, empty, identical, corrupt JSON, invalid
state in handoff), the handoff single-slot + clobber guard +
terminal-state allow, the steering FIFO cap at 20, the steering
length cap at 500, the handoff history cap at 10, the validator
forward-compat for the new metadata fields, and the `HANDOFF_FILE`
constant matches the runtime path.

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
