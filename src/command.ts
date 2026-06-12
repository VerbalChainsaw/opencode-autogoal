/**
 * /goal command dispatcher — pure, deterministic, and unit-tested.
 *
 * Given the raw `$ARGUMENTS` string, this performs the state operation and
 * returns the text the agent should act on (or relay to the user). It is kept
 * out of `server.ts` precisely so it can be tested without a running OpenCode.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  setGoal,
  transitionGoal,
  readGoalState,
  formatStatus,
  editMaxTurns,
  editMaxTime,
  editMaxTokens,
  editCondition,
  restartGoal,
  appendSteering,
  clearSteering,
  createHandoff,
  claimHandoff,
  parsePositiveInt,
  unwrapQuotes,
  type GoalState,
  type GoalSeed,
} from "./goal-state.js";
import { BUILTIN_TEMPLATES, type GoalTemplate, resolveTemplateVars, discoverTemplates, exportTemplate as exportTemplateFn, importTemplate as importTemplateFn } from "./templates.js";
import { readGoalChain, createGoalChain, skipGoalChainStep, resetGoalChain, MAX_CHAIN_SIZE, type GoalChainStep } from "./goal-chain.js";

const KNOWN_ACTIONS = new Set([
  "set", "view", "clear", "stop", "off", "reset", "none", "cancel", "pause", "resume", "template", "use", "history",
  // v0.2.0+ dial commands
  "turns", "time", "tokens", "condition", "steer", "unsteer", "restart", "handoff", "claim",
  // v0.4.0+ chain commands
  "chain",
]);
const CLEAR_ALIASES = new Set(["clear", "stop", "off", "reset", "none", "cancel"]);

function userTemplateSeed(directory: string, name: string):
  | { seed: GoalSeed; condition: string; description: string; variables?: GoalTemplate["variables"] }
  | null {
  let tpl: GoalTemplate | undefined = BUILTIN_TEMPLATES[name];
  const userPath = join(directory, ".opencode", "goals", `${name}.json`);
  if (existsSync(userPath)) {
    try {
      const userJson: unknown = JSON.parse(readFileSync(userPath, "utf-8"));
      // Validate shape before trusting it — JSON.parse output is untrusted.
      if (userJson && typeof userJson === "object" && !Array.isArray(userJson) &&
          typeof (userJson as Record<string, unknown>).condition === "string") {
        tpl = userJson as GoalTemplate; // user file overrides builtin
      }
    } catch {
      /* fall back to builtin if present */
    }
  }
  if (!tpl) return null;
  return {
    condition: tpl.condition,
    description: tpl.description || name,
    seed: { command: tpl.command ?? null, constraints: tpl.constraints },
    variables: tpl.variables,
  };
}

/**
 * Structured envelope returned by `dispatchGoalCommandStructured`. The
 * CLI uses the typed `kind` to pick an exit code and never inspects
 * the human-readable `message` to decide success vs failure. The
 * OpenCode agent path (the prose function) reads the same envelope
 * and reproduces the byte-identical reply string for the agent.
 */
export type GoalCommandKind =
  | "success"            // generic success (view, pause, resume, clear, dials, ...)
  | "set"                // successful set — message + agentExtras
  | "usage"              // bad/missing arguments                  → CLI exit 1
  | "invalid-value"      // failed validation                      → CLI exit 1
  | "unknown-action"     // unrecognised first word                → CLI exit 1
  | "no-goal"            // no active goal                         → CLI exit 2
  | "terminal-state"     // cannot edit a terminal goal            → CLI exit 2
  | "handoff-exists"     // handoff already pending                → CLI exit 2
  | "no-handoff"         // no handoff to claim                    → CLI exit 2
  | "current-goal"       // claim refused: a goal is running       → CLI exit 2
  | "write-failed"       // I/O error                              → CLI exit 3
  | "already-in-state";  // no-op (e.g. pause when already paused)  → CLI exit 0

export interface GoalCommandResult {
  kind: GoalCommandKind;
  /** Clean user-facing text. NO relay wrapper, NO "How to proceed" scaffolding. */
  message: string;
  /** Agent-only briefing (the "How to proceed:\n...\nBegin now." block).
   *  Present only when kind === "set". */
  agentExtras?: string;
}

