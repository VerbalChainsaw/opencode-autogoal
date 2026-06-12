/**
 * OpenGoal core — types, argument parsing, state construction, atomic I/O, status
 * transitions, completion-marker detection, and status formatting.
 *
 * This is the single source of truth for everything that touches the goal state
 * file. It has ZERO third-party imports (only Node builtins), so the compiled
 * output is self-contained and the package needs no runtime dependencies.
 *
 * Ported verbatim from the previously unit-tested scripts (set-state / update-state /
 * read-state) so behaviour is unchanged — just consolidated and cross-platform.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, statSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

export type GoalStatus = "active" | "paused" | "achieved" | "cleared";
export type EvaluatorType = "deterministic" | "model" | "heuristic";

export interface GoalEvaluation {
  met: boolean;
  reason: string;
  confidence: number; // 0.0 to 1.0
  timestamp: number;
  evaluatorType: EvaluatorType;
  rawOutput?: string;
  /** Set when the agent signalled it is stuck (GOAL_BLOCKED). Pauses the loop. */
  blocked?: boolean;
}

export interface GoalConstraints {
  maxTurns: number;
  maxTimeMinutes: number;
  maxTokens: number;
}

/** v0.4.0+ — how the goal condition is verified. */
export type Verification =
  | { type: "shell"; command: string }
  | { type: "http"; url: string; expectStatus?: number; expectBody?: string; timeoutMs?: number }
  | { type: "file"; path: string; exists?: boolean; contains?: string }
  | { type: "marker" };

export interface GoalState {
  version: number;
  id: string;
  condition: string;
  command?: string | null;
  /** v0.4.0+ — structured verification. Takes priority over `command`. */
  verification?: Verification | null;
  status: GoalStatus;
  createdAt: number;
  startedAt: number;
  completedAt: number | null;
  pausedAt: number | null;
  resumedAt: number | null;
  turnsEvaluated: number;
  tokensUsed: number;
  lastEvaluation: GoalEvaluation | null;
  evaluationHistory: GoalEvaluation[];
  constraints: GoalConstraints;
  metadata: {
    setBy: "user" | "template" | "chain";
    sessionId?: string;
    agentName?: string;
    /** v0.2.0+ — set by editCondition when the user edits the condition live. */
    conditionEditedAt?: number;
    /** v0.2.0+ — set by restartGoal so a new id has a breadcrumb to the prior. */
    previousId?: string;
    /** v0.2.0+ — set by restartGoal to record the last restart timestamp. */
    restartedAt?: number;
    /** v0.2.0+ — append-only steering notes (capped at MAX_STEERING_NOTES). */
    steering?: Array<{ at: number; note: string }>;
    /** v0.2.0+ — set by claimHandoff to record the resume timestamp. */
    resumedFromHandoffAt?: number;
    /** v0.4.0+ — links this goal to its parent chain. */
    chainId?: string;
    /** v0.4.0+ — which step this goal represents (0-based). */
    chainStep?: number;
    /** v0.4.0+ — total steps in the chain. */
    chainTotal?: number;
    /** v0.4.0+ — webhook notification config. */
    webhook?: { url: string; on: GoalStatus[]; allowLocal?: boolean };
  };
}

export const STATE_FILE = ".opencode/.goal-state.json";
export const MAX_CONDITION_LEN = 4000;
export const DEFAULT_CONSTRAINTS: GoalConstraints = { maxTurns: 20, maxTimeMinutes: 30, maxTokens: 100000 };

// ── Constraint bounds ──────────────────────────────────────────────────────
// Reject the runaway / no-op failure modes. The loop in `server.ts` treats
// `state.turnsEvaluated >= constraints.maxTurns` as the trip condition; if
// `maxTurns` is 0 the goal is immediately cleared, and if it's 1e20 the limit
// never trips. Both are user-hostile (silent goal death / silent infinite
// loop). Clamp to a sane range; out-of-range values fall back to the default.
export const CONSTRAINT_BOUNDS = {
  minTurns: 1,
  maxTurns: 10_000,
  minMinutes: 1,
  maxMinutes: 10_000,
  minTokens: 1,
  maxTokens: 10_000_000,
} as const;

/** Clamp `value` into [lo, hi]; return the default if non-finite or out of range. */
function clampOrDefault(value: number, lo: number, hi: number, fallback: number): number {
  if (!Number.isFinite(value) || value < lo || value > hi) return fallback;
  return value;
}

// ── Completion protocol ─────────────────────────────────────────────────────
// The agent signals completion by writing a line beginning with `GOAL_COMPLETE:`
// (or `GOAL_BLOCKED:` if stuck). The detection is intentionally strict: the
// marker must be at the start of a line, NOT inside a markdown code fence,
// NOT inside an indented code block, and NOT mid-sentence. The cycle-0 audit
// found the previous version tripped on code-fence content (the agent
// explaining the protocol in a markdown block).
//
// The protocol: scan top-to-bottom tracking fenced-code-block state, return
// the LAST non-fenced, line-anchored, exact-marker match.
//
//   ```
//   GOAL_COMPLETE: tests pass        ← ignored (inside fenced code block)
//   ```
//   GOAL_COMPLETE: all done          ← accepted (line-anchored, outside fence)
//   "to mark complete, output
//    GOAL_COMPLETE: <evidence>"      ← ignored (inside indented code block:
//                                       a line starting with 4+ spaces in
//                                       markdown is a code-block line)
//   GOAL_COMPLETE: with one space    ← accepted (1 space — typical prose indent)
//
// The previous regex `/^\s*GOAL_COMPLETE\s*:\s*(.*)$/i` matched the first
// case (false positive). The new regex limits leading whitespace to 0-3
// characters (markdown's "indented code block" threshold is 4+ spaces) AND
// the parser tracks fenced code blocks separately.
//
// The marker is CASE-SENSITIVE (the protocol is documented uppercase;
// the agent's instructions in command.ts:60-61 say exactly that). A
// lowercase "goal_complete:" does NOT trip.
export const COMPLETE_RE = /^[ ]{0,3}GOAL_COMPLETE\s*:\s*(.*)$/;
export const BLOCKED_RE = /^[ ]{0,3}GOAL_BLOCKED\s*:\s*(.*)$/;

const FENCE_RE = /^\s*(`{3,}|~{3,})/;

/**
 * Find the marker in `text`, ignoring any line that sits inside a fenced code
 * block (markdown ``` or ~~~). Returns the marker's trailing text, or null.
 *
 * Implementation: scan lines in order, track an `inFence` boolean. Each
 * fence open/close toggles it. Only line-anchored matches OUTSIDE a fence
 * count. Walks top-to-bottom and returns the LAST match (the agent's most
 * recent statement, not an old one — the `^` anchor + top-to-bottom scan
 * naturally implements this).
 */
export function detectMarker(text: string, re: RegExp): string | null {
  // Split on \n, \r\n, or bare \r (old Mac line endings). The triple-alternative
  // matches each line terminator once without leaving stray \r in the line content.
  const lines = text.split(/\r?\n|\r(?!\n)/);
  let inFence = false;
  let fenceMarker: string | null = null;
  let result: string | null = null;
  for (const line of lines) {
    // Fence open/close detection runs FIRST so a line that opens a fence with
    // the marker (e.g. the agent literally writes "```\\nGOAL_COMPLETE: ...\\n```")
    // doesn't trip the marker.
    const fenceMatch = line.match(FENCE_RE);
    if (fenceMatch) {
      const marker = fenceMatch[1]![0]!;
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
      } else if (fenceMarker === marker) {
        inFence = false;
        fenceMarker = null;
      }
      // Don't scan this line for the marker (it may be the line that opens
      // the fence with the marker as its content).
      continue;
    }
    if (inFence) continue;
    const m = line.match(re);
    if (m) result = (m[1] ?? "").trim();
  }
  return result;
}

