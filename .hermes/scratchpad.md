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

_(none — start a new section below when you begin work)_

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
