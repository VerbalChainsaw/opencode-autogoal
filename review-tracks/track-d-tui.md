# Track D — TUI Correctness Review

**Head:** `4bdfa8f` (v0.4.0 hardening — "209 new tests + 14 real defects fixed")
**Scope:** `src/tui.tsx`, `src/tui-logic.ts`, `src/tui-dials-logic.ts`, `src/sidebar.tsx`, plus the server-side `src/goal-state.ts` primitives the TUI delegates to.
**Method:** Read-only. Verified every hypothesis with file/line citations, a node one-liner reproduction of the math edge cases, a full project `tsc --noEmit` (exit 0), and inspection of `@opencode-ai/plugin/tui` + `@opentui/keymap` types from `node_modules`.

---

## 0. Important context: the brief was written against a pre-v0.4.0 snapshot

The brief's line numbers (`tui.tsx:1056-1066`, `tui.tsx:1080`, etc.) point past the current 480-line file. The TUI's I/O used to be *inline* in `tui.tsx`; in the v0.4.0 refactor it was extracted to `src/tui-logic.ts` (validated math + read/write delegation) and `src/tui-dials-logic.ts` (dial submit handlers). The 13-line hypothesis list was authored against that pre-refactor shape.

This matters for every "1–10" finding below. Each brief claim is evaluated against the *current* code, not the snapshot the brief assumed. Where the brief's hypothesis is **wrong** (because the refactor already fixed the bug), I say so with evidence. Where the brief's *class* of concern is real but surfaces in a different place, I name the new location.

A useful framing: the v0.4.0 refactor moved the TUI surface from a "self-contained JSX file with hidden I/O" to a thin JSX layer that delegates to a tested engine. Most of the cycle-0 bug class the brief worried about is now physically impossible (the I/O is not in the JSX file). I found 4 new defects in the current code that the brief did not flag — those are the real value-add of this track.

---

## 1. Brief finding 1 — "Type drift: tui.tsx redefines GoalState with fewer fields" → **HYPOTHESIS Moot**

The brief claims `tui.tsx:1056-1066` redefined `GoalState` with fewer fields than `goal-state.ts`, and worried that the local writer at `tui.tsx:1080` would drop unknown fields.

**Current state:** `tui.tsx` does NOT redefine `GoalState` and does NOT have its own `readState` / `writeState`. It imports `GoalState` from `./tui-logic.js` (line 38), which in turn imports it from `./goal-state.js` (line 24 of tui-logic.ts, re-exported on line 30). The type is single-sourced from `goal-state.ts` (lines 44-85). The writer is `writeGoalStateAtomic` in `goal-state.ts:523`, which JSON.stringify's the canonical type — every field (including forward-compat fields like `verification`, `metadata.webhook`, `metadata.chainId`, etc.) round-trips correctly.

The TUI layer is **field-drop-free by construction**: the JSX can only see what the validator accepts, and the validator is the same one the server uses. If the server adds a new field, both the validator and the writer pick it up; the TUI's existing fields keep working because it only reads the ones it knows about (the rest pass through untouched in the on-disk JSON).

**Verdict:** Resolved by the v0.4.0 refactor. No defect.

---

## 2. Brief finding 2 — "writeState silently swallows rename errors" → **HYPOTHESIS Moot**

The brief said: "the catch block does `try { unlinkSync(tmp) } catch { /* ignore */ }` and the outer catch is empty (no rethrow). A failed rename (e.g. EBUSY, EACCES, disk full) means the temp file is unlinked and the write silently fails. The user sees a stale state."

**Current state:** `writeGoalStateAtomic` in `goal-state.ts:523-535`:

```ts
try {
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", "utf-8");
  renameSync(tmp, p);
} catch (err) {
  try { unlinkSync(tmp); } catch { /* ignore */ }
  throw err;            // ← re-raises to caller
}
```

The outer catch **does** rethrow. The TUI's `toggle()` and `clear()` wrappers (tui.tsx:229-249) call `toggleGoal` / `clearGoal` which delegate to `atomicToggle` (goal-state.ts:745) and `transitionGoal` (goal-state.ts:679). Both wrap `writeGoalStateAtomic` in a try/catch and return `{ ok: false, reason: "write-failed", error }`. The TUI's `toggle()` handler (tui.tsx:235-237) toasts the error:

```ts
debouncedToast({ message: `Could not change goal: ${res.error ?? "unknown error"}`, variant: "error" });
```

