# opencode-autogoal

**Give OpenCode a goal and it keeps working until the goal is met.**

The easiest way to use it is to **just say what you want** — no syntax to remember:

> **You:** "Keep working until the tests pass and don't stop on your own."
> **OpenCode:** *(sets the goal itself)* "Goal set: tests pass — I'll keep going and check after each step. 🎯"

`opencode-autogoal` adds that behavior to [OpenCode](https://opencode.ai): conversational **tools** (so the agent
sets and manages goals when you ask in plain English), a `/goal` command if you prefer typing, and a
background auto-loop that re-checks the goal after every turn and nudges the agent onward until the
condition holds (or a turn/time limit trips).

Designed for **OpenCode Desktop (Electron)** and the **terminal** — the engine is a server plugin (what
Desktop runs). Its only dependency is `@opencode-ai/plugin` (the plugin API your OpenCode already provides).
An optional terminal-only dashboard ships alongside.

Requires **OpenCode ≥ 1.16** (uses the `session.idle` and `experimental.session.compacting` hooks).

---

## Install

```bash
opencode plugin opencode-autogoal
```

That single line enables the **conversational tools** — you can immediately say *"keep going until the
tests pass"* and OpenCode sets the goal itself. No command needed.

If you *also* want the `/goal` slash command, add the `command` block (it makes `/goal` exist; the plugin
attempts this automatically via the `config` hook too, but declaring it is the reliable path):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-autogoal"],
  "command": {
    "goal": {
      "description": "Set, view, pause, resume, or clear a task goal.",
      "agent": "build",
      "template": "Process the /goal command with arguments: $ARGUMENTS"
    }
  }
}
```

> If your project doesn't use a `build` agent, change `agent` to one you have. See
> [`examples/opencode.jsonc`](examples/opencode.jsonc).

---

## Usage

### Just talk to it (recommended)

The plugin gives OpenCode five tools, so you manage goals in plain language — it picks the right one:

| Say something like… | Tool the agent calls |
|---|---|
| "keep going until the tests pass", "don't stop until the build is green" | `set_goal` |
| "what's my goal?", "how's it going?" | `goal_status` |
| "pause the goal for a sec" | `pause_goal` |
| "ok, back to the goal" | `resume_goal` |
| "stop the goal", "we're done with that" | `clear_goal` |

Tip: mention a check command and it's verified deterministically — *"keep going until `npm test` passes."*

> **Note:** the conversational path needs a model that's good at tool-calling (e.g. Claude, GPT-class,
> strong DeepSeek). Smaller/free models may not invoke `set_goal` from plain English — on those, use the
> `/goal` command below, which is deterministic on **any** model.

### Or use the `/goal` command (if you prefer typing)

```
/goal set "<condition>"                 set a goal (the agent starts working immediately)
/goal set "<condition>" --command "<c>" verify completion by running a shell command (exit 0 = met)
/goal set "<condition>" stop after 10 turns
/goal                                   show current goal + progress (bare /goal = view)
/goal pause | resume | clear            control the loop (clear aliases: stop, off, reset, none, cancel)
/goal template <name>                   set a goal from a built-in or project template
/goal history                           show recent evaluation results
```

Inline modifiers: `stop after N turns`, `stop after N minutes`, `stop after Nk tokens`,
`--command "<check>"` (also `--turns N`, `--time N`). Everything else is the condition.

Both paths share the same engine and state — use whichever feels natural.

### Examples

```
/goal set "all unit tests pass" --command "npm test"
/goal set "remove every TODO comment in src/ and explain each removal" stop after 8 turns
/goal template fix-lint
```

### Good to know

- **An active goal steers the conversation.** Until the goal is met, the agent treats it as top priority
  and gets nudged back to it each turn. Use **`/goal pause`** (or `/goal clear`) before switching to
  unrelated work. Bare **`/goal`** shows the current status.
- **The `stop after N …` phrasing is parsed anywhere in the condition.** So `/goal set "make it stop
  after 5 turns of retrying"` would read `5` as a turn limit. For literal text like that, set limits with
  the unambiguous flags instead (`--turns`, `--time`) and keep them out of the condition prose.
- **Status commands cost one model turn.** `/goal view|clear|pause|resume|history` are handled by the
  agent relaying the result, so they aren't instantaneous like a native UI button.

---

## How it works

Two kinds of goal, two kinds of evaluation:

- **Verifiable goals** (`--command`): after each turn the plugin runs your command in the project
  directory. **Exit 0 = achieved.** Cross-platform (uses the OS shell), deterministic, the reliable path.
