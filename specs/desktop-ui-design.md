# Goal Panel — Desktop UI Design Specification

> **Status:** Design Phase  
> **Target:** OpenCode Desktop (packages/app + packages/server)  
> **Package:** opencode-goal v0.2.0

---

## 1. Architecture Overview

The goal panel lives in the **session right sidebar** (`session-side-panel.tsx`) as a new tab alongside Review, Context, and file tabs. It reads goal state from `.opencode/.goal-state.json` via the server client, subscribes to SSE events for live updates, and offers pause/resume/clear controls without leaving the session view.

```
┌──────────────┐  ┌───────────────────────────────────┐  ┌──────────────────┐
│ Left Sidebar │  │        Session Conversation        │  │  RIGHT SIDEBAR   │
│ (projects)   │  │  ┌───────────────────────────────┐ │  │                  │
│              │  │  │  Message Timeline             │ │  │ ┌──────────────┐ │
│              │  │  │                               │ │  │ │ Tabs:        │ │
│              │  │  │  🎯 [Goal achieved] ...       │ │  │ │ Review│Goal  │ │
│              │  │  │                               │ │  │ │────────────────│ │
│              │  │  │                               │ │  │ │              │ │
│              │  │  └───────────────────────────────┘ │  │ │  GOAL PANEL  │ │
│              │  │  ┌───────────────────────────────┐ │  │ │              │ │
│              │  │  │  Prompt Input                 │ │  │ │  condition   │ │
│              │  │  └───────────────────────────────┘ │  │ │  progress    │ │
└──────────────┘  └───────────────────────────────────┘  │ │  controls    │ │
                                                          │ │              │ │
                                                          │ └──────────────┘ │
                                                          └──────────────────┘
```

### Integration point (validated against source)

The tab insertion point is between the Review trigger and Context trigger in `SessionSidePanel`:

```tsx
// session-side-panel.tsx, line ~268-277 (currently):
<Show when={reviewTab() && props.canReview()}>
  <Tabs.Trigger value="review">...</Tabs.Trigger>
</Show>
// ← NEW: Goal tab inserted here, shown when goalState != null
<Show when={goalActive()}>
  <Tabs.Trigger value="goal">...</Tabs.Trigger>
</Show>
<Show when={contextOpen()}>
  <Tabs.Trigger value="context">...</Tabs.Trigger>
</Show>
```

Content area follows the same pattern after the existing `<Tabs.Content>` blocks.

---

## 2. Component Tree

```
GoalPanel (new file: session/goal-panel.tsx)
├── GoalHeader
│   ├── status icon (🎯 / ⏸ / ✅ / ⚠)
│   ├── condition text
│   └── elapsed time badge
├── GoalProgressBar
│   ├── turn progress (filled/empty segments)
│   ├── time progress (if applicable)
│   └── percentage label
├── GoalControls
│   ├── [Pause] / [Resume]  (toggle, disabled if achieved/cleared)
│   └── [Clear]             (destructive, with confirm dialog)
├── GoalEvaluation
│   ├── latest evaluation reason
│   ├── evaluator type badge (deterministic / transcript)
│   └── confidence indicator (if model-based, future)
└── GoalHistory (collapsible)
    └── list of recent evaluations with timestamps
```

---

## 3. Data Flow

```
Server Plugin (src/server.ts)
  │
  │  writes .opencode/.goal-state.json
  │  emits SSE event: "goal.state.changed"
  ▼
OpenCode Server (packages/server)
  │
  │  SSE event stream (already exists via server-sdk.tsx)
  │  File read API: client.file.read({ path: ".opencode/.goal-state.json" })
  ▼
Desktop Renderer
  ├── server-sdk.tsx → event listener (catches "goal.state.changed")
  ├── createResource() → polls file via client.file.read() every 3s as fallback
  └── goal-panel.tsx → renders from reactive state
```

### Data contract (GoalState — TypeScript)

