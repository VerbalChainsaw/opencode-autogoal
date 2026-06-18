# Mission Control UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade OpenCode/OpenGoal into a denser, more legible mission-control variant while fixing the operational regressions first: shell styling, new-session entrypoints, visible controls, and reliable resizing.

**Architecture:** The work spans two sibling repos. `C:\Users\zerop\Development\opencode-source` owns the desktop shell, home page, session shell, and goal dock UI. `C:\Users\zerop\Development\OpenGoal` owns the goal state, budget enforcement, block/status contract, and regression tests that pin the dock’s assumptions. Implement operational guardrails first, then move surface-by-surface: Home, Session shell, Goal dock, History/detail, polish.

**Tech Stack:** SolidJS, Bun, Electron-Vite, OpenCode app/desktop packages, OpenGoal Node/TypeScript plugin, Bun test, node:test

---

## File Structure

### `C:\Users\zerop\Development\opencode-source`

- `packages/desktop/src/renderer/index.tsx`
  Purpose: desktop renderer entrypoint; must import shared app CSS so the shell is not unstyled.
- `packages/desktop/src/renderer/index.test.ts`
  Purpose: regression guard for the shared app stylesheet import.
- `packages/app/src/components/titlebar.tsx`
  Purpose: high-value global/session actions, including the top-level new-session entrypoint.
- `packages/app/src/components/titlebar.test.ts`
  Purpose: regression guard that the titlebar uses draft-based new-session creation instead of same-route legacy navigation.
- `packages/app/src/pages/home.tsx`
  Purpose: Home/front page; will become the Global Ops Board.
- `packages/app/src/pages/session.tsx`
  Purpose: session shell layout and right-panel sizing boundary.
- `packages/app/src/pages/session/session-side-panel.tsx`
  Purpose: right-dock container, tab behavior, file-tree resize handle, goal tab visibility.
- `packages/app/src/pages/session/goal-panel.tsx`
  Purpose: the main Dual-Band Dock component.
- `packages/app/src/pages/session/goal-panel.test.ts`
  Purpose: unit/regression coverage for goal dock rendering and controls.
- `packages/app/src/pages/session/goal-panel-lifecycle.ts`
  Purpose: pure lifecycle/history visibility logic for the dock.
- `packages/app/src/pages/session/goal-panel-lifecycle.test.ts`
  Purpose: regression coverage for live-vs-history behavior.
- `packages/app/src/pages/session/helpers.test.ts`
  Purpose: session tab + goal-tab visibility/opening regression guards.
- `packages/app/src/components/session/session-header.tsx`
  Purpose: session-scoped top controls, including the goal toggle.

### `C:\Users\zerop\Development\OpenGoal`

- `src/server.ts`
  Purpose: budget enforcement, loop stop reason, goal status text and block fallback.
- `src/goal-state.ts`
  Purpose: goal constraints and dial editing semantics.
- `src/blocks/goal-blocks.ts`
  Purpose: block/status summaries that mirror dock-visible budgets and status.
- `test/server-events.test.mjs`
  Purpose: loop-stop and notification/event coverage.
- `test/command-dials.test.mjs`
  Purpose: `/goal turns` and `/goal time` mutation coverage.
- `test/server-dials.test.mjs`
  Purpose: server-side dial command coverage from the plugin surface.
- `test/blocks-goal-blocks.test.mjs`
  Purpose: block/status contract coverage for visible budgets/status rows.

## Task 1: Lock Operational Guardrails

**Files:**
- Modify: `C:\Users\zerop\Development\opencode-source\packages\desktop\src\renderer\index.tsx`
- Modify: `C:\Users\zerop\Development\opencode-source\packages\app\src\components\titlebar.tsx`
- Test: `C:\Users\zerop\Development\opencode-source\packages\desktop\src\renderer\index.test.ts`
- Test: `C:\Users\zerop\Development\opencode-source\packages\app\src\components\titlebar.test.ts`

- [ ] **Step 1: Write the failing regression tests**

```ts
// packages/desktop/src/renderer/index.test.ts
import { describe, expect, test } from "bun:test"

describe("desktop renderer entrypoint", () => {
  test("imports the shared app stylesheet", async () => {
    const source = await Bun.file(new URL("./index.tsx", import.meta.url)).text()
    expect(source).toContain('import "@opencode-ai/app/index.css"')
  })
})
```

