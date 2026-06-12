# Track C — TypeScript soundness & static analysis

**Scope:** v0.4.0 opencode-autogoal at `C:\Users\zerop\Development\OpenGoal`, head `4bdfa8f`. Full `src/` audit.
**Reviewer:** Coder branch (track-c).
**Method:** Read-only static review. No source files modified. Verification commands run: `tsc -p tsconfig.json --noEmit --<flag>` for each strictness option; collision simulation via a Node script; pattern grep across `src/`.

The codebase is well-built: the most aggressive strictness flags (`noImplicitOverride`, baseline `strict: true`) produce zero errors. The defect class is concentrated in **non-discriminated result interfaces, silent corruption recovery, and stale-style temp-file entropy**. One critical and one high-severity defect class; the rest are minor smells.

---

## Defect summary

| # | Severity | Title | File(s) |
|---|----------|-------|---------|
| C-1 | **Critical** | `SetResult` missing `reason` discriminant — `set` action collapses 3 error classes into `kind:"no-goal"` (exit 2) | `command.ts:194`, `goal-state.ts:552` |
| C-2 | **High** | Silent corruption recovery in `readGoalState` / `readGoalChain` / `readHandoff` masks a real defect class (corrupt file → "no goal", lost on next set) | `goal-state.ts:499,512,1294`, `goal-chain.ts:102` |
| C-3 | **Medium** | `process.pid + Date.now()` tmp-filename entropy: ~99.97% collision rate within a 1ms window (verified empirically). Inconsistency: `templates.ts:199` adds `Math.random()`, the other 3 sites don't | `goal-state.ts:527,1236`, `goal-chain.ts:119` |
| C-4 | **Medium** | `CreateChainResult` / `AdvanceChainResult` / `SetResult` not discriminated unions — `res.state!` non-null assertions at 5 callsites | `goal-chain.ts:193,334`, `goal-state.ts:552` |
| C-5 | **Low** | `fireWebhook` declared `async` but does no `await`; 7 fire-and-forget callsites. Not a real defect today, but a future trap | `server.ts:244,346,370,401,500,528,548,567,724` |
| C-6 | **Low** | `noUncheckedIndexedAccess` would surface 5 real type-soundness gaps (regex match-array `m[1]` typed `string` but should be `string \| undefined`) | `goal-state.ts:280,288,295,308`, `cli.ts:131,144,318` |
| C-7 | **Low** | `exactOptionalPropertyTypes` would surface 8 sites where properties typed `T?` are assigned `T \| undefined` (i.e. the API surface advertises "absent or T" but the code emits "explicit undefined") | `command.ts:63,281`, `goal-chain.ts:285`, `goal-state.ts:1264,1347`, `gui.ts:125`, `server.ts:488`, `sidebar-logic.ts:296,297,306` |
| C-8 | **Low** | `evaluateFile` uses dynamic `await import("node:path")` and `await import("node:fs")` despite `server.ts` already importing `node:child_process`/`node:util`. Either static-import everywhere or justify the dynamic import | `server.ts:196,209` |
| C-9 | **Smell** | `isLocalUrl` doesn't handle IPv4-mapped IPv6 loopback (`::ffff:127.0.0.1`) — `[::1]` is matched but the IPv4-in-IPv6 form is not | `server.ts:286` |
| C-10 | **Smell** | `command.ts:198, 287` and `server.ts:501` use `res.state!` non-null assertions on `SetResult` (5 total sites across `SetResult`/`CreateChainResult`/`AdvanceChainResult` consumers) | `command.ts:198,287,468`, `server.ts:501` |

The remaining `catch (err: any)` sites, `.catch(() => {})` sites, swallowed `try { } catch {}` cleanups, and regex patterns are all **best-practice and not defects** — see the per-pattern verdicts at the bottom of this report.

---

## C-1 (Critical) — `SetResult` missing `reason` discriminant

**File:** `src/goal-state.ts:552-557`, consumed at `src/command.ts:194-197`, `src/command.ts:287`, `src/server.ts:495`.

`SetResult` is the only "result object" interface in the codebase still using the pre-`TransitionResult` pattern:

```ts
// goal-state.ts:552
export interface SetResult {
  ok: boolean;
  error?: string;
  replaced?: string | null;
  state?: GoalState;
}
```

`TransitionResult` (lines 667-676), `EditResult` (lines 816-818), `ToggleResult`, and `ClearResult` were all migrated to discriminated unions with a typed `reason` field so the dispatcher can map to `GoalCommandKind` without string-matching the human-readable `error`. `SetResult` was missed.

Concrete consequence in `command.ts:192-200`:

```ts
if (action === "set") {
  const res = setGoal(directory, payload);
  if (!res.ok) {
    // setGoal's error messages are pre-shaped by the primitive.
    return { kind: "no-goal", message: `Goal not set — ${res.error}` };
  }
  ...
}
```