```ts
// Mirrors goal-state.ts types, used in both server plugin and renderer
interface GoalState {
  version: number;
  id: string;
  condition: string;
  command?: string | null;
  status: "active" | "paused" | "achieved" | "cleared";
  createdAt: number;
  startedAt: number;
  completedAt: number | null;
  pausedAt: number | null;
  turnsEvaluated: number;
  tokensUsed: number;
  lastEvaluation: {
    met: boolean;
    reason: string;
    confidence: number;
    timestamp: number;
    evaluatorType: "deterministic" | "model" | "heuristic";
  } | null;
  evaluationHistory: Array<...>;
  constraints: {
    maxTurns: number;
    maxTimeMinutes: number;
    maxTokens: number;
  };
}
```

### Server API additions needed

**New SSE event type:**

```ts
// Emitted by server plugin after every state mutation
type EventGoalStateChanged = {
  type: "goal.state.changed";
  properties: {
    state: GoalState;   // full state object
    previousStatus?: string;  // for transition animations
  };
};
```

**File read fallback:**

The renderer can already call `client.file.read()` — but the path `.opencode/.goal-state.json` may need to be relative to the workspace directory. The server plugin's `directory` parameter is the workspace root, and the file lives at `.opencode/.goal-state.json` relative to it. This path must be resolvable by the server's file API.

---

## 4. State Machine & Visual States

### 4.1 Tab visibility

| Goal state                   | Tab shown? | Badge            |
|------------------------------|------------|------------------|
| No file / status=cleared     | No         | —                |
| status=active                | Yes        | "active" dot     |
| status=paused                | Yes        | "paused" dot     |
| status=achieved              | Yes        | "✓" checkmark    |

### 4.2 Panel states

```
┌─ EMPTY ───────────────────────────────────────┐
│                                                │
│               🎯                               │
│     No active goal                             │
│     Set one with /goal set "condition"         │
│     --command "npm test"                       │
│                                                │
└────────────────────────────────────────────────┘

┌─ ACTIVE ──────────────────────────────────────┐
│  🎯  All unit tests pass                      │
│      5/20 turns · 8/30 min · ~45K tokens     │
│                                                │
│  ████████░░░░░░░░░░░░  40%                    │
│                                                │
│  Last: 3 tests failing in auth module          │
│  Evaluator: deterministic (npm test)           │
│                                                │
│  [⏸ Pause]  [✕ Clear]                        │
│                                                │
│  ── History ──────────────────────────────     │
│  Turn 5 · exit 1 · 3s ago                     │
│  Turn 4 · exit 1 · 20s ago                    │
│  Turn 3 · exit 1 · 40s ago                    │
└────────────────────────────────────────────────┘

┌─ PAUSED ──────────────────────────────────────┐
│  ⏸  All unit tests pass         PAUSED        │
│                                                │
│  Paused at turn 5. Resume to continue.        │
│                                                │
│  [▶ Resume]  [✕ Clear]                       │
└────────────────────────────────────────────────┘

┌─ ACHIEVED ────────────────────────────────────┐
│  ✅  All unit tests pass         ACHIEVED     │
│                                                │
│  Completed in 8 turns, 12 minutes              │
│  npm test exited 0                             │
│                                                │
│  [✕ Clear]                                    │
└────────────────────────────────────────────────┘

┌─ ERROR ───────────────────────────────────────┐
│  ⚠  Could not read goal state                 │
│                                                │
│  The goal state file may be corrupted.         │
│  Try running /goal clear to reset.            │
└────────────────────────────────────────────────┘

┌─ LOADING ─────────────────────────────────────┐
│                                                │
│           ⟳  Loading goal state...            │
│                                                │
└────────────────────────────────────────────────┘
```

---

## 5. Visual Design

### 5.1 Progress bar

```tsx
// Reuses existing @opencode-ai/ui/progress component
// width = (turnsEvaluated / maxTurns) * 100, clamped 0-100
// color: var(--v2-icon-success-base) when active
//        var(--v2-icon-warning-base) when paused
//        var(--v2-text-weak) when achieved
```

### 5.2 CSS classes (Tailwind + design tokens)

All classes follow the existing conventions in `packages/app/`:

| Element         | Classes                                          |
|-----------------|--------------------------------------------------|
| Panel container | `flex flex-col gap-3 p-4 h-full overflow-y-auto` |
| Condition text  | `text-14-medium text-text-base`                  |
| Status badge    | `text-11-regular px-2 py-0.5 rounded-md`        |
| Progress bar    | Existing `<Progress>` component                  |
| Reason text     | `text-12-regular text-text-weak`                 |
| History item    | `text-11-regular text-text-weaker`               |
| Button row      | `flex items-center gap-2 mt-auto pt-3`           |

### 5.3 Icons

Use existing `@opencode-ai/ui/icon` names:
- Active goal: `"checklist"` or a custom `"goal"` icon
- Paused: `"pause"`
- Achieved: `"check"`  
- Clear: `"close-small"`
- History toggle: `"chevron-down"` / `"chevron-right"`

---

## 6. Accessibility

| Element            | Requirement                                         |
|--------------------|-----------------------------------------------------|
| Tab                | `aria-label` = localized "Goal"                     |
| Progress bar       | `aria-valuenow`, `aria-valuemin`, `aria-valuemax`  |
| Pause/Resume       | `aria-label` describes action + current status      |
| Clear button       | Confirm dialog with `aria-modal`, focus trap        |
| Status region      | `aria-live="polite"` for evaluation updates         |
| History list       | `role="list"`, each item `role="listitem"`          |
| Color only info    | Always paired with text (status badge text)         |
| Reduced motion     | `motion-reduce:transition-none` on animated bars    |

---

## 7. Error Handling & Edge Cases

| Edge Case                         | Handling                                               |
|-----------------------------------|--------------------------------------------------------|
| Goal file missing during render   | Show empty state, not error                            |
| Goal file is malformed JSON       | Show error state with "reset" suggestion               |
| File read API returns 403/404     | Show "no goal" (same as missing file)                  |
| SSE event stream disconnects      | Fall back to polling (3s interval)                     |
| Goal transitions during render    | Animate with CSS transition (status badge)             |
| Very long condition (>200 chars)  | Truncate with `line-clamp-2`, expand on hover/tooltip  |
| Constraint field missing          | Default to 20 turns, 30 min                            |
| `turnsEvaluated > maxTurns`       | Show 100% bar, mark stopped (already handled by loop)  |
| Session switch while goal active  | Re-fetch goal for the new session                      |
| Window resize (narrow)            | Sidebar collapses, goal tab still accessible in tabs   |

---

## 8. File Manifest (changes needed)

### New files

| File                                               | Purpose                              |
|----------------------------------------------------|--------------------------------------|
| `packages/app/src/pages/session/goal-panel.tsx`    | Main GoalPanel component             |
| `packages/app/src/context/goal.tsx`                | `useGoal` hook (state fetch + SSE)   |

### Modified files

| File                                               | Change                               |
|----------------------------------------------------|--------------------------------------|
| `packages/app/src/pages/session/session-side-panel.tsx` | Add "goal" tab trigger + content |
| `packages/app/src/pages/session.tsx`               | Wire `useGoal` into SessionSidePanel props |
| `packages/app/src/i18n/en.ts` (×18 locales)        | Add i18n keys                        |
| `packages/server/src/...` (TBD)                    | File-read endpoint for `.opencode/` files or new event |
| `src/server.ts` (opencode-goal)                    | Emit "goal.state.changed" SSE event  |

---

## 9. i18n Keys

```ts
// en.ts additions — follow existing "session.tab." / "session.review." pattern
"session.tab.goal": "Goal",
"session.goal.noActive": "No active goal",
"session.goal.noActive.hint": "Set one with /goal set \"condition\" --command \"npm test\"",
"session.goal.paused": "Paused",
"session.goal.paused.hint": "Paused. Resume to continue.",
"session.goal.achieved": "Achieved",
"session.goal.achieved.detail": "Completed in {{turns}} turns, {{minutes}} minutes",
"session.goal.progress": "{{current}}/{{max}} turns",
"session.goal.time": "{{minutes}}m elapsed",
"session.goal.evaluator": "Evaluator: {{type}}",
"session.goal.evaluator.deterministic": "deterministic",
"session.goal.evaluator.transcript": "transcript",
"session.goal.history": "History",
"session.goal.history.empty": "No evaluations yet",
"session.goal.history.item": "Turn {{turn}} · {{reason}} · {{time}}",
"session.goal.action.pause": "Pause",
"session.goal.action.resume": "Resume",
"session.goal.action.clear": "Clear",
"session.goal.confirmClear.title": "Clear goal?",
"session.goal.confirmClear.message": "This stops the auto-loop and clears the current goal.",
"session.goal.error.corrupt": "Could not read goal state. Try /goal clear to reset.",
"session.goal.loading": "Loading goal state…",
```

