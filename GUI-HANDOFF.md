# Mission-Control GUI — Session Handoff & Punch-List

**Written:** 2026-06-16 · **For:** a fresh Claude Code session picking up the GUI work.
**Goal:** get the OpenGoal mission-control desktop GUI to *daily-usable* (not perfect) and shipped.

Read this top-to-bottom before touching code. It exists so you do NOT re-discover the architecture.

---

## Session 11 update (2026-06-17) — Method Library reshaped to the approved screenshot + baseline re-greened

**What landed (committed):**
- **opencode-source** `dev` @ `e04fbaabb` — `feat(app): Method Library panel + green baseline`. Staged source/tests only (`packages/app/src`, `packages/desktop/src`); no logs/screenshots.
- **OpenGoal** branch `gui/method-library-wiring` @ `007d748` — `feat(plugin): goal-templates snapshot + sidebar/terminal-state work`. (Branched off `main` to keep it clean — fast-forward/merge when ready.)

**The work — "Method Library" panel** (`packages/app/src/pages/session/goal-panel.tsx`, the `goal-method-library` aside): reshaped Codex's over-built "Action Library" to match the target screenshot.
- Renamed UI: **Method library / Reusable prompt methods / Prompt method** button / **Search methods** (i18n values in `en.ts`, keys unchanged).
- Cards now show **BUILT-IN** + **PROMPT|VERIFY** tags via `methodTags()` (dropped tone-colored icons, the category pill, the per-row "Add").
- Dropped the **category dropdown** filter (search only).
- Detail pane = title + tags → **PROMPT** → **VERIFY COMMAND** (“No verify command”) → **LIMITS** → editable **VARIABLES** → **[Edit draft] [Use as draft] [Duplicate]** (+ Add-to-chain ghost, + Delete for user methods) → editor (name/label/prompt/verify/turns/minutes/**Save template**).
- Removed the **category/checkpoint/color/elevation taxonomy UI** (summary grid + editor pickers). The data model + inference stayed because the **chain builder still consumes gate/tone** — taxonomy is now auto-inferred on save, not user-edited.

**Fixed pre-existing breakage Codex left** (the tree was already RED before this session):
- `inferActionGate`, `stepGateLabel`, `chainGateCount` were **used but never defined** → typecheck failed. Defined them (`ACTION_GATE_LABELS` + gate inference). 
- The brittle `goal panel mission-control contracts` source-string tests asserted renamed/removed markers and `not.toContain("gate…")` that the source actually had → updated to the new markers / behavior.

**Verification:** app `bun run typecheck` clean + **574/574** unit tests; plugin `npm test` **1157/1157** (typecheck + build clean). NOT verified in a running desktop (this env can't launch Electron — see §6) — **please confirm the Method Library live.**

**Still open / for the next agent:**
- **Dead display helpers** now unused after the reshape (safe to delete): `actionToneClass`, `actionToneSwatchClass`, `actionSurfaceClass`, `actionIconName`, `actionTags`, `ACTION_TONE_LABELS`, `ACTION_ELEVATION_LABELS`, `runtimeCheckLabel`, `templateGateLabel`, `categoryCounts`. **Keep** `inferActionGate` / `inferActionCategory` / `inferredActionTone` (chain builder uses them).
- **“Template name + Save template”** lives inside the editor (opens via Edit draft / Prompt method), not always-visible as in the screenshot — wire an always-visible quick-save if desired.
- **Plugin builtins** are still `fix-lint`/`fix-types`/`pass-tests`; the app intentionally ignores plugin builtins and ships its own method set (Plan/Build/Debug/Validate/Typecheck/Commit in `goal-panel-pure.ts`). To make `/goal template plan` work from the CLI/TUI too, add those to the plugin's `BUILTIN_TEMPLATES`.
- **i18n**: only `en.ts` got the method terminology; `zh.ts`/`zht.ts` still say "action" (cosmetic; falls back to en).
- **Uncommitted in both trees** (intentionally left, nothing lost): root config/workflow churn, screenshots (`electron-*.png`), dev logs, `.opencode/` runtime, `.superpowers/`/`.playwright-mcp/`/`.hermes/`, and the loose `MISSION_CONTROL_*`/`AUDIT-DEFECTS*` docs.

---

## Session 10 update (2026-06-16) - Electron E2E target correction

The previous no-restart guidance is stale for this phase. Browser checks
remain useful for fast renderer diagnostics, but they are not sufficient
when the user asks for the Electron app. The final GUI proof must happen
in the native OpenCode Desktop window from
`C:\Users\zerop\Development\opencode-source\packages\desktop`.

Operational rule for this handoff:
- Rebuild OpenGoal after plugin edits so `dist/` is current.
- Relaunch the owned Desktop dev app/sidecar when plugin or server-side
  behavior needs to reload.
- Run the live button/function matrix in Electron and record
  works/fails with evidence.

---

## Session 9 update (2026-06-16) - systematic GUI/function pass found and fixed command-hook bug

Systematic gates refreshed:
- `C:\Users\zerop\Development\opencode-source\packages\app`: `bun run typecheck` pass; focused GUI/helper sweep pass 169/169.
- `C:\Users\zerop\Development\OpenGoal`: `npm test` pass 1148/1148.
- File-integrity polish: `packages/app/src/pages/session/goal-panel-contract.test.ts` no longer contains a literal NUL byte; the sanitizer fixture now uses escaped `\u0000` and a byte scan reports `NullByteCount: 0`.

Browser matrix against `http://127.0.0.1:4444/`:
- Home/Mission Control: no console warn/error logs; metric disabled-state logic correct; Projects metric opens/closes the project dialog; Active Goals opens history; New Session enters draft flow; Open Goal routes to the session and selects the Goal dock.
- Goal dock: Pause -> Resume worked at runtime. The budget `+` button exposed a real bug: `/goal turns 21` could become a new goal with `condition: "turns 21"` because OpenGoal's `command.execute.before` hook assigned `output.parts = [...]` while the host kept the original command-template parts array.

Fix:
- `src/server.ts` now mutates the host-owned `output.parts` array in place with `splice(0, output.parts.length, part)` and makes the fallback command template inert.
- `test/server-dials.test.mjs` adds a compiled-plugin regression proving the hook preserves array identity, removes the original command template, applies `turns 21`, and keeps the original goal condition.

Important runtime caveat: the already-running browser backend still had stale plugin code loaded. Per app package instructions, it was not restarted. A narrow live recheck after the code fix still reproduced stale behavior, so rerun the full dock button matrix only after the backend/desktop sidecar reloads the rebuilt plugin from `dist/`.

---

## Session 7 update (2026-06-16) - home project source fixed, Goal dock runtime smoke passed

Found and fixed a real Mission Control entry blocker: the backend on `4096` already listed `OpenGoal`, but the new home board used only the app-local pinned project list. In a fresh browser state this made the board and picker show zero projects, blocking the OpenGoal session path.

- Fixed in `C:\Users\zerop\Development\opencode-source\packages\app\src\pages\layout\helpers.ts`:
  - added `mergeHomeProjectLists()` to merge locally opened projects with backend-known projects
  - preserves local order/expanded state
  - appends backend-known projects
  - excludes the synthetic `global` project
- Wired in `packages/app/src/pages/home.tsx`:
  - `HomeDesign` now uses the merged list for metrics, project rail, sessions, and actions
- Added regression coverage in `packages/app/src/pages/layout/helpers.test.ts`.

Runtime proof:
- Reloaded `http://127.0.0.1:4444/` against backend `127.0.0.1:4096`.
- Home board changed from Projects `0` to Projects `2`, Live Sessions `1`, Active Goals `1`.
- `OpenGoal` appeared in the project rail and recent-session row.
- Opened the OpenGoal-bound session URL and switched to the Goal tab.
- Set a disposable smoke goal through the dock; backend accepted it and the panel transitioned to ACTIVE with no `Command not found` and no console warn/error logs.
- Cleared the disposable goal with `node dist\cli.js --dir C:\Users\zerop\Development\OpenGoal clear`; follow-up status reports no active goal.

Verified from `C:\Users\zerop\Development\opencode-source\packages\app`:
- `bun test --preload ./happydom.ts ./src/pages/layout/helpers.test.ts ./src/pages/home.test.ts` - 39/39 pass
- `bun run typecheck` - pass
- `bun test --preload ./happydom.ts` - 527/527 pass

Note: the disposable smoke created an untracked `C:\Users\zerop\Development\OpenGoal\.opencode\goal-history.json` archive artifact with the smoke run history. It was left in place rather than deleting generated history unilaterally.

---

## Session 6 update (2026-06-16) - verification refreshed, web runtime smoke passed

No product code changed in this pass. The work was to resume from the live frontier, re-check the scoped repo instructions, refresh the green baseline, and run a browser smoke against a fresh dev target.

- No listeners were present on `4444`, `4096`, or `11305` at first check.
- Started a fresh local dev target instead of restarting anything:
  - backend: `http://127.0.0.1:4096` (PID `40756`)
  - app: `http://127.0.0.1:4444/` (port owner PID `36432`, launched by Bun PID `38376`)
  - logs: `C:\Users\zerop\Development\opencode-source\.hermes\runtime-logs\`
- Browser smoke at `http://127.0.0.1:4444/`:
  - page identity: title `OpenCode`, URL `/`
  - no framework overlay
  - no console warn/error logs
  - visible Mission Control home board renders with Projects, Live Sessions, Active Goals, Needs Attention, search, Actions, and Needs Attention panels
  - clicking `New Session` opens the expected `Open project` modal because the fresh backend has zero projects/folders registered
- Verified from `C:\Users\zerop\Development\OpenGoal`:
  - `npm test` - 1147/1147 pass
- Verified from `C:\Users\zerop\Development\opencode-source\packages\app`:
  - `bun run typecheck` - pass
  - focused GUI sweep (`status-popover`, `helpers`, `goal-panel-contract`, `goal-panel-lifecycle`) - 80/80 pass
  - `bun test --preload ./happydom.ts` - 526/526 pass
- Verified from `C:\Users\zerop\Development\opencode-source\packages\desktop`:
  - `bun test electron-builder.config.test.ts` - 4/4 pass
  - `bun run typecheck` - pass
  - `bun test` - 60/60 pass
  - `bun run build` - pass, with existing Vite/electron bundle warnings only

Remaining proof: live session/Goal dock behavior after a project/session exists in the running backend, plus Electron desktop-window confirmation for desktop-only toast/popover positioning. The browser smoke proves the web-rendered Mission Control home surface, not the full desktop window.

---

## Session 5 update (2026-06-16) — status-popover signal truth table fixed

While auditing the remaining portal/overlay risks, found a concrete non-V2 status popover bug: the legacy status dot class predicates marked a healthy server as both `critical` and `weak`. The V2 path already had the correct truth table.

- Fixed in `C:\Users\zerop\Development\opencode-source\packages\app\src\components\status-popover.tsx` by routing both legacy and V2 status dots through a shared helper.
- Added the pure helper in `packages/app/src/components/status-popover-tone.ts`.
- Added `packages/app/src/components/status-popover.test.ts` to pin success/warning/critical/weak status tone behavior without importing the client-only popover component tree.
- Pinned the previously noted "generic tab.close keybind" caveat in `packages/app/src/pages/session/helpers.test.ts`: `createSessionTabs().closableTab()` does not expose `"goal"`, so `mod+w` cannot close the Goal tab through the shared session command path.
- Verified from `C:\Users\zerop\Development\opencode-source\packages\app`:
  - `bun test --preload ./happydom.ts ./src/components/status-popover.test.ts` — 4/4 pass
  - `bun test --preload ./happydom.ts ./src/pages/session/helpers.test.ts` — 27/27 pass
  - `bun run typecheck` — pass
  - focused GUI sweep — 149/149 pass
  - full `bun test --preload ./happydom.ts` — 526/526 pass
- Verified from `C:\Users\zerop\Development\opencode-source\packages\desktop`:
  - `bun run build` — pass, with existing Vite/electron bundle warnings only

Runtime caveat: no local app/backend ports were listening (`4444`, `4096`, `11305`), and this session did not restart services. Running-window confirmation remains the last proof needed for the GUI positioning/focus items.

---

## Session 4 update (2026-06-16) — toast/right-dock positioning code-fixed

The remaining "windows render in wrong spaces" report was audited against the current desktop surfaces. The Goal panel itself is correctly mounted in the session right sidebar; the likely overlap path was global toast portals that render to `document.body` and previously ignored the open right dock width.

- Fixed in `C:\Users\zerop\Development\opencode-source\packages\app\src\pages\session.tsx` by publishing `--oc-toast-region-right` from the active right panel width.
- Added pure helper coverage in `packages/app/src/pages/session/helpers.ts` / `helpers.test.ts` for closed panel, Goal/review dock, and file-tree dock offsets.
- Updated both toast systems to consume the variable with the old `32px` fallback:
  - `packages/ui/src/components/toast.css`
  - `packages/ui/src/v2/components/toast-v2.css`
- Verified from `C:\Users\zerop\Development\opencode-source\packages\app`:
  - `bun test --preload ./happydom.ts ./src/pages/session/helpers.test.ts` — 26/26 pass
  - `bun run typecheck` — pass
  - focused GUI sweep — 144/144 pass
  - full `bun test --preload ./happydom.ts` — 521/521 pass
- Verified from `C:\Users\zerop\Development\opencode-source\packages\desktop`:
  - `bun run build` — pass, with existing Vite/electron bundle warnings only

Runtime caveat: this is code-fixed but still needs running-window confirmation because this session did not restart the app/server. If a future screenshot still shows a detached overlay, the next suspect is the portal-based status popover, not the Goal dock itself.

---

## Session 3 update (2026-06-16) — desktop package gate repaired

The desktop package had one remaining red full-suite test after the app/plugin gates were green:

- `packages/desktop/electron-builder.config.test.ts` failed because the prod legacy Linux launcher fpm mapping emitted a Windows absolute path (`C:\Users\...\resources\linux\opencode-desktop.desktop=...`) while the package contract expects the resource-relative path (`resources/linux/opencode-desktop.desktop=...`).
- Fixed in `C:\Users\zerop\Development\opencode-source\packages\desktop\electron-builder.config.ts` by keeping `legacyDesktopEntry` package-relative.
- Verified from `C:\Users\zerop\Development\opencode-source\packages\desktop`:
  - `bun test electron-builder.config.test.ts` — 4/4 pass
  - `bun run typecheck` — pass
  - `bun test` — 60/60 pass
  - `bun run build` — pass, with existing Vite/electron bundle warnings only

The live desktop GUI still needs actual running-window verification for the remaining positioning/reporting issue; this session did not restart the app/server.

---

## ⏩ Session 2 update (2026-06-16) — what changed since this doc was written

**Both baselines were RED on arrival** (the prior session left in-flight WIP that didn't compile — the "green" claim in §0/§5 was stale). Fixed and re-verified:

- **Plugin (`OpenGoal`)** — `npm test` now green: **1147/1147**, typecheck + build clean.
  - `src/sidebar-logic.ts` had a botched duplicate fragment (syntax error) → removed.
  - `src/sidebar.tsx` called `api.renderer.invalidate?.()` (not a `CliRenderer` method) → `requestRender?.()`.
  - 15 stale tests updated to the prior session's *intentional* changes: compact one-metric-per-line sidebar layout (FIX-23) and terminal goals staying viewable in the TUI sidebar (v0.5.1).
- **App (`opencode-source`, branch `dev`)** — `bun run typecheck` now CLEAN, full unit suite **519/519**.
  - `titlebar.tsx` regression: unguarded `server.current` (`ServerConnection.Any | undefined`) → early-return guard (matches `app.tsx:275`).
  - `tsconfig.json` regression: prior session dropped `"package.json"` from `include` while `entry.tsx` still `import pkg from "../package.json"` → restored.

**Punch-list status (see §3 for detail):**
- 🔴 **Blocker 1 (pause/resume stale/reorder)** — ✅ DONE + BROWSER VERIFIED. Single optimistic toggle in a stable slot. Pure helper `pauseResumeAction` in `goal-panel-lifecycle.ts` (+ tests). Browser smoke confirmed Pause → same-slot disabled Resume → Paused/enabled Resume, then Resume → Active/enabled Pause.
- 🔴 **Blocker 2 (steer field loses focus)** — ✅ DONE + BROWSER VERIFIED. `useGoal` now `reconcile`s the state (keyed on `id`) so the `<Match … keyed>` subtree updates in place instead of tearing down every 2s and destroying the focused input. Browser smoke confirmed the Steer input retained focus and text after a 3.5s polling interval.
- 🟡 **Goal-tab close** — ✅ DONE + BROWSER VERIFIED. User chose "block close while active": `goalTabCloseable(status)` helper gates the X button + middle-click in `session-side-panel.tsx` (live goal ⇒ not closeable). The generic `tab.close` keybind path is also guarded indirectly because `createSessionTabs().closableTab()` never returns `"goal"`; pinned in `helpers.test.ts`. Browser smoke confirmed the close affordance is absent during a live goal and present again after clear.
- 🟢 **Dynamic template buttons** — ✅ DONE. Plugin writes `.opencode/goal-templates.json` (`src/goal-templates-snapshot.ts`, lazy/best-effort, only when user templates exist); dock polls it (`templateButtonsFromSnapshot` in `goal-panel-pure.ts`, builtin fallback). Both sides unit-tested.
- 🟡 **"windows render in wrong spaces"** — ✅ CODE-FIXED / BROWSER-RUNTIME VERIFIED. Global toast portals now offset around the open right dock; browser runtime proof at `http://127.0.0.1:4444/` showed the dock and toast region plumbing without console regressions. Native Electron window proof is still the remaining desktop-only confirmation.

**Still unverified in a native Electron window**: browser-rendered app verification passed for pause/resume, steer focus, goal-tab behavior, history fallback, and home board routing. Launch the desktop (§5) only if the remaining question is desktop-window-specific positioning.

## 2026-06-16 Session 8 — browser runtime proof

The already-running backend/app pair (`127.0.0.1:4096` + `http://127.0.0.1:4444/`) was used without restarting services. App gates passed: `bun run typecheck` and the focused GUI sweep passed 169/169 (`layout/helpers`, `home`, `session/helpers`, `goal-panel-contract`, `goal-panel-lifecycle`, `goal-panel`, `status-popover`). Browser verification passed with no console warn/error logs: Home showed Projects=2, Live Sessions=1, Active Goals=1, OpenGoal visible, and the Open Goal action routed to the OpenGoal session. In the Goal dock, a disposable goal set through the UI rendered the active status band, turns/time controls, activity, and recent runs; Pause changed the same-slot control to Resume and then polled to Paused; Resume returned to Active/Pause; the Steer input retained focus and text after a 3.5s polling interval; clearing via `node dist\cli.js --dir C:\Users\zerop\Development\OpenGoal clear` returned exit 0 and the dock returned to Set Goal + Recent Runs. OpenGoal `npm test` also passed 1147/1147. The smoke added entries to the existing untracked `.opencode/goal-history.json`; leave or prune deliberately, do not treat it as source.

---

## 0. The one-paragraph orientation

OpenGoal is a zero-dep OpenCode plugin (`opencode-autogoal`) that keeps an agent working toward a goal. **The plugin is done and shippable** — `npm test` is green (1140 tests, typecheck + build clean). The in-flight work is a **mission-control GUI** built into a *fork of OpenCode's desktop app*. The GUI is where all remaining bugs live — they are **integration friction** (custom goal dock fighting the host app's focus/state/polling/layout), not plugin defects. Your job: clear the short remaining blocker list, verify in the running desktop app, ship.

## 1. The two repos (work spans both)

| Repo | Role | Branch | Verify |
|---|---|---|---|
| `C:\Users\zerop\Development\OpenGoal` (this one) | The `opencode-autogoal` plugin: goal state, budget enforcement, block/status contract, permission guard, templates, history/archive. **This is the product.** | `main` | `npm test` (typecheck+build+1140 tests) |
| `C:\Users\zerop\Development\opencode-source` | OpenCode app/desktop UI (SolidJS + Bun + electron-vite). Owns home board, session shell, **goal dock**, titlebar. A fork. | `dev` | per-package `bun run typecheck` + `bun test` |

**Data contract:** the plugin owns the data; the dock *draws* it. The dock reads plugin-written JSON snapshots from `<project>/.opencode/` — `goal-history.json` (history), `goal-state.json` (live goal), activity/chain files — by **polling every 2 seconds** via the SDK's `file.read`. Remember this: **the dock is a 2s poll, not reactive.** Several bugs trace to that lag.

Specs in this repo: `MISSION_CONTROL_UI_DESIGN.md` (the steel-and-signal vision), `MISSION_CONTROL_UI_IMPLEMENTATION_PLAN.md` (6-task plan, mostly done). Audit: `opencode-source/AUDIT-DEFECTS.md` (131 findings, monorepo-wide — most are NOT this tool's shipping path; console/web/infra/nix/docs are OpenCode-upstream).

## 2. Fixed already this session (verify, don't redo)

All compile + tests green. **App (renderer) changes hot-reload; plugin changes need a desktop restart to reload (see §5).**

| Bug | Fix | File |
|---|---|---|
| Buttons fire wrong / "Permission request not found" | Plugin permission guard was blind to the host's `permission.asked` event (only knew `permission.updated`/`permission.v2.asked`). The auto-loop nudged during an open permission dialog → host evicted the request. Added `permission.asked` + defensive id read. 16/16 permission tests. | `src/permissions.ts` `classifyPermissionEvent` |
| History vanishes on Stop | History `<Show>` was gated on the **live goal** store (`store.loaded && !store.corrupt`); stopping clears that. Decoupled — now keyed only on `archive().length > 0`. | `opencode-source/.../goal-panel.tsx` (~line 969) |
| Stopped runs never appear in history | Only *achieved* runs were archived. Clear/stop path now `appendGoalArchive(..., "cleared")`. | `src/server.ts` clear_goal handler (~line 757) |
| Can't resize the dock | Handle wrapper was `relative` inside a `flex flex-col` panel → collapsed to a zero-height strip at the bottom. Re-pinned `absolute inset-y-0 right-0 z-30 w-0 overflow-visible` (matches the working sidebar handle in `layout.tsx`). | `opencode-source/.../session.tsx` (~line 1831) |
| Washed-out light theme | App defaulted `colorScheme="system"`; OS light → light palette. Now defaults dark (the steel-and-signal palette). | `opencode-source/.../app.tsx` (~235) + `ui/src/theme/context.tsx` (~181) |
| New Session crash (dynamic import) | `new-session.tsx` imported via the heavy `@/components/session` barrel. Switched to the leaf module. | `opencode-source/.../new-session.tsx:4` |
| Always-V2 header typo | `<Show when={isDesktopV2}>` (function, always truthy) → `isDesktopV2()`. | `opencode-source/.../session-header.tsx` (~346) |
| CRIT-03 timing-attack auth | `===` password compare → constant-time `safeEqual` (length-check + `timingSafeEqual`). | `opencode-source/packages/{opencode/src/server,server/src}/auth.ts` |

## 3. PUNCH-LIST — remaining work

### 🔴 Blocker 1 — Pause/Resume send stale commands; buttons reorder
**Symptom (user):** "It was already paused and said Pause again"; "buttons get out of order"; resume/pause send the wrong command sometimes.
**Root cause (hypothesis):** the dock renders Pause vs Resume from `s.status`, which is the **2s-polled** goal state. After you click an action, local state isn't updated optimistically, so the button label/position lags reality until the next poll — and the Pause↔Resume conditional swaps button *position*, so you click a stale button.
**Where:** `opencode-source/packages/app/src/pages/session/goal-panel.tsx`
- Pause `ActionButton` shown when `s.status === "active"` (~line 688); Resume when `s.status === "paused"` (~697); `runAction(action)` → `sendGoalCommand` (~415-432).
- The `useGoal` store + its poll loop (`onMount` tick @ 2000ms, ~line 381-390) is the state source.
**Fix direction:** (a) optimistic status update on click (reflect paused/active immediately), (b) keep the action button in a **stable position** (don't swap layout slots — render one toggle that changes label, same slot), (c) trigger an **immediate** state refresh right after a command instead of waiting for the 2s tick, and (d) keep buttons disabled (`busy()`) until that refresh confirms. There IS a `busy()` guard but it releases before the poll catches up.

### 🔴 Blocker 2 — Steer field can't hold focus (flashes back to chat)
**Symptom (user):** typing in the steer box, the cursor keeps jumping to the main chat composer.
**Root cause (hypothesis):** the host's chat composer has an autofocus effect that re-grabs focus on re-render; the dock re-renders every 2s poll, so the composer steals focus from the steer `TextField` each cycle.
**Where:** steer `TextField` in `goal-panel.tsx` (~line 753, inside `<Show when={steerOpen()}>`). The thief is the session composer's focus logic — search `opencode-source/packages/app/src/pages/session/composer/` and `prompt-input.tsx` for `.focus()` / `autofocus` / `requestAnimationFrame(... focus)` effects that fire on render.
**Fix direction:** gate the composer's autofocus so it does NOT steal focus while a dock input is focused (e.g. check `document.activeElement` is inside the goal panel), OR make the steer affordance a focus-trapping popover/dialog instead of an inline field that re-renders with the poll.

### 🟡 Minor — goal-tab reopen is non-obvious
Closing the Goal tab (X) hides it (sets a per-goal `dismissedKey`). It IS recoverable via the **circle-check icon** in the session header rail (`session-header.tsx` `toggleGoal`, ~152-162; button ~582), but users don't realize that. **Decision needed (ask user):** (a) make reopen obvious, or (b) don't allow closing the Goal tab while a goal is *active*. Logic lives in `session-side-panel.tsx` `goalVisible`/`closeGoalTab` (~189-204).

### 🟡 Minor — "windows render in wrong spaces"
Code-fixed for the likely permission/question toast path: body-level toast portals now offset around the open desktop right dock using `--oc-toast-region-right`. Get a fresh screenshot or live confirmation before closing this fully. If it still reproduces, inspect the portal-based status popover geometry next.

### 🟢 Feature the user wants — dynamic template buttons
The dock's template quick-start buttons are **hardcoded** (`goal-panel.tsx` ~463, a literal array of 3: pass-tests/fix-lint/fix-types). But the plugin already supports user templates at `<project>/.opencode/goals/<name>.json` via `src/templates.ts` (`discoverTemplates`, `exportTemplate`, `importTemplate` — full validation, `{var}` substitution, 256KB cap). A user's custom template runs via typed `/goal template <name>` but does NOT appear as a button. **To close the gap:** have the plugin write a `.opencode/goal-templates.json` snapshot (same pattern as `goal-history.json`) and have the dock poll + render it. Then any `.opencode/goals/*.json` shows up as a button automatically.

## 4. The dock's render model (so you don't fight it)

- `goal-panel.tsx` renders by **lifecycle STATUS**, not truthiness. `goal-panel-lifecycle.ts` owns the pure rules: `liveGoal(state)` returns state only while `active`/`paused`; terminal/missing → null → empty+history view. Keep that invariant.
- History timeline sits **outside** the live-goal `<Switch>` (so it survives a stop). Keep it that way.
- Everything dynamic (state, history, activity, chain) comes from **2s polling** of `.opencode/*.json` via `readWorkspaceText(sdk, path)`. There is no push/reactive channel from the plugin to the dock. If a fix needs immediacy, refresh-on-command is the pattern.

## 5. Build / test / run

```bash
# Plugin (this repo) — the product. Always keep green before shipping.
cd C:\Users\zerop\Development\OpenGoal && npm test     # typecheck + build + 1140 node:test

# App package checks
cd C:\Users\zerop\Development\opencode-source\packages\app && bun run typecheck
bun test --preload ./happydom.ts ./src/pages/session/helpers.test.ts ./src/pages/session/goal-panel-contract.test.ts ./src/pages/session/goal-panel-lifecycle.test.ts

# Run the REAL desktop app (the required way to verify GUI)
cd C:\Users\zerop\Development\opencode-source\packages\desktop && bun run dev   # electron-vite; opens the window
```
**Renderer (app) edits hot-reload** in the running window (Ctrl+R if needed). **Plugin edits (`src/*.ts`) require `npm run build` here AND a desktop restart** — the opencode *sidecar* loads the plugin from `dist/` at spawn; restarting the desktop respawns the sidecar and reloads the plugin.

## 6. Hard constraints / gotchas

- **Electron window proof is required for GUI sign-off.** Use the native Desktop dev window for the final matrix. If Computer Use or another desktop automation path is available, drive and screenshot the Electron window directly; otherwise launch the window and collect user-provided observations/screenshots rather than substituting the browser preview.
- **Bash tool here is real Git Bash** (`/usr/bin/bash`), NOT the PowerShell shim that `~/.claude/CLAUDE.md` describes. The dedicated PowerShell tool is intermittently unavailable. Use git-bash syntax; for Windows process/port work use `netstat`/`taskkill //PID //F`.
- **Event-name drift bites repeatedly.** The host renamed permission events across versions (v1 `permission.updated` → v2 `permission.v2.asked` → v1.17 `permission.asked`). Any guard matching host event *types* must tolerate all known names. (This caused Blocker-class bug #1's predecessor.)
- **The plugin tests import from `dist/`** — rebuild before running `node --test`, or you test stale code. `npm test` does this for you.

## 7. If the GUI keeps multiplying bugs

The honest fallback the user is aware of: **ship the plugin alone** (the `/goal` command + the TUI dashboard both work today and are low-maintenance). The GUI is the high-surface-area bet. If a real usage session surfaces a fresh wave of integration bugs, recommend shipping plugin-only and treating the desktop GUI as a separate, scoped project rather than continuing whack-a-mole. Daily-usable is the bar for the GUI — not bug-free.

## 8. First moves for the fresh session

1. `npm test` here + `bun run typecheck` in app/desktop → confirm the green baseline.
2. Launch the desktop app (§5); ask the user to reproduce Blocker 1 and 2 while you watch the symptoms against the code in §3.
3. Fix Blocker 1 (optimistic + stable-slot + refresh-on-command), then Blocker 2 (focus guard). Verify each live with the user.
4. Ask the user the goal-tab decision (§3 minor a/b).
5. When daily-usable: commit on both branches (user hasn't authorized commits yet — ask first), then ship.