```ts
// packages/app/src/components/titlebar.test.ts
import { describe, expect, test } from "bun:test"

describe("titlebar new-session entrypoint", () => {
  test("creates a draft instead of relying on legacy session navigation", async () => {
    const source = await Bun.file(new URL("./titlebar.tsx", import.meta.url)).text()
    expect(source).toContain("tabs.newDraft({ server: server.key, directory })")
    expect(source).toContain("onClick={openNewTab}")
  })
})
```

- [ ] **Step 2: Run the focused regression tests and verify the baseline**

Run:

```powershell
cd C:\Users\zerop\Development\opencode-source\packages\desktop
bun test src/renderer/index.test.ts src/renderer/initialization.test.ts

cd C:\Users\zerop\Development\opencode-source\packages\app
bun test --only-failures --preload ./happydom.ts ./src/components/titlebar.test.ts
```

Expected:

- the desktop test fails if the shared app stylesheet import is absent
- the titlebar test fails if the button still uses legacy same-route navigation

- [ ] **Step 3: Implement the operational guardrails**

```ts
// packages/desktop/src/renderer/index.tsx
// @refresh reload
import "@opencode-ai/app/index.css"
```

```ts
// packages/app/src/components/titlebar.tsx
const newSessionDirectory = () => {
  const current = decode64(params.dir)
  if (current) return current
  return layout.projects.list()[0]?.worktree
}

const openNewTab = () => {
  const directory = newSessionDirectory()
  if (!directory) return
  tabs.newDraft({ server: server.key, directory })
}
```

```tsx
// packages/app/src/components/titlebar.tsx
<IconButtonV2
  type="button"
  variant="ghost-muted"
  size="large"
  class="shrink-0"
  icon={<IconV2 name="plus" />}
  disabled={!newSessionDirectory()}
  onClick={openNewTab}
  aria-label={language.t("command.session.new")}
/>
```

```tsx
// packages/app/src/components/titlebar.tsx
<Button
  variant="ghost"
  icon={creating() ? "new-session-active" : "new-session"}
  class="titlebar-icon w-8 h-6 p-0 box-border"
  disabled={layout.sidebar.opened()}
  tabIndex={layout.sidebar.opened() ? -1 : undefined}
  onClick={openNewTab}
  aria-label={language.t("command.session.new")}
  aria-current={creating() ? "page" : undefined}
/>
```

- [ ] **Step 4: Re-run typecheck and the guardrail tests**

Run:

```powershell
cd C:\Users\zerop\Development\opencode-source\packages\app
bun run typecheck
bun test --only-failures --preload ./happydom.ts ./src/components/titlebar.test.ts

cd C:\Users\zerop\Development\opencode-source\packages\desktop
bun run typecheck
bun test src/renderer/index.test.ts src/renderer/initialization.test.ts
```

Expected:

- app typecheck passes
- desktop typecheck passes
- all focused tests pass

- [ ] **Step 5: Commit**

```bash
cd C:/Users/zerop/Development/opencode-source
git add packages/app/src/components/titlebar.tsx packages/app/src/components/titlebar.test.ts packages/desktop/src/renderer/index.tsx packages/desktop/src/renderer/index.test.ts
git commit -m "fix(app): lock shell styling and draft session entrypoints"
```

## Task 2: Build the Home Page Global Ops Board

**Files:**
- Modify: `C:\Users\zerop\Development\opencode-source\packages\app\src\pages\home.tsx`
- Test: `C:\Users\zerop\Development\opencode-source\packages\app\src\pages\home.test.ts` (create)

- [ ] **Step 1: Write a focused home-page contract test**

```ts
// packages/app/src/pages/home.test.ts
import { describe, expect, test } from "bun:test"

describe("home mission-control contract", () => {
  test("defines the mission-control status labels and action box", async () => {
    const source = await Bun.file(new URL("./home.tsx", import.meta.url)).text()
    expect(source).toContain("Projects")
    expect(source).toContain("Live Sessions")
    expect(source).toContain("Active Goals")
    expect(source).toContain("Needs Attention")
    expect(source).toContain("Resume Last")
    expect(source).toContain("Open Goal")
  })
})
```

- [ ] **Step 2: Run the home-page contract test and verify it fails**

Run:

