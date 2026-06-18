/**
 * Goal Chains — multi-step goal sequencer.
 *
 * A chain is a sequence of steps stored in `.opencode/.goal-chain.json`.
 * Each step has its own condition, optional command, and optional constraint
 * overrides. When the current step is achieved, the chain auto-advances to
 * the next step.
 *
 * The chain file coexists with `.opencode/.goal-state.json` — the state file
 * always holds the *currently active* step. The chain file tracks which step
 * is current and which have been completed.
 *
 * Data integrity: all writes use temp-file + rename (atomic). The state file
 * is always internally consistent regardless of concurrent access.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  readGoalState,
  writeGoalStateAtomic,
  createGoalState,
  parseGoalInput,
  type GoalState,
  type GoalConstraints,
  type Verification,
  type GoalStatus,
  type ReadResult,
  type CorruptReason,
  DEFAULT_CONSTRAINTS,
  MAX_CONDITION_LEN,
} from "./goal-state.js";

export const CHAIN_FILE = ".opencode/.goal-chain.json";

// Re-export the v0.4.1 (C-2) tri-state reader types so callers of this
// module don't have to reach into goal-state.js just to type a
// readGoalChainResult result.
export type { ReadResult, CorruptReason } from "./goal-state.js";

export interface GoalChainStep {
  condition: string;
  command?: string | null;
  /** v0.4.0+ — structured verification. Takes priority over `command`. */
  verification?: Verification | null;
  maxTurns?: number;
  maxMinutes?: number;
  /** v0.7.x — optional Desktop action metadata. */
  skills?: string[];
  model?: GoalPinnedModel | string;
  category?: string;
  tone?: string;
  elevation?: string;
}

export interface GoalPinnedModel {
  providerID: string;
  modelID: string;
}

export interface ChainMasterBudget {
  maxTurns?: number;
  maxMinutes?: number;
  turnsUsed: number;
  minutesUsed: number;
}

/**
 * v0.4.0+ chain-level webhook config. The chain OWNS this — every step's
 * `state.metadata.webhook` is derived from `chain.webhook` on
 * create/advance/skip/reset, so a webhook configured at chain start fires
 * on EVERY step's achievement, not just step 0. (v0.4.0 patch, D6.)
 *
 * Semantics:
 *   - `chain.webhook` is the single source of truth for the chain's
 *     notification behavior. If the user later calls `goal_webhook` on a
 *     step within the chain, the server routes the change to
 *     `setChainWebhook`, which updates the chain file (and re-projects
 *     the webhook to the current step's metadata).
 *   - A pre-existing step's `metadata.webhook` (set via
 *     `set_goal` + `goal_webhook` BEFORE the chain started) is
 *     promoted to the chain's webhook at `createGoalChain` time, so
 *     the "configure once, fires on all steps" contract holds across
 *     the user's existing workflow.
 *   - This shape mirrors `GoalState["metadata"]["webhook"]` exactly, so
 *     `fireWebhook` (in server.ts) reads it through the same allowlist
 *     validation as the per-step path.
 */
export interface ChainWebhook {
  url: string;
  on: GoalStatus[];
  allowLocal?: boolean;
}

export interface GoalChain {
  version: 1;
  id: string;
  steps: GoalChainStep[];
  current: number;          // 0-based index into steps; -1 = not started
  cycles: number;           // how many times the chain has looped (onComplete="loop")
  maxCycles: number;        // max loops (0 = unlimited)
  onComplete: "stop" | "loop";
  metadata: {
    createdAt: number;
    setBy: "user" | "template";
    sessionId?: string;
    /** Agent name to use as fallback when a chain step has no model. */
    agentName?: string;
  };
  /**
   * v0.4.0+ — chain-level webhook. When set, every step created or
   * advanced under this chain inherits the webhook into its
   * `metadata.webhook` so `fireWebhook` (in server.ts) finds it on
   * every step's achievement, not just step 0.
   */
  webhook?: ChainWebhook;
  /** v0.7.x — optional chain-level cap across all steps. Step caps still
   *  apply independently; the active step receives the tighter remaining cap. */
  master?: ChainMasterBudget;
}

export const MAX_CHAIN_SIZE = 256 * 1024;  // same cap as state files
export const MAX_CHAIN_STEPS = 50;

// ── I/O ──────────────────────────────────────────────────────────────────────

export function goalChainPath(directory: string): string {
  return join(directory, CHAIN_FILE);
}

