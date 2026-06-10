# OpenGoal → `opencode-autogoal` packaging plan

Target: a single, installable OpenCode plugin package (`opencode plugin opencode-autogoal`),
GitHub-community ready. Consolidates the old multi-file extension (plugin + command +
skill + scripts + templates) into one self-contained plugin.

## Architecture decisions (verified)

- **Ship compiled JS**, not raw `.ts`. Real published opencode plugins ship `dist/*.js`
  (`opencode-helicone-session` uses `bun build index.ts --target node`; the spec example
  uses `tsc`). Raw `.ts` would fail if the Desktop Electron plugin host runs Node, not Bun.
- **Zero runtime dependencies.** `@opencode-ai/*` are imported `import type` only (erased at
  compile); the only runtime imports are Node builtins + the package's own `goal-state.js`.
  So a plain `tsc` build produces a self-contained `dist/` — no bundler needed.
- **Command handled via the `command.execute.before` hook**, NOT the `tool()` helper.
  The hook is a server-side hook (works on Desktop), fires when `/goal …` runs, parses the
  args, mutates state deterministically in TS, and injects the right prompt parts. This avoids
  a runtime value-import of the `tool()` helper, keeping the package dependency-free.
- **Command registration** is attempted via the `config` hook (`cfg.command.goal = {...}`).
  Because late config mutation surfacing as a slash command on Desktop is unverifiable from
  the dev box, the README also documents the guaranteed manual 4-line `command.goal` snippet.
- **Skill is folded in.** The `GOAL_COMPLETE`/`GOAL_BLOCKED` protocol + priority framing is
  injected by the `command.execute.before` parts on `/goal set` (so a fresh no-command goal's
  FIRST turn has guidance) and re-stated by the loop's continue-prompt each iteration.
- **Scripts are eliminated.** All parse/state/IO logic moves into `goal-state.ts` (Node `fs`),
  cross-platform by construction — no more `sh`/`pwsh` duality.
- **TUI stays terminal-only/optional**, shipped as `src/tui.tsx` source (the terminal host is
  Bun and compiles solid JSX); excluded from the server `tsc` build.

## Layout

```
opencode-autogoal/
├── package.json          # name, exports {./server → dist, ./tui → src/tui.tsx}, files, engines, scripts
├── README.md             # install (opencode plugin / manual config), usage, how it works
├── LICENSE               # MIT
├── tsconfig.json         # build: src → dist (excludes tui.tsx)
├── src/
│   ├── goal-state.ts     # types, parse, build, atomic IO, transitions, marker detection, formatting
│   ├── server.ts         # plugin: config hook + command.execute.before + event auto-loop + compacting
│   ├── tui.tsx           # terminal dashboard (optional, source-shipped)
│   └── templates.ts      # built-in goal templates (fix-lint, fix-types)
├── test/
│   └── goal-state.test.mjs  # marker 8/8 + set/update lifecycle, run against built dist
└── examples/opencode.jsonc
```

## Verification guards (from the prior, tested implementation)
- Re-run the marker detection suite (was 8/8) against `goal-state.ts`.
- Re-run the set/update lifecycle (incl. quotes/apostrophes, template, transitions) against it.
- `tsc` typecheck of server + tui clean.
- Keep the old `.opencode/` implementation until the new package builds + tests green; remove last.