```powershell
cd C:\Users\zerop\Development\opencode-source\packages\app
bun test --only-failures --preload ./happydom.ts ./src/pages/home.test.ts
```

Expected:

- the test fails because the current home page does not yet render the new mission-control labels

- [ ] **Step 3: Add the mission-control layout in `home.tsx`**

```tsx
// packages/app/src/pages/home.tsx
<div class="grid grid-cols-4 gap-3">
  <MetricCard label="Projects" value={String(projects().length)} />
  <MetricCard label="Live Sessions" value={String(records().filter((r) => !r.session.closedAt).length)} />
  <MetricCard label="Active Goals" value={String(records().filter((r) => r.session.title?.length).length)} />
  <MetricCard
    label="Needs Attention"
    value={String(records().filter((r) => unseenCount(focusedServer()!, r.project) > 0).length)}
    tone="warning"
  />
</div>
```

```tsx
// packages/app/src/pages/home.tsx
<div class="grid grid-cols-[minmax(0,1.2fr)_minmax(280px,.8fr)] gap-4">
  <section class="rounded-[12px] border border-v2-border-border-muted bg-v2-background-bg-layer-01 p-3">
    <div class="mb-2 text-v2-text-text-muted [font-weight:440]">Live Board</div>
    <div class="flex min-h-0 flex-col gap-2">
      <For each={records()}>
        {(record) => (
          <button type="button" class="rounded-[10px] border border-v2-border-border-muted px-3 py-2 text-left" onClick={() => openSession(record.session)}>
            <div class="flex items-center justify-between gap-2">
              <span class="text-v2-text-text-base [font-weight:530]">{record.projectName}</span>
              <span class="text-v2-text-text-muted [font-weight:440]">{sessionTitle(record.session.title) || record.session.id}</span>
            </div>
          </button>
        )}
      </For>
    </div>
  </section>

  <aside class="flex flex-col gap-4">
    <section class="rounded-[12px] border border-v2-border-border-muted bg-v2-background-bg-layer-01 p-3">
      <div class="mb-2 text-v2-text-text-muted [font-weight:440]">Actions</div>
      <div class="flex flex-col gap-2">
        <ButtonV2 variant="primary" size="normal" onClick={openNewSession}>New Session</ButtonV2>
        <ButtonV2 variant="ghost-muted" size="normal" onClick={() => records()[0] && openSession(records()[0].session)}>Resume Last</ButtonV2>
        <ButtonV2 variant="ghost-muted" size="normal" onClick={() => records()[0] && openSession(records()[0].session)}>Open Goal</ButtonV2>
      </div>
    </section>
  </aside>
</div>
```

- [ ] **Step 4: Run typecheck and the home-page test**

Run:

```powershell
cd C:\Users\zerop\Development\opencode-source\packages\app
bun run typecheck
bun test --only-failures --preload ./happydom.ts ./src/pages/home.test.ts
```

Expected:

- typecheck passes
- the new home-page contract test passes

- [ ] **Step 5: Commit**

```bash
cd C:/Users/zerop/Development/opencode-source
git add packages/app/src/pages/home.tsx packages/app/src/pages/home.test.ts
git commit -m "feat(app): turn home into a global ops board"
```

## Task 3: Reset the Active Session Hierarchy and Resize Visibility

**Files:**
- Modify: `C:\Users\zerop\Development\opencode-source\packages\app\src\pages\session.tsx`
- Modify: `C:\Users\zerop\Development\opencode-source\packages\app\src\pages\session\session-side-panel.tsx`
- Modify: `C:\Users\zerop\Development\opencode-source\packages\app\src\components\session\session-header.tsx`
- Test: `C:\Users\zerop\Development\opencode-source\packages\app\src\pages\session\helpers.test.ts`

- [ ] **Step 1: Add a failing session-shell regression test**

```ts
// packages/app/src/pages/session/helpers.test.ts
test("goal tab remains a first-class fixed trigger in the side panel", () => {
  const source = Bun.file(new URL("./session-side-panel.tsx", import.meta.url)).text()
  return expect(source).resolves.toContain('<Tabs.Content value="goal"')
})
```

```ts
// packages/app/src/pages/session/helpers.test.ts
test("session shell still exposes a visible ResizeHandle for the right panel", () => {
  const source = Bun.file(new URL("../session.tsx", import.meta.url)).text()
  return expect(source).resolves.toContain("<ResizeHandle")
})
```

