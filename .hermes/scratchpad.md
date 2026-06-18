# Scratchpad — `.hermes/scratchpad.md`

This file is the **session handoff** for any agent (human or AI)
picking up work in this repo. It is loaded into context at the
start of every session, alongside `AGENTS.md`.

## How to use it

1. **At the start of every non-trivial task**, write a "Spec
   reconciliation" entry under "## Active task" below. The
   template is fixed:

   ```
   ### Spec reconciliation
   User's literal words: <verbatim quote>
   Spec surface: <file:line for each specs/ file in scope>
   Reconciliation: <one sentence — what the work is and
                   where it lands>
   If you cannot write the reconciliation, stop and ask.
   ```

2. **Keep the "Current state" section up to date** as the work
   progresses. Commit-by-commit. This is the agent's working
   memory across compaction events.

3. **At handoff time** (end of session, before context dies),
   fill in the "Handoff" section so the next agent doesn't
   restart from zero.

## What NOT to put here

- Secrets, tokens, or any value an attacker could use.
- Long file dumps. Use `git diff` or `read_file` for those.
- Speculation about the user's intent. The user said X; cite
  the quote. If you think X means Y, write the reconciliation
  explicitly so it can be checked.

---

## Active task

## 2026-06-17 In-place running status and stop permission fix

### Spec reconciliation
User's literal words: "I realize we're now missing the activity ch uh block we used to have. And we don't have the status block that we used to have anymore. And I can't prove that any of this works. Like I'm very disappointed." / "Dude what the hell as soon as I hit start on the goal it goes to some other weird page that's totally unpolished" / "And I got a request failed permission denied message again when I tried to stop." / "Right, this page here should just go to a running status, not take me to a whole nother page."
The repo's spec surface for this work: `specs/desktop-ui-design.md:4` keeps this in OpenCode Desktop; `specs/desktop-ui-design.md:382-384` requires GoalPanel states for active/paused/achieved/error; `specs/v0.5.0-feature-work-orders.md:242-251` places the Desktop GoalPanel in `C:\Users\zerop\Development\opencode-source`; `MISSION_CONTROL_UI_DESIGN.md:30` requires controls and status visible together; `MISSION_CONTROL_UI_DESIGN.md:179-246` requires a status band, command strip, utility zone, and live activity while running.
The reconciliation: keep Start Goal/Start Chain in the same Goal dock by replacing the old active/paused branch with a polished running-status console that keeps status, controls, chain progress, activity, and history visible, and stop using the permission-denied `session.abort` path from the Goal dock.
If you cannot write the reconciliation, stop and ask.

## 2026-06-17 Chain UI polish, permission overlay, and first-step replay

### Spec reconciliation
User's literal words: "I need you to pick up where you left off on this project.  I need you to get the user interface polished and I I need it to look much better than it does. I ran into a permissions issue as soon as I tried to run one of these chains. It was the floating permission issue again. Where I couldn't approve anything. Also it looks like it's re triggering the first task twice. Like it should just be starting with the first item in the chain."
Spec surface: specs/desktop-ui-design.md:4 and specs/desktop-ui-design.md:11 keep this in the OpenCode Desktop Goal panel/session sidebar; specs/v0.4.0-roadmap.md:11-15 and specs/v0.4.0-roadmap.md:41-49 define chains as ordered GoalChainStep records that start at step 0 and advance on achievement; specs/v0.5.0-feature-work-orders.md:242-275 places the Desktop GoalPanel in `C:\Users\zerop\Development\opencode-source\packages\app` with real host/plugin invocation when available; specs/cli-hardening-work-order.md:42-44 keeps behavior fixes test-first.
Reconciliation: Continue the app-side Goal panel chain-builder work by polishing the Desktop UI shell, fixing host permission/question overlays so chain-run approvals remain reachable, and pinning Start Chain so it creates exactly one active first step rather than replaying the first action twice.
If you cannot write the reconciliation, stop and ask.

**Current state:** Implemented the Desktop Goal panel polish in `C:\Users\zerop\Development\opencode-source\packages\app\src\pages\session\goal-panel.tsx`: the playbook workspace now uses the target mock's four-zone console structure with explicit red Last Result, blue Set Goal, violet Chain Builder, and green Action Library/Action Editor shells. The accent borders/glows are inline styles because Electron dark-mode proof showed the dynamic Tailwind color classes were present but rendered as white. The action library/editor language is explicit rather than generic template chrome.

**Behavior fixes:** `startGoalChain()` now only sends `chain start-json ...`; it no longer calls the generic `startGoalRun()` after writing chain state, so the first chain step is not admitted twice through a second prompt. `SessionPermissionDock` now measures the sticky session viewport and prompt dock, sets `--permission-prompt-max-height`, observes resize, and wraps footer actions so floating permission approvals remain reachable.

**Verification:** App focused regressions pass: `bun test --preload ./happydom.ts src/pages/session/goal-panel.test.ts --test-name-pattern "four-zone|permission approval|start chain does not"`. Full Goal panel test passes 81/81 with 366 expects. App `bun run typecheck` passes. Native Electron Desktop is running from `C:\Users\zerop\Development\opencode-source\packages\desktop` via `bun run dev`; renderer is `http://localhost:5173`, CDP is `127.0.0.1:9222`, Electron main PID observed as `10764`. Electron dark-mode proof verified all five console zones and computed accent colors; screenshot saved at `C:\Users\zerop\Development\opencode-source\electron-goal-console-polished-20260617.png`.

**Handoff:** Current uncommitted work spans `packages/app/src/pages/session/goal-panel.tsx`, `packages/app/src/pages/session/goal-panel.test.ts`, `packages/app/src/pages/session/composer/session-permission-dock.tsx`, `packages/ui/src/components/message-part.css`, and this scratchpad. The live Electron session transcript contains older `Unauthorized: token is required` messages from a previous run; they did not block rendering or the UI proof, but should be separated from any future permission-overlay repro.

## 2026-06-16 Electron E2E instruction correction

### Spec reconciliation
User's literal words: "the repo instructions are wrong and need to be updated, I want full end to end testing, and then I need followup to go thru the functions live and tell you waht works and what does not work.  I want the electron app up, not the web page"
Spec surface: specs/desktop-ui-design.md:4, specs/desktop-ui-design.md:92, specs/desktop-ui-design.md:95, specs/desktop-ui-design.md:413, specs/v0.5.0-feature-work-orders.md:247, specs/v0.5.0-feature-work-orders.md:275, specs/v0.5.0-feature-work-orders.md:276
Reconciliation: Update the stale repo guidance so GUI verification targets the native OpenCode Desktop Electron app with sidecar/plugin reloads when needed, then run a live end-to-end function/button matrix and report which controls work or fail.
If you cannot write the reconciliation, stop and ask.

**Current state:** The previous systematic pass found and fixed a command-hook array-identity bug in `src/server.ts`, but the live recheck still used a stale already-running backend. The user has now explicitly corrected the stale no-restart guidance and requires Electron app proof, not browser-page proof. Next steps are to update the instruction files, rebuild/reload the plugin/desktop sidecar, launch the Electron app, and run the live button/function matrix against the native window.

## 2026-06-16 Systematic GUI/function testing

