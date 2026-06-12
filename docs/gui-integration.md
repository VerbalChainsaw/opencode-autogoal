# GUI Integration — opencode-autogoal v0.3.0

This document is the contract for any GUI that wants to render the
AutoGoal plugin's state. The canonical consumer is the OpenCode
Desktop "Goals" tab (`packages/app/src/components/session/goal-tab.tsx`
in the `VerbalChainsaw/opencode` fork), but the contract is host-agnostic
— any web component, native widget, or CLI dashboard can implement
against it.

## The data contract

There is exactly one source of truth: the state file at
`.opencode/.goal-state.json`. The shape is the `GoalState` interface
in `src/goal-state.ts`. It is:

```typescript
interface GoalState {
  version: number;
  id: string;
  condition: string;
  command: string | null;
  status: "active" | "paused" | "achieved" | "cleared";
  createdAt: number;
  startedAt: number;
  completedAt: number | null;
  pausedAt: number | null;
  resumedAt: number | null;
  turnsEvaluated: number;
  tokensUsed: number;
  lastEvaluation: GoalEvaluation | null;
  evaluationHistory: GoalEvaluation[];  // capped at 10
  constraints: {
    maxTurns: number;          // [1, 10_000]
    maxTimeMinutes: number;    // [1, 10_000]
    maxTokens: number;         // [1, 10_000_000]
  };
  metadata: {
    setBy: "user" | "template" | "chain";
    sessionId?: string;
    agentName?: string;
    // v0.2.0+ optional fields:
    conditionEditedAt?: number;
    previousId?: string;
    restartedAt?: number;
    steering?: Array<{ at: number; note: string }>;  // capped at 20
    resumedFromHandoffAt?: number;
  };
}

interface GoalEvaluation {
  met: boolean;
  reason: string;        // 200-char cap; sanitized for prompt injection
  confidence: number;     // [0.0, 1.0]
  timestamp: number;
  evaluatorType: "deterministic" | "model" | "heuristic";
  blocked?: boolean;      // true if the agent signalled GOAL_BLOCKED
  rawOutput?: string;     // up to 1000 chars
}
```

Read this with `JSON.parse(stateFileContent)`. Validate with
`validateGoalState(state)` (re-exported from the plugin's `./goal-state.js`
subpath export). If the validator returns false, treat the state as
corrupt and render an empty-state placeholder.

The state file may legitimately be missing (no goal set yet). Treat
that as "empty state" — the file's existence is NOT a precondition
for the GUI to render.

## The live-update mechanism (polling)

The OpenCode plugin has no event-emit API for live state updates.
The GUI must poll. The recommended pattern is a `setInterval` at
**2 seconds**; that's a reasonable trade-off between freshness and
the host's resource budget.

The polling call is the `goal_get_state` tool. From the GUI
SolidJS side, you call it via the OpenCode SDK:

```typescript
import { useSDK } from "@/context/sdk";

const sdk = useSDK();
const directory = useDirectory();  // the project root
const [state, setState] = createSignal<GoalState | null>(null);

async function refresh() {
  // The SDK client exposes plugin tools via client.tool.invoke or
  // similar. The exact API shape depends on the OpenCode version.
  // For v0.3.0+ the call is:
  const raw = await sdk.client.tool.invoke("goal_get_state", { directory });
  if (raw === "null" || !raw) {
    setState(null);
  } else {
    const parsed = JSON.parse(raw);
    setState(parsed);
  }
}

onMount(() => {
  refresh();
  const interval = setInterval(refresh, 2000);
  onCleanup(() => clearInterval(interval));
});
```

(If the SDK in your OpenCode version doesn't have `tool.invoke`,
adapt to the equivalent. The `goal_get_state` tool is registered
whenever the opencode-autogoal plugin is loaded; check
`sdk.client.tool.list()` for the available tools.)

## The dial surface (write side)

The GUI can mutate goal state by invoking the dials as tools. The
plugin exposes these:

| Tool | Args | Returns |
|---|---|---|
| `set_goal` | `{condition, command?, maxTurns?, maxMinutes?}` | The new state (as a stringified goal description) |
| `goal_get_state` | (none) | JSON string of the current state or "null" |
| `goal_status` | (none) | A short human-readable status string |
| `clear_goal` | (none) | Confirmation string |
| `pause_goal` | (none) | Confirmation string |
| `resume_goal` | (none) | Confirmation string |
| `goal_turns` | `{n}` | Confirmation string (n in [1, 10000]) |
| `goal_time` | `{n}` | Confirmation string (n in [1, 10000]) |
| `goal_tokens` | `{n}` | Confirmation string (n in [1, 10000000]) |
| `goal_condition` | `{text}` | Confirmation string |
| `goal_steer` | `{text}` | Confirmation string |
| `goal_clear_steering` | (none) | Confirmation string |
| `goal_restart` | (none) | Confirmation string |
| `goal_handoff` | `{note?}` | Confirmation string |
| `goal_claim` | (none) | Confirmation string |
| `goal_webhook` | `{url?, on?, allowLocal?}` | Confirmation string — set/clear notification webhook |

The `goal_*` dial tools are the v0.2.0+ dials. All return strings
suitable for displaying in a toast. For a true dialog-based
interaction (with confirm/cancel), use the TUI keymap commands
`/goal-turns`, `/goal-restart`, etc. — those have the same backend
primitives.

The 5 transition tools (`set_goal`, `goal_status`, `clear_goal`,
`pause_goal`, `resume_goal`) are the v0.1.0+ conversational tools.

## Rendering the readouts

A reasonable Goals tab renders (at minimum):

```
┌─────────────────────────────────────────┐
│  GOALS                       [icon]      │  ← sidebar_title
├─────────────────────────────────────────┤
│  🎯 "make all tests pass"               │  ← sidebar_content
│  ███████████░░░░░░░░░░ 55%  11/20 turns  │
│  turns:  11/20    time:   5/30m          │
│  tokens: 12,345/100,000  last: tests pass│
│  ──── eval history ────                  │
│  ✓  tests pass                           │
│  ·  compiling                            │
│  ·  reading test files                   │
│  2 steer notes    ⤴ handoff             │
│  last edit: 3m ago                       │
├─────────────────────────────────────────┤
│  dials: /goal-turns · /goal-steer · ...  │  ← sidebar_footer
└─────────────────────────────────────────┘
```

The dials in the footer are the *slash command names* (which the
TUI keymap binds), not direct invocations. A real working GUI
should:

1. Render the readouts from `state` (polled every 2s)
2. On user action (click a button), invoke the corresponding tool
3. Force a refresh of the polled state

## Edge cases

- **State file missing**: render an empty-state placeholder with
  "Set a goal with `/goal set '<condition>'`" or "Click here to set
  a goal" (GUI-invokes the `set_goal` tool).
- **State file corrupt** (validator returns false): render an error
  banner with the path. Don't render the readouts — they'll be
  nonsensical.
- **No plugin installed**: the `goal_get_state` tool call will fail.
  Catch the error in `refresh()` and render "AutoGoal plugin not
  installed" in the tab.
- **Terminal state** (status `achieved` or `cleared`): show the
  read-only readouts, gray out the dials. The plugin doesn't allow
  editing terminal-state goals.
- **Goal was just edited**: the next poll (within 2s) will show
  the new condition. No special-casing needed.

## Security

The state file is user-controlled (anyone with write access to the
project can plant one). The plugin's `validateGoalState` enforces
shape and array-length caps. The `claimHandoff` and `restartGoal`
primitives rebuild metadata from a fixed allowlist (`sanitizeMetadata`)
and route the condition and steering notes through `sanitizeForPrompt`
before any prompt-surface interpolation. The GUI is a READ consumer;
the dials go through the plugin's primitives which handle all
sanitization. **Do not render raw `metadata.steering[].note` without
running it through `sanitizeForPrompt` first** (the plugin's
`./goal-state.js` exports this).

## Versioning

The data contract is the public API. Backward-incompatible changes
to `GoalState` are a major version bump (v0.3 → v0.4). The
plugin's `state.version` field on disk is independent of the npm
package version — it's the in-file schema version, currently `1`.
The plugin tolerates older state files (no `version` field defaults
to 1).
