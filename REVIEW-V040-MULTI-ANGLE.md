# OpenGoal v0.4.0 — Multi-Angle Review

**Build HEAD:** `4bdfa8f` ("test+audit: v0.4.0 hardening — 209 new tests + 14 real defects fixed")
**Date:** 2026-06-12
**Reviewers:** 6 independent review tracks (A–F), each a read-only review with reproduction evidence.

This document aggregates the findings of six independent review tracks. **It contains no new findings** — every defect, judgment, and recommendation comes verbatim from the per-track reports. The per-track files at `review-tracks/` are the authoritative source for evidence and reproduction.

Per-track evidence: `review-tracks/track-a-concurrency.md`, `track-b-plugin-api.md`, `track-c-typescript-static.md`, `track-d-tui.md`, `track-e-adversarial-input.md`, `track-f-regression-check.md`.

---

## 1. Executive summary

### 1.1 Headline

**The v0.4.0 hardening is structurally sound. The D6 chain-webhook patch and the F1 server-webhook flake fix layered cleanly. 734/734 tests pass. Two `tsc` configs are clean.**

There are **2 critical/high defects** (1 Critical, 1 High) that should ship in a v0.4.1 patch, plus **6 Medium defects** and **19 Low defects** in the v0.4.1 / v0.4.2 backlog. (E-7 is an observation, not a defect — see §1.3.) User-impact severity within the Medium tier varies: E-1, E-2, and the B-3 sub-finding B-3b (`session.error`) have direct user-visible impact; A-1 is a doc patch; C-3 is theoretical (not currently reachable in deployment); C-4 is a type-system cleanliness issue. **No defect is severe enough to warrant reverting v0.4.0.** Track F's 10 regression checks all PASS.

### 1.2 Defects by severity (no synthesized count)

Each item below is a discrete finding sourced from the per-track reports and detailed in §2. Items are listed under the severity assigned by the originating track. "Total" at the bottom is the count of discrete finding IDs (not lines of code or call sites).

**Critical (1)**
- C-1 — `SetResult` missing `reason` discriminant → wrong CLI exit codes (Track C, §2.1)

**High (1)**
- C-2 — Silent corruption recovery hides a real defect class (Track C, §2.2)

**Medium (6)**
- A-1 — Doc/changelog claim `withStateLock` exists; removed in v0.3.0 (Track A, §2.7)
- B-3 — Missing event handlers for `session.compacted`/`session.error`/`session.deleted`/`session.created` (Track B, §2.8; aggregates B-3a–3d as one root-cause finding)
- C-3 — `process.pid + Date.now()` tmp-filename entropy at 3 atomic-write sites (Track C, §2.5)
- C-4 — Non-discriminated result interfaces (5 `!` callsites) (Track C, §2.6)
- E-1 — `/goal chain start` drops pre-chain webhook (D6 spec violation) (Track E, §2.3)
- E-2 — `validateGoalChain` accepts malformed `step.verification`; advance produces unrecoverable state (Track E, §2.4)

**Low (19)** — detailed in §2.9:
- A-4 (Track A), A-5 (Track A)
- B-1 (Track B), B-5 (Track B), B-8 (Track B), B-9 (Track B), B-11 (Track B)
- C-5 (Track C), C-6 (Track C), C-7 (Track C), C-8 (Track C)
- D-11 (Track D), D-12 (Track D), D-13 (Track D), D-14 (Track D)
- E-3 (Track E), E-4 (Track E), E-5 (Track E), E-6 (Track E)

**Total discrete defects: 27** (1 Critical + 1 High + 6 Medium + 19 Low).

The §2.9 Low table is the authoritative list of all 19 Low items; cross-reference by ID. E-7 (BOM observation) is NOT in the defect count — it is listed in §1.3 as a smell/observation per Track E's own severity classification.

### 1.3 Items that are NOT defects (so the verifier can audit the judgment)

These items appear in the per-track reports but were classified as designed / workaround-OK / smell / observation. They are **not counted** in the §1.2 totals. Listed here for transparency, not as defects.

**Designed or accepted by the project (not defects):**
- A-2 — `evaluate()` async-window staleness (Track A: state.id re-read is the protective boundary)
- A-3 — Cross-process concurrent writers can lose edits ("last rename wins") (Track A: documented at `goal-state.ts:537-550`)
- A-6 — `isEvaluating` is process-local; cross-process mutual exclusion is impossible (Track A: architectural)
- D-7 — TUI toggle/clear race with concurrent Desktop writer (Track D: low-severity, accepted by v0.4.0 design; UX impact only)

**Workarounds classified WORKAROUND-OK by Track B (5 items, defensible, documented):**
- B-2 — `command.execute.before` part cast (Track B)
- B-4 — `experimental.session.compacting` `output.context.push` (Track B)
- B-6 — All four `client.*` calls correctly signed (Track B)
- B-7 — `default: return` in event switch (Track B)
- B-10 — `process.stdin.fd as unknown as number` cast (Track B)

**Smells or observations (4 items, not blocking):**
- B-8 (Track B, also listed in Low but is a smell-class item)
- C-9 — `isLocalUrl` doesn't handle IPv4-mapped IPv6 loopback (Track C)
- C-10 — 5 non-null assertions on non-discriminated result interfaces (Track C, mirrors C-4)
- E-7 — BOM stripped incidentally via `trim()` (Track E, observation only)

> **Note on B-8:** B-8 is "per-PLUGIN-INSTANCE lock, not per-SESSION" and appears in both Track B's smell list and in this aggregated doc's §2.9 Low table. Track B's own table lists it as SMELL; for aggregation I included it in §2.9 because it has the same root cause as B-3d (multi-session fan-in) and ships in the same patch. The "items not counted as defects" list above treats it as a smell per its track of origin.

