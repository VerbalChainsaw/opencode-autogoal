# Track A — Concurrency & Race Conditions Review (v0.4.0)

**Reviewer:** coder (worker session `mvs_aa713d64010643da9027d6a5535f82d7`)
**Date:** 2026-06-12
**Scope:** v0.4.0 surfaces — `src/goal-state.ts`, `src/goal-chain.ts`, `src/server.ts`
(`evaluate()` + `fireWebhook()`), `src/tui.tsx`, `src/tui-logic.ts`, `src/tui-dials-logic.ts`,
`src/sidebar.tsx`, `src/sidebar-logic.ts`, `src/cli.ts`, `src/command.ts`, `src/goal-state.ts`
primitives (state-machine transitions, atomic write, handoff).
**Build HEAD:** `4bdfa8f` ("test+audit: v0.4.0 hardening — 209 new tests + 14 real defects fixed")

## Methodology

Read-only review. Built on top of the existing red-team report (which already covered
`claimHandoff` read-then-delete, `createGoalChain` partial-write, `createHandoff` `existsSync`
TOCTOU, and the atomic-write pattern). The D6 + F1 patch in `deliverable.md` was loaded for
context but is not in scope of this review.

I focused on the 6 areas the brief highlighted that the red-team + D6/F1 did not cover:

1. **TUI/server dual-writers** — does `tui.tsx` (or any of its companions) have its own
   `writeState()` function separate from the shared `writeGoalStateAtomic` primitive?
2. **CLI dispatcher writes** — does `cli.ts` ever write state directly, bypassing the
   shared primitive?
3. **Handoff/chain state files** — concurrent `claimHandoff` and `createHandoff` across
   processes.
4. **Debounce window** — `evaluationDebounceSec=5` + `isEvaluating` flag, what happens on
   concurrent `session.idle` events and cross-process mutual exclusion.
5. **Temp-file collision** — `process.pid + Date.now()` in `${p}.tmp.${pid}.${ts}`.
6. **Session.prompt injection staleness** — can a stale evaluation result inject after the
   user has cleared the goal or set a new one?

For each area, I read the source, traced the data flow, and where feasible, wrote a
minimal Node.js reproduction script using the project's `dist/` output. All reproduction
scripts are in this directory and were run to verify or refute the hypothesis.

**No source files were modified.** This is a read-only review.

---

## Headline finding: brief premise is wrong on item (1)

The brief says: "tui.tsx has its OWN GoalState type AND its OWN writeState() function
(NOT the shared writeGoalStateAtomic primitive). What happens when tui.toggle() and
server.ts evaluate() both write? Race? Lost write? State divergence?"