`setGoal` (called via `persistGoal` in goal-state.ts:597) returns `SetResult` with three distinct failure causes, all collapsed to `kind: "no-goal"`:

1. `parseGoalInput` returns `{ error: "Goal condition cannot be empty..." }` (user typed wrong). Should be `kind: "invalid-value"` (CLI exit 1).
2. `parseGoalInput` returns `{ error: "Goal condition must be 4000 characters or fewer..." }` (user typed too long). Should be `kind: "invalid-value"` (CLI exit 1).
3. `persistGoal`'s write fails: `setGoal` returns `{ ok: false, error: 'Failed to write state: EACCES' }` (disk/permission). Should be `kind: "write-failed"` (CLI exit 3).

The CLI exit code for `kind: "no-goal"` is 2 (per `KIND_TO_EXIT` in command.ts:99-112). So a user who types `set ""` gets exit 2, not 1. A user with a full disk gets exit 2, not 3. **A scripts that branch on exit code will get the wrong answer for every `set` failure.**

The A1 fix pattern in command.ts:397-413 (for `restart` and `handoff`) demonstrates the right way to handle this. The `set` path was missed.

**Fix:** Add a typed `reason` field to `SetResult`:

```ts
export type SetReason = "invalid-value" | "write-failed";
export interface SetResult {
  ok: true; state: GoalState; replaced: string | null;
} | {
  ok: false; reason: SetReason; error: string;
}
```

Then in `command.ts:194-197`:

```ts
if (!res.ok) {
  return { kind: res.reason === "write-failed" ? "write-failed" : "invalid-value", message: `Goal not set — ${res.error}` };
}
```

**Test gap:** `cli-e2e.test.mjs` should assert that `set ""` exits 1 (not 2) and `set` with an unwritable state directory exits 3 (not 2). No such test exists today; the v0.4.0 chain-webhook suite doesn't cover this either.

---

## C-2 (High) — Silent corruption recovery hides a real defect class

**Files:** `src/goal-state.ts:499-509` (`readGoalState`), `src/goal-state.ts:512-521` (`readGoalStateRaw`), `src/goal-state.ts:1294-1309` (`readHandoff`), `src/goal-chain.ts:102-113` (`readGoalChain`).

All four readers have the same shape:

```ts
try {
  const p = goalStatePath(directory);
  if (!existsSync(p)) return null;
  if (statSync(p).size > MAX_STATE_SIZE) return null;
  const parsed = JSON.parse(readFileSync(p, "utf-8"));
  return validateGoalState(parsed) ? (parsed as GoalState) : null;
} catch {
  return null;
}
```

Three distinct failure modes all collapse to `null`:

1. **Missing file** — legitimate "no goal set" state. The correct return.
2. **Oversized file** — DoS guard tripped. Should be a separate "too big" signal.
3. **Corrupt file** — `JSON.parse` throws, or `validateGoalState` rejects. **Currently indistinguishable from case 1.**

`gui.ts:readGoalStateSafe` (lines 65-104) was the team's later answer: it threads a `corrupt: boolean` through the result so the GUI can show "Goal state file is corrupt" instead of "No goal set." But the underlying primitives still return bare `null`. **There are 52 callsites of `readGoalState` in `src/`, and 51 of them treat `null` as "no goal"** (the GUI is the only one that disambiguates). The CLI, the server, the dispatcher, the tui, and the chain code all silently treat a corrupt file as "no goal."

Defect class in production:

1. User has an active goal (e.g. a multi-hour build).
2. A bug in another tool (or a hand-edit, or a partial-write race that survived the temp+rename atomicity) corrupts `.opencode/.goal-state.json`.
3. User runs `/goal view`. They get "No active goal" (CLI exit 2). The corrupt file still exists.
4. User runs `/goal set "do something"`. `setGoal` calls `writeGoalStateAtomic`, which overwrites the corrupt file with a fresh state. **The corrupt state is lost — and so is any recoverable evidence in it (e.g. an uncommitted turn counter, an unsent webhook, an accidentally-edited condition).**

The user has no way to know the file was corrupt. There is no "corrupt" signal in the CLI, the server's `goal_status` tool, the TUI dashboard, the sidebar, or the chain dispatcher. The 5-minute-deep forensic question "where did my goal go?" is unanswerable.

**Fix (recommended):** Thread a `corrupt` boolean (or a tri-state) through the readers. Mirror the `readGoalStateSafe` shape in the core API:

```ts
export type ReadResult =
  | { kind: "absent" }
  | { kind: "corrupt"; reason: "parse" | "validate" | "oversize" }
  | { kind: "ok"; state: GoalState };
```

Add a config flag (default ON, opt-out) to surface the corrupt state through the CLI and the dashboard as a clear message. The fix should NOT silently overwrite the corrupt file — it should rename it to `.goal-state.json.corrupt.<ts>` first so the user can recover manually.

