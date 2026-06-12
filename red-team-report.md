# Red-Team Audit Report — v0.4.0 Code Paths

**Auditor:** verifier (worker session `mvs_ccf379d1183d4803ae33b3dcf2f352c8`)
**Date:** 2026-06-12
**Skill:** `.mavis/skills/typescript-red-team-audit/SKILL.md`
**Scope:** v0.4.0 surfaces — `src/goal-chain.ts`, `src/server.ts` (evaluateGoal + fireWebhook),
`src/goal-state.ts` (sanitizeMetadata, validateGoalState, claimHandoff), `src/templates.ts`,
`src/command.ts` (chain + template dispatch), `src/cli.ts` (chain + template CLI), all new test files.

## Methodology

Three-pass scan-then-trace per the project red-team skill:

- **Pass 1 — SCAN** (rg commands, 2 turns max)
- **Pass 2 — TRACE** (3 high-risk areas, read-once + trace-one-path)
- **Pass 3 — VERDICT** (honest report, no "one more check")

---

## Pass 1 — Scan Findings

### 1.1 Unsafe casts (`rg -n ' as any| as unknown as |@ts-ignore|@ts-expect-error' src/ -g '*.ts'`)

```
src/server.ts:139   const msgs = (res.data ?? []) as any[];
src/server.ts:814   const part = { type: "text", text } as unknown as (typeof output.parts)[number];
```

- **Line 139**: Cast on SDK response shape; followed by `.filter().at(-1)` and `.map()`. Read-only,
  no risk of unsoundness. The SDK's `messages` response type is a discriminated union that the
  comment in server.ts:139 omits for brevity. **Acceptable.**
- **Line 814**: Deliberate cast for the `command.execute.before` hook contract — the host treats
  the hook as a content-rewrite and the part type is structurally a text part. The code is
  appending to `output.parts` and the comment explains the cast. **Acceptable (intentional).**

**Net: clean.** No new unsafe casts were introduced by v0.4.0.

### 1.2 Test dishonesty (`rg -n 'it\.skip|describe\.skip|\.only\(|TODO|FIXME' test/ -g '*.mjs'`)

```
test/tui-logic.test.mjs:357   "tui.tsx should NOT import resolveSessionDirectory; that's the multi-workspace TODO",
```

- **Line 357**: This is a `describe` test NAME that mentions a TODO, not a skipped test. The
  surrounding code is an active test. **False positive — clean.**

**Net: clean.** No skipped tests, no `.only()`, no live TODOs.

### 1.3 Dead patterns

The `let \w+ = .*\n.*\1\+\+` regex wasn't compilable in the project rg (no backreferences), so
this was checked by visual scan. No dead counters or self-incrementing patterns observed in
the v0.4.0 surfaces.

**Net: clean.**

### 1.4 Shell / command execution

```
src/server.ts:20   import { exec } from "node:child_process";
```

Only one shell-exec site: `evaluateDeterministic` (server.ts:101-134). Called from:
- `evaluateGoal` dispatcher (server.ts:166) — `case "shell": return evaluateDeterministic(v.command);`
- `evaluateGoal` fallback (server.ts:162) — `if (state.command) return evaluateDeterministic(state.command);`

Both paths are bounded by the `commandTimeoutMs: 30_000` (server.ts:55) and `maxBuffer: 1024*1024`
(server.ts:115). **No new shell-exec surfaces introduced by v0.4.0; the existing guard is sound.**

### 1.5 File I/O with user-controlled paths

`rg -n 'readFileSync' src/ -g '*.ts'` returned 11 call sites. Categorized:

