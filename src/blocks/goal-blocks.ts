/**
 * src/blocks/goal-blocks.ts — goal-state → RenderBlock mapping.
 *
 * Takes a GoalState (from goal-state.ts) plus handoff/now context and produces
 * an array of RenderBlock objects that the OpenCode Desktop renderer will
 * display inside the tool output card.
 *
 * The blocks carry the same data as the TUI control center (control-center.ts)
 * but as typed, display-agnostic blocks. When the Desktop ships the
 * BlockRenderer, these blocks render natively. Until then, the plain-text
 * fallback (already in the tool output string) still works.
 */

import type { GoalState, GoalEvaluation } from "../goal-state.js";
import { sanitizeForPrompt } from "../goal-state.js";
import { presentGoalState } from "../gui.js";
import { blocks } from "./factories.js";
import type { RenderBlock } from "./types.js";

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Build the full set of blocks for a goal-status display.
 *
 * @param state - The validated GoalState.
 * @param handoffPresent - True when a handoff file (.goal-handoff.json) exists.
 * @param now - Current timestamp (defaults to Date.now()).
 * @returns Array of RenderBlock objects ready for ctx.render() or metadata.blocks.
 */
export function buildGoalStatusBlocks(
  state: GoalState,
  handoffPresent: boolean = false,
  now: number = Date.now(),
): RenderBlock[] {
  const p = presentGoalState(state, handoffPresent, now);
  const result: RenderBlock[] = [];

  // 1. Header text block — condition + status
  result.push(
    blocks.text({
      key: "goal-header",
      content: `**${p.icon} ${p.statusLabel}:** ${sanitizeForPrompt(state.condition).slice(0, 200)}`,
    }),
  );

  // 2. Stat row — turns, time, tokens
  result.push(blocks.statRow({
    key: "goal-stats",
    stats: [
      { label: "Turns", value: p.turnsLabel },
      { label: "Time", value: p.timeLabel },
      { label: "Tokens", value: p.tokensLabel },
    ],
  }));

  result.push(blocks.statRow({
    key: "goal-limits",
    stats: [
      { label: "Max turns", value: state.constraints.maxTurns.toLocaleString() },
      { label: "Max time", value: `${state.constraints.maxTimeMinutes}m` },
      { label: "Max tokens", value: state.constraints.maxTokens.toLocaleString() },
    ],
  }));

  // 3. Progress bar — max(turns%, time%)
  if (p.progressPct >= 0) {
    result.push(
      blocks.progress({
        key: "goal-progress",
        percent: p.progressPct,
        label: `${p.progressPct}%`,
        variant: p.progressPct >= 90 ? "warning" : "default",
      }),
    );
  }

  // 4. Last evaluation reason
  if (p.lastReason) {
    result.push(
      blocks.text({
        key: "goal-last-eval",
        content: `**Last evaluation: ** ${sanitizeForPrompt(p.lastReason)}`,
      }),
    );
  }

  // 5. Evaluation history strip — last 3 entries as a list
  const recentEvals = state.evaluationHistory.slice(-3);
  if (recentEvals.length > 0) {
    result.push(
      buildEvalList(recentEvals),
    );
  }

  // 6. Steering notes (if present)
  const steering = Array.isArray(state.metadata.steering) ? state.metadata.steering : [];
  if (steering.length > 0) {
    result.push(
      buildSteeringList(steering.map((s) => s.note)),
    );
  }

  // 7. Chain step indicator (if part of a chain)
  if (state.metadata.chainStep !== undefined && state.metadata.chainTotal !== undefined) {
    result.push(
      blocks.text({
        key: "goal-chain",
        content: `*Chain step ${state.metadata.chainStep + 1} of ${state.metadata.chainTotal}*`,
      }),
    );
  }

  // 8. Handoff indicator
  if (handoffPresent) {
    result.push(
      blocks.text({
        key: "goal-handoff",
        content: "📋 *Handoff pending* — use `goal_claim` to resume.",
      }),
    );
  }

  return result;
}

/**
 * Build blocks for the goal_set confirmation display.
 */
export function buildGoalSetBlocks(
  state: GoalState,
): RenderBlock[] {
  return [
    blocks.text({
      key: "set-header",
      content: `**🎯 Goal set:** ${sanitizeForPrompt(state.condition).slice(0, 200)}`,
    }),
    blocks.statRow({
      stats: [
        { label: "Max turns", value: state.constraints.maxTurns.toLocaleString() },
        { label: "Max time", value: `${state.constraints.maxTimeMinutes}m` },
        { label: "Max tokens", value: state.constraints.maxTokens.toLocaleString() },
        ...(state.command ? [{ label: "Verification", value: state.command }] : []),
      ],
    }),
  ];
}

/**
 * Build blocks for a transition confirmation (pause, resume, clear, restart).
 */
export function buildGoalTransitionBlocks(
  state: GoalState,
  action: string,
): RenderBlock[] {
  const labels: Record<string, string> = {
    pause: "⏸ Goal paused",
    resume: "🎯 Goal resumed",
    clear: "🗑 Goal cleared",
    restart: "🔄 Goal restarted",
  };
  const label = labels[action] ?? `Goal ${action}`;
  const p = presentGoalState(state, false);
  return [
    blocks.text({
      key: "transition-header",
      content: `**${label}:** ${sanitizeForPrompt(state.condition).slice(0, 120)}`,
    }),
    blocks.statRow({
      stats: [
        { label: "Turns", value: p.turnsLabel },
        { label: "Time", value: p.timeLabel },
      ],
    }),
  ];
}

// ── Internal helpers ────────────────────────────────────────────────────────

function buildEvalList(evals: GoalEvaluation[]): RenderBlock {
  const items = evals.map((e) => {
    const icon = e.met ? "✓" : e.blocked ? "!" : "·";
    const reason = sanitizeForPrompt(e.reason ?? "").slice(0, 80);
    const type = e.evaluatorType;
    const text = `${icon} ${reason} *(${type})*`;
    return { text };
  });
  return blocks.list({ key: "goal-evals", variant: "unordered", items });
}

function buildSteeringList(notes: string[]): RenderBlock {
  const items = notes.map((note) => ({
    text: sanitizeForPrompt(note).slice(0, 120),
  }));
  return blocks.list({ key: "goal-steering", variant: "unordered", items });
}