So a failed rename is **not silent** — the user sees an error toast. The disk-full / EBUSY / EACCES case is handled end-to-end.

**Verdict:** Resolved. The brief's hypothesis is the *opposite* of what the current code does.

---

## 3. Brief finding 3 — "readState swallow" → **Acceptable, as brief said**

`readGoalState` in `goal-state.ts:499-509` has the same try/catch swallow pattern, returning null on any error. `readDashboardState` (tui-logic.ts:69-74) treats null as "no goal" and renders the fallback panel.

The brief is right: this is acceptable. A corrupt or unreadable state file is treated as "no goal," which is the same UX as a fresh install. The trade-off is that the user doesn't get a toast explaining *why* their state appears to be missing. A v0.4.x follow-up could add a one-shot toast on first-render-with-null-after-prior-non-null, but that's a UX improvement, not a defect.

**Verdict:** As the brief said, acceptable.

---

## 4. Brief finding 4 — "Progress bar math edge cases" → **Mostly resolved, one residual defect (4a)**

Reproduction (Node 22.22, against the current `computeProgress` in tui-logic.ts:90-104):

| Input | Result | Verdict |
|-------|--------|---------|
| `maxTurns=0` | `{pct:0, filledBlocks:0, bar:"░░░…"}` | ✅ Safe — `Math.max(1, 0) = 1` clamp in line 96. No `NaN` from divide-by-zero, no `RangeError` from `repeat(NaN)`. |
| `turnsEvaluated=50, maxTurns=20` | `{pct:100, filledBlocks:20, bar:"████…"}` | ✅ Safe — `Math.min(100, …)` clamps pct; `filledBlocks` clamped to 20. |
| `startedAt = -1e15` | `elapsedMinutes = 16,666,666,667` | ❌ **Defect 4a — see below.** |
| `startedAt = 1e15` (future) | `elapsedMinutes = 0` | ✅ Safe — `Math.max(0, …)` clamps to 0. |
| `constraints.maxTurns = NaN` | `pct:null, filledBlocks:null, bar:""` | ⚠ Degraded display, not a crash. The dashboard renders "null%". |
| `turnsEvaluated = Infinity` | `pct:100, filledBlocks:20` | ✅ Safe. |
| `state.startedAt = undefined` | `elapsedMinutes:null` | ⚠ Renders "null" in the elapsed text. |
| `state.constraints` missing | **TypeError thrown** | ⚠ Crashes the dashboard render. Mitigated by `validateGoalState` requiring `constraints` (goal-state.ts:248-250), so this can't happen in production. |

**Defect 4a — `computeProgress` does not validate `startedAt` range.** `validateGoalState` (goal-state.ts:204) checks `isFiniteNumber(state.startedAt)` but not `startedAt >= 0` or `startedAt <= now`. A state file with `startedAt: -1` passes validation. When the TUI renders, `now - (-1) = now + 1`, so `elapsedMinutes` is `Math.round((now + 1) / 60_000)` — a number around `Date.now() / 60000` ≈ **17,000,000+ minutes** (about 32 years). The dashboard renders something like `Progress: 5/20 turns · 17000000/30m` which is visibly broken.

In production this is hard to trigger: the server plugin always sets `startedAt: now` (goal-state.ts:476, 1107), and the chain create / set / restart paths all use `Date.now()`. The only way to land a bad `startedAt` is a manually-edited state file. But the validator is the right place to enforce the contract — the dashboard shouldn't have to defend against a corrupt startedAt.

**Suggested fix (do not apply per task instructions):** add to `validateGoalState` (after the existing `isFiniteNumber(state.startedAt)` check on line 211):

```ts
if (state.startedAt < 0 || state.startedAt > now + 60_000) return false;  // small clock-skew window
```

Or alternatively, clamp in `computeProgress`:
```ts
const elapsedMinutes = Math.max(0, Math.round((now - Math.max(0, state.startedAt)) / 60_000));
```

**Defect 4b (minor, pre-existing class):** `computeProgress` does not defend against `state.constraints` being undefined. The function dereferences `state.constraints.maxTurns` on line 96 without a guard. The validator rejects states with missing constraints, so production is safe, but the function is fragile against any future caller that bypasses the validator.

**Verdict:** Brief's divide-by-zero and `turns > maxTurns` concerns are resolved by the v0.4.0 refactor. One new defect: `startedAt` not range-validated.

---

