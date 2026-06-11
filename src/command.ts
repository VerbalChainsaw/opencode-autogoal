/**
 * /goal command dispatcher — pure, deterministic, and unit-tested.
 *
 * Given the raw `$ARGUMENTS` string, this performs the state operation and
 * returns the text the agent should act on (or relay to the user). It is kept
 * out of `server.ts` precisely so it can be tested without a running OpenCode.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
  unwrapQuotes,
  type GoalState,
  type GoalSeed,
} from "./goal-state.js";
import { BUILTIN_TEMPLATES } from "./templates.js";

const KNOWN_ACTIONS = new Set([
  "set", "view", "clear", "stop", "off", "reset", "none", "cancel", "pause", "resume", "template", "use", "history",
  // v0.2.0+ dial commands
  "turns", "time", "tokens", "condition", "steer", "unsteer", "restart", "handoff", "claim",
]);
const CLEAR_ALIASES = new Set(["clear", "stop", "off", "reset", "none", "cancel"]);

function userTemplateSeed(directory: string, name: string): { seed: GoalSeed; condition: string; description: string } | null {
  const builtin = BUILTIN_TEMPLATES[name];
  const userPath = join(directory, ".opencode", "goals", `${name}.json`);
  let tpl: any = builtin;
  if (existsSync(userPath)) {
    try {
      tpl = JSON.parse(readFileSync(userPath, "utf-8")); // user file overrides builtin
    } catch {
      /* fall back to builtin if present */
    }
  }
  if (!tpl || typeof tpl.condition !== "string") return null;
  return {
    condition: tpl.condition,
    description: tpl.description || name,
    seed: { command: tpl.command ?? null, constraints: tpl.constraints },
  };
}

/** The "you set a goal, now work toward it" briefing — shared by the /goal
 *  command AND the conversational set_goal tool so the agent gets identical guidance. */
export function goalInstructions(state: GoalState, replaced: string | null, fromTemplate?: string): string {
  const lines: string[] = [];
  if (fromTemplate) lines.push(`A goal has been set from template "${fromTemplate}".`);
  else lines.push("A goal has been set and is now your top priority.");
  if (replaced) lines.push(`(Replaced previous goal: ${replaced})`);
  lines.push("", `GOAL: ${state.condition}`);
  if (state.command) lines.push(`Verification command: \`${state.command}\` — the goal is met when this exits 0.`);
  lines.push(`Limits: up to ${state.constraints.maxTurns} turns / ${state.constraints.maxTimeMinutes} minutes.`, "");
  lines.push("How to proceed:");
  lines.push("- Briefly tell the user the goal is set, then start working toward it immediately.");
  lines.push("- Treat the goal as your top priority; after each step, ask whether it advanced the goal.");
  lines.push("- The user can interrupt at any time with `/goal pause` or `/goal clear`.");
  if (state.command) lines.push("- Run the verification command to confirm completion; it must exit 0.");
  else lines.push('- When you believe the goal is satisfied, write a line beginning "GOAL_COMPLETE:" followed by the evidence.');
  lines.push('- If you become genuinely, unrecoverably blocked, write a line beginning "GOAL_BLOCKED:" explaining why.');
  lines.push("", "Begin now.");
  return lines.join("\n");
}

function relayToUser(message: string): string {
  return `Tell the user this, then stop and await further instruction:\n\n${message}`;
}

/** Plain status text (no "relay to user" wrapper) — for the goal_status tool. */
export function plainStatus(directory: string): string {
  return formatStatus(readGoalState(directory)) ?? "No active goal. Ask to set one to start.";
}

function viewResponse(directory: string): string {
  const status = formatStatus(readGoalState(directory));
  return relayToUser(status ?? 'No active goal. Set one with /goal set "<condition>".');
}