**Caveat on the Medium count:** Track A classifies A-1 as `wontfix-with-reason` (after fix) — a doc patch, not a code patch. Track B classifies B-3b specifically as DEFECT and the other three (B-3a/c/d) as MEDIUM; the aggregation treats all four B-3 sub-items as one root-cause finding (Medium) per the root-cause aggregation in §2.8. Track E classifies E-1 and E-2 as MEDIUM. The per-track severity tags are preserved; the aggregation groups by root cause for actionability.

### 1.4 Regression status of prior fixes (Track F)

| # | Check | Status |
|---|-------|--------|
| 1 | B1: `command.ts` chain start size cap | **PASS** |
| 2 | B2: `cli.ts` template import `<path>` size cap | **PASS** |
| 3 | B3: `cli.ts` template import `<stdin>` chunked read | **PASS** |
| 4 | D6: chain-level webhook — 11/11 tests pass | **PASS** |
| 5 | F1: server-webhook test — 5/5 runs no flake | **PASS** |
| 6 | `readFileSync` in `goal-chain.ts` all bounded | **PASS** |
| 7 | No new `exec`/`execAsync` in `src/` | **PASS** |
| 8 | Atomic write pattern intact (3 functions, not 4) | **PASS** |
| 9 | `tsc` clean for both configs | **PASS** |
| 10 | `npm test` 734/734 green | **PASS** |

**All 10 regression checks PASS.** See §5 for full evidence.

### 1.5 Brief-premise corrections worth surfacing

Three of the six review briefs contained hypotheses that **did not match the current code**. The reviewers verified with citations and reproductions:

| Brief hypothesis | Reality | Evidence track |
|------------------|---------|----------------|
| `tui.tsx` has its own `writeState` separate from the shared primitive | TUI delegates to the shared `writeGoalStateAtomic` since v0.2.0-rc.10; the JSX layer has zero write surface | A |
| `tui.tsx:1056-1066` redefines `GoalState` with fewer fields; the local writer drops unknown fields | `tui.tsx` does not redefine `GoalState`; type is single-sourced from `goal-state.ts:44-85`; the writer JSON.stringifies the canonical type | D |
| A failed `renameSync` in `writeState` is silently swallowed (TUI's catch is empty) | `writeGoalStateAtomic` **does** rethrow on failure; the TUI's `toggle()`/`clear()` handlers catch and surface an error toast via `debouncedToast` | D |

**Implication:** the brief-level hypotheses about TUI/CLI/server "dual writers" are structurally closed by the v0.2.0-rc.10 and v0.4.0 refactors. There is exactly one write surface for the state file.

---

## 2. Defects sorted by severity

### 2.1 CRITICAL — C-1: `SetResult` missing `reason` discriminant

- **Track:** C
- **File:line:** `src/goal-state.ts:552-557`, consumed at `src/command.ts:194-197`, `src/command.ts:287`, `src/server.ts:495`.
- **Description:** `SetResult` is the only "result object" interface in the codebase still using the pre-refactor pattern. `TransitionResult`, `EditResult`, `ToggleResult`, and `ClearResult` were all migrated to discriminated unions; `SetResult` was missed. `setGoal` returns three distinct failure causes — invalid value (CLI exit 1), too-long value (CLI exit 1), and disk-write failure (CLI exit 3) — all collapsed to `kind: "no-goal"` (CLI exit 2). Scripts that branch on exit code get the wrong answer for every `set` failure.
- **Evidence:** `track-c-typescript-static.md` lines 30-90 (full reproduction, fix shape, and exit-code mapping). The A1 fix pattern at `command.ts:397-413` (for `restart` and `handoff`) demonstrates the right way to handle this; the `set` path was missed.
- **Fix proposal (one sentence):** Migrate `SetResult` to a discriminated union with a `reason: "invalid-value" | "write-failed"` discriminant; update the three call sites to map to `GoalCommandKind` directly.
- **Regression test idea:** Assert in `cli-e2e.test.mjs` that `set ""` exits 1 (not 2) and `set` against an unwritable state directory exits 3 (not 2). No such test exists today.

### 2.2 HIGH — C-2: Silent corruption recovery hides a real defect class

- **Track:** C
- **File:line:** `src/goal-state.ts:499-509` (`readGoalState`), `src/goal-state.ts:512-521` (`readGoalStateRaw`), `src/goal-state.ts:1294-1309` (`readHandoff`), `src/goal-chain.ts:102-113` (`readGoalChain`).
- **Description:** All four readers have `try { ... } catch { return null; }`. Three distinct failure modes — missing file (correct "no goal"), oversize file (DoS guard tripped), and corrupt file (JSON parse or validator reject) — all collapse to `null`. 51 of 52 `readGoalState` callsites in `src/` treat `null` as "no goal" (the GUI is the only disambiguator, via `readGoalStateSafe` at `gui.ts:65-104` which threads `corrupt: boolean` but the underlying primitive still returns bare `null`). A corrupt `.goal-state.json` is silently treated as "no goal" and the next `setGoal` overwrites it — destroying any recoverable evidence.
- **Evidence:** `track-c-typescript-static.md` lines 94-141. The `gui.ts:readGoalStateSafe` already proves the team knows the issue; the fix wasn't propagated.
- **Fix proposal (one sentence):** Thread a tri-state `ReadResult` (`{ kind: "absent" } | { kind: "corrupt"; reason: "parse" | "validate" | "oversize" } | { kind: "ok"; state: GoalState }`) through the four readers; on `corrupt`, rename the file to `.goal-state.json.corrupt.<ts>` before any subsequent write.
- **Regression test idea:** A test that writes a deliberately invalid JSON to `.goal-state.json` and asserts that `readGoalState` returns the `corrupt` signal AND that the file is renamed (not silently overwritten on the next `setGoal`).

### 2.3 MEDIUM — E-1: `/goal chain start` drops pre-chain webhook (D6 spec violation)

- **Track:** E
- **File:line:** `src/command.ts:466`.
- **Description:** The D6 spec change added `{ webhook: "from-state" }` as a `createGoalChain` option, and `createGoalChain` correctly handles it (covered by `v040-chain-webhook.test.mjs:179-221`). The CLI dispatcher at `command.ts:466` calls `createGoalChain(directory, steps)` — **no webhook option at all**. The pre-chain state's webhook is never promoted to the chain, so step 0's state has no `metadata.webhook` and the achieved transition does not fire a webhook.
- **Evidence:** `track-e-adversarial-input.md` lines 41-114 (full repro, expected vs actual output). This is a regression of a documented v0.4.0 feature.
- **Fix proposal (one sentence):** Change `createGoalChain(directory, steps)` to `createGoalChain(directory, steps, { webhook: "from-state" })` at `command.ts:466` (one line); consider making `from-state` the default to prevent future propagation slips.
- **Regression test idea:** Add a CLI-level test that runs `set` → `goal_webhook` → `chain start` and asserts the chain's `webhook` field equals the pre-chain state's webhook (currently the assertion would fail).

### 2.4 MEDIUM — E-2: `validateGoalChain` accepts malformed `step.verification`; advance produces unrecoverable state

- **Track:** E
- **File:line:** `src/goal-chain.ts:167-173` (the `for (const step of chain.steps)` loop in `validateGoalChain`).
- **Description:** `validateGoalChain`'s per-step loop checks `condition`, `command`, `maxTurns`, `maxMinutes` but not `verification`. A chain file with a malformed `verification` (e.g. `{ "type": "BANANA" }`) on any step passes validation; when that step becomes active via `advanceGoalChain`, the new state has the malformed verification, the next `readGoalState` rejects it, and the chain silently dies mid-way. The user sees `chain status` showing step 1/2 with no state — unrecoverable except via `chain reset`.
- **Evidence:** `track-e-adversarial-input.md` lines 117-205 (full repro, expected vs actual output, fix shape). The validator at `goal-state.ts:223-233` does the same shape check for `GoalState.verification`; the chain validator was missed.
- **Fix proposal (one sentence):** Add per-step `verification` validation to `validateGoalChain`'s step loop, mirroring the shape check at `goal-state.ts:223-233` (the duplication is unfortunate but defensive until a shared helper exists).
- **Regression test idea:** Construct a chain file with one valid and one malformed step; assert `createGoalChain` returns `ok: false` (currently returns `ok: true`).

### 2.5 MEDIUM — C-3: `process.pid + Date.now()` tmp-filename entropy (1-line fix)

- **Track:** C
- **File:line:** `src/goal-state.ts:527` (`writeGoalStateAtomic`), `src/goal-state.ts:1236` (`writeHandoffAtomic`), `src/goal-chain.ts:119` (`writeGoalChainAtomic`). Compare `src/templates.ts:199` which adds `Math.random()`.
- **Description:** The three atomic-write primitives construct `${p}.tmp.${process.pid}.${Date.now()}`. Empirically verified at 99.97% collision rate within a 1ms window (1M iterations). `templates.ts:199` already uses the augmented form `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2,8)}` — the other three sites don't. In production, the 5-second debounce and the user's hand-driven CLI cadence mean the collision isn't currently reachable; but a future fuzz test or load scenario would hit it, and the inconsistency is a code-smell + future-bug magnet.
- **Evidence:** `track-c-typescript-static.md` lines 143-176 (empirical verification, collision scenario, fix shape).
- **Fix proposal (one sentence):** Use `randomUUID().slice(0, 8)` from `node:crypto` (already imported in `goal-state.ts:13`) at all three sites; or extract a single `makeTempPath(targetPath)` helper and call it from all four sites.
- **Regression test idea:** A test that explicitly issues 10,000 same-process writes and asserts every write either succeeds with a unique final state or fails with a clear error. The current code silently collapses same-ms writes.

### 2.6 MEDIUM — C-4: Non-discriminated result interfaces (5 `!` callsites)

- **Track:** C
- **File:line:** `src/goal-state.ts:552-557` (`SetResult`), `src/goal-chain.ts:193-198` (`CreateChainResult`), `src/goal-chain.ts:334-342` (`AdvanceChainResult`). Consumers at `command.ts:198, 287, 468`, `server.ts:409, 501`.
- **Description:** Three result interfaces still use the pre-refactor pattern (optional fields, no discriminant). Five call sites use non-null assertions (`res.state!`, `chainResult.message!`). If a future refactor adds a `completed: true` return path without a `message`, the `!` on `server.ts:409` silently passes `undefined` to `notify` and the user sees an empty toast.
- **Evidence:** `track-c-typescript-static.md` lines 179-225.
- **Fix proposal (one sentence):** Migrate the three interfaces to discriminated unions (mirror `TransitionResult` at `goal-state.ts:667-676`); the `!` operators all disappear in one pass. Follow-on to C-1's fix.
- **Regression test idea:** Any test that exercises the result-shape contract catches a future regression; today the `!` makes the contract un-testable.

### 2.7 MEDIUM — A-1: Doc/changelog claim `withStateLock` exists; the lock was removed in v0.3.0 (unannounced)

- **Track:** A
- **File:line:** `CHANGELOG.md:79-80, 104, 295`, `specs/v0.4.0-roadmap.md:77, 88, 577`, `src/tui-logic.ts:120-121, 141-142`.
- **Description:** 14 references to `withStateLock` in docs and 2 stale code comments, but no such helper exists in the current code at HEAD `4bdfa8f`. It was removed in commit `4217a13` (v0.3.0, "refactor (lock): remove advisory file lock — eliminate TOCTOU bug class"). The v0.3.0 removal is **not documented anywhere in CHANGELOG.md** (the changelog jumps from `## 0.2.1` to `## 0.4.0` — v0.3.0 is missing). The actual concurrency stance is documented at `src/goal-state.ts:537-550` (no lock; last-rename-wins is accepted).
- **Evidence:** `track-a-concurrency.md` lines 76-159.
- **Fix proposal (one sentence):** Add a `## 0.3.0` section to `CHANGELOG.md` documenting the file-lock removal; strip `withStateLock` references from `specs/v0.4.0-roadmap.md` and the v0.4.0 CHANGELOG sections; update the two stale `tui-logic.ts` comments to refer to "single read-decide-write turn."
- **Regression test idea:** A `test/docs-drift.test.mjs` that runs `rg 'withStateLock' src/` and asserts zero matches.

### 2.8 MEDIUM — B-3: Missing event handlers for `session.compacted`, `session.error`, `session.deleted`, `session.created`

- **Track:** B
- **File:line:** `src/server.ts:837-886` (the `event` switch handles 3 of 30+ event types).
- **Description:** Four events cause state-file drift because they're not handled:

  | Event | Drift | Severity |
  |-------|-------|----------|
  | `session.compacted` | `lastEvaluationTime` not reset; post-compaction `session.idle` is debounced for the full 5s window | MEDIUM |
  | `session.error` | Loop continues nudging a dead session (e.g. `ProviderAuthError`); goal stays "active" forever with no user signal | **DEFECT** (per B-3b) |
  | `session.deleted` | State file lingers for a deleted session; a new session in the same dir inherits the old goal | MEDIUM |
  | `session.created` | New session's events share the per-instance `isEvaluating` lock; first session's evaluation blocks subsequent sessions for the full debounce window; idle events are fire-and-forget — the lost event is not deferred | MEDIUM |
- **Evidence:** `track-b-plugin-api.md` lines 158-260.
- **Fix proposal (one sentence):** Add four cases to the event switch; for `session.error` specifically, transition the goal to "paused" with reason "Session error: <message>" and fire a webhook on the active→paused transition so the user gets a notification.
- **Regression test idea:** A unit test that dispatches a synthetic `session.error` event and asserts the goal transitions to "paused."

### 2.9 LOW — Remaining defects (for v0.4.1 / v0.4.2 backlog)

| ID | Track | File:line | Defect |
|----|-------|-----------|--------|
| A-4 | A | `goal-state.ts:527, 1236` + `goal-chain.ts:119` | Same-process same-ms temp-filename collision (theoretical on Windows, reachable on fast-SSD Linux). Same fix as C-3. |
| A-5 | A | `tui-logic.ts:120, 142` | Stale `withStateLock` comments (cosmetic; covered by A-1). |
| B-1 | B | `server.ts:139` | `as any[]` cast on `session.messages` response hides a real shape contract; the access pattern works today by coincidence but is one SDK release away from breaking. Fix: replace with `Array<{ info: Message; parts: Part[] }>`. |
| B-5 | B | `server.ts:439-455` | `client.session.prompt` continue-prompt path swallows errors. After N consecutive failures (e.g. N=3), transition the goal to "paused" with a "nudge delivery failed" reason so the user gets a notification. |
| B-8 | B | `server.ts:66-67, 309-316` | `isEvaluating`/`lastEvaluationTime` are per-PLUGIN-INSTANCE, not per-SESSION. (Same as B-3d; listed separately by track B for the "isolation" line of inquiry.) |
| B-9 | B | `server.ts:888` | `experimental.session.compacting` ignores `input.sessionID`; the `_input` should be commented as "intentionally unused; goal is per-directory, not per-session." |
| B-11 | B | `server.ts:138-139` | `res.data ?? []` is dead-code defensive; the real problem is the cast (bundled with B-1). |
| C-5 | C | `server.ts:244-269` | `fireWebhook` is `async` but does no `await`; 7 fire-and-forget callsites. Not a defect today; future trap. Fix: drop `async` or document explicitly. |
| C-6 | C | `cli.ts:131, 144, 318`, `goal-state.ts:280, 288, 295, 308` | `noUncheckedIndexedAccess` would surface 5 real type-soundness gaps (regex `m[1]` typed `string` but should be `string \| undefined`). Runtime-safe; mechanical fix. |
| C-7 | C | 5 files, 8 sites | `exactOptionalPropertyTypes` would surface 8 sites where properties typed `T?` are assigned `T \| undefined`. Runtime-safe; type-system cleanliness only. |
| C-8 | C | `server.ts:196, 209` | Dynamic `import("node:path")` / `import("node:fs")` inside `evaluateFile` despite `server.ts` statically importing `node:child_process`/`node:util`. Static-import everywhere. |
| D-11 | D | `sidebar.tsx:170` | `renderFooter` calls `buildSidebarView(directory)` directly, bypassing the FIX-5 mtime cache used by `renderTitle` and `renderContent`. Trivial 2-line fix. |
| D-12 | D | `tui.tsx:382-425` | All 13 keymap `run()` callbacks declare zero arguments but `@opentui/keymap` `Command.run` requires `ctx`. Works today via index-signature tolerance; latent fragility. |
| D-13 | D | `tui.tsx:197-215` | Toast debounce map pruning is conditional on `> TOAST_MAP_SOFT_CAP`. Acceptable in practice; worth noting in the design comment. |
| D-14 | D | `goal-state.ts:204-250` | `validateGoalState` does not range-check `startedAt`. A state file with `startedAt: -1` passes validation and `computeProgress` renders ~17M elapsed minutes. Same defect as Track D-4a; fix in the validator. |
| E-3 | E | `templates.ts:83-108` | `importTemplate` accepts empty / whitespace-only `condition`; missing `condition.trim().length === 0` check. UX confusion: template shows in `list` but `use` fails. |
| E-4 | E | `templates.ts:114-145` | `discoverTemplates` lists user templates larger than the 256KB `MAX_TEMPLATE_IMPORT_SIZE` cap. The cap is enforced at import time and at the CLI, not at list time. |
| E-5 | E | `goal-chain.ts:149-159` | `sanitizeChainWebhook` allows CRLF in URL. No current exploit (the URL is never concatenated into a receiver-visible string), but the sanitizer is the trust boundary. |
| E-6 | E | `goal-state.ts:141-142` | `detectMarker` regex `/^[ ]{0,3}GOAL_COMPLETE/` does not match tab-indented markers. Markdown-spec says tabs are code-block indentation, so current behavior is correct; pick a side and document. |

> **Note on E-7:** Track E classified E-7 ("BOM is stripped incidentally via `trim()`, not by an explicit check") as an **observation** in its own severity table (`track-e-adversarial-input.md:27`), not as a Low defect. The aggregated doc lists E-7 in §1.3 (smell/observation) and excludes it from the §1.2 defect count. See `src/goal-state.ts:418-429, 634` for the source.

---

## 3. "No defect" sections per track — what was checked and confirmed clean

### 3.1 Track A — Concurrency & Race Conditions

**Areas traced and confirmed clean beyond the documented "last-rename-wins" behavior:**

1. **TUI dashboard / dials / sidebar** (`tui.tsx`, `tui-logic.ts`, `tui-dials-logic.ts`, `sidebar.tsx`, `sidebar-logic.ts`) — all delegate to the shared `goal-state.ts` primitives. **No second write surface.** Verified by `rg -n 'writeFileSync|writeState' src/tui.tsx src/sidebar.tsx src/sidebar-logic.ts src/tui-logic.ts src/tui-dials-logic.ts`: only imports.
2. **CLI dispatcher** (`cli.ts`, `command.ts`) — both delegate to `dispatchGoalCommandStructured`, which calls the same `goal-state.ts` primitives. No CLI-only write path.
3. **`atomicToggle`** (the fix for the TUI mashing bug) — read-decide-write inside a single function call; JS single-threaded execution model guarantees no interleave. Verified by `track-a-in-process.test.mjs` "atomicToggle called 1000x in a tight loop — toggle count = 1000" (4/4 pass).
4. **Handoff create + claim** (cross-process) — `createHandoff` / `claimHandoff` at `goal-state.ts:1251-1383`. Cross-process test confirms the on-disk state file is always internally consistent.
5. **Chain create + manual `set_goal`** (cross-process) — `chainId` mismatch guard in `advanceGoalChain` catches the override and returns "Chain interrupted — goal was manually overridden." Verified 2/2 pass.
6. **Chain webhook projection (D6 fix)** — `applyChainWebhookToState` at `goal-chain.ts:223-233` is the single projection point; all 4 step-creation paths route through it. Structurally correct.
7. **`evaluate()` async-window staleness** — the IIFE at `server.ts:322, 354, 378` re-reads state and re-checks `state.id`; a stale evaluation result cannot inject into a replaced goal. (Track A classified A-2 as designed-not-defect.)
8. **Temp file naming (cross-process, pid disambiguation)** — different processes have different pids, so cross-process collisions are impossible even if the timestamps match. (In-process same-ms is the theoretical case, see C-3 / A-4.)

**Reproduction artifacts:** 19/19 tests pass across 7 reproduction scripts (`track-a-cross-process.test.mjs`, `track-a-in-process.test.mjs`, `track-a-chain.test.mjs`, `track-a-chain-cross.test.mjs`, `track-a-tmp-collision.test.mjs`, `track-a-tmp-simulation.test.mjs`, `track-a-stress.test.mjs`).

### 3.2 Track B — OpenCode Plugin/SDK API Misuse

**Workarounds classified WORKAROUND-OK (defensible, documented):**

- **B-2** `server.ts:833` `command.execute.before` part cast — the `as unknown as (typeof output.parts)[number]` is a deliberate contract claim that the host fills `id`/`sessionID`/`messageID`. The "host fills them" assumption is unverified without live testing (the red-team report explicitly noted this), but the cast is documented in the comment (lines 825-832). The two-site append pattern (`output.parts = [...output.parts, part]`) is the right defense.
- **B-4** `server.ts:888-908` `experimental.session.compacting` `output.context.push` — matches the documented contract; pushing is the documented pattern.
- **B-6** All four `client.*` calls (`app.log` at line 73, `tui.showToast` at line 81, `session.prompt` x2 at lines 82, 439, `session.messages` at line 138) are signed correctly against the SDK's `body`/`path`/`query` envelope; all field types match. The `.catch(() => {})` patterns are intentional.
- **B-7** `server.ts:883-884` `default: return` in event switch — good defensive coding; comment is accurate (handles a runtime event whose type the type system doesn't know about).
- **B-10** `cli.ts:408` `process.stdin.fd as unknown as number` — legacy type workaround; runtime value is always a number.

**Smells classified SMELL (track, don't fix):**

- **B-8** (same as A-3 / B-3d) `isEvaluating` is per-plugin-instance, not per-session.
- **B-9** `experimental.session.compacting` ignores `input.sessionID` — should be commented as "intentionally unused."
- **B-11** `res.data ?? []` is dead-code defensive; the real problem is the cast (covered by B-1).

**Not verified (out of scope of code reading):** Live behavior of `command.execute.before` part ID-filling (would require running the v0.4.0 README smoke test); OpenCode host source; multi-workspace OpenCode deployments (verified by code reading, not by runtime test).

### 3.3 Track C — TypeScript Soundness & Static Analysis

**Patterns the brief asked about, classified NOT defect:**

1. **41 `catch (err: any)` sites** — 32 that use `err` all do `err?.message ?? err` or similar; the 9 untyped `catch (err)` sites all just do `return null` or `log("error", ..., { error: String(err) })`. The only non-trivial use (`server.ts:126-131`, child_process error inspection) is correctly safe.
2. **13 `try { } catch { /* ignore */ }` cleanup sites** — all are best-practice cleanups (`unlinkSync(tmp)` after a failed atomic write, `closeSync(openedFd)`, `watchHandle.close()`, `isLocalUrl` catch returning `false`). None hide a defect class.
3. **5 `.catch(() => {})` / `.catch((err) => log(...))` sites** — all fire-and-forget for non-critical operations (log, toast, webhook fetch, notify). None hide a defect class.
4. **No `void someAsync()` patterns.** Non-awaited `fireWebhook(...)` is C-5 (async-by-habit, not a defect today).
5. **Discriminated-union consumers** (`TransitionResult`, `EditResult`, `ToggleResult`, `ClearResult`) — uniformly correct. Consumers all narrow on `if (res.ok)` first.
6. **11 `JSON.parse` sites** — all 11 wrapped in try/catch. The deeper issue is the silent recovery in 4 of them (C-2).
7. **`process.pid + Date.now()` for temp filenames** — C-3 covers the 3 sites; the 1 in `templates.ts` uses `Math.random()`.
8. **tsconfig strictness** — `strict: true` covers `noImplicitAny`, `strictNullChecks`, `strictFunctionTypes`, `strictBindCallApply`, `strictPropertyInitialization`, `noImplicitThis`, `useUnknownInCatchVariables`, `alwaysStrict`. `noImplicitOverride` is clean (no class hierarchies). `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` would surface additional sites (C-6, C-7); recommend leaving them off unless the team wants the marginal benefit.
9. **0 `Promise.all` / `Promise.race` / `Promise.allSettled` / `Promise.any` uses** — codebase is almost entirely sequential. No parallelism leak defects.
10. **Regex reuse and stateful `lastIndex`** — module-level constants for hot-path patterns (good); per-call `new RegExp` for user-supplied patterns (necessary); `/g` + `exec` loops in function-scoped regexes terminate correctly. No stateful bug.
11. **Node deprecations** — all imports use `node:` protocol; no `new Buffer()`, no `require("fs")`, no `domain.*`/`setImmediate`/`process.binding`, no legacy `util.is*`, no `__dirname`/`__filename` (uses `import.meta.url` correctly). Zero Node deprecation violations. Codebase is on the modern Node 20+ API surface (`engines.node = ">=20"`).

**Smells classified SMELL (track, don't fix):**

- **C-9** `server.ts:286-300` `isLocalUrl` doesn't handle IPv4-mapped IPv6 loopback (`[::ffff:127.0.0.1]`). Spec says "string match"; gap is small; not a real exploit path.
- **C-10** 5 non-null assertions on non-discriminated result interfaces. Mirrors C-4; disappears when C-4 is fixed.

### 3.4 Track D — TUI Correctness

**Brief findings classified moot or resolved by v0.4.0 refactor:**

- **D-1, D-2, D-3, D-5, D-6** → moot or resolved. The TUI's I/O was extracted to `tui-logic.ts` and `tui-dials-logic.ts`; the JSX layer is a thin wrapper with no write surface, no local `GoalState` redefinition, no in-memory `s` object, and no silent failure on rename.
- **D-8** → confirmed safe. The `DashboardView` render at `tui.tsx:123-162` is well-guarded by `<Show when={state()} fallback={...}>` and optional chaining. No null-state crash path.
- **D-9** → confirmed real. All `TuiDialogConfirm` / `TuiDialogStack.replace` / `TuiDialogStack.clear` / `TuiDialogPrompt` / `TuiToast` API surfaces used by the TUI exist in the host's type defs (`@opencode-ai/plugin/dist/tui.d.ts` 1.17.1) with the exact prop shape. The plugin is type-correct against the official spec.
- **D-10** → confirmed safe. All 13 `slashName`s, 13 command `name`s, and 1 route name are unique within the plugin. Cross-plugin collision is a convention concern (the `goal.` namespace prefix), not a defect.

**TUI-specific confirmed clean (beyond Track A's "no second write surface"):**

- All 13 `api.ui.*` and `api.event.*` calls match the host's type defs.
- `npx tsc --noEmit` project-wide exits 0.
- `computeProgress` math edge cases (`maxTurns=0`, `turns>maxTurns`, future `startedAt`, `Infinity`, `undefined` `state.startedAt`) are all safe — except for the negative-`startedAt` case (D-14 / D-4a, see §2.9).
- `readDashboardState` filter at `tui-logic.ts:72` means the dashboard never shows a stale state after a file change (re-reads on `file.watcher.updated`).

### 3.5 Track E — Adversarial Input & Boundary Cases

**164 individual cases across 12 probe scripts; areas probed and confirmed clean:**

- **JSON.parse boundaries** (24 cases): top-level array, string/number/null root, deeply nested objects, broken JSON, empty file, whitespace-only file, wrong schema, wrong types — all 24 rejected by the validators or by the try/catch around the parse.
- **Path traversal in template names**: the `/^[A-Za-z0-9_-]+$/` regex on every name path (`templates.ts:129, 149, 179`, `command.ts:251`) rejects `../etc/passwd`, absolute paths, names with shell metacharacters, leading dots, leading dashes.
- **Built-in vs user template discovery**: `discoverTemplates` handles a missing `.opencode/goals/` directory, a file in place of the directory, and broken JSON per file. The `userTemplateSeed` fallback handles broken-JSON and `condition: null`.
- **Webhook URL sanitization (most cases)**: `javascript:`, `data:`, `file:`, empty string, missing URL, empty `on` array, invalid `on` entries, mixed valid+invalid `on` — all properly handled. `allowLocal: "yes"` and `allowLocal: 1` are correctly coerced to `false`.
- **SSRF guard (`isLocalUrl`)**: `127.0.0.0/8`, `localhost`, `0.0.0.0`, `[::1]` are all blocked. `10.0.0.1` and `169.254.169.254` (AWS metadata) are intentionally NOT blocked (spec call-out, common in CI runners). Hostname tricks (`localhost.attacker.com`) are correctly NOT blocked at the string level.
- **`detectMarker` regex**: markers inside fenced code blocks (``` or ~~~) correctly ignored; 4-space-indented markers correctly NOT detected (markdown code block); 3-space-indented markers correctly detected; 100MB-line DoS test took 74ms (no memory blowup).
- **`--command` flag parser** (`parseCommand`): requires the value to be quoted (double or single). Unquoted, backtick-quoted, and unterminated-quote variants all return `null`. The CLI's `buildSetPayload` rejects missing values, empty values, embedded double quotes, and duplicate flags.
- **Template import**: the 256KB cap is enforced at `importTemplate` and at `handleTemplateImport` BEFORE `JSON.parse`. Templates with declared-but-unused variables, undeclared variables, 1000 declared variables, and `$IFS`-style placeholders are all correctly handled.

**Probe scripts:** `outputs/track-e-adversarial-input/probes/` (12 scripts, 164 cases total).

### 3.6 Track F — Regression Check

**All 10 regression checks PASS.** See §5 for the full evidence chain. **No critical regressions found.** D6 patch layered cleanly on top of the red-team hardening; B1/B2/B3 size caps intact; F1 server-webhook test is flake-free across 5 consecutive runs; both `tsc` configs compile clean; full suite is 734/734 green.

**Negative findings confirmed:**

- No `.only(`, `.skip(`, live `TODO`, or `FIXME` in test files.
- No new `unsafe cast` introduced by D6 (the only `as` casts are in `goal-chain.ts:268-274` for `opts.webhook` discriminated-union narrowing, which is sound).
- No new `eval`, `Function(...)`, or `new Function(...)` introduced by D6.
- D6 e2e tests use a real `node:http` receiver on `127.0.0.1:<random>`; the SSRF guard is bypassed by `allowLocal: true` (the documented opt-in for local URLs). Intentional and tested.

---

## 4. Cross-track observations

These are not new defects — they are patterns visible only when the six tracks are read together.

### 4.1 The "per-site propagation slip" pattern appears three times

The same root cause — a feature added with API-level coverage but the CLI/dispatcher/wrapper site not updated — appears in:

- **D6 / E-1**: `createGoalChain`'s `webhook: "from-state"` option is supported by the API and covered by 11 e2e tests, but `command.ts:466` doesn't pass it.
- **C-1 / SetResult vs A1 fix pattern**: `TransitionResult`, `EditResult`, `ToggleResult`, `ClearResult` were migrated to discriminated unions; `SetResult` was missed.
- **C-2 / corrupt-state recovery**: `gui.ts:readGoalStateSafe` threads `corrupt: boolean` for the GUI; the 4 underlying readers still return bare `null`.

The fix is structural, not per-site: either default `from-state` propagation in the API, migrate the missing interfaces, or propagate the corrupt signal through the readers. The "if you have to add the same line at 3+ sites, the API is wrong" smell applies to all three.

### 4.2 Two defects share the same shape and could share a fix

- **A-4 + C-3**: same-process same-ms temp-filename collision. One `randomUUID().slice(0, 8)` call at 3 (or 4) sites.
- **D-4a + D-14**: `validateGoalState` doesn't range-check `startedAt`. The fix belongs in the validator (single boundary), not in `computeProgress`.

### 4.3 The "last-rename-wins" design is consistently applied

Tracks A and D both confirm: the v0.4.0 concurrency model is `atomic write + no lock + last-rename-wins`. The model is documented at `goal-state.ts:537-550`, accepted by the project, and confirmed by cross-process tests. The `state.id` re-read at the IIFE is the protective boundary for state-write staleness. **The brief's worry about TUI/CLI/server "dual writers" is structurally closed.** Any future review should not relitigate this.

### 4.4 The doc-vs-code drift is the most actionable Medium

A-1 (14 references to a non-existent `withStateLock` helper, v0.3.0 removal unannounced) is the cheapest fix and the highest leverage: a future maintainer reading the spec and looking for the helper would either be confused or (re-)add a broken lock, creating the same TOCTOU bug class that was just removed. A doc patch closes the gap; no code change.

---

## 5. Regressions of prior fixes (Track F)

**Verdict: NO REGRESSIONS. All 10 checks PASS.**

| # | Check | Status | Evidence |
|---|-------|--------|----------|
| 1 | **B1**: `command.ts` chain start size cap | **PASS** | `MAX_CHAIN_SIZE = 256 * 1024` exported from `goal-chain.ts:93`, imported in `command.ts:31`, used at `command.ts:455-460` BEFORE `readFileSync`; regression test at `cli-e2e.test.mjs:546` passes. |
| 2 | **B2**: `cli.ts` template import `<path>` size cap | **PASS** | `MAX_TEMPLATE_IMPORT_SIZE` from `templates.ts:48`; `cli.ts:459-462` checks `statSync(path).size > MAX_TEMPLATE_IMPORT_SIZE` BEFORE `readFileSync`; regression test at `template.test.mjs:936` passes. |
| 3 | **B3**: `cli.ts` template import `<stdin>` chunked read | **PASS** | `cli.ts:395-431` chunked read with running byte-count cap; cross-platform (`/dev/fd` first, raw `stdin.fd` fallback); peak heap bounded by ~320KB; regression test at `template.test.mjs:892` passes. |
| 4 | **D6**: chain-level webhook — 11/11 tests pass | **PASS** | `v040-chain-webhook.test.mjs`: 11 `it(...)` blocks, 11/11 pass in 746.5ms. `setChainWebhook(null)` clearing test (test #7) confirmed correct. |
| 5 | **F1**: server-webhook test — 5/5 runs no flake | **PASS** | `waitFor(receiver.received, 1)` at `server-webhook.test.mjs:501`. 5 consecutive runs hit 53/53 with duration ≈ 6.3s (consistent, no degradation). |
| 6 | `readFileSync` in `goal-chain.ts` all bounded | **PASS** | `grep readFileSync src/goal-chain.ts` returns exactly one site (`readGoalChain`, bounded by `statSync(p).size > MAX_CHAIN_SIZE` on line 106). D6 patch did NOT add a new `readFileSync`. |
| 7 | No new `exec` / `execAsync` in `src/` | **PASS** | One `exec` site (`evaluateDeterministic`, server.ts:111), unchanged from red-team baseline; bounded by `commandTimeoutMs: 30_000` and `maxBuffer: 1024*1024`. D6 patch did NOT add a new exec surface. |
| 8 | Atomic write pattern intact (3 functions, not 4) | **PASS** | The 3 atomic writes are `writeGoalStateAtomic` (`goal-state.ts:523`), `writeGoalChainAtomic` (`goal-chain.ts:115`), `writeHandoffAtomic` (`goal-state.ts:1234`). D6 did NOT add a 4th. `setChainWebhook` reuses the existing 2 primitives. |
| 9 | `tsc` clean for both configs | **PASS** | `npx tsc -p tsconfig.json` → exit 0; `npx tsc -p tsconfig.build.json` → exit 0; `npm run build` → exit 0. No type errors in D6-modified files. |
| 10 | `npm test` 734/734 green | **PASS** | 734 tests, 57 suites, 0 fail, 0 cancelled, 0 skipped, 0 todo, 11388ms. Matches the deliverable's claimed count (baseline 723 + 11 D6 tests = 734). |

**Full evidence (tsc logs, build log, F1 5-run logs, full test log):** `outputs/track-f-regression-of-fixed/` (Track F's output directory).

---

## 6. Recommended action

### 6.1 Accept v0.4.0; plan v0.4.1 for the 2 critical/high + 3 user-impacting Medium defects.

**Recommendation: ACCEPT v0.4.0 as-is.** Plan a v0.4.1 patch for:

- The 2 critical/high defects: **C-1** (Critical, wrong CLI exit codes) and **C-2** (High, silent corruption recovery).
- The 3 Medium defects with direct user-visible impact: **E-1** (chain drops pre-chain webhook), **E-2** (chain silently dies mid-way on malformed `step.verification`), and the B-3 sub-finding **B-3b** (loop continues nudging a session in a fatal error state).
- The 3 remaining Medium defects are lower-priority for v0.4.1: **A-1** (doc patch only), **C-3** (theoretical; not currently reachable in deployment), **C-4** (type-system cleanliness; no runtime impact).

The remaining 19 Low defects are v0.4.1 / v0.4.2 backlog items per the per-track classifications. None are severe enough to warrant reverting v0.4.0.

### 6.2 Why not revert?

- **No data corruption or crash path** in any defect at default (single-process OpenCode per workspace) usage.
- **All size caps (B1/B2/B3) intact.** DoS surface is closed.
- **All 734 tests pass.** The D6 chain-webhook feature works as documented at the API level (the bug is at one CLI call site).
- **The TUI/CLI/server "dual writer" race the brief worried about is structurally closed** by the v0.2.0-rc.10 + v0.4.0 refactors. The last-rename-wins model is documented and accepted.
- **F1 server-webhook flake is gone.** 5/5 runs at 6.3s each.

### 6.3 v0.4.1 patch priority (one task per item)

Order: Critical → High → Medium (sorted by user impact within each tier).

1. **C-1** (Critical, 1-2 hours) — Migrate `SetResult` to discriminated union; update the 3 call sites; add the 2 exit-code assertions in `cli-e2e.test.mjs`.
2. **C-2** (High, 1-2 days) — Thread the tri-state `ReadResult` through the 4 readers; rename corrupt files to `.corrupt.<ts>` before any subsequent write; add the `corrupt: true` signal through CLI/server/TUI/chain. **The team has already solved this in `gui.ts:readGoalStateSafe`; propagate the pattern.**
3. **E-1** (Medium, 1 line + 1 test) — `createGoalChain(directory, steps, { webhook: "from-state" })` at `command.ts:466`; add a CLI-level test that runs `set` → `goal_webhook` → `chain start` and asserts the chain's webhook is the pre-chain state's.
4. **E-2** (Medium, ~10 lines + 1 test) — Add per-step `verification` validation to `validateGoalChain`'s step loop at `goal-chain.ts:167-173`. Mirror `goal-state.ts:223-233`.
5. **B-3b** (Medium, 5 lines) — Add `case "session.error"` to the event switch at `server.ts:851-885`; transition goal to "paused" with reason "Session error: <message>"; fire a webhook on the active→paused transition.
6. **A-1** (Medium, doc patch only) — Add `## 0.3.0` to `CHANGELOG.md`; strip `withStateLock` from `specs/v0.4.0-roadmap.md` and the v0.4.0 CHANGELOG sections; update the 2 stale `tui-logic.ts` comments; add `test/docs-drift.test.mjs`.
7. **C-3 / A-4** (Medium, 1-2 lines) — `randomUUID().slice(0, 8)` at the 3 atomic-write temp-path sites (and `templates.ts:199`); or extract a `makeTempPath` helper.

### 6.4 v0.4.1 / v0.4.2 backlog (no rush)

- C-4 (5 `!` callsites — non-discriminated result interfaces)
- C-5 (`fireWebhook` async-by-habit)
- C-6 / C-7 (`noUncheckedIndexedAccess` / `exactOptionalPropertyTypes` opt-in)
- C-8 (dynamic import in `evaluateFile`)
- B-1, B-5, B-8, B-9, B-11 (Plugin/SDK API smells)
- D-11 (sidebar `renderFooter` bypasses cache — 2-line fix)
- D-12 (`run()` should accept `ctx`)
- D-13, D-14 (toast debounce, `startedAt` range check)
- E-3, E-4, E-5, E-6 (template import, marker regex, CRLF defense-in-depth) — E-7 (BOM observation) is in §1.3, not here.

### 6.5 What NOT to do

- **Do not re-add `withStateLock`.** The v0.2.0–v0.3.0 advisory lock was removed after 3 security reviews found 5 TOCTOU bugs. The atomic-write + `state.id` re-read pattern is the correct design for the single-process-per-workspace use case.
- **Do not refactor the async window in `evaluate()` to "fix" A-2.** The IIFE re-reads and refuses on id mismatch. The wasted roundtrip on the OLD goal's verification is the cost of the design, not a defect.
- **Do not turn on `Promise.all` or other parallelism primitives in the auto-loop.** The codebase is intentionally sequential; the async style is the safe form.
- **Do not silently overwrite a corrupt state file.** The fix for C-2 must rename first, not overwrite.

---

*End of aggregated review.*