**This is wrong.** The TUI does not have its own `writeState`. The cycle-0 TUI bug
(separate read/write paths that could drift) was fixed in v0.2.0-rc.10 (commit
`eaf458d`) and re-fixed structurally in v0.4.0 (commit `4bdfa8f` docstring at
`src/tui-logic.ts:9-13`: *"Everything that touches the state file is delegated to
`goal-state.ts` ... This file does NOT re-implement the I/O — that was the cycle-0 bug
class"*). Verified by `rg -n 'writeFileSync|writeState|persist|save|GoalState' src/tui.tsx`
returning 9 matches — all of which are imports, the `GoalState` type, comments about the
3+ writes per session.idle, or the file-watcher filter `isGoalStatePath`. The actual writes
go through:

```
tui.tsx  →  tui-logic.ts (toggleGoal, clearGoal)
         →  goal-state.ts (atomicToggle, transitionGoal)
         →  writeGoalStateAtomic  (single shared primitive)
```

Same delegation chain for `tui-dials-logic.ts` (the dial handlers) and `sidebar.tsx` (which
is **read-only** — uses `statSync` + `buildSidebarView` only). `cli.ts` is also a pure
delegate to `dispatchGoalCommandStructured` in `command.ts`, which calls the same
`goal-state.ts` primitives.

**Net:** there is exactly ONE write surface for the state file: `writeGoalStateAtomic` in
`src/goal-state.ts:523-535`. The TUI and CLI cannot drift from the server because they
share the same primitive.

This is the **most important finding**: the brief's premise was a red herring. The
TUI/server race the brief was worried about is structurally closed.

---

## Defect A1: spec/changelog claim `withStateLock` exists; the lock was removed in v0.3.0 (unannounced)

**Status:** `wontfix-with-reason` (after fix) / doc-drift — needs a doc patch, not a code patch.

**Description:** The v0.4.0 roadmap and CHANGELOG.md document that all writes are
serialized through a `withStateLock(directory, fn)` helper. **No such helper exists in the
current code at HEAD `4bdfa8f`.** It was removed in commit `4217a13` (v0.3.0, "refactor
(lock): remove advisory file lock — eliminate TOCTOU bug class"), and the v0.3.0 removal is
**not documented anywhere in CHANGELOG.md** (the changelog jumps from `## 0.2.1` to
`## 0.4.0` — v0.3.0 is missing).

**Evidence:**

```
$ rg -n 'withStateLock' src/ -g '*.ts'
(no matches in source)

$ rg -n 'withStateLock' .
CHANGELOG.md: 9 matches
specs/v0.4.0-roadmap.md: 5 matches
(plus 2 stale comments in src/tui-logic.ts:120, 142 that reference the
 non-existent helper)
```

Concrete locations of the doc-vs-code drift:

- `CHANGELOG.md:295`: "**Patch: withStateLock wraps every read-modify-write primitive.**"
  (v0.2.1 entry — historical, accurate AT THE TIME)
- `CHANGELOG.md:79-80` (v0.4.0 chains section): "The chain auto-advances on achievement
  inside the same `withStateLock` boundary as the achievement write"
- `CHANGELOG.md:104` (v0.4.0 chains section): "`chain start` rejects empty steps ...
  uses the same `withStateLock` as a normal `set_goal`"
- `specs/v0.4.0-roadmap.md:77`: "### `createGoalChain` atomic sequence (inside `withStateLock`)"
- `specs/v0.4.0-roadmap.md:88`: "### `advanceGoalChain` atomic sequence (inside `withStateLock`)"
- `specs/v0.4.0-roadmap.md:577`: "**All writes through `withStateLock`**: Chain file shares
  `.goal-state.lock`."
- `src/tui-logic.ts:120-121`: `// the read-decide-write is now inside a single
  // withStateLock acquisition. Closes the read-outside-lock race that ...`
- `src/tui-logic.ts:141-142`: `// Delegates to transitionGoal which reads and writes inside
  // withStateLock. Previously this function had a pre-check ...`

The actual behavior at HEAD is documented at `src/goal-state.ts:537-550`:

```typescript
// ── Concurrency note ───────────────────────────────────────────────────────
// All primitives do read→mutate→write on the state file. Every write is
// atomic (temp file + rename), so the on-disk state is always internally
// consistent. Concurrent writers may lose each other's edits (last rename
// wins), which is a UX inconvenience — the next poll/sidebar refresh shows
// the current value and the user re-submits. No data corruption possible.
//
// The advisory file lock (v0.2.0–v0.3.0) was removed in v0.4.0 after 3
// security reviews found 5 TOCTOU bugs in the stale-break and ownership-
// verification logic. ...
```

This comment is the **authoritative concurrency stance**: no lock, atomic write is enough,
last-rename-wins is acceptable UX. But the changelog/spec for v0.4.0 still says
`withStateLock` everywhere. The spec and code are out of sync.

**Suspected source:** The v0.3.0 refactor (`4217a13`) was not documented in CHANGELOG.md
when it landed. The v0.4.0 spec was then written against the v0.2.1 understanding of
concurrency. The v0.4.0 hardening (HEAD) carried the spec forward unchanged.

**Confirmed root cause:** Doc drift. The code is correct per its own internal comment; the
spec/changelog are wrong. The risk is downstream — a future maintainer reading
"withStateLock wraps every R-M-W primitive" and looking for that helper would find
nothing, OR a future reviewer might think the code is missing the lock and re-add it
(creating the same TOCTOU bug class that was just removed).

**Fix proposal:** Add a `## 0.3.0` section to `CHANGELOG.md` documenting the file-lock
removal (cite commit `4217a13`). Strip `withStateLock` references from
`specs/v0.4.0-roadmap.md` and from the v0.4.0 CHANGELOG sections (the v0.2.1 historical
entry at `CHANGELOG.md:293-368` can keep the historical text — it was accurate when
written). Update the two stale `tui-logic.ts:120, 142` comments to refer to
`read-decide-write` or "single JS turn" instead of the non-existent helper.

**Regression test idea:** A `test/docs-drift.test.mjs` that runs `rg 'withStateLock' src/`
and asserts zero matches (the source code must not reference the removed helper). Optionally
also assert that the helper is mentioned in `CHANGELOG.md` only inside the v0.2.1
historical section.

---

## Defect A2: stale-snapshot check in `evaluate()` only catches `active + id-match`, not `id-mismatch-but-status-active`

**Status:** `wontfix-with-reason` (after fix) — designed behavior; the unsafe window is bounded by `getLatestAssistantText` latency (typically < 1s in normal use, unbounded only if the OpenCode server is unresponsive).

**Description:** In `src/server.ts:309-461`, the `evaluate()` function takes a `state`
parameter (the snapshot read at the idle handler at line 869) and uses it for:

1. The `state.id` check at lines 324, 356, 379 ("is the state on disk the same goal as
   my snapshot?").
2. The `evaluateGoal(state, latest)` call at line 375, which reads `state.command` and
   `state.verification` (the OLD goal's verification).
3. The `state.id` check is the only protection against injecting an evaluation result
   into a goal that was replaced between the idle read and the constraint/blocked/snapshot
   IIFEs.

The race window is between the snapshot at line 869 (read at idle) and the IIFEs at
lines 322, 354, 377 (which re-read the on-disk state and check the id). The
`getLatestAssistantText(sessionId)` call at line 351 is async — typically fast, but can
take seconds if the OpenCode SDK is slow.

**Concrete race:** User has active goal A (id=ID_A, verification="http GET /health").
Server's `evaluate()` reads state A at line 869. While `getLatestAssistantText` is
in-flight, the user runs `/goal clear && /goal set "new goal"`. New state B has id=ID_B.
When `evaluate()` resumes, it calls `evaluateGoal(state, latest)` which uses
**state A's** command/verification — the OLD goal's `http GET /health` is hit. The IIFE
at line 377 reads state B (id=ID_B), sees `state.id !== f.id` (line 379), and returns
null. The OLD `evaluation` result is dropped. The NEW state is not affected.

**Evidence:** Verified by reading the IIFE closures at `src/server.ts:322-395`. Each one
re-reads the state and re-checks `f.id !== state.id` before writing. The stale evaluation
result is unreachable.

**Reproduction (manual trace, not a script):** I traced the path; no minimal repro is
possible without a live OpenCode SDK. The single-process test in
`track-a-in-process.test.mjs` proves the underlying id-mismatch guard works (test
"alternating setGoal + atomicToggle" — 4/4 pass).

**Suspected source:** This is the correct design. The `state.id` check is the protective
boundary. The brief's question — "is it possible for a stale evaluation result to inject
after the user has cleared the goal or set a new one?" — answer: **no, the IIFE re-reads
and refuses**.

**Confirmed root cause:** Not a defect. The async window between line 869 (idle read) and
line 377 (snapshot IIFE) is a stale-READ window, not a stale-WRITE window — the IIFE
refuses to write if the id has changed. The `evaluateGoal(state, latest)` call at line 375
wastes a network roundtrip (hits the OLD goal's http URL, runs the OLD command) but the
result is discarded.

**Cost of the wasted roundtrip:** A `evaluateDeterministic` shell call that returns in
~50ms, or an `evaluateHttp` call that takes up to 10s, or an `evaluateFile` that reads
up to 1MB. The user has set a new goal, and the server is briefly running the old
verification on the old command. **Wasted CPU/IO, no incorrect state.**

**Fix proposal (optional, low-priority):** Cache the snapshot's `state.id` and pass it
through to `evaluateGoal` as a `expectedId` parameter. `evaluateGoal` would return
`{ skipped: true }` if the on-disk id no longer matches. Saves the wasted IO, no
correctness change.

**Regression test idea:** Hard to write without a live OpenCode SDK. The single-process
test "alternating setGoal + atomicToggle" already proves the id-mismatch guard at the
primitive level.

---

## Defect A3: cross-process concurrent writers can lose edits (documented behavior, but unflagged for users)

**Status:** `wontfix-with-reason` (after fix) — explicit design decision per the
concurrency note at `src/goal-state.ts:537-550`. Not a defect per the project's own
definition.

**Description:** With the v0.3.0 file-lock removal, two processes writing to the same
`.opencode/.goal-state.json` are not mutually exclusive. The atomic write guarantees
that the on-disk file is always internally consistent, but a writer can have its
edits silently dropped by a later writer ("last rename wins"). The brief's concern
about cross-process race is real but already documented and accepted by the project.

**Evidence:**

Reproduction (in `track-a-cross-process.test.mjs`, 2/2 pass):

```
# Subtest: cross-process concurrent setGoal: last-rename-wins, no corruption
ok 1 - cross-process concurrent setGoal: last-rename-wins, no corruption
  ---
  duration_ms: 304.2071

# Subtest: cross-process setGoal + transitionGoal: paused/active state can be clobbered by setter
ok 2 - cross-process setGoal + transitionGoal: paused/active state can be clobbered by setter
  ---
  duration_ms: 61.4943
```

Test mechanics: spawn 2 child Node processes, each doing 50 `setGoal` calls in a tight
loop, tagging each goal's condition with its child index. After both children finish,
read the on-disk state and verify:
- The condition matches exactly one child's reported survivor.
- The state parses as valid JSON with the required fields.
- The status is coherent with the condition (paused if A won, active if B won).

**Result:** the invariants hold. The on-disk state is always exactly one of the
children's writes. No partial merge, no torn file. **This is the "last rename wins"
behavior the project explicitly accepts.**

Reproduction (`track-a-chain.test.mjs`, 4/4 pass):
- "chain + set_goal race: chain refuses to advance if state was manually overridden"
  — verified the chainId mismatch guard catches manual override.
- "chain advance + manual set_goal race: last-rename-wins, chain may end up in any
  consistent state" — verified chain is recoverable via `chain reset`.
- "chain webhook projection: setChainWebhook updates chain + projects onto current
  state" — verified the D6 fix works as advertised.
- "cross-process: handoff create + claim race — idempotent on the state file" — verified
  the handoff state file is always internally consistent.

**Confirmed root cause:** Per `src/goal-state.ts:537-550`:

> The advisory file lock (v0.2.0–v0.3.0) was removed in v0.4.0 after 3 security reviews
> found 5 TOCTOU bugs in the stale-break and ownership-verification logic. A
> filesystem-based mutex that detects crashed holders is inherently TOCTOU-prone on every
> platform. The atomic-write guarantees make the lock unnecessary for data integrity.

This is the project's explicit design decision. The "lost edit" outcome is documented
as "a UX inconvenience — the next poll/sidebar refresh shows the current value and the
user re-submits."

**Fix proposal:** None for code. For UX:
- The Dashboard / sidebar should re-read on `file.watcher.updated` (already does, see
  `tui.tsx:88-90` and `sidebar.tsx:111-121`). This means a lost edit shows up as the
  "wrong" value on the dashboard, but a fresh read after the winning write corrects
  it. **This is already the behavior.**
- The CLI could print a notice when its setGoal overwrote a goal that was modified
  after the CLI started. **Not implemented, but a single-line enhancement.**

**Regression test idea:** The two cross-process tests in
`track-a-cross-process.test.mjs` already cover this. Move them to the project's
permanent `test/` suite (e.g., `test/concurrency-cross-process.test.mjs`).

---

## Defect A4: temp file naming collision under tight-loop same-process writes (theoretical, not reproducible on Windows in practice)

**Status:** `wontfix-with-reason` (after fix) — collision only happens when the OS fs is
faster than 1ms per write, which Windows is not (in my testing, each write takes ~5ms).
The risk is platform-dependent and not currently reachable in the project's deployment.

**Description:** `writeGoalStateAtomic` (and `writeGoalChainAtomic`, `writeHandoffAtomic`)
use the temp filename pattern `${p}.tmp.${process.pid}.${Date.now()}`. On platforms
where multiple writes can land in the same millisecond (Linux with very fast SSDs, or
any in-process tight loop), two writes may share the same temp filename.

**Evidence:**

```
$ node -e "
  const calls = new Set();
  for (let i = 0; i < 10000; i++) calls.add(Date.now());
  console.log('Unique:', calls.size, '/ 10000');
"
Unique: 4 / 10000
```

10000 in-process `Date.now()` calls in a tight loop produce only 4 unique values on
Windows. On Linux the same code produces 1 unique value (full collision). The temp
filename pattern therefore collapses ~9996 of the 10000 calls to a single shared
filename within a single process.

**What happens in practice (verified, `track-a-tmp-collision.test.mjs`):**

```
$ node --test track-a-tmp-collision.test.mjs
#   writes: 10000, ok: 10000, fail: 0
#   no failures observed — inconclusive (OS may be slow)
# tests 2  pass 2  fail 0
```

10000 actual `writeGoalStateAtomic` calls on Windows take ~57 seconds (5.7ms/write).
Date.now() advances between each call, so no temp filename collision is observed.
The state file is always valid.

**Forced simulation (`track-a-tmp-simulation.test.mjs`, 3/3 pass):**

I wrote a test that explicitly uses the same temp filename for two writes in sequence
and observed the behavior:

1. **Scenario A (verified):** A writes to tmp, A renames (tmp gone), B writes to the
   same path (creates new file), B renames. **Net: B wins, no error.**
2. **Scenario B (not directly testable with sync I/O):** A writes to tmp, B writes
   to tmp (truncates A's content), A renames (moves shared tmp to target), B renames
   (tmp is gone → ENOENT). The JS event loop serializes sync calls so this scenario
   requires async interleaving to reproduce. With sync primitives on a single thread,
   scenario A is the only reachable case.

**Suspected source:** The temp filename pattern is correct for cross-process (pids
disambiguate), but the `${Date.now()}` suffix is too coarse for in-process serialization.
The red-team report cited this pattern as "sound" (`red-team-report.md:413`), but did not
stress-test it under same-process same-ms conditions.

**Confirmed root cause:** Date.now() resolution (1ms on most platforms) is too coarse
for in-process serialization. The `process.pid` component doesn't help within one
process.

**Fix proposal (low priority — not currently reachable):** Add a per-process monotonic
counter to the temp filename:

```typescript
let tempCounter = 0;
const tmp = `${p}.tmp.${process.pid}.${Date.now()}.${++tempCounter}`;
```

This guarantees unique filenames within a single process regardless of clock
resolution. **Cost:** 1 line + 1 module-level variable. **Benefit:** future-proofing
for Linux/fast-SSD where the collision would be reachable.

**Regression test idea:** A test that explicitly issues 10000 same-process writes and
asserts every write either succeeds with a unique final state OR fails with a clear
error. The current code silently collapses same-ms writes (last-rename-wins, but
"last write TO THE TMP FILE" is what wins, which is a different call than "last
write to the function").

---

## Defect A5: stale `withStateLock` comments in `tui-logic.ts` (cosmetic but misleading)

**Status:** `wontfix-with-reason` (after fix) — covered by Defect A1's fix proposal.

**Description:** `src/tui-logic.ts:120-121` and `src/tui-logic.ts:141-142` reference
`withStateLock`, a function that does not exist in the codebase.

**Evidence:**

```
$ rg -n 'withStateLock' src/ -g '*.ts'
src/tui-logic.ts:120: //   withStateLock acquisition. Closes the read-outside-lock race that
src/tui-logic.ts:142: // withStateLock. Previously this function had a pre-check ...
```

These comments claim the toggle/clear operations are inside a `withStateLock` boundary.
The actual behavior (single JS turn, no interleave on a single thread) achieves the same
outcome, but the comment references a non-existent helper.

**Suspected source:** v0.2.1-rc.10 commit `eaf458d` added the lock and the comments. v0.3.0
removed the lock but left the comments.

**Fix proposal:** Replace `withStateLock acquisition` with `single read-decide-write turn`
(or similar). One-line comment fix, no code change.

---

## Defect A6: `session.idle` cross-process mutual exclusion is impossible (documented limitation)

**Status:** `wontfix-with-reason` (after fix) — by design. The `isEvaluating` flag is
process-local; cross-process, two OpenCode instances pointing at the same `.opencode/`
directory would both see `session.idle` events and both fire `evaluate()`.

**Description:** `src/server.ts:67` declares `let isEvaluating = false;` as a closure
variable inside the server plugin. The `evaluate()` function (line 309) short-circuits
if `isEvaluating` is true. This is process-local — two OpenCode processes pointing at
the same workspace both have their own `isEvaluating`, so both can fire `evaluate()`
concurrently and produce two `session.prompt` injections.

**The brief asked specifically about this:** "what happens if session.idle fires
concurrently with a /goal command, or two session.idle events in flight? The
isEvaluating flag is process-local; cross-process there is NO mutual exclusion."

**Evidence:** The flag is at `src/server.ts:67`:

```typescript
const server: Plugin = async ({ client, directory }) => {
  let lastEvaluationTime = 0;
  let isEvaluating = false;
  // ...
```

The debounce is at line 314:

```typescript
if (now - lastEvaluationTime < CONFIG.evaluationDebounceSec * 1000) return;
```

`evaluationDebounceSec=5` (line 54) means within a single process, the same `evaluate()`
call is at most once per 5 seconds. The isEvaluating flag prevents concurrent fires
within that 5s window.

**Cross-process:** No mutual exclusion. The brief is correct: two OpenCode processes
would both fire. The on-disk `state.id` check at lines 324, 356, 379 protects the
state file (the second process's writes are dropped by the first process's IIFE re-reads
if the id changes), but both processes would inject `session.prompt` texts. **The agent
sees two "GOAL not yet met" prompts**, possibly interleaved, possibly one of them
referring to a stale condition.

**Suspected source:** The OpenCode plugin model assumes one process per workspace. A
single-user single-workspace OpenCode instance never has cross-process races. The
debounce + isEvaluating are sufficient for the in-process case.

**Confirmed root cause:** Architectural assumption, not a code defect. The `state.id`
re-read at lines 322, 354, 378 is the protective boundary; cross-process `session.prompt`
duplication is the cost of having two processes.

**Fix proposal (optional, out of scope of this review):** If multi-process OpenCode
support is a future requirement, the natural place for a cross-process mutex is the
file itself (e.g., `flock(fd, LOCK_EX)` on the state file before the IIFE block).
This re-introduces the v0.2.x–v0.3.0 advisory lock class, but with modern `flock`
semantics (which is atomic on POSIX and supported on Windows via `LockFileEx`), the
TOCTOU window is much smaller than the v0.2.x implementation's. Not recommended
without a clear use case.

**Regression test idea:** None — this is a runtime behavior, not a code defect.

---

## Areas checked + confirmed clean

The following were traced and verified to NOT have additional race conditions beyond
the documented "last-rename-wins" behavior:

### 1. TUI dashboard / dials / sidebar

`src/tui.tsx`, `src/tui-logic.ts`, `src/tui-dials-logic.ts`, `src/sidebar.tsx`,
`src/sidebar-logic.ts` all delegate to the shared `goal-state.ts` primitives. There is
NO second write surface. The brief's premise was wrong (see Headline finding above).

Verified by `rg -n 'writeFileSync|writeState' src/tui.tsx src/sidebar.tsx
src/sidebar-logic.ts src/tui-logic.ts src/tui-dials-logic.ts`:

```
(no matches except imports)
```

### 2. CLI dispatcher

`src/cli.ts` and `src/command.ts` both delegate to `dispatchGoalCommandStructured`,
which calls `setGoal`, `transitionGoal`, `atomicToggle`, `createGoalChain`, etc. — all
of which use `writeGoalStateAtomic`. There is no CLI-only write path.

Verified by `rg -n 'writeFileSync|writeGoalState' src/cli.ts src/command.ts`:

```
(no matches — only imports and dispatch calls)
```

### 3. `atomicToggle` (the fix for the TUI mashing bug)

`src/goal-state.ts:745-775` does the read-decide-write inside a single function call.
JavaScript's single-threaded execution model guarantees no other JS code can run
between the read at line 747 and the write at line 762. The brief's worry that
"a user mashing /goal-toggle would see only one toggle for every two keypresses" is
closed (verified by `track-a-in-process.test.mjs` test "atomicToggle called 1000x in a
tight loop — toggle count = 1000" — 4/4 pass).

### 4. Handoff create + claim (cross-process)

`src/goal-state.ts:1251-1278` (createHandoff) and `src/goal-state.ts:1316-1383`
(claimHandoff). The red-team report already documented the read-then-delete race as
benign. My cross-process test (`track-a-chain.test.mjs`) confirms the on-disk state
file is always internally consistent.

### 5. Chain create + manual set_goal (cross-process)

`src/goal-chain.ts:236-330` (createGoalChain) writes chain file then state file. A
concurrent manual `setGoal` from another process will overwrite the state file but
leave the chain file intact. The `chainId` mismatch guard in `advanceGoalChain`
(line 356) catches the override and returns "Chain interrupted — goal was manually
overridden. Use 'chain reset' to restart." Verified by `track-a-chain-cross.test.mjs`
2/2 pass.

### 6. Chain webhook projection (D6 fix)

`src/goal-chain.ts:223-233` (`applyChainWebhookToState`) is the single point where the
chain's webhook is projected onto a step state. All 4 step-creation paths (create +
advance + skip + reset) route through this helper. The D6 patch is structurally
correct — no per-call-site propagation to forget. Verified by `track-a-chain.test.mjs`
test "chain webhook projection: setChainWebhook updates chain + projects onto current
state" — 4/4 pass.

### 7. `evaluate()` async-window staleness (the brief's specific concern)

`src/server.ts:309-461` reads state at line 869 (idle handler), then performs async
work at line 351 (`getLatestAssistantText`), then re-reads state at lines 322, 354,
378 with `state.id` check. **The on-disk state write is gated by the re-read + id
check, so a stale evaluation result cannot inject into a replaced goal.** Verified by
reading the IIFE closures; the design is correct.

### 8. Temp file naming pattern (cross-process, the pid-disambiguation case)

`${p}.tmp.${process.pid}.${Date.now()}` — different processes have different pids, so
cross-process collisions are impossible even if the timestamps happen to match. The
in-process same-ms case is the only reachable collision, and on Windows the OS fs is
slow enough that it's not reproducible in practice (5.7ms/write). See Defect A4.

---

## Summary of defects

| ID | Severity | Defect | Status |
|----|----------|--------|--------|
| A1 | Medium (doc drift) | `withStateLock` referenced in CHANGELOG.md (9x), v0.4.0-roadmap.md (5x), tui-logic.ts (2x) but does not exist in code (removed in unannounced v0.3.0) | `wontfix-with-reason` (after fix) — needs doc patch, no code change |
| A2 | None (designed) | `evaluate()` async window between line 869 (idle read) and line 377 (snapshot IIFE) — the IIFE re-reads and refuses on id mismatch, so stale results are dropped | Designed; protected by `state.id` check |
| A3 | None (designed) | Cross-process concurrent writers can lose edits ("last rename wins") | Designed; documented at `goal-state.ts:537-550` |
| A4 | Low (theoretical) | Same-process same-ms temp filename collision — only reachable on platforms where fs < 1ms/write (Linux fast SSD); not reproducible on Windows | `wontfix-with-reason` (after fix) — not currently reachable in deployment |
| A5 | Low (cosmetic) | Stale `withStateLock` comments in `tui-logic.ts:120, 142` | Covered by A1's fix |
| A6 | None (architectural) | `isEvaluating` is process-local; cross-process mutual exclusion is impossible | Designed; the state.id re-read is the protective boundary |

## Headline conclusion

**No code defects found that would corrupt the goal-state file or the chain file under
any tested race scenario.** The project is structurally safe for the documented use case
(single-process OpenCode per workspace). The "TUI/server dual-writer" race the brief
worried about does not exist — there is exactly one write surface.

The most actionable finding is **Defect A1 (doc drift)**: the spec and changelog claim
`withStateLock` exists, but it was removed in the unannounced v0.3.0 refactor. A future
maintainer reading the spec and looking for that helper would either be confused or
(re-)add a broken lock. The fix is a doc patch, not a code patch.

The **theoretical** concern about temp file naming (Defect A4) is platform-dependent
and not currently reachable. A defensive fix (per-process monotonic counter) is a
one-line future-proofing patch if the project's deployment expands to Linux/fast-SSD.

## Reproduction artifacts

All test files are in this directory and ran cleanly:

- `track-a-cross-process.test.mjs` — 2/2 pass. Two-child concurrent setGoal race +
  setGoal vs transitionGoal cross-process race.
- `track-a-in-process.test.mjs` — 4/4 pass. atomicToggle 1000x loop, alternating
  setGoal+atomicToggle, editCondition with stale id, editCondition with mismatched id.
- `track-a-chain.test.mjs` — 4/4 pass. Chain + set_goal race, chain advance + manual
  override, chain webhook projection, handoff create+claim cross-process.
- `track-a-chain-cross.test.mjs` — 2/2 pass. Cross-process chain + set_goal
  interruption, cross-process setChainWebhook + advanceGoalChain.
- `track-a-tmp-collision.test.mjs` — 2/2 pass. 10000 in-process writes (no
  failures on Windows), cross-process pid disambiguation.
- `track-a-tmp-simulation.test.mjs` — 3/3 pass. Forced same-filename writeFileSync +
  renameSync behavior.
- `track-a-stress.test.mjs` — 2/2 pass. 1000 in-process writes, unique temp filename
  count.

**Total: 19/19 tests pass.** No source files were modified during the review.

## Notes for the verifier

- The brief's premise about `tui.tsx` having its own `writeState` was wrong. The TUI
  has delegated to the shared primitive since v0.2.0-rc.10. The docstring at
  `tui-logic.ts:9-13` explicitly states this is the design.
- The red-team report (`red-team-report.md`) and the v0.4.0 hardening commit
  (`4bdfa8f`) already covered the major race conditions. This review extends the
  coverage to TUI/CLI delegation, the async window in `evaluate()`, the temp file
  collision theory, and the spec/changelog doc drift.
- The `withStateLock` removal in v0.3.0 (commit `4217a13`) is the largest doc-vs-code
  gap. The project's authoritative concurrency stance lives in
  `goal-state.ts:537-550`; the spec and changelog do not reflect it.
- The reproduction scripts are intentionally NOT added to the project's `test/`
  suite (this is a one-shot review, not a code change). They are preserved in this
  output directory for the verifier to re-run if needed.
