# Security Policy

## Reporting a vulnerability

Please report security issues **privately** via GitHub:
**[Security advisories](https://github.com/VerbalChainsaw/opencode-autogoal/security/advisories/new)** →
"Report a vulnerability". Please don't open a public issue for anything exploitable.

I'll acknowledge within a few days and aim to ship a fix or mitigation before any public disclosure.

## Supported versions

This project is pre-1.0. Only the latest `0.x` release receives fixes.

## Threat model & known considerations

`opencode-autogoal` runs as an OpenCode **server plugin**. It reads/writes one file
(`.opencode/.goal-state.json`) and, for "verifiable" goals, runs a shell command. Be aware of the
following by design:

### 1. Verification commands execute shell commands (intentional)

A goal can carry a `command` (e.g. `npm test`) that the plugin runs in your project directory on each
idle to check completion — exit 0 means met. **Only use commands you trust.** This is the same trust you
extend to npm scripts, git hooks, or a test runner. The command is run via the OS shell with a 30s
timeout and a 1 MB output cap.

### 2. The state file is a trust boundary ⚠️

The command to execute is stored in `.opencode/.goal-state.json` and is run automatically when the
session goes idle. That means **a crafted state file is a code-execution vector**: if you clone a
malicious repository that ships a `.opencode/.goal-state.json` containing a `command`, and you open it in
OpenCode with this plugin enabled, that command can run on the first idle.

Mitigations and guidance:

- The state file is **git-ignored** by this project's `.gitignore`, so it isn't committed in normal use —
  but an attacker can force-add one. Treat a *pre-existing* `.opencode/.goal-state.json` in cloned code as
  untrusted.
- **Don't enable this plugin globally if you routinely open untrusted repositories.** Prefer enabling it
  per-project, in projects you trust. (Opening untrusted code in *any* agent/IDE is inherently risky —
  a malicious `opencode.json`, npm `postinstall`, or build script is an equivalent vector.)
- If you'd like a hard switch to disable command execution entirely
  (e.g. `["opencode-autogoal", { "allowCommandExecution": false }]`), open an issue — it's a small addition
  and a reasonable default for security-sensitive environments.

### 3. Path traversal in template names — fixed

`/goal template <name>` interpolates `<name>` into a file path. Names are validated against
`^[A-Za-z0-9_-]+$`, so they cannot escape `.opencode/goals/` (e.g. `../../etc/passwd`). Fixed and
regression-tested in 0.1.0.

### 4. Prompt-injection surface (low)

A verification command's output (truncated to 200 chars) and the goal condition are injected into the
agent's context as it's nudged onward. A command that prints adversarial text could influence the agent.
Low risk in practice (it's your own command), but worth knowing.

### 5. Cross-shell command execution (intentional, with a workaround)

The verification command runs through `child_process.exec`, which on POSIX uses `/bin/sh -c` and on
Windows uses `cmd.exe /d /s /c`. The same command string can tokenize differently on the two shells
(single quotes work on POSIX, cmd.exe ignores them; backslashes and `&&` mean different things). For
the **built-in templates** (`fix-lint`, `fix-types`, `pass-tests`) this is not an issue — they're
authored to be portable. For a **user-supplied `--command`**, a state file that works on the
author's machine may behave differently on the victim's.

The `parseShellWords` helper (exported from `goal-state.ts`) gives a portable POSIX-style argv view of
any command string. The plugin logs this argv at debug level (`OPENGOAL_DEBUG=1`). The plugin still
uses `exec` for the default execution path so you keep full shell semantics (pipes, redirects, `&&`).
If you want argv-only execution with no shell, that is a planned `verificationShell: "none"` opt-in —
open an issue if you need it.

## What this project does NOT do

No network calls, no telemetry, no secret access, no `eval`/`new Function`, and no runtime dependencies
beyond OpenCode's own plugin API. Argument parsing uses linear regexes (no ReDoS). The plugin's only
filesystem mutations are reads and writes to the state file at `.opencode/.goal-state.json`.