| File | Line | Bounded by |
|------|------|------------|
| goal-state.ts | 504, 517 | `MAX_STATE_SIZE` (256KB) via `statSync` before read |
| goal-state.ts | 1300 | `MAX_HANDOFF_SIZE` (256KB) via `statSync` before read |
| goal-chain.ts | 69 | `MAX_CHAIN_SIZE` (256KB) via `statSync` before read |
| templates.ts | 124, 146 | `discoverTemplates`/`exportTemplate` for `.opencode/goals/*.json` — user dir, but the file names are filtered by the `/^[A-Za-z0-9_-]+$/` slug regex. **No size cap at this site, but the files are user-managed in their own `.opencode/` and the read paths either fail validation (discover skips invalid) or fall through to a user-controlled test case.** Acceptable. |
| **command.ts** | **49** | `userTemplateSeed` — for `--template foo` and `/goal template foo`, reads `.opencode/goals/foo.json` after the slug regex. Same accept-as-user-managed pattern. |
| **command.ts** | **450** | **`chain start <path-to-chain.json>` — `readFileSync` of a user-supplied path with NO size cap. → B1 below** |
| server.ts | 218 | `evaluateFile` — verified path via `relative` + `isAbsolute` guard (Phase 2 fix). The `contains` regex is bounded by file read; size cap NOT applied here, but the verification is HTTP/CLI-discoverable and trusted-source. **Acceptable for verification but could be hardened.** |
| **cli.ts** | **381** | **`template import -` (stdin) — `readFileSync(process.stdin.fd)` with NO size cap. → B3 below** |
| **cli.ts** | **405** | **`template import <path>` — `readFileSync(path)` with NO size cap. → B2 below** |
| gui.ts | 82, 191 | GUI file watcher — well-scoped, no user path input. |
| templates.ts | 124, 146 | listed above. |

**Three size-cap gaps found.** Each is a real DoS vector: a multi-MB file is fully read into memory
and then rejected downstream by the per-step condition cap or the importTemplate cap. A
well-formed 1MB+ file with `condition` ≤ 4000 chars or `MAX_TEMPLATE_IMPORT_SIZE` ≤ 256KB would
burn heap + CPU just to be rejected.

### 1.6 Atomic writes & rename

`rg -n 'renameSync' src/ -g '*.ts'` returned 4 call sites, all the same pattern:
`writeFileSync(tmp, ...) → renameSync(tmp, p) → unlinkSync(tmp) on failure`. Pattern is sound.
No defects.

---

## Pass 2 — Trace (3 High-Risk Areas)

### Trace 1 — File I/O with user paths (commands.ts chain start, cli.ts template import path/stdin)

This was the highest-risk area identified in Pass 1. I traced ONE path per read site.

**Path 1a: `/goal chain start <file.json>` via `dispatchGoalCommandStructured` (command.ts:445-461)**

Pre-fix sequence:
1. `resolve(directory, subPayload)` — absolute paths from the user land as-is. The user can
   point at any file on the filesystem.
2. `readFileSync(chainPath, "utf-8")` — **unbounded**.
3. `JSON.parse(raw) as GoalChainStep[]` — CPU and memory pressure proportional to file size.
4. `createGoalChain(directory, steps)` — validates steps, but the per-step condition cap
   (4000 chars) and the MAX_CHAIN_STEPS (50) cap fire only AFTER the parse.

**Repro (50MB chain file, valid shape, absurd condition):**
```
File size: 52428818
Took ms: 77
Heap delta: 99.98 MB
Result: { kind: "invalid-value", message: "Step 1 condition must be 4000 chars or fewer." }
```

A 50MB file allocates ~100MB heap (string copy), parses, and is rejected post-parse. A user
with shell access (which they have to invoke `/goal` anyway) can target the `readFileSync`
allocation specifically by piping a 1GB file with an early-parseable shape.

**Verdict: B1 (real defect).** Fix at the read boundary with a `statSync` size check,
mirroring the existing `readGoalChain` / `readGoalState` / `readHandoff` patterns. Cap = 256KB.

**Path 1b: `opencode-autogoal template import <file.json>` via CLI (cli.ts:400-405)**

Pre-fix sequence:
1. `resolve(directory, arg)` — same as 1a.
2. `existsSync(path)` — fine.
3. `readFileSync(path, "utf-8")` — **unbounded**.
4. `dispatchGoalCommandStructured` is called with `template import <name> <content>` — the
   dispatcher forwards to `importTemplate` which DOES check `content.length > 256*1024` (the
   primitive's own cap, see templates.ts:175). But this check fires AFTER the CLI's full
   read.

**Repro (50MB template file):**
```
File size: 52428816
Took ms: 132
Status: 1
Stdout: Template file too large (max 256KB).
```

132ms and 50MB allocated before the primitive's cap fires. A user with CLI access can
target the read.

**Verdict: B2 (real defect).** Fix at the read boundary with a `statSync` check. Cap = 256KB
(reused via the new `MAX_TEMPLATE_IMPORT_SIZE` export from templates.ts).

**Path 1c: `opencode-autogoal template import -` via CLI (cli.ts:373-403)**

Pre-fix sequence:
1. `isTTY` guard (cli.ts:378) — sound.
2. `readFileSync(process.stdin.fd, "utf-8")` — **unbounded**.
3. The same dispatcher / `importTemplate` chain as 1b.

I initially tried to use `fstatSync` on `process.stdin.fd` for a pre-read size check.
**This doesn't work** — `fstatSync` on a pipe always reports `size: 0` (verified by
spawning a child and inspecting the fstat output for a 1MB and a 50MB piped payload;
both reported size 0). The portable cross-platform approach is **chunked read + abort**:
read up to 64KB at a time, accumulate the byte count, abort if the running total exceeds
the cap. The existing buffer chunks can be GC'd as we go; the peak heap is bounded by the
cap, not the input.

