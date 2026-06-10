/**
 * opencode-autogoal — SERVER plugin (the whole product on Desktop).
 *
 * Runtime imports: Node builtins, this package's own `goal-state.js`/`command.js`,
 * and `tool` from `@opencode-ai/plugin` (the host-provided plugin API — the only
 * dependency). `tool.schema` is the host's own zod, so no separate zod dependency.
 *
 * Responsibilities:
 *  - `tool` → conversational goal management (set_goal / goal_status / clear_goal /
 *    pause_goal / resume_goal): the user just asks in plain language. PRIMARY UX.
 *  - `config` + `command.execute.before` → the optional `/goal` slash command,
 *    handled deterministically in TS (logic lives in ./command.ts).
 *  - `event` (session.idle) → the auto-loop: evaluate the goal, notify, and nudge
 *    the agent onward until the condition holds or a constraint trips.
 *  - `experimental.session.compacting` → keeps the goal in context across compaction.
 */

import type { Plugin, PluginModule } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import {
  readGoalState,
  writeGoalStateAtomic,
  setGoalFields,
  transitionGoal,
  detectMarker,
  parseShellWords,
  COMPLETE_RE,
  BLOCKED_RE,
  type GoalState,
  type GoalEvaluation,
} from "./goal-state.js";
import { dispatchGoalCommand, goalInstructions, plainStatus } from "./command.js";
import { PendingPermissions } from "./permissions.js";

const execAsync = promisify(exec);

const CONFIG = {
  evaluationDebounceSec: 5,
  commandTimeoutMs: 30_000,
  // Set OPENGOAL_DEBUG=1 to surface debug-level logs while testing/diagnosing.
  debug: process.env.OPENGOAL_DEBUG === "1" || process.env.OPENGOAL_DEBUG === "true",
};

// Minimal fallback template; the real work happens in command.execute.before.
const COMMAND_TEMPLATE =
  "Handle the /goal command. Arguments: $ARGUMENTS\n" +
  "(The goal plugin processes this deterministically; follow the injected instructions.)";

