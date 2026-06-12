# Changelog

## 0.4.0

**Goal chains, richer verification, webhooks, and template variables.**

Four additive phases shipped on the v0.3.x baseline. Every new feature is
opt-in; existing 0.3.x state files, tools, and the 514 pre-existing tests
work unchanged. The chain/verification/webhook metadata fields are added
to the `sanitizeMetadata` allowlist; template variables are pure string
substitution that leaves literals intact when no value is bound.

The high-level surface added in this release:

- **Goal chains** — file-backed step sequencer (`.opencode/.goal-chain.json`)
  with auto-advance on achievement, explicit skip/reset, and loop-or-stop
  on completion. Per-step `maxTurns` / `maxMinutes` overrides.
- **`Verification` discriminated union** — `shell` / `http` / `file` /
  `marker` replace the single `command` string. The deprecated `command`
  field still works; `verification` wins when both are set.
- **Webhook notifications** — POST goal state changes to a configurable
  URL, fire-and-forget, localhost blocked by default with an explicit
  `--allow-local` opt-in.
- **Template variables** — `{name}` substitution in `condition` and
  `command`, `--var key=value` override, declared defaults applied when
  no override, and a `template import` / `template export` CLI surface
  with a stdin TTY guard and a 256KB import size cap.

**Total: 723/723 tests pass (514 prior + 209 new across 5 test files).
Typecheck clean.** Build clean. CI matrix green on ubuntu × windows ×
node 20 × node 22.

### Chains

A `.opencode/.goal-chain.json` file stores a sequence of `GoalChainStep`
objects; the active step is mirrored into the regular `.goal-state.json`
with `metadata.chainId` / `chainStep` / `chainTotal` linkage. The chain
auto-advances on achievement inside the same `withStateLock` boundary as
the achievement write — there is no window in which a goal can be
achieved without its successor being installed.

- **New file: `src/goal-chain.ts`** — `readGoalChain`, `writeGoalChainAtomic`
  (temp + rename, unique suffix per write to avoid same-ms collisions in
  tight loops), `createGoalChain`, `advanceGoalChain`, `skipGoalChainStep`,
  `resetGoalChain`. `validateGoalChain` runs before every write; size cap
  is 256KB to match the handoff convention.
- **Type additions** — `GoalChain` (version, id, steps, current,
  maxCycles, onComplete, metadata); `GoalChainStep` (condition, command,
  per-step maxTurns / maxMinutes); `GoalState.metadata.chainId`,
  `.chainStep`, `.chainTotal`.
- **Override guard** — `advanceGoalChain` returns an error if
  `state.metadata.chainId !== chain.id` (catches the case where a manual
  `set_goal` was called while a chain was active and never re-synced).
- **Loop mode** — `onComplete: "loop"` with `maxCycles` (default 10,
  `0` = unlimited). Loop counter advances after the last step's
  achievement, not on `createGoalChain`.
- **Server.ts integration** — `evaluate()` calls `advanceGoalChain` inside
  the same lock as the achievement write. The notification message reads
  `"Step N+1/N: <condition>"`.
- **Sidebar / GUI** — sidebar title shows `🎯 Step 2/4: <condition>`
  when `chainId` is set. The chain display shows ✅ / 🎯 / ⬜ glyphs,
  per-step turn count, and a progress bar.
- **CLI** — `chain start <json-file>`, `chain` (show), `chain skip`,
  `chain reset`. `chain start` rejects empty steps, empty conditions,
  and oversize files; uses the same `withStateLock` as a normal
  `set_goal`.

#### Upgrade notes (chains)

- **Yes — fully backward-compatible.** v0.3.x state files (no
  `chainId`) behave identically. The chain path is only entered when
  a chain file is created. The `set_goal` tool's new fields
  (`chainId`, etc.) are read-only in this release — only `chain start`
  writes them.

#### New tests (chains)

- **`test/goal-chain.test.mjs`** (565 lines, 30+ scenarios) — chain
  creation, step 0 activation with `chainId` linkage, auto-advance on
  achievement, last-step completion, loop mode, `maxCycles=0`
  unlimited, `maxCycles=N` cap, 1-step edge cases, skip without
  achievement, reset to step 0, override guard (manual `set_goal` mid-
  chain + chain reset recovers), `validateGoalChain` shape checks
  (missing steps, invalid current, empty condition), corrupt JSON
  returns null, oversize (>256KB) returns null, `chainId` /
  `chainStep` / `chainTotal` survive `restartGoal`, `claimHandoff`,
  and the `sanitizeMetadata` allowlist. CLI e2e: `chain start` +
  `chain` both exit 0 and write the expected state file.

### Verification

The single `command` field is replaced by a `Verification` discriminated
union on `GoalState`. The dispatcher in `evaluate()` (server.ts) routes
to `evaluateDeterministic` (shell), `evaluateHttp`, `evaluateFile`, or
`evaluateByTranscript` (marker) based on `verification.type`. The
deprecated `command` field is honored as a fallback; when both are set,
`verification` wins.