/** Process `/goal <args>` and return the text for the agent to act on / relay. */
export function dispatchGoalCommand(directory: string, rawArguments: string): string {
  const argsText = (rawArguments ?? "").trim();

  // Bare `/goal` (no arguments) shows status — it must NOT fall through to an
  // empty "set" (which would error with "condition cannot be empty").
  if (!argsText) return viewResponse(directory);

  const firstSpace = argsText.search(/\s/);
  const firstWord = (firstSpace === -1 ? argsText : argsText.slice(0, firstSpace)).toLowerCase();
  const isAction = KNOWN_ACTIONS.has(firstWord);
  const action = isAction ? firstWord : "set";
  const payload = isAction ? (firstSpace === -1 ? "" : argsText.slice(firstSpace + 1).trim()) : argsText;

  if (action === "view") return viewResponse(directory);

  if (action === "set") {
    const res = setGoal(directory, payload);
    if (!res.ok) return relayToUser(`Goal not set — ${res.error}`);
    return goalInstructions(res.state!, res.replaced ?? null);
  }

  if (action === "template" || action === "use") {
    const m = payload.match(/^(\S+)\s*(.*)$/);
    if (!m) return relayToUser("Usage: /goal template <name>. Templates live in .opencode/goals/ or are built in.");
    const name = m[1];
    const overrides = m[2] ?? "";
    // SECURITY: `name` is interpolated into a file path. Reject anything but a
    // plain slug so it cannot traverse out of .opencode/goals/ (e.g. "../../etc/x").
    if (!/^[A-Za-z0-9_-]+$/.test(name)) {
      return relayToUser(`Invalid template name '${name}'. Use letters, numbers, hyphens, and underscores only.`);
    }
    const tpl = userTemplateSeed(directory, name);
    if (!tpl) return relayToUser(`Template '${name}' not found. Built-ins: ${Object.keys(BUILTIN_TEMPLATES).join(", ")}.`);
    const rawArgs = `${tpl.condition} ${overrides}`.trim();
    const res = setGoal(directory, rawArgs, { setBy: "template", seed: tpl.seed });
    if (!res.ok) return relayToUser(`Goal not set — ${res.error}`);
    return goalInstructions(res.state!, res.replaced ?? null, tpl.description);
  }

  if (CLEAR_ALIASES.has(action)) {
    const res = transitionGoal(directory, "clear");
    return relayToUser(res.ok ? res.message! : res.error!);
  }

  if (action === "pause") {
    const res = transitionGoal(directory, "pause");
    return relayToUser(res.ok ? res.message! : res.error!);
  }

  if (action === "resume") {
    const res = transitionGoal(directory, "resume");
    if (!res.ok) return relayToUser(res.error!);
    const state = readGoalState(directory);
    return state
      ? `Goal resumed — continue working toward it now:\n\nGOAL: ${state.condition}`
      : relayToUser(res.message!);
  }

  if (action === "history") {
    const state = readGoalState(directory);
    const hist = state?.evaluationHistory ?? [];
    if (!hist.length) return relayToUser("No evaluation history for the current goal.");
    const rows = hist
      .slice(-10)
      .map((e) => `[${new Date(e.timestamp).toISOString()}] met=${e.met} (${e.evaluatorType}) — ${e.reason}`)
      .join("\n");
    return relayToUser(`Goal evaluation history (most recent last):\n${rows}`);
  }

  // ── Dial commands (v0.2.0+) ────────────────────────────────────────────
  // Each is a thin wrapper that calls the goal-state primitive and
  // relays the result to the user. Syntax:
  //   /goal turns 50
  //   /goal time 60
  //   /goal tokens 200000
  //   /goal condition "the new condition"
  //   /goal steer "focus on library X next"
  //   /goal unsteer
  //   /goal restart
  //   /goal handoff [optional note]
  //   /goal claim

  if (action === "turns") {
    const n = parsePositiveInt(payload);
    if (n === null) return relayToUser("Usage: /goal turns <number>. e.g. /goal turns 50");
    const res = editMaxTurns(directory, n);
    return dialResultToUser(res, "Max turns updated.");
  }

  if (action === "time") {
    const n = parsePositiveInt(payload);
    if (n === null) return relayToUser("Usage: /goal time <minutes>. e.g. /goal time 60");
    const res = editMaxTime(directory, n);
    return dialResultToUser(res, "Max time updated.");
  }

  if (action === "tokens") {
    const n = parsePositiveInt(payload);
    if (n === null) return relayToUser("Usage: /goal tokens <number>. e.g. /goal tokens 200000");
    const res = editMaxTokens(directory, n);
    return dialResultToUser(res, "Max tokens updated.");
  }

  if (action === "condition") {
    if (!payload) return relayToUser('Usage: /goal condition "<text>". e.g. /goal condition "make all tests pass"');
    const res = editCondition(directory, unwrapQuotes(payload));
    return dialResultToUser(res, "Condition updated.");
  }

  if (action === "steer") {
    if (!payload) return relayToUser('Usage: /goal steer "<hint>". The hint is shown to the agent on the next nudge.');
    const res = appendSteering(directory, unwrapQuotes(payload));
    return dialResultToUser(res, "Steering note added.");
  }

  if (action === "unsteer") {
    const res = clearSteering(directory);
    if (!res.ok) {
      if (res.reason === "no-goal") return relayToUser("No active goal.");
      return relayToUser(res.error ?? "Failed to clear steering notes.");
    }
    return relayToUser(res.message);
  }

  if (action === "restart") {
    const res = restartGoal(directory);
    if (!res.ok) {
      if (res.reason === "no-goal") return relayToUser("No active goal to restart.");
      return relayToUser(res.error ?? "Failed to restart.");
    }
    return relayToUser(res.message);
  }

  if (action === "handoff") {
    const note = payload || undefined;
    const res = createHandoff(directory, note);
    if (!res.ok) {
      if (res.reason === "no-goal") return relayToUser("No active goal to handoff.");
      return relayToUser(res.error ?? "Failed to create handoff.");
    }
    return relayToUser(res.message);
  }

  if (action === "claim") {
    const res = claimHandoff(directory);
    if (!res.ok) {
      if (res.reason === "no-handoff") return relayToUser("No handoff to claim.");
      if (res.reason === "current-goal") return relayToUser(res.error ?? "A goal is already active. Clear it before claiming the handoff.");
      return relayToUser(res.error ?? "Failed to claim handoff.");
    }
    return relayToUser(res.message);
  }

  return relayToUser('Unknown /goal action. Try: set "<condition>", view, pause, resume, clear, template <name>, history, turns <n>, time <n>, tokens <n>, condition "<text>", steer "<hint>", unsteer, restart, handoff [note], claim.');
}

/** Strict positive-integer parser shared with the dial actions. */
function parsePositiveInt(s: string): number | null {
  if (typeof s !== "string") return null;
  const trimmed = s.trim();
  if (trimmed.length === 0) return null;
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.trunc(n);
}

/** Convert an EditResult into a "relay to user" string. */
function dialResultToUser(res: { ok: true; message: string } | { ok: false; reason: string; error?: string }, defaultMsg: string): string {
  if (res.ok) return relayToUser(res.message);
  // Map the no-goal / terminal-state reasons to friendly messages even
  // when the primitive didn't include an `error` field.
  if (res.reason === "no-goal") return relayToUser("No active goal.");
  if (res.reason === "terminal-state") return relayToUser(res.error ?? "Cannot edit a goal in a terminal state.");
  return relayToUser(res.error ?? `${defaultMsg} failed.`);
}