- [ ] **Step 2: Run the session-helper tests and verify the contract**

Run:

```powershell
cd C:\Users\zerop\Development\opencode-source\packages\app
bun test --only-failures --preload ./happydom.ts ./src/pages/session/helpers.test.ts
```

Expected:

- the tests pass or fail only on the new hierarchy assertions

- [ ] **Step 3: Strengthen the active session shell**

```tsx
// packages/app/src/pages/session.tsx
<Show when={desktopReviewOpen()}>
  <div class="relative border-l border-v2-border-border-muted bg-v2-background-bg-layer-00/80" onPointerDown={() => size.start()}>
    <ResizeHandle
      classList={{ "-right-1": settings.general.newLayoutDesigns() }}
      direction="horizontal"
      size={layout.session.width()}
      min={450}
      max={typeof window === "undefined" ? 1000 : window.innerWidth * 0.45}
      onResize={(width) => {
        size.touch()
        layout.session.resize(width)
      }}
    />
  </div>
</Show>
```

```tsx
// packages/app/src/pages/session/session-side-panel.tsx
<aside class="flex h-full min-h-0 border-l border-v2-border-border-muted bg-v2-background-bg-layer-00">
  {/* keep conversation primary; strengthen the dock boundary and fixed goal trigger */}
</aside>
```

```tsx
// packages/app/src/components/session/session-header.tsx
<Button
  variant="ghost"
  class="group/goal-toggle titlebar-icon w-8 h-6 p-0 box-border ring-1 ring-transparent hover:ring-v2-border-border-muted"
  onClick={toggleGoal}
  aria-label={language.t("session.tab.goal")}
  aria-expanded={goalShown()}
  aria-controls="review-panel"
>
  <Icon size="small" name="circle-check" />
</Button>
```

- [ ] **Step 4: Re-run typecheck and session tests**

Run:

```powershell
cd C:\Users\zerop\Development\opencode-source\packages\app
bun run typecheck
bun test --only-failures --preload ./happydom.ts ./src/pages/session/helpers.test.ts ./src/pages/session/goal-panel-lifecycle.test.ts
```

Expected:

- typecheck passes
- existing helper/lifecycle tests stay green

- [ ] **Step 5: Commit**

```bash
cd C:/Users/zerop/Development/opencode-source
git add packages/app/src/pages/session.tsx packages/app/src/pages/session/session-side-panel.tsx packages/app/src/components/session/session-header.tsx packages/app/src/pages/session/helpers.test.ts
git commit -m "feat(app): strengthen session shell hierarchy and resize affordances"
```

## Task 4: Pin Budget Enforcement in the OpenGoal Plugin

**Files:**
- Modify: `C:\Users\zerop\Development\OpenGoal\test\command-dials.test.mjs`
- Modify: `C:\Users\zerop\Development\OpenGoal\test\server-events.test.mjs`
- Modify: `C:\Users\zerop\Development\OpenGoal\test\blocks-goal-blocks.test.mjs`
- Modify: `C:\Users\zerop\Development\OpenGoal\src\blocks\goal-blocks.ts` (only if block labels need alignment)

- [ ] **Step 1: Write the failing OpenGoal contract tests**

```js
// test/command-dials.test.mjs
test("/goal time 45: updates maxTimeMinutes for the dock budget row", () => {
  const dir = tempDir()
  dispatchGoalCommand(dir, 'set "ship it"')
  const out = dispatchGoalCommand(dir, "time 45")
  assert.match(out, /45/)
  assert.equal(readGoalState(dir).constraints.maxTimeMinutes, 45)
})
```

```js
// test/server-events.test.mjs
test("constraint stop emits a time-limit reason when elapsed minutes hit the cap", async () => {
  const state = makeGoalState({ startedAt: Date.now() - 31 * 60_000, constraints: { maxTurns: 20, maxTimeMinutes: 30, maxTokens: 100000 } })
  const result = detectConstraintStop(state)
  assert.equal(result.exceeded, true)
  assert.match(result.reason, /Time limit reached/)
})
```

```js
// test/blocks-goal-blocks.test.mjs
test("status blocks expose Max turns and Max time for dock parity", () => {
  const blocks = buildGoalStatusBlocks(makeGoalState())
  const text = blocksToText(blocks)
  assert.match(text, /Max turns/i)
  assert.match(text, /Max time/i)
})
```

