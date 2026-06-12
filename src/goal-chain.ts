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
  DEFAULT_CONSTRAINTS,
  MAX_CONDITION_LEN,
} from "./goal-state.js";

export const CHAIN_FILE = ".opencode/.goal-chain.json";

export interface GoalChainStep {
  condition: string;
  command?: string | null;
  maxTurns?: number;
  maxMinutes?: number;
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
  };
}

export const MAX_CHAIN_SIZE = 256 * 1024;  // same cap as state files
export const MAX_CHAIN_STEPS = 50;

// ── I/O ──────────────────────────────────────────────────────────────────────

export function goalChainPath(directory: string): string {
  return join(directory, CHAIN_FILE);
}

export function readGoalChain(directory: string): GoalChain | null {
  try {
    const p = goalChainPath(directory);
    if (!existsSync(p)) return null;
    if (statSync(p).size > MAX_CHAIN_SIZE) return null;
    const parsed = JSON.parse(readFileSync(p, "utf-8"));
    if (!validateGoalChain(parsed)) return null;
    return parsed as GoalChain;
  } catch {
    return null;
  }
}

export function writeGoalChainAtomic(directory: string, chain: GoalChain): void {
  const p = goalChainPath(directory);
  const dir = dirname(p);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
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
  }
  if (!isFiniteNumber(chain.current) || chain.current < -1 || chain.current >= chain.steps.length) return false;
  if (!isFiniteNumber(chain.cycles) || chain.cycles < 0) return false;
  if (!isFiniteNumber(chain.maxCycles) || chain.maxCycles < 0) return false;
  if (chain.onComplete !== "stop" && chain.onComplete !== "loop") return false;
  if (!isPlainObject(chain.metadata)) return false;
  if (!isFiniteNumber(chain.metadata.createdAt)) return false;
  if (chain.metadata.setBy !== "user" && chain.metadata.setBy !== "template") return false;
  return true;
}

// ── Construction ─────────────────────────────────────────────────────────────

export interface CreateChainResult {
  ok: boolean;
  error?: string;
  chain?: GoalChain;
  state?: GoalState;
}

/** Create a new chain and set step 0 as the active goal. */
export function createGoalChain(
  directory: string,
  steps: GoalChainStep[],
  opts: { setBy?: "user" | "template"; sessionId?: string; maxCycles?: number; onComplete?: "stop" | "loop"; now?: number } = {},
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
    },
  };

  // Build step 0 as the active goal
  const step0 = steps[0]!;
  const constraints: GoalConstraints = {
    maxTurns: step0.maxTurns ?? DEFAULT_CONSTRAINTS.maxTurns,
    maxTimeMinutes: step0.maxMinutes ?? DEFAULT_CONSTRAINTS.maxTimeMinutes,
    maxTokens: DEFAULT_CONSTRAINTS.maxTokens,
  };

  const state = createGoalState(
    { condition: step0.condition, command: step0.command ?? null, constraints, custom: false },
    "chain",
    now,
  );
  state.metadata.chainId = chain.id;
  state.metadata.chainStep = 0;
  state.metadata.chainTotal = steps.length;

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

export interface AdvanceChainResult {
  ok: boolean;
  error?: string;
  message?: string;
  /** True when chain is fully completed (last step achieved, onComplete=stop). */
  completed?: boolean;
  /** The new state after advancement (null if completed or error). */
  state?: GoalState;
}

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

  const step = chain.steps[chain.current]!;
  const constraints: GoalConstraints = {
    maxTurns: step.maxTurns ?? DEFAULT_CONSTRAINTS.maxTurns,
    maxTimeMinutes: step.maxMinutes ?? DEFAULT_CONSTRAINTS.maxTimeMinutes,
    maxTokens: DEFAULT_CONSTRAINTS.maxTokens,
  };

  const newState = createGoalState(
    { condition: step.condition, command: step.command ?? null, constraints, custom: false },
    "chain",
    now,
  );
  newState.metadata.chainId = chain.id;
  newState.metadata.chainStep = chain.current;
  newState.metadata.chainTotal = chain.steps.length;

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

  const step = chain.steps[0]!;
  const constraints: GoalConstraints = {
    maxTurns: step.maxTurns ?? DEFAULT_CONSTRAINTS.maxTurns,
    maxTimeMinutes: step.maxMinutes ?? DEFAULT_CONSTRAINTS.maxTimeMinutes,
    maxTokens: DEFAULT_CONSTRAINTS.maxTokens,
  };

  const newState = createGoalState(
    { condition: step.condition, command: step.command ?? null, constraints, custom: false },
    "chain",
    now,
  );
  newState.metadata.chainId = chain.id;
  newState.metadata.chainStep = 0;
  newState.metadata.chainTotal = chain.steps.length;

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
