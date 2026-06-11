# Work order: CLI hardening — fix the prose-boundary architecture

**Status**: ready to execute. Diagnosis is complete and verified; do NOT re-investigate.
**Verified green before this work**: `npm test` (409/409), `npx tsc -p tsconfig.json` (clean),
Windows CLI smoke test (set/status/turns/pause, exit codes 0/1/2).

## The diagnosis (context — read, don't re-derive)

`dispatchGoalCommand` in `src/command.ts` is a **chat-shaped interface**: it takes one
prose string (structure like `--command "npm test"` embedded in the text, quotes intact
because chat input preserves them) and returns one prose string (structured results from
the goal-state primitives flattened into agent-directed text like
`"Tell the user this, then stop and await further instruction:\n\n..."`).

`src/cli.ts` is a **shell-shaped consumer**: it has real argv (the shell already stripped
quotes) and must produce real exit codes. It was bolted directly onto the chat-shaped
interface, forcing two lossy conversions:

1. **argv → prose** (`payload = argv.slice(startIdx+1).join(" ")`, cli.ts:127): quoting is
   destroyed. `parseCommand` (goal-state.ts:276) requires literal quote chars
   (`--command "..."`), so the README's own example
   `opencode-autogoal set "ship v2" --command "make deploy"` **silently** creates
   `condition: "ship v2 --command make deploy"`, `command: null` — no verification
   command, exit 0, looks like success. (Empirically confirmed.)
2. **prose → exit code** (`mapExitCode`, cli.ts:184): regex-greps the human text. A goal
   condition containing `Usage:` or `No active goal` poisons the exit code of a
   successful `status` call. `cleanForCli` similarly truncates at the first
   `\n\nHow to proceed:` anywhere in the reply, including inside user text.

Plus two mechanical bugs found in the same review:

3. **cli.ts:249 — the ESM entry guard never matches on POSIX**:
   `` `file:///${process.argv[1]?.replace(/\\/g, "/")}` `` yields `file:////home/...`
   (4 slashes) vs `import.meta.url`'s `file:///home/...`. On Linux/macOS the published
   bin prints nothing and exits 0. Also fails on Windows paths with spaces (no %20
   encoding) and through npm bin symlinks (realpath mismatch). The e2e suite masks this
   because it spawns `dist/cli.js` by its literal space-free Windows path.
4. **package.json `exports["./schema"].types`** was accidentally changed from
   `./dist/goal-state.d.ts` to `./dist/goal-state.js` — breaks TS consumers of the
   schema subpath.

## Ground rules

- TDD: for every task, write the failing test first, see it fail, then implement.
- `npm test` runs build + all tests. All 409 existing tests must stay green —
  **existing prose output of `dispatchGoalCommand` must remain byte-identical.**
- Run `npx tsc -p tsconfig.json` after each task.
- Windows dev box; shell is PowerShell 7. `node --test test/<file>` runs one suite.

---

## Task 1 — Fix the ESM entry guard (mechanical, do first)

**File**: `src/cli.ts` (bottom).

Replace the `if (import.meta.url === ...)` block with a tested helper:

```ts
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";

/** True when this module is the process entry point (handles Windows
 *  backslashes, %20-encoding, and npm bin symlinks via realpath). */
export function isCliEntry(metaUrl: string, argv1: string | undefined): boolean {
  if (!argv1) return false;
  try {
    if (pathToFileURL(argv1).href === metaUrl) return true;
  } catch { /* fall through */ }
  try {
    return pathToFileURL(realpathSync(argv1)).href === metaUrl;
  } catch {
    return false;
  }
}

if (isCliEntry(import.meta.url, process.argv[1])) {
  process.exit(main());
}
```