/**
 * v0.4.1 (C-2) — read the chain file with full failure-mode
 * discrimination. Returns `ReadResult<GoalChain>`:
 *
 *   - `{ kind: "absent" }`   — file does not exist (no active chain).
 *   - `{ kind: "corrupt"; reason: "parse" | "validate" | "oversize" | "io" }`
 *     — file exists but is corrupt. The reader has renamed it to
 *     `<original>.corrupt.<ts>` best-effort.
 *   - `{ kind: "ok"; value }` — file parsed and validated by
 *     `validateGoalChain` (which includes the per-step `verification`
 *     shape check added in the E-2 fix).
 *
 * The corrupt rename is the v0.4.1 C-2 fix: a corrupt `.goal-chain.json`
 * is renamed before the next chain mutation can land, so the user has
 * a forensic recovery path. Previously, a corrupt chain file was
 * silently treated as "no chain" and the next
 * `createGoalChain`/`advanceGoalChain` overwrote it, destroying
 * recoverable evidence (mid-chain progress, webhook config, etc.).
 *
 * Migration: this is the new tri-state reader. The old `readGoalChain`
 * (returning `GoalChain | null`) is preserved as a deprecated shim that
 * unwraps this ReadResult; the 4 internal `src/` callsites still work.
 * v0.4.2 will migrate the callsites to consume the `kind` directly.
 */
export function readGoalChainResult(directory: string): ReadResult<GoalChain> {
  const p = goalChainPath(directory);
  if (!existsSync(p)) return { kind: "absent" };
  let size = 0;
  try {
    size = statSync(p).size;
    // A zero-byte chain file is "no chain" — semantically equivalent to
    // absent. Mirrors the readGoalStateResult size-0 handling. A
    // zero-byte file is typically a partial write that was cleaned up,
    // not attacker-planted data.
    if (size === 0) return { kind: "absent" };
    if (size > MAX_CHAIN_SIZE) {
      renameCorruptChainFile(p);
      return { kind: "corrupt", reason: "oversize", rawSize: size };
    }
    const parsed = JSON.parse(readFileSync(p, "utf-8"));
    if (!validateGoalChain(parsed)) {
      renameCorruptChainFile(p);
      return { kind: "corrupt", reason: "validate", rawSize: size };
    }
    return { kind: "ok", value: parsed as GoalChain };
  } catch (err) {
    const reason: CorruptReason = err instanceof SyntaxError ? "parse" : "io";
    renameCorruptChainFile(p);
    return { kind: "corrupt", reason, rawSize: size };
  }
}

/**
 * v0.4.1 (C-2) — local best-effort rename of a corrupt chain file to
 * `<original>.corrupt.<Date.now()>`. Same shape as the goal-state
 * version (`renameCorruptFile` in goal-state.ts); duplicated locally so
 * the chain module owns its own file-rename primitive and the goal-state
 * version doesn't have to know about chain files. A shared helper is the
 * cleaner long-term answer but is out of scope for the C-2 fix.
 */
function renameCorruptChainFile(p: string): void {
  const stamped = `${p}.corrupt.${Date.now()}`;
  try {
    renameSync(p, stamped);
  } catch {
    // Best-effort. The next atomic write will overwrite the corrupt
    // file at the original path; the user has lost the evidence, but
    // at least we tried.
  }
}

/**
 * @deprecated v0.4.1 — use `readGoalChainResult` (returns
 * `ReadResult<GoalChain>`). This shim returns the `value` on `ok` and
 * `null` on `absent` or `corrupt`. The 4 internal `src/` callsites
 * (`advanceGoalChain`, `resetGoalChain`, `setChainWebhook`, the chain
 * test suite) continue to work unchanged. v0.4.2 will migrate the
 * callsites to consume the `kind`.
 */
export function readGoalChain(directory: string): GoalChain | null {
  const r = readGoalChainResult(directory);
  return r.kind === "ok" ? r.value : null;
}

