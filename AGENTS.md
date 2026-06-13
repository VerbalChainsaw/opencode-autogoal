# Working rules for `opencode-autogoal`

These rules are non-negotiable. They are enforced by both the
`AGENTS.md` standing rules and the `tools/guard-spec-ref.sh`
pre-commit hook. An external agent (human or AI) working in
this repo is bound by all three.

---

## 1. The spec wins. Always.

Before any non-trivial work — feature, refactor, "let me just
polish X" — read the spec surface.

```bash
ls specs/
# If the spec dir is non-empty, EVERY spec file is in scope.
# Read each one. Not the first 50 lines. The whole file.
```

The `specs/` directory is the **source of truth for what
surface a given piece of work lands on**. The user's words in
chat are a *requirement*. The spec is the *architecture*.
When the two conflict, the spec wins, and you must surface
the conflict to the user with a one-sentence reconciliation
*before* writing any code.

**Concrete failure mode this rule prevents:**

The user says: *"I want a GUI interface to run my autocode."*
The agent, reading only the user's words, decides the
deliverable is a fancier standalone terminal TUI.

The user means: a block-based render surface emitted by the
server plugin via `ctx.render({ blocks: RenderBlock[] })`,
rendered by OpenCode Desktop's `packages/app` as Slack-Block-
Kit-style cards inside the existing tool output card.

The spec at `specs/render-protocol-design.md` makes this
unambiguous. Read it first. If you don't, you will spend 23
commits building the wrong surface. (This is not hypothetical.
This is what happened on the v0.7.0 attempt.)

---

## 2. Host-integration requests produce host-consumed artifacts, not separate apps.

When the user's request implies integration with a host
(OpenCode, VS Code, an IDE, a desktop app, a CLI tool that
already exists), the deliverable is **what the host consumes**,
not a separate app the user launches.

For `opencode-autogoal` specifically, the host is OpenCode.
The host-consumed surfaces are:

| User says…                          | Deliverable is…                              | Lands in…                       |
|-------------------------------------|-----------------------------------------------|---------------------------------|
| "GUI", "interface", "in the app"    | `RenderBlock[]` payloads + `ctx.render()` calls | `src/blocks/`, server plugin    |
| "in the terminal", "TUI tab"         | A `TuiPlugin` module with routes + keymap     | `src/tui.tsx`, `src/sidebar.tsx` |
| "a CLI command", "I want to run X"  | A standalone CLI subcommand                   | `src/cli.ts`, `dist/cli.js`      |
| "watch the goal", "live status"      | A watch command that reads state file         | `src/cli.ts` watch subcommand    |

The standalone `opencode-autogoal tui` command (`runControlCenter`
in `src/control-center.ts`) is **not** the deliverable for
"GUI interface" requests. It exists for users who want a
separate terminal app, but it is not the integration point
with OpenCode.

**If you find yourself writing 900+ lines of new code in
`src/control-center.ts` for a "GUI" request, you are on the
wrong surface. Stop.**

---

## 3. Spec-read ritual (mandatory, before any non-trivial work).

For any task that is more than a one-line fix, do this
*before* writing code:

1. List the spec surface:
   ```bash
   ls specs/ && echo "---" && wc -l specs/*.md
   ```

2. Read every spec file. If a spec is > 500 lines, read it in
   full. Do not skim. The spec was written for a reason; the
   reason is usually "the previous attempt got this wrong."

3. Write down, in `.hermes/scratchpad.md`, under a new heading
   "Spec reconciliation":
   ```markdown
   ## Spec reconciliation
   User's literal words: <quote them verbatim>
   The repo's spec surface for this work: <file:line references>
   The reconciliation: <one sentence>
   If you cannot write the reconciliation: STOP AND ASK.
   ```

4. Re-read the spec section you'll be working against *after*
   writing the reconciliation. The act of writing the
   reconciliation forces you to commit to a surface; reading
   the spec again confirms you picked the right one.

---

## 4. Commit hygiene (enforced by pre-commit hook).

Every commit message must cite a spec section.

Format: `feat(scope): summary (spec §N.M)` or
`fix(scope): summary (spec §N.M)`.

The pre-commit hook `tools/guard-spec-ref.sh` blocks any
commit where:
- The staged diff touches `src/**/*.ts` (or `src/**/*.tsx`),
  AND
- The commit message does not contain a regex match for
  `specs/[a-zA-Z0-9_./-]+\.md( §[0-9.]+)?`.

If the hook rejects your commit, the right action is **not**
to bypass the hook. The right action is to:
1. Re-read the relevant spec section.
2. Cite it in the commit message.
3. Re-stage and commit.