### Spec reconciliation
User's literal words: "I need systematic function testing, GUI button testing, polish"
Spec surface: specs/desktop-ui-design.md:11, specs/desktop-ui-design.md:66, specs/desktop-ui-design.md:261, specs/desktop-ui-design.md:276, specs/desktop-ui-design.md:384, specs/desktop-ui-design.md:413, specs/v0.5.0-feature-work-orders.md:242, specs/v0.5.0-feature-work-orders.md:255, specs/v0.5.0-feature-work-orders.md:256, specs/v0.5.0-feature-work-orders.md:275, MISSION_CONTROL_UI_DESIGN.md:29, MISSION_CONTROL_UI_DESIGN.md:159, MISSION_CONTROL_UI_DESIGN.md:169, MISSION_CONTROL_UI_DESIGN.md:216, MISSION_CONTROL_UI_DESIGN.md:249, MISSION_CONTROL_UI_DESIGN.md:358, MISSION_CONTROL_UI_IMPLEMENTATION_PLAN.md:506, MISSION_CONTROL_UI_IMPLEMENTATION_PLAN.md:596, MISSION_CONTROL_UI_IMPLEMENTATION_PLAN.md:619, MISSION_CONTROL_UI_IMPLEMENTATION_PLAN.md:709, MISSION_CONTROL_UI_IMPLEMENTATION_PLAN.md:756
Reconciliation: Build and execute a systematic function and rendered-button test pass for the OpenCode Desktop Mission Control/Goal dock GUI, polishing only concrete issues found on that host-consumed app surface and preserving the OpenGoal plugin contracts it depends on.
If you cannot write the reconciliation, stop and ask.

**Current state:** Starting a systematic matrix pass after the previous browser proof. The target is the already-running app at `http://127.0.0.1:4444/` backed by the OpenGoal workspace, not the terminal TUI. Function coverage should include app pure helpers/hooks plus OpenGoal plugin contract tests; GUI coverage should click real Home and Goal dock buttons and verify state changes, not just screenshots.

**Systematic pass result:** Inventory covered the Desktop app helpers/hooks (`layout/helpers`, `home`, `session/helpers`, `goal-panel-*`, `status-popover`) and the OpenGoal plugin contracts. Fixed one file-integrity polish issue in `C:\Users\zerop\Development\opencode-source\packages\app\src\pages\session\goal-panel-contract.test.ts`: the control-character fixture contained a literal NUL byte, so `rg` treated the test as binary; it now uses the escaped runtime string `\u0000`, and a byte check reports `NullByteCount: 0`. Automated gates are green: app `bun run typecheck` passes; focused app GUI/helper sweep passes 169/169; OpenGoal `npm test` passes 1148/1148 after adding a new server hook regression.

**Browser button matrix:** Home/Mission Control rendered with no console warn/error logs. Verified metric disabled-state logic, Projects dialog open/close, Active Goals history dialog, New Session entering the draft flow, and Open Goal routing into a session with the Goal dock selected. In the dock, Pause -> Resume worked at runtime, but the budget `+` button exposed a real integration bug: `/goal turns 21` mutated the active goal into `condition: "turns 21"` because the plugin hook assigned `output.parts = [...]` while the host kept the original command-template parts array alive. Fixed in `src/server.ts` by mutating the host-owned `output.parts` array in place and making the fallback command template inert; regression added in `test/server-dials.test.mjs` proves the original goal condition survives a `turns 21` hook call. Caveat: the already-running browser backend still has stale plugin code loaded; per app instructions it was not restarted, so the narrow live recheck still reproduced the stale behavior. Re-run the dock button matrix after a backend/desktop reload picks up the rebuilt plugin.

## 2026-06-16 GUI continuation

### Spec reconciliation
User's literal words: "Sorry I mean GUI?"
Spec surface: specs/desktop-ui-design.md:11, specs/desktop-ui-design.md:293, specs/desktop-ui-design.md:299, specs/desktop-ui-design.md:310, specs/v0.5.0-feature-work-orders.md:242, specs/v0.5.0-feature-work-orders.md:255, specs/v0.5.0-feature-work-orders.md:259, specs/v0.5.0-feature-work-orders.md:265, MISSION_CONTROL_UI_DESIGN.md:169, MISSION_CONTROL_UI_DESIGN.md:358, MISSION_CONTROL_UI_IMPLEMENTATION_PLAN.md:5, MISSION_CONTROL_UI_IMPLEMENTATION_PLAN.md:7, MISSION_CONTROL_UI_IMPLEMENTATION_PLAN.md:756
Reconciliation: Continue the current OpenCode Desktop Mission Control GUI work in the host-consumed app/dock surface, using the OpenGoal plugin/block contracts only where the GUI depends on them, and do not resume the terminal TUI surface.
If you cannot write the reconciliation, stop and ask.

**Current state:** User corrected the target from TUI to GUI. The spec pass and handoff show the current GUI frontier is the OpenCode Desktop Mission Control/Goal dock integration, with remaining work to be identified from the live dirty tree and punch-list rather than inventing a new standalone surface.

**2026-06-16 runtime proof:** The current dirty GUI implementation already contains the punch-list fixes: optimistic same-slot pause/resume, focus-preserving goal state reconciliation, live-goal tab close gating, dynamic template snapshot support, compact history pills, and toast offset plumbing. Verified app package gates: `bun run typecheck` passes and the focused GUI sweep passes 169/169 (`layout/helpers`, `home`, `session/helpers`, `goal-panel-contract`, `goal-panel-lifecycle`, `goal-panel`, `status-popover`). Browser verification against the already-running app at `http://127.0.0.1:4444/` passed: Home renders the Mission Control board with OpenGoal visible and no console warn/error logs; Open Goal opens the OpenGoal session/Goal dock; setting a disposable goal through the dock shows active status, budget controls, activity, and history; Pause switches the same control slot to disabled Resume immediately and then to enabled Resume after the poll; Resume round-trips back to enabled Pause; the Steer input retains focus and text across a polling interval; clearing the disposable goal via `node dist\cli.js --dir C:\Users\zerop\Development\OpenGoal clear` returns exit 0 and the dock falls back to Set Goal + Recent Runs. OpenGoal `npm test` passes 1147/1147. Remaining boundary: this is browser-rendered runtime proof, not a native Electron window smoke; the existing untracked `.opencode/goal-history.json` now includes additional disposable smoke history and was left in place.

## 2026-06-16 Continue repo runtime proof

### Spec reconciliation
User's literal words: "Can you continue working on this repo?"
Spec surface: specs/desktop-ui-design.md:11, specs/desktop-ui-design.md:277, specs/v0.5.0-feature-work-orders.md:242, MISSION_CONTROL_UI_IMPLEMENTATION_PLAN.md:756
Reconciliation: Continue from the current OpenGoal/opencode-source frontier by verifying the OpenCode Desktop app-side Mission Control and Goal dock against the OpenGoal workspace, only editing code if runtime proof exposes a concrete blocker on that host-consumed surface.
If you cannot write the reconciliation, stop and ask.

**Current state:** Starting from the dirty continuation tree. Ports `4096`, `4173`, and `4444` were already listening, so no app/server process was restarted or killed. Browser proof found the Mission Control home board was using only the app-local pinned project list; the backend already knew `OpenGoal`, but the home board/picker showed zero projects. Fixed in `C:\Users\zerop\Development\opencode-source\packages\app\src\pages\layout\helpers.ts` via `mergeHomeProjectLists()` and wired `HomeDesign` to merge backend-known projects with locally opened projects. Browser reload at `http://127.0.0.1:4444/` now shows Projects `2`, Live Sessions `1`, Active Goals `1`, with `OpenGoal` visible and no console warn/error logs. Opened the OpenGoal session, switched to the Goal tab, set a disposable smoke goal through the dock, verified the panel transitioned to ACTIVE without `Command not found`, then cleared it via `node dist\cli.js --dir C:\Users\zerop\Development\OpenGoal clear`; follow-up status reports no active goal. Verification: `bun test --preload ./happydom.ts ./src/pages/layout/helpers.test.ts ./src/pages/home.test.ts` passes 39/39; `bun run typecheck` in `packages/app` passes; full `bun test --preload ./happydom.ts` in `packages/app` passes 527/527. The disposable smoke created an untracked `.opencode/goal-history.json` archive artifact in OpenGoal; left it in place rather than deleting generated history unilaterally.

