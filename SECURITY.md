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

## What this project does NOT do

No network calls, no telemetry, no secret access, no `eval`/`new Function`, and no runtime dependencies
beyond OpenCode's own plugin API. Argument parsing uses linear regexes (no ReDoS).