export function writeGoalChainAtomic(directory: string, chain: GoalChain): void {
  const p = goalChainPath(directory);
  const dir = dirname(p);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  // v0.4.2 (C-3/A-4) — random suffix; see goal-state.ts writeGoalStateAtomic.
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  try {
    writeFileSync(tmp, JSON.stringify(chain, null, 2) + "\n", "utf-8");
    renameSync(tmp, p);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

// ── Validation ───────────────────────────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

const VALID_CHAIN_STATUSES = new Set<GoalStatus>(["active", "paused", "achieved", "cleared"]);
const VALID_VERIFICATION_TYPES = new Set(["shell", "http", "file", "marker"]);
const MAX_STEP_SKILLS = 8;
const MAX_STEP_SKILL_LEN = 80;
const MAX_STEP_MODEL_FIELD_LEN = 160;

/**
 * v0.4.1 (E-2) — shape check for a step's `verification` field. Mirrors
 * goal-state.ts:223-233 so a chain file with a malformed verification
 * (e.g. `{ type: "BANANA" }`, or `{ type: "shell" }` missing the
 * required `command`) cannot smuggle bad data past the validator.
 * Returns true ONLY when the object is a valid Verification shape;
 * returns false for any deviation. The check is duplicated from
 * goal-state.ts by design (E-2 fix scope: "do not refactor the
 * existing validation"); a shared helper is the cleaner long-term
 * answer but is out of scope for this patch.
 */
function isValidVerificationShape(v: unknown): boolean {
  if (!isPlainObject(v)) return false;
  if (typeof v.type !== "string") return false;
  if (!VALID_VERIFICATION_TYPES.has(v.type)) return false;
  if (v.type === "shell" && typeof v.command !== "string") return false;
  if (v.type === "http" && typeof v.url !== "string") return false;
  if (v.type === "file" && typeof v.path !== "string") return false;
  return true;
}

/**
 * v0.4.1 (E-2) — return a human-readable reason a verification shape
 * is invalid, or null if it is valid. Used by `createGoalChain` so
 * the error message can identify the offending step index and the
 * specific problem (rather than a bare "invalid verification").
 */
function verificationShapeError(v: unknown): string | null {
  if (!isPlainObject(v)) return "verification must be an object";
  if (typeof v.type !== "string") return "verification.type must be a string";
  if (!VALID_VERIFICATION_TYPES.has(v.type)) {
    return `verification.type must be one of shell|http|file|marker (got "${String(v.type)}")`;
  }
  if (v.type === "shell" && typeof v.command !== "string") return "verification.type=shell requires a string 'command'";
  if (v.type === "http" && typeof v.url !== "string") return "verification.type=http requires a string 'url'";
  if (v.type === "file" && typeof v.path !== "string") return "verification.type=file requires a string 'path'";
  return null;
}

function stepSkillsError(v: unknown): string | null {
  if (!Array.isArray(v)) return "skills must be an array";
  if (v.length > MAX_STEP_SKILLS) return `skills cannot include more than ${MAX_STEP_SKILLS} entries`;
  const seen = new Set<string>();
  for (const item of v) {
    if (typeof item !== "string") return "skills entries must be strings";
    const skill = item.trim();
    if (!skill) return "skills entries cannot be empty";
    if (skill.length > MAX_STEP_SKILL_LEN) return `skills entries must be ${MAX_STEP_SKILL_LEN} chars or fewer`;
    if (seen.has(skill)) return "skills entries must be unique";
    seen.add(skill);
  }
  return null;
}

function pinnedModelError(v: unknown): string | null {
  if (typeof v === "string") {
    if (!v.trim()) return "model cannot be empty";
    if (v.length > MAX_STEP_MODEL_FIELD_LEN) return `model must be ${MAX_STEP_MODEL_FIELD_LEN} chars or fewer`;
    return null;
  }
  if (!isPlainObject(v)) return "model must be a string or { providerID, modelID }";
  if (typeof v.providerID !== "string" || !v.providerID.trim()) return "model.providerID must be a non-empty string";
  if (typeof v.modelID !== "string" || !v.modelID.trim()) return "model.modelID must be a non-empty string";
  if (v.providerID.length > MAX_STEP_MODEL_FIELD_LEN || v.modelID.length > MAX_STEP_MODEL_FIELD_LEN) {
    return `model.providerID and model.modelID must be ${MAX_STEP_MODEL_FIELD_LEN} chars or fewer`;
  }
  return null;
}

function stepStringMetadataError(step: Record<string, unknown>, field: "category" | "tone" | "elevation"): string | null {
  const value = step[field];
  if (value === undefined) return null;
  if (typeof value !== "string") return `${field} must be a string`;
  if (value.length > 80) return `${field} must be 80 chars or fewer`;
  return null;
}

function stepMetadataError(step: Record<string, unknown>): string | null {
  if (step.skills !== undefined) {
    const reason = stepSkillsError(step.skills);
    if (reason !== null) return reason;
  }
  if (step.model !== undefined) {
    const reason = pinnedModelError(step.model);
    if (reason !== null) return reason;
  }
  return (
    stepStringMetadataError(step, "category") ??
    stepStringMetadataError(step, "tone") ??
    stepStringMetadataError(step, "elevation")
  );
}

/**
 * Validate + sanitize a raw object (typically loaded from `.goal-chain.json`
 * or supplied via the CLI) into a `ChainWebhook`. Returns `null` if the
 * object is missing required fields or has any malformed piece. URL must
 * start with http:// or https://, `on` must contain at least one valid
 * `GoalStatus`, `allowLocal` must be a boolean if present. Mirrors the
 * shape validation in `sanitizeMetadata` for the per-step webhook.
 */
export function sanitizeChainWebhook(raw: unknown): ChainWebhook | null {
  if (!isPlainObject(raw)) return null;
  const url = raw.url;
  if (typeof url !== "string" || !/^https?:\/\//.test(url)) return null;
  // v0.4.1 (E-5) — strip CR/LF from the URL so a hand-crafted chain
  // file cannot inject header fields or split the request. The regex
  // already rejects non-http schemes; this is defense-in-depth against
  // CRLF injection in the URL hostname/path/query string.
  const cleanUrl = url.replace(/[\r\n]/g, "");
  const on = raw.on;
  if (!Array.isArray(on)) return null;
  const filteredOn = on.filter((s): s is GoalStatus => typeof s === "string" && VALID_CHAIN_STATUSES.has(s as GoalStatus));
  if (filteredOn.length === 0) return null;
  const allowLocal = raw.allowLocal === true;
  return { url: cleanUrl, on: filteredOn, allowLocal };
}

export function validateGoalChain(chain: unknown): chain is GoalChain {
  if (!isPlainObject(chain)) return false;
  if (chain.version !== 1) return false;
  if (typeof chain.id !== "string" || chain.id.length === 0) return false;
  if (!Array.isArray(chain.steps) || chain.steps.length === 0) return false;
  if (chain.steps.length > MAX_CHAIN_STEPS) return false;
  for (const step of chain.steps) {
    if (!isPlainObject(step)) return false;
    if (typeof step.condition !== "string" || step.condition.trim().length === 0) return false;
    if (step.command !== undefined && step.command !== null && typeof step.command !== "string") return false;
    if (step.maxTurns !== undefined && (!isFiniteNumber(step.maxTurns) || step.maxTurns < 1)) return false;
    if (step.maxMinutes !== undefined && (!isFiniteNumber(step.maxMinutes) || step.maxMinutes < 1)) return false;
    // v0.4.1 (E-2) — per-step `verification` shape check. Mirrors
    // goal-state.ts:223-233 so a chain file with a malformed
    // `verification` (e.g. { type: "BANANA" }) cannot smuggle bad
    // data past the validator and silently kill the chain mid-way
    // when advanceGoalChain builds the next state. See
    // REVIEW-V040-MULTI-ANGLE.md §2.4. Duplicated rather than
    // refactored to a shared helper per the E-2 fix scope rules
    // ("do not refactor the existing validation"); a shared
    // `isValidVerification(v)` would be a cleaner follow-up.
    if (step.verification !== undefined && step.verification !== null) {
      if (!isValidVerificationShape(step.verification)) return false;
    }
    if (stepMetadataError(step) !== null) return false;
  }
  if (!isFiniteNumber(chain.current) || chain.current < -1 || chain.current >= chain.steps.length) return false;
  if (!isFiniteNumber(chain.cycles) || chain.cycles < 0) return false;
  if (!isFiniteNumber(chain.maxCycles) || chain.maxCycles < 0) return false;
  if (chain.onComplete !== "stop" && chain.onComplete !== "loop") return false;
  if (!isPlainObject(chain.metadata)) return false;
  if (!isFiniteNumber(chain.metadata.createdAt)) return false;
  if (chain.metadata.setBy !== "user" && chain.metadata.setBy !== "template") return false;
  // v0.4.0+ — chain-level webhook is optional. If present, route through
  // the sanitizer; if it doesn't survive, reject the entire chain (a
  // malformed webhook on disk is the same trust class as a malformed
  // step — silent acceptance would be worse than rejection).
  if (chain.webhook !== undefined) {
    if (sanitizeChainWebhook(chain.webhook) === null) return false;
  }
  if (chain.master !== undefined) {
    if (!isPlainObject(chain.master)) return false;
    if (chain.master.maxTurns !== undefined && (!isFiniteNumber(chain.master.maxTurns) || chain.master.maxTurns < 1)) return false;
    if (chain.master.maxMinutes !== undefined && (!isFiniteNumber(chain.master.maxMinutes) || chain.master.maxMinutes < 1)) return false;
    if (!isFiniteNumber(chain.master.turnsUsed) || chain.master.turnsUsed < 0) return false;
    if (!isFiniteNumber(chain.master.minutesUsed) || chain.master.minutesUsed < 0) return false;
  }
  return true;
}

// ── Construction ─────────────────────────────────────────────────────────────

export type CreateChainResult =
  | { ok: true; chain: GoalChain; state: GoalState }
  | { ok: false; error: string };

export interface CreateChainOpts {
  setBy?: "user" | "template";
  sessionId?: string;
  maxCycles?: number;
  onComplete?: "stop" | "loop";
  now?: number;
  /**
   * v0.4.0+ — chain-level webhook config. Two valid input shapes:
   *   1. A pre-sanitized `ChainWebhook` object (the type already validates).
   *   2. `"from-state"` — pull the webhook from the current goal state's
   *      `metadata.webhook`. Use this to transparently promote a
   *      pre-chain `set_goal` + `goal_webhook` config into the chain.
   * Omit to create a chain with no webhook.
   */
  webhook?: ChainWebhook | "from-state";
  master?: { maxTurns?: number; maxMinutes?: number };
  /** Agent name to use as fallback when a chain step has no model. */
  agentName?: string;
}

function normalizeMasterBudget(raw: CreateChainOpts["master"]): ChainMasterBudget | null {
  if (!raw) return null;
  if (raw.maxTurns !== undefined && (!isFiniteNumber(raw.maxTurns) || raw.maxTurns < 1)) return null;
  if (raw.maxMinutes !== undefined && (!isFiniteNumber(raw.maxMinutes) || raw.maxMinutes < 1)) return null;
  if (raw.maxTurns === undefined && raw.maxMinutes === undefined) return null;
  return {
    ...(raw.maxTurns !== undefined ? { maxTurns: Math.round(raw.maxTurns) } : {}),
    ...(raw.maxMinutes !== undefined ? { maxMinutes: Math.round(raw.maxMinutes) } : {}),
    turnsUsed: 0,
    minutesUsed: 0,
  };
}

function constraintsForStep(step: GoalChainStep, chain: Pick<GoalChain, "master"> | null): GoalConstraints {
  const turns = step.maxTurns ?? DEFAULT_CONSTRAINTS.maxTurns;
  const minutes = step.maxMinutes ?? DEFAULT_CONSTRAINTS.maxTimeMinutes;
  const remainingTurns = chain?.master?.maxTurns === undefined
    ? turns
    : Math.max(1, chain.master.maxTurns - chain.master.turnsUsed);
  const remainingMinutes = chain?.master?.maxMinutes === undefined
    ? minutes
    : Math.max(1, chain.master.maxMinutes - chain.master.minutesUsed);
  return {
    maxTurns: Math.min(turns, remainingTurns),
    maxTimeMinutes: Math.min(minutes, remainingMinutes),
    maxTokens: DEFAULT_CONSTRAINTS.maxTokens,
  };
}

function recordMasterUsage(chain: GoalChain, state: GoalState, now: number): void {
  if (!chain.master) return;
  chain.master.turnsUsed += Math.max(0, Math.round(state.turnsEvaluated));
  chain.master.minutesUsed += Math.max(0, Math.floor((now - state.startedAt) / 60_000));
}

function masterBudgetExhausted(chain: GoalChain): boolean {
  if (!chain.master) return false;
  if (chain.master.maxTurns !== undefined && chain.master.turnsUsed >= chain.master.maxTurns) return true;
  if (chain.master.maxMinutes !== undefined && chain.master.minutesUsed >= chain.master.maxMinutes) return true;
  return false;
}

/**
 * Apply `chain.webhook` to a freshly-built step state. Idempotent — a
 * chain with no webhook leaves `state.metadata.webhook` unset, which is
 * the same shape as the pre-D6 baseline. All four chain step-creation
 * paths (create + advance + skip + reset) route through this helper.
 */
function applyChainWebhookToState(state: GoalState, chain: GoalChain): void {
  if (chain.webhook) {
    state.metadata.webhook = {
      url: chain.webhook.url,
      on: [...chain.webhook.on],
      allowLocal: chain.webhook.allowLocal === true,
    };
  } else {
    delete state.metadata.webhook;
  }
}

/** Create a new chain and set step 0 as the active goal. */
export function createGoalChain(
  directory: string,
  steps: GoalChainStep[],
  opts: CreateChainOpts = {},
): CreateChainResult {
  const now = opts.now ?? Date.now();

  if (!Array.isArray(steps) || steps.length === 0) {
    return { ok: false, error: "Chain must have at least one step." };
  }
  if (steps.length > MAX_CHAIN_STEPS) {
    return { ok: false, error: `Chain cannot have more than ${MAX_CHAIN_STEPS} steps.` };
  }
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]!;
    if (!s.condition || s.condition.trim().length === 0) {
      return { ok: false, error: `Step ${i + 1} condition cannot be empty.` };
    }
    if (s.condition.length > MAX_CONDITION_LEN) {
      return { ok: false, error: `Step ${i + 1} condition must be ${MAX_CONDITION_LEN} chars or fewer.` };
    }
    // v0.4.1 (E-2) — reject malformed `verification` at chain-create
    // time so the validator runs BEFORE the chain file is written.
    // `s.verification` may be undefined/null (unset is allowed) or a
    // valid Verification shape. See REVIEW-V040-MULTI-ANGLE.md §2.4.
    if (s.verification !== undefined && s.verification !== null) {
      const reason = verificationShapeError(s.verification);
      if (reason !== null) {
        return { ok: false, error: `Step ${i + 1} ${reason}.` };
      }
    }
    const metadataReason = stepMetadataError(s as unknown as Record<string, unknown>);
    if (metadataReason !== null) {
      return { ok: false, error: `Step ${i + 1} ${metadataReason}.` };
    }
  }
  const master = normalizeMasterBudget(opts.master);
  if (opts.master && !master) {
    return { ok: false, error: "Chain master budget must include positive maxTurns or maxMinutes." };
  }

  // Resolve the chain's webhook. Three modes:
  //   1. `opts.webhook` is a ChainWebhook object → use it directly.
  //   2. `opts.webhook === "from-state"` → pull from the current state.
  //   3. `opts.webhook` omitted → no webhook on the chain.
  // We sanitize everything — even a caller-supplied ChainWebhook — so a
  // poisoned `chain.json` cannot smuggle a malformed webhook past the
  // validator.
  let resolvedWebhook: ChainWebhook | null = null;
  if (opts.webhook && typeof opts.webhook === "object") {
    resolvedWebhook = sanitizeChainWebhook(opts.webhook);
  } else if (opts.webhook === "from-state") {
    const existing = readGoalState(directory);
    const existingWh = existing?.metadata?.webhook;
    if (existingWh) {
      resolvedWebhook = sanitizeChainWebhook(existingWh);
    }
  }

  // Promote the current state's agent name to the chain if the caller
  // didn't provide one. This mirrors the `webhook: "from-state"` pattern:
  // when a chain is started from a CLI command (no `ctx.agent` available),
  // the chain picks up the agent from whatever goal was already active
  // (set via set_goal tool which captures ctx.agent).
  let resolvedAgentName = opts.agentName ?? undefined;
  if (!resolvedAgentName) {
    const existingGoal = readGoalState(directory);
    const existingAgent = existingGoal?.metadata?.agentName;
    if (typeof existingAgent === "string" && existingAgent.trim()) {
      resolvedAgentName = existingAgent.trim();
    }
  }

  const chain: GoalChain = {
    version: 1,
    id: randomUUID(),
    steps: steps.map((s) => ({ ...s, condition: s.condition.trim() })),
    current: 0,
    cycles: 0,
    maxCycles: opts.maxCycles ?? 10,
    onComplete: opts.onComplete ?? "stop",
    metadata: {
      createdAt: now,
      setBy: opts.setBy ?? "user",
      sessionId: opts.sessionId,
      ...(resolvedAgentName ? { agentName: resolvedAgentName } : {}),
    },
  };
  if (resolvedWebhook) chain.webhook = resolvedWebhook;
  if (master) chain.master = master;

  // Build step 0 as the active goal
  const step0 = steps[0]!;
  const constraints = constraintsForStep(step0, chain);

  const state = createGoalState(
    { condition: step0.condition, command: step0.command ?? null, verification: step0.verification ?? null, constraints, custom: false, agentName: chain.metadata.agentName },
    "chain",
    now,
  );
  state.metadata.chainId = chain.id;
  state.metadata.chainStep = 0;
  state.metadata.chainTotal = steps.length;
  // v0.4.0 D6 fix: project the chain's webhook onto the step state so
  // the auto-loop's `fireWebhook` finds it on this step's achievement.
  applyChainWebhookToState(state, chain);

  try {
    writeGoalChainAtomic(directory, chain);
  } catch (err: any) {
    return { ok: false, error: `Failed to write chain: ${err?.message ?? err}` };
  }

  try {
    writeGoalStateAtomic(directory, state);
  } catch (err: any) {
    return { ok: false, error: `Failed to write state: ${err?.message ?? err}` };
  }

  return {
    ok: true,
    chain,
    state,
  };
}

// ── Chain advancement ────────────────────────────────────────────────────────

export type AdvanceChainResult =
  | { ok: false; error: string }
  | { ok: true; message: string; completed?: boolean; state?: GoalState };

/**
 * Advance the chain to the next step and set it as the active goal.
 * Must only be called after the current step was achieved.
 * Checks chainId consistency to prevent advancing a chain whose goal was
 * manually overridden.
 */
export function advanceGoalChain(directory: string, now: number = Date.now()): AdvanceChainResult {
  const chain = readGoalChain(directory);
  if (!chain) return { ok: false, error: "No active chain." };

  const state = readGoalState(directory);
  // Guard: the current goal must belong to this chain
  if (!state || state.metadata.chainId !== chain.id) {
    return { ok: false, error: "Chain interrupted — goal was manually overridden. Use 'chain reset' to restart." };
  }
  recordMasterUsage(chain, state, now);

  const next = chain.current + 1;

  // Check if we're at the last step
  if (next >= chain.steps.length) {
    if (chain.onComplete === "loop") {
      if (chain.maxCycles > 0 && chain.cycles + 1 >= chain.maxCycles) {
        return { ok: true, completed: true, message: `Chain completed after ${chain.cycles + 1} cycles.` };
      }
      // Loop: go back to step 0
      chain.cycles += 1;
      chain.current = 0;
    } else {
      return { ok: true, completed: true, message: "All chain steps completed." };
    }
  } else {
    chain.current = next;
  }
  if (masterBudgetExhausted(chain)) {
    try {
      writeGoalChainAtomic(directory, chain);
    } catch (err: any) {
      return { ok: false, error: `Failed to write chain: ${err?.message ?? err}` };
    }
    return { ok: true, completed: true, message: "Chain master budget reached." };
  }

  const step = chain.steps[chain.current]!;
  const constraints = constraintsForStep(step, chain);

  const newState = createGoalState(
    { condition: step.condition, command: step.command ?? null, verification: step.verification ?? null, constraints, custom: false, agentName: chain.metadata.agentName },
    "chain",
    now,
  );
  newState.metadata.chainId = chain.id;
  newState.metadata.chainStep = chain.current;
  newState.metadata.chainTotal = chain.steps.length;
  // v0.4.0 D6 fix: re-project the chain's webhook onto the new step's
  // state. Without this, `advanceGoalChain` silently drops the webhook
  // on every step beyond step 0, and `fireWebhook` in server.ts finds
  // `state.metadata.webhook` undefined on those steps' achievements.
  applyChainWebhookToState(newState, chain);

  try {
    writeGoalChainAtomic(directory, chain);
  } catch (err: any) {
    return { ok: false, error: `Failed to write chain: ${err?.message ?? err}` };
  }

  try {
    writeGoalStateAtomic(directory, newState);
  } catch (err: any) {
    return { ok: false, error: `Failed to write state: ${err?.message ?? err}` };
  }

  return {
    ok: true,
    state: newState,
    message: `Step ${chain.current + 1}/${chain.steps.length}: ${step.condition.slice(0, 60)}`,
  };
}

/**
 * Skip the current step without requiring achievement. Advances to the
 * next step immediately. Useful when a step is blocked or unnecessary.
 */
export function skipGoalChainStep(directory: string, now: number = Date.now()): AdvanceChainResult {
  // Reuse the same logic — advancement doesn't check achievement status
  return advanceGoalChain(directory, now);
}

/** Reset the chain to step 0 with fresh counters. */
export function resetGoalChain(directory: string, now: number = Date.now()): AdvanceChainResult {
  const chain = readGoalChain(directory);
  if (!chain) return { ok: false, error: "No active chain." };

  chain.current = 0;
  chain.cycles = 0;
  if (chain.master) {
    chain.master.turnsUsed = 0;
    chain.master.minutesUsed = 0;
  }

  const step = chain.steps[0]!;
  const constraints = constraintsForStep(step, chain);

  const newState = createGoalState(
    { condition: step.condition, command: step.command ?? null, verification: step.verification ?? null, constraints, custom: false, agentName: chain.metadata.agentName },
    "chain",
    now,
  );
  newState.metadata.chainId = chain.id;
  newState.metadata.chainStep = 0;
  newState.metadata.chainTotal = chain.steps.length;
  // v0.4.0 D6 fix: a reset sends the chain back to step 0; project the
  // chain's webhook onto the rebuilt step state for consistency with
  // createGoalChain and advanceGoalChain.
  applyChainWebhookToState(newState, chain);

  try {
    writeGoalChainAtomic(directory, chain);
  } catch (err: any) {
    return { ok: false, error: `Failed to write chain: ${err?.message ?? err}` };
  }

  try {
    writeGoalStateAtomic(directory, newState);
  } catch (err: any) {
    return { ok: false, error: `Failed to write state: ${err?.message ?? err}` };
  }

  return {
    ok: true,
    state: newState,
    message: `Chain reset to step 1/${chain.steps.length}.`,
  };
}

// ── Chain webhook update ─────────────────────────────────────────────────────

export interface SetChainWebhookResult {
  ok: boolean;
  error?: string;
  /** The new chain-level webhook (or null if cleared). */
  webhook?: ChainWebhook | null;
  /** The new state with `metadata.webhook` re-projected from the chain. */
  state?: GoalState | null;
}

/**
 * Update the chain's webhook config and re-project the new value onto
 * the current step's state metadata. Used by the server's `goal_webhook`
 * tool when the active goal is part of a chain — the chain is the
 * authoritative owner of the webhook once a chain is active, so per-step
 * `goal_webhook` calls land here instead of mutating the state in place.
 *
 * Pass `webhook === null` to clear. Validation: URL must start with
 * http:// or https://, `on` must contain at least one valid `GoalStatus`,
 * `allowLocal` must be a boolean if present. Invalid input is rejected
 * with `{ ok: false, error }` and no writes happen.
 */
export function setChainWebhook(
  directory: string,
  webhook: ChainWebhook | null,
  now: number = Date.now(),
): SetChainWebhookResult {
  const chain = readGoalChain(directory);
  if (!chain) return { ok: false, error: "No active chain." };

  // Reject invalid input. `null` is the explicit "clear" signal.
  if (webhook !== null) {
    const sanitized = sanitizeChainWebhook(webhook);
    if (sanitized === null) {
      return { ok: false, error: "Invalid webhook shape: url must be http(s), 'on' must list at least one valid status." };
    }
    chain.webhook = sanitized;
  } else {
    delete chain.webhook;
  }

  // Re-project onto the current step's state so the next fireWebhook
  // call sees the new value, AND so the on-disk state file is
  // self-consistent with the chain file (a debugger reading either
  // file alone gets the same answer).
  const state = readGoalState(directory);
  if (!state) {
    // No state — this is unusual (a chain should always have a
    // corresponding state), but the chain write is still meaningful.
    try { writeGoalChainAtomic(directory, chain); }
    catch (err: any) { return { ok: false, error: `Failed to write chain: ${err?.message ?? err}` }; }
    return { ok: true, webhook: chain.webhook ?? null, state: null };
  }
  applyChainWebhookToState(state, chain);

  try {
    writeGoalChainAtomic(directory, chain);
  } catch (err: any) {
    return { ok: false, error: `Failed to write chain: ${err?.message ?? err}` };
  }
  try {
    writeGoalStateAtomic(directory, state);
  } catch (err: any) {
    return { ok: false, error: `Failed to write state: ${err?.message ?? err}` };
  }

  return { ok: true, webhook: chain.webhook ?? null, state };
}

// ── Step add / reorder (v0.7.x — GUI sub-goals) ───────────────────────────────

/**
 * Append a sub-goal step. If a chain already exists, the step is pushed onto
 * the end. If there is NO chain but there IS a current goal, the goal is
 * promoted into a 2-step chain (the current goal becomes step 0/active, the
 * new condition step 1) so the user can break a single goal into ordered
 * sub-goals from the GUI. Refuses past MAX_CHAIN_STEPS.
 */
export function addChainStep(
  directory: string,
  condition: string,
  command: string | null = null,
  now: number = Date.now(),
): { ok: boolean; error?: string } {
  const cond = (condition ?? "").trim();
  if (!cond) return { ok: false, error: "Step condition cannot be empty." };
  if (cond.length > MAX_CONDITION_LEN) return { ok: false, error: `Step must be ${MAX_CONDITION_LEN} chars or fewer.` };

  const chain = readGoalChain(directory);
  if (chain) {
    if (chain.steps.length >= MAX_CHAIN_STEPS) return { ok: false, error: `Chain cannot exceed ${MAX_CHAIN_STEPS} steps.` };
    chain.steps.push({ condition: cond, command });
    const state = readGoalState(directory);
    if (state?.metadata.chainId === chain.id) {
      state.metadata.chainTotal = chain.steps.length;
    }
    try {
      writeGoalChainAtomic(directory, chain);
    } catch (err: any) {
      return { ok: false, error: `Failed to write chain: ${err?.message ?? err}` };
    }
    if (state?.metadata.chainId === chain.id) {
      try {
        writeGoalStateAtomic(directory, state);
      } catch (err: any) {
        return { ok: false, error: `Failed to write state: ${err?.message ?? err}` };
      }
    }
    return { ok: true };
  }

  // No chain yet — promote the current goal into a 2-step chain.
  const state = readGoalState(directory);
  if (!state) return { ok: false, error: "No goal to add a sub-goal to. Set a goal first." };
  const res = createGoalChain(
    directory,
    [
      {
        condition: state.condition,
        command: state.command ?? null,
        verification: state.verification ?? null,
        maxTurns: state.constraints.maxTurns,
        maxMinutes: state.constraints.maxTimeMinutes,
      },
      { condition: cond, command },
    ],
    { now },
  );
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}

/**
 * Reorder a chain step from `from` to `to` (both 0-based). Keeps `current`
 * pointing at the same logical step so the active sub-goal doesn't change
 * identity under a reorder. Bounds-checked; a no-op move returns ok.
 */
export function reorderChainStep(
  directory: string,
  from: number,
  to: number,
): { ok: boolean; error?: string } {
  const chain = readGoalChain(directory);
  if (!chain) return { ok: false, error: "No active chain." };
  const n = chain.steps.length;
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || from >= n || to < 0 || to >= n) {
    return { ok: false, error: "Step index out of range." };
  }
  if (from === to) return { ok: true };

  const [moved] = chain.steps.splice(from, 1);
  chain.steps.splice(to, 0, moved!);

  // Keep `current` anchored to the same logical step across the move.
  if (chain.current === from) chain.current = to;
  else if (from < chain.current && to >= chain.current) chain.current -= 1;
  else if (from > chain.current && to <= chain.current) chain.current += 1;

  const state = readGoalState(directory);
  if (state?.metadata.chainId === chain.id) {
    state.metadata.chainStep = chain.current;
    state.metadata.chainTotal = chain.steps.length;
  }

  try {
    writeGoalChainAtomic(directory, chain);
  } catch (err: any) {
    return { ok: false, error: `Failed to write chain: ${err?.message ?? err}` };
  }
  if (state?.metadata.chainId === chain.id) {
    try {
      writeGoalStateAtomic(directory, state);
    } catch (err: any) {
      return { ok: false, error: `Failed to write state: ${err?.message ?? err}` };
    }
  }
  return { ok: true };
}