## 2026-06-16 Resume verification pass

### Spec reconciliation
User's literal words: "Resume working please."
Spec surface: specs/desktop-ui-design.md:11, specs/desktop-ui-design.md:277, MISSION_CONTROL_UI_DESIGN.md:365, MISSION_CONTROL_UI_IMPLEMENTATION_PLAN.md:756
Reconciliation: Resume the OpenCode Desktop app-side Mission Control verification pass by proving the current OpenGoal plugin and opencode-source app/desktop gates, while leaving running-window verification as the remaining step because no existing local app/backend ports are listening and package instructions forbid restarting services.
If you cannot write the reconciliation, stop and ask.

**Current state:** Re-read the spec surface and handoff, then checked local listeners and found no existing app/backend target on `4444`, `4096`, or `11305`. Because no target was running, started a fresh local dev target instead of restarting anything: backend `127.0.0.1:4096` (PID `40756`) and app `http://127.0.0.1:4444/` (port owner PID `36432`, launched by Bun PID `38376`). Browser smoke verified the Mission Control home board renders visibly with Projects/Live Sessions/Active Goals/Needs Attention metrics, search, action buttons, no framework overlay, and no console warn/error logs. Clicking New Session opens the expected Open Project modal in the zero-project state. Verified this pass: OpenGoal `npm test` passes 1147/1147; app `bun run typecheck` passes; app focused GUI sweep passes 80/80; app full `bun test --preload ./happydom.ts` passes 526/526; desktop `bun test electron-builder.config.test.ts` plus `bun run typecheck` passes; desktop full `bun test` passes 60/60; desktop `bun run build` exits 0 with existing bundle warnings only. Remaining proof: live session/Goal dock verification after a project/session exists in the running backend, plus Electron desktop-window confirmation for desktop-only positioning behavior.

## 2026-06-16 Status popover truth table

### Spec reconciliation
User's literal words: "Finish building, debugging, polishing, testing, and adversarially-scanning the application - bring it to a functional, polished production state."
Spec surface: specs/desktop-ui-design.md:11, specs/desktop-ui-design.md:277, MISSION_CONTROL_UI_DESIGN.md:114, MISSION_CONTROL_UI_DESIGN.md:143, MISSION_CONTROL_UI_IMPLEMENTATION_PLAN.md:739
Reconciliation: Continue hardening the OpenCode Desktop app-side Mission Control shell by fixing a status-popover signal-class regression in `C:\Users\zerop\Development\opencode-source`, not by changing the OpenGoal plugin or standalone terminal/TUI surface.
If you cannot write the reconciliation, stop and ask.

**Current state:** Investigation found a concrete legacy status-popover bug while auditing remaining portal/overlay risks: the non-V2 status dot marked healthy server state as both `critical` and `weak`, unlike the V2 truth table. `C:\Users\zerop\Development\opencode-source\packages\app\src\components\status-popover-tone.ts` now owns the shared status tone truth table and both legacy/V2 popovers consume it. Added `status-popover.test.ts` for the truth table and pinned that generic `tab.close` cannot close the Goal tab via `createSessionTabs().closableTab()`. Verified: status-popover focused test passes 4/4, session helpers pass 27/27, app typecheck passes, focused GUI sweep passes 149/149, full app suite passes 526/526, and desktop `bun run build` exits 0 with existing bundle warnings only. Runtime window verification remains pending because no local app/backend ports were listening and this session did not restart services.

## 2026-06-16 Toast/right-dock positioning

### Spec reconciliation
User's literal words: "Lets rock"
Spec surface: specs/desktop-ui-design.md:11, specs/desktop-ui-design.md:289, MISSION_CONTROL_UI_DESIGN.md:153, MISSION_CONTROL_UI_DESIGN.md:169, MISSION_CONTROL_UI_IMPLEMENTATION_PLAN.md:762
Reconciliation: Fix the OpenCode Desktop app-side positioning path for global permission/question toasts so they avoid the Mission Control right dock, without changing the OpenGoal plugin or terminal/TUI surfaces.
If you cannot write the reconciliation, stop and ask.

**Current state:** The likely "windows render in wrong spaces" cause was body-level toast portals using fixed `right: 32px` even while the desktop right dock/file panel is open. `C:\Users\zerop\Development\opencode-source\packages\app\src\pages\session.tsx` now publishes `--oc-toast-region-right` from the active right-panel width via `toastOffsetRight`, and removes the variable on cleanup. Both legacy and v2 toast regions consume the variable with a `32px` fallback. Verified: app focused helper test passes 26/26, app typecheck passes, focused GUI sweep passes 144/144, full app test passes 521/521, and desktop `bun run build` exits 0 with existing bundle warnings only. Live running-window verification is still pending because this session did not restart the app/server.

## 2026-06-16 Desktop typecheck unblock

### Spec reconciliation
User's literal words: "Lets rock"
Spec surface: specs/desktop-ui-design.md:4, MISSION_CONTROL_UI_IMPLEMENTATION_PLAN.md:17, MISSION_CONTROL_UI_IMPLEMENTATION_PLAN.md:739
Reconciliation: Clear the OpenCode Desktop fork's package typecheck blocker needed for Mission Control GUI verification by restoring the existing desktop main-process `node:http` dependency in `C:\Users\zerop\Development\opencode-source`, not by changing the OpenGoal terminal/TUI surface.
If you cannot write the reconciliation, stop and ask.

**Current state:** `C:\Users\zerop\Development\opencode-source\packages\desktop\src\main\index.ts` now imports `node:http` via a default `Http` binding and calls `setGlobalProxyFromEnv()` through a narrow local type instead of `any`. The previously failing desktop `bun run typecheck` now passes; desktop renderer tests pass; app typecheck + focused GUI tests pass; OpenGoal `npm test` passes.

**2026-06-16 follow-up:** Full desktop tests were still red on `electron-builder.config.test.ts` because the Linux legacy launcher fpm mapping emitted a Windows absolute path. `C:\Users\zerop\Development\opencode-source\packages\desktop\electron-builder.config.ts` now keeps `resources/linux/opencode-desktop.desktop` package-relative so the mapping is platform-neutral. Verified: desktop focused packaging test passes, desktop `bun run typecheck` passes, desktop full `bun test` passes 60/60, and desktop `bun run build` exits 0.

## 2026-06-13 Mission Control execution

### Spec reconciliation
User's literal words: "Read UI Mission Control plan and start work on carrying it out.  Don't spent tons of time reading the backstory of the repo, save context.  Here's the ID to the old chat for searching:  019ec1e3-32b4-7571-ad80-dc6d02c490b6"
Spec surface: specs/cli-hardening-work-order.md:101, specs/desktop-ui-design.md:9, specs/v0.4.0-roadmap.md:138, specs/v0.5.0-feature-work-orders.md:242
Reconciliation: Execute the Mission Control plan from the live current frontier, starting with the desktop shell and new-session guardrails in `C:\Users\zerop\Development\opencode-source`, while preserving the OpenGoal plugin contracts that the dock depends on.
If you cannot write the reconciliation, stop and ask.