## 5. Brief finding 5 — "toggle() does not update in-memory `s` object's pausedAt/resumedAt" → **HYPOTHESIS Moot**

The brief said `toggle()` at tui.tsx:1090-1101 sets status=paused or active and writes atomically but does NOT update the in-memory `s` object's `pausedAt`/`resumedAt`/`completedAt` fields.

**Current state:** There's no "in-memory `s` object" in the current code. The TUI's `useGoalState` (tui.tsx:65-94) is a reactive accessor that re-reads from the state file on every `file.watcher.updated` event. After a toggle, the server-side `atomicToggle` (goal-state.ts:745) writes the new state with `pausedAt: newStatus === "paused" ? now : state.pausedAt` and `resumedAt: newStatus === "active" ? now : state.resumedAt` (lines 757-758). The file-watcher event fires, the TUI re-reads, and the new pausedAt/resumedAt are visible.

**Verdict:** Resolved by the refactor. The "in-memory s object" was an old design that has been replaced by a file-watcher-driven accessor.

---

## 6. Brief finding 6 — "clear() does not reset turnsEvaluated" → **Confirmed by design, not a defect**

The brief asked: "does it [clear] set turnsEvaluated? It doesn't, but the local type has it. Check what's persisted."

`transitionGoal` with `action: "clear"` (goal-state.ts:686-691) sets:
- `state.status = "cleared"`
- `state.completedAt = now`

It does NOT reset `turnsEvaluated`, `tokensUsed`, `evaluationHistory`, or `lastEvaluation`. The state file is mutated in place and persisted atomically.

This is **by design**, not a defect. The v0.4.0 model treats `cleared` and `achieved` as **terminal** statuses — the file is a historical record, not a live counter. The `formatStatus` helper (goal-state.ts:778) and the dashboard's progress bar (`Progress: {s().turnsEvaluated}/{s().constraints.maxTurns} turns`) both still read `turnsEvaluated`, so the user sees the final count even after clearing. Resetting to 0 would lose that information.

**Side note:** the dashboard's `Show` guard at tui.tsx:131 plus `readDashboardState`'s `if (state.status !== "active" && state.status !== "paused") return { state: null };` (tui-logic.ts:72) means a cleared or achieved goal renders the "No active goal" fallback panel — the progress bar is never shown for a terminal state. So the "is the final count visible after clear?" question has a practical answer of "no, the dashboard hides it." That might be a UX issue (the user might want to see "Goal cleared after 7 turns"), but it's the deliberate intent of the `readDashboardState` filter. The CLI's `/goal view` is the surface for inspecting historical state.

**Verdict:** By design. No defect.

---

## 7. Brief finding 7 — "Race: terminal user toggles, Desktop user sets new goal" → **CONFIRMED real defect, UX-impact only**

The concurrency model is documented at `goal-state.ts:537-551`: atomic writes (temp + rename), **no advisory file lock** (removed in v0.4.0 after 3 security reviews found 5 TOCTOU bugs), and last-rename-wins. The docstring says: *"Concurrent writers may lose each other's edits (last rename wins), which is a UX inconvenience — the next poll/sidebar refresh shows the current value and the user re-submits. No data corruption possible."*

**Concrete scenario:**

1. Desktop user types `/goal set "Run all tests"` — server plugin's `setGoal` reads state, mutates, writes.
2. Terminal user (Bun, separate process) mashes `/goal-toggle` — `atomicToggle` reads the OLD state, decides "toggle to paused", writes.
3. The two `writeGoalStateAtomic` calls race on the rename. Whichever renames last wins.

The TUI's `useGoalState` will see the file-watcher.updated event and re-read — so the dashboard will show the *actual* current state, not the user's intent. The terminal user's toast ("Goal paused") might appear even though the goal is now active (Desktop overwrote their pause).