/** Maps the structured kind to the CLI's exit code. */
export const KIND_TO_EXIT: Record<GoalCommandKind, number> = {
  success: 0,
  set: 0,
  "already-in-state": 0,
  usage: 1,
  "invalid-value": 1,
  "unknown-action": 1,
  "no-goal": 2,
  "terminal-state": 2,
  "handoff-exists": 2,
  "no-handoff": 2,
  "current-goal": 2,
  "write-failed": 3,
};

/** The "you set a goal, now work toward it" briefing — shared by the /goal
 *  command AND the conversational set_goal tool so the agent gets identical guidance.
 *
 *  Returns the joined prose as a single string. For the structured dispatcher
 *  (which needs to keep the agent-prompt scaffolding separate from the
 *  user-facing message), use `goalInstructionsEnvelope` below. */
export function goalInstructions(state: GoalState, replaced: string | null, fromTemplate?: string): string {
  const { message, agentExtras } = goalInstructionsEnvelope(state, replaced, fromTemplate);
  return `${message}\n\n${agentExtras}`;
}

/** Same content as `goalInstructions`, but split at the "How to proceed:"
 *  boundary so the CLI can show the user-facing half and the agent can
 *  see both. The split is by content, not by string-search on user data. */
function goalInstructionsEnvelope(
  state: GoalState, replaced: string | null, fromTemplate?: string,
): { message: string; agentExtras: string } {
  const topLines: string[] = [];
  if (fromTemplate) topLines.push(`A goal has been set from template "${fromTemplate}".`);
  else topLines.push("A goal has been set and is now your top priority.");
  if (replaced) topLines.push(`(Replaced previous goal: ${replaced})`);
  topLines.push("", `GOAL: ${state.condition}`);
  if (state.command) topLines.push(`Verification command: \`${state.command}\` — the goal is met when this exits 0.`);
  topLines.push(`Limits: up to ${state.constraints.maxTurns} turns / ${state.constraints.maxTimeMinutes} minutes.`);
  const message = topLines.join("\n");

  const agentLines: string[] = [
    "How to proceed:",
    "- Briefly tell the user the goal is set, then start working toward it immediately.",
    "- Treat the goal as your top priority; after each step, ask whether it advanced the goal.",
    "- The user can interrupt at any time with `/goal pause` or `/goal clear`.",
  ];
  if (state.command) agentLines.push("- Run the verification command to confirm completion; it must exit 0.");
  else agentLines.push('- When you believe the goal is satisfied, write a line beginning "GOAL_COMPLETE:" followed by the evidence.');
  agentLines.push('- If you become genuinely, unrecoverably blocked, write a line beginning "GOAL_BLOCKED:" explaining why.');
  agentLines.push("", "Begin now.");
  const agentExtras = agentLines.join("\n");

  return { message, agentExtras };
}

function relayToUser(message: string): string {
  return `Tell the user this, then stop and await further instruction:\n\n${message}`;
}

/** Plain status text (no "relay to user" wrapper) — for the goal_status tool. */
export function plainStatus(directory: string): string {
  return formatStatus(readGoalState(directory)) ?? "No active goal. Ask to set one to start.";
}

/** The structured dispatcher. The CLI uses this directly; the OpenCode
 *  agent path uses `dispatchGoalCommand` (a thin presenter that
 *  reproduces the byte-identical prose for backward compat). */
