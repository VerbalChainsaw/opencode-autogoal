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
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
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

export interface GoalState {
  version: number;
  id: string;
  condition: string;
  command?: string | null;
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
  const lines = text.split(/\r?\n/);
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
  if (state.lastEvaluation !== null && state.lastEvaluation !== undefined && !isPlainObject(state.lastEvaluation)) {
    return false;
  }
  if (state.evaluationHistory !== undefined && !Array.isArray(state.evaluationHistory)) return false;
  // Constraints must have all 3 numeric fields. Empty `{}` previously passed
  // the loose `typeof === "object"` check and caused silent infinite loops
  // because `state.constraints.maxTurns` was `undefined`.
  if (!isPlainObject(state.constraints)) return false;
  if (!isFiniteNumber(state.constraints.maxTurns) || state.constraints.maxTurns < CONSTRAINT_BOUNDS.minTurns) return false;
  if (!isFiniteNumber(state.constraints.maxTimeMinutes) || state.constraints.maxTimeMinutes < CONSTRAINT_BOUNDS.minMinutes) return false;
  if (!isFiniteNumber(state.constraints.maxTokens) || state.constraints.maxTokens < CONSTRAINT_BOUNDS.minTokens) return false;
  // metadata: loose — `setBy` is the only field read at runtime; tolerate any
  // object shape so future fields don't break older state files.
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
  constraints: GoalConstraints;
  custom: boolean;
}

export interface GoalSeed {
  constraints?: Partial<GoalConstraints>;
  command?: string | null;
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

export function readGoalState(directory: string): GoalState | null {
  try {
    const p = goalStatePath(directory);
    if (!existsSync(p)) return null;
    const parsed = JSON.parse(readFileSync(p, "utf-8"));
    return validateGoalState(parsed) ? (parsed as GoalState) : null;
  } catch {
    return null;
  }
}

/** Read raw state even if not schema-valid (for transitions that report status). */
export function readGoalStateRaw(directory: string): any | null {
  try {
    const p = goalStatePath(directory);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
}

export function writeGoalStateAtomic(directory: string, state: GoalState): void {
  const p = goalStatePath(directory);
  const dir = dirname(p);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
  try {
    writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", "utf-8");
    renameSync(tmp, p);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

export interface SetResult {
  ok: boolean;
  error?: string;
  replaced?: string | null;
  state?: GoalState;
}

/** Persist an already-parsed goal, reporting any active goal it replaced. */
function persistGoal(directory: string, parsed: ParsedGoal, setBy: "user" | "template" | "chain", now: number): SetResult {
  const existing = readGoalStateRaw(directory);
  const replaced =
    existing && (existing.status === "active" || existing.status === "paused") ? (existing.condition as string) : null;
  const state = createGoalState(parsed, setBy, now);
  try {
    writeGoalStateAtomic(directory, state);
  } catch (err: any) {
    return { ok: false, error: `Failed to write state: ${err?.message ?? err}` };
  }
  return { ok: true, replaced, state };
}

/** Parse a raw `/goal set` string + persist. `seed` carries template defaults. */
export function setGoal(
  directory: string,
  rawArgs: string,
  opts: { setBy?: "user" | "template" | "chain"; seed?: GoalSeed; now?: number } = {}
): SetResult {
  const parsed = parseGoalInput(rawArgs, opts.seed);
  if ("error" in parsed) return { ok: false, error: parsed.error };
  return persistGoal(directory, parsed, opts.setBy ?? "user", opts.now ?? Date.now());
}

export interface GoalFields {
  condition: string;
  command?: string | null;
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
  if (!condition) return { ok: false, error: "Goal condition cannot be empty." };
  if (condition.length > MAX_CONDITION_LEN)
    return { ok: false, error: `Goal condition must be ${MAX_CONDITION_LEN} characters or fewer. Current length: ${condition.length}` };

  const constraints: GoalConstraints = {
    maxTurns: fields.maxTurns ?? DEFAULT_CONSTRAINTS.maxTurns,
    maxTimeMinutes: fields.maxMinutes ?? DEFAULT_CONSTRAINTS.maxTimeMinutes,
    maxTokens: fields.maxTokens ?? DEFAULT_CONSTRAINTS.maxTokens,
  };
  const custom =
    constraints.maxTurns !== DEFAULT_CONSTRAINTS.maxTurns ||
    constraints.maxTimeMinutes !== DEFAULT_CONSTRAINTS.maxTimeMinutes ||
    constraints.maxTokens !== DEFAULT_CONSTRAINTS.maxTokens;

  const parsed: ParsedGoal = { condition, command: fields.command ?? null, constraints, custom };
  return persistGoal(directory, parsed, opts.setBy ?? "user", opts.now ?? Date.now());
}

export type TransitionAction = "clear" | "pause" | "resume";

export interface TransitionResult {
  ok: boolean;
  error?: string;
  status?: GoalStatus;
  turnsEvaluated?: number;
  message?: string;
}

/** Atomically clear / pause / resume the current goal. */
export function transitionGoal(directory: string, action: TransitionAction, now: number = Date.now()): TransitionResult {
  const state = readGoalState(directory);
  if (!state) return { ok: false, error: `No active goal to ${action}.` };

  if (action === "clear") {
    if (state.status === "cleared" || state.status === "achieved") return { ok: false, error: "No active goal to clear." };
    state.status = "cleared";
    state.completedAt = now;
  } else if (action === "pause") {
    if (state.status === "paused") return { ok: false, error: "Goal is already paused." };
    if (state.status !== "active") return { ok: false, error: "No active goal to pause." };
    state.status = "paused";
    state.pausedAt = now;
  } else {
    if (state.status === "active") return { ok: false, error: "Goal is already active." };
    if (state.status === "achieved") return { ok: false, error: "This goal was already achieved. Set a new goal instead." };
    if (state.status === "cleared") return { ok: false, error: "This goal was cleared. Set a new goal instead." };
    state.status = "active";
    state.resumedAt = now;
  }

  try {
    writeGoalStateAtomic(directory, state);
  } catch (err: any) {
    return { ok: false, error: `Failed to write state: ${err?.message ?? err}` };
  }

  const messages: Record<TransitionAction, string> = {
    clear: `Goal cleared. ${state.turnsEvaluated} turns were evaluated before clearing.`,
    pause: "Goal paused. Resume with `/goal resume`.",
    resume: `Goal resumed. ${state.turnsEvaluated} turns completed so far.`,
  };
  return { ok: true, status: state.status, turnsEvaluated: state.turnsEvaluated, message: messages[action] };
}

/** Human-readable status block for `/goal view`. Returns null when no active/paused goal. */
export function formatStatus(state: GoalState | null, now: number = Date.now()): string | null {
  if (!state || (state.status !== "active" && state.status !== "paused")) return null;
  const suffix = state.status === "paused" ? " (PAUSED)" : "";
  const startedAt = state.startedAt || state.createdAt || now;
  const elapsed = Math.round((now - startedAt) / 60000);
  const lines = [
    `Condition: ${state.condition}`,
    `Status: ${state.status}${suffix}`,
    `Progress: ${state.turnsEvaluated}/${state.constraints.maxTurns} turns, ${elapsed}/${state.constraints.maxTimeMinutes} minutes`,
    `Last evaluation: ${state.lastEvaluation?.reason ?? "none yet"}`,
  ];
  if (state.command) lines.push(`Verification: \`${state.command}\``);
  return lines.join("\n");
}