---

## 10. Text-Based Mockup

```
╔══════════════════════════════════════════════╗
║  🔴 ● ● ● ●  🔵 ● ● ●  🟢 ● ● ●  🎯 1     ║  ← status dots (server/mcp/lsp/goal)
╠══════════════════════════════════════════════╣
║ ← Projects rail →  │  Conversation  │  R│G│C│F│  ← tabs: Review, Goal, Context, Files
║                    │                 │ ──┴─┴─┴─┴──
║                    │                 │ 🎯  ACTIVE GOAL
║                    │                 │
║                    │  agent is       │ "All unit tests pass
║                    │  working...     │  and lint exits clean"
║                    │                 │
║                    │                 │ ████████████░░░░░░░░  60%
║                    │                 │ 12/20 turns · 10/30m
║                    │                 │
║                    │                 │ Last: 2 tests failing
║                    │                 │ Eval: deterministic
║                    │                 │
║                    │                 │ [ ⏸ Pause ]  [ ✕ Clear ]
║                    │                 │
║                    │                 │ ── History ────
║                    │                 │ #6 · exit 1 · 3s
║                    │                 │ #5 · exit 1 · 25s
║                    │                 │ #4 · exit 1 · 48s
║                    │                 │   ⋮
╚══════════════════════════════════════════════╝
```

---

## 11. Implementation Phases

### Phase 1 — Data plumbing (server side)
1. Add goal state read API to server (or use existing file API)
2. Add SSE event emission from server plugin
3. Verify renderer can receive goal state

### Phase 2 — GoalPanel component (renderer)
1. Create `useGoal` hook (`createResource` + SSE listener)
2. Build `GoalPanel` with all states (loading/empty/active/paused/achieved/error)
3. Add progress bar, controls, evaluation display

### Phase 3 — Integration
1. Wire into `session-side-panel.tsx` as a new tab
2. Add i18n keys (en.ts + placeholder keys in all 18 locales)
3. Add command palette entries for goal actions (optional)
4. Add confirm dialog for clear action

### Phase 4 — Polish
1. Animation on status transitions
2. Configurable refresh interval
3. Keyboard shortcuts for pause/resume/clear
4. Screen reader testing

---

## 12. Open Questions / Risks

| # | Question | Risk |
|---|----------|------|
| 1 | Does `client.file.read` support dot-prefixed paths? | Low — test needed |
| 2 | Can server plugins emit arbitrary SSE events? | Medium — may need server-side changes |
| 3 | Goal state is per-workspace, not per-session. Which workspace's goal to show? | Medium — use the active session's workspace |
| 4 | Multiple sessions can share a goal. Should the panel show in all? | Low — yes, panel reads same state file |
| 5 | The rendering surface is SolidJS, not React. Are all patterns transferable? | Low — SolidJS has `createResource`, `Show`, `For` |

---

## 13. Validation Checklist

- [ ] Empty state renders correctly when no `.goal-state.json` exists
- [ ] Active state shows progress bar, controls, evaluation
- [ ] Paused state shows paused badge, resume button
- [ ] Achieved state shows completion stats
- [ ] Error state renders when JSON is malformed
- [ ] Tab appears/disappears based on goal existence
- [ ] `session.tab.goal` key exists in all 18 locale files
- [ ] `aria-live` announces evaluation updates
- [ ] Progress bar respects `motion-reduce`
- [ ] Confirm dialog traps focus for clear action
- [ ] Panel resizes correctly with sidebar
- [ ] No hydration mismatch when SSE delivers stale state