export function dispatchGoalCommandStructured(
  directory: string, rawArguments: string,
): GoalCommandResult {
  const argsText = (rawArguments ?? "").trim();

  // Bare `/goal` (no arguments) shows status — it must NOT fall through to an
  // empty "set" (which would error with "condition cannot be empty").
  if (!argsText) {
    const status = formatStatus(readGoalState(directory));
    if (status) return { kind: "success", message: status };
    return { kind: "no-goal", message: 'No active goal. Set one with /goal set "<condition>".' };
  }

  const firstSpace = argsText.search(/\s/);
  const firstWord = (firstSpace === -1 ? argsText : argsText.slice(0, firstSpace)).toLowerCase();
  const isAction = KNOWN_ACTIONS.has(firstWord);
  const action = isAction ? firstWord : "set";
  const payload = isAction ? (firstSpace === -1 ? "" : argsText.slice(firstSpace + 1).trim()) : argsText;

  if (action === "view") {
    const status = formatStatus(readGoalState(directory));
    if (status) return { kind: "success", message: status };
    return { kind: "no-goal", message: 'No active goal. Set one with /goal set "<condition>".' };
  }

  if (action === "set") {
    const res = setGoal(directory, payload);
    if (!res.ok) {
      // C-1 fix: switch on the typed `reason` so "invalid-value" maps to
      // kind:"invalid-value" (CLI exit 1) and "write-failed" maps to
      // kind:"write-failed" (CLI exit 3). The previous fall-through to
      // kind:"no-goal" (CLI exit 2) was wrong — a user who typed
      // nothing got exit 2, a user with a full disk got exit 2.
      if (res.reason === "write-failed") {
        return { kind: "write-failed", message: `Goal not set — ${res.error}` };
      }
      return { kind: "invalid-value", message: `Goal not set — ${res.error}` };
    }
    // Discriminated OK branch: `state` and `replaced` are always present.
    const { message, agentExtras } = goalInstructionsEnvelope(res.state, res.replaced);
    return { kind: "set", message, agentExtras };
  }

  if (action === "template" || action === "use") {
    // Parse: template <subaction> [args...]
    const subAction = payload.split(/\s+/)[0]?.toLowerCase() ?? "";
    const subPayload = payload.slice(subAction.length).trim();

    // v0.4.0: template list
    if (subAction === "list") {
      const templates = discoverTemplates(directory);
      if (templates.length === 0) return { kind: "no-goal", message: "No templates available." };
      const lines = templates.map(t => `${t.builtin ? "📦" : "📁"} ${t.name.padEnd(16)} ${t.description}`);
      return { kind: "success", message: lines.join("\n") };
    }

    // v0.4.0: template export
    if (subAction === "export") {
      const name = subPayload.trim();
      if (!name) return { kind: "usage", message: "Usage: /goal template export <name>" };
      const tpl = exportTemplateFn(directory, name);
      if (!tpl) return { kind: "usage", message: `Template '${name}' not found.` };
      return { kind: "success", message: JSON.stringify(tpl, null, 2) };
    }

    // v0.4.0: template import
    if (subAction === "import") {
      const name = subPayload.trim();
      if (!name) return { kind: "usage", message: "Usage: /goal template import <name> <json-content>" };
      // name is first word, rest is JSON content
      const spaceIdx = subPayload.search(/\s/);
      const templateName = spaceIdx === -1 ? subPayload : subPayload.slice(0, spaceIdx);
      const jsonContent = spaceIdx === -1 ? "" : subPayload.slice(spaceIdx + 1).trim();
      if (!templateName || !jsonContent) return { kind: "usage", message: "Usage: /goal template import <name> <json-content>" };
      const res = importTemplateFn(directory, templateName, jsonContent);
      if (!res.ok) return { kind: "invalid-value", message: res.error! };
      return { kind: "success", message: `Template '${templateName}' imported.` };
    }

    // Original behavior: template use (with optional --var support)
    const m = payload.match(/^(\S+)\s*(.*)$/);
    if (!m) {
      return { kind: "usage", message: "Usage: /goal template <name>. Templates live in .opencode/goals/ or are built in." };
    }
    const name = m[1]!;
    let overrides = m[2] ?? "";
    // Parse --var key=value pairs from overrides
    const vars: Record<string, string> = {};
    overrides = overrides.replace(/--var\s+(\w+)=(\S+)/g, (_, k, v) => { vars[k] = v; return ""; }).trim();
    
    // SECURITY: `name` is interpolated into a file path. Reject anything but a
    // plain slug so it cannot traverse out of .opencode/goals/ (e.g. "../../etc/x").
    if (!/^[A-Za-z0-9_-]+$/.test(name)) {
      return { kind: "usage", message: `Invalid template name '${name}'. Use letters, numbers, hyphens, and underscores only.` };
    }
    const tpl = userTemplateSeed(directory, name);
    if (!tpl) {
      return { kind: "usage", message: `Template '${name}' not found. Built-ins: ${Object.keys(BUILTIN_TEMPLATES).join(", ")}.` };
    }
    // Resolve template variables on BOTH the condition AND the seed
    // command. Spec v0.4.0: "Template use with --var: condition + command
    // resolved" AND "Template use with default variable | default value
    // applied". The variable resolution order is:
    //   1. explicit `--var key=value` overrides (highest priority)
    //   2. declared `variables.<key>.default` from the template file
    //   3. unresolved → kept as literal `{key}` in the output
    //
    // The previous behavior only resolved the condition and used
    // explicit overrides — declared defaults were ignored, leaving
    // `{branch}` literal in the state when no `--var` was passed.
    const mergedVars: Record<string, string> = {};
    if (tpl.variables) {
      for (const [k, def] of Object.entries(tpl.variables)) {
        if (def && typeof def === "object" && typeof def.default === "string") {
          mergedVars[k] = def.default;
        }
      }
    }
    // Explicit --var overrides win over declared defaults.
    Object.assign(mergedVars, vars);

    const resolvedCondition = resolveTemplateVars(tpl.condition, mergedVars);
    const resolvedSeed: GoalSeed = {
      ...tpl.seed,
      command: tpl.seed.command != null ? resolveTemplateVars(tpl.seed.command, mergedVars) : tpl.seed.command,
    };
    const rawArgs = `${resolvedCondition} ${overrides}`.trim();
    const res = setGoal(directory, rawArgs, { setBy: "template", seed: resolvedSeed });
    // C-1 fix: same reason-switch as the bare `set` path above. A
    // template with an empty condition (or a write failure) should
    // surface with the correct kind, not collapse to no-goal.
    if (!res.ok) {
      if (res.reason === "write-failed") {
        return { kind: "write-failed", message: `Goal not set — ${res.error}` };
      }
      return { kind: "invalid-value", message: `Goal not set — ${res.error}` };
    }
    const { message, agentExtras } = goalInstructionsEnvelope(res.state, res.replaced, tpl.description);
    return { kind: "set", message, agentExtras };
  }

  if (CLEAR_ALIASES.has(action)) {
    const res = transitionGoal(directory, "clear");
    if (res.ok) return { kind: "success", message: res.message! };
    // R2-1: switch on typed `reason` instead of regex-greping `error`.
    if (res.reason === "no-goal") return { kind: "no-goal", message: res.error! };
    return { kind: "write-failed", message: res.error ?? "Failed to clear." };
  }

  if (action === "pause") {
    const res = transitionGoal(directory, "pause");
    if (res.ok) return { kind: "success", message: res.message! };
    // R2-1: switch on typed `reason` (was regex on `error` prose).
    switch (res.reason) {
      case "no-goal": return { kind: "no-goal", message: res.error! };
      case "already-in-state": return { kind: "already-in-state", message: res.error! };
      default: return { kind: "write-failed", message: res.error ?? "Failed to pause." };
    }
  }

  if (action === "resume") {
    const res = transitionGoal(directory, "resume");
    if (!res.ok) {
      // R2-1: switch on typed `reason` (was regex on `error` prose).
      // Note: `transitionGoal` returns reason="no-goal" for both
      // "no goal at all" and "goal was cleared" — the OpenCode
      // agent's surface (which sees the raw `error` string) preserves
      // the two distinct messages; the CLI/structured surface
      // collapses them to one kind.
      if (res.reason === "no-goal") return { kind: "no-goal", message: res.error! };
      if (res.reason === "terminal-state") return { kind: "terminal-state", message: res.error! };
      if (res.reason === "already-in-state") return { kind: "already-in-state", message: res.error! };
      return { kind: "write-failed", message: res.error ?? "Failed to resume." };
    }
    const state = readGoalState(directory);
    if (state) {
      // Special-cased bare message: the "continue working toward it now"
      // briefing is the user-facing output, NOT relay-wrapped. The
      // presenter (dispatchGoalCommand) preserves this verbatim.
      return { kind: "success", message: `Goal resumed — continue working toward it now:\n\nGOAL: ${state.condition}` };
    }
    return { kind: "success", message: res.message! };
  }

  if (action === "history") {
    const state = readGoalState(directory);
    const hist = state?.evaluationHistory ?? [];
    if (!hist.length) return { kind: "no-goal", message: "No evaluation history for the current goal." };
    const rows = hist
      .slice(-10)
      .map((e) => `[${new Date(e.timestamp).toISOString()}] met=${e.met} (${e.evaluatorType}) — ${e.reason}`)
      .join("\n");
    return { kind: "success", message: `Goal evaluation history (most recent last):\n${rows}` };
  }

  // ── Dial commands (v0.2.0+) ────────────────────────────────────────────
  // Each is a thin wrapper that calls the goal-state primitive and
  // relays the result to the user.

  if (action === "turns") {
    const n = parsePositiveInt(payload);
    if (n === null) return { kind: "usage", message: "Usage: /goal turns <number>. e.g. /goal turns 50" };
    const res = editMaxTurns(directory, n);
    return dialResultToEnvelope(res, "Max turns updated.");
  }

  if (action === "time") {
    const n = parsePositiveInt(payload);
    if (n === null) return { kind: "usage", message: "Usage: /goal time <minutes>. e.g. /goal time 60" };
    const res = editMaxTime(directory, n);
    return dialResultToEnvelope(res, "Max time updated.");
  }

  if (action === "tokens") {
    const n = parsePositiveInt(payload);
    if (n === null) return { kind: "usage", message: "Usage: /goal tokens <number>. e.g. /goal tokens 200000" };
    const res = editMaxTokens(directory, n);
    return dialResultToEnvelope(res, "Max tokens updated.");
  }

  if (action === "condition") {
    if (!payload) return { kind: "usage", message: 'Usage: /goal condition "<text>". e.g. /goal condition "make all tests pass"' };
    const res = editCondition(directory, unwrapQuotes(payload));
    return dialResultToEnvelope(res, "Condition updated.");
  }

  if (action === "steer") {
    if (!payload) return { kind: "usage", message: 'Usage: /goal steer "<hint>". The hint is shown to the agent on the next nudge.' };
    const res = appendSteering(directory, unwrapQuotes(payload));
    return dialResultToEnvelope(res, "Steering note added.");
  }

  if (action === "unsteer") {
    const res = clearSteering(directory);
    if (!res.ok) {
      if (res.reason === "no-goal") return { kind: "no-goal", message: "No active goal." };
      return { kind: "write-failed", message: res.error ?? "Failed to clear steering notes." };
    }
    return { kind: "success", message: res.message };
  }

  if (action === "restart") {
    const res = restartGoal(directory);
    if (!res.ok) {
      // A1: terminal-state case was missing — fall-through mapped to
      // write-failed (exit 3) when it should be terminal-state (exit 2).
      if (res.reason === "no-goal") return { kind: "no-goal", message: "No active goal to restart." };
      if (res.reason === "terminal-state") return { kind: "terminal-state", message: res.error! };
      if (res.reason === "handoff-pending") return { kind: "handoff-exists", message: res.error ?? "A handoff is pending." };
      return { kind: "write-failed", message: res.error ?? "Failed to restart." };
    }
    return { kind: "success", message: res.message };
  }

  if (action === "handoff") {
    const note = payload || undefined;
    const res = createHandoff(directory, note);
    if (!res.ok) {
      // A1: terminal-state case was missing (see restart above).
      if (res.reason === "no-goal") return { kind: "no-goal", message: "No active goal to handoff." };
      if (res.reason === "terminal-state") return { kind: "terminal-state", message: res.error! };
      if (res.reason === "handoff-exists") return { kind: "handoff-exists", message: res.error ?? "A handoff is already pending." };
      return { kind: "write-failed", message: res.error ?? "Failed to create handoff." };
    }
    return { kind: "success", message: res.message };
  }

  if (action === "claim") {
    const res = claimHandoff(directory);
    if (!res.ok) {
      if (res.reason === "no-handoff") return { kind: "no-handoff", message: "No handoff to claim." };
      if (res.reason === "current-goal") return { kind: "current-goal", message: res.error ?? "A goal is already active. Clear it before claiming the handoff." };
      return { kind: "write-failed", message: res.error ?? "Failed to claim handoff." };
    }
    return { kind: "success", message: res.message };
  }

  // ── v0.4.0+ chain commands ───────────────────────────────────────────
  if (action === "chain") {
    const subAction = payload.split(/\s+/)[0]?.toLowerCase() ?? "";
    const subPayload = payload.slice(subAction.length).trim();

    if (subAction === "skip") {
      const res = skipGoalChainStep(directory);
      if (!res.ok) return { kind: "no-goal", message: res.error! };
      return { kind: "success", message: res.message! };
    }

    if (subAction === "reset") {
      const res = resetGoalChain(directory);
      if (!res.ok) return { kind: "no-goal", message: res.error! };
      return { kind: "success", message: res.message! };
    }

    if (subAction === "start") {
      if (!subPayload) return { kind: "usage", message: "Usage: /goal chain start <path-to-chain.json>" };
      // Read the chain JSON file. Cap the file size BEFORE reading so a
      // 50MB+ attack payload doesn't burn heap on a string allocation just
      // to be rejected downstream — mirrors the readGoalChain size guard
      // in goal-chain.ts. (Red-team audit, Pass 2 — file I/O with user paths.)
      try {
        const chainPath = resolve(directory, subPayload);
        // existsSync + statSync guards against ENOENT-throwing statSync.
        if (!existsSync(chainPath)) {
          return { kind: "invalid-value", message: `Chain file not found: ${chainPath}` };
        }
        const fileSize = statSync(chainPath).size;
        if (fileSize > MAX_CHAIN_SIZE) {
          return { kind: "invalid-value", message: `Chain file too large (${fileSize} bytes; max ${MAX_CHAIN_SIZE} bytes / 256KB).` };
        }
        const raw = readFileSync(chainPath, "utf-8");
        const steps = JSON.parse(raw) as GoalChainStep[];
        if (!Array.isArray(steps)) {
          return { kind: "invalid-value", message: "Chain file must contain a JSON array of steps." };
        }
        const res = createGoalChain(directory, steps);
        if (!res.ok) return { kind: "invalid-value", message: res.error! };
        return { kind: "success", message: `Chain started with ${steps.length} step${steps.length === 1 ? "" : "s"}. Step 1/${steps.length}: ${res.state!.condition.slice(0, 60)}` };
      } catch (err: any) {
        return { kind: "invalid-value", message: `Failed to read chain file: ${err?.message ?? err}` };
      }
    }

    // Default: show chain status
    const chain = readGoalChain(directory);
    if (!chain) return { kind: "no-goal", message: "No active chain." };
    const lines = [
      `Chain: ${chain.id.slice(0, 8)} · ${chain.steps.length} steps · current: ${chain.current + 1}/${chain.steps.length}`,
      chain.onComplete === "loop" ? `Mode: loop (cycle ${chain.cycles + 1}${chain.maxCycles > 0 ? `/${chain.maxCycles}` : ""})` : "Mode: stop on completion",
      "",
    ];
    for (let i = 0; i < chain.steps.length; i++) {
      const marker = i < chain.current ? "✅" : i === chain.current ? "🎯" : "⬜";
      lines.push(`${marker} Step ${i + 1}: ${chain.steps[i]!.condition.slice(0, 80)}`);
    }
    return { kind: "success", message: lines.join("\n") };
  }

  return { kind: "unknown-action", message: 'Unknown /goal action. Try: set "<condition>", view, pause, resume, clear, template <name>, history, turns <n>, time <n>, tokens <n>, condition "<text>", steer "<hint>", unsteer, restart, handoff [note], claim, chain [skip|reset|start].' };
}