- **New types in `src/goal-state.ts`** — `Verification = { type: "shell",
  command } | { type: "http", url, expectStatus?, expectBody?,
  timeoutMs? } | { type: "file", path, exists?, contains? } | { type:
  "marker" }`. `GoalState.verification?` carries it; `GoalState.command`
  is preserved (deprecated).
- **`evaluateHttp`** — `global fetch` with `AbortSignal.timeout(5000)`
  by default, overridable via `verification.timeoutMs`. Returns
  `{ met: false, reason: "..." }` on timeout, connection refused, or
  non-matching status. `expectBody` is matched as a regex.
- **`evaluateFile`** — resolves `path` relative to the goal directory;
  blocks path traversal (relative must not start with `..` AND must
  not be absolute — the second clause is the Windows cross-drive fix).
  `exists: false` passes when the file is absent; `contains` is a
  regex match against `readFileSync` content; ENOENT on a
  `contains` check returns `{ met: false }` (does not throw).
- **`set_goal` tool** — new optional `verification` object argument.
  The CLI takes a `--verify shell:"npm test"` / `http:url` / `file:path`
  / `marker` shorthand.
- **`validateGoalState`** — accepts the four `verification.type` shapes
  with the required per-type fields; rejects unknown types and missing
  per-type fields.

#### Upgrade notes (verification)

- **Yes — fully backward-compatible.** v0.3.x state files with `command`
  continue to work; the dispatcher falls back to
  `evaluateDeterministic(state.command)` when `verification` is absent.
  Old `set_goal` invocations that pass `command` only store `command`
  (no `verification`), matching the v0.3.x on-disk shape.

#### New tests (verification)

- **`test/server-verify.test.mjs`** (864 lines, 43 scenarios,
  exceeds the 25 the spec requires) — shell pass/fail/timeout,
  HTTP 200/404/expectStatus-mismatch/timeout/connection-refused,
  file exists/absent/contains/no-match, file path-traversal blocked
  (including the Windows cross-drive case), marker detection,
  backward compat (legacy `command` field), `verification` wins
  when both are set, `validateGoalState` accepts valid shapes for
  all four types and rejects invalid shapes (wrong type, missing
  per-type fields). E2E: spinning up the plugin host with a mock
  OpenCode client, calling `set_goal` with each `verification` type,
  firing `session.idle`, and reading back the state file.

### Webhooks

POST goal state changes to a configurable URL. Fire-and-forget
(`fetch(...).catch(() => {})`) — a slow or down receiver cannot stall
the auto-loop. Localhost URLs (127.0.0.0/8, [::1], 0.0.0.0,
`localhost`) are blocked by default with an opt-in
`allowLocal: true`. The new `goal_webhook` tool and the
`webhook <url> --on ...` CLI surface set / show / clear the config.

- **New metadata field** — `GoalState.metadata.webhook: { url, on:
  GoalStatus[], allowLocal?: boolean }`. Added to the
  `sanitizeMetadata` allowlist with strict shape filtering (`on`
  values are filtered against `VALID_STATUSES`).
- **`fireWebhook`** — captures the previous status BEFORE chain
  advancement, so the payload reflects the transition that fired it
  (e.g. `status: "achieved"`, not `status: "active"` of the next
  step). 5-second timeout via `AbortSignal.timeout`. Failures are
  logged at `warn` and swallowed.
- **Call sites** — wired at all 8 spec call sites: `set` /
  `achieved` / `paused` / `resumed` / `cleared` / `timeout` /
  `restarted` / `blocked`. The webhook is only fired when the
  transition is in the `on` array.
- **SSRF guard** — `isLocalUrl` matches `localhost` (any port),
  `127.0.0.0/8`, `[::1]`, `0.0.0.0`. Does NOT block `10.x`,
  `172.16.x`, `192.168.x`, `169.254.x` (CI uses private IPs).
  Documented in `SECURITY.md`.
- **Payload** — `{ goalId, chainId | null, condition, status,
  previousStatus, turnsEvaluated, lastReason, timestamp }`. `lastReason`
  is run through `sanitizeForPrompt` before serialization to close the
  prompt-injection leak.
- **Preservation** — `sanitizeMetadata` keeps the webhook config across
  `restartGoal` and `claimHandoff` (the "configure once" contract).

#### Upgrade notes (webhooks)

- **Yes — fully backward-compatible.** State files without `webhook`
  behave exactly as in v0.3.x — no HTTP traffic, no `fireWebhook` call.
  v0.3.x `set_goal` invocations that don't pass `webhook` store no
  webhook config, matching the v0.3.x on-disk shape.

#### New tests (webhooks)