// ── Validation ──────────────────────────────────────────────────────────────
// Deep validation: every field the runtime reads downstream is shape-checked
// and type-checked. A state file with `constraints: {}` or `command: [array]`
// would otherwise pass the shape check and crash later in `checkConstraints` /
// `execAsync` with an unhelpful error. Rejecting at the boundary turns those
// into clean "state file is corrupt, ignoring it" recovery.
const VALID_STATUSES = new Set<GoalStatus>(["active", "paused", "achieved", "cleared"]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

export function validateGoalState(state: any): state is GoalState {
  if (!isPlainObject(state)) return false;
  if (!isFiniteNumber(state.version)) return false;
  if (typeof state.id !== "string" || state.id.length === 0) return false;
  if (typeof state.condition !== "string") return false;
  if (typeof state.status !== "string" || !VALID_STATUSES.has(state.status as GoalStatus)) return false;
  if (!isFiniteNumber(state.createdAt)) return false;
  if (!isFiniteNumber(state.startedAt)) return false;
  // Optional-but-typed fields. The schema treats them as `T | null`; an absent
  // field reads back as `undefined` from JSON.parse and is acceptable.
  if (state.completedAt !== null && state.completedAt !== undefined && !isFiniteNumber(state.completedAt)) return false;
  if (state.pausedAt !== null && state.pausedAt !== undefined && !isFiniteNumber(state.pausedAt)) return false;
  if (state.resumedAt !== null && state.resumedAt !== undefined && !isFiniteNumber(state.resumedAt)) return false;
  if (!isFiniteNumber(state.turnsEvaluated) || state.turnsEvaluated < 0) return false;
  if (!isFiniteNumber(state.tokensUsed) || state.tokensUsed < 0) return false;
  // `command` may be `string | null | undefined`. The runtime (server.ts:178)
  // passes it to `execAsync` if truthy; an array or object would be coerced via
  // String() and produce silent corruption. Reject anything but string/null/absent.
  if (state.command !== undefined && state.command !== null && typeof state.command !== "string") return false;
  // v0.4.0+ verification — if present, must be a valid shape
  if (state.verification !== undefined && state.verification !== null) {
    if (!isPlainObject(state.verification)) return false;
    const v = state.verification as Record<string,unknown>;
    if (typeof v.type !== "string") return false;
    const VALID_VTYPES = new Set(["shell","http","file","marker"]);
    if (!VALID_VTYPES.has(v.type)) return false;
    if (v.type === "shell" && typeof v.command !== "string") return false;
    if (v.type === "http" && typeof v.url !== "string") return false;
    if (v.type === "file" && typeof v.path !== "string") return false;
  }
  if (state.lastEvaluation !== null && state.lastEvaluation !== undefined && !isPlainObject(state.lastEvaluation)) {
    return false;
  }
  if (state.evaluationHistory !== undefined && !Array.isArray(state.evaluationHistory)) return false;
  // Cap the history length. The runtime only reads `lastEvaluation` and the
  // sidebar's eval-strip shows at most 3 entries; a 100k-entry history is
  // a memory + I/O DoS vector (claimHandoff with a hand-crafted handoff
  // would propagate it). The cap is the same one `createHandoff` uses
  // when serializing.
  if (Array.isArray(state.evaluationHistory) && state.evaluationHistory.length > 10) return false;
  // Constraints must have all 3 numeric fields. Empty `{}` previously passed
  // the loose `typeof === "object"` check and caused silent infinite loops
  // because `state.constraints.maxTurns` was `undefined`.
  if (!isPlainObject(state.constraints)) return false;
  if (!isFiniteNumber(state.constraints.maxTurns) || state.constraints.maxTurns < CONSTRAINT_BOUNDS.minTurns) return false;
  if (!isFiniteNumber(state.constraints.maxTimeMinutes) || state.constraints.maxTimeMinutes < CONSTRAINT_BOUNDS.minMinutes) return false;
  if (!isFiniteNumber(state.constraints.maxTokens) || state.constraints.maxTokens < CONSTRAINT_BOUNDS.minTokens) return false;
  // metadata: loose by design. `setBy` is the only field read at runtime;
  // unknown keys are tolerated for forward-compat but stripped by
  // `sanitizeMetadata` on any untrusted-source path (claim/restart). A
  // mis-shaped `steering` is tolerated too — the runtime reads it behind
  // `Array.isArray` guards (treats junk as `[]`) and sanitizes the injected
  // note. The DoS angle (a huge planted file) is bounded by the file-size cap
  // in `readGoalState`/`readHandoff`, not by rejecting the whole goal here.
  // (Security review #1 — closed via size cap + sanitize-on-use, not validator
  // rejection, to preserve the "don't lose the goal over a bad sub-field" contract.)
  if (state.metadata !== undefined && !isPlainObject(state.metadata)) return false;
  return true;
}

// ── Argument parsing ────────────────────────────────────────────────────────
// `parseConstraints` reads inline modifier phrases ("stop after N turns/minutes/
// tokens", "--turns N", etc.) from the user-typed string. The parsed values
// are clamped to `CONSTRAINT_BOUNDS` to prevent the two failure modes the
// previous version was vulnerable to:
//
//   1. `0` accepted → goal immediately cleared on first idle (`0 >= 0`).
//   2. `1e20` accepted → constraint never trips, silent infinite loop.
//
// An out-of-range value falls back to the per-field default rather than the
// user-typed-but-invalid value, so a typo can't silently kill the goal.
export function parseConstraints(text: string, defaults: GoalConstraints): GoalConstraints {
  const c = { ...defaults };
  let m: RegExpMatchArray | null;
  if ((m = text.match(/stop after (\d+) turns?/i)) || (m = text.match(/--turns\s+(\d+)/i))) {
    c.maxTurns = clampOrDefault(
      parseInt(m[1], 10),
      CONSTRAINT_BOUNDS.minTurns,
      CONSTRAINT_BOUNDS.maxTurns,
      defaults.maxTurns,
    );
  }
  if ((m = text.match(/stop after (\d+) minutes?/i)) || (m = text.match(/--time\s+(\d+)/i))) {
    c.maxTimeMinutes = clampOrDefault(
      parseInt(m[1], 10),
      CONSTRAINT_BOUNDS.minMinutes,
      CONSTRAINT_BOUNDS.maxMinutes,
      defaults.maxTimeMinutes,
    );
  }
  if ((m = text.match(/stop after (\d+)(k)? tokens?/i))) {
    const raw = parseInt(m[1], 10) * (m[2] ? 1000 : 1);
    c.maxTokens = clampOrDefault(
      raw,
      CONSTRAINT_BOUNDS.minTokens,
      CONSTRAINT_BOUNDS.maxTokens,
      defaults.maxTokens,
    );
  }
  return c;
}

export function parseCommand(text: string): string | null {
  const m = text.match(/--command\s+"([^"]+)"/) || text.match(/--command\s+'([^']+)'/);
  return m ? m[1] : null;
}

/**
 * Strict positive-integer parser used by both the v0.2.0+ dial handlers
 * (tui-dials-logic.ts) and the /goal dispatcher (command.ts). Single source
 * of truth — the previous copy-paste in command.ts drifted in documentation
 * ("shared with the dial actions") even though the bodies were identical.
 *
 * Syntactic shape only: digits, no leading sign, no scientific notation,
 * no decimals. Returns the parsed integer (which may be 0; bounds-checking
 * is the caller's job, per CONSTRAINT_BOUNDS).
 */
export function parsePositiveInt(s: string): number | null {
  if (typeof s !== "string") return null;
  const trimmed = s.trim();
  if (trimmed.length === 0) return null;
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) return null;
  // Defense-in-depth: reject integers beyond IEEE 754 precision.
  // Number("9007199254740994") returns 9007199254740996 due to
  // floating-point rounding — silently returning a different value
  // is dangerous even though callers apply their own bounds.
  if (n > Number.MAX_SAFE_INTEGER) return null;
  return Math.trunc(n);
}

// ── POSIX word-splitting ─────────────────────────────────────────────────────
// Splits a shell-style command string into argv tokens, honoring single quotes
// (literal), double quotes (allows backslash escapes), and backslash escapes
// (preserves the next char literally, including outside quotes). This is a
// deliberately small subset of POSIX shell parsing — no `$` expansion, no glob
// expansion, no backticks, no brace expansion. The point is the **quoting** rules:
// the user types `--command "echo $HOME"` and the parsed argv is
// `["echo", "$HOME"]` (the dollar sign is preserved; the host's shell would
// expand it). The plugin does NOT use this for execution by default (the
// default `evaluateDeterministic` still goes through `exec` so users get full
// shell semantics); this helper is exported for:
//
//   1. Tests — assert that `--command "X"` parses to `["X"]` and
//      `--command "echo 'hello world'"` parses to `["echo", "hello world"]`.
//   2. Dry-run / display — the plugin can log "would execute: argv=[...]" so
//      users see what their command resolves to without actually running it.
//   3. Future `verificationShell: "none"` opt-in — a security-conscious
//      user can request argv-only execution (no shell), in which case the
//      plugin calls `execFile(parsed[0], parsed.slice(1))`. Pipes, redirects,
//      and `&&` don't work in that mode; the user opts in knowing that.
//
// Cross-shell inconsistency (cycle-0 I6): the default `exec` uses
// `/bin/sh -c` on POSIX and `cmd.exe /d /s /c` on Windows. The same command
// string can tokenize differently. This helper gives a *portable* view of
// the user's intent: the argv tokens are the same on every platform.
export function parseShellWords(s: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let inSingle = false;
  let inDouble = false;
  let hasContent = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    // Inside single quotes, EVERYTHING is literal — backslashes, dollar
    // signs, everything. The only special char inside single quotes is the
    // closing single quote itself. This matches POSIX shell semantics.
    if (inSingle) {
      if (c === "'") { inSingle = false; continue; }
      cur += c;
      hasContent = true;
      continue;
    }
    if (inDouble) {
      if (c === '"') { inDouble = false; continue; }
      if (c === "\\" && i + 1 < s.length) { cur += s[i + 1]!; i++; hasContent = true; continue; }
      cur += c; hasContent = true;
      continue;
    }
    // Outside quotes: backslash escapes the next char (preserves it).
    if (c === "\\" && i + 1 < s.length) {
      cur += s[i + 1]!;
      hasContent = true;
      i++;
      continue;
    }
    if (c === "'") { inSingle = true; hasContent = true; continue; }
    if (c === '"') { inDouble = true; hasContent = true; continue; }
    if (/\s/.test(c)) {
      if (hasContent) { tokens.push(cur); cur = ""; hasContent = false; }
      continue;
    }
    cur += c; hasContent = true;
  }
  if (hasContent) tokens.push(cur);
  return tokens;
}