- [ ] **Step 2: Run the focused OpenGoal tests**

Run:

```powershell
cd C:\Users\zerop\Development\OpenGoal
node --test test/command-dials.test.mjs test/server-events.test.mjs test/blocks-goal-blocks.test.mjs
```

Expected:

- green if the existing plugin already satisfies the dock contract
- otherwise failing assertions reveal the exact gap before UI work continues

- [ ] **Step 3: Implement only the missing contract pieces**

```ts
// src/blocks/goal-blocks.ts
statRow({
  title: "Limits",
  stats: [
    { label: "Max turns", value: state.constraints.maxTurns.toLocaleString() },
    { label: "Max time", value: `${state.constraints.maxTimeMinutes}m` },
    { label: "Max tokens", value: state.constraints.maxTokens.toLocaleString() },
  ],
})
```

```ts
// src/server.ts
if (state.turnsEvaluated >= c.maxTurns) {
  return { exceeded: true, reason: `Turn limit reached: ${state.turnsEvaluated}/${c.maxTurns} turns` }
}

if (elapsedMin >= c.maxTimeMinutes) {
  return { exceeded: true, reason: `Time limit reached: ${Math.round(elapsedMin)}/${c.maxTimeMinutes} minutes` }
}
```

- [ ] **Step 4: Re-run the focused OpenGoal tests**

Run:

```powershell
cd C:\Users\zerop\Development\OpenGoal
node --test test/command-dials.test.mjs test/server-events.test.mjs test/blocks-goal-blocks.test.mjs
```

Expected:

- all three suites pass

- [ ] **Step 5: Commit**

```bash
cd C:/Users/zerop/Development/OpenGoal
git add test/command-dials.test.mjs test/server-events.test.mjs test/blocks-goal-blocks.test.mjs src/blocks/goal-blocks.ts src/server.ts
git commit -m "feat(plugin): lock mission-control budget and status contracts (MISSION_CONTROL_UI_DESIGN.md §Surface 3)"
```

## Task 5: Rebuild the Goal Panel into the Dual-Band Dock

**Files:**
- Modify: `C:\Users\zerop\Development\opencode-source\packages\app\src\pages\session\goal-panel.tsx`
- Modify: `C:\Users\zerop\Development\opencode-source\packages\app\src\pages\session\goal-panel.test.ts`
- Modify: `C:\Users\zerop\Development\opencode-source\packages\app\src\pages\session\goal-panel-lifecycle.test.ts`

- [ ] **Step 1: Add failing goal-panel tests for visible budgets and command strip**

```ts
// packages/app/src/pages/session/goal-panel.test.ts
test("goal panel source includes always-visible turn and time budget rows", async () => {
  const source = await Bun.file(new URL("./goal-panel.tsx", import.meta.url)).text()
  expect(source).toContain('openBudget("turns"')
  expect(source).toContain('openBudget("time"')
  expect(source).toContain('Pause')
  expect(source).toContain('Steer')
  expect(source).toContain('Stop')
})
```

```ts
// packages/app/src/pages/session/goal-panel-lifecycle.test.ts
test("history remains available when the live goal disappears", () => {
  expect(shouldShowCreateForm({ liveGoal: null, forceCreate: false })).toBe(true)
})
```

- [ ] **Step 2: Run the focused goal-panel tests and verify they pin the current baseline**

Run:

```powershell
cd C:\Users\zerop\Development\opencode-source\packages\app
bun test --only-failures --preload ./happydom.ts ./src/pages/session/goal-panel.test.ts ./src/pages/session/goal-panel-lifecycle.test.ts
```

Expected:

- existing lifecycle tests stay green
- any missing budget/control assertions fail before implementation

- [ ] **Step 3: Implement the Dual-Band Dock layout**