/** Convert an EditResult into a GoalCommandResult envelope. */
function dialResultToEnvelope(
  res: { ok: true; field?: string; value?: unknown; message: string }
    | { ok: false; reason: "no-goal" | "terminal-state" | "invalid-value" | "write-failed"; error?: string },
  defaultMsg: string,
): GoalCommandResult {
  if (res.ok) return { kind: "success", message: res.message };
  // Map the no-goal / terminal-state / invalid-value / write-failed
  // reasons to their corresponding kinds.
  if (res.reason === "no-goal") return { kind: "no-goal", message: "No active goal." };
  if (res.reason === "terminal-state") return { kind: "terminal-state", message: res.error ?? "Cannot edit a goal in a terminal state." };
  if (res.reason === "invalid-value") return { kind: "invalid-value", message: res.error ?? "Invalid value." };
  return { kind: "write-failed", message: res.error ?? `${defaultMsg} failed.` };
}

/** The prose presenter. Reproduces the byte-identical reply strings the
 *  pre-refactor dispatcher produced, so the OpenCode agent path keeps
 *  working without any behavioral change. The CLI uses the structured
 *  function directly and bypasses this. */
export function dispatchGoalCommand(directory: string, rawArguments: string): string {
  const res = dispatchGoalCommandStructured(directory, rawArguments);
  // Two non-relayed success paths: set (returns full briefing) and
  // resume with state (returns the "continue working toward it now"
  // bare string). Everything else is relay-wrapped.
  if (res.kind === "set") return `${res.message}\n\n${res.agentExtras}`;
  if (res.kind === "success" && res.message.startsWith("Goal resumed — continue working toward it now:")) {
    return res.message;
  }
  return relayToUser(res.message);
}

// parsePositiveInt is imported from goal-state.ts — single source of truth.