/**
 * Strip ONE pair of surrounding matching quotes when the whole string is a
 * single quoted token — e.g. `/goal set "do the thing"` → `do the thing`.
 * Leaves inner quotes alone (`make the "smart" parser`) and multi-quote strings
 * (`"a" and "b"`) untouched by requiring exactly two occurrences of the quote.
 */
export function unwrapQuotes(s: string): string {
  if (s.length < 2) return s;
  const q = s[0];
  if ((q === '"' || q === "'") && s[s.length - 1] === q && s.split(q).length - 1 === 2) {
    return s.slice(1, -1).trim();
  }
  return s;
}

export function stripMetadata(text: string): string {
  return text
    .replace(/stop after \d+ turns?/gi, "")
    .replace(/stop after \d+ minutes?/gi, "")
    .replace(/stop after \d+k? tokens?/gi, "")
    .replace(/--turns\s+\d+/gi, "")
    .replace(/--time\s+\d+/gi, "")
    .replace(/--command\s+"[^"]+"/gi, "")
    .replace(/--command\s+'[^']+'/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export interface ParsedGoal {
  condition: string;
  command: string | null;
  verification?: Verification | null;
  constraints: GoalConstraints;
  custom: boolean;
}

export interface GoalSeed {
  constraints?: Partial<GoalConstraints>;
  command?: string | null;
  verification?: Verification | null;
}

/** Parse a raw `/goal set` argument string. Returns ParsedGoal or an error string. */
export function parseGoalInput(rawArgs: string, seed: GoalSeed = {}): ParsedGoal | { error: string } {
  const trimmed = (rawArgs ?? "").trim();
  if (!trimmed) return { error: 'Goal condition cannot be empty. Usage: /goal set "<condition>"' };

  const seedConstraints = { ...DEFAULT_CONSTRAINTS, ...(seed.constraints ?? {}) };
  const constraints = parseConstraints(trimmed, seedConstraints);
  const command = parseCommand(trimmed) ?? seed.command ?? null;
  const condition = unwrapQuotes(stripMetadata(trimmed));

  if (!condition) return { error: "Goal condition is empty after removing flags. Provide a condition to work toward." };
  if (condition.length > MAX_CONDITION_LEN)
    return { error: `Goal condition must be ${MAX_CONDITION_LEN} characters or fewer. Current length: ${condition.length}` };

  const custom =
    constraints.maxTurns !== DEFAULT_CONSTRAINTS.maxTurns ||
    constraints.maxTimeMinutes !== DEFAULT_CONSTRAINTS.maxTimeMinutes ||
    constraints.maxTokens !== DEFAULT_CONSTRAINTS.maxTokens;

  return { condition, command, constraints, custom };
}

export function createGoalState(parsed: ParsedGoal, setBy: "user" | "template" | "chain", now: number): GoalState {
  return {
    version: 1,
    id: randomUUID(),
    condition: parsed.condition,
    command: parsed.command,
    verification: parsed.verification ?? null,
    status: "active",
    createdAt: now,
    startedAt: now,
    completedAt: null,
    pausedAt: null,
    resumedAt: null,
    turnsEvaluated: 0,
    tokensUsed: 0,
    lastEvaluation: null,
    evaluationHistory: [],
    constraints: parsed.constraints,
    metadata: { setBy },
  };
}

// ── Atomic I/O (directory is the project root, provided by the plugin host) ──
export function goalStatePath(directory: string): string {
  return join(directory, STATE_FILE);
}

/** Max size of `.goal-state.json` we'll read. A legit state file is ~18KB
 *  (4000-char condition + 10 evals + 20×500 steering). A larger one is a
 *  planted DoS (re-parsed every idle); treat it as "no state". (Review #1.) */
export const MAX_STATE_SIZE = 256 * 1024;

/**
 * v0.4.1 (C-2) — reason a state-file read came back as "corrupt". The four
 * readers (readGoalState, readGoalStateRaw, readHandoff, readGoalChain)
 * historically collapsed three distinct failure modes (missing / oversize /
 * corrupt) into a single `null`, which meant a corrupt `.goal-state.json`
 * was silently treated as "no goal" and the next `setGoal` overwrote it,
 * destroying recoverable evidence. The new `ReadResult<T>` discriminates
 * `absent` from `corrupt`, and on `corrupt` the reader renames the file to
 * `<original>.corrupt.<Date.now()>` BEFORE returning so the user has a
 * forensic recovery path. See REVIEW-V040-MULTI-ANGLE.md §2.2.
 */
export type CorruptReason = "parse" | "validate" | "oversize" | "io";

/**
 * v0.4.1 (C-2) — tri-state result for the four state-file readers. Mirrors
 * the prototype at `gui.ts:readGoalStateSafe` (which threads `corrupt:
 * boolean`) but with a richer `corrupt.reason` and a typed `value` field so
 * callers don't have to do a separate "valid?" check. The shape is:
 *
 *   - `{ kind: "absent" }`  — file does not exist (legitimate "no state").
 *   - `{ kind: "corrupt"; reason; rawSize }` — file exists but cannot be
 *     parsed / validated / read; reader renamed it to
 *     `<original>.corrupt.<ts>` best-effort so the next `setGoal` can
 *     write a fresh tmp without overwriting the corrupt file silently.
 *   - `{ kind: "ok"; value }` — file parsed and (where applicable)
 *     validated; `value` is the typed payload.
 *
 * Migration: the v0.4.1 deliverable adds `readGoalStateResult`,
 * `readGoalStateRawResult`, and `readHandoffResult` returning `ReadResult`.
 * The original `readGoalState`, `readGoalStateRaw`, and `readHandoff`
 * become deprecated shims that call the new function and return `value`
 * on `ok` / `null` on `absent` or `corrupt`. Migrating the 51 internal
 * `src/` callsites to consume the discriminated `kind` is a v0.4.2 task.
 */
export type ReadResult<T> =
  | { kind: "absent" }
  | { kind: "corrupt"; reason: CorruptReason; rawSize: number }
  | { kind: "ok"; value: T };

/**
 * v0.4.1 (C-2) — best-effort rename of a corrupt state file to
 * `<original>.corrupt.<Date.now()>`. The rename must happen BEFORE any
 * subsequent atomic write can land, otherwise the corrupt file is lost.
 * The rename itself is best-effort: if it fails (e.g. the directory was
 * unlinked, the FS is read-only, the rename is racing with another
 * process), we log nothing and let the next writer overwrite the file
 * at the original path. This is the "do not silently overwrite" half of
 * the C-2 fix; the "thread the corrupt signal" half is the `ReadResult`
 * discriminated union.
 *
 * The function returns void; it is `try/catch`-swallowed internally so
 * callers don't have to repeat the boilerplate.
 */
function renameCorruptFile(p: string): void {
  const stamped = `${p}.corrupt.${Date.now()}`;
  try {
    renameSync(p, stamped);
  } catch {
    // Best-effort. The next atomic write will overwrite the corrupt file
    // at the original path; the user has lost the evidence, but at least
    // we tried. The GUI / CLI / server can surface the corrupt signal via
    // the ReadResult so the user gets SOME warning (e.g. "Goal state
    // file was corrupt; renamed to .goal-state.json.corrupt.<ts> if
    // possible").
  }
}

/**
 * v0.4.2 — list quarantined corrupt-file artifacts in `.opencode/`
 * (files renamed by `renameCorruptFile` / `renameCorruptChainFile`:
 * `.goal-state.json.corrupt.<ts>`, `.goal-handoff.json.corrupt.<ts>`,
 * `.goal-chain.json.corrupt.<ts>`). Newest first. Returns `[]` on any
 * error (missing dir, permissions) — this is a notice surface, never
 * a failure path. User surfaces (view/status/sidebar) use this so the
 * corrupt notice survives the quarantine rename: the live "corrupt"
 * ReadResult fires exactly once (the read that renames); every later
 * read sees `absent`, and only the artifact on disk proves anything
 * went wrong.
 */
