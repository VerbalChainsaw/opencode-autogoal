# Track B — OpenCode Plugin/SDK API Misuse

**Reviewer:** coder (branch session `mvs_28344928203549c9a9c9b52330ed6c75`)
**Target:** opencode-autogoal v0.4.0 @ `4bdfa8f`
**Scope:** full `src/` surface that touches the host API — primarily `src/server.ts` (913 lines), with cross-references to `src/permissions.ts` and `src/cli.ts`.
**Date:** 2026-06-12
**Mode:** Adversarial review, read-only (no source files modified).

---

## TL;DR

Eleven findings. **Three are real defects** (B-1 partial shape-mismatch hide, B-3 missing lifecycle handlers, B-5 swallowed error before a "goal achieved" claim). **Five are deliberate workarounds** documented in code and acceptable for v0.4.0 (B-2 part cast, B-4 `output.context.push` shape, B-6 the four `client.*` calls, B-7 the switch's `default` exhaustiveness, B-10 CLI fd cast). **Three are smells worth tracking** but not blocking (B-8 multi-session fan-in via `isEvaluating` lock, B-9 ignored `input.sessionID` in compacting hook, B-11 unread `res.data` typing path on `messages`).

The red-team was right to flag the cast at server.ts:814 (now `:833`) as needing live verification — the cast is **defensible** as a contract workaround but the surrounding comment's "OpenCode fills id/sessionID/messageID" is the only evidence we have; I have not seen the host source. Recommend the v0.4.1 changelog mention the live test, and a test stub for the cast site.

---

## Method

Read all 12 files in `src/` for context. Read three authoritative sources in `node_modules`:

- `@opencode-ai/plugin/dist/index.d.ts` (322 lines) — the documented hook contracts.
- `@opencode-ai/sdk/dist/gen/types.gen.d.ts` (3383 lines) — the discriminated unions, request data shapes, and response types.
- `@opencode-ai/sdk/dist/gen/sdk.gen.d.ts` (403 lines) — the `OpencodeClient` class method surface.

Then cross-referenced every API call site in `src/server.ts` and `src/cli.ts` against those definitions. For each mismatch or workaround, traced the impact path through the code (does the host actually fill required fields? does the SDK actually return the claimed shape? does the catch handler hide a real failure?).

Findings are tagged:

- **DEFECT** — a real bug or contract violation. Ship-blocking.
- **WORKAROUND-OK** — a deliberate cast or unconventional use that's documented in code and justifiable; not a bug, but worth knowing.
- **SMELL** — not a bug, but a maintainability or design concern. Track only.

---

## B-1 [DEFECT] `as any[]` cast on `session.messages` hides a real shape mismatch

**File:** `src/server.ts:139`
**Type source:** `@opencode-ai/sdk/dist/gen/types.gen.d.ts:2234-2242` (`SessionMessagesResponses`)

```ts
// server.ts:138-142
const res = await client.session.messages({ path: { id: sessionId } });
const msgs = (res.data ?? []) as any[];
const last = msgs.filter((m) => m?.info?.role === "assistant").at(-1);
if (!last) return "";
return (last.parts ?? []).filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n");
```

**The actual SDK type is:**

```ts
// types.gen.d.ts:2234-2242
export type SessionMessagesResponses = {
    200: Array<{
        info: Message;
        parts: Array<Part>;
    }>;
};
```

**Why this matters:**

The plugin treats each `m` as if it WERE a `Message` (and accesses `m.info?.role` and `m.parts`). It happens to work — because `m.info?.role` correctly dereferences through the wrapper — but the cast to `any[]` claims a shape the SDK does NOT guarantee. The plugin then iterates `m.parts` as if it were on the message itself; the SDK guarantees `parts` is a SIBLING of `info`, not a child of `info`.

The current access pattern is correct BY COINCIDENCE. If a future SDK release flattens the response to `Message[]` (moving `parts` inside `info`), the access `m.parts` would suddenly resolve to `undefined` and `.filter().map().join()` would silently produce an empty string — `evaluateByTranscript` would then mark the goal as not-met (heuristic confidence 0.5), and the agent would be nudged again, looping forever.

**The "filter `.role === 'assistant'` then read `.parts`" pattern only happens to work because both fields are at the same depth on the same wrapper object.** That's a fragile invariant pinned by a type-system hole.

**Root-cause fix:**

Replace `as any[]` with the actual SDK shape:

```ts
type SessionMessage = { info: Message; parts: Part[] };
const msgs = (res.data ?? []) as SessionMessage[];
const last = msgs.filter((m) => m?.info?.role === "assistant").at(-1);
if (!last) return "";
return (last.parts ?? []).filter((p) => p.type === "text").map((p) => p.text).join("\n");
```

`Message` and `Part` are already exported from `@opencode-ai/sdk`; the import line at server.ts:18-19 would need to be extended with `import type { Message, Part } from "@opencode-ai/sdk"`. The `as any` on `p` and `p.text` would then be removable.

**Severity:** Defect (the cast hides a real shape contract; the access pattern works today but is one SDK release away from breaking silently).

**Regression test:** would be straightforward — a unit test that imports the SDK's `SessionMessagesResponses` type, calls `getLatestAssistantText` with a mock returning the documented shape, and asserts the joined text is correct. Today the test (`test/server-verify.test.mjs`) uses `mockClient` returning `{ data: [] }` — a 0-element path that doesn't exercise the shape at all.

---

## B-2 [WORKAROUND-OK] `command.execute.before` part cast is documented and defensible

**File:** `src/server.ts:833`
**Type source:** `@opencode-ai/plugin/dist/index.d.ts:228-234`, `@opencode-ai/sdk/dist/gen/types.gen.d.ts:142-353`

```ts
// server.ts:822-835
"command.execute.before": async (input, output) => {
  if (input.command !== "goal") return;
  const text = dispatchGoalCommand(directory, input.arguments ?? "");
  // ... comment about host behavior ...
  const part = { type: "text", text } as unknown as (typeof output.parts)[number];
  output.parts = [...output.parts, part];
},
```

**The hook contract:**

```ts
// plugin/index.d.ts:228-234
"command.execute.before"?: (input: {
    command: string;
    sessionID: string;
    arguments: string;
}, output: {
    parts: Part[];
}) => Promise<void>;
```

`output.parts` is `Part[]`, where `Part` is the discriminated union:

```ts
// types.gen.d.ts:345-353
export type Part = TextPart | {
    id: string; sessionID: string; messageID: string;
    type: "subtask"; prompt: string; description: string; agent: string;
} | ReasoningPart | FilePart | ToolPart | StepStartPart | StepFinishPart | SnapshotPart | PatchPart | AgentPart | RetryPart | CompactionPart;
```

`TextPart` (line 142) requires:

```ts
{ id: string; sessionID: string; messageID: string; type: "text"; text: string; ... }
```

**Why the cast is needed:** the plugin pushes `{type: "text", text}` — a structurally valid *input* shape — without `id`, `sessionID`, or `messageID`. The `as unknown as` is a deliberate contract claim that the host fills those fields in after the hook returns.

**The "OpenCode fills id/sessionID/messageID" assumption is unverified.** I have read the plugin and SDK types but not the OpenCode host source. The red-team explicitly noted "this can only be confirmed against a live OpenCode — see the smoke test in the README" (red-team-report.md:32-34). I have not run that smoke test.

**My assessment of risk:**

- If the host *does* re-ID parts: cast is correct, ship it.
- If the host treats `output.parts` as the final value and dispatches it as-is: the part lands in the conversation with `id=undefined`, `sessionID=undefined`, `messageID=undefined`. The agent will see a text part; the TUI/Desktop renderer will display it. The undefined IDs are a probable null-deref crash on the next render of that message in the UI (the renderer indexes parts by `id`/`sessionID`).
- If the host silently drops malformed parts: the `/goal` command would invoke `dispatchGoalCommand` (a side effect — a tool call result, a state write), the user would see a "could not parse command" error, and the goal would not be set. No crash, but broken UX.

**The two-site append pattern is the right defense.** The plugin does `output.parts = [...output.parts, part]` (line 834) rather than `output.parts = [part]`. If the host puts preamble parts (icon, slash descriptor) on the original array, the plugin preserves them and appends. If the host treats `output.parts` as the final value, the plugin doesn't clobber existing parts.

**Recommendation:**

1. Keep the cast. It is documented in the comment (server.ts:825-832) and the reason is clear.
2. Add a test that constructs a minimal mock host invoking the hook and verifies the appended part structure. This pins the contract locally so a future SDK change is detected.
3. The v0.4.1 changelog should reference the live smoke test as the canonical proof.

**Severity:** Workaround-OK. Cast is defensible; the only risk is the live-test gap.

---

## B-3 [DEFECT] Missing event handlers for `session.compacted`, `session.deleted`, `session.error`, `session.created` cause state-file drift

**File:** `src/server.ts:837-886` (event hook)
**Type source:** `@opencode-ai/plugin/dist/index.d.ts:175-178`, `@opencode-ai/sdk/dist/gen/types.gen.d.ts:413-524` (event types)

**The plugin's event switch (server.ts:851-885):**

```ts
switch (event.type) {
    case "permission.updated":   // line 852
    case "permission.replied":   // line 857
    case "session.idle":         // line 862
    default: return;             // line 883
}
```

**Events the SDK defines that the plugin ignores:**

From `Event` (types.gen.d.ts:602) — the plugin handles 3 of 30:

| Event type | Defined at | Plugin handles? | Drift risk? |
|---|---|---|---|
| `session.idle` | 413 | ✓ | — |
| `session.compacted` | 419 | ✗ | **HIGH** (see below) |
| `session.status` (busy/retry) | 406 | ✗ | MEDIUM (debounce window confusion) |
| `session.created` | 493 | ✗ | MEDIUM (multiple sessions in one dir) |
| `session.deleted` | 505 | ✗ | MEDIUM (state file for deleted session lingers) |
| `session.updated` | 499 | ✗ | LOW |
| `session.error` | 518 | ✗ | **HIGH** (loop keeps nudging an errored session) |
| `session.diff` | 511 | ✗ | LOW |
| `message.updated/removed/part.*` | 129-367 | ✗ | LOW |
| `file.edited` | 425 | ✗ | LOW |
| `todo.updated` | 449 | ✗ | LOW |
| `command.executed` | 456 | ✗ | LOW |
| `pty.*` (4 events) | 571-594 | ✗ | LOW |
| `tui.*` (3 events) | 538-561 | ✗ | LOW |
| `server.*` (4 events) | 596+ | ✗ | LOW |
| `lsp.*` (2) | — | ✗ | LOW |
| `file.watcher.updated` | 525 | ✗ | LOW |
| `vcs.branch.updated` | 532 | ✗ | LOW |
| `installation.*` (2) | — | ✗ | LOW |

**Three events are real defect territory:**

### B-3a `session.compacted` — drift in the `lastEvaluationTime` / `isEvaluating` debounce

The plugin already uses the `experimental.session.compacting` hook to push the goal back into the LLM context. But the **PLUGIN'S OWN state** is not reset on compaction:

- `lastEvaluationTime` (server.ts:66) is closure-scoped to the plugin instance.
- `isEvaluating` (server.ts:67) is also closure-scoped.
- `pendingPermissions` (server.ts:69) — also closure-scoped, persisted across compaction.

After a compaction, the session resumes with a fresh `session.idle` event. The plugin's `isEvaluating` flag is whatever it was before. If it was `true` (mid-evaluation) when the compaction began, it stays `true` until the in-flight `evaluate()` promise resolves, and the `finally` block clears it. That's actually correct. ✓

BUT: the debounce timestamp `lastEvaluationTime` does NOT reset on compaction. If the session was last evaluated at T, compaction happens at T+1s, and a new session.idle fires at T+2s, the debounce check `now - lastEvaluationTime < 5000` is `1000 < 5000 = true` → evaluation skipped. That's an unrelated bug (the debounce is supposed to handle rapid-fire idle bursts from a single session, not a compaction followed by a single idle).

The real issue: **the debounce has no compaction awareness.** A session that idles, compacts 1s later, and idles again 1s after that will be debounced for a full 5 seconds (or never re-evaluated) when it should resume work immediately.

**Severity:** MEDIUM. Affects long-running goals that hit the compaction boundary.

### B-3b `session.error` — loop continues nudging a session in a fatal state

```ts
// types.gen.d.ts:518-524
export type EventSessionError = {
    type: "session.error";
    properties: {
        sessionID?: string;
        error?: ProviderAuthError | UnknownError | MessageOutputLengthError | MessageAbortedError | ApiError;
    };
};
```

When a session hits a `ProviderAuthError` (bad API key) or `MessageAbortedError`, the session is essentially dead — the next `session.idle` will fire (the session is, after all, idle now), and the plugin will try to nudge it. The nudge will be queued by the host but never executed, OR will fail and produce another `session.error` in a tight loop.

The plugin's `event` switch has no `case "session.error":` — it falls through to `default: return;`. The state file is never updated to reflect "session is in error" — the goal keeps status="active", and the auto-loop keeps trying to push prompts that the dead session will never process.

**Severity:** HIGH. A user with a stuck auth error would see the goal state pinned to "active" indefinitely with no indication the session is in error.

**Fix proposal:** handle `session.error` by transitioning the goal to "paused" with reason "Session error: <error message>" and firing a webhook on the active→paused transition. The user can then manually fix the API key and `resume_goal` to continue.

### B-3c `session.deleted` — state file for a deleted session lingers

If the user deletes the session in the TUI (or via `client.session.delete` from another plugin), the state file persists. A new session created later in the same directory will find the lingering state and the plugin will try to nudge the new session toward the old goal. If the new session's sessionID doesn't match, the next webhook/notification fires on a session that has no context for the goal — confusing to the user.

**Severity:** MEDIUM. Mitigation is a "stale session" check (read state file, if `state.lastEvaluation.timestamp` is older than N hours and the session was never paused manually, treat as abandoned). The v0.4.0 design does not implement this.

### B-3d `session.created` — multi-session fan-in

If a user starts a second session in the same directory (e.g. a parallel "research" session while the main "implementation" session is running its goal), the new session's events will fire into the same plugin instance. The `pendingPermissions` map is per-`(sessionID, permissionID)` and correctly isolates per-session. The `isEvaluating` / `lastEvaluationTime` lock, however, is **shared across sessions** in the same plugin instance.

Sequence:

1. Session A's turn finishes → `session.idle` fires.
2. Plugin starts `evaluate(stateA, sessionA)`, sets `isEvaluating = true`, `lastEvaluationTime = T1`.
3. Session B's turn finishes 100ms later → `session.idle` fires.
4. Plugin sees `isEvaluating = true` → returns immediately. Session B's evaluation is **lost** (not deferred — `event` is fire-and-forget, the idle event is consumed).
5. After A's evaluation finishes, `isEvaluating = false`. Session B will not see another idle event until it next turns idle (which could be never, if the user moved on).

**Severity:** MEDIUM. Affects multi-session workflows. The fix is per-session evaluation queues or a re-debounce after a session.idle burst from a different session.

**Aggregate B-3 severity:** HIGH collectively, MEDIUM individually. Worth a v0.4.1 backlog item.

---

## B-4 [WORKAROUND-OK] `experimental.session.compacting` `output.context.push` is the documented shape

**File:** `src/server.ts:888-908`
**Type source:** `@opencode-ai/plugin/dist/index.d.ts:283-288`

```ts
// plugin/index.d.ts:283-288
"experimental.session.compacting"?: (input: {
    sessionID: string;
}, output: {
    context: string[];
    prompt?: string;
}) => Promise<void>;
```

The plugin does `output.context.push(...)` with a single concatenated string (line 903-907). The contract is clear from the JSDoc:

```
* - `context`: Additional context strings appended to the default prompt
```

Pushing is the documented pattern. ✓

**Minor concern (B-9 below):** the input `sessionID` is destructured as `_input` and ignored. If the plugin instance serves multiple sessions (multi-workspace OpenCode server, or a parent + child session.fork), the hook injects the SAME state-file goal into compaction context for every session. The state is per-directory, not per-session, so this is probably intentional — but the `_input` should be commented as "intentionally unused; goal is per-directory, not per-session" for clarity.

**Severity:** Workaround-OK. Documented contract. The `input.sessionID` ignore is a smell (B-9), not a bug.

---

## B-5 [DEFECT] `client.session.prompt` "goal achieved" claim is fire-and-forget on a swallowed error

**File:** `src/server.ts:439-455`
**Type source:** `@opencode-ai/sdk/dist/gen/types.gen.d.ts:2244-2289`

```ts
// server.ts:439-455
await client.session
  .prompt({
    path: { id: sessionId },
    body: {
      parts: [
        {
          type: "text",
          text: `[GOAL] Not yet met (${safeReason}). Keep working toward: ${safeConditionForNudge}\n` +
                `When satisfied, write a line beginning "GOAL_COMPLETE:" with the evidence. ` +
                `If truly blocked, write a line beginning "GOAL_BLOCKED:" explaining why.` +
                steerSuffix,
        },
      ],
    },
  })
  .catch((err) => log("error", "Failed to inject continue prompt", { error: String(err) }));
```

**The pattern is the same as `notify` (line 82-84):** any error from `session.prompt` is caught and logged. The caller does not propagate or retry.

**For the `notify` path** (toast + visible message), this is fine — the user already saw a toast and the message is non-critical.

**For the continue-prompt path**, the implication is worse than the comment suggests. This is the path that drives the auto-loop. If the prompt fails to deliver:

1. The plugin logged "Failed to inject continue prompt" — but the user never sees it (logs go to host stderr, not to the user).
2. The session goes idle. The next `session.idle` fires. The plugin runs the debounce check (5s window). If the last attempt was < 5s ago, evaluation is SKIPPED. If it was > 5s ago, evaluation runs, computes the goal is not met, tries to inject again, fails again, logs again. The loop has no feedback to the user that the nudge is being silently dropped.
3. From the user's perspective: the goal is "active" but the agent never receives nudges. The user sees a stale `lastEvaluation` timestamp and no progress. They may assume the agent is making slow progress when in fact the loop is broken.

**The line the brief specifically called out:**

> "a failed `writeGoalStateAtomic` followed by a `client.session.prompt` that says 'goal achieved' would lie to the user"

Looking at the achieved path (server.ts:398-411):

```ts
if (snapshot.achieved) {
  const achievedState = readGoalState(directory);
  if (achievedState) fireWebhook(achievedState, "active");
  await notify(sessionId, "Goal achieved", snapshot.reason, "success");
  const chainResult = advanceGoalChain(directory);
  // ...
}
```

The `fireWebhook` is called BEFORE `notify`. If `fireWebhook` succeeds (POST sent, 5xx response) but the state has a corrupt webhook config that the receiver rejects, the `notify` proceeds and tells the user "Goal achieved." That's not a `client.session.prompt` lying to the user, but it IS a state-mutation that "succeeded" with side effects that contradict the goal condition.

The deeper lie scenario the brief is gesturing at:

```ts
// server.ts:382-387
if (evaluation.met) {
  f.status = "achieved";
  f.completedAt = Date.now();
  writeGoalStateAtomic(directory, f);
  return { achieved: true as const, reason: evaluation.reason };
}
```

If `writeGoalStateAtomic` THROWS (disk full, EACCES, ENOSPC, race with concurrent write), the error propagates up to the `try/catch` at line 456-458:

```ts
} catch (err) {
  log("error", "Evaluation loop failed", { error: String(err) });
} finally {
  isEvaluating = false;
}
```

`log` calls `client.app.log().catch(() => {})` (line 73). If the LOG ITSELF fails (host shutdown), the error is silently swallowed. The state is "achieved" in the IIFE's local `f` object (line 384 wrote `f.status = "achieved"` BEFORE `writeGoalStateAtomic` on line 385) — but the persisted state on disk is the PRIOR state. The `notify` and `advanceGoalChain` were not reached because the error threw out of the IIFE.

But the user-facing concern: the `notify` for "Goal achieved" is on line 402 — INSIDE the try, AFTER the IIFE returns. The IIFE either returns `{ achieved: true, reason }` (on success) or throws (on `writeGoalStateAtomic` failure). On failure, the IIFE throws, the outer catch catches, and the user is never told "achieved." So the "lies to the user" scenario doesn't actually play out as described.

**The real defect:** the `client.session.prompt` at line 439 swallows the error. If the prompt fails, the loop silently does nothing on subsequent `session.idle` events (until the debounce window expires and a new attempt is made, which also fails). The user has no signal that the loop is broken.

**Fix proposal:**

```ts
try {
  await client.session.prompt({ ... });
} catch (err) {
  log("error", "Failed to inject continue prompt", { error: String(err) });
  // Also write a transient marker to the state file so the user can see
  // "last nudge attempt failed at <timestamp>" in the GUI/sidebar.
  // This makes the broken-loop state observable.
}
```

Or, at minimum, count consecutive prompt failures and pause the goal after N failures (e.g. N=3) with a webhook on the active→paused transition. The user gets a notification "Goal paused: nudge failed 3 times."

**Severity:** MEDIUM. Real silent-failure risk on flaky connections. The "lie to user" framing in the brief is too strong (the achieved path doesn't actually lie on failure), but the swallowed-error pattern is still a defect.

---

## B-6 [WORKAROUND-OK] All four `client.*` calls are documented and correctly signed

**File:** `src/server.ts` (lines 73, 81-84, 138, 439-455)
**Type source:** `@opencode-ai/sdk/dist/gen/types.gen.d.ts:2842, 3264, 2209, 2244`

I cross-referenced each call site against the SDK type definitions. All four use the documented `body`/`path`/`query` envelope, all field types match, all required fields are present, and no documented field is dropped.

### B-6a `client.app.log` (server.ts:73)

```ts
// types.gen.d.ts:2842-2868
export type AppLogData = {
    body?: {
        service: string;
        level: "debug" | "info" | "error" | "warn";
        message: string;
        extra?: { [key: string]: unknown };
    };
    path?: never;
    query?: { directory?: string };
    url: "/log";
};
```

Plugin invocation:

```ts
// server.ts:71-74
function log(level: "debug" | "info" | "warn" | "error", message: string, extra?: any) {
  if (!CONFIG.debug && level === "debug") return;
  client.app.log({ body: { service: "opencode-autogoal", level, message: `[goal] ${message}`, extra } }).catch(() => {});
}
```

`level` is `"debug" | "info" | "warn" | "error"` — the SDK expects `"debug" | "info" | "error" | "warn"`. The set of values is identical (just the order differs in the type definition); the runtime value passes through unchanged. ✓

`extra` typed as `any` in the plugin — the SDK expects `Record<string, unknown>`. The `any` widens the type but at runtime any value is accepted. ✓

`.catch(() => {})` is intentional: log failures should not crash the plugin. ✓

### B-6b `client.tui.showToast` (server.ts:81)

```ts
// types.gen.d.ts:3264-3279
export type TuiShowToastData = {
    body?: {
        title?: string;
        message: string;
        variant: "info" | "success" | "warning" | "error";
        duration?: number;
    };
    path?: never;
    query?: { directory?: string };
    url: "/tui/show-toast";
};
```

Plugin invocation:

```ts
// server.ts:80-85
async function notify(sessionId: string, title: string, message: string, variant: "info" | "success" | "warning" | "error") {
  await client.tui.showToast({ body: { title, message, variant } }).catch(() => {});
  // ...
}
```

All required fields present (`message`, `variant`); `title` and `duration` are optional and omitted. ✓

The `.catch(() => {})` is intentional: the TUI is not the primary surface (the in-conversation message is). Toast failures are non-critical. ✓

The variant union matches the SDK's union exactly. ✓

### B-6c `client.session.prompt` x2 (server.ts:82-84, 439-455)

```ts
// types.gen.d.ts:2244-2268
export type SessionPromptData = {
    body?: {
        messageID?: string;
        model?: { providerID: string; modelID: string; };
        agent?: string;
        noReply?: boolean;
        system?: string;
        tools?: { [key: string]: boolean; };
        parts: Array<TextPartInput | FilePartInput | AgentPartInput | SubtaskPartInput>;
    };
    path: { id: string; };
    query?: { directory?: string };
    url: "/session/{id}/message";
};
```

Plugin invocations:

**Call 1 (server.ts:82-84)** — the `notify` path:
```ts
await client.session
  .prompt({ path: { id: sessionId }, body: { noReply: true, parts: [{ type: "text", text: `🎯 [${title}] ${message}` }] } })
  .catch((err) => log("error", "notify (session message) failed", { error: String(err) }));
```

`path.id` is the session ID. ✓
`body.noReply: true` — the SDK accepts `noReply?: boolean`. ✓
`body.parts: [{type: "text", text: "..."}]` — the SDK accepts `TextPartInput` (types.gen.d.ts:1231-1244), which requires `type: "text"` and `text: string`, both present. ✓
`.catch` is documented (see B-5 for the swallowed-error concern).

**Call 2 (server.ts:439-455)** — the continue-prompt path. Same shape. ✓

**Note:** `parts` could be `TextPartInput | FilePartInput | AgentPartInput | SubtaskPartInput` (line 2257). The plugin uses ONLY `TextPartInput`. The cast `{type: "text", text} as ...` is unnecessary here — `TextPartInput` is exactly that shape. ✓ (No cast needed for this site.)

### B-6d `client.session.messages` (server.ts:138)

```ts
// types.gen.d.ts:2209-2242
export type SessionMessagesData = {
    body?: never;
    path: { id: string; };
    query?: { directory?: string; limit?: number; };
    url: "/session/{id}/message";
};
```

Plugin invocation:
```ts
const res = await client.session.messages({ path: { id: sessionId } });
```

`path.id` is the session ID. ✓
`query` omitted (the plugin does not constrain directory at this site — but see B-1 about the response shape mismatch).

**Aggregate B-6:** all four calls are signed correctly. The `.catch(() => {})` patterns are intentional. The only real defect in this neighborhood is the `as any[]` on the `session.messages` response, covered in B-1.

---

## B-7 [WORKAROUND-OK] `default: return` exhaustiveness comment is accurate

**File:** `src/server.ts:874-884`

```ts
// All other event types are intentionally unhandled. The `default`
// case is a defensive no-op so a future SDK event (one not in the
// TypeScript discriminated union at compile time) cannot crash
// the plugin at runtime. ...
default:
  return;
```

The comment correctly explains the design rationale. The `switch` is exhaustive at compile time (TS will fail compilation if a new variant is added to `Event`); the `default` covers the runtime gap (a runtime event whose type the type system doesn't know about). ✓

**Caveat:** the comment claims "a future SDK release could add a new event type without a corresponding type update." This is a hypothetical. In practice, the `@opencode-ai/sdk` and `@opencode-ai/plugin` packages are versioned together, and adding a new event type without updating the type union would be a packaging bug, not a feature. The `default` is still good defensive coding. ✓

**Severity:** Workaround-OK. Comment is accurate.

---

## B-8 [SMELL] `isEvaluating` and `lastEvaluationTime` are per-PLUGIN-INSTANCE, not per-SESSION

**File:** `src/server.ts:66-67, 309-316, 459`

Already covered in B-3d. Restated here as a discrete finding for the "isolation" line of inquiry.

The lock state variables are closure-scoped. Multiple sessions sharing a plugin instance (e.g. two sessions in the same directory, or a parent + child from session.fork) share the same lock. The first session to start evaluation blocks subsequent sessions for the entire debounce window. If session A's evaluation takes 30s and session B idles at the 5s mark, session B is **lost** — not deferred, the `event` callback returned, the idle event was consumed.

**Severity:** SMELL. Not a defect for single-session workflows (the common case). Becomes a defect only in multi-session setups.

**Fix proposal:** per-session evaluation locks, keyed by `sessionID`. The lock map can be a `Map<string, { isEvaluating: boolean, lastEvaluationTime: number }>`. The debounce check becomes per-session.

---

## B-9 [SMELL] `experimental.session.compacting` ignores `input.sessionID`

**File:** `src/server.ts:888-908`

```ts
"experimental.session.compacting": async (_input, output) => {
  // ...
  const state = readGoalState(directory);
  if (!state || (state.status !== "active" && state.status !== "paused")) return;
  // ... builds the context string from state ...
  output.context.push(/* the string */);
},
```

The hook receives `input.sessionID` (per the type at plugin/index.d.ts:284) and discards it as `_input`. The state is read from the directory-level state file, which is shared across all sessions in the directory. If a user starts a second session in the same directory (e.g. a parallel "research" session), the compacting hook injects the active goal into the new session's context too. This is probably the intended behavior (goals are per-directory, not per-session), but it's not commented as such.

**Severity:** SMELL. Not a bug. The `_input` should be renamed to `_input: { sessionID }` or commented to clarify "intentionally unused — goal is per-directory, not per-session."

---

## B-10 [WORKAROUND-OK] `cli.ts:408` `as unknown as number` cast is benign

**File:** `src/cli.ts:408`

```ts
readFd = process.stdin.fd as unknown as number;
```

`process.stdin.fd` is typed as `number` in modern @types/node but historically was typed as `number | null` (or wrapped in a NodeJS.ReadStream). The cast works around that legacy type. The runtime value is always a number. ✓

This is in `cli.ts`, which is a different surface from the server plugin, but I checked it for completeness because the brief asks for a full `src/` scope.

**Severity:** Workaround-OK.

---

## B-11 [SMELL] `res.data ?? []` short-circuit on `session.messages` is dead-code defensive

**File:** `src/server.ts:138-139`

```ts
const res = await client.session.messages({ path: { id: sessionId } });
const msgs = (res.data ?? []) as any[];
```

The SDK type for `SessionMessagesResponses[200]` is `Array<{info, parts}>` — always an array. The `?? []` only fires if `res.data` is `null` or `undefined`. The `RequestResult` envelope from `@hey-api/client` typically has `data` as `T | undefined` (for `throwOnError: true` mode) — so the `?? []` is defensive against the SDK returning `undefined` for a successful response (which it shouldn't, but the type allows it).

**Severity:** SMELL. Defensive code is fine; the cast hides the actual problem (the data IS the array, not `any`).

**Fix proposal:** drop the `?? []` (rely on the SDK guarantee) and replace `as any[]` with the actual shape per B-1.

---

## Summary table

| ID | File:line | Severity | Description |
|---|---|---|---|
| B-1 | server.ts:139 | **DEFECT** | `as any[]` on `session.messages` response hides a real shape contract violation. Access pattern works today by coincidence; one SDK release away from breaking. |
| B-2 | server.ts:833 | WORKAROUND-OK | `command.execute.before` part cast is a deliberate contract claim. The "host fills id/sessionID/messageID" assumption is unverified without live testing. |
| B-3a | server.ts:837-886 | MEDIUM | `session.compacted` not handled → debounce window confusion post-compaction. |
| B-3b | server.ts:837-886 | **DEFECT** | `session.error` not handled → loop continues nudging a dead session indefinitely. |
| B-3c | server.ts:837-886 | MEDIUM | `session.deleted` not handled → state file lingers for a deleted session. |
| B-3d | server.ts:837-886 | MEDIUM | `session.created` not handled → multi-session in one directory shares the per-instance `isEvaluating` lock. |
| B-4 | server.ts:888-908 | WORKAROUND-OK | `output.context.push` matches the documented compacting hook contract. |
| B-5 | server.ts:439-455 | **DEFECT** | `client.session.prompt` continue-prompt path swallows errors. The achieved-path "lie" scenario is not as bad as the brief suggested, but the silent-failure pattern is real. |
| B-6 | server.ts:73, 81, 138, 439 | WORKAROUND-OK | All four `client.*` calls are signed correctly. The `.catch(() => {})` patterns are intentional. |
| B-7 | server.ts:883-884 | WORKAROUND-OK | `default: return` in event switch is good defensive coding; comment is accurate. |
| B-8 | server.ts:66-67, 309-316 | SMELL | `isEvaluating` / `lastEvaluationTime` are per-PLUGIN-INSTANCE, not per-SESSION. |
| B-9 | server.ts:888 | SMELL | `experimental.session.compacting` ignores `input.sessionID` without a comment explaining why. |
| B-10 | cli.ts:408 | WORKAROUND-OK | `process.stdin.fd as unknown as number` is a legacy type workaround. |
| B-11 | server.ts:138-139 | SMELL | `res.data ?? []` is dead-code defensive; the real problem is the cast. |

---

## Recommendations (v0.4.1 backlog)

Priority order based on user impact and likelihood:

1. **B-3b (session.error handler)** — HIGH. The simplest fix: in the event switch, add a `case "session.error"` that reads the state and, if active, transitions it to "paused" with reason "Session error: <message>". This stops the auto-loop from nudging a dead session and surfaces the error to the user via the existing webhook + notify mechanism.

2. **B-1 (replace `as any[]` with the actual SDK shape)** — MEDIUM. Fix the cast, drop the `?? []`, narrow the `p: any` to `p: Part`. Adds a regression test that the access pattern survives a mock returning the documented `Array<{info, parts}>` shape.

3. **B-5 (surface silent prompt failures)** — MEDIUM. After N consecutive failures, transition the goal to "paused" with a "nudge delivery failed" reason. Or simpler: include the failure count in the next prompt's text so the user (and the next state read) can see it.

4. **B-3a, B-3c, B-3d (other missing lifecycle handlers)** — backlog. Each is a one-case-add to the event switch. Together they would close the state-file drift surface.

5. **B-8 (per-session evaluation locks)** — backlog. Touches the lock semantics; needs design.

6. **B-9 (comment the unused `input.sessionID`)** — one-line change. Ship whenever someone touches that hook next.

7. **B-11 (drop `?? []`)** — bundled with B-1.

---

## What I did NOT verify

- **Live behavior of `command.execute.before` part ID-filling.** This is the single biggest unverified assumption in the codebase. The v0.4.0 README smoke test is the only documentation; I have not run it. A v0.4.1 task should add a programmatic test that constructs a mock host invoking the hook and asserts the appended part's `id`/`sessionID`/`messageID` are populated.
- **OpenCode host source.** I read the plugin and SDK types; the host source is not in `node_modules`. Some "workaround" verdicts here may be wrong if the host has undeclared behavior.
- **Multi-workspace OpenCode deployments.** The plugin's `directory` is per-instance, so cross-directory isolation is enforced at the OpenCode server level. I have not tested that. If a user runs two OpenCode servers on the same machine with the plugin loaded in both, the event hooks fire for each instance separately — no cross-instance leakage. ✓ (Confirmed by code reading; not by runtime test.)