export const server: Plugin = async ({ client, directory }) => {
  let lastEvaluationTime = 0;
  let isEvaluating = false;
  // Tracks open tool-permission requests; the loop must not nudge while one is open.
  const pendingPermissions = new PendingPermissions();

  function log(level: "debug" | "info" | "warn" | "error", message: string, extra?: any) {
    if (!CONFIG.debug && level === "debug") return;
    client.app.log({ body: { service: "opencode-autogoal", level, message: `[goal] ${message}`, extra } }).catch(() => {});
  }

  // ── User-facing notifications, frontend-agnostic ──────────────────────────
  // `client.tui.showToast` only renders in the terminal TUI; on the Desktop
  // (Electron) app it is a no-op. The conversation is the one shared surface, so
  // we ALSO write a `noReply` status line into the session.
  async function notify(sessionId: string, title: string, message: string, variant: "info" | "success" | "warning" | "error") {
    await client.tui.showToast({ body: { title, message, variant } }).catch(() => {});
    await client.session
      .prompt({ path: { id: sessionId }, body: { noReply: true, parts: [{ type: "text", text: `🎯 [${title}] ${message}` }] } })
      .catch((err) => log("error", "notify (session message) failed", { error: String(err) }));
  }

  // Command handling lives in ./command.ts (pure + unit-tested).

  // ── Auto-loop evaluation ──────────────────────────────────────────────────
  function checkConstraints(state: GoalState): { exceeded: boolean; reason: string } {
    const c = state.constraints;
    if (state.turnsEvaluated >= c.maxTurns)
      return { exceeded: true, reason: `Turn limit reached: ${state.turnsEvaluated}/${c.maxTurns} turns` };
    const elapsedMin = (Date.now() - state.startedAt) / 60_000;
    if (elapsedMin >= c.maxTimeMinutes)
      return { exceeded: true, reason: `Time limit reached: ${Math.round(elapsedMin)}/${c.maxTimeMinutes} minutes` };
    // maxTokens is intentionally not enforced: the SDK exposes no per-session token count.
    return { exceeded: false, reason: "" };
  }

  async function evaluateDeterministic(command: string): Promise<GoalEvaluation> {
    const now = Date.now();
    // Debug-only: log the portable argv view of the command. The execution
    // path still uses `exec` (the user expects shell semantics — `2>&1`,
    // pipes, `&&`). The argv view is for diagnostics; it's the same on every
    // platform and lets users verify their command parses as they expect.
    if (CONFIG.debug) {
      log("debug", "verification command argv", { argv: parseShellWords(command) });
    }
    try {
      const { stdout } = await execAsync(command, {
        cwd: directory,
        timeout: CONFIG.commandTimeoutMs,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      });
      return {
        met: true,
        reason: `Verified (exit 0): ${stdout.slice(0, 200).trim()}`,
        confidence: 1.0,
        timestamp: now,
        evaluatorType: "deterministic",
        rawOutput: stdout.slice(0, 1000),
      };
    } catch (err: any) {
      const timedOut = err?.killed && (err?.signal === "SIGTERM" || err?.signal === "SIGKILL");
      const stderr = String(err?.stderr ?? "").trim();
      const stdout = String(err?.stdout ?? "").trim();
      const reason = timedOut
        ? `Command timed out after ${CONFIG.commandTimeoutMs}ms`
        : `Not met (exit ${err?.code ?? "?"}): ${(stderr || stdout || String(err?.message ?? err)).slice(0, 200)}`;
      return { met: false, reason, confidence: 1.0, timestamp: now, evaluatorType: "deterministic", rawOutput: `${stdout}\n${stderr}`.slice(0, 1000) };
    }
  }

  async function getLatestAssistantText(sessionId: string): Promise<string> {
    try {
      const res = await client.session.messages({ path: { id: sessionId } });
      const msgs = (res.data ?? []) as any[];
      const last = msgs.filter((m) => m?.info?.role === "assistant").at(-1);
      if (!last) return "";
      return (last.parts ?? []).filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n");
    } catch (err) {
      log("debug", "Could not read messages", { error: String(err) });
      return "";
    }
  }

  function evaluateByTranscript(latest: string): GoalEvaluation {
    const now = Date.now();
    const detail = detectMarker(latest, COMPLETE_RE);
    if (detail !== null) {
      return { met: true, reason: `Agent reported completion: ${detail.slice(0, 200) || "(no detail)"}`, confidence: 0.8, timestamp: now, evaluatorType: "heuristic" };
    }
    return { met: false, reason: "No GOAL_COMPLETE signal in latest output yet", confidence: 0.5, timestamp: now, evaluatorType: "heuristic" };
  }

  function recordEvaluation(state: GoalState, evaluation: GoalEvaluation): void {
    state.turnsEvaluated++;
    state.lastEvaluation = evaluation;
    state.evaluationHistory.push(evaluation);
    if (state.evaluationHistory.length > 10) state.evaluationHistory.shift();
  }

  async function evaluate(state: GoalState, sessionId: string): Promise<void> {
    if (isEvaluating) return;
    const now = Date.now();
    // Debounce rapid idle bursts. Fails SAFE: if an injected turn finishes within
    // the window the loop stalls rather than spins; turns normally exceed it.
    if (now - lastEvaluationTime < CONFIG.evaluationDebounceSec * 1000) return;
    isEvaluating = true;
    lastEvaluationTime = now;
    try {
      const constraint = checkConstraints(state);
      if (constraint.exceeded) {
        const fresh = readGoalState(directory);
        if (!fresh || fresh.status !== "active" || fresh.id !== state.id) return;
        fresh.status = "cleared";
        fresh.completedAt = now;
        fresh.lastEvaluation = { met: false, reason: constraint.reason, confidence: 1.0, timestamp: now, evaluatorType: "deterministic" };
        fresh.evaluationHistory.push(fresh.lastEvaluation);
        writeGoalStateAtomic(directory, fresh);
        await notify(sessionId, "Goal stopped", constraint.reason, "warning");
        return;
      }

      const latest = await getLatestAssistantText(sessionId);
      const blockedText = detectMarker(latest, BLOCKED_RE);
      if (blockedText !== null) {
        const fresh = readGoalState(directory);
        if (!fresh || fresh.status !== "active" || fresh.id !== state.id) return;
        recordEvaluation(fresh, { met: false, blocked: true, reason: `Agent reported blocked: ${blockedText.slice(0, 200) || "(no detail)"}`, confidence: 0.8, timestamp: now, evaluatorType: "heuristic" });
        fresh.status = "paused";
        fresh.pausedAt = now;
        writeGoalStateAtomic(directory, fresh);
        await notify(sessionId, "Goal paused (blocked)", fresh.lastEvaluation!.reason, "warning");
        return;
      }

      const evaluation = state.command ? await evaluateDeterministic(state.command) : evaluateByTranscript(latest);

      const fresh = readGoalState(directory);
      if (!fresh || fresh.status !== "active" || fresh.id !== state.id) return;
      recordEvaluation(fresh, evaluation);

      if (evaluation.met) {
        fresh.status = "achieved";
        fresh.completedAt = Date.now();
        writeGoalStateAtomic(directory, fresh);
        await notify(sessionId, "Goal achieved", evaluation.reason, "success");
        return;
      }

      writeGoalStateAtomic(directory, fresh);
      await client.session
        .prompt({
          path: { id: sessionId },
          body: {
            parts: [
              {
                type: "text",
                text:
                  `[GOAL] Not yet met (${evaluation.reason}). Keep working toward: ${fresh.condition}\n` +
                  `When satisfied, write a line beginning "GOAL_COMPLETE:" with the evidence. ` +
                  `If truly blocked, write a line beginning "GOAL_BLOCKED:" explaining why.`,
              },
            ],
          },
        })
        .catch((err) => log("error", "Failed to inject continue prompt", { error: String(err) }));
    } catch (err) {
      log("error", "Evaluation loop failed", { error: String(err) });
    } finally {
      isEvaluating = false;
    }
  }

  return {
    // ── Conversational tools ─────────────────────────────────────────────────
    // These let the user manage goals by just TALKING to OpenCode ("keep going
    // until the tests pass", "what's my goal?", "stop the goal") — no /goal
    // syntax. The agent picks the right tool from these descriptions. `tool.schema`
    // is the host's own zod instance, so no separate dependency is needed.
    tool: {
      set_goal: tool({
        description:
          "Set a persistent goal that you must keep working toward until it is met — even across multiple turns. " +
          "Call this whenever the user expresses an ongoing objective: \"keep going until X\", \"don't stop until Y\", " +
          "\"work until the tests pass\", \"loop until the build is green\", or similar. " +
          "Prefer a `command` when success is checkable by a shell command (it's verified deterministically, exit 0 = done).",
        args: {
          condition: tool.schema.string().describe("The success condition in plain language, e.g. 'all unit tests pass'."),
          command: tool.schema
            .string()
            .optional()
            .describe("Optional shell command that exits 0 exactly when the goal is met, e.g. 'npm test'. Strongly preferred when one exists."),
          maxTurns: tool.schema.number().int().positive().optional().describe("Stop after this many evaluation turns (default 20)."),
          maxMinutes: tool.schema.number().int().positive().optional().describe("Stop after this many minutes (default 30)."),
        },
        async execute(args, ctx) {
          const res = setGoalFields(ctx.directory, {
            condition: args.condition,
            command: args.command ?? null,
            maxTurns: args.maxTurns,
            maxMinutes: args.maxMinutes,
          });
          if (!res.ok) return `Could not set the goal: ${res.error}`;
          return goalInstructions(res.state!, res.replaced ?? null);
        },
      }),

      goal_status: tool({
        description: "Report the current goal and its progress (condition, status, turns/time used, verification command). Use when the user asks 'what's my goal?', 'how's it going?', or 'is there an active goal?'.",
        args: {},
        async execute(_args, ctx) {
          return plainStatus(ctx.directory);
        },
      }),

      clear_goal: tool({
        description: "Clear/stop the active goal so OpenCode stops working toward it. Use when the user says 'stop the goal', 'cancel it', 'we're done with that goal', or 'clear the goal'.",
        args: {},
        async execute(_args, ctx) {
          const res = transitionGoal(ctx.directory, "clear");
          return res.ok ? res.message! : res.error!;
        },
      }),

      pause_goal: tool({
        description: "Pause the active goal (the auto-loop stops nudging) without discarding it, so unrelated work can happen. Use for 'pause the goal' / 'hold off on the goal for a sec'.",
        args: {},
        async execute(_args, ctx) {
          const res = transitionGoal(ctx.directory, "pause");
          return res.ok ? res.message! : res.error!;
        },
      }),

      resume_goal: tool({
        description: "Resume a paused goal and continue working toward it. Use for 'resume the goal' / 'back to the goal'.",
        args: {},
        async execute(_args, ctx) {
          const res = transitionGoal(ctx.directory, "resume");
          if (!res.ok) return res.error!;
          const state = readGoalState(ctx.directory);
          return state ? `Goal resumed. Continue working toward: ${state.condition}` : res.message!;
        },
      }),
    },

    config: async (cfg: any) => {
      try {
        cfg.command ??= {};
        if (!cfg.command.goal) {
          cfg.command.goal = {
            template: COMMAND_TEMPLATE,
            description: "Set/view/clear/pause/resume a task goal; OpenCode keeps working until it's met.",
            agent: "build",
          };
        }
      } catch (err) {
        log("error", "config hook failed to register /goal command", { error: String(err) });
      }
    },

    "command.execute.before": async (input, output) => {
      if (input.command !== "goal") return;
      const text = dispatchGoalCommand(directory, input.arguments ?? "");
      // We hand the host an input-shaped text part; OpenCode fills id/sessionID/
      // messageID. The cast is deliberate (the hook's output.parts is typed as
      // the fully-resolved Part, but the host treats command.execute.before as
      // a rewrite hook that supplies just the content — see the smoke test in
      // the README). We APPEND rather than wholesale-replace so any preamble
      // parts the host put in (e.g. an icon or a slash-command descriptor) are
      // preserved. This is the one piece that can only be confirmed against a
      // live OpenCode — see the smoke test in the README.
      const part = { type: "text", text } as unknown as (typeof output.parts)[number];
      output.parts = [...output.parts, part];
    },

    event: async ({ event }) => {
      // The host invokes this for every SDK event. We dispatch on the
      // discriminated union type so a future SDK addition forces a compile
      // error here (the `default` is exhaustive-checked). The two events we
      // care about for the auto-loop:
      //
      //   - "permission.updated" → a tool wants to ask the user for permission;
      //     we add the permission id to the pending set so the session.idle
      //     handler skips evaluation. Otherwise nudging would orphan the
      //     request ("permission request not found" — the v0.1.0 bug).
      //   - "permission.replied" → the user answered; we remove the id from
      //     the pending set. If a reply never arrives, the entry stays — a
      //     stalled goal is harmless; an orphaned permission is not.
      //   - "session.idle" → the auto-loop fires (below).
      switch (event.type) {
        case "permission.updated": {
          const { sessionID, id } = event.properties;
          pendingPermissions.add(sessionID, id);
          return;
        }
        case "permission.replied": {
          const { sessionID, permissionID } = event.properties;
          pendingPermissions.remove(sessionID, permissionID);
          return;
        }
        case "session.idle": {
          const sessionId = event.properties.sessionID;
          if (!sessionId) return;
          if (pendingPermissions.has(sessionId)) {
            log("debug", "skipping evaluation: permission request pending", { sessionId });
            return;
          }
          const state = readGoalState(directory);
          if (!state || state.status !== "active") return;
          await evaluate(state, sessionId);
          return;
        }
        // All other event types are intentionally unhandled. Using a default
        // branch here would let future SDK events silently no-op (the
        // current behavior) but a missing case in the switch would fail
        // typecheck — that's the property we want. The SDK exports a closed
        // discriminated union, so the exhaustiveness check is automatic.
        default:
          return;
      }
    },

    "experimental.session.compacting": async (_input, output) => {
      const state = readGoalState(directory);
      if (!state || (state.status !== "active" && state.status !== "paused")) return;
      output.context.push(
        `\n## ACTIVE GOAL\nCondition: ${state.condition}\nStatus: ${state.status}\n` +
          `Progress: ${state.turnsEvaluated}/${state.constraints.maxTurns} turns\n`
      );
    },
  };
};

const plugin: PluginModule = { id: "goal", server };
export default plugin;