**Repro (50MB stdin):**
```
Stdin size: 52428830
Took ms: 192
Status: 1
Stdout: 
Stderr: opencode-autogoal: stdin template must include a top-level string 'name' field.
```

192ms and 50MB string allocated before any check. (The `name` field error came from the
JSON-parse step in the dispatcher because the test fixture was missing the `name` field;
the underlying size issue is the same — the read happened in full.)

**Verdict: B3 (real defect).** Fix with chunked read + cap. Use `readSync` with the existing
stdin fd (works on Windows where `/dev/fd/N` is absent) or `openSync('/dev/fd/N', 'r')`
where available. Both paths converge in the same loop.

### Trace 2 — Shell / command execution (server.ts evaluateDeterministic, evaluateHttp)

**evaluateDeterministic (server.ts:101-134):** Single exec call, bounded by
`commandTimeoutMs: 30_000` (server.ts:55) and `maxBuffer: 1024 * 1024` (server.ts:115).
The `command` comes from `state.command` or `v.command` (verification), which is
user-supplied via the `set_goal` tool or `/goal set "..." --command "..."`. The
`directory` is the OpenCode CWD, which is the user's project — the user has shell
access to the same CWD, so this is not a privilege boundary being crossed.

**Adversarial probe: arbitrary command execution.** A user with `set_goal` access can
already run arbitrary shell commands via `command: "rm -rf /"`. The auto-loop's
`evaluateDeterministic` runs the same command, but the user can also run it themselves.
**Not a privilege boundary being crossed** — the verification command is the user's
own command, run on their own machine, against their own state. **Clean.**

**evaluateHttp (server.ts:173-192):** Hits a user-supplied URL via `fetch`. No SSRF
guard (no `isLocalUrl` / `allowLocal` check) — a user can probe `http://127.0.0.1:8080`.

**Adversarial probe: SSRF.** A user who can call `set_goal` with
`verification: { type: "http", url: "http://localhost:3000" }` can probe internal
services. This is intentional per the v0.4.0 spec (`specs/v0.4.0-roadmap.md:278-281`):

```
--verify http:http://localhost:3000?expect=201
```

The spec **explicitly uses localhost URLs as the example for HTTP verification**.
Unlike webhooks (where the user opts into "send to external service" and `isLocalUrl`
blocks by default unless `allowLocal: true`), verification is the user explicitly
pointing at their own dev infrastructure. The same user can `curl http://localhost:3000`
themselves. **Not a privilege boundary being crossed.**

**Verdict: clean.** Both shell exec and HTTP verification are user-controlled actions on
the user's own machine; the existing timeouts and SSRF exemption for verification are
intentional per the spec. No fix.

### Trace 3 — Race conditions (atomic writes, handoff single-shot)

**createGoalChain writes 2 files (goal-chain.ts:189-199):**

1. `writeGoalChainAtomic(directory, chain)` — temp + rename, atomic.
2. `writeGoalStateAtomic(directory, state)` — temp + rename, atomic.

If step 1 succeeds and step 2 fails (e.g. disk full), the chain file is persisted but
the state file is missing. The next `advanceGoalChain` would fail with
`"Chain interrupted — goal was manually overridden"`. The user can recover by running
`chain reset` (which writes a fresh state with `metadata.chainId = chain.id`).

**Adversarial probe: partial-write recovery.** A crash or disk-full between the two
writes leaves an orphan chain. This is recoverable (via `chain reset`), not corrupting.
**Not a defect — acceptable degraded mode.**

**claimHandoff read-then-delete (goal-state.ts:1316-1383):**

