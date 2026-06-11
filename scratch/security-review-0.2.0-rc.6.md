# Security Review: opencode-autogoal v0.2.0-rc.6

Branch: feature/gui-foundation-and-sidebar
HEAD: 019d6ef
Reviewer scope: the NEW v0.2.0 surface (10 new primitives, handoff file, TUI dials, /goal dispatcher, compacting hook).

The state file `.opencode/.goal-state.json` and the new handoff file
`.opencode/.goal-handoff.json` are both user-controlled artifacts in a
shared project directory. Anyone with write access can plant one. The
existing trust model (SECURITY.md §2) already calls this out for the
state file; the new handoff file inherits the same posture but is
documented nowhere.

Existing mitigations observed:
- `validateGoalState` rejects loose `command` (only string|null|undefined
  accepted, server.ts:178→execAsync) → no new exec vectors.
- The new primitives consistently funnel through `writeGoalStateAtomic`
  (temp + rename) for the state file → partial-write safe.
- Sidebar sanitization (`sanitizeForSidebar`, sidebar-logic.ts:89) drops
  C0/C1 + 0x7F on display.
- Constraint fields are clamped to `CONSTRAINT_BOUNDS`; NaN/Infinity
  rejected.
- Template names regex-pinned `^[A-Za-z0-9_-]+$` (command.ts:120).

Below: 17 findings, ordered by severity. Each cites file:line.

---

## BLOCKER

### 1. Handoff file: no size cap on read; validator accepts arbitrarily-large `metadata.steering`
- src/goal-state.ts:947 `readHandoff` — `readFileSync(path, "utf-8")` reads
  the entire file into memory, then `JSON.parse` + `validateGoalState`.
  A 10 GB handoff → OOM the plugin.