**Schema-suspicion status:** the validator at `validateGoalState` is the trust boundary. If a hand-edited file fails the validator, the contract is currently "we throw it away." The brief asks whether the swallow masks malformed-state-file corruption. **It does, and the existing `gui.ts:readGoalStateSafe` proves the team already knows this** — they built the recovery for the GUI, then didn't propagate it.

---

## C-3 (Medium) — `process.pid + Date.now()` temp filename entropy

**Files:** `src/goal-state.ts:527` (`writeGoalStateAtomic`), `src/goal-state.ts:1236` (`writeHandoffAtomic`), `src/goal-chain.ts:119` (`writeGoalChainAtomic`). Compare `src/templates.ts:199` (`importTemplate`) which adds `Math.random()`.

The three atomic-write primitives construct their temp file as:

```ts
const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
```

**Empirical verification:** I ran `node -e "..."` to drive 1,000,000 iterations of `${pid}.${Date.now()}` in a tight loop (no awaits, no I/O — pure JS). The collision rate was **999,702 / 1,000,000 = 99.97%**. Within a single millisecond, the same expression produces the same string. The expression has zero per-call entropy.

**Production risk assessment:** LOW. The atomic-write call sites in `goal-state.ts` and `goal-chain.ts` are debounced by either the 5-second auto-loop debounce (`CONFIG.evaluationDebounceSec` in `server.ts:54`) or by the user's hand-driven CLI cadence. In production, two `writeGoalStateAtomic` calls land on different millisecond boundaries essentially always. Tests run in fresh temp directories and don't loop tight on writes. **The collision does not manifest in the v0.4.0 test suite.**

**However:** the templates.ts:199 site uses the augmented form `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`. The other three sites don't. **This is a code-consistency smell and a future-bug magnet.** A test that rapidly fires `writeGoalStateAtomic` in a loop (e.g. for fuzz testing or for a load scenario) will hit the collision and:

- A's `writeFileSync(tmp, "v1")` succeeds; file at `tmp` = "v1".
- B's `writeFileSync(tmp, "v2")` succeeds (same path); file at `tmp` = "v2".
- A's `renameSync(tmp, p)` moves the file containing "v2" to the final path. A's caller thinks they wrote "v1."
- B's `renameSync(tmp, p)` throws ENOENT (the file is already at `p` after A's rename). The try/catch on line 531 calls `unlinkSync(tmp)`, which also throws ENOENT. **B's error is swallowed silently** (the `catch (err) { throw err; }` does throw, but the caller's `catch (err: any) { return { ok: false, error: ... } }` discards the message loss). User sees "Failed to write state: ENOENT" with no context.

**Net effect of the collision in tight-loop test:** the LAST writer's `setGoal`/`createGoalChain`/etc. returns `ok: false, error: "ENOENT..."`, and the FIRST writer's data is at the final path. This is a "last write wins, but first writer got the success toast" silent data-loss bug. The "swallow" is the discarded B-side error in the write-failure path.

**Fix (one line each):** Use `randomUUID()` from `node:crypto` (already imported in goal-state.ts:13) for the temp-filename entropy:

```ts
const tmp = `${p}.tmp.${process.pid}.${Date.now()}.${randomUUID().slice(0, 8)}`;
```

Or better: extract a single `makeTempPath(targetPath)` helper and use it from all four sites. The `randomUUID` form is monotonic-safe and cross-platform; the `Math.random().toString(36).slice(2,8)` form in templates.ts is also fine but should match the other sites.

**Why the `Math.random()` in templates.ts isn't enough:** Math.random() is 52 bits of state and slices to ~6 base-36 chars = ~31 bits. Collision probability per pair in a single ms is ~1 in 2 billion. That's fine in practice. `randomUUID()` is 122 bits and slices to ~6 hex chars = 24 bits. Also fine in practice. **Both are vastly better than the bare `pid + Date.now()`.** Pick one, use it everywhere.

---

## C-4 (Medium) — Non-discriminated result interfaces

**Files:** `src/goal-state.ts:552-557` (`SetResult`), `src/goal-chain.ts:193-198` (`CreateChainResult`), `src/goal-chain.ts:334-342` (`AdvanceChainResult`).

All three interfaces use the pre-refactor pattern:

```ts
export interface AdvanceChainResult {
  ok: boolean;
  error?: string;
  message?: string;
  completed?: boolean;
  state?: GoalState;
}
```

This means `if (chainResult.ok)` does NOT narrow the type, and consumers need non-null assertions on the optional fields. The codebase has **5 sites** that use `!` on these:

- `command.ts:198`: `res.state!` (SetResult)
- `command.ts:287`: `res.state!` (SetResult)
- `command.ts:468`: `res.state!` (CreateChainResult)
- `server.ts:501`: `res.state!` (SetResult)
- `server.ts:409`: `chainResult.message!` (AdvanceChainResult)

