# Getting a real "Goals" panel into the OpenCode Desktop GUI

This plugin gives you the *behavior* (set a goal → OpenCode works until it's met) through
conversation and a slash command. What it **cannot** do is draw a custom panel, sidebar, or
buttons inside the Desktop app. This document explains why, and exactly what a real GUI
contribution would involve — so you can pursue it with the OpenCode maintainers if you want to.

## Why a plugin can't do it (verified against OpenCode's source)

OpenCode's extension surface is split:

| Plugin type | Runs in | Can render UI? |
|---|---|---|
| **Server plugin** (this package) | the core server — **what Desktop uses** | **No.** Its hooks are logic-only: `event`, `tool`, `config`, `command.execute.before`, `tool.execute.*`, `chat.*`. There is no UI hook. |
| **TUI plugin** | the **terminal** TUI only | Yes, but terminal-only (opentui/SolidJS). Desktop never loads it. |

The Desktop GUI itself is **not pluggable**. From OpenCode's `CONTRIBUTING.md`:

- `packages/app` — the shared **web UI**, written in **SolidJS** (the actual interface).
- `packages/desktop` — the **Electron** app, which just **wraps `packages/app`**.

So the buttons and panels you see in Desktop live in OpenCode's own `packages/app`. Adding a
"Goals" panel means changing that code — a **pull request to OpenCode**, not a plugin.

## The clean split (why this is still the right foundation)

This plugin is deliberately the **logic/engine layer**, and it keeps all state in one place:

- State file: `.opencode/.goal-state.json` (documented schema in `src/goal-state.ts`).
- Operations: the tools (`set_goal`, `goal_status`, …) and the same functions they call.

A future GUI panel would be a **thin view** on top of exactly this — it would not reimplement
logic. That's the ideal shape to propose: "the behavior already exists and is battle-tested as a
plugin; this PR just adds a view."

## What a real contribution would involve

1. **Open a discussion/issue first.** Don't surprise maintainers with a big PR. Describe the
   feature, link this plugin as the existing logic layer, and ask if they'd accept a UI for it.
2. **Find the panel host in `packages/app`.** Locate where existing side panels / status areas are
   rendered (SolidJS components). The new component would live beside them.
3. **Build a `GoalPanel` SolidJS component** that:
   - reads goal status (ideally via an SDK/server endpoint, not by reading the file directly from
     the renderer — Electron renderers shouldn't touch the FS; go through the server), and
   - has Set / Pause / Resume / Clear controls that call the same operations.
   - This likely means adding a small **server endpoint** (e.g. `GET/POST /goal`) in
     `packages/opencode` that the panel talks to, backed by the same `goal-state` logic.
4. **Wire the component into the layout** and gate it (only show when the plugin/feature is active).
5. **Match their conventions**: SolidJS patterns, their styling system, tests, and the
   `CONTRIBUTING.md` checklist. Run their dev build (`packages/desktop`) locally to verify.

## Realistic assessment

- **Effort:** moderate-to-large, and most of it is *their* codebase (SolidJS UI + a server
  endpoint), not this repo. Expect iteration with maintainers on design.
- **Risk:** they may prefer goals stay conversational, or want a different UX. The discussion in
  step 1 settles that before you invest.
- **Meanwhile:** the conversational tools already give you a no-syntax, GUI-native experience (it's
  just chat), so you're not blocked while the upstream conversation happens.

## Pointers

- OpenCode repo: <https://github.com/anomalyco/opencode>
- `CONTRIBUTING.md` (dev setup, `packages/desktop` run instructions)
- This plugin's engine/state contract: [`src/goal-state.ts`](src/goal-state.ts)