- src/goal-state.ts:215–217 — the validator's metadata check is
  intentionally loose ("tolerate any object shape so future fields
  don't break older state files"). A malicious handoff can include
  `metadata.steering: [{at: 1, note: "<10MB>"}, ...×20]` and pass
  validation. `createHandoff` caps `evaluationHistory` at 10
  (line 924) but does NOT cap `metadata.steering` size or per-entry
  length. The validator doesn't either.
- The full state (with the planted steering) is then written to
  `.goal-state.json` by `claimHandoff` (line 984). Every subsequent
  `session.idle` event and every TUI `file.watcher.updated` notification
  re-parses the bloated file.

**Why it matters**: a repo can ship a multi-hundred-MB `.goal-handoff.json`.
Just opening the repo and the user running `/goal claim` (or
accidentally clicking the sidebar's "Claim" dial) DoSes the OpenCode
process.

**Mitigation**: cap `readHandoff` input size (e.g. stat-then-early-return
on > ~256 KB), AND tighten the validator to enforce
`metadata.steering` is `Array<{at: number, note: string}>` with
`note.length <= MAX_STEERING_LEN` and `length <= MAX_STEERING_NOTES`.

---

### 2. `claimHandoff` carries forward attacker-controlled `metadata` keys without filter
- src/goal-state.ts:975–981 — `claimHandoff` builds the resumed state
  via `{ ...payload.state, ..., metadata: { ...payload.state.metadata,
  resumedFromHandoffAt: now } }`. The validator accepts any metadata
  shape (line 217). After claim, the resumed goal inherits arbitrary
  metadata keys the attacker chose.
- src/goal-state.ts:786–804 — `restartGoal` then merges that
  metadata again: `metadata: { ...state.metadata, restartedAt, previousId }`.
  Attacker keys survive the restart.

**Why it matters**: a malicious handoff can plant metadata fields that
the runtime DOESN'T currently read (low risk today) but that future
versions might. Forward-compat is fine for the plugin's own fields
but dangerous for an untrusted source. Even today, the auto-loop's
`Array.isArray(fresh.metadata.steering)` check (server.ts:206) is the
ONLY runtime guard — if a future feature reads a new metadata key
without an `Array.isArray` / type check, an attacker's value type-confuses
it.

**Mitigation**: in `readHandoff` (or a new `validateHandoffPayload`
helper), enumerate and re-build metadata from a fixed allowlist
(`{setBy, conditionEditedAt, previousId, restartedAt, steering,
resumedFromHandoffAt, sessionId, agentName}`) and refuse extras. The
`GoalState.metadata` type's explicit field list (goal-state.ts:53–67)
is the allowlist; anything else is untrusted.

---

### 3. `evaluation.reason` is injected verbatim into the continue-prompt — ANSI/U+2028 prompt-injection surface
- src/server.ts:219 — `[GOAL] Not yet met (${evaluation.reason}). …`
- src/server.ts:196 — `notify(sessionId, "Goal achieved", evaluation.reason, ...)`
- The reason is constructed in `evaluateDeterministic` (line 117) as
  `Not met (exit …): ${(stderr || stdout || String(err?.message ?? err)).slice(0, 200)}`.
  A user-typed verification `command` (via `--command "…"` on `/goal set`,
  or via a planted `command` in a state file) whose `stdout`/`stderr`
  contains ANSI escape codes or U+2028/U+2029 lands in the reason, then
  in the prompt. The same is true for the agent's `GOAL_BLOCKED:` text
  (line 178).

**Why it matters**: the existing trust model says the verification
command is "the same trust you extend to npm scripts" (SECURITY.md §1)
— so ANSI from a user's own command is expected. But:
  (a) The same is NOT documented for a planted state file's `command`
      (SECURITY.md §2 says the state file is a code-exec vector; the
      injection up-stream from that exec is the corollary).
  (b) `appendSteering`'s sanitizer is the only place in the new code
      that strips C0/C1 — and it's NOT applied to the reason or to
      metadata read straight from the state file.
  (c) A repo that plants a state file with `command: "printf '\\x1b[2J'"`
      will, on the first idle, inject literal ESC into the agent's
      prompt after the first exec.

**Mitigation**: route `evaluation.reason` (and the `blockedText` from
`GOAL_BLOCKED:`) through the same C0/C1 stripper that `editCondition`
uses. Cap at 200 chars (already done) AND apply the stripper BEFORE
the slice. Document in SECURITY.md that the verification command's
stdout/stderr becomes part of the agent's prompt.

---

### 4. `lastSteer.note` injected verbatim into the compacting hook context
- src/server.ts:387–396 — `experimental.session.compacting` reads
  `state.metadata.steering` directly (no sanitization) and pushes
  `Latest user hint: ${lastSteer.note}` into the context that the
  host will hand to the model.
- src/server.ts:206–210 — same shape for the continue-prompt's
  `User hint (most recent): ${lastSteer.note}`.

**Why it matters**: a malicious handoff that lands via `claimHandoff`
brings its `metadata.steering` along, and the auto-loop uses it
unfiltered. The sidebar sanitizes for DISPLAY (sidebar-logic.ts:89),
but the auto-loop uses the raw value. A planted note can:
  - Inject ANSI escape codes that alter the agent's terminal (clear
    screen, move cursor, fake prompts).
  - Inject U+2028/U+2029 line separators that some renderers treat as
    newlines, breaking out of the "Latest user hint:" line into a
    fresh instruction.

**Mitigation**: the compacting hook and the continue-prompt should
sanitize `lastSteer.note` (and `state.condition`) the same way
`sanitizeForSidebar` does, before interpolation. Equivalently, a
single helper `sanitizeForPrompt(s)` in goal-state.ts that drops C0/C1
+ normalizes U+2028/2029 to a space.

---

## IMPORTANT

### 5. Read-modify-write race across all dial primitives + the auto-loop
- src/goal-state.ts:628–866 — every dial primitive (editMaxTurns,
  editMaxTime, editMaxTokens, editCondition, restartGoal, appendSteering,
  clearSteering) does `readGoalState → mutate → writeGoalStateAtomic`.
- src/goal-state.ts:539–572 — `transitionGoal` does the same.
- src/server.ts:151–233 — `evaluate` does its own read-modify-write on
  the SAME file (lines 162–168, 176–181, 188–200).

**Why it matters**: with no lock, two concurrent writers race. The
classic sequence:
  1. T1: `editMaxTurns` reads state with id=X, maxTurns=20.
  2. T2: `restartGoal` reads state with id=X, status=active.
  3. T1: writes `maxTurns=50` (still id=X).
  4. T2: writes `{id=Y (new UUID), status=active, maxTurns=20}` — but
     T1's mutation is lost.

A user pressing "edit turns" and "restart" quickly (or a TUI dials
hotkey firing while the auto-loop is mid-evaluation) loses one of the
two edits silently. The visible result is "I set maxTurns to 50 but it
stayed at 20".

**Mitigation**: an in-process mutex on the directory-keyed file, OR
file-locking (`proper-lockfile` style: stat+O_EXCL create a
`.goal-state.lock`, fail after a 100ms timeout). This is the same
shape of bug that the file-watcher logic is trying to paper over.

---

### 6. `createHandoff` does not use atomic write — partial-write on crash leaves a corrupt handoff
- src/goal-state.ts:928–933 — direct `writeFileSync(path, ...)`. No
  temp+rename. If the process dies mid-write, the handoff file is left
  in a half-written state. `readHandoff` does
  `readFileSync → JSON.parse → catch → return null`, so the claim
  fails closed (`no-handoff` reason). Good. BUT the file is still
  corrupt on disk, blocking a fresh `createHandoff` (which refuses
  with `handoff-exists` on line 920).

**Why it matters**: a single crash during a handoff write traps the
user. They have to manually `rm .opencode/.goal-handoff.json` to make
`/goal handoff` work again. The state-file path is atomic; the
handoff file is not. Asymmetric and surprising.

**Mitigation**: factor out a `writeHandoffAtomic` that mirrors
`writeGoalStateAtomic` (temp+rename). Cheap, one helper.

---

### 7. U+2028 LINE SEPARATOR and U+2029 PARAGRAPH SEPARATOR not stripped
- src/goal-state.ts:724–732 (`editCondition`) and src/goal-state.ts:835–842
  (`appendSteering`) only drop C0 (0x00–0x1F), C1 (0x80–0x9F), and
  0x7F. U+2028 and U+2029 are valid JSON characters that many
  downstream renderers (iTerm2, some web views, the LLM's own
  decoder) treat as line terminators.
- src/command.ts:263–266 / `parseCommand` / `parseConstraints` are
  regex-based on ASCII; the condition ultimately lands in the prompt
  via `fresh.condition` (server.ts:219, 393) and
  `state.condition` directly in the compacting hook.

**Why it matters**: a user (or a state file) can plant a condition
like `"step 1\u2028Step 2: rm -rf /"`. In some terminal+agent chains,
the U+2028 is treated as a real newline, so the prompt becomes two
distinct instructions and the second is no longer in the "GOAL: …"
frame. Same applies to the steering note in the compacting hook.

**Mitigation**: in the sanitization loops at goal-state.ts:725–731 and
goal-state.ts:836–841, also drop or space-replace code points
`0x2028` (LINE SEPARATOR) and `0x2029` (PARAGRAPH SEPARATOR). Equivalently,
add a third pass: `s.replace(/[\u2028\u2029]/g, " ")` after the C0/C1
strip.

---

### 8. `parsePositiveInt` does not detect overflow; over-large values silently round to maxTokens/maxTurns via Number conversion
- src/tui-dials-logic.ts:44–53, src/command.ts:249–257 — both
  implementations are the same. `Number("9".repeat(16))` = `9e15`
  (finite, ~9 quadrillion). `Math.trunc(9e15) = 9000000000000000`.
  The bounds check in `handleTokensSubmit` (line 93) catches it
  (`9e15 > 10_000_000`). So this is a NIT, not a real overflow vector.
- BUT: `Number("9".repeat(309))` = `Infinity` → `Number.isFinite` is
  false → returns null. Good.
- The real issue: the `EditResult` path returns
  `reason: "invalid-value", error: "maxTokens must be in [1, 10000000]."`,
  which is then displayed raw in a toast. Fine for the TUI; the agent
  sees it via `relayToUser` in the /goal path. NOT a security issue.

**Why it matters**: low. The bounds check catches everything. Noting
for completeness only — the test plan in scratch/attack-fence.mjs
implies overflow is on the reviewer's mind, but the code is correct.

---

### 9. The handoff file is a NEW trust boundary not documented in SECURITY.md
- src/goal-state.ts:894 — `HANDOFF_FILE = ".opencode/.goal-handoff.json"`.
- SECURITY.md:78 says "The plugin's only filesystem mutations are reads
  and writes to the state file at `.opencode/.goal-state.json`." — that
  is now false.

**Why it matters**: anyone reading SECURITY.md to make a
"should-I-trust-this-plugin-in-an-untrusted-repo" decision is acting
on stale information. The handoff file is the same risk class as the
state file (it gets claimed → its state becomes the active goal → its
metadata.steering is injected into the prompt), but is unmentioned.

**Mitigation**: add a §6 to SECURITY.md paralleling §2: "The handoff
file is also a trust boundary. A malicious `.opencode/.goal-handoff.json`
will, on `/goal claim` (or the sidebar's Claim dial), be promoted to
the active goal state and its steering notes will be injected into
the agent's prompt."

---

### 10. `createHandoff` note param is not length-capped and not sanitized
- src/goal-state.ts:925 — `note: note?.trim() || undefined`. Only
  trim. No control-char strip, no length cap.
- src/command.ts:225–227 (`/goal handoff <note>`) passes the raw
  payload through.
- src/tui.tsx:230 (sidebar dial) — `v.trim() || undefined`. Same
  shape.

**Why it matters**: a multi-MB handoff note blows up the handoff
file size (compounding with #1). A note containing ANSI escapes is
preserved verbatim into the file; if the agent later reads the file
via a tool, the escapes land in its terminal. Not the highest-impact,
but easy to fix.

**Mitigation**: cap note length (e.g. 500 chars, mirroring
MAX_STEERING_LEN) and run the same C0/C1 stripper the condition path
uses. Reject if empty after sanitization (mirror `appendSteering`).

---

### 11. `/goal steer` and the TUI steer dial accept a note with embedded ANSI/U+2028 with no warning
- src/command.ts:201–205, src/tui-dials-logic.ts:113–121 — the
  primitive (`appendSteering`) does sanitize, but a USER typing
  `"` style or pasting a multi-line block in the dialog might be
  surprised when the visible content is rewritten (newline → space,
  ANSI dropped). The dispatcher doesn't warn. The TUI handler shows
  a generic "Steering note added" toast (handleSteerSubmit → res.message).

**Why it matters**: low — this is a UX concern. The sanitization
prevents prompt-injection via the steering path. But the user has
no way to know their pasted text was rewritten. Noting for
completeness.

---

## NIT

### 12. `/goal steer '"'` — stripSurroundingQuotes leaves a single `"` that bypasses empty check
- src/command.ts:270–278 — `stripSurroundingQuotes('"')` returns `'`
  (single char). Then `appendSteering` receives `'"'`, runs through
  the C0/C1 loop (the `"` is 0x22, printable, preserved), trims, and
  accepts (length 1 > 0). The user expected their steer to be
  rejected (empty) but it becomes the literal character `"`.

**Why it matters**: low. The note IS now a single `"` and that's
mostly harmless (printed into the prompt as `User hint (most
recent): "`). But the behavior is surprising and
inconsistent — `/goal steer ''` (no chars at all) hits the
`!payload` check at command.ts:202, but `/goal steer '"'` slips
through.

**Mitigation**: in `appendSteering`'s reject-empty check, also reject
when `cleaned` is a single non-alphanumeric punctuation char. Or in
the dispatcher, check `stripSurroundingQuotes(payload).length === 0`
and reject as empty.

---

### 13. `dispatchGoalCommand` uses a different `stripSurroundingQuotes` than `goal-state.ts`'s `unwrapQuotes`
- src/command.ts:270–278 — stripSurroundingQuotes strips when the
  first AND last char are the same quote. Returns `s.slice(1, -1)`
  with NO `.trim()`.
- src/goal-state.ts:341–348 — `unwrapQuotes` requires EXACTLY two
  occurrences of the quote char (via `s.split(q).length - 1 === 2`).
  Returns `s.slice(1, -1).trim()`.
- The /goal path uses the dispatcher version; the
  `setGoalFields` path uses `unwrapQuotes`. They have different
  semantics. `/goal condition "  hello  "` (with internal whitespace
  around) gets the surrounding quotes stripped but no inner trim —
  so the condition starts and ends with a space, and `editCondition`'s
  "New condition is identical" check (line 741) will reject a
  no-op edit of a condition that the dispatcher wrote with trailing
  spaces. Confusing.

**Why it matters**: low. Cosmetic consistency issue, not a security
boundary. Noting because the divergence is silent and can produce
weird "I just set the condition to the same thing and it says
identical" failures.

---

### 14. `metadata.steering` is silently dropped on overflow — no warning to user
- src/goal-state.ts:852 — `if (next.length > MAX_STEERING_NOTES) next.splice(0, next.length - MAX_STEERING_NOTES)`. The user's oldest
  notes vanish without ceremony. The result message is
  `Steering note added (21 total).` — the user can't tell that the
  first one is gone.

**Why it matters**: low. UX issue. Not a security boundary, but a
"user appends 100 notes, 80 are silently dropped" surprise is on the
reviewer's checklist. A note that the user thought was retained
could be the one carrying important guidance; if they then
specifically referenced it, the agent would have no record.

**Mitigation**: surface in the result message when truncation
happens: "Steering note added (21 total; 1 oldest dropped)."

---

### 15. `restartGoal` carries forward attacker-plated `metadata` keys (same as #2 but with a different code path)
- src/goal-state.ts:799–803 — `metadata: { ...state.metadata, restartedAt, previousId }`. The `...state.metadata` is from
  `readGoalState(directory)` which read from disk, which was written
  by `claimHandoff` (or by an attacker planting the state file). Same
  data-flow as #2; not a separate vector but a separate code path
  that needs the same allowlist fix.

---

## NOTE

### 16. New primitives all funnel through `writeGoalStateAtomic` for the state file — confirmed
- src/goal-state.ts:644 (`editMaxTurns`), 668 (`editMaxTime`),
  692 (`editMaxTokens`), 748 (`editCondition`), 807 (`restartGoal`),
  856 (`appendSteering`), 877 (`clearSteering`), 984 (`claimHandoff`).
  No primitive does its own `writeFileSync` to the state file.
  `createHandoff` is the lone exception — it writes the HANDOFF
  file, not the state file, and uses `writeFileSync` directly (see
  finding #6). The auto-loop also uses `writeGoalStateAtomic` (e.g.
  server.ts:168, 181, 195, 200). No new write path bypasses
  atomicity. Good.

---

### 17. No new shell-exec vector — confirmed
- The new primitives do not call `exec`/`execAsync`/`spawn` directly.
  The only exec surface remains the pre-existing one:
  `evaluateDeterministic` runs `state.command` (server.ts:97). The
  v0.2.0 surface did not introduce a new code path to exec.
  The state file's `command` field is the (already-documented)
  trust boundary, and the validator (goal-state.ts:203) still
  enforces `command: string | null | undefined`.
- The handoff validator also goes through `validateGoalState`, so
  a planted handoff's `command` field is type-checked the same way.
  No regression here.

---

## Summary by threat class (from the task brief)

| # | Threat in brief | Verdict | Finding(s) |
|---|---|---|---|
| 1 | New shell exec | NONE — no new exec paths | #17 |
| 2 | Path traversal in handoff | LOW — `join()` is safe, `directory` is host-supplied not user-supplied | (not flagged) |
| 3 | State file integrity | MOSTLY OK — all primitives use `writeGoalStateAtomic` | #6, #16 |
| 4 | Race conditions | REAL — every primitive is read-modify-write unlocked | #5 |
| 5 | Handoff file as new attack surface | REAL — 4 issues stacked | #1, #2, #3, #4, #6, #9, #10 |
| 6 | Steering note prompt-injection | REAL — auto-loop and compacting hook inject unsanitized `lastSteer.note` | #4 |
| 7 | Compacting hook | SAME AS #6 | #4 |
| 8 | stripSurroundingQuotes edge | LOW — single `"` slips through | #12 |
| 9 | TUI dialog input bypass | NONE — DialogPrompt hands a string; we sanitize in primitives | (not flagged) |
| 10 | Secrets in state file | LOW — no detection, no warning | (out of scope, see note) |
| 11 | Handoff size cap | REAL — `readHandoff` reads whole file, validator doesn't cap `metadata.steering` | #1, #2 |
| 12 | Write-failed handling bypass | NONE — all primitives handle write errors | #16 |
| 13 | Mismatched quotes in dispatcher | LOW — single char slips through | #12, #13 |
| 14 | handoffPath directory arg validation | LOW — host-supplied, not user-supplied | (not flagged) |
| 15 | Append steering silent drop | UX NIT | #14 |
| 16 | Resumed-state metadata allowlist | REAL — see #2 | #2, #15 |
| 17 | U+2028/U+2029 not stripped | REAL — note #7 | #7 |
| 18 | `evaluation.reason` ANSI injection | REAL | #3 |
| 19 | parsePositiveInt overflow | NONE — bounds check catches | #8 |
| 20 | claimHandoff race | REAL — see #5 | #5 |

**Top 4 fixes to ship before tag**:
- #1 cap handoff file read size + tighten validator
- #2 allowlist metadata keys in `readHandoff` / `claimHandoff`
- #3 sanitize `evaluation.reason` and `blockedText` before prompt
  interpolation
- #4 sanitize `lastSteer.note` in the auto-loop's continue-prompt
  AND the compacting hook