Sequence: `readHandoff` → `writeGoalStateAtomic` → `unlinkSync(handoffPath)`. Two
processes can both reach the `readHandoff` step before either `unlinkSync` lands.
Both write the same goal state (identical payload), both attempt `unlinkSync` (one
succeeds, the other gets ENOENT which is swallowed). **The state file ends up
identical; the second process's "Handoff claimed" message is a benign log-only
double-report.** Not a defect.

**Handoff-claim vs concurrent chain create (race across primitives):**
`createHandoff` checks `existsSync(handoffPath)` then writes atomically. If
`createHandoff` and `claimHandoff` race, `existsSync` is not atomic with the
write — a TOCTOU window exists. The mitigation is the `writeHandoffAtomic` pattern
which would only corrupt the write if the same temp filename collides (mitigated
by `${path}.tmp.${process.pid}.${Date.now()}`).

**Adversarial probe: concurrent createHandoff + claimHandoff.** Two distinct
processes can race. Worst case: one chain-write fails because the file already
exists from a previous createHandoff that just finished, returning
`{ ok: false, reason: "handoff-exists" }`. The state file is unaffected. **Not a
defect — the user can retry the claim.**

**Verdict: clean.** No data corruption. Acceptable degraded modes.

---

## Pass 2 — Bugs Found and Fixed

### Bug B1 — `chain start` size cap missing

**Description:** `/goal chain start <path>` reads a user-supplied JSON file via
`readFileSync` with no size cap. A multi-MB file is fully read into memory and
parsed before being rejected downstream by the per-step condition cap (4000
chars) or MAX_CHAIN_STEPS (50). Heap allocation is proportional to file size.

**Evidence:**
- File: `src/command.ts:445-461` (pre-fix)
- Repro: 50MB chain file → 100MB heap delta, 77ms CPU, only then rejected.

**Root cause:** The read boundary (in `dispatchGoalCommandStructured`) doesn't
mirror the `statSync`-then-`readFileSync` pattern that `readGoalState` /
`readGoalChain` / `readHandoff` already use.

**Fix:** Added a `statSync` size check before `readFileSync`, with a cleaner
`existsSync` guard for the not-found case. Cap is `MAX_CHAIN_SIZE` (256KB),
matching the existing cap used by `readGoalChain`. Also exported the constant
from `goal-chain.ts` for the CLI to reuse.

**Files modified:**
- `src/command.ts` (imports `statSync` + `MAX_CHAIN_SIZE`; adds size cap)
- `src/goal-chain.ts` (no change — `MAX_CHAIN_SIZE` was already exported)

**Regression test:** `test/cli-e2e.test.mjs` — `"chain e2e: 'chain start' oversized
file (>256KB) is rejected with size error, no allocation"`. Test creates a 300KB
JSON file, asserts the size error fires BEFORE the per-step condition cap
(different error message) and that no state file is created. Pre-fix: would
fail on `assert.match` because the per-step cap fires first. Post-fix: passes.

**Post-fix repro:**
```
File size: 52428818
Took ms: 1
Heap delta: 0.027 MB
Result: { kind: "invalid-value", message: "Chain file too large (52428818 bytes; max 262144 bytes / 256KB)." }
```

Also updated existing test `"chain start' with non-existent path → exit 1"` to
match the new explicit `existsSync` guard's error message
(`"Chain file not found"` instead of the old catch-all `"Failed to read chain
file: ENOENT..."`).

### Bug B2 — `template import <path>` size cap missing in CLI

**Description:** `opencode-autogoal template import <file.json>` reads a
user-supplied template file via `readFileSync` with no size cap. A multi-MB
file is fully read into memory before being rejected downstream by
`importTemplate`'s 256KB cap.

**Evidence:**
- File: `src/cli.ts:400-405` (pre-fix)
- Repro: 50MB template file → 132ms CPU, 50MB allocation, only then rejected.

**Root cause:** Same as B1 — the CLI's read boundary doesn't pre-check size.

**Fix:** Added a `statSync` size check before `readFileSync`. Cap is
`MAX_TEMPLATE_IMPORT_SIZE` (newly exported from `templates.ts`, value = 256KB,
matching the existing primitive cap).

**Files modified:**
- `src/cli.ts` (imports `statSync` + `MAX_TEMPLATE_IMPORT_SIZE`; adds size cap)
- `src/templates.ts` (adds and exports `MAX_TEMPLATE_IMPORT_SIZE`; uses it in `importTemplate`)