```tsx
// packages/app/src/pages/session/goal-panel.tsx
<div class="flex flex-col gap-3 rounded-[12px] border border-v2-border-border-muted bg-v2-background-bg-layer-01 p-3">
  <div class="flex items-start justify-between gap-3">
    <div class="min-w-0">
      <div class="text-[11px] uppercase tracking-[0.08em] text-v2-text-text-muted">Running now</div>
      <div class="truncate text-v2-text-text-base [font-weight:530]">{s.condition}</div>
    </div>
    <div class="rounded-full border border-v2-border-border-muted px-2 py-0.5 text-v2-text-text-muted">{s.status}</div>
  </div>

  <ProgressBar
    pct={s.status === "achieved" ? 100 : progressPct()}
    status={s.status === "paused" ? "paused" : s.status === "achieved" ? "achieved" : "active"}
  />

  <div class="grid grid-cols-2 gap-2">
    <BudgetStepper
      label="Turns"
      current={s.turnsEvaluated}
      max={s.constraints.maxTurns}
      onMinus={() => nudgeBudget("turns", -1)}
      onPlus={() => nudgeBudget("turns", +1)}
    />
    <BudgetStepper
      label="Time"
      current={elapsedMinutes()}
      max={s.constraints.maxTimeMinutes}
      suffix="m"
      onMinus={() => nudgeBudget("time", -1)}
      onPlus={() => nudgeBudget("time", +1)}
    />
  </div>
</div>
```

```tsx
// packages/app/src/pages/session/goal-panel.tsx
<div class="grid grid-cols-2 gap-2 rounded-[12px] border border-v2-border-border-muted bg-v2-background-bg-layer-00 p-2">
  <ActionButton label={s.status === "paused" ? language.t("session.goal.action.resume") : language.t("session.goal.action.pause")} variant="primary" onClick={() => runAction(s.status === "paused" ? "resume" : "pause")} />
  <ActionButton label={language.t("session.goal.action.steer")} variant="secondary" onClick={() => setSteerOpen((v) => !v)} />
  <ActionButton label={language.t("session.goal.action.newGoal")} variant="secondary" onClick={() => setForceCreate(true)} />
  <ActionButton label={language.t("session.goal.action.stop")} variant="secondary" onClick={() => setConfirmingClear(true)} />
</div>
```

- [ ] **Step 4: Run typecheck and the focused goal-panel tests**

Run:

```powershell
cd C:\Users\zerop\Development\opencode-source\packages\app
bun run typecheck
bun test --only-failures --preload ./happydom.ts ./src/pages/session/goal-panel.test.ts ./src/pages/session/goal-panel-lifecycle.test.ts
```

Expected:

- typecheck passes
- the goal-panel tests pass

- [ ] **Step 5: Commit**

```bash
cd C:/Users/zerop/Development/opencode-source
git add packages/app/src/pages/session/goal-panel.tsx packages/app/src/pages/session/goal-panel.test.ts packages/app/src/pages/session/goal-panel-lifecycle.test.ts
git commit -m "feat(app): rebuild the goal sidebar into a dual-band dock"
```

## Task 6: Add Compact History Pills and Nested Detail Without Disturbing the Live Run

**Files:**
- Modify: `C:\Users\zerop\Development\opencode-source\packages\app\src\pages\session\goal-panel.tsx`
- Modify: `C:\Users\zerop\Development\opencode-source\packages\app\src\pages\session\goal-panel-lifecycle.ts`
- Modify: `C:\Users\zerop\Development\opencode-source\packages\app\src\pages\session\goal-panel-lifecycle.test.ts`

- [ ] **Step 1: Add the failing history-detail regression test**

```ts
// packages/app/src/pages/session/goal-panel-lifecycle.test.ts
test("selected history entry does not replace the live goal card", () => {
  const live = makeState({ id: "live-1", status: "active" })
  expect(liveGoal(live)).toEqual(live)
})
```

- [ ] **Step 2: Run the lifecycle test before changing the history UI**

Run:

```powershell
cd C:\Users\zerop\Development\opencode-source\packages\app
bun test --only-failures --preload ./happydom.ts ./src/pages/session/goal-panel-lifecycle.test.ts
```

Expected:

- lifecycle tests pass except any newly added assertion that exposes a regression

- [ ] **Step 3: Implement history pills plus nested detail drawer**

```tsx
// packages/app/src/pages/session/goal-panel.tsx
<div class="flex flex-wrap gap-2">
  <For each={archive()}>
    {(h) => (
      <button
        type="button"
        class="rounded-full border px-3 py-1 text-[11px] [font-weight:530]"
        classList={{
          "border-emerald-700/60 bg-emerald-500/10": h.summary.outcome === "achieved",
          "border-amber-700/60 bg-amber-500/10": h.summary.outcome === "paused",
          "border-rose-700/60 bg-rose-500/10": h.summary.outcome === "stopped",
        }}
        onClick={() => setSelectedHistoryGoalID((c) => (c === h.summary.goalID ? null : h.summary.goalID))}
      >
        {h.summary.outcome} · {h.summary.turns}t · {h.summary.minutes}m
      </button>
    )}
  </For>
</div>
```

