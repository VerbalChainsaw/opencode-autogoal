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

// ── Completion protocol ─────────────────────────────────────────────────────
// Line-ANCHORED so the agent merely *talking about* the protocol cannot trip it.
export const COMPLETE_RE = /^\s*GOAL_COMPLETE\s*:\s*(.*)$/i;
export const BLOCKED_RE = /^\s*GOAL_BLOCKED\s*:\s*(.*)$/i;

/** Returns the marker's trailing text if a line in `text` declares it, else null. */
export function detectMarker(text: string, re: RegExp): string | null {
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(re);
    if (m) return (m[1] ?? "").trim();
  }
  return null;
}

// ── Validation ──────────────────────────────────────────────────────────────
export function validateGoalState(state: any): state is GoalState {
  if (typeof state !== "object" || state === null) return false;
  return (
    typeof state.version === "number" &&
    typeof state.id === "string" &&
    typeof state.condition === "string" &&
    ["active", "paused", "achieved", "cleared"].includes(state.status) &&
    typeof state.createdAt === "number" &&
    typeof state.constraints === "object"
  );
}

// ── Argument parsing ────────────────────────────────────────────────────────
export function parseConstraints(text: string, defaults: GoalConstraints): GoalConstraints {
  const c = { ...defaults };
  let m: RegExpMatchArray | null;
  if ((m = text.match(/stop after (\d+) turns?/i)) || (m = text.match(/--turns\s+(\d+)/i)))
    c.maxTurns = parseInt(m[1], 10);
  if ((m = text.match(/stop after (\d+) minutes?/i)) || (m = text.match(/--time\s+(\d+)/i)))
    c.maxTimeMinutes = parseInt(m[1], 10);
  if ((m = text.match(/stop after (\d+)(k)? tokens?/i))) {
    const val = parseInt(m[1], 10);
    c.maxTokens = m[2] ? val * 1000 : val;
  }
  return c;
}

export function parseCommand(text: string): string | null {
  const m = text.match(/--command\s+"([^"]+)"/) || text.match(/--command\s+'([^']+)'/);
  return m ? m[1] : null;
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