**Regression test:** `test/template.test.mjs` — `"oversized template file
(300KB) → exit 1, size error (no allocation)"`. Test creates a 300KB JSON
template file, asserts the CLI's size error fires (different message from the
primitive's) and that no goal file is created. Pre-fix: would fail because
the primitive's `"Template file too large"` message comes from `dispatcher →
importTemplate`, not from the CLI. Post-fix: passes.

**Post-fix repro:**
```
File size: 52428816
Took ms: 45
Status: 1
Stdout: 
Stderr: opencode-autogoal: template file too large (52428816 bytes; max 262144 bytes / 256KB).
```

### Bug B3 — `template import -` (stdin) size cap missing in CLI

**Description:** `opencode-autogoal template import -` reads stdin via
`readFileSync(process.stdin.fd, "utf-8")` with no size cap. A multi-MB
stdin payload is fully read into memory before being rejected downstream by
`importTemplate`'s 256KB cap.

**Evidence:**
- File: `src/cli.ts:373-403` (pre-fix)
- Repro: 50MB stdin → 192ms CPU, 50MB string allocation, only then rejected.

**Root cause:** Same as B1 / B2 — the CLI's read boundary doesn't pre-check size.
Unlike B2, `statSync` / `fstatSync` on a pipe is **unreliable for size**
(`fstatSync` on a pipe returns `size: 0` regardless of payload — verified on
Windows with a 1MB and 50MB piped payload, both reported 0). The only
portable fix is a chunked read with a running byte-count cap.

**Fix:** Replaced the single `readFileSync` with a `readSync` loop (64KB
chunks), tracking the running total. If the total exceeds
`MAX_TEMPLATE_IMPORT_SIZE`, abort and return exit 1. The existing `chunks`
array is GC'd as we go; the peak heap is bounded by the cap, not the input.
The chunks are concatenated to a string only AFTER the cap check passes.

**Files modified:**
- `src/cli.ts` (added `openSync` + `readSync` + `closeSync` imports; replaced
  the stdin read with a chunked read; added `MAX_TEMPLATE_IMPORT_SIZE` import)

**Regression test:** `test/template.test.mjs` — `"oversized stdin payload
(300KB) → exit 1, size error (no allocation)"`. Test fakes `process.stdin.fd`
to point at a 300KB file and asserts the CLI's `"stdin template too large"`
error fires (different message from the primitive's
`"Template file too large"`) and that no goal file is created. Pre-fix: would
fail because the primitive's error message reaches the user, not the CLI's.
Post-fix: passes.

**Post-fix repro:**
```
Stdin size: 52428830
Took ms: 127
Status: 1
Stdout: 
Stderr: opencode-autogoal: stdin template too large (>262144 bytes / 256KB).
```

The 127ms is the OS pipe read (50MB through the pipe); the cap fires at the
64KB-chunk boundary and the remaining 49MB+ is never read. Peak heap is the
accumulated `stdinChunks` Buffer array, which is bounded by `chunkSize * ceil(MAX/64KB)`
≈ 64KB × 5 = 320KB.

### Areas Checked + Confirmed Clean

- `evaluateDeterministic` (server.ts:101-134) — bounded by timeout + maxBuffer; not a privilege boundary.
- `evaluateHttp` (server.ts:173-192) — no SSRF guard, but spec explicitly allows localhost (verification IS the user pointing at their own dev infra). Intentional, not a defect.
- `evaluateFile` (server.ts:194-227) — path-traversal guard with `isAbsolute` (Phase 2 fix); confirmed intact.
- `fireWebhook` (server.ts:244-269) — sanitizes all user-controlled fields; only fires when `wh.on.includes(state.status)`. Sound.
- `isLocalUrl` (server.ts:286-300) — covers `localhost`, `0.0.0.0`, `[::1]`, and `127.0.0.0/8`. Sound.
- `sanitizeMetadata` (goal-state.ts:1047-1073) — allowlist-based; preserves only the documented v0.4.0 fields. Sound.
- `validateGoalState` (goal-state.ts:204-262) — deep validation; rejects empty constraints, missing fields, out-of-range bounds. Sound.
- `claimHandoff` (goal-state.ts:1316-1383) — sanitizes all user-controlled fields; the read-then-delete race is benign (state file ends up identical; second unlinkSync is a no-op).
- `validateGoalChain` (goal-chain.ts:101-122) — shape + range checks; sound.
- `createGoalChain` (goal-chain.ts:134-206) — write-order is chain-then-state; partial-write recovery is `chain reset`. Acceptable degraded mode.
- `validateTemplate` (templates.ts:76-101) — enforces declared-vars-used + no-undefined-vars-in-condition (Phase 4 fix); sound.
- `importTemplate` (templates.ts:167-202) — size cap (now using the exported constant); sound.
- `exportTemplate` / `discoverTemplates` (templates.ts:107-151) — slug regex prevents path traversal; sound.
- All `writeGoalStateAtomic` / `writeGoalChainAtomic` / `writeHandoffAtomic` — temp+rename pattern with `process.pid + Date.now()` to avoid temp-name collisions. Sound.
- All test files — no `.only`, no `.skip`, no live `TODO`/`FIXME`.