**Where the optimistic-concurrency helper helps (and where it doesn't):** `openConditionDial` (tui.tsx:317-330) captures the current `state.id` and passes it to `handleConditionSubmit` as `expectedId`. The condition-dial path refuses with "stale-snapshot" if the id changed. **This is the right pattern, but it is ONLY used for the condition dial.** Toggle, clear, restart, and the numeric dials (turns/time/tokens) do NOT check expectedId. So the same race produces silent data loss on those paths.

**Defect 7a — no expectedId check on toggle/clear/restart/numeric-dials.** The condition-dial pattern should be applied uniformly. A toggle in the terminal while a `/goal set` lands in the server should toast "Goal was changed by another session — current state is X. Try again?" rather than silently lose the toggle.

**Severity:** Low. The v0.4.0 design accepts the trade-off explicitly. The docstring even tells the user to "re-submit" on the next poll. The TUI's `useGoalState` means the dashboard never displays a stale state (it re-reads on file change). So data integrity is fine; the user experience is "I just hit toggle, why didn't anything change?" The fix is purely UX (add a "your toggle was overwritten" toast when the post-write state differs from the pre-write intent).

**Verdict:** Real defect, low severity, accepted by design. Worth a follow-up issue.

---

## 8. Brief finding 8 — "Route render error paths" → **CONFIRMED safe**

The brief asked: "if readState returns null OR the state is in an unexpected shape, does the render crash?"

The render path is `DashboardView` (tui.tsx:123-162):
1. `useGoalState` returns a `Signal<GoalState | null>`.
2. `<Show when={state()} fallback={...}>` (line 130) renders the fallback when state is null.
3. When state is non-null, the inner `{(s) => { ... }}` (line 146) destructures from a non-null signal — TypeScript narrows it via the `Show` callback.
4. `computeProgress(s())` is called with the validated state. The math is clamped (see finding 4).
5. `s().lastEvaluation?.reason ?? "none yet"` (line 154) — optional chain is safe even if lastEvaluation is null.

The render is well-guarded. **No crash path for null state.** The only crash path I found is `state.constraints` being undefined inside `computeProgress` (defect 4b) — but `readGoalState` rejects such states via the validator, so it cannot reach the render.

**Verdict:** Safe. No defect.

---

## 9. Brief finding 9 — "DialogConfirm / dialog.replace are real TUIPlugin API methods" → **CONFIRMED real**

Cross-referenced against `node_modules/@opencode-ai/plugin/dist/tui.d.ts` (1.17.1):

- `TuiDialogConfirmProps` (lines 92-97) — `{ title, message, onConfirm?, onCancel? }`. The tui.tsx call at line 253 passes exactly `{ title, message, onConfirm, onCancel }`. ✅
- `TuiDialogStack.replace(render, onClose?)` (line 80). The tui.tsx call at line 223 passes `render, () => { ourDialogOpen = false; }`. ✅
- `TuiDialogStack.clear()` (line 81). tui.tsx calls at lines 256, 286, 365. ✅
- `TuiDialogPrompt` props (lines 98-107) — `{ title, description?, placeholder?, value?, busy?, busyText?, onConfirm?, onCancel? }`. The tui.tsx call at lines 275-289 passes `{ title, placeholder, value, onConfirm, onCancel }`. ✅ Note: `busy` and `busyText` exist on the type but the plugin never uses them — since the dial handlers are sync and sub-ms, "busy" would never show. Not a defect.
- `TuiToast` (lines 164-169) — `{ variant?, title?, message, duration? }`. The tui.tsx `debouncedToast` wrapper (line 200) matches. ✅

**Verdict:** All API surfaces used by the TUI exist in the host's type defs. The plugin is type-correct against the official spec.

---

## 10. Brief finding 10 — "Keymap / slashName / route name uniqueness" → **Unique within plugin, no host-API check**

**Within `tui.tsx`:**
- 13 `slashName`s: `goal-dashboard, goal-close, goal-toggle, goal-clear, goal-turns, goal-time, goal-tokens, goal-condition, goal-steer, goal-clear-steering, goal-restart, goal-handoff, goal-claim` — all unique. ✅
- 13 command `name`s: `goal.dashboard, goal.dashboard.close, goal.toggle, goal.clear, goal.dial.turns, goal.dial.time, goal.dial.tokens, goal.dial.condition, goal.dial.steer, goal.dial.clear-steering, goal.dial.restart, goal.dial.handoff, goal.dial.claim` — all unique. ✅
- 1 route name: `goal.dashboard` — unique within this plugin. ✅

**Cross-plugin collision risk:** A future TUI plugin authoring a command named `goal.toggle` would collide. The convention is the `goal.` namespace prefix — but it's a convention, not enforced by the host. The keymap's `registerLayer` (verified in `node_modules/@opentui/keymap/src/keymap.d.ts:32`) takes a `Layer` whose `commands` is `readonly Command[]` with no uniqueness check at the type level. The host's runtime behavior on duplicate command names is not specified in the type defs I have access to.

**Within OpenGoal's own TUI surface:** the sidebar.tsx (sibling file) does not register any keymap commands (sidebar.tsx:62-67 explicitly says so). It surfaces the existing commands in the footer as `/goal-toggle` and `/goal-clear` hints. So no internal collision.

**Verdict:** All unique. Cross-plugin collision is a convention concern, not a defect in this plugin.

---

## New defects found (not in the brief)

### Defect 11 — `sidebar.tsx:170` `renderFooter` bypasses the mtime cache

`renderFooter` calls `buildSidebarView(directory)` directly (sidebar.tsx:170), not through the cached `getView()` helper used by `renderTitle` and `renderContent`.

```ts
function renderFooter(): JSX.Element {
  const view = buildSidebarView(directory);   // ← bypasses cache; re-reads both files
  ...
}
```

The cache (lines 111-121) was specifically introduced as FIX-5 to avoid the "title shows active, content shows paused" race between the three render fns in a single host invalidation pass. Two statSync + one buildSidebarView per pass is the design. The footer should be:

```ts
const view = getView();
return <text fg={theme().textMuted}>{sanitizeForSidebar(view.footer)}</text>;
```

**Impact:**
- **Race window:** between the title's cached read and the footer's direct read, the state file can change. Title and footer could show mismatched views (the footer only shows keymap hints, so user-visible impact is small but nonzero).
- **Perf waste:** 2 extra `readFileSync` calls per render pass. The header (buildSidebarView) reads both `.goal-state.json` AND `.goal-handoff.json`.

**Severity:** Low. The footer text is a static keymap hint (`/goal-toggle · /goal-clear`); even if it lagged a render, the user would not notice a mismatch. But it directly contradicts the FIX-5 design comment and is a 2-line fix.

**Verdict:** Real defect, low severity, trivial fix.

### Defect 12 — `TuiCommand.run(ctx)` signature mismatch (latent, not currently broken)

`@opentui/keymap` `Command.run(ctx: CommandContext<TTarget, TEvent, TPayload>)` (types.d.ts:117-121) takes a required `ctx` argument. All 13 `run` callbacks in tui.tsx:382-425 declare `run()` with zero arguments:

```ts
{ name: "goal.dashboard", ..., run() { ... } }
{ name: "goal.toggle", ..., run() { toggle(); } }
// etc.
```

The project-wide `tsc --noEmit` passes (exit 0, verified just now), so the types are currently compatible. The reason: `Command<TTarget, TEvent, TPayload>` extends `{ [key: string]: unknown }` (types.d.ts:120), and the runtime invokes `run` with `ctx` but the plugin's run() ignores it. **Function arity in TypeScript and JS is not strict** — a function declared `run()` can be passed a function that takes 0 args, even when called with 1.

**Why it's "latent":** this works today, but it's fragile. If a future OpenCode plugin SDK release tightens the `Command` type to remove the index signature, or if a runtime check enforces arity, every command would fail to typecheck. The fix is trivial: change `run()` to `run(_ctx)` in all 13 commands (or `run(_ctx: CommandContext<Renderable, KeyEvent>)` for full typing). The underscore prefix is the convention for "unused required param."

**Severity:** Trivial. No runtime impact today. Future-proofing concern.

**Verdict:** Latent fragility, not a current bug.

### Defect 13 — `toast` debounce key is unbounded over long sessions

`tui.tsx:197-215` debounces toasts keyed by `${variant}|${message}`. The cap is `TOAST_MAP_SOFT_CAP = 50`; pruning only happens when the map is OVER the cap (line 208: `if (toastLastShown.size > TOAST_MAP_SOFT_CAP)`). The cap is a soft "lazy prune" — if the user sees 50 distinct toasts and then sees a 51st distinct toast, the cap triggers and the O(n) prune runs. After the prune, the map is back under 50. **In steady state the map stays bounded, but the prune iterates the full map** (a O(n) scan) **on every distinct 51st toast.**

For a long session (hours of goal-dial fiddling), the cap is fine — the prune keeps the size at most 50. The O(n) scan is bounded by the cap (50), so it runs in microseconds. Not a perf problem.

**The real concern:** if a future host ever allocates many distinct toast messages (e.g. an error toast that includes a UUID or a counter), the map could be much larger than 50 because each unique message keeps the entry. The 50-cap protects this, but the pruning is conditional — it only runs when crossing the threshold. If the host fires toasts with strictly increasing uniqueness (UUID, timestamp), the cap triggers often and the O(n) prune runs often.

**Severity:** Trivial in practice. The map is bounded; the prune is O(n) with bounded n.

**Verdict:** Acceptable, but worth noting in the design comment.

### Defect 14 — `validateGoalState` does not range-check `startedAt` (restating 4a in validation terms)

This is the same defect as 4a, viewed from the validator's perspective. `validateGoalState` (goal-state.ts:204-250) requires `startedAt` to be a finite number (line 211) but does not bound it (e.g. `startedAt >= 0 && startedAt <= now + small_skew`). A state file with `startedAt = -1` (signed-bit-flip, off-by-one in a buggy manual edit, etc.) passes validation and reaches the dashboard, where `computeProgress` produces a garbage elapsed time.

The fix belongs in the validator, not in computeProgress: the validator is the single boundary for "is this state shape acceptable to the runtime." All consumers (server, TUI, sidebar, CLI) read through `readGoalState` and benefit from a single check.

**Verdict:** See defect 4a. Single defect, two framings.

---

## Summary

The v0.4.0 TUI surface is **substantially cleaner** than the brief's pre-refactor snapshot assumed. Most of the brief's "1-10" findings are resolved by the JSX/logic/engine split that already happened:

- 1, 2, 3, 5, 6 → moot or resolved by the refactor.
- 4 → mostly resolved; one residual: `startedAt` not range-validated (Defect 4a).
- 7 → confirmed real but accepted by the v0.4.0 design (atomic writes, no lock, last-rename-wins); UX impact only.
- 8, 9, 10 → confirmed safe; the API surfaces and uniqueness are correct.

Four new defects the brief did not catch:
- **Defect 11** (low): `sidebar.tsx:170 renderFooter` bypasses the mtime cache. Trivial 2-line fix.
- **Defect 12** (latent): all 13 `run()` callbacks should accept the `ctx` argument the keymap type requires. Future-proofing, not a current bug.
- **Defect 13** (trivial): toast debounce map pruning is conditional and O(n). Acceptable in practice.
- **Defect 14 / 4a** (low): `validateGoalState` does not range-check `startedAt`. State file with a negative startedAt produces visibly broken elapsed-time display.

None of the four are critical. The plugin is in good shape for v0.4.0. The most worthwhile follow-up is **Defect 11** (bypass of the FIX-5 cache) — it's a 2-line fix that directly contradicts an existing design comment, so it's a "while you're in there" cleanup. **Defect 14 / 4a** is worth a one-line addition to the validator and would harden against hostile or accidental manual edits to the state file.

---

## Files inspected

| File | Lines | What I looked at |
|------|-------|-----------------|
| `src/tui.tsx` | 480 | The whole file. Keymap, route, dialog-stack ownership, file-watcher subscription, debounced toast, render guards. |
| `src/tui-logic.ts` | 151 | `readDashboardState`, `computeProgress`, `toggleGoal`, `clearGoal`, type re-export. |
| `src/tui-dials-logic.ts` | 248 | `handle*Submit` dial handlers, `fromEditResult`, switch exhaustiveness. |
| `src/sidebar.tsx` | 209 | mtime cache (FIX-5), `renderFooter` bypass (Defect 11), slot registration. |
| `src/sidebar-logic.ts` | 311 | `buildSidebarView`, `SidebarView` shape, `sanitizeForSidebar`. |
| `src/goal-state.ts` | 1385 | `GoalState` type, `validateGoalState`, `writeGoalStateAtomic`, `atomicToggle`, `transitionGoal`, `readGoalState`, concurrency model. |
| `node_modules/@opencode-ai/plugin/dist/tui.d.ts` | 509 | All TUI plugin API surfaces (`api.ui.*`, `api.keymap`, `api.route`, `api.event`, `api.lifecycle`). |
| `node_modules/@opentui/keymap/src/keymap.d.ts` | 65 | `Keymap` class, `registerLayer` shape. |
| `node_modules/@opentui/keymap/src/types.d.ts` | 598 | `Command`, `Binding`, `Layer` types. |

## Verification commands run

- `npx tsc --noEmit` (project-wide) → exit 0, no errors.
- `node -e "…"` reproduction of `computeProgress` against 8 edge cases (maxTurns=0, turns>max, negative startedAt, future startedAt, NaN, Infinity, undefined startedAt, missing constraints).
- Manual trace of every `api.ui.*` and `api.event.*` call against the host's `.d.ts` to confirm method existence and prop shape.

## Files changed

None. This is a read-only review.