If you genuinely believe the commit doesn't need a spec
reference (e.g., a typo fix in a comment), split the commit:
the spec-cited work goes in one commit, the typo fix in
another with a `[no-spec]` tag in the message that the hook
explicitly allows.

---

## 5. Wrong-surface commits stay. They get tagged and branched, not reverted.

When you discover — at any point — that work was done on the
wrong surface, **do not revert**. Sunk-cost framing is wrong:
the recoverable commits represent *knowledge of what doesn't
work*, which is itself a deliverable. The reversion is also
hostile to the user, who has paid (in time and tokens) for
the work and does not want it deleted out from under them.

The correct workflow for "wrong surface":

```bash
# Tag the wrong-surface commits so they're findable
git tag -a wip/wrong-surface/<date>-<surface-name> <last-wrong-commit>

# Cut a new branch from the last known-good base
git checkout -b feat/<right-surface-name> <last-known-good-sha>

# Mine the wrong-surface branch for transferable pure modules
git log --oneline wip/wrong-surface/<date>-<surface-name>
# (transcript this in the scratchpad)
```

Wrong-surface commits are *mined*, not deleted.

---

## 6. "Debug it again, break it hard, audit it" mid-loop criteria mean verify the target, not the work.

When the user adds mid-loop criteria like:

- "Debug from multiple angles"
- "Adversarial review"
- "Break it hard"
- "Check for regressions"
- "Final threat-tracing and simulated run"
- "File integrity verification"

...the work being verified is **the work the user asked for
on the surface the spec says to use**. Do not interpret these
criteria as "go deeper on whatever I'm already building."

**Concrete failure mode this rule prevents:**

User adds mid-loop criteria on a v0.7.0 build that's on the
wrong surface. Agent interprets the criteria as "run more
tests on the v0.7.0 work, polish the v0.7.0 work harder, ship
the v0.7.0 work better." Agent never questions whether the
v0.7.0 work is the right *target*.

The right interpretation: *"These criteria say 'verify the
work.' The first verification is: is the work on the right
surface? If not, all the tests in the world don't help."*

Before running any verification pass, re-read the spec
section the work is supposed to land in. If the work is
landing somewhere else, the verification is moot.

---

## 7. External-agent handoff contract.

When this work is handed off to an external agent (human or
AI), the handoff package is:

1. The repo (this directory) with working tree clean
   (`git status --short` shows nothing modified, nothing
   untracked except `docs/` and `specs/` working notes).
2. This `AGENTS.md` file.
3. The `.hermes/scratchpad.md` with the most recent
   "Spec reconciliation" entry.
4. The pre-commit hook installed (`tools/guard-spec-ref.sh`
   + git config `core.hooksPath` if not already set).
5. A one-paragraph handoff note in the scratchpad answering:
   *"What is the current state? What is uncommitted? What
   did we just learn? What is the next concrete step?"*

If any of the five is missing, the handoff is incomplete and
the receiving agent should not start work.

---

## 8. Forbidden shortcuts.

These are the patterns that, in the v0.7.0 attempt, cost the
user hours and money. They are forbidden, period.

- **Building a polished standalone surface for a host-
  integration request.** Wrong. See §2.
- **Polishing instead of questioning.** When the user pushes
  back, the right move is *not* "let me make the polish
  better." The right move is "let me re-read the spec."
- **Trusting test count as a proxy for correctness.** 1053
  tests passing on the wrong surface is 1053 wrong-surface
  tests. The test count is orthogonal to surface correctness.
- **Suggesting revert when the user says "don't roll it
  back."** The user has paid for the work. They own the
  decision to keep or delete it. See §5.
- **"Going quiet" as a damage-control move.** The user is
  frustrated; silence is not a fix. The fix is concrete
  recovery (git tags, branch cuts, spec re-reads) and a
  honest answer to "what now?"
- **Adding a "helpful" injection or alarm to a future
  prompt.** Prompt injections degrade. The model adapts to
  them. By the third time the same alarm fires, it's noise.
  Use environment-level enforcement (pre-commit hooks, spec
  rituals, standing rules) instead.

---

## 9. If you only remember three things.

1. **The spec wins.** (`specs/render-protocol-design.md` is
   the architecture; the user's chat words are the
   requirement; when they conflict, the spec wins, and you
   surface the conflict.)

2. **Host integration = host-consumed artifacts.** A "GUI"
   request against an OpenCode plugin produces
   `ctx.render({ blocks })` payloads, not a separate terminal
   app.

3. **Wrong-surface commits are mined, not reverted.** Tag
   them `wip/wrong-surface/<date>-<name>`, cut a new branch
   from the last known-good base, mine the pure modules.

Everything else in this file is elaboration on those three.