### Spec reconciliation
User's literal words: "Read UI Mission Control plan and start work on carrying it out.  Don't spent tons of time reading the backstory of the repo, save context.  Here's the ID to the old chat for searching:  019ec1e3-32b4-7571-ad80-dc6d02c490b6"
Spec surface: MISSION_CONTROL_UI_IMPLEMENTATION_PLAN.md:62, MISSION_CONTROL_UI_IMPLEMENTATION_PLAN.md:95, specs/desktop-ui-design.md:1, specs/v0.5.0-feature-work-orders.md:223
Reconciliation: Execute Task 1 only by locking the existing desktop renderer stylesheet import and the titlebar draft-session entrypoint in `C:\Users\zerop\Development\opencode-source`, then verify them with the focused regression tests and typechecks.
If you cannot write the reconciliation, stop and ask.

---

## Handoff

**From:** v0.7.0 attempt session (2026-06-12/13, 23 commits on `main`)
**To:** next agent (human or AI) picking up this repo
**When:** 2026-06-13, post-recovery

**Current state:**
- HEAD on `main`: `2233cc5` (pre-commit hook) → `97d7813` (AGENTS.md) → `3f1a0ba` (README v0.7.0) → `752b49c` (version bump) → 21 v0.7.0 commits → `ba145d8` (v0.6.1, public release).
- Working tree: clean except for untracked working notes (`.hermes/scratchpad.md` already in the repo, `docs/`, `specs/`).
- Public registry: still v0.6.1. **No `npm publish` was run.**
- 1053/1053 tests green (verified 3× runs pre-recovery; the new `AGENTS.md` and `tools/guard-spec-ref.sh` don't change any source so the test count should still be 1053/1053).

**What was just added (this recovery session):**
- `AGENTS.md` (root of repo) — 9-rule standing document. The 3 most load-bearing rules: §1 "The spec wins," §2 "Host integration = host-consumed artifacts," §5 "Wrong-surface commits are mined, not reverted."
- `tools/guard-spec-ref.sh` + `tools/hooks/pre-commit` (identical copies) — pre-commit hook that blocks any `src/` commit without a `specs/<file>.md §N.M` reference in the message. Registered via `git config core.hooksPath tools/hooks`. Verified with 9/9 unit cases (6 pass + 2 block + 1 non-src-bypass).
- `.hermes/scratchpad.md` — rewritten to the structured template. The "Historical task snapshots" section has a one-paragraph retrospective of the v0.7.0 wrong-surface attempt so the next agent doesn't have to re-derive why the v0.7.0 commits are wrong-surface work.

**What was just learned:**
- The right surface for "GUI" requests on this plugin is `src/blocks/` emitting `ctx.render({ blocks: RenderBlock[] })` payloads (per `specs/render-protocol-design.md`). The v0.7.0 attempt landed in `src/control-center.ts` as a fancier standalone `runControlCenter` TUI command. Both can coexist; the v0.7.0 work is recoverable but should not be the next step.
- The pure modules from v0.7.0 are surface-agnostic and survive re-targeting: `session-events.ts`, `step-timeline.ts`, `control-center-history.ts`, `picker.ts`, `help-content.ts`, `help-overlay.ts`, `templates-view.ts`. The shell (`runControlCenter` in `src/control-center.ts`) is the wrong shape and should be either repurposed or left as-is on a `wip/wrong-surface` tag.

**Next concrete step:**
1. **Read the spec.** `cat specs/render-protocol-design.md` (in full — 841 lines). Don't skim.
2. **Decide the next task.** Likely candidates: (a) `feat(blocks): emit stat-row for eval failures` against the block protocol; (b) `feat(blocks): add a new block type for steering notes`; (c) something else per the user's request.
3. **Write the spec reconciliation** in the "Active task" section above before writing any code. AGENTS.md §3.
4. **Branch from `2233cc5`** for new work. Don't stack new features on the v0.7.0 commit chain until that work has its own spec reconciliation.
5. The v0.7.0 chain (`3f1a0ba` and below) is recoverable: `git tag -a wip/v070-wrong-surface 3f1a0ba` to mark the boundary if it isn't already.

**Do NOT do:**
- Don't revert the v0.7.0 commits. Per AGENTS.md §5 and explicit user instruction, the work stays.
- Don't `npm publish` anything. Public surface is v0.6.1 and the v0.7.0 work is local-only.
- Don't start writing code without the spec reconciliation filled in above.

---

## Historical task snapshots

_(prior sessions, kept short — one paragraph each)_

### v0.7.0 attempt (2026-06-12/13)

Built 23 commits against the wrong surface. The deliverable
should have been a `src/blocks/` module emitting
`ctx.render({ blocks: RenderBlock[] })` payloads from the
server plugin (per `specs/render-protocol-design.md`), but
the work landed in `src/control-center.ts` as a fancier
standalone `runControlCenter` TUI command. The pure modules
(`session-events.ts`, `step-timeline.ts`,
`control-center-history.ts`, `picker.ts`, `help-content.ts`,
`help-overlay.ts`, `templates-view.ts`) are surface-agnostic
and survive a re-target. The shell + CLI are the wrong
shape and need to be re-purposed or discarded. 1053/1053
tests green, but on the wrong surface — test count is
orthogonal to surface correctness (per AGENTS.md §6).
Public registry still shows v0.6.1 (commit `ba145d8`);
v0.7.0 work is local-only on `main`, ahead of `ba145d8` by
23 commits, head `3f1a0ba` at the time this snapshot was
written.

### Recovery: standing rules + pre-commit hook (2026-06-13)

Wrote `AGENTS.md` (the 9-rule standing document) and
`tools/guard-spec-ref.sh` (the pre-commit hook that enforces
spec references in commit messages touching `src/`). The
scratchpad was rewritten to the structured template above.
The hook is registered via `git config core.hooksPath
tools/hooks` so it runs on every commit. A copy of the hook
also lives at `tools/hooks/pre-commit` for direct `.git/hooks/`
installation. Both forms are equivalent; pick one.

To verify the hook works: try a commit that touches `src/`
without a spec reference — it should be blocked. Try one
with `(spec §2.2)` in the message — it should pass.
## 2026-06-13 Recovery pass

### Spec reconciliation
User's literal words: "I need you to work on this again. I've tried to work in it while you were out, but I think we just messed it up." / "It's worse than just the sidebar. The front page renders with no styling. I'm missing some buttons. Even the open goal functionality doesn't seem to work quite right and the buttons are poorly styled and other shit."
Spec surface: specs/desktop-ui-design.md:1, specs/desktop-ui-design.md:38, specs/desktop-ui-design.md:277
Reconciliation: Fix the actual desktop goal-panel render path and desktop shell styling first, then correct goal-tab open behavior on the live app surface instead of building a new surface.

## 2026-06-13 Mission Control Task 2

### Spec reconciliation
User's literal words: "Task 2: Build the Home Page Global Ops Board"
Spec surface: MISSION_CONTROL_UI_IMPLEMENTATION_PLAN.md:192, MISSION_CONTROL_UI_DESIGN.md:47, specs/desktop-ui-design.md:1, specs/v0.5.0-feature-work-orders.md:242
Reconciliation: Implement the home-page mission-control contract on the existing `HomeDesign` surface in `C:\Users\zerop\Development\opencode-source\packages\app\src\pages\home.tsx`, preserving current session/project behavior while adding the Global Ops Board metrics and action affordances the desktop host consumes.
If you cannot write the reconciliation, stop and ask.

## 2026-06-16 Electron GUI control verification

**Current state:** The OpenCode Desktop app is the verified target, not the web page. Live Board rows are clipped inside `home-live-board` with hit-testing below the card returning the page/container rather than off-card session rows. The New Session/session composer screenshots show the composer no longer covering session text. The Goal panel's budget controls now call `POST /experimental/goal/control/goal_control` with the active directory in both query and body, and the sidecar uses a Node-compatible state-file fallback for core GUI commands.

**Live evidence:** Fresh Electron sidecar `http://127.0.0.1:15981`; renderer CDP page `7109041AB4DCF35A71BB03D36C700F73`. Clicking `Increase turn limit` in the native app returned `200`, body `Max turns: 24 -> 25`, changed `C:\Users\zerop\Development\opencode-source\.opencode\.goal-state.json` from `maxTurns=24` to `25`, updated the UI to `TURNS 2/25`, and produced no `/session/.../command` or `/command` requests. Screenshot: `electron-goal-control-after-turns-plus.png`.

**Verification:** `C:\Users\zerop\Development\opencode-source\packages\app` typecheck passed. Focused app tests passed 67/67. `packages/opencode` goal-control state helper tests passed 5/5. `packages/opencode` typecheck is still blocked by the existing unrelated `packages/tui/src/component/dialog-provider.tsx` `errorMessage` symbol errors.

## 2026-06-16 Template launch adjustability

### Spec reconciliation
User's literal words: "Also the start from the template buttons are dumb if we can't adjust them or if we don't know what the hell they're actually starting. Like this is kind of weak. We should be able to put our own templates in or we should know what these templates are or we should I mean this should be adjustable totally adjustable. This is way too little."
The repo's spec surface for this work: `specs/desktop-ui-design.md:1` and `specs/desktop-ui-design.md:4` make OpenCode Desktop the target; `specs/v0.4.0-roadmap.md:468-516` defines templates, variables, discovery, export, and import; `specs/v0.5.0-feature-work-orders.md:242-263` places the GoalPanel in `C:\Users\zerop\Development\opencode-source`.
The reconciliation: enrich the plugin template snapshot and the Desktop GoalPanel so template buttons show their condition, command, source, and variables and can be adjusted through the existing Set Goal path before launch, while keeping generic controls turnless.

## 2026-06-16 Template pick-list correction

### Spec reconciliation
User's literal words: "Hey the templates section has to bre a pick list not buttons, with edit, view, maybe like duplicate, delete, etc..."
The repo's spec surface for this work: `specs/desktop-ui-design.md:1` and `specs/desktop-ui-design.md:4` keep this on the OpenCode Desktop GoalPanel, while `specs/v0.4.0-roadmap.md:514-516` defines template discovery, export, and import as the plugin-backed template operations.
The reconciliation: render templates as a selectable Desktop pick-list with an inspector; keep view/edit/duplicate/save/delete as deterministic template control operations, adding a narrow project-template delete command because the existing plugin only has list/export/import.

## 2026-06-17 Chain builder correction

### Spec reconciliation
User's literal words: "Lets build the chain builder, you're exactly right on this, brainstorm order of operations, edge cases, features, or gaps tha we may have missed then lets build it"
The repo's spec surface for this work: `specs/desktop-ui-design.md:1` and `specs/v0.5.0-feature-work-orders.md:242-263` keep the visual surface in OpenCode Desktop `packages/app`, while `specs/v0.4.0-roadmap.md:13-49` defines chains as `GoalChainStep[]` with per-step `maxTurns` and `maxMinutes`.
The reconciliation: replace the rejected template picker with a Desktop two-column chain builder that composes local action prompts into rich `GoalChainStep` records, then add the narrow plugin command bridge needed for the Desktop control endpoint to start that spec-defined chain without building a separate app.

## 2026-06-17 Stop plan abort path

### Spec reconciliation
User's literal words: "stoping the plan didn't stop the AI from continuing.."
The repo's spec surface for this work: `specs/desktop-ui-design.md:11` and `specs/desktop-ui-design.md:66-68` put pause/resume/clear controls in the OpenCode Desktop session sidebar; `specs/desktop-ui-design.md:335-337` says Clear stops the auto-loop and clears the current goal.
The reconciliation: the Desktop Stop/confirm-stop action must clear the OpenGoal state through the deterministic goal control endpoint and also abort the active OpenCode session turn through the host session abort API, without turning dialable controls into chat prompts.

## 2026-06-17 Chain action semantics audit

### Spec reconciliation
User's literal words: "Some of the menu doesn't make sense.  Do all the buttons work as intended?  Is there no option for raised elements or color?" / "Like, are all of these things dialable? Can we change them where we need to? Like category planning, gate behavior required? Like what is some of this stuff? Is it even d doing anything?And why are we designating the difference between a built in or a prompt? Like it doesn't matter. These are all just actions.Furthermore I need to know if these things all work in the right order and if they like work when I cancel them or bring them back or you know like do some filtering or I click the buttons like everything should be alterable here. Like I need the the user needs to know what the hell's going on."
The repo's spec surface for this work: `specs/desktop-ui-design.md:1-4` makes OpenCode Desktop the target surface; `specs/v0.4.0-roadmap.md:13-49` defines chain steps as condition, command, and constraints; `specs/v0.4.0-roadmap.md:89-121` defines achievement-driven chain advancement; `specs/v0.4.0-roadmap.md:211-240` defines verification as the runtime gate; `specs/v0.5.0-feature-work-orders.md:242-263` says Desktop controls must use real host/plugin invocation when available.
The reconciliation: audit and tighten the Desktop action builder so every editable field either mutates the file-backed action/chain state through the deterministic control path or is explicitly presented as display/planning metadata, with gate semantics mapped to verification/requiredness rather than an inert label.

## 2026-06-17 Native Electron sidebar finish-line proof

**Current state:** `C:\Users\zerop\Development\opencode-source\packages\app\src\components\titlebar.tsx` now clamps the Electron Windows titlebar width to `100vw - window-controls-width` and makes the V2 session tab strip the shrinkable scroll region, so the New Session, Goal, and Review action rail stays inside the visible native window. This fixed the case where the Goal button existed but could be pushed offscreen by `env(titlebar-area-width)`.

**Action-library proof:** In the running native OpenCode Desktop window, the Goal sidebar was opened from the titlebar button. The action library was then exercised through the live UI: Add inserted a local chain step and enabled Start chain; remove returned the chain to `0 steps` and disabled Start chain; category filtering narrowed rows to Testing only; search narrowed to Validate/Typecheck; New action opened the editor; category, checkpoint, color, and elevation controls changed to Review / review / Emerald / Raised; a temporary `codex-proof-*` action saved through the deterministic template route, rendered with the chosen metadata, then deleted through the UI. Disk check after delete: no `.opencode/goals/codex-proof-*.json`, and `.opencode/goal-templates.json` did not contain the proof id.

**Screenshots:** `C:\Users\zerop\Development\opencode-source\output\playwright\electron-goal-titlebar-visible-after-clamp.png` proves the Goal titlebar control opens the sidebar and mounts the Goal workspace. `C:\Users\zerop\Development\opencode-source\output\playwright\electron-goal-action-library-live-proof.png` proves the action library/editor state after the live control pass.

**Verification:** `packages/app`: focused sidebar/titlebar/home tests passed `190 pass / 0 fail`; full app suite passed `574 pass / 0 fail`; `bun run typecheck` passed. `packages/opencode`: `bun test test/goal-control-state.test.ts` passed `10 pass / 0 fail`; `bun script/build-node.ts` completed. Native Desktop dev process was relaunched from `packages/desktop` with sidecar `http://127.0.0.1:27255`, renderer `http://localhost:5173`, and CDP `127.0.0.1:9222`.

## 2026-06-17 Action editor terminology correction

### Spec reconciliation
User's literal words: "These buttons make no sense. The \"checkpoints\" makes no sense, who is calling this, when does it run? What does it do? This issue is with most things here, like the \"tags\" button is useless, \"category\" button should be super small, most of the informational bars should be a single line at best. This still is not what I asked for."
The repo's spec surface for this work: `specs/desktop-ui-design.md:1-4` keeps this in the OpenCode Desktop Goal panel; `specs/v0.4.0-roadmap.md:13-49` defines chain steps as condition, command, and constraints; `specs/v0.4.0-roadmap.md:89-121` says chain advancement is driven by goal achievement; `specs/v0.4.0-roadmap.md:211-240` defines verification as shell/http/file/marker rather than a vague checkpoint; `specs/v0.5.0-feature-work-orders.md:242-263` requires real host/plugin invocation when available.
The reconciliation: remove or demote inert metadata from the main action editor, replace checkpoint/gate labels with a truthful one-line completion rule derived from the actual verifier (`command` or `GOAL_COMPLETE` marker), and keep category/color/elevation as compact display/edit styling rather than large informational cards.

### Completion note
Claude's Method Library rename is now completed in the Desktop app source contract. In `C:\Users\zerop\Development\opencode-source\packages\app`, `goal-panel.tsx` no longer renders or sends checkpoint/gate metadata from the Method Library/editor/chain start path, the old source-kind tags are gone, and the old `goal-action-library-rail` / `goal-action-inspector` selectors were replaced with `goal-method-library-rail` / `goal-method-inspector`. The chain budget area now has one `goal-chain-summary-line` instead of a Checkpoints metric, and method cards show `Goal marker` / `Command check` completion rules.

Verification: `bun test --preload ./happydom.ts` passed `574 pass / 0 fail` from `packages/app`, and `bun typecheck` passed from `packages/app`. Native Electron proof used the running Desktop app on CDP `127.0.0.1:9222`: opened the OpenGoal session's Goal tab, verified the Method Library selectors, clicked `Add to chain` to create one local draft row with summary `1 methods · 0 command checks · 1 marker checks`, captured `C:\Users\zerop\AppData\Local\Temp\opengoal-method-library-electron.png`, then clicked Remove and confirmed the draft returned to `0 methods · 0 command checks · 0 marker checks`.

## 2026-06-17 Action workspace layout correction

### Spec reconciliation
User's literal words: "The top panel buttons are way too tall... The \"Last Result\" window is poorly laid out... Max turns/Step/Estimated turns <-- does this even work? What is checks?... For Chain Builder title block, the start chain and the steps should be on the left... Why isn't that just a small little header?... there should be an add button that goes from the method library over to the run order... what the hell does goal marker mean inside that search method?... this isn't a goal maker, this is a an action maker... all that wasted space in the bottom where it says time limit, term limit, checks, and estimated total like that should be at the top."
The repo's spec surface for this work: `specs/desktop-ui-design.md:1-4` keeps this in the OpenCode Desktop Goal panel; `specs/v0.4.0-roadmap.md:13-49` defines chain steps as ordered goals with per-step turn/time limits; `specs/v0.4.0-roadmap.md:211-240` defines verification behavior; `specs/v0.5.0-feature-work-orders.md:242-263` says the Desktop GoalPanel belongs in `C:\Users\zerop\Development\opencode-source`.
The reconciliation: tighten the app-side Goal panel action workspace so the top readouts use current/max turn and time language, the Chain Builder header owns start/step/budget controls, library rows have an explicit local Add-to-run-order action, and the editor is named as an action editor without exposing checkpoint/source taxonomy.

## 2026-06-17 Goal tab four-panel shell

### Spec reconciliation
User's literal words: "Look, last result should be its own encapsulated box with the status on the left so that it's really clear and obvious... For the set of goal that should all be one box as well... The chain builder should be its own separate box because these are all three different major functions."
The repo's spec surface for this work: `specs/desktop-ui-design.md:1-4` keeps the work in the OpenCode Desktop Goal panel; `specs/v0.4.0-roadmap.md:13-49` defines the chain data the builder edits; `specs/v0.5.0-feature-work-orders.md:242-263` names `packages/app` as the Desktop GoalPanel surface.
The reconciliation: replace the Goal tab layout shell with peer panels for Last Result, Set a Goal, Chain Builder, and Action Library/Editor, preserving the existing deterministic controls and local chain-draft behavior.

## 2026-06-17 Action builder recovery

### Spec reconciliation
User's literal words: "PLEASE IMPLEMENT THIS PLAN: # Goal Panel Action Builder Recovery Plan ... Action Library stores reusable actions, Action Editor edits one action draft, Chain Builder contains the run order, Set a Goal remains separate, and only Start Chain runs anything."
The repo's spec surface for this work: `specs/desktop-ui-design.md:1-4` keeps this in the OpenCode Desktop Goal panel; `specs/v0.4.0-roadmap.md:13-49` defines chain steps as condition, command, and per-step constraints; `specs/v0.4.0-roadmap.md:211-240` defines verification behavior instead of vague checkpoints; `specs/v0.5.0-feature-work-orders.md:242-263` places the app-side GoalPanel in `C:\Users\zerop\Development\opencode-source`.
The reconciliation: stabilize the Desktop action builder so the library selects reusable actions into one editable draft, the editor can save/duplicate/delete/add that draft, Set Goal stays separate, and only the Chain Builder start action crosses the run boundary.

## 2026-06-17 Chain builder header streamline

### Spec reconciliation
User's literal words: "streamline this bar, this is very ugly, weird spacing, weird layout"
The repo's spec surface for this work: `specs/desktop-ui-design.md:1-4` keeps this in the OpenCode Desktop Goal panel; `specs/v0.4.0-roadmap.md:13-49` defines chain steps with per-step `maxTurns` and `maxMinutes`; `specs/v0.5.0-feature-work-orders.md:242-263` places the Desktop GoalPanel work in `C:\Users\zerop\Development\opencode-source`.
The reconciliation: tighten the Chain Builder header into one compact control/status strip that keeps Start Chain, step count, run limits, and verification summary visible without tall budget cards or uneven spacing.

## 2026-06-17 Goal console polish and chain semantics pass

### Spec reconciliation
User's literal words: "Why isn't this polished and a little more meaningful?" / "How am I supposed to scroll through any of this or use any of it?" / "Why do I see some dotted line at the bottom what does that even mean? Is this gonna show my chains properly? Will it execute through them one by one without duplication or getting caught up on permissions or other crap? Is it letting me set the skills per action? Are all of the other dials working for each action? Is it gonna trigger weird turns when I change things or try to stop or pause or resume?"
The repo's spec surface for this work: `specs/desktop-ui-design.md:1-4` keeps the surface in OpenCode Desktop; `specs/v0.4.0-roadmap.md:13-49` defines chains as ordered file-backed steps with condition, command/verification, and per-step turn/time limits; `specs/v0.4.0-roadmap.md:89-121` defines auto-advance after achievement; `specs/v0.5.0-feature-work-orders.md:242-263` places the Desktop GoalPanel in `C:\Users\zerop\Development\opencode-source`.
The reconciliation: make the Desktop Goal console explain and render the real chain boundary: local draft edits do not start turns, Start Chain sends exactly one `chain start-json` control, the plugin activates step 1 and advances after achievement, permission prompts stay reachable, and per-action OpenCode skill/agent selection is not shown because it is not supported by the current chain schema.

### Current state
The GoalPanel now uses bounded scroll bodies for the Action Library and Action Editor, a filled/labeled Last Result output card, dense command-list action rows, and a Chain Builder empty state that no longer renders fake dashed/drop-zone affordances. Non-empty chain rows fit inside the native Electron panel without horizontal overflow and expose per-step turns/minutes, completion rule, reorder, and remove controls. Start Chain preserves ordered steps plus condition, shell/marker verification, maxTurns, maxMinutes, category, tone, and elevation; it does not send `startGoalRun` or `promptAsync` a second time. Stop/clear still clears the goal and aborts the active session turn. Permission approval prompts are viewport-clamped and their action footer wraps.

### Verification
`C:\Users\zerop\Development\opencode-source\packages\app`: `bun test --preload ./happydom.ts src/pages/session/goal-panel.test.ts` passed `85 pass / 0 fail`; `bun run typecheck` passed. `C:\Users\zerop\Development\OpenGoal`: `bun test test/goal-chain.test.mjs` passed `43 pass / 0 fail`, covering create, advance, completion, loop, override guard, corrupt/oversize rejection, and verification-shape validation. Native Electron Desktop was relaunched from `packages/desktop`; CDP proof captured `C:\Users\zerop\Development\opencode-source\electron-chain-builder-clean-20260617.png`, `C:\Users\zerop\Development\opencode-source\electron-chain-builder-with-action-fit-20260617.png`, and `C:\Users\zerop\Development\opencode-source\electron-goal-console-final-20260617.png`.

## 2026-06-17 Target chain workspace and runtime controls

### Spec reconciliation
User's literal words: "/GOAL POLISH THE WORKSPACE UNTIL IT FUNCTIONIONALLY AND VISUALLY MATCHES THE TARGET IMAGE FOR THE PROJECT"
The repo's spec surface for this work: `specs/desktop-ui-design.md:1-4` keeps this in the OpenCode Desktop Goal panel; `specs/v0.4.0-roadmap.md:13-49` defines chains as ordered steps with condition, command/verification, and per-step limits; `specs/v0.5.0-feature-work-orders.md:242-263` places the app-side GoalPanel work in `C:\Users\zerop\Development\opencode-source`.
The reconciliation: make the native Desktop Goal tab look like the approved target chain workspace and prove that visible run controls use the real host/plugin boundary: local action edits stay local, Start Chain writes the chain then admits exactly one prompt, Restart/Resume admit one prompt after state change, and Steer records the note plus submits a steering prompt without using slash-command chat fallback.

### Current state
`packages/app/src/pages/session/goal-panel.tsx` now opens the Goal form path as a target-style two-column workspace: a large Chain Builder panel on the left and an Action Library/Action Editor rail on the right. The old internal Last Result/Set Goal column is hidden from this workflow so the first visible panel matches the target. The chain header has Validate chain, Save draft, Start chain, highlighted numeric limits/counts, and Chain settings. Action Library rows are compact fixed Add/Edit command rows, category tabs stay on one line, and the editor uses bright Save/Add/Duplicate/Delete controls.

Functional corrections landed in `packages/app/src/pages/session/goal-panel-actions.ts` and `goal-panel.tsx`: Start Chain still emits one deterministic `chain start-json` control and now admits exactly one `prompt_async`; Restart and Resume now admit one prompt after their state transition; Steer now writes `/goal steer` metadata and also sends a `prompt_async` steering update so it can be consumed by the active or next continuation instead of waiting for a later manual nudge.

### Verification
`C:\Users\zerop\Development\opencode-source\packages\app`: `bun test --preload ./happydom.ts src/pages/session/goal-panel.test.ts` passed `89 pass / 0 fail`; `bun run typecheck` passed. Native Electron proof used the running Desktop app on CDP `127.0.0.1:9222`, opened the real session Goal side panel with `[aria-controls="review-panel"][aria-label="Goal"]`, verified `goal-chain-builder-workspace`, `chain-builder`, `action-library`, and `action-editor` were mounted, captured `C:\Users\zerop\Development\opencode-source\output\playwright\electron-goal-target-final-20260617.png`, and ran an intercepted Start Chain click: one Add made one local row and enabled Start Chain; clicking Start emitted exactly one `/experimental/goal/control/goal_control` request and exactly one `/session/{id}/prompt_async` request, with no real workspace side effect because both routes were fulfilled by Playwright.

## 2026-06-17 Per-action runtime pins

### Spec reconciliation
User's literal words: "Okay, I should be able to assign certain skills that go with any one of these actions. Like I need to be able to assign more than one skill, so I need to be able to pin skills to it, and then I should also be able to pin a certain model to it."
The repo's spec surface for this work: `specs/desktop-ui-design.md:1-4` keeps this in the OpenCode Desktop Goal panel; `specs/v0.4.0-roadmap.md:13-49` defines chain steps as condition, command/verification, and step limits; `specs/v0.5.0-feature-work-orders.md:242-263` places Desktop GoalPanel work in `C:\Users\zerop\Development\opencode-source`. The current `src/goal-chain.ts` validator accepts additional per-step metadata but does not consume `skills` or `model` into runtime execution.
The reconciliation: add per-action `skills[]` and `model` pins to the Desktop action/template/chain draft data path and include them in `chain start-json` step metadata, while treating actual OpenCode runtime consumption as a follow-up plugin/host integration rather than pretending the current chain executor already applies them.

## 2026-06-17 Chain builder color polish

### Spec reconciliation
User's literal words: "You're missing color and polish on the Chain Builder Screen, including the portion where we have actual chained items in there"
The repo's spec surface for this work: `specs/desktop-ui-design.md:1-4` keeps this in the OpenCode Desktop Goal panel; `specs/v0.4.0-roadmap.md:13-49` defines chain steps as ordered goal/action entries with condition, command/verification, and per-step limits; `specs/v0.5.0-feature-work-orders.md:242-263` places Desktop GoalPanel work in `C:\Users\zerop\Development\opencode-source`.
The reconciliation: polish only the app-side Chain Builder visual layer so the builder shell, status strip, empty state, and populated chain rows carry clear semantic color while preserving the existing local-draft and Start Chain behavior.

## 2026-06-17 Desktop Goal panel E2E verification

### Spec reconciliation
User's literal words: "I need this end to end tested, each function, each button, each sequence"
The repo's spec surface for this work: `specs/desktop-ui-design.md:1-4` keeps final proof on the OpenCode Desktop Goal panel; `specs/v0.4.0-roadmap.md:13-49` defines ordered chain steps and per-step constraints; `specs/v0.4.0-roadmap.md:89-121` defines chain advancement boundaries; `specs/v0.5.0-feature-work-orders.md:242-263` places the app-side GoalPanel implementation in `C:\Users\zerop\Development\opencode-source`.
The reconciliation: verify the native Electron Goal panel end to end by exercising visible local-edit controls, chain sequencing, and the Start Chain host/plugin boundary with side-effecting requests intercepted.

### Verification
Electron Desktop was launched from `C:\Users\zerop\Development\opencode-source\packages\desktop` and attached through CDP `127.0.0.1:9222`. The OpenGoal session `OpenGoal Control Center spec` mounted the Goal panel at `http://localhost:5173/.../session/ses_140e661b9ffe6M2Pa1QGHJOmI7`.

The Electron E2E pass verified: `chain-builder`, `action-library`, and `action-editor` mount; major headers are visible; the old `BASE ACTION` badge is gone; the vague `Verification` stat is now `COMMANDS`; `New action` is scoped inside the Action Editor; Action Library Add/Edit buttons align at 22px high; action rows use semantic gradients and colored borders; clicking `Build` Edit highlights the row and loads the editor; editor name/instruction/verify/turn/minute fields update; one model can be selected; multiple skills can be pinned; `Add to run order`, library `Add`, reorder, remove, `Validate chain`, and `Save draft` all respond; project-template `Delete` emits `template delete codex-electron-smoke-template` when intercepted; `Start chain` emits exactly one `chain start-json` control request and exactly one `prompt_async` request. The captured `chain start-json` payload preserved master limits, step order after reorder, edited command verification, per-step limits, `skills:["adversarial-review","aesthetic"]`, and `model:"deepseek:deepseek-v4-pro"`. No new console errors were recorded during the corrected Electron pass.

Side effects were intentionally intercepted for `template import`, `template delete`, `chain start-json`, and `prompt_async`, so no real run was launched and the existing project template was not deleted.

## 2026-06-17 Action library immediate-save fix and visual consistency pass

### Spec reconciliation
User's literal words: "Actions bar sucks too, polish is bad. Keep working toward consistency in the layout and application functionality too. excessively thick white outlines and boldness in the chain builder compared to everything else." / "I created a new action And it did not show up in the action library."
The repo's spec surface for this work: `specs/desktop-ui-design.md:1-4` keeps the target in the OpenCode Desktop Goal panel; `specs/v0.4.0-roadmap.md:13-49` keeps chain/action data as ordered steps and reusable template actions; `specs/v0.5.0-feature-work-orders.md:242-263` places the app-side implementation in `C:\Users\zerop\Development\opencode-source`.
The reconciliation: soften the Chain Builder visual hierarchy to match the Action Library/Editor and make Action Library mutation state immediate, so creating/saving/duplicating/deleting an action changes the visible reusable-action list without waiting for a snapshot refresh.

### Current state
`packages/app/src/pages/session/goal-panel.tsx` now keeps local template overrides and delete tombstones layered over the plugin snapshot. `Save action` and `Duplicate` optimistically upsert the saved action into the Action Library and keep it selected; `Delete` hides the deleted project template immediately after the command succeeds. The visual pass also reduced section border thickness/shadows, softened Chain Builder row/icon/budget typography and borders, and gave the Action Library header, category bar, search wrapper, and list container the same shaded panel treatment as the Action Editor.

Verification: `C:\Users\zerop\Development\opencode-source\packages\app`: `bun run typecheck` passed; `bun test --preload ./happydom.ts src/pages/session/goal-panel.test.ts` passed `89 pass / 0 fail`.

## 2026-06-17 Chain builder outline correction

### Spec reconciliation
User's literal words: "Bro the whole chain builder section is overpopped white outlines, it's bad"
The repo's spec surface for this work: `specs/desktop-ui-design.md:1-4` keeps the surface in the OpenCode Desktop Goal panel; `specs/v0.4.0-roadmap.md:13-49` keeps Chain Builder rows as ordered steps with per-step limits; `specs/v0.5.0-feature-work-orders.md:242-263` places the app-side implementation in `C:\Users\zerop\Development\opencode-source`.
The reconciliation: mute the Chain Builder shell and nested run-order outlines to match the Action Library/Editor weight, while preserving semantic color on step numbers, action icons, and numeric highlights.

## 2026-06-17 Verification and visual correction after failed neutral pass

### Spec reconciliation
User's literal words: "Wow.  This is insanely ugly now.  No good.  Did you test it?  Do all the functions work in the right order?  Have you gap scanned it?  Brittle tested?  Data tested?"
The repo's spec surface for this work: `specs/desktop-ui-design.md:1-4` keeps the target in the OpenCode Desktop Goal panel; `specs/v0.4.0-roadmap.md:13-49` and `specs/v0.4.0-roadmap.md:89-121` define ordered chain step data and advancement; `specs/v0.5.0-feature-work-orders.md:242-263` places the app-side GoalPanel implementation in `C:\Users\zerop\Development\opencode-source`.
The reconciliation: verify the chain/action function and data paths with focused tests, then replace the flat neutral Chain Builder pass with a more deliberate low-glow violet command surface that avoids white outlines but keeps meaningful color hierarchy.

### Verification
`C:\Users\zerop\Development\opencode-source\packages\app`: `bun test --preload ./happydom.ts src/pages/session/goal-panel.test.ts` passed `89 pass / 0 fail`; `bun run typecheck` passed; `git diff --check` passed for `goal-panel.tsx` and `goal-panel.test.ts`. A source audit of `startGoalChain` found exactly one `sendGoalCommand`, exactly one `chain start-json`, exactly one `startGoalRun`, and zero `session.command` fallback. A class scan found no `border-white/`, `ring-white`, `border-violet-400/70`, `bg-violet-950/14`, or old bright Chain Builder outline classes in `goal-panel.tsx`.

`C:\Users\zerop\Development\OpenGoal`: `bun test test/goal-chain.test.mjs test/server-verify.test.mjs test/template.test.mjs test/goal-templates-snapshot.test.mjs test/goal-history.test.mjs` passed `158 pass / 0 fail`, covering chain creation/advance/loop/reset/override guard/corrupt/oversize, verification validators/evaluators, template import/export/delete/snapshot, and goal history snapshot data.

## 2026-06-17 In-place running status and stop permission fix

### Spec reconciliation
User's literal words: "WE JUS TNEED THE FIRST SCREEN TO GO INTO A 'running state' where some title bar changes to 'running' or something" / "And the running steps highlight"
The repo's spec surface for this work: `specs/desktop-ui-design.md:1-4` keeps final proof in the OpenCode Desktop Goal panel; `specs/v0.4.0-roadmap.md:13-49` defines ordered chain steps and per-step limits; `specs/v0.5.0-feature-work-orders.md:242-263` places the app-side GoalPanel implementation in `C:\Users\zerop\Development\opencode-source`.
The reconciliation: keep the same Chain Builder workspace mounted for live goals, add an inline running state/status/activity strip, and highlight the current chain step instead of routing to a separate running-status workspace.

### Current state
`packages/app/src/pages/session/goal-panel.tsx` now renders the Chain Builder workspace for loaded non-corrupt goal state whether the goal is idle, paused, or active. When a live goal exists, the Chain Builder section title changes to `Running Chain`, the toolbar Start button becomes a disabled `Running` state, an inline running status strip exposes status/progress/turns/time/current step plus Resume/Restart/Stop/Steer controls, and a compact Activity block stays under the chain rows. Runtime chain rows are mapped from `.opencode/.goal-chain.json`, expose `data-run-state`, and use a style-layer emerald border/glow for the active step so the highlight is not overridden by category gradients. Draft row edits/reorder/remove and master limit inputs are locked while a run is live so local editing cannot masquerade as live mutation.

The Goal dock Stop button no longer calls the Desktop `session.abort` path from the component. It sends deterministic `goal_control clear`, which avoids the previously observed permission-denied abort failure while still clearing the goal through the plugin boundary.

### Verification
`C:\Users\zerop\Development\opencode-source\packages\app`: `bun run typecheck` passed; `bun test --preload ./happydom.ts src/pages/session/goal-panel.test.ts` passed `90 pass / 0 fail`.

Native Electron Desktop proof attached to the running app through CDP `127.0.0.1:9222`, opened the real OpenGoal session `ses_140e661b9ffe6M2Pa1QGHJOmI7`, and verified: `chain-builder` visible; `goal-chain-running-status` visible inside the Chain Builder; `goal-chain-running-activity` visible; no visible `goal-running-status-workspace`; row states were `running, queued, queued`; exactly one running row existed; and the active row computed style used emerald border/glow distinct from queued rows. Screenshot captured at `C:\Users\zerop\AppData\Local\Temp\opengoal-electron-single-screen-running-highlight.png`.

Electron Stop interaction proof backed up `.opencode/.goal-state.json`, `.opencode/.goal-chain.json`, and `.opencode/goal-history.json`, clicked `Stop` then `Confirm stop` in the inline Chain Builder controls, saw no `permission denied` or `request failed` text, and confirmed the app stayed on `chain-builder`. The backed-up files were restored, and the post-restore Electron check again showed inline running status with row states `running, queued, queued`.

`C:\Users\zerop\Development\OpenGoal`: `bun test test/permissions.test.mjs test/goal-chain.test.mjs` passed `59 pass / 0 fail`.