- **`test/server-webhook.test.mjs`** (1082 lines, 53 scenarios,
  exceeds the 15 the spec requires) — fires on configured statuses,
  does NOT fire when the transition is absent from `on`, fails
  silently on bad URL (loop continues, no crash), localhost blocked
  by default, localhost allowed with `allowLocal`, `sanitizeMetadata`
  preserves the webhook config across `restartGoal`, `claimHandoff`
  preserves it, `chainId` present in payload when goal is part of a
  chain, `chainId` null when goal is standalone, multiple statuses
  fire on each, no webhook set means no POST and no crash, invalid
  URL rejected by `set_goal`, `validateGoalState` rejects invalid
  webhook shape and accepts valid shape. E2E: HTTP test server,
  full plugin host, `set_goal` → `session.idle` → POST received
  with the expected payload.

### Templates

`{name}` substitution in template `condition` and `command`. Variables
can be passed at use-time via `--var key=value`, declared in the
template with an optional `default` (applied when no `--var` is given),
or left unresolved — in which case `{name}` stays as a literal in the
output (so a human reading the goal sees what's missing).

- **Type update in `src/templates.ts`** — `GoalTemplate.variables?:
  Record<string, { description: string; default?: string }>`.
  Existing templates without `variables` are unchanged.
- **`resolveTemplateVars(text, vars)`** — single-pass regex replace;
  unresolved keys are kept as `{key}` literal (no infinite loops, no
  cascade into substituted values).
- **`validateTemplate`** — enforces that every declared variable is
  referenced in `condition` or `command` (catches "I declared `branch`
  but never used it" silently-misconfigured templates), AND that no
  unreferenced variable appears in the rendered condition (catches the
  "I wrote `{brnach}` with a typo" class of bug). Runs the full
  validation in `discoverTemplates`, not just the description check.
- **Default application** — at `template use` time, the dispatcher
  merges declared defaults into the resolver map, then applies
  `--var` overrides on top. Precedence: `--var` > `default` > literal.
- **CLI** — `template list`, `template use <name> --var k=v`,
  `template export <name>`, `template import <path>`, `template
  import -` (stdin). Stdin import has a TTY guard that returns the
  spec-mandated message instead of blocking. Import is size-capped
  at 256KB and size-checked BEFORE `JSON.parse` (CPU DoS guard).
- **Import security** — name validated with `/^[A-Za-z0-9_-]+$/`
  (rejects `..`, `/`, `\`, reserved names), shape validated before
  write, atomic write (temp + rename, unique suffix).

#### Upgrade notes (templates)

- **Yes — fully backward-compatible.** v0.3.x built-in templates
  (`fix-lint`, `fix-types`, `pass-tests`) have no `variables` and
  resolve as before. User templates added by `template import` in
  v0.3.x remain valid. `template use` with no `--var` on a
  v0.3.x-vintage template (no `variables`) behaves identically to
  v0.3.x.

#### New tests (templates)

- **`test/template.test.mjs`** (870 lines, 53 tests across 9 describe
  blocks) — simple variable substitution, multiple variables, missing
  variable kept as `{var}` literal, old template without `variables`
  works unchanged, template list includes builtins + user templates,
  template export round-trip, template import valid / invalid JSON /
  bad name / oversized, stdin import when TTY (returns spec
  message, does not read) / when piped (succeeds), `template use`
  with `--var` (resolves condition + command), `template use` with
  default (default applied), `template use` with missing `--var`
  (literal kept), full export → import → use round-trip,
  `validateTemplate` detects unused declared variables and undefined
  variables in condition.

### End-to-end integration

A single e2e test file exercises the four phases as they interact in
realistic flows, catching the asymmetric gaps the per-phase thickeners
miss (e.g. "the chain primitive doesn't propagate the step's
`verification`" — a real defect the chain-thickener's own tests
couldn't see because the test scenarios only set chains without
verification).

- **`test/v040-e2e.test.mjs`** (541 lines, 5 it() blocks across 4
  describe groups) — chain step with verification auto-advances
  with the correct verification object on the next step; chain
  with a webhook that fires on each step's achievement; template
  use with `--var` populating a chain step's `condition` and
  `command`; file verification that gates a chain step's
  completion; full goal → chain → webhook flow under a single
  `withStateLock` boundary.

#### New tests (e2e)

- **`test/v040-e2e.test.mjs`** — see above.

### Cross-cutting notes

- **All new writes through `withStateLock`** — chain file shares
  `.goal-state.lock` with the state file; the achievement-then-advance
  sequence holds the same lock for both writes.
- **All new atomic writes** — `writeGoalChainAtomic`,
  `writeGoalStateAtomic`, and the import-side temp+rename all use
  unique random suffixes (not just `pid + Date.now()`) to avoid
  same-ms collisions in tight loops.
- **No new dependencies** — HTTP uses global `fetch` (Node 18+);
  webhooks use the same `fetch`. Template variable substitution is
  pure string regex. The chain type is a JSON file in `.opencode/`.
- **Backward compatibility** — 514 prior tests pass unmodified. The
  15 existing tools work identically. The `command` field is
  preserved (deprecated, not removed). Old CLI flags still work.

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
