#!/usr/bin/env node
/**
 * opencode-autogoal CLI — standalone entry point.
 *
 * Exposes the goal-loop commands as a command-line tool so external
 * software (CI scripts, cron jobs, shell aliases, other agents) can
 * drive the goal loop without going through OpenCode's plugin layer.
 *
 * The CLI is a thin wrapper around `dispatchGoalCommandStructured`
 * (plus `dispatchGoalCommand` for the `--command` argv-rebuilding
 * path on `set`). It reads/writes the same state file at
 * `.opencode/.goal-state.json` (or `--dir <path>/.opencode/.goal-state.json`)
 * that the OpenCode TUI, sidebar, and server plugin use, so multiple
 * surfaces (CLI + OpenCode) coordinate via the same on-disk state.
 *
 * ── Usage ─────────────────────────────────────────────────────────────────
 *   opencode-autogoal [--dir <path>] <command> [args...]
 *
 * ── Commands ──────────────────────────────────────────────────────────────
 *   set <condition> [--command "cmd"]  Set a new goal (replaces current)
 *   view | status                       Show current goal state
 *   pause                               Pause the auto-loop
 *   resume                              Resume from pause
 *   clear | stop                        Clear the current goal (terminal state)
 *   restart                             Restart the same goal (new id, fresh counters)
 *   history                             Show evaluation history
 *
 * ── Dials (v0.2.0+ live edits) ────────────────────────────────────────────
 *   turns <n>                  Set max turns (1..10000)
 *   time <n>                   Set max time in minutes (1..10000)
 *   tokens <n>                 Set max tokens (1..10000000)
 *   condition "<text>"         Edit the goal condition
 *   steer "<hint>"             Append a steering note for the next nudge
 *   unsteer                    Clear all steering notes
 *
 * ── Handoff ───────────────────────────────────────────────────────────────
 *   handoff [note]             Write a handoff file for a future session
 *   claim                      Claim a pending handoff
 *
 * ── Exit codes ────────────────────────────────────────────────────────────
 *   0  success (or no-op: pause-from-paused, resume-from-active)
 *   1  user error (bad args, invalid value)
 *   2  no goal / terminal state / precondition not met
 *      (clear-from-cleared, pause-from-cleared, editMax-on-terminal, etc.)
 *   3  write failed (I/O error, permission denied, disk full)
 *
 * Exit codes are determined by the structured dispatcher's `kind` field,
 * not by grepping the human-readable output. Scripts can branch on
 * the exit code without parsing the text. The README has the table.
 */