**Tests first** (add to `test/cli.test.mjs`, import `isCliEntry` from `../dist/cli.js`):
- POSIX-style: `isCliEntry("file:///home/u/cli.js", "/home/u/cli.js")` → `true`
  (this fails against the old hand-rolled string — that's the regression pin).
- Space path: `isCliEntry("file:///C:/a%20b/cli.js", "C:\\a b\\cli.js")` → `true`.
- Mismatch: `isCliEntry("file:///x/cli.js", "/y/other.js")` → `false`.
- Undefined argv1 → `false`.
- Symlink: create a real temp file + `fs.symlinkSync` to it (wrap in try/catch and
  `t.skip()` if symlink creation fails — Windows non-admin can't always symlink),
  assert `isCliEntry(pathToFileURL(realTarget).href, symlinkPath)` → `true`.

**Verify**: `npm test`; the e2e suite must still pass (guard still matches direct spawn).

## Task 2 — Revert the package.json types regression (mechanical)

**File**: `package.json`. Change `exports["./schema"].types` back to
`"./dist/goal-state.d.ts"`. Nothing else in that block.

**Test first**: add to `test/cli.test.mjs` (or a new `test/package-exports.test.mjs`):
read `package.json`, assert every `exports[*].types` value ends with `.d.ts`.

## Task 3 — Structured dispatcher result (the core fix)

**File**: `src/command.ts`.

Add a structured envelope and make the prose function a thin presenter over it:

```ts
export type GoalCommandKind =
  | "success"          // generic success (view, pause, resume, clear, dials, ...)
  | "set"              // successful set — message + agentExtras
  | "usage"            // bad/missing arguments               → CLI exit 1
  | "invalid-value"    // failed validation                   → CLI exit 1
  | "unknown-action"   //                                     → CLI exit 1
  | "no-goal"          //                                     → CLI exit 2
  | "terminal-state"   //                                     → CLI exit 2
  | "handoff-exists" | "no-handoff" | "current-goal"          // → CLI exit 2
  | "write-failed";    //                                     → CLI exit 3

export interface GoalCommandResult {
  kind: GoalCommandKind;
  /** Clean user-facing text. NO relay wrapper, NO "How to proceed" scaffolding. */
  message: string;
  /** Agent-only briefing (the "How to proceed:\n...\nBegin now." block).
   *  Present only when kind === "set". */
  agentExtras?: string;
}

export function dispatchGoalCommandStructured(
  directory: string, rawArguments: string,
): GoalCommandResult { /* current dispatch logic, returning kinds + clean messages */ }
```

Implementation notes:
- Move the body of `dispatchGoalCommand` into `dispatchGoalCommandStructured`. Every
  `return relayToUser(X)` becomes `return { kind: <K>, message: X }` where `<K>` comes
  from the primitive's existing `reason` field (they already return
  `no-goal` / `terminal-state` / `invalid-value` / `write-failed` / `handoff-exists` /
  `no-handoff` / `current-goal`) or `usage` for the `Usage:` strings or
  `unknown-action` for the fallthrough. `viewResponse` with no goal → `no-goal`
  (message unchanged).
- Split `goalInstructions` output: `message` = the part before `"\n\nHow to proceed:"`,
  `agentExtras` = the rest. (Simplest: build the two halves separately inside
  `goalInstructions` or a new helper; do NOT split by string-search on user data.)
- Rewrite `dispatchGoalCommand` as the presenter — it must reproduce **byte-identical**
  output to today:
  ```ts
  export function dispatchGoalCommand(directory: string, rawArguments: string): string {
    const res = dispatchGoalCommandStructured(directory, rawArguments);
    if (res.kind === "set") return `${res.message}\n\n${res.agentExtras}`;
    if (res.kind === "success" && /* resume special case */) return res.message; // see note
    return relayToUser(res.message);
  }
  ```
  NOTE the two non-relayed success paths today: successful `set`/`template` (returns
  `goalInstructions(...)` bare) and successful `resume` with state (returns
  `"Goal resumed — continue working toward it now:\n\nGOAL: ..."` bare). Model these
  explicitly (e.g. a `relay: boolean` field on the envelope or kind `"set"` for both);
  the existing prose tests will catch any drift — that is the point of them.
- Delete the duplicated `// parsePositiveInt is imported...` comment (lines 250–252,
  keep one) and fix the over-indented `return` at line 247.

**File**: `src/cli.ts`. Replace `dispatchGoalCommand` + `cleanForCli` + `mapExitCode`
with the structured call:

```ts
const KIND_TO_EXIT: Record<GoalCommandKind, number> = {
  success: 0, set: 0,
  usage: 1, "invalid-value": 1, "unknown-action": 1,
  "no-goal": 2, "terminal-state": 2, "handoff-exists": 2, "no-handoff": 2, "current-goal": 2,
  "write-failed": 3,
};
const res = dispatchGoalCommandStructured(parsed.directory, dispatcherArg);
process.stdout.write(`${res.message}\n`);   // never agentExtras — CLI users aren't agents
return KIND_TO_EXIT[res.kind];
```

Delete `cleanForCli` and `mapExitCode` entirely; update `test/cli.test.mjs` exports test
and any tests that imported them (replace with `KIND_TO_EXIT` table tests).

**Tests first**:
- `test/command.test` additions: for each action path assert the structured `kind`
  (set → "set" with `agentExtras` containing "Begin now."; bad turns → "usage";
  pause with no goal → "no-goal"; etc.).
- Prose-identity test: for a representative matrix of inputs (set, view, bare /goal,
  pause no-goal, turns abc, unknown action, resume), assert
  `dispatchGoalCommand(dir, x)` equals the **current** output strings (copy the exact
  current strings into the test BEFORE refactoring — run against the unmodified build
  to capture them).
- The poison test (the bug this kills): in a temp dir,
  `set` a condition of `document the Usage: section of the No active goal page`,
  then dispatch `view` → structured kind must be `"success"` (old grep would have
  mapped exit 1). E2E variant in `test/cli-e2e.test.mjs`: same flow via spawned CLI,
  assert exit code 0.

## Task 4 — CLI: stop destroying argv structure on `set`

**File**: `src/cli.ts`, function `payloadToDispatcherArg` / `parseArgs`.

For the `set` action only, scan the post-action argv elements for `--command`:
the **single next argv element** is the command (the user's shell already grouped it).
Re-quote it before joining so `parseCommand`'s regex finds it:

```ts
// In main(), before building dispatcherArg, when dispatcherAction === "set":
// argvRest = process.argv.slice(2 + startIdx + 1)  — keep raw elements, do NOT pre-join.
function buildSetPayload(rest: string[]): string {
  const i = rest.indexOf("--command");
  if (i === -1) return rest.join(" ");
  const cmd = rest[i + 1];
  if (cmd === undefined) throw new Error("--command requires a value");
  if (cmd.includes('"')) throw new Error('--command value may not contain double quotes');
  const condition = [...rest.slice(0, i), ...rest.slice(i + 2)].join(" ");
  return `${condition} --command "${cmd}"`;
}
```

This requires `parseArgs` to return the rest as an **array** (`payloadParts: string[]`)
instead of a pre-joined string; non-`set` actions keep `payloadParts.join(" ")`
behavior. Errors thrown here follow the existing parseArgs error path (stderr + HELP,
exit 1).

**Tests first**:
- Unit: `buildSetPayload(["ship", "v2", "--command", "make deploy"])` →
  `'ship v2 --command "make deploy"'`; no `--command` → plain join; `--command` with
  no value → throws; value containing `"` → throws; `--command` first
  (`["--command", "x", "fix", "it"]`) → `'fix it --command "x"'`.
- E2E (`test/cli-e2e.test.mjs`): spawn
  `set "ship v2" --command "make deploy"`, then read
  `.opencode/.goal-state.json` → `condition === "ship v2"` AND
  `command === "make deploy"`. **This is the README example; it must work verbatim.**

## Task 5 — Minor TUI fixes (small, isolated)

**File**: `src/tui.tsx`.
- `toastLastShown` grows unboundedly (keys include dynamic messages). After each
  `toastLastShown.set(...)`, prune: if `size > 50`, delete every entry older than
  `TOAST_DEBOUNCE_MS`. Fix the comment that claims the key includes duration (it's
  `variant|message`).
- Source-pattern test (follow the style of `test/tui-ux-fixes.test.mjs`): assert
  `tui.tsx` contains the prune logic (match on `> 50` near `toastLastShown`).

## Task 6 — README corrections

**File**: `README.md` (Standalone CLI section).
- Document that `status` with no goal exits 2 (precondition), not 0.
- Document `--command` for `set`: value is one shell-quoted argument.
- No other prose changes.

---

## Final verification (run all; paste output in the handoff)

```powershell
npm test                       # all suites green (409 existing + new)
npx tsc -p tsconfig.json       # no output = clean
# E2E re-proof of the two killer bugs, in a temp dir:
node dist/cli.js set "ship v2" --command "make deploy"   # state: condition="ship v2", command="make deploy"
node dist/cli.js set "document the Usage: section"; node dist/cli.js status; echo $LASTEXITCODE  # 0
```

Do not commit `scratch/`. Commit message prefix: `fix(cli): v0.2.2 — structured dispatcher results + entry-guard/packaging fixes`.

---

# ROUND 2 — audit findings on the executed work (2026-06-11)

Tasks 1–6 were audited and verified: entry guard, `--command` e2e, exit-code poison,
package.json types, toast prune, README — all correct, 438/438 green, prose
byte-identity held. **Two new defects were introduced in Task 3's kind-mapping
and must be fixed before release.** Root cause: `transitionGoal` is the only
primitive without a typed `reason` field, so `command.ts` recovers kinds by
regex-matching its error prose — and the regexes miss cases.

## Fix R2-1 — `transitionGoal` gets a typed reason (the altitude fix)

**File**: `src/goal-state.ts`. Add to `TransitionResult`:
```ts
reason?: "no-goal" | "terminal-state" | "already-in-state" | "write-failed";
```
Set it at every `return { ok: false, ... }` site in `transitionGoal`:
- "No active goal to ${action}." → `no-goal`
- clear on cleared/achieved ("No active goal to clear.") → `no-goal`
- "Goal is already paused." / "Goal is already active." → `already-in-state`
- "This goal was already achieved. Set a new goal instead." → `terminal-state`
- "This goal was cleared. Set a new goal instead." → `no-goal`
- write catch → `write-failed`
Additive and optional — no existing caller breaks. Do NOT change any message string.

**File**: `src/command.ts`. In the `clear`/`pause`/`resume` branches, replace the
regex-on-message mapping with `res.reason` switches (message strings stay the
same; only `kind` selection changes). Delete the `/No active goal/i` etc. regexes.

**Defects this fixes (write these tests FIRST, they fail today):**
- e2e: `clear` with no goal → exit **2** (today: 3).
- e2e: `resume` when already active → exit **0**, kind `already-in-state`
  (today: 3). Mirrors pause-when-paused.
- envelope: `resume` on an achieved goal → kind `terminal-state` → exit 2 (today: 3).
- envelope: `pause` on achieved/cleared → kind `no-goal` → exit 2 (already
  correct today via regex — pin it so the refactor can't regress it).

## Fix R2-2 — `buildSetPayload` docstring contradicts the code

**File**: `src/cli.ts` (~line 232). The docstring example claims
`buildSetPayload(["--command", "echo", "hi"]) → '--command "echo hi"'` but the
implementation takes the SINGLE next element: actual result is `'hi --command "echo"'`.
The implementation is correct (the shell groups a quoted command into one argv
element); fix the example to match the code. Add a unit test pinning
`buildSetPayload(["--command", "echo", "hi"])` → `'hi --command "echo"'`.

## Fix R2-3 — stale comments (5 min, no behavior change)

- `src/cli.ts` header (~lines 9, 45–49): still says "thin wrapper around
  `dispatchGoalCommand`" and "Scripts can grep the output for known markers".
  Update: wraps `dispatchGoalCommandStructured`; scripts should use exit codes.
- `test/command-prose-identity.test.mjs` header (~line 14): mentions
  `cleanForCli`, which no longer exists.

## Round-2 verification

```powershell
npm test                  # all green, including the 4 new R2-1 tests
npx tsc -p tsconfig.json
# in a temp dir:
node dist/cli.js clear; echo $LASTEXITCODE       # 2 (no goal)
node dist/cli.js set "x" | Out-Null; node dist/cli.js resume; echo $LASTEXITCODE  # 0 (already active)
```