- **Open-ended goals** (no command): the plugin reads the agent's latest message **read-only** and looks
  for an explicit completion signal — it never injects evaluation prompts or guesses. The agent declares
  done with a line beginning `GOAL_COMPLETE:` (and `GOAL_BLOCKED:` if it's stuck). These markers are
  **line-anchored**, so the agent merely *talking about* them won't trip the goal.

When a goal isn't met yet, one continue-nudge is injected to drive the next turn. Turn and time limits
stop a runaway loop. On any terminal state (achieved / stopped / blocked) you get a notification **both**
as a TUI toast (terminal) **and** as a status line in the conversation — the latter is what surfaces on
Desktop, where TUI toasts don't render.

State lives in `.opencode/.goal-state.json` (atomic writes; auto-gitignored).

### Templates

Built-in: `fix-lint`, `fix-types`, `pass-tests`. Add your own at `.opencode/goals/<name>.json`:

```json
{
  "description": "Ship the migration",
  "condition": "the migration script runs cleanly and the app boots",
  "command": "npm run migrate && npm run smoke",
  "constraints": { "maxTurns": 20, "maxTimeMinutes": 30 }
}
```

A project file with the same name overrides a built-in.

---

## Desktop vs. terminal

OpenCode **Desktop (Electron)** is driven entirely by *server* plugins — it does **not** load TUI plugins.
Everything above works on Desktop via the server plugin. The interactive dashboard below is **terminal-only**.

### Optional terminal dashboard

A small TUI dashboard (`/goal-dashboard`, `/goal-toggle`, `/goal-clear`) ships as `opencode-autogoal/tui`.
It is **terminal-only** and **off by default**. Enable it in `tui.json` (only if you run OpenCode in a terminal):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-autogoal/tui"]
}
```

> ⚠️ The dashboard is shipped best-effort: it type-checks against OpenCode's TUI types and follows the
> official plugin spec, but verify it in your terminal before relying on it. It has no effect on Desktop.

---

## Development

```bash
npm install
npm run build       # tsc → dist/ (the server plugin; zero runtime deps)
npm test            # build, then run the regression suite (node --test)
npm run typecheck   # type-check src/ (server + tui)
```

- `src/goal-state.ts` — types, arg parsing, atomic state I/O, transitions, marker detection.
- `src/command.ts` — the `/goal` dispatcher (pure, deterministic).
- `src/server.ts` — the plugin wiring: command hook + the auto-loop.
- `src/tui.tsx` — optional terminal dashboard (shipped as source).
- `src/templates.ts` — built-in goal templates.

The package ships compiled JS (`dist/`) so it loads regardless of whether the host runtime is Node or Bun.

### What's tested vs. what needs a live check

`npm test` covers `goal-state.ts` and the `/goal` dispatcher (parsing, state, transitions, markers,
every command path) against the **built** output. What unit tests *can't* exercise is the live OpenCode
integration: the `command.execute.before`/`config` hooks, the `session.idle` loop, and how injected
messages render in the Desktop UI. **Smoke-test the packaged tarball before publishing:**

```bash
npm pack                                   # builds dist/ and makes opencode-autogoal-x.y.z.tgz
cd /path/to/a/throwaway/project
npm i /path/to/opencode-autogoal-x.y.z.tgz     # exercises the COMPILED output + real install path
# add the plugin (+ optional command block) to opencode.json, then in OpenCode:
#   CONVERSATIONAL (primary path):
#     "set a goal to write a haiku, then keep going until it's done"  → agent calls set_goal
#     "what's my goal?"  → goal_status     ·     "stop the goal"  → clear_goal
#   SLASH COMMAND (if you added the command block):
#     /goal              → shows "no active goal"
#     /goal set "say hi once you've written a haiku"   (no --command: tests the GOAL_COMPLETE path)
#     /goal pause, /goal resume, /goal clear
#     /goal set "<thing>" --command "<cmd that exits 0>"   (tests deterministic completion)
```

If `/goal` does nothing, the command-registration/`command.execute.before` path needs adjustment for
your OpenCode version — open an issue with your version (`opencode --version`).

---

## Related work & a high five 🙌

Huge props to **[@mirsella](https://github.com/mirsella)** and
**[opencode-goal](https://github.com/mirsella/opencode-goal)** — they shipped the original
"Codex-style long-running goals for OpenCode," and it's a clean, lightweight take that proves the idea.
If you want something simpler and model-judgment-based, go give it a star. 🌟

`opencode-autogoal` heads in a different direction: **deterministic `--command` verification**,
**turn/time limits**, **templates**, and a **conversational tool interface** so you set goals by just
talking. Different trade-offs, same good idea. Thanks for blazing the trail. 🤝

---

## License

MIT © VerbalChainsaw