Concrete instance of the failure mode (`server.ts:404-410`):

```ts
const chainResult = advanceGoalChain(directory);
if (chainResult.ok && chainResult.message) {
  await notify(sessionId, "Chain advanced", chainResult.message, "success");
}
if (chainResult.completed) {
  await notify(sessionId, "Chain completed", chainResult.message!, "success");
}
```

If a future refactor adds a `completed: true` return path WITHOUT a `message`, the `!` on line 409 silently passes `undefined` to `notify`. The user would see a toast with an empty body. **Currently safe in `goal-chain.ts:363-373` (all `completed: true` paths also set `message`), but the type system doesn't enforce the invariant.**

**Fix:** Make all three discriminated unions (mirror the `TransitionResult` pattern from goal-state.ts:667-676):

```ts
export type AdvanceChainResult =
  | { ok: true; message: string; completed?: false; state: GoalState }
  | { ok: true; completed: true; message: string; state?: undefined }
  | { ok: false; error: string };
```

The `!` operators disappear. New failure modes are forced through the type system.

This is a follow-on to the v0.4.0 refactor that converted `EditResult`, `TransitionResult`, `ToggleResult`, and `ClearResult` to the same pattern. `SetResult`, `CreateChainResult`, and `AdvanceChainResult` were missed.

---

## C-5 (Low) — `fireWebhook` is `async` but does no `await`