### Remaining Risk (after this audit)

- **`evaluateFile` (server.ts:194-227) has no size cap on the read content.** A
  user can set `verification: { type: "file", path: "./x.txt", contains: "." }`
  against a 1GB file in the project CWD, and the verification will read the
  whole file. This is the user's own file in their own CWD, so not a
  privilege boundary, but it could be hardened with the same `statSync`
  pre-check (cap = 1MB or so). Not a defect per the user's own trust
  boundary, but worth flagging for a future hardening pass.
- **The chain's `createGoalChain` partial-write window (chain-then-state)
  has no rollback.** If the chain write succeeds but the state write fails,
  the user is left with an orphan chain and a clear error message, but no
  automatic recovery. A future hardening could write state first, then chain
  (and if the chain write fails, delete the state). The current order
  (chain first) is preferred because it preserves the chain-on-disk for
  recovery; reversing it would lose the chain on a disk-full between writes.
  Not a defect.
- **Webhook `isLocalUrl` doesn't cover `169.254.x` link-local.** A webhook
  with `allowLocal: false` can still hit AWS-instance metadata service at
  `169.254.169.254`. The spec deliberately does NOT block private networks
  or link-local (CI runners live there), so this is a documented design
  choice (server.ts:271-286 comment). Not a defect.

---

## Regression Tests Added

| Test file | Test name | Bug |
|---|---|---|
| `test/cli-e2e.test.mjs` | `"chain e2e: 'chain start' oversized file (>256KB) is rejected with size error, no allocation"` | B1 |
| `test/template.test.mjs` | `"oversized stdin payload (300KB) → exit 1, size error (no allocation)"` | B3 |
| `test/template.test.mjs` | `"oversized template file (300KB) → exit 1, size error (no allocation)"` | B2 |

**Test file modified:** `test/cli-e2e.test.mjs` — updated existing
`"chain e2e: 'chain start' with non-existent path → exit 1 (invalid-value)"`
to match the new explicit `existsSync` guard's error message (the previous
test asserted the catch-all `"Failed to read chain file: ENOENT..."` which
is now replaced by a clean `"Chain file not found"`).

---

## Final Test Output

`npm test` (last 5 lines):
```
# tests 718
# suites 51
# pass 718
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 11079.6962
```

Baseline 715 (per prior tracks' board entries) → 718 after this audit
(+3 new regression tests; 0 modifications that removed tests; 1 test
modified to match a new error message).

`npx tsc -p tsconfig.json` output (last 3 lines, should be empty):
```
[empty — 0 errors]
```

`npx tsc -p tsconfig.build.json` output (last 3 lines, should be empty):
```
[empty — 0 errors]
```

---

## Verdict

**3 bugs fixed** (B1, B2, B3 — all in the "file I/O with user paths" area;
all DoS via heap allocation at the read boundary; all fixable with the same
`statSync`/chunked-read pattern).

**Areas clean** (10 areas): evaluateDeterministic, evaluateHttp (intentional
SSRF exemption per spec), evaluateFile, fireWebhook, isLocalUrl,
sanitizeMetadata, validateGoalState, claimHandoff, validateGoalChain,
createGoalChain (partial-write degraded mode is acceptable), validateTemplate,
importTemplate, exportTemplate, discoverTemplates, all atomic writes, all
test files.

**Remaining risk:** `evaluateFile` read-content size cap (not a privilege
boundary, but worth a future hardening pass). Documented in the
"Remaining Risk" section above.

**No further checks performed after this verdict** (per the skill's stop
condition: "do not say 'let me check one more thing' after Pass 3").