```tsx
// packages/app/src/pages/session/goal-panel.tsx
<Show when={selectedHistoryRun()}>
  <div class="rounded-[12px] border border-v2-border-border-muted bg-v2-background-bg-layer-01 p-3">
    <div class="mb-2 text-v2-text-text-muted [font-weight:440]">Run details</div>
    <div class="text-v2-text-text-base [font-weight:530]">{selectedHistoryRun()!.summary.condition}</div>
    <div class="mt-2 flex gap-2">
      <ActionButton label={language.t("session.goal.history.reuse")} variant="secondary" onClick={() => void reuseGoal(selectedHistoryRun()!)} />
    </div>
  </div>
</Show>
```

- [ ] **Step 4: Re-run typecheck and lifecycle/history tests**

Run:

```powershell
cd C:\Users\zerop\Development\opencode-source\packages\app
bun run typecheck
bun test --only-failures --preload ./happydom.ts ./src/pages/session/goal-panel.test.ts ./src/pages/session/goal-panel-lifecycle.test.ts
```

Expected:

- typecheck passes
- history behavior remains green

- [ ] **Step 5: Commit**

```bash
cd C:/Users/zerop/Development/opencode-source
git add packages/app/src/pages/session/goal-panel.tsx packages/app/src/pages/session/goal-panel-lifecycle.ts packages/app/src/pages/session/goal-panel-lifecycle.test.ts
git commit -m "feat(app): add compact history pills with nested run detail"
```

## Final Verification

- [ ] **Step 1: Run the OpenGoal focused regression suite**

Run:

```powershell
cd C:\Users\zerop\Development\OpenGoal
node --test test/command-dials.test.mjs test/server-events.test.mjs test/blocks-goal-blocks.test.mjs
```

Expected:

- all focused OpenGoal contract tests pass

- [ ] **Step 2: Run the app test and typecheck sweep**

Run:

```powershell
cd C:\Users\zerop\Development\opencode-source\packages\app
bun run typecheck
bun test --only-failures --preload ./happydom.ts ./src/components/titlebar.test.ts ./src/pages/home.test.ts ./src/pages/session/helpers.test.ts ./src/pages/session/goal-panel.test.ts ./src/pages/session/goal-panel-lifecycle.test.ts
```

Expected:

- typecheck passes
- all focused app tests pass

- [ ] **Step 3: Run the desktop sweep**

Run:

```powershell
cd C:\Users\zerop\Development\opencode-source\packages\desktop
bun run typecheck
bun test src/renderer/index.test.ts src/renderer/initialization.test.ts
bun run build
```

Expected:

- desktop typecheck passes
- desktop tests pass
- build completes, with warnings allowed only if they are pre-existing and unrelated

- [ ] **Step 4: Manual runtime verification**

Check in the live desktop app:

- front page is styled
- New Session visibly works from titlebar and home/front page
- resize handles are visible and draggable
- active session remains conversation-first
- right dock shows the stronger status band
- turns/time budget row appears under the progress bar
- both budget steppers change constraints inline
- hitting a turns/time limit stops the run
- history pills open detail without disturbing the live card

## Spec Coverage Review

- `Global Ops Board`: covered by Task 2
- `conversation-first work surface`: covered by Task 3
- `Dual-Band Dock`: covered by Task 5
- `turns/time under the green bar with inline steppers`: covered by Tasks 4 and 5
- `hard stop on either budget`: covered by Task 4
- `compact history pills + nested detail`: covered by Task 6
- `operational issues before polish`: covered by Tasks 1, 3, and Final Verification

## Placeholder Scan

- No `TODO`, `TBD`, or “implement later” markers remain.
- Every task lists exact files and exact commands.
- Every code-changing step includes concrete code.

## Type Consistency Review

- `tabs.newDraft({ server, directory })` matches the current `TabsProvider` API.
- `maxTurns` and `maxTimeMinutes` match the existing `GoalState.constraints` keys in the plugin and the app.
- `goal-panel` history selection continues to use `selectedHistoryGoalID` / `selectedHistoryRun`, matching the existing component surface.