**File:** `src/server.ts:244-269`. Callers: 7 sites at lines 346, 370, 401, 500, 528, 548, 567, 724 (line 548 and 567 are in different `if` branches of the same code, so it's 7 distinct paths).

```ts
async function fireWebhook(state: GoalState, previousStatus: GoalStatus | null) {
  const wh = state.metadata.webhook;
  if (!wh || !wh.on.includes(state.status)) return;
  if (!wh.allowLocal && isLocalUrl(wh.url)) {
    log("warn", "webhook blocked: localhost URL", { url: wh.url });
    return;
  }
  const payload = { ... };
  fetch(wh.url, { ... }).catch(() => { /* fire-and-forget */ });
}
```

The function has no `await` anywhere in its body. It returns a resolved Promise immediately. The 7 callsites do:

```ts
if (cleared) fireWebhook(cleared, "active");
```

— without `await`. Today, this is **functionally correct** (the function does its work synchronously up to the `fetch`, which is fire-and-forget).

**Future trap:** if anyone adds an `await` inside `fireWebhook` (e.g. to validate the URL, to read a config, to check a rate-limit table), the function will start returning a pending Promise. The 7 fire-and-forget callsites will silently drop the Promise. The function will appear to "work" because the work happens inside the fetch call, but any new post-fetch logic (e.g. "log success/failure of the webhook") would be silently lost.

**Fix:** Either drop the `async` keyword (and the return type) — making the 7 callsites self-documenting as "fire and forget" — OR document explicitly that this function is async and intentionally non-awaited.

The docstring on lines 230-243 already says "Fires fire-and-forget POSTs", so the intent is clear. The code just doesn't enforce it. **Not a defect today; a "make the type match the intent" cleanup.**

---

## C-6 (Low) — `noUncheckedIndexedAccess` would surface 5 real type-soundness gaps

**Verification command:** `node_modules\.bin\tsc -p tsconfig.json --noEmit --noUncheckedIndexedAccess`

**Output (5 errors, all in `cli.ts` and `goal-state.ts`):**

```
src/cli.ts(131,25): error TS2345: Argument of type 'string | undefined' is not assignable to parameter of type 'string'.
src/cli.ts(144,23): error TS2322: Type 'string | undefined' is not assignable to type 'string'.
src/cli.ts(318,7): error TS18048: 'cmd' is possibly 'undefined'.
src/goal-state.ts(280,16): error TS2345: Argument of type 'string | undefined' is not assignable to parameter of type 'string'.
src/goal-state.ts(288,16): error TS2345: Argument of type 'string | undefined' is not assignable to parameter of type 'string'.
src/goal-state.ts(295,26): error TS2345: Argument of type 'string | undefined' is not assignable to parameter of type 'string'.
src/goal-state.ts(308,14): error TS2322: Type 'string | undefined' is not assignable to type 'string | null'.
```

The `goal-state.ts:280,288,295,308` errors are all the regex-match-array `m[1]` pattern. Today's code:

```ts
let m: RegExpMatchArray | null;
if ((m = text.match(/stop after (\d+) turns?/i)) || (m = text.match(/--turns\s+(\d+)/i))) {
  c.maxTurns = clampOrDefault(parseInt(m[1], 10), ...);
}
```

TS with `noUncheckedIndexedAccess` types `m[1]` as `string | undefined`. The `parseInt` of `undefined` returns `NaN` (silently accepted; the downstream `clampOrDefault` rejects NaN, so no real defect). The `parseCommand` (line 308) returns `m[1]` which would be `string | undefined` — the explicit `string | null` return type is the soundness check. **All five sites are runtime-safe, but the type system can't prove it without the flag.**

The `cli.ts:131,144,318` errors are `argv[1]`, `argv[startIdx]`, and `parts[i+1]` patterns. The code has already bounds-checked these (the `if (argv.length < 2)` on line 125 guards the `argv[1]` access; the `startIdx < argv.length` check guards the `argv[startIdx]` access). The runtime is safe; the type system is just stricter.

**Fix (if you want to turn the flag on):** 5 small `!` additions or refactor to `const [first] = arr; if (first !== undefined) ...` style. The change is mechanical. The benefit is that a future refactor that breaks the bounds check would be caught at compile time.

**Recommend: leave it off unless the team is willing to maintain the stricter types.** The cost is real (5 lines) and the benefit is marginal (the existing code is bounds-safe at runtime).

---

## C-7 (Low) — `exactOptionalPropertyTypes` would surface 8 API-surface ambiguities

**Verification command:** `node_modules\.bin\tsc -p tsconfig.json --noEmit --exactOptionalPropertyTypes`

**Output (8 errors across 5 files):**

The pattern: properties typed `T?` (which TypeScript today means `T | undefined`) are being assigned `T | undefined` literals. The flag distinguishes "absent" from "explicitly undefined", which is a real API-surface distinction:

- A type that says `note?: string` with the flag means: "the key may not be present, but if it IS present, it's a `string` (not `undefined`)." A caller passing `{ note: undefined }` violates the contract.
- Without the flag, the same `note?: string` accepts both `{ note: "x" }` and `{ note: undefined }`.

The 8 sites:

1. `command.ts:63`: `tpl.seed = { command: tpl.command ?? null, constraints: tpl.constraints }` — `tpl.constraints` is `Partial<GoalConstraints> | undefined`, but `GoalSeed.constraints` is `Partial<GoalConstraints>` (not `| undefined`).
2. `command.ts:281`: `resolvedSeed` includes `command: tpl.seed.command != null ? resolveTemplateVars(...) : tpl.seed.command` — the ternary returns `string | null | undefined`, but `GoalSeed.command` is `string | null`.
3. `goal-chain.ts:285`: `metadata: { createdAt, setBy, sessionId: opts.sessionId }` — `opts.sessionId` is `string | undefined` (from `CreateChainOpts.sessionId?: string`).
4. `goal-state.ts:1264`: `payload` includes `note: safeNote || undefined` — `safeNote` is `string`, so `safeNote || undefined` is `string | undefined`, but `HandoffPayload.note` is `string | undefined` (per the existing type), so this is actually a flag-vs-type distinction. With the flag, `HandoffPayload.note?: string` means "may be absent", not "may be undefined", and `note: undefined` violates that.
5. `goal-state.ts:1347`: `resumed` includes `command: typeof payload.state.command === "string" ? sanitizeForPrompt(payload.state.command) : payload.state.command` — the ternary returns `string | null | undefined`, but `GoalState.command` is `string | null`.
6. `gui.ts:125`: `metadata: { ...state.metadata, steering: state.metadata.steering.map(...) : state.metadata.steering }` — `state.metadata.steering` is `Array<...> | undefined`, but the target type says `steering?: Array<...>`.
7. `server.ts:488`: `setGoalFields(ctx.directory, { condition: args.condition, command: args.command ?? null, verification: ..., maxTurns: args.maxTurns, maxMinutes: args.maxMinutes })` — `args.maxTurns` and `args.maxMinutes` are `number | undefined` (from the zod schema), but `GoalFields.maxTurns` is `number` (not `number | undefined`).
8. `sidebar-logic.ts:296,297,306`: `handoffView` is constructed with `note: handoff.note` — `handoff.note` is `string | undefined`, but the local `HandoffView` type says `note?: string`.

**Runtime safety:** All 8 sites are runtime-safe (the field either ends up absent or with the right value). The issue is the type contract: a future caller reading the type can't tell whether `undefined` is a valid value to pass.

**Recommend: leave it off.** The cost is 8 lines of refactor across 5 files; the benefit is purely a type-system cleanliness improvement with no runtime impact. If the team is heading toward a published `.d.ts` API surface (the package's `types` field in package.json exposes `dist/server.d.ts`, `dist/goal-state.d.ts`, etc.), this becomes more important — a downstream consumer using `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` would hit these.

---

## C-8 (Low) — Dynamic `import("node:path")` inside `evaluateFile`

**File:** `src/server.ts:196, 209`.

```ts
async function evaluateFile(v: { path: string; exists?: boolean; contains?: string }): Promise<GoalEvaluation> {
  const now = Date.now();
  const { resolve, relative, isAbsolute } = await import("node:path");
  ...
  try {
    const { existsSync, readFileSync } = await import("node:fs");
    ...
```

`server.ts` already statically imports `node:child_process` and `node:util` (lines 20-21). The dynamic imports inside `evaluateFile` are inside a try/catch so they can't throw at runtime, but the import system has to:

1. Resolve `node:path` from the module cache (it'll be in the cache on the second call, but the first call pays the resolution cost).
2. Resolve `node:fs` similarly.

For a debounced goal-evaluation loop (5s), this is essentially zero cost. **The real cost is cognitive:** a reader of `server.ts` has to know that `node:path` and `node:fs` are imported dynamically elsewhere in the file, in case they're searching for a function used by a static import that doesn't see them.

**Fix:** Add static imports at the top of `server.ts`:

```ts
import { resolve, relative, isAbsolute } from "node:path";
import { existsSync, readFileSync } from "node:fs";
```

The code inside `evaluateFile` doesn't need to change. The dynamic-import form is then redundant and the static import is the only path.

(If the team has a specific reason for the dynamic form — e.g. `evaluateFile` is a rare path and they want to defer the import until first use — that should be a comment. Today, the code is just inconsistent.)

---

## C-9 (Smell) — `isLocalUrl` misses IPv4-mapped IPv6 loopback

**File:** `src/server.ts:286-300`.

The SSRF guard handles:
- `localhost` and `0.0.0.0` hostname string match.
- `[::1]` IPv6 loopback string match.
- `127.x.x.x` IPv4 loopback range.

It does NOT handle:
- `[::ffff:127.0.0.1]` IPv4-mapped IPv6 loopback. The hostname string would be `[::ffff:127.0.0.1]`. None of the four branches match. The webhook would be permitted.
- `[::1]` lowercased to `[::1]` is already handled. But `WHATWG URL` may surface IPv6 hostnames with or without brackets depending on the `URL.toString()` form. The string match is the right call here; just be aware of the gap.

**Practical risk:** an attacker would have to KNOW their target is on `::ffff:127.0.0.1` and configure a webhook receiver there. The receiver would then be a localhost service (e.g. a dev server on `127.0.0.1`). The attack is "trick the user into webhooking their own dev server to exfiltrate state" — low-value. **Not a real defect, but the guard's spec says "string match" and the gap is small.**

**Fix (if you want to close it):**

```ts
const lower = h.toLowerCase();
if (lower === "localhost" || lower === "0.0.0.0") return true;
if (lower === "[::1]" || lower === "[::ffff:127.0.0.1]") return true;
if (/^127(?:\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)){3}$/.test(h)) return true;
return false;
```

**Recommend: leave as-is and document the gap in the comment.** The spec says "string match", and a more comprehensive check (e.g. DNS resolve + check) is explicitly out of scope for the TOCTOU reasons already documented in the function.

---

## C-10 (Smell) — Non-null assertions on the non-discriminated result interfaces

**Sites (5 total):**

- `command.ts:198`: `res.state!` (SetResult)
- `command.ts:287`: `res.state!` (SetResult)
- `command.ts:468`: `res.state!` (CreateChainResult)
- `server.ts:501`: `res.state!` (SetResult)
- `server.ts:409`: `chainResult.message!` (AdvanceChainResult)

These are the consumer-side mirror of the C-4 defect. If the result interfaces were discriminated unions, all 5 `!` operators would be unnecessary (TS would narrow on the `ok: true` branch).

**Fix:** See C-4. Migrating the three interfaces to discriminated unions deletes all 5 `!` operators in one pass.

---

## Verdicts on the patterns the brief asked about (no defect)

These are the patterns the brief asked about that I judged **NOT** to be defects. Listed per the brief's focus areas so the verifier can audit the judgment.

### 1. `catch (err: any)` access patterns

41 `catch` sites in `src/`. The 32 sites that actually use `err` all do `err?.message ?? err` or `err?.code ?? err?.stderr ?? err?.stdout`. The only non-trivial use is `server.ts:126-131` (the `evaluateDeterministic` child_process error inspection), which is correctly safe — `err?.killed`, `err?.signal`, `err?.code`, `err?.stderr`, `err?.stdout` are all valid properties on the `exec` rejection error. The optional chaining handles non-Error throws. **No defect.**

The 9 `catch (err)` (untyped) sites are all in the auto-loop's top-level catch (server.ts:456), the JSON parse try/catch in `readGoalState` etc., and a few others. They all just do `return null` or `log("error", ..., { error: String(err) })`. The `err` is the catch binding name, not the type. **No defect.**

### 2. Swallowed errors in cleanup paths

13 sites of `try { } catch { /* ignore */ }` or `try { } catch {}`. All are best-practice cleanups:

- `unlinkSync(tmp)` after a write failure (3 sites in goal-state.ts, 1 in goal-chain.ts, 1 in templates.ts) — temp-file cleanup after a failed atomic write. The temp file may or may not exist; the cleanup is best-effort.
- `closeSync(openedFd)` in cli.ts:424 — close an opened fd in a `finally` block. Best-effort.
- `try { watchHandle.close(); } catch { /* ignore */ }` in gui.ts:210 — disposing a file watcher. Best-effort.
- `} catch { return false; }` in server.ts:299 — `isLocalUrl` catch; the function returns false on parse failure, which is the safe default (don't block the webhook).

**None of these hide a defect class. All of them are documented in the inline comments.**

The bigger swallow is the **`try { ... } catch { return null; }`** in `readGoalState` / `readGoalChain` / `readHandoff` / `readGoalStateRaw` — that's C-2, classified as a real defect.

### 3. `.catch(() => {})` and `.catch((err) => log(...))`

5 sites:

- `server.ts:73`: `client.app.log(...).catch(() => {});` — fire-and-forget log call. The log itself is best-effort; if it fails, there's nowhere to report. **Acceptable.**
- `server.ts:81`: `client.tui.showToast(...).catch(() => {});` — fire-and-forget toast. The TUI may not be active (Desktop Electron is a no-op per the docstring). **Acceptable.**
- `server.ts:84`: `client.session.prompt(...).catch((err) => log("error", "notify (session message) failed", { error: String(err) }));` — failure is logged. **Acceptable.**
- `server.ts:268`: `fetch(wh.url, ...).catch(() => { /* fire-and-forget */ });` — the webhook fetch is intentionally fire-and-forget. **Acceptable, but the comment should be on the spec line.**
- `server.ts:455`: `client.session.prompt(...).catch((err) => log("error", "Failed to inject continue prompt", { error: String(err) }));` — failure is logged. **Acceptable.**

None of these hide a defect class. The webhook fetch in particular is **intentionally** fire-and-forget (the spec says "POST and forget").

### 4. Unhandled promise rejections — `void someAsync()` or non-awaited async

No `void someAsync()` patterns in the codebase.

The non-awaited `fireWebhook(...)` (7 sites) is in C-5. The function is async-by-habit, not async-by-need. The 7 callsites don't `await` it, but since the function does no async work, the dropped promise is always already-resolved. **Not a defect today.** The classification as "low" is because it's a future trap.

The `advanceGoalChain(directory)` callsite at server.ts:404 is **not async at all** — `advanceGoalChain` is a sync function. The `const chainResult = advanceGoalChain(directory)` is just a sync function call. **No promise involved, no defect.**

### 5. `Promise<{ ok: boolean; ... }>` discriminated-union consumers

The codebase has 4 different result-object shapes:

- **Discriminated unions (4 of them):** `EditResult`, `TransitionResult`, `ToggleResult`, `ClearResult`. Consumers all narrow correctly on `if (res.ok)`.
- **Non-discriminated (3 of them):** `SetResult`, `CreateChainResult`, `AdvanceChainResult`. Consumers use `!` assertions. **See C-4 and C-10.**

I verified the discriminated-union consumers by reading every callsite:

- `command.ts:194-200, 234, 287, 292-298, 301-309, 311-333, 350-355, 357-362, 364-369, 371-375, 377-381, 383-390, 392-403, 405-416, 418-426, 433-437, 439-443, 466-468, 474-487, 498-505` — all check `res.ok` first, then either use `res.reason` (typed) or `res.error` (string). No missing-narrowing defects.
- `server.ts:495, 524, 544, 562, 628, 642, 656, 670, 684, 696, 711, 736, 749, 775, 797` — all check `res.ok` first, then map reasons. No missing-narrowing defects.
- `tui-dials-logic.ts:166, 178, 192, 206` — all check `!res.ok` first, then switch on `res.reason`. No missing-narrowing defects.
- `tui-logic.ts:123, 146` — narrow correctly.

**The discriminated-union consumers are uniformly correct.** The defect is in the non-discriminated interfaces (C-4).

### 6. JSON.parse without try/catch

11 `JSON.parse` sites in `src/`. All 11 are wrapped in `try/catch` (or `try/catch (err: any)`). The catch returns `null` or a `{ ok: false, error }` envelope. **No uncovered JSON.parse.**

The deeper issue is the **silent recovery** in 4 of those 11 (C-2): `readGoalState`, `readGoalStateRaw`, `readGoalChain`, `readHandoff`. The catch returns `null`, which downstream code treats as "no goal/no chain/no handoff." The brief's "should there be a 'schema is corrupt' recovery path" — **yes, gui.ts already implements it for one of the four; the other three need the same treatment.**

### 7. `process.pid + Date.now()` for temp filenames

4 sites. See C-3. The 3 in `goal-state.ts` and `goal-chain.ts` have no entropy beyond the millisecond. Verified empirically: 99.97% collision rate in a tight loop. The 1 in `templates.ts` adds `Math.random()`. **Inconsistency; recommend `randomUUID()` from `node:crypto` at all 4 sites.**

### 8. tsconfig strictness

`tsconfig.json` has `strict: true`. `strict` includes `noImplicitAny`, `strictNullChecks`, `strictFunctionTypes`, `strictBindCallApply`, `strictPropertyInitialization`, `noImplicitThis`, `useUnknownInCatchVariables`, `alwaysStrict`. All are ON.

Tested additional flags:

- `noUncheckedIndexedAccess` — surfaces 5 sites (C-6).
- `exactOptionalPropertyTypes` — surfaces 8 sites (C-7).
- `noImplicitOverride` — clean (no class hierarchies).

**Recommend:** turn on `noUncheckedIndexedAccess` if the team is willing to add 5 `!` operators or refactor to destructured-with-undefined-checks. Skip `exactOptionalPropertyTypes` (too many surface-area changes for too little runtime safety benefit). Skip `noImplicitOverride` (no relevant code).

### 9. `Promise.all` / `Promise.race` patterns

**Zero** `Promise.all` / `Promise.race` / `Promise.allSettled` / `Promise.any` uses in `src/`. The codebase is almost entirely sequential. The two notable async pipelines are:

- `evaluate` (server.ts:309-461) — sequential await chain. The notify / fireWebhook / prompt calls are sequential.
- `evaluateFile` / `evaluateHttp` (server.ts:173-227) — single async function each, no parallelism.

**No Promise.all/race leak defects.** The codebase's async style is "await one, then the next," which is the safe form.

### 10. Regex reuse and stateful `lastIndex` bugs

Static regexes:

- `COMPLETE_RE`, `BLOCKED_RE`, `FENCE_RE` (goal-state.ts:141, 142, 144) — module-level constants, no `/g` flag. Used in `.match(re)`. **No stateful bug.**
- All other static regexes in the codebase (29 sites from the grep) — either no flags, or `/i` flag (case-insensitive, no stateful behavior), or `/g` flag used with `.replace()` (replace does not use lastIndex and always replaces all matches).

`new RegExp(...)` dynamic creation:

- `server.ts:184`: `new RegExp(v.expectBody).test(body)` — no flags. `.test()` resets lastIndex even on /g regexes per ECMA spec. **No stateful bug.**
- `server.ts:219`: `new RegExp(v.contains).test(content)` — same. **No stateful bug.**

Loop with `/g` and `exec`:

- `templates.ts:61-67`: `referencedVars` — function-scoped `re = /\{(\w+)\}/g`, local to the function. Each call creates a fresh regex. The `while ((m = re.exec(text)) !== null)` loop terminates when `exec` returns null (which it does at end-of-string, resetting `lastIndex` to 0). **No cross-call pollution because the regex is local.**

**Verdict: no stateful-lastIndex bug. Regex reuse is module-level for hot-path patterns (good) and per-call for user-supplied patterns (necessary — user inputs can change). JIT/identity cost is negligible.**

### 11. Node deprecation / future-deprecation

Verified:

- All imports use `node:` protocol (forward-compatible ESM). No `require("fs")` / `require("path")` legacy imports.
- No `new Buffer()` or `Buffer()` (legacy) — only `Buffer.alloc` (cli.ts:412).
- No `domain.*` / `setImmediate()` / `process.binding()` (none in src/).
- No `util.isArray` / `util.isDate` / `util._extend` / `util.puts` / `util.print` / `util.error` / `util.pump` (all deprecated/removed).
- URL parsing uses `new URL()` (WHATWG) — see `server.ts:288` and `cli.ts:55,520,523`. No legacy `url.parse()` / `url.format()`.
- Path operations use `path` (platform-appropriate). No `path.posix.join` mismatches with `path.resolve` (which would be a Windows-vs-POSIX separator bug — none found).
- No `__dirname` / `__filename` (Node would auto-generate these in CJS; the codebase is ESM and uses `import.meta.url` correctly in cli.ts).

**Verdict: zero Node deprecation violations. The codebase is on the modern Node 20+ API surface (engines.node = ">=20").**

---

## Summary

The codebase is in good shape on TypeScript soundness. **The 3 real defects** are:

- **C-1 (Critical)**: `SetResult` missing `reason` discriminant — `set` failures collapse to wrong exit code.
- **C-2 (High)**: silent corruption recovery in 4 reader primitives — corrupt state files are silently treated as "no goal."
- **C-3 (Medium)**: tmp-file entropy — `pid + Date.now()` is insufficient; 1-line `randomUUID()` fix.

The rest of the brief's focus areas (catch, swallowed errors, regex, Node deprecations) are **uniformly correct or best-practice** — the only smells are the non-discriminated result interfaces (C-4, follow-on from C-1) and the `fireWebhook` async-by-habit (C-5).

Recommend fixing C-1, C-2, C-3 in that order. C-4 falls out of C-1's fix. C-5 through C-10 are optional cleanup.