export function listCorruptArtifacts(directory: string): string[] {
  try {
    return readdirSync(join(directory, ".opencode"))
      .filter((f) => /\.corrupt\.\d+$/.test(f))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/**
 * v0.4.1 (C-2) — read the goal state file with full failure-mode
 * discrimination. Returns `ReadResult<GoalState>`:
 *
 *   - `{ kind: "absent" }`   — file does not exist (legitimate "no state").
 *   - `{ kind: "corrupt"; reason: "parse" | "validate" | "oversize" | "io" }`
 *     — file exists but is corrupt. The reader has renamed it to
 *     `<original>.corrupt.<ts>` best-effort.
 *   - `{ kind: "ok"; value }` — file parsed and validated.
 *
 * Migration: this is the new tri-state reader. The old `readGoalState`
 * (returning `GoalState | null`) is preserved as a deprecated shim that
 * unwraps this ReadResult; the 51 internal `src/` callsites still work.
 * v0.4.2 will migrate the callsites to consume the `kind` directly.
 */
export function readGoalStateResult(directory: string): ReadResult<GoalState> {
  const p = goalStatePath(directory);
  if (!existsSync(p)) return { kind: "absent" };
  let size = 0;
  try {
    size = statSync(p).size;
    // A zero-byte state file is "no state" — semantically equivalent to
    // absent. We don't surface it as corrupt because the pre-v0.4.1
    // readGoalStateSafe treated it as "empty" with a dedicated summary,
    // and the existing GUI test suite pins that behavior. A zero-byte
    // file is typically a partial write that was cleaned up, not
    // attacker-planted data.
    if (size === 0) return { kind: "absent" };
    if (size > MAX_STATE_SIZE) {
      renameCorruptFile(p);
      return { kind: "corrupt", reason: "oversize", rawSize: size };
    }
    const parsed = JSON.parse(readFileSync(p, "utf-8"));
    if (!validateGoalState(parsed)) {
      renameCorruptFile(p);
      return { kind: "corrupt", reason: "validate", rawSize: size };
    }
    return { kind: "ok", value: parsed as GoalState };
  } catch (err) {
    // Two distinct sub-modes collapse here:
    //   - JSON.parse throws SyntaxError → "parse"
    //   - readFileSync / statSync throws (IO error other than ENOENT) → "io"
    // The reader can't tell them apart at this granularity without
    // re-trying, and the spec asks for a single "parse" vs "io" choice.
    // SyntaxError is the parse case; everything else is io.
    const reason: CorruptReason = err instanceof SyntaxError ? "parse" : "io";
    renameCorruptFile(p);
    return { kind: "corrupt", reason, rawSize: size };
  }
}

/**
 * @deprecated v0.4.1 — use `readGoalStateResult` (returns `ReadResult<GoalState>`).
 * This shim returns the `value` on `ok` and `null` on `absent` or `corrupt`,
 * which loses the corrupt/absent discrimination. Migrating the 51 internal
 * `src/` callsites to consume the discriminated `kind` is a v0.4.2 task
 * (REVIEW-V040-MULTI-ANGLE.md §2.2).
 */
export function readGoalState(directory: string): GoalState | null {
  const r = readGoalStateResult(directory);
  return r.kind === "ok" ? r.value : null;
}

/**
 * v0.4.1 (C-2) — read the goal state file WITHOUT running validateGoalState.
 * Same tri-state ReadResult as readGoalStateResult, but `corrupt.reason` is
 * "parse" or "io" (no "validate" since the validator is bypassed). Used by
 * `persistGoal` to read the current state's status / webhook for replacement
 * decisions without paying the validator cost twice (the validator runs
 * again on the next read in the typical read-decide-write turn).
 */
export function readGoalStateRawResult(directory: string): ReadResult<unknown> {
  const p = goalStatePath(directory);
  if (!existsSync(p)) return { kind: "absent" };
  let size = 0;
  try {
    size = statSync(p).size;
    if (size === 0) return { kind: "absent" };
    if (size > MAX_STATE_SIZE) {
      renameCorruptFile(p);
      return { kind: "corrupt", reason: "oversize", rawSize: size };
    }
    const parsed = JSON.parse(readFileSync(p, "utf-8"));
    return { kind: "ok", value: parsed };
  } catch (err) {
    const reason: CorruptReason = err instanceof SyntaxError ? "parse" : "io";
    renameCorruptFile(p);
    return { kind: "corrupt", reason, rawSize: size };
  }
}

/** Read raw state even if not schema-valid (for transitions that report status).
 *
 *  @deprecated v0.4.1 — use `readGoalStateRawResult` (returns `ReadResult<unknown>`).
 *  This shim returns the raw value on `ok` and `null` on `absent` or `corrupt`.
 *  The single internal caller (`persistGoal`) has been migrated to consume
 *  the new ReadResult directly so it doesn't have to do "is it null AND was
 *  it actually absent or corrupt?" discrimination by hand.
 */
export function readGoalStateRaw(directory: string): any | null {
  const r = readGoalStateRawResult(directory);
  return r.kind === "ok" ? r.value : null;
}

export function writeGoalStateAtomic(directory: string, state: GoalState): void {
  const p = goalStatePath(directory);
  const dir = dirname(p);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  // v0.4.2 (C-3/A-4) — random suffix prevents same-process same-ms tmp
  // collisions (two writers in one tick would share pid+timestamp and
  // clobber each other's tmp). Same pattern as templates.ts.
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  try {
    writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", "utf-8");
    renameSync(tmp, p);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

// ── Concurrency note ───────────────────────────────────────────────────────
// All primitives do read→mutate→write on the state file. Every write is
// atomic (temp file + rename), so the on-disk state is always internally
// consistent. Concurrent writers may lose each other's edits (last rename
// wins), which is a UX inconvenience — the next poll/sidebar refresh shows
// the current value and the user re-submits. No data corruption possible.
//
// The advisory file lock (v0.2.0–v0.3.0) was removed in v0.4.0 after 3
// security reviews found 5 TOCTOU bugs in the stale-break and ownership-
// verification logic. A filesystem-based mutex that detects crashed holders
// is inherently TOCTOU-prone on every platform. The atomic-write guarantees
// make the lock unnecessary for data integrity.
//
// See: specs/v0.4.0-roadmap.md for the full architecture rationale.

/** Typed reason for a `SetResult` failure. The dispatcher (src/command.ts)
 *  maps this to a `GoalCommandKind` for exit codes: "invalid-value" → exit 1
 *  (bad user input), "write-failed" → exit 3 (I/O error). The plain
 *  human-readable `error` string is preserved for the OpenCode agent path.
 *  Mirrors `TransitionReason` at the bottom of this file. (v0.4.1 — C-1 fix.) */
export type SetReason = "invalid-value" | "write-failed";

export type SetResult =
  | { ok: true; state: GoalState; replaced: string | null }
  | { ok: false; reason: SetReason; error: string };

/** Persist an already-parsed goal, reporting any active goal it replaced.
 *
 *  v0.4.0+ webhook preservation: when a new goal replaces an existing
 *  one, the previous state's `metadata.webhook` (if any) is copied
 *  forward into the new state. This is the spec-interpreted
 *  "configure once, applies to all goal cycles" contract — without
 *  it, the `set_goal` → `goal_webhook` → `clear_goal` → `set_goal`
 *  sequence would silently drop the user's webhook configuration
 *  on the second set, and the `null → active` webhook fire on
 *  subsequent sets would never deliver. The webhook is the ONE
 *  metadata field we preserve; everything else (steering, restart
 *  marker, etc.) is reset to defaults because it doesn't apply to
 *  a fresh goal.
 *
 *  SECURITY: route the preserved webhook through `sanitizeMetadata`
 *  before re-applying it. The existing state file is untrusted
 *  (planted handoff, attacker-written state, etc.); preserving a
 *  raw webhook object would carry forward URL injection or invalid
 *  `on` arrays. The sanitizer is the trust boundary.
 */
function persistGoal(directory: string, parsed: ParsedGoal, setBy: "user" | "template" | "chain", now: number): SetResult {
  {
    // v0.4.1 (C-2) — consume the new tri-state ReadResult. The
    // replacement-decision logic ("was there an active/paused goal whose
    // condition we should report as `replaced`?") only applies on `ok`.
    // On `absent` there's no existing state; on `corrupt` the reader has
    // already renamed the corrupt file, so the subsequent
    // writeGoalStateAtomic call below creates a fresh tmp + rename at
    // the original path. Either way, we proceed normally and the corrupt
    // file's evidence is preserved (renamed to .corrupt.<ts>) rather than
    // silently overwritten. Note the gate is the RAW reader's `ok`,
    // which means "parsed as JSON" — NOT "passed validateGoalState".
    // A parseable-but-schema-invalid file's webhook is still promoted
    // below. That is equivalent trust to the normal path (whoever can
    // write a schema-invalid state file can write a valid one with the
    // same webhook), so the raw gate adds no exposure; it only skips
    // unparseable files.
    const existingResult = readGoalStateRawResult(directory);
    const existing = existingResult.kind === "ok" ? existingResult.value as Record<string, unknown> : null;
    const replaced =
      existing && (existing.status === "active" || existing.status === "paused") &&
      typeof existing.condition === "string"
        ? (existing.condition as string)
        : null;
    const state = createGoalState(parsed, setBy, now);
    // Preserve webhook across replacement (see docstring above).
    if (existing && existing.metadata && (existing.metadata as Record<string, unknown>).webhook) {
      const sanitized = sanitizeMetadata(existing.metadata);
      if (sanitized.webhook) {
        state.metadata.webhook = sanitized.webhook;
      }
    }
    try {
      writeGoalStateAtomic(directory, state);
    } catch (err: any) {
      return { ok: false, reason: "write-failed", error: `Failed to write state: ${err?.message ?? err}` };
    }
    return { ok: true, replaced, state };
  }
}

/** Parse a raw `/goal set` string + persist. `seed` carries template defaults. */
export function setGoal(
  directory: string,
  rawArgs: string,
  opts: { setBy?: "user" | "template" | "chain"; seed?: GoalSeed; now?: number } = {}
): SetResult {
  const parsed = parseGoalInput(rawArgs, opts.seed);
  // parseGoalInput returns one error class — bad user input (empty
  // condition, condition too long, etc.). Map to "invalid-value" so
  // the dispatcher can pick the right CLI exit code (1, not 2).
  if ("error" in parsed) return { ok: false, reason: "invalid-value", error: parsed.error };
  return persistGoal(directory, parsed, opts.setBy ?? "user", opts.now ?? Date.now());
}

export interface GoalFields {
  condition: string;
  command?: string | null;
  verification?: Verification | null;
  maxTurns?: number;
  maxMinutes?: number;
  maxTokens?: number;
}

/**
 * Persist a goal from STRUCTURED fields (used by the conversational tools — the
 * agent supplies typed arguments, so there is nothing to parse). Still unwraps a
 * stray surrounding quote pair and validates length, sharing the same writer.
 */
export function setGoalFields(
  directory: string,
  fields: GoalFields,
  opts: { setBy?: "user" | "template" | "chain"; now?: number } = {}
): SetResult {
  const condition = unwrapQuotes((fields.condition ?? "").trim());
  if (!condition) return { ok: false, reason: "invalid-value", error: "Goal condition cannot be empty." };
  if (condition.length > MAX_CONDITION_LEN)
    return { ok: false, reason: "invalid-value", error: `Goal condition must be ${MAX_CONDITION_LEN} characters or fewer. Current length: ${condition.length}` };

  const constraints: GoalConstraints = {
    maxTurns: fields.maxTurns ?? DEFAULT_CONSTRAINTS.maxTurns,
    maxTimeMinutes: fields.maxMinutes ?? DEFAULT_CONSTRAINTS.maxTimeMinutes,
    maxTokens: fields.maxTokens ?? DEFAULT_CONSTRAINTS.maxTokens,
  };
  const custom =
    constraints.maxTurns !== DEFAULT_CONSTRAINTS.maxTurns ||
    constraints.maxTimeMinutes !== DEFAULT_CONSTRAINTS.maxTimeMinutes ||
    constraints.maxTokens !== DEFAULT_CONSTRAINTS.maxTokens;

  const parsed: ParsedGoal = { condition, command: fields.command ?? null, verification: fields.verification ?? null, constraints, custom };
  return persistGoal(directory, parsed, opts.setBy ?? "user", opts.now ?? Date.now());
}

export type TransitionAction = "clear" | "pause" | "resume";

/** Typed reason for a `TransitionResult` failure. The dispatcher
 *  (src/command.ts) maps this to a `GoalCommandKind` for exit codes;
 *  using a typed reason (rather than regex-greping the `error` string)
 *  is the only way to correctly distinguish "no active goal" (exit 2)
 *  from "write-failed" (exit 3). The `error` field stays the same
 *  human-readable string for backward compat with the OpenCode agent. */
export type TransitionReason =
  | "no-goal"
  | "terminal-state"
  | "already-in-state"
  | "write-failed";

export interface TransitionResult {
  ok: boolean;
  error?: string;
  status?: GoalStatus;
  turnsEvaluated?: number;
  message?: string;
  /** Set on every `ok: false` return. Additive and optional; existing
   *  callers that only inspect `error` are unaffected. */
  reason?: TransitionReason;
}

/** Atomically clear / pause / resume the current goal. */
export function transitionGoal(directory: string, action: TransitionAction, now: number = Date.now()): TransitionResult {
  {
    const state = readGoalState(directory);
    if (!state) {
      return { ok: false, error: `No active goal to ${action}.`, reason: "no-goal" };
    }

    if (action === "clear") {
      if (state.status === "cleared" || state.status === "achieved") {
        return { ok: false, error: "No active goal to clear.", reason: "no-goal" };
      }
      state.status = "cleared";
      state.completedAt = now;
    } else if (action === "pause") {
      if (state.status === "paused") {
        return { ok: false, error: "Goal is already paused.", reason: "already-in-state" };
      }
      if (state.status !== "active") {
        return { ok: false, error: "No active goal to pause.", reason: "no-goal" };
      }
      state.status = "paused";
      state.pausedAt = now;
    } else {
      if (state.status === "active") {
        return { ok: false, error: "Goal is already active.", reason: "already-in-state" };
      }
      if (state.status === "achieved") {
        return { ok: false, error: "This goal was already achieved. Set a new goal instead.", reason: "terminal-state" };
      }
      if (state.status === "cleared") {
        return { ok: false, error: "This goal was cleared. Set a new goal instead.", reason: "no-goal" };
      }
      state.status = "active";
      state.resumedAt = now;
    }

    try {
      writeGoalStateAtomic(directory, state);
    } catch (err: any) {
      return { ok: false, error: `Failed to write state: ${err?.message ?? err}`, reason: "write-failed" };
    }

    const messages: Record<TransitionAction, string> = {
      clear: `Goal cleared. ${state.turnsEvaluated} turns were evaluated before clearing.`,
      pause: "Goal paused. Resume with `/goal resume`.",
      resume: `Goal resumed. ${state.turnsEvaluated} turns completed so far.`,
    };
    return { ok: true, status: state.status, turnsEvaluated: state.turnsEvaluated, message: messages[action] };
  }
}

/**
 * Atomically toggle an active goal between paused and active. The read
 * (decide pause vs. resume) and the write happen inside a single
 * The read (decide pause vs. resume) and the write happen atomically
 * by reading and writing within the same operation. Closes the
 * read-outside-lock race that
 * `toggleGoal` had: a user mashing /goal-toggle would see only one toggle
 * for every two keypresses because two concurrent reads could both see
 * "active" and both decide "pause", with only the first write succeeding.
 *
 * This is the same bug class as the v0.2.0 server.ts `checkConstraints`
 * stale-snapshot advisory, but on the TUI side.
 *
 * Returns ok:true with the new status, or ok:false with a typed reason.
 */
export function atomicToggle(directory: string, now: number = Date.now()): { ok: true; newStatus: "active" | "paused"; message: string } | { ok: false; reason: "no-goal" | "terminal-state" | "write-failed"; error?: string } {
  {
    const state = readGoalState(directory);
    if (!state) return { ok: false, reason: "no-goal" };
    if (state.status !== "active" && state.status !== "paused") {
      return { ok: false, reason: "terminal-state", error: `Cannot toggle a ${state.status} goal.` };
    }

    const newStatus: "active" | "paused" = state.status === "active" ? "paused" : "active";
    const updated: GoalState = {
      ...state,
      status: newStatus,
      pausedAt: newStatus === "paused" ? now : state.pausedAt,
      resumedAt: newStatus === "active" ? now : state.resumedAt,
    };

    try {
      writeGoalStateAtomic(directory, updated);
    } catch (err: any) {
      return { ok: false, reason: "write-failed", error: `Failed to write state: ${err?.message ?? err}` };
    }

    return {
      ok: true,
      newStatus,
      message: newStatus === "paused"
        ? "Goal paused. Resume with `/goal resume`."
        : `Goal resumed. ${updated.turnsEvaluated} turns completed so far.`,
    };
  }
}

/** Human-readable status block for `/goal view`. Returns null when no active/paused goal. */
export function formatStatus(state: GoalState | null, now: number = Date.now()): string | null {
  if (!state || (state.status !== "active" && state.status !== "paused")) return null;
  const suffix = state.status === "paused" ? " (PAUSED)" : "";
  const startedAt = state.startedAt || state.createdAt || now;
  const elapsed = Math.round((now - startedAt) / 60000);
  // Sanitize user-controlled strings to prevent newline injection, bidi overrides,
  // and control chars from breaking the one-line-per-field display contract.
  const safeCondition = sanitizeForPrompt(state.condition);
  const safeReason = state.lastEvaluation?.reason ? sanitizeForPrompt(state.lastEvaluation.reason) : "none yet";
  const lines = [
    `Condition: ${safeCondition}`,
    `Status: ${state.status}${suffix}`,
    `Progress: ${state.turnsEvaluated}/${state.constraints.maxTurns} turns, ${elapsed}/${state.constraints.maxTimeMinutes} minutes`,
    `Last evaluation: ${safeReason}`,
  ];
  if (state.command) lines.push(`Verification: \`${state.command}\``);
  return lines.join("\n");
}

// ──────────────────────────────────────────────────────────────────────────
// DIALS: live edit primitives for the sidebar.
//
// All five primitives below follow the same shape:
//   1. Read the current state via readGoalState (the validated one).
//   2. Mutate the in-memory copy.
//   3. writeGoalStateAtomic — atomic + validated by the validator on next read.
//   4. Return a result object the JSX layer can surface in a toast.
//
// They NEVER re-implement I/O, NEVER re-validate, and NEVER touch the state
// file directly. The dashboard and the sidebar share these primitives, so
// they cannot drift apart (the v0.1.1 cycle-0 finding class).
//
// All primitives refuse to operate on a terminal-state goal (cleared or
// achieved) — those are by definition immutable history. The caller can
// set a new goal to replace them.
// ──────────────────────────────────────────────────────────────────────────

/** Result shape for the live-edit primitives. */
export type EditResult =
  | { ok: true; field: "turns" | "time" | "tokens" | "condition"; value: number | string; message: string }
  | { ok: false; reason: "no-goal" | "terminal-state" | "invalid-value" | "write-failed"; error?: string };

/** True if the state is mutable (active or paused). */
function isMutable(state: GoalState): boolean {
  return state.status === "active" || state.status === "paused";
}

/** True if the state is terminal (cleared or achieved) — by definition immutable. */
function isTerminal(state: GoalState): boolean {
  return state.status === "cleared" || state.status === "achieved";
}

/**
 * Set `maxTurns` to a new clamped value.
 * Clamps to CONSTRAINT_BOUNDS. Returns an invalid-value error if the input
 * is non-finite, out of range, or non-positive.
 */
export function editMaxTurns(directory: string, newMax: number, now: number = Date.now()): EditResult {
  if (!Number.isFinite(newMax) || newMax < CONSTRAINT_BOUNDS.minTurns || newMax > CONSTRAINT_BOUNDS.maxTurns) {
    return { ok: false, reason: "invalid-value", error: `maxTurns must be in [${CONSTRAINT_BOUNDS.minTurns}, ${CONSTRAINT_BOUNDS.maxTurns}].` };
  }
  {
    const state = readGoalState(directory);
    if (!state) return { ok: false, reason: "no-goal" };
    if (isTerminal(state)) return { ok: false, reason: "terminal-state", error: `Cannot edit a ${state.status} goal.` };
    // If the user lowers maxTurns BELOW the already-evaluated count, the
    // constraint is now satisfied (the loop would immediately trip on next
    // idle). We surface this in the message but allow it — the loop checks
    // `turnsEvaluated >= maxTurns`, so setting maxTurns to a value <=
    // turnsEvaluated is a valid way to "finish" a goal that has run its
    // full budget. The user might want this to mean "wrap it up now."
    const oldValue = state.constraints.maxTurns;
    state.constraints.maxTurns = newMax;
    try {
      writeGoalStateAtomic(directory, state);
    } catch (err: any) {
      return { ok: false, reason: "write-failed", error: `Failed to write state: ${err?.message ?? err}` };
    }
    return {
      ok: true,
      field: "turns",
      value: newMax,
      message: `Max turns: ${oldValue} → ${newMax}${newMax <= state.turnsEvaluated ? " (loop will trip on next idle)" : ""}`,
    };
  }
}

/** Set `maxTimeMinutes` to a new clamped value. Same shape as editMaxTurns. */
export function editMaxTime(directory: string, newMax: number, now: number = Date.now()): EditResult {
  if (!Number.isFinite(newMax) || newMax < CONSTRAINT_BOUNDS.minMinutes || newMax > CONSTRAINT_BOUNDS.maxMinutes) {
    return { ok: false, reason: "invalid-value", error: `maxTimeMinutes must be in [${CONSTRAINT_BOUNDS.minMinutes}, ${CONSTRAINT_BOUNDS.maxMinutes}].` };
  }
  {
    const state = readGoalState(directory);
    if (!state) return { ok: false, reason: "no-goal" };
    if (isTerminal(state)) return { ok: false, reason: "terminal-state", error: `Cannot edit a ${state.status} goal.` };
    const oldValue = state.constraints.maxTimeMinutes;
    state.constraints.maxTimeMinutes = newMax;
    try {
      writeGoalStateAtomic(directory, state);
    } catch (err: any) {
      return { ok: false, reason: "write-failed", error: `Failed to write state: ${err?.message ?? err}` };
    }
    return {
      ok: true,
      field: "time",
      value: newMax,
      message: `Max time: ${oldValue} → ${newMax} min`,
    };
  }
}

/** Set `maxTokens` to a new clamped value. Same shape as editMaxTurns. */
export function editMaxTokens(directory: string, newMax: number, now: number = Date.now()): EditResult {
  if (!Number.isFinite(newMax) || newMax < CONSTRAINT_BOUNDS.minTokens || newMax > CONSTRAINT_BOUNDS.maxTokens) {
    return { ok: false, reason: "invalid-value", error: `maxTokens must be in [${CONSTRAINT_BOUNDS.minTokens}, ${CONSTRAINT_BOUNDS.maxTokens}].` };
  }
  {
    const state = readGoalState(directory);
    if (!state) return { ok: false, reason: "no-goal" };
    if (isTerminal(state)) return { ok: false, reason: "terminal-state", error: `Cannot edit a ${state.status} goal.` };
    const oldValue = state.constraints.maxTokens;
    state.constraints.maxTokens = newMax;
    try {
      writeGoalStateAtomic(directory, state);
    } catch (err: any) {
      return { ok: false, reason: "write-failed", error: `Failed to write state: ${err?.message ?? err}` };
    }
    return {
      ok: true,
      field: "tokens",
      value: newMax,
      message: `Max tokens: ${oldValue} → ${newMax}`,
    };
  }
}

/**
 * Edit the goal condition in place. Preserves id, status, evaluations,
 * and constraints. The next auto-loop iteration will re-evaluate against
 * the new condition. The `metadata.conditionEditedAt` timestamp records
 * when the last edit happened (used by the sidebar's "condition edited
 * at HH:MM" readout and the auto-loop's "you changed the condition; the
 * next nudge reflects the new text" diagnostic).
 *
 * The new condition is sanitized (control chars dropped, length-clamped
 * to MAX_CONDITION_LEN) — same as the user-typed path in setGoal.
 *
 * If `expectedId` is provided, the edit refuses with reason "stale-snapshot"
 * when the on-disk state's id has changed since the caller captured it.
 * This is the optimistic-concurrency guard for the TUI's condition dial:
 * the dashboard reads state.id when the user opens the dial, then passes
 * it back here; a concurrent `/goal set` in another tab would change the
 * id, and the user's blind overwrite would be refused.
 */
export function editCondition(directory: string, newCondition: string, now: number = Date.now(), expectedId?: string): EditResult {
  if (typeof newCondition !== "string") {
    return { ok: false, reason: "invalid-value", error: "Condition must be a string." };
  }
  // Use sanitizeForPrompt: drops C0/C1 control chars, Unicode format
  // chars (zero-width, bidi overrides, line/para separators), collapses
  // whitespace. This is the same sanitizer applied at the prompt-injection
  // surface; using it here means what the user types = what gets stored =
  // what the auto-loop later interpolates. Single source of truth.
  let cleaned = sanitizeForPrompt(newCondition);
  if (cleaned.length === 0) return { ok: false, reason: "invalid-value", error: "Condition is empty after sanitization." };
  if (cleaned.length > MAX_CONDITION_LEN) cleaned = cleaned.slice(0, MAX_CONDITION_LEN);

  {
    const state = readGoalState(directory);
    if (!state) return { ok: false, reason: "no-goal" };
    if (isTerminal(state)) return { ok: false, reason: "terminal-state", error: `Cannot edit a ${state.status} goal.` };

    // Optimistic concurrency guard (FIX-10): if the caller captured a
    // specific state.id at dialog-open and the on-disk id has since
    // changed (e.g. another tab issued `/goal set`), refuse the write.
    // Without this, the user would silently overwrite a concurrent update.
    if (expectedId !== undefined && state.id !== expectedId) {
      return {
        ok: false,
        reason: "invalid-value",
        error: "The goal changed underneath you (another session may have set a new goal). Please review the current condition and re-submit.",
      };
    }

    const oldCondition = state.condition;
    if (oldCondition === cleaned) {
      return { ok: false, reason: "invalid-value", error: "New condition is identical to the current one." };
    }

    state.condition = cleaned;
    state.metadata.conditionEditedAt = now;
    try {
      writeGoalStateAtomic(directory, state);
    } catch (err: any) {
      return { ok: false, reason: "write-failed", error: `Failed to write state: ${err?.message ?? err}` };
    }
    return {
      ok: true,
      field: "condition",
      value: cleaned,
      message: `Condition updated (${oldCondition.length} → ${cleaned.length} chars).`,
    };
  }
}

/**
 * Strip C0/C1/Unicode format chars that some renderers treat as line
 * terminators or terminal-control escapes. Used to sanitize ANY string
 * that gets injected into the agent's prompt (continue-prompt,
 * compacting hook, etc.) — NOT just the sidebar's display surface.
 *
 * Drops:
 *   - C0 (0x00-0x1F) — including \0, \n, \r, \t, ESC, BEL
 *   - 0x7F (DEL)
 *   - C1 (0x80-0x9F) — including the 8-bit CSI/SGR range
 *   - U+200B-200F (zero-width space, ZWNJ, ZWJ, LRM, RLM)
 *   - U+2028 (LINE SEPARATOR)
 *   - U+2029 (PARAGRAPH SEPARATOR)
 *   - U+202A-202E (bidi overrides — can flip agent output RTL)
 *   - U+2060-2064 (invisible operators, word joiner)
 *   - U+FEFF (BOM / zero-width no-break space)
 *   - U+FFF9-FFFB (interlinear annotations)
 *
 * Preserves all printable Unicode (emoji, CJK, math, etc.) and ASCII
 * whitespace that survived the C0 strip (i.e. SP, since the C0 drop
 * only affects the literal \t \n \r which become single SP first).
 */
export function sanitizeForPrompt(s: string): string {
  if (typeof s !== "string" || s.length === 0) return "";
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code === 0x09 || code === 0x0a || code === 0x0d) { out += " "; continue; }
    if (code < 0x20 || code === 0x7f) continue;
    if (code >= 0x80 && code <= 0x9f) continue;
    if (code >= 0x200b && code <= 0x200f) continue; // zero-width chars
    if (code === 0x2028 || code === 0x2029) { out += " "; continue; } // line/para separator
    if (code >= 0x202a && code <= 0x202e) continue; // bidi overrides
    if (code >= 0x2060 && code <= 0x2064) continue; // invisible operators
    if (code === 0xfeff) continue; // BOM
    if (code >= 0xfff9 && code <= 0xfffb) continue; // interlinear annotations
    out += s[i];
  }
  return out.replace(/ {2,}/g, " ").trim();
}

/**
 * Validate + cap + content-sanitize an array of steering notes. (Security
 * review #1.) Drops mis-shaped entries, caps the count at MAX_STEERING_NOTES,
 * runs each note through `sanitizeForPrompt`, caps note length, and drops
 * notes that are empty after sanitization.
 */
export function sanitizeSteeringNotes(arr: unknown): Array<{ at: number; note: string }> {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((e): e is { at: number; note: string } => isPlainObject(e) && isFiniteNumber(e.at) && typeof e.note === "string")
    .slice(-MAX_STEERING_NOTES)
    .map((e) => ({ at: e.at, note: sanitizeForPrompt(e.note).slice(0, MAX_STEERING_LEN) }))
    .filter((e) => e.note.length > 0);
}

/**
 * Re-build a metadata object from a fixed ALLOWLIST of known fields, dropping
 * any unknown keys an attacker may have planted in a state or handoff file.
 * (Security review #2 / #15.) The `GoalState.metadata` type's field list IS the
 * allowlist; anything else is untrusted and discarded. Each kept field is
 * type-checked; steering notes are additionally shape-checked + sanitized.
 */
export function sanitizeMetadata(meta: unknown): GoalState["metadata"] {
  const m = isPlainObject(meta) ? meta : {};
  const out: GoalState["metadata"] = {
    setBy: m.setBy === "template" || m.setBy === "chain" ? m.setBy : "user",
  };
  if (typeof m.sessionId === "string") out.sessionId = m.sessionId;
  if (typeof m.agentName === "string") out.agentName = m.agentName;
  if (isFiniteNumber(m.conditionEditedAt)) out.conditionEditedAt = m.conditionEditedAt;
  if (typeof m.previousId === "string") out.previousId = m.previousId;
  if (isFiniteNumber(m.restartedAt)) out.restartedAt = m.restartedAt;
  if (isFiniteNumber(m.resumedFromHandoffAt)) out.resumedFromHandoffAt = m.resumedFromHandoffAt;
  if (typeof m.chainId === "string") out.chainId = m.chainId;           // v0.4.0
  if (isFiniteNumber(m.chainStep)) out.chainStep = m.chainStep;         // v0.4.0
  if (isFiniteNumber(m.chainTotal)) out.chainTotal = m.chainTotal;      // v0.4.0
  // v0.4.0+ webhook — validate shape before allowing
  if (isPlainObject(m.webhook) && typeof (m.webhook as Record<string,unknown>).url === "string" &&
      Array.isArray((m.webhook as Record<string,unknown>).on)) {
    out.webhook = {
      url: (m.webhook as Record<string,unknown>).url as string,
      on: ((m.webhook as Record<string,unknown>).on as string[]).filter(s => VALID_STATUSES.has(s as GoalStatus)) as GoalStatus[],
      allowLocal: (m.webhook as Record<string,unknown>).allowLocal === true,
    };
  }
  const steering = sanitizeSteeringNotes(m.steering);
  if (steering.length > 0) out.steering = steering;
  return out;
}

/**
 * Clear the current goal and re-set it with the same condition + same
 * constraints + fresh counters. The new goal gets a new id (a true
 * "restart"), but the user-visible text is identical.
 *
 * The handoff path: if a handoff file exists (.opencode/.goal-handoff.json),
 * this is a no-op (the restart would clobber the handoff). The user must
 * claim the handoff first or delete it.
 */
export function restartGoal(directory: string, now: number = Date.now()): { ok: true; newId: string; message: string } | { ok: false; reason: "no-goal" | "terminal-state" | "handoff-pending" | "write-failed"; error?: string } {
  {
    const state = readGoalState(directory);
    if (!state) return { ok: false, reason: "no-goal" };
    if (isTerminal(state)) return { ok: false, reason: "terminal-state", error: `Cannot restart a ${state.status} goal. Set a new one instead.` };

    // Refuse if a handoff is pending — the user almost certainly wants the
    // handoff to be claimed, not clobbered by a fresh restart.
    const handoffPath = join(directory, ".opencode", ".goal-handoff.json");
    if (existsSync(handoffPath)) {
      return { ok: false, reason: "handoff-pending", error: "A handoff is pending. Claim it first or delete the handoff file." };
    }

    // Build the new state from the old one. Preserves condition, constraints,
    // and (most) metadata. Resets: id, status, createdAt, startedAt, completedAt,
    // pausedAt, resumedAt, turnsEvaluated, tokensUsed, lastEvaluation,
    // evaluationHistory. The setBy stays the same (so a `/goal template foo`
    // goal stays a template goal).
    const newState: GoalState = {
      ...state,
      id: randomUUID(),
      status: "active",
      createdAt: now,
      startedAt: now,
      completedAt: null,
      pausedAt: null,
      resumedAt: null,
      turnsEvaluated: 0,
      tokensUsed: 0,
      lastEvaluation: null,
      evaluationHistory: [],
      // Allowlist metadata so a restart can't carry forward attacker-planted keys
      // from a claimed/planted state file. (Security review #15.)
      metadata: {
        ...sanitizeMetadata(state.metadata),
        restartedAt: now,
        previousId: state.id,
      },
    };

    try {
      writeGoalStateAtomic(directory, newState);
    } catch (err: any) {
      return { ok: false, reason: "write-failed", error: `Failed to write state: ${err?.message ?? err}` };
    }

    return {
      ok: true,
      newId: newState.id,
      message: `Goal restarted. New id: ${newState.id.slice(0, 8)}.`,
    };
  }
}

/**
 * Append a steering note. Steering notes are short hints the user wants
 * the agent to see on the next nudge — "focus on X next" / "try the new
 * library" / "stop doing Y". They are NOT the goal; the goal is unchanged.
 * The auto-loop in server.ts reads `metadata.steering` and injects the
 * latest note into the continue-prompt.
 *
 * Notes are append-only (with a cap) and timestamped. `MAX_STEERING_NOTES`
 * keeps the state file small.
 */
export const MAX_STEERING_NOTES = 20;
export const MAX_STEERING_LEN = 500;

export function appendSteering(directory: string, note: string, now: number = Date.now()): EditResult {
  if (typeof note !== "string") return { ok: false, reason: "invalid-value", error: "Steering note must be a string." };
  // Use the same sanitizer the auto-loop applies on injection — a steering
  // note that survives the primitive must also survive the prompt, and
  // must not carry format chars that the prompt surface would have stripped
  // anyway. This is the single source of truth for what a "safe" steering
  // note looks like.
  let cleaned = sanitizeForPrompt(note);
  if (cleaned.length === 0) return { ok: false, reason: "invalid-value", error: "Steering note is empty after sanitization." };
  if (cleaned.length > MAX_STEERING_LEN) cleaned = cleaned.slice(0, MAX_STEERING_LEN);

  {
    const state = readGoalState(directory);
    if (!state) return { ok: false, reason: "no-goal" };
    if (isTerminal(state)) return { ok: false, reason: "terminal-state", error: `Cannot steer a ${state.status} goal.` };

    const existing = Array.isArray(state.metadata.steering) ? state.metadata.steering : [];
    const next = [...existing, { at: now, note: cleaned }];
    let dropped = 0;
    if (next.length > MAX_STEERING_NOTES) {
      dropped = next.length - MAX_STEERING_NOTES;
      next.splice(0, dropped);
    }

    state.metadata.steering = next;
    try {
      writeGoalStateAtomic(directory, state);
    } catch (err: any) {
      return { ok: false, reason: "write-failed", error: `Failed to write state: ${err?.message ?? err}` };
    }
    return {
      ok: true,
      field: "condition", // reusing the field discriminator for the toast — closest semantic
      value: cleaned,
      message: `Steering note added (${next.length} total${dropped > 0 ? `; ${dropped} oldest dropped` : ""}).`,
    };
  }
}

/** Drop all steering notes. Returns the count cleared. */
export function clearSteering(directory: string, now: number = Date.now()): { ok: true; cleared: number; message: string } | { ok: false; reason: "no-goal" | "write-failed"; error?: string } {
  {
    const state = readGoalState(directory);
    if (!state) return { ok: false, reason: "no-goal" };
    const existing = Array.isArray(state.metadata.steering) ? state.metadata.steering : [];
    const cleared = existing.length;
    if (cleared > 0) {
      delete state.metadata.steering;
      try {
        writeGoalStateAtomic(directory, state);
      } catch (err: any) {
        return { ok: false, reason: "write-failed", error: `Failed to write state: ${err?.message ?? err}` };
      }
    }
    return { ok: true, cleared, message: cleared === 0 ? "No steering notes to clear." : `Cleared ${cleared} steering note${cleared === 1 ? "" : "s"}.` };
  }
}

// ── Handoff ───────────────────────────────────────────────────────────────
// A handoff is a serializable snapshot of the current goal written to
// `.opencode/.goal-handoff.json`. A future session can `claimHandoff` to
// resume the goal as if it had never been cleared — the claimer copies
// the handoff contents into a fresh `.goal-state.json` and deletes the
// handoff file. The handoff is single-shot (one claim, then deleted) to
// prevent the same handoff from being claimed by multiple sessions.

export const HANDOFF_FILE = ".opencode/.goal-handoff.json";

export interface HandoffPayload {
  /** ISO-8601 timestamp of when the handoff was created. */
  createdAt: string;
  /** The full goal state at handoff time. */
  state: GoalState;
  /** Free-form note the user attached at handoff time. */
  note?: string;
}

export function handoffPath(directory: string): string {
  return join(directory, ".opencode", ".goal-handoff.json");
}

/** Atomic handoff write (temp + rename), mirroring `writeGoalStateAtomic`.
 *  (Security review #6: a crash mid-write must not leave a corrupt handoff.) */
function writeHandoffAtomic(path: string, payload: HandoffPayload): void {
  mkdirSync(dirname(path), { recursive: true });
  // v0.4.2 (C-3/A-4) — random suffix; see writeGoalStateAtomic.
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  try {
    writeFileSync(tmp, JSON.stringify(payload, null, 2) + "\n", "utf-8");
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

/**
 * Write the current goal state to the handoff file. The handoff is
 * single-slot — if a handoff already exists, this is a no-op (return
 * `handoff-exists`). The user must claim or delete the prior handoff first.
 */
export function createHandoff(directory: string, note?: string, now: number = Date.now()): { ok: true; path: string; message: string } | { ok: false; reason: "no-goal" | "terminal-state" | "handoff-exists" | "write-failed"; error?: string } {
  // Cap + sanitize the note (Security review #10): a multi-MB or ANSI-laden
  // note would bloat the handoff and could land control chars in a later read.
  const safeNote = typeof note === "string" ? sanitizeForPrompt(note).slice(0, MAX_STEERING_LEN) : "";

  {
    const state = readGoalState(directory);
    if (!state) return { ok: false, reason: "no-goal" };
    if (isTerminal(state)) return { ok: false, reason: "terminal-state", error: `Cannot handoff a ${state.status} goal.` };

    const path = handoffPath(directory);
    if (existsSync(path)) return { ok: false, reason: "handoff-exists", error: "A handoff is already pending. Claim it first or delete the file." };

    const payload: HandoffPayload = {
      createdAt: new Date(now).toISOString(),
      state: { ...state, evaluationHistory: state.evaluationHistory.slice(-10) }, // cap history at 10
      note: safeNote || undefined,
    };

    try {
      writeHandoffAtomic(path, payload);
    } catch (err: any) {
      return { ok: false, reason: "write-failed", error: `Failed to write handoff: ${err?.message ?? err}` };
    }

    return { ok: true, path, message: `Handoff written. A future session can claim it with \`/goal claim\`.` };
  }
}

/**
 * Read the handoff file (if present) and return its payload. Does NOT
 * delete the file. The caller is `claimHandoff` (which also deletes) or
 * the sidebar (which just displays the handoff status).
 *
 * SECURITY: caps the read size at 256KB. A hand-crafted handoff could
 * be arbitrarily large (the JSON parser is happy to allocate 1GB+).
 * The cap is conservative — the largest legitimate handoff is
 * ~18KB (4000-char condition + 10×1000-char evals + 20×500-char steering).
 *
 * v0.4.1 (C-2) — this reader is now split into a tri-state `ReadResult`
 * version (`readHandoffResult`) and a deprecated shim that returns
 * `HandoffPayload | null`. The shim is the only consumer of the new
 * function; the 2 internal callers (`claimHandoff`, the sidebar logic)
 * continue to work unchanged. The tri-state version is the surface
 * the v0.4.2 callsite migration will switch to. See
 * REVIEW-V040-MULTI-ANGLE.md §2.2.
 */
export const MAX_HANDOFF_SIZE = 256 * 1024;

/**
 * v0.4.1 (C-2) — read the handoff file with full failure-mode
 * discrimination. Returns `ReadResult<HandoffPayload>`:
 *
 *   - `{ kind: "absent" }`   — file does not exist (no handoff pending).
 *   - `{ kind: "corrupt"; reason: "parse" | "validate" | "oversize" | "io" }`
 *     — file exists but is corrupt. The reader has renamed it to
 *     `<original>.corrupt.<ts>` best-effort.
 *   - `{ kind: "ok"; value }` — file parsed, `createdAt` is a string,
 *     and the embedded `state` passes `validateGoalState`.
 *
 * Handoff-specific validation: the JSON must be an object with a string
 * `createdAt` and a `state` field that survives `validateGoalState`. A
 * missing-`createdAt` failure is reported as `reason: "validate"` (the
 * shape check), not "parse".
 */
export function readHandoffResult(directory: string): ReadResult<HandoffPayload> {
  const path = handoffPath(directory);
  if (!existsSync(path)) return { kind: "absent" };
  let size = 0;
  try {
    size = statSync(path).size;
    if (size === 0) return { kind: "absent" };
    if (size > MAX_HANDOFF_SIZE) {
      renameCorruptFile(path);
      return { kind: "corrupt", reason: "oversize", rawSize: size };
    }
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      renameCorruptFile(path);
      return { kind: "corrupt", reason: "validate", rawSize: size };
    }
    if (typeof parsed.createdAt !== "string") {
      renameCorruptFile(path);
      return { kind: "corrupt", reason: "validate", rawSize: size };
    }
    if (!parsed.state || !validateGoalState(parsed.state)) {
      renameCorruptFile(path);
      return { kind: "corrupt", reason: "validate", rawSize: size };
    }
    return { kind: "ok", value: parsed as HandoffPayload };
  } catch (err) {
    const reason: CorruptReason = err instanceof SyntaxError ? "parse" : "io";
    renameCorruptFile(path);
    return { kind: "corrupt", reason, rawSize: size };
  }
}

/**
 * @deprecated v0.4.1 — use `readHandoffResult` (returns
 * `ReadResult<HandoffPayload>`). This shim returns the `value` on `ok`
 * and `null` on `absent` or `corrupt`. The 2 internal callers
 * (`claimHandoff`, `sidebar-logic.buildSidebarView`) continue to work
 * unchanged. v0.4.2 will migrate the callsites to consume the `kind`.
 */
export function readHandoff(directory: string): HandoffPayload | null {
  const r = readHandoffResult(directory);
  return r.kind === "ok" ? r.value : null;
}

/**
 * Claim the handoff: read the payload, write it to the goal-state file,
 * delete the handoff. If no handoff exists, no-op. If a current goal
 * exists, refuse (the user must clear or finish it first).
 */
export function claimHandoff(directory: string, now: number = Date.now()): { ok: true; state: GoalState; message: string } | { ok: false; reason: "no-handoff" | "current-goal" | "write-failed"; error?: string } {
  {
    const current = readGoalState(directory);
    if (current && isMutable(current)) {
      return { ok: false, reason: "current-goal", error: "A goal is already active. Clear it before claiming the handoff." };
    }
    const payload = readHandoff(directory);
    if (!payload) return { ok: false, reason: "no-handoff" };

    // Resume the handoff: copy the state into the goal-state file. The
    // resumed state keeps the same id (it IS the same goal) and keeps the
    // status if it was active/paused; we re-set status to active so the
    // auto-loop picks it up.
    //
    // SECURITY: route the condition and each steering note through
    // sanitizeForPrompt before persisting. The handoff is the trust
    // boundary — a planted handoff can have arbitrary content in these
    // fields, and the next time the agent gets a nudge or the session
    // compacts, the malicious text becomes the prompt-injection payload.
    // The validateGoalState call in readHandoff already enforced shape
    // and array-length caps; the sanitizeForPrompt pass here enforces
    // content safety.
    // SECURITY: sanitize every user-controlled string field from the handoff.
    // The handoff is the trust boundary — a planted handoff can embed bidi
    // overrides, control chars, or prompt-injection markers in condition,
    // command, evaluation reasons, and notes. sanitizeForPrompt strips C0/C1,
    // Unicode format chars, bidi overrides, and invisible operators.
    const safeEvalHistory = (payload.state.evaluationHistory || []).map((e) => ({
      ...e,
      reason: sanitizeForPrompt(e.reason ?? ""),
    }));
    const resumed: GoalState = {
      ...payload.state,
      condition: sanitizeForPrompt(payload.state.condition),
      command: typeof payload.state.command === "string" ? sanitizeForPrompt(payload.state.command) : payload.state.command,
      lastEvaluation: payload.state.lastEvaluation
        ? { ...payload.state.lastEvaluation, reason: sanitizeForPrompt(payload.state.lastEvaluation.reason ?? "") }
        : null,
      evaluationHistory: safeEvalHistory,
      status: "active",
      resumedAt: now,
      completedAt: null,
      // Rebuild metadata from the allowlist — drops any attacker-planted keys; the
      // steering array is shape-checked + content-sanitized inside. (Review #2.)
      metadata: {
        ...sanitizeMetadata(payload.state.metadata),
        resumedFromHandoffAt: now,
      },
    };

    try {
      writeGoalStateAtomic(directory, resumed);
    } catch (err: any) {
      return { ok: false, reason: "write-failed", error: `Failed to write state: ${err?.message ?? err}` };
    }

    // Delete the handoff file. If this fails, log it but don't roll back —
    // the state file is the source of truth and a stale handoff will just
    // be a no-op the next time the user tries to claim.
    const path = handoffPath(directory);
    try { unlinkSync(path); } catch { /* swallow */ }

    return {
      ok: true,
      state: resumed,
      message: `Handoff claimed. Resumed goal id ${resumed.id.slice(0, 8)} (${payload.note ? `note: ${payload.note}` : "no note"}).`,
    };
  }
}