import { dispatchGoalCommandStructured, KIND_TO_EXIT } from "./command.js";
import { resolve, basename, extname } from "node:path";
import { existsSync, realpathSync, readFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { MAX_TEMPLATE_IMPORT_SIZE } from "./templates.js";

const HELP = `opencode-autogoal — goal-loop CLI

Usage: opencode-autogoal [--dir <path>] <command> [args...]

If --dir is not given, uses the current working directory. The state file
is at <dir>/.opencode/.goal-state.json (auto-created on first action).

Commands:
  set <condition>            Set a new goal (replaces any current goal)
  view | status              Show the current goal's status block
  pause                      Pause the auto-loop
  resume                     Resume a paused goal
  clear | stop | off | reset | none | cancel
                             Clear the current goal (marks it terminal)
  restart                    Restart with the same condition + constraints
  history                    Show the last 10 evaluation records

Templates (built-in or in .opencode/goals/<name>.json):
  template | use <name>      Set a goal from a built-in or project template
  template list              List built-in + user templates
  template export <name>     Print a template's JSON
  template import <path>     Import a template from a file
  template import -          Import a template from stdin (JSON)

Dials (live edits — keep the goal, change a constraint):
  turns <n>                  Set max turns (1..10000)
  time <n>                   Set max time in minutes (1..10000)
  tokens <n>                 Set max tokens (1..10000)
  condition "<text>"         Replace the goal condition
  steer "<hint>"             Append a steering note for the next nudge
  unsteer                    Clear all steering notes

Handoff (multi-session continuity):
  handoff [note]             Write a handoff file for a future session
  claim                      Claim a pending handoff (resumes the goal)

Examples:
  opencode-autogoal set "make all tests pass" --command "npm test"
  opencode-autogoal status
  opencode-autogoal template fix-lint
  opencode-autogoal steer "focus on the flaky integration suite"
  opencode-autogoal turns 100
  opencode-autogoal pause
  opencode-autogoal handoff "for tomorrow's session"
  opencode-autogoal --dir /path/to/project status
`;

interface ParsedArgs {
  directory: string;
  action: string;
  /** The post-action argv elements, kept as a list so `buildSetPayload`
   *  (Task 4) can scan for `--command` and re-quote it. */
  payloadParts: string[];
}

/**
 * Parse argv into (directory, action, payloadParts).
 * Returns null if `--help`/`-h`/`help` was requested (caller prints HELP).
 * Throws Error on malformed args (caller prints and exits 1).
 */
function parseArgs(argv: string[]): ParsedArgs | null {
  if (argv.length === 0) return null;
  if (argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") return null;

  let directory = process.cwd();
  let startIdx = 0;
  if (argv[0] === "--dir") {
    if (argv.length < 2 || argv[1] === "") {
      // B4: an empty string after --dir would `resolve("")` to cwd
      // and silently behave like omitting the flag. That's confusing
      // for scripts that want to construct the path dynamically.
      throw new Error("--dir requires a path argument");
    }
    directory = resolve(argv[1]);
    if (!existsSync(directory)) {
      throw new Error(`--dir path does not exist: ${directory}`);
    }
    startIdx = 2;
  }

  if (startIdx >= argv.length) {
    throw new Error("missing command (try: opencode-autogoal help)");
  }

  const action = argv[startIdx];
  const payloadParts = argv.slice(startIdx + 1);
  return { directory, action, payloadParts };
}

/**
 * Map CLI action names to the dispatcher's verb. Some CLI commands are
 * aliases (e.g. `status` → `view`, `stop` → `clear`). The aliases here
 * MUST stay in sync with the dispatcher's `KNOWN_ACTIONS` /
 * `CLEAR_ALIASES` sets in `src/command.ts` — drift would mean a user
 * can invoke an action via `/goal` but not via the CLI, which is
 * confusing. Round 4 (B2) caught a gap: `off`, `reset`, `none`,
 * `cancel` (clear aliases) and `template`, `use` (template + alias)
 * were missing here even though the dispatcher accepted them.
 */
const CLI_TO_DISPATCHER: Record<string, string> = {
  set: "set",
  view: "view",
  status: "view",
  pause: "pause",
  resume: "resume",
  clear: "clear",
  stop: "clear",
  off: "clear",
  reset: "clear",
  none: "clear",
  cancel: "clear",
  template: "template",
  use: "template",
  restart: "restart",
  history: "history",
  turns: "turns",
  time: "time",
  tokens: "tokens",
  condition: "condition",
  steer: "steer",
  unsteer: "unsteer",
  handoff: "handoff",
  claim: "claim",
  chain: "chain",
};

function main(): number {
  let parsed: ParsedArgs | null;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err: any) {
    process.stderr.write(`opencode-autogoal: ${err.message}\n\n`);
    process.stderr.write(HELP);
    return 1;
  }
  if (parsed === null) {
    process.stdout.write(HELP);
    return 0;
  }

  const dispatcherAction = CLI_TO_DISPATCHER[parsed.action];
  if (dispatcherAction === undefined) {
    process.stderr.write(`opencode-autogoal: unknown command "${parsed.action}"\n\n`);
    process.stderr.write(HELP);
    return 1;
  }

  // v0.4.0+: `template import <path>` / `template import -` need the
  // CLI to read a file (or stdin) BEFORE the dispatcher sees the args
  // (the dispatcher's import path expects inline JSON, not a path).
  // We rewrite the payload to `<basename> <fileContent>` and let the
  // dispatcher drive the rest (validation, atomic write, exit kind).
  if (dispatcherAction === "template" && parsed.payloadParts[0] === "import") {
    return handleTemplateImport(parsed.directory, parsed.payloadParts.slice(1));
  }

  // Build the same argv-style string the dispatcher expects:
  // "<action> <payload>". The dispatcher splits on the first space.
  // For `set` actions with a `--command` flag, use `buildSetPayload`
  // to preserve quoting (Task 4).
  let dispatcherArg: string;
  try {
    dispatcherArg = buildDispatcherArg(dispatcherAction, parsed.payloadParts);
  } catch (err: any) {
    process.stderr.write(`opencode-autogoal: ${err.message}\n\n`);
    process.stderr.write(HELP);
    return 1;
  }

  // Use the structured dispatcher: the `kind` field gives us a clean
  // exit-code decision (no prose-grepping), and the `message` field
  // is the user-facing text without the conversational relay wrapper
  // (the dispatcher already separates that into `agentExtras`).
  const res = dispatchGoalCommandStructured(parsed.directory, dispatcherArg);
  process.stdout.write(`${res.message}\n`);
  // Defensive: if a future refactor adds a new kind without updating
  // KIND_TO_EXIT, the lookup returns undefined and process.exit(0)
  // would silently mask an internal bug. Fail closed with exit 3
  // (the same code as write-failed) so the bug surfaces immediately.
  const code = KIND_TO_EXIT[res.kind];
  if (code === undefined) {
    process.stderr.write(`opencode-autogoal: internal error: unknown kind '${res.kind}'\n`);
    return 3;
  }
  return code;
}

/**
 * Build the dispatcher's expected argv string from the CLI's (action, payloadParts).
 * The dispatcher expects "<action> <payload>" with shell-style quoting
 * preserved verbatim. We DO NOT re-quote — the user's shell already
 * stripped the quotes; the payload is the literal text after the action.
 *
 * For `set` actions, `buildSetPayload` detects `--command` in the
 * post-action argv elements and re-quotes the value so the
 * dispatcher's `parseCommand` regex finds it. See Task 4.
 *
 * Special case: empty payload means just the action. Used by `view`,
 * `pause`, `resume`, `clear`, `restart`, `history`, `unsteer`, `claim`.
 */
function buildDispatcherArg(action: string, parts: string[]): string {
  if (parts.length === 0) return action;
  if (action === "set") {
    return `${action} ${buildSetPayload(parts)}`;
  }
  return `${action} ${parts.join(" ")}`;
}

/**
 * For the `set` action only: detect `--command` in the post-action
 * argv elements and re-quote the SINGLE next element so the
 * dispatcher's `parseCommand` regex (`/--command\s+"([^"]+)"/`)
 * finds it. The user's shell already grouped the command into one
 * argv element; the dispatcher just needs the literal quote chars.
 *
 * The SINGLE-next-element rule means multi-word commands like
 * `make deploy` must be quoted by the shell — the dispatcher gets
 * one argv element `["make deploy"]`, not two. Elements AFTER
 * the command value become part of the condition.
 *
 * Empty value (`--command ""`) is treated as "no command" — the
 * flag is stripped entirely. This matches the user's intent: a
 * script that wants a goal with no verification command passes
 * `--command ""` rather than omitting the flag. The opposite
 * choice (throwing on empty) would force scripts to track whether
 * they passed the flag at all, which is brittle.
 *
 * Duplicate `--command` throws — the user almost certainly meant
 * one or the other, never both, and silently taking the first
 * hides bugs in their scripts.
 *
 * Examples:
 *   buildSetPayload(["ship", "v2", "--command", "make deploy"])
 *     → 'ship v2 --command "make deploy"'
 *   buildSetPayload(["--command", "echo", "hi"])
 *     → 'hi --command "echo"'  (the SINGLE next arg is "echo";
 *                               "hi" falls into the condition)
 *   buildSetPayload(["ship", "v2"])
 *     → 'ship v2'  (no --command)
 *   buildSetPayload(["ship", "v2", "--command", ""])
 *     → 'ship v2'  (empty value: strip the flag)
 *   buildSetPayload(["ship", "v2", "--command"])
 *     → throws (missing value)
 *   buildSetPayload(["--command", 'has "quote"'])
 *     → throws (value may not contain a double quote)
 *   buildSetPayload(["x", "--command", "a", "--command", "b"])
 *     → throws (duplicate --command)
 */
function buildSetPayload(parts: string[]): string {
  const i = parts.indexOf("--command");
  if (i === -1) return parts.join(" ");
  // Detect duplicate --command (A3). The user almost certainly meant
  // one or the other; silently taking the first hides bugs.
  if (parts.indexOf("--command", i + 1) !== -1) {
    throw new Error("duplicate --command flag");
  }
  if (i + 1 >= parts.length) {
    throw new Error("--command requires a value");
  }
  const cmd = parts[i + 1];
  if (cmd.includes('"')) {
    throw new Error('--command value may not contain double quotes');
  }
  // Empty value: strip the flag entirely (A2). The user wants
  // "no command", not "command = ''" which would store an empty
  // string and confuse the auto-loop's verification.
  if (cmd === "") {
    return [...parts.slice(0, i), ...parts.slice(i + 1)].join(" ").trim();
  }
  const condition = [...parts.slice(0, i), ...parts.slice(i + 2)].join(" ");
  // Adversarial audit finding #2: place --command BEFORE the condition so
  // the dispatcher's parseCommand regex (which matches the FIRST occurrence
  // of --command) finds the real one, not a fake one embedded in the
  // condition text (e.g. `set "pre --command \"evil\"" --command "real"`).
  return `--command "${cmd}" ${condition}`.trim();
}

// node:test entry — exported so the regression test suite can import
// parseArgs / buildSetPayload / isCliEntry / CLI_TO_DISPATCHER /
// handleTemplateImport without spawning a child process.
export { parseArgs, buildSetPayload, isCliEntry, CLI_TO_DISPATCHER, handleTemplateImport };

/**
 * v0.4.0+: bridge the CLI's `template import <path>` / `template
 * import -` form to the dispatcher's inline-JSON form
 * (`template import <name> <json-content>`).
 *
 *  - `<path>`: read the file. Use the basename (sans `.json`) as the
 *    template name. Spec §"CLI".
 *  - `-`: stdin. Spec §"Stdin import guard": if `process.stdin.isTTY`
 *    is true, error out — the user probably forgot to pipe. Otherwise
 *    read stdin to EOF, parse just enough to extract the `name` field
 *    (the dispatcher's existing path uses the name as the file slug).
 *    If `name` is missing, error with a clear message.
 *
 * Errors are returned as a tuple `[exitCode, message]`; the caller
 * writes to stdout/stderr and returns the code. We DO NOT call
 * `process.exit` here so the test suite can drive the function in-process.
 */
function handleTemplateImport(directory: string, parts: string[]): number {
  const arg = parts[0];
  if (!arg) {
    process.stderr.write("opencode-autogoal: usage: template import <path|->\n\n");
    process.stderr.write(HELP);
    return 1;
  }
  if (parts.length > 1) {
    // `template import foo.json extra` — reject to keep the surface small.
    process.stderr.write("opencode-autogoal: template import takes a single path argument\n\n");
    process.stderr.write(HELP);
    return 1;
  }

  let content: string;
  let derivedName: string | null = null;

  if (arg === "-") {
    // Stdin guard: a TTY means the user didn't pipe anything in.
    // Reading from a TTY would BLOCK (and on Windows would actually
    // return EOF immediately, silently producing a useless empty import).
    if (process.stdin.isTTY === true) {
      process.stderr.write("opencode-autogoal: stdin is a terminal. Pipe template JSON or use template import <path>.\n");
      return 1;
    }
    // Read stdin in chunks and abort if we exceed the size cap. The
    // `importTemplate` primitive would reject the oversize payload
    // eventually (256KB cap in templates.ts), but only AFTER we've
    // allocated a 50MB+ string. (Red-team audit, Pass 2 — file I/O with
    // user paths.) fstat on a pipe always reports size=0, so we must
    // read-and-count. We still re-check content.length before the
    // primitive call as a defense-in-depth (the chunked read could
    // land just under the cap during streaming and finish exactly at it).
    //
    // We can't use createReadStream on /dev/stdin (POSIX-only) or
    // process.stdin as a stream (async). fs.readSync works on raw fd
    // numbers on every platform, so the fd is opened via /dev/fd/N on
    // POSIX, and used as-is on Windows where /dev/fd/ is not present.
    const chunkSize = 64 * 1024;
    const stdinChunks: Buffer[] = [];
    let stdinTotal = 0;
    let stdinTruncated = false;
    let openedFd: number | null = null;
    try {
      let readFd: number;
      try {
        readFd = openSync(`/dev/fd/${process.stdin.fd}`, "r");
        openedFd = readFd;
      } catch {
        // /dev/fd/N not available (Windows). Use the raw fd directly;
        // readSync accepts fd numbers on every platform.
        readFd = process.stdin.fd as unknown as number;
      }
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const buf = Buffer.alloc(chunkSize);
        const bytesRead = readSync(readFd, buf, 0, chunkSize, null);
        if (bytesRead === 0) break;
        stdinTotal += bytesRead;
        if (stdinTotal > MAX_TEMPLATE_IMPORT_SIZE) {
          stdinTruncated = true;
          break;
        }
        stdinChunks.push(bytesRead === chunkSize ? buf : buf.subarray(0, bytesRead));
      }
    } finally {
      if (openedFd !== null) {
        try { closeSync(openedFd); } catch { /* ignore */ }
      }
    }
    if (stdinTruncated) {
      process.stderr.write(`opencode-autogoal: stdin template too large (>${MAX_TEMPLATE_IMPORT_SIZE} bytes / 256KB).\n`);
      return 1;
    }
    content = Buffer.concat(stdinChunks).toString("utf-8");
    if (content.length === 0) {
      process.stderr.write("opencode-autogoal: stdin is empty. Pipe template JSON or use template import <path>.\n");
      return 1;
    }
    // Stdin has no filename — derive name from JSON's `name` field.
    try {
      const peek = JSON.parse(content);
      if (peek && typeof peek === "object" && typeof (peek as Record<string, unknown>).name === "string") {
        derivedName = (peek as Record<string, unknown>).name as string;
      } else {
        process.stderr.write("opencode-autogoal: stdin template must include a top-level string 'name' field.\n");
        return 1;
      }
    } catch (err: any) {
      process.stderr.write(`opencode-autogoal: stdin is not valid JSON: ${err?.message ?? err}\n`);
      return 1;
    }
  } else {
    const path = resolve(directory, arg);
    if (!existsSync(path)) {
      process.stderr.write(`opencode-autogoal: template file not found: ${path}\n`);
      return 1;
    }
    // Size cap BEFORE readFileSync — the importTemplate primitive would
    // reject the oversize payload eventually, but only AFTER we've
    // allocated a 50MB+ string. (Red-team audit, Pass 2 — file I/O with
    // user paths.)
    const fileSize = statSync(path).size;
    if (fileSize > MAX_TEMPLATE_IMPORT_SIZE) {
      process.stderr.write(`opencode-autogoal: template file too large (${fileSize} bytes; max ${MAX_TEMPLATE_IMPORT_SIZE} bytes / 256KB).\n`);
      return 1;
    }
    content = readFileSync(path, "utf-8");
    // Use basename without extension as the name. Spec doesn't mandate,
    // but it's the obvious convention and matches what users see in
    // `discoverTemplates` output.
    const base = basename(path, extname(path));
    if (/^[A-Za-z0-9_-]+$/.test(base)) {
      derivedName = base;
    } else {
      // Path basename has chars the name regex rejects. Don't fail the
      // import outright — just don't pre-derive a name; the JSON's
      // `name` field (if present) will be used by the dispatcher
      // because the import primitive's name comes from the FIRST arg,
      // not from the JSON. Hmm — that's a problem.
      //
      // We have to pass SOME name to the dispatcher. The cleanest
      // fallback: re-extract from JSON. If that also fails, error.
      try {
        const peek = JSON.parse(content);
        if (peek && typeof peek === "object" && typeof (peek as Record<string, unknown>).name === "string") {
          derivedName = (peek as Record<string, unknown>).name as string;
        }
      } catch { /* fall through */ }
      if (!derivedName) {
        process.stderr.write(`opencode-autogoal: template file basename '${base}' is not a valid template name and the file has no 'name' field. Rename the file or add a top-level 'name' string.\n`);
        return 1;
      }
    }
  }

  // Forward to the dispatcher using the inline form. The dispatcher's
  // import subcommand already calls the primitive, which validates +
  // writes atomically. We just translate path/stdin → (name, content).
  const dispatcherArg = `template import ${derivedName} ${content}`;
  const res = dispatchGoalCommandStructured(directory, dispatcherArg);
  process.stdout.write(`${res.message}\n`);
  const code = KIND_TO_EXIT[res.kind];
  if (code === undefined) return 3;
  return code;
}

/**
 * True when this module is the process entry point. The previous
 * hand-rolled comparison
 *   `import.meta.url === file:///${process.argv[1]?.replace(/\\/g, "/")}`
 * failed in three real-world ways:
 *   - POSIX: produced 4 slashes (file:////home/...) vs import.meta.url's 3
 *   - Windows: literal spaces in argv[1] weren't %20-encoded
 *   - npm bin symlinks: argv[1] is the symlink, import.meta.url is real path
 *
 * Using pathToFileURL normalizes the argv path to its canonical
 * file:// URL (handles encoding and the slash count), and realpathSync
 * resolves symlinks. Both sides are compared as `href` strings.
 */
function isCliEntry(metaUrl: string, argv1: string | undefined): boolean {
  if (!argv1) return false;
  try {
    if (pathToFileURL(argv1).href === metaUrl) return true;
  } catch { /* fall through to realpath attempt */ }
  try {
    return pathToFileURL(realpathSync(argv1)).href === metaUrl;
  } catch {
    return false;
  }
}

// Only run when invoked as a script, not when imported by the test suite.
if (isCliEntry(import.meta.url, process.argv[1])) {
  const code = main();
  process.exit(code);
}