/**
 * Remove a pending chain step by 0-based index. The active and completed
 * portion of a live chain is immutable here; deleting the current step would
 * leave the in-flight assistant turn pointing at a missing goal. Use clear/stop
 * for the active turn, then rebuild or reset the chain if earlier steps need
 * structural edits.
 */
export function removeChainStep(
  directory: string,
  index: number,
): { ok: boolean; error?: string } {
  const chain = readGoalChain(directory);
  if (!chain) return { ok: false, error: "No active chain." };
  const n = chain.steps.length;
  if (!Number.isInteger(index) || index < 0 || index >= n) {
    return { ok: false, error: "Step index out of range." };
  }
  if (n <= 1) return { ok: false, error: "Cannot remove the only chain step." };
  if (chain.current >= 0 && index <= chain.current) {
    return { ok: false, error: "Only pending future steps can be removed from a live chain. Stop or reset before editing the active step." };
  }

  chain.steps.splice(index, 1);

  const state = readGoalState(directory);
  if (state?.metadata.chainId === chain.id) {
    state.metadata.chainTotal = chain.steps.length;
  }

  try {
    writeGoalChainAtomic(directory, chain);
  } catch (err: any) {
    return { ok: false, error: `Failed to write chain: ${err?.message ?? err}` };
  }
  if (state?.metadata.chainId === chain.id) {
    try {
      writeGoalStateAtomic(directory, state);
    } catch (err: any) {
      return { ok: false, error: `Failed to write state: ${err?.message ?? err}` };
    }
  }
  return { ok: true };
}
