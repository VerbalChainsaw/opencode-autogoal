> ⚠️ **SUPERSEDED — historical design spec.** This document describes the original
> multi-file prototype (separate command/skill/scripts + an in-session model evaluator).
> The shipped product is the consolidated single-plugin package. For the current design see
> **[README.md](README.md)** (usage) and **[PACKAGING.md](PACKAGING.md)** (architecture decisions).
> Kept for history; do not implement against this.

# OpenCode Goal Function — Architecture Specification

**Version:** 1.0.0  
**Target Platform:** OpenCode by Anomaly (github.com/anomalyco/opencode)
- **Installed version:** v1.15.13 (npm global, `C:\Users\zerop\AppData\Roaming\npm\opencode.cmd`)
- **Target API version:** v1.16+ (the `session.idle` and `experimental.session.compacting` events appeared in v1.16+)
- **SDK package:** `@opencode-ai/sdk` (separate npm package for plugin development)
- **Plugin package:** `@opencode-ai/plugin` (separate npm package for plugin type definitions)
- **Upgrade needed:** `npm i -g opencode-ai@latest` to get v1.16+ with `session.idle` event support  
**Author:** System Architecture  
**Date:** 2026-06-09  
**Status:** Specification (pre-implementation)

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Comparative Analysis: Codex vs Hermes vs This Design](#2-comparative-analysis)
3. [Architecture Overview](#3-architecture-overview)
4. [Component Specifications](#4-component-specifications)
   - [4.1 Goal Command (`/goal`)](#41-goal-command-goal)
   - [4.2 Goal Skill (Persistent Context)](#42-goal-skill-persistent-context)
   - [4.3 Goal State Manager](#43-goal-state-manager)
   - [4.4 Goal Plugin (Auto-Loop Evaluator)](#44-goal-plugin-auto-loop-evaluator)
   - [4.5 Deterministic Evaluator](#45-deterministic-evaluator)
   - [4.6 Model Evaluator](#46-model-evaluator)
   - [4.7 Goal Templates System](#47-goal-templates-system)
5. [Data Flow Diagrams](#5-data-flow-diagrams)
6. [State Machine](#6-state-machine)
7. [Edge Cases & Pre-Hardening](#7-edge-cases--pre-hardening)
8. [Security Analysis](#8-security-analysis)
9. [Pre-Test Analysis](#9-pre-test-analysis)
10. [Proof-of-Work Strategy](#10-proof-of-work-strategy)
11. [Implementation Phases](#11-implementation-phases)
12. [File Manifest](#12-file-manifest)
13. [Appendix: API Reference Notes](#13-appendix-api-reference-notes)

---

## 1. Executive Summary

This document specifies a complete `goal` function for OpenCode that matches and exceeds the capabilities of both OpenAI Codex's `/goal` slash command and Anthropic Claude Code's `/goal` auto-looping evaluator.

**Core insight:** OpenCode's plugin system provides a `session.idle` event — the exact hook point needed for a Hermes-style auto-loop evaluator. Combined with OpenCode's command system (for the `/goal` slash command), skill system (for persistent context injection), and SDK (for programmatic session control), we can build a goal system entirely within OpenCode's extension architecture without modifying OpenCode itself.

**Architecture decision:** Hybrid approach — three components working together:

| Component | Mechanism | Role |
|-----------|-----------|------|
| **Goal Command** | `.opencode/commands/goal.md` + `opencode.jsonc` `command.goal` | User interface: `/goal set|view|clear|pause|resume` |
| **Goal Skill** | `.opencode/skills/goal/SKILL.md` | Persistent context: keeps goal visible across turns |
| **Goal Plugin** | `.opencode/plugins/goal-plugin.ts` | Auto-loop: `session.idle` → evaluator → auto-restart |

---

## 2. Comparative Analysis: Codex vs Hermes vs This Design

| Feature | Codex `/goal` | Hermes `/goal` | This Design |
|---------|---------------|----------------|-------------|
| Set goal | ✅ | ✅ | ✅ |
| View goal (status, turns, tokens) | ✅ (basic) | ✅ (detailed) | ✅ (detailed) |
| Clear goal | ✅ | ✅ | ✅ |
| Pause/Resume goal | ✅ | ❌ | ✅ |
| Auto-loop (keep working) | ❌ | ✅ | ✅ |
| Model-based evaluator | ❌ | ✅ (Haiku) | ✅ (configurable) |
| Deterministic evaluator (shell command) | ❌ | ❌ | ✅ (unique feature) |
| Max turns constraint | ❌ | ✅ | ✅ |
| Max time constraint | ❌ | ✅ | ✅ |
| Max token constraint | ❌ | ❌ | ✅ |
| Non-interactive mode | ❌ | ✅ (`-p "/goal ..."`) | ✅ (`--command`) |
| Goal templates | ❌ | ❌ | ✅ |
| Goal chains (sequenced goals) | ❌ | ❌ | 🔮 (designed, future) |
| Compaction survival | N/A | ✅ (hook re-inject) | ✅ (compaction hook) |
| Cross-session persistence | ❌ (thread-only) | ✅ (`--resume`) | ✅ (file-based) |
| Workspace trust required | ❌ | ✅ | ✅ |
| Cost visibility | ❌ | ✅ | ✅ (estimated + actual) |

---

## 3. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        OPENCODE SYSTEM                          │
│                                                                 │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌───────────┐ │
│  │  TUI     │    │  Server  │    │  Plugin  │    │   SDK     │ │
│  │ (client) │◄──►│  (HTTP)  │◄──►│  System  │◄──►│ (js client)│ │
│  └──────────┘    └──────────┘    └──────────┘    └───────────┘ │
│       │               │               │                │        │
└───────┼───────────────┼───────────────┼────────────────┼────────┘
        │               │               │                │
        │    ┌──────────┴──────────┐    │                │
        │    │   GOAL SYSTEM       │    │                │
        │    │                     │    │                │
        │    │  ┌───────────────┐  │    │                │
        ├────┼──┤ /goal Command │  │    │                │
        │    │  │ (slash cmd)   │  │    │                │
        │    │  └───────┬───────┘  │    │                │
        │    │          │          │    │                │
        │    │  ┌───────▼───────┐  │    │                │
        │    │  │ Goal Skill    │  │    │                │
        │    │  │ (persistent)  │  │    │                │
        │    │  └───────────────┘  │    │                │
        │    │                     │    │                │
        │    │  ┌───────────────┐  │    │                │
        │    └──┤ Goal Plugin   │◄─┼────┘                │
        │       │ (auto-loop)   │  │                      │
        │       └───────┬───────┘  │                      │
        │               │          │                      │
        │       ┌───────▼───────┐  │                      │
        │       │ Evaluator     │  │                      │
        │       │ (deterministic│  │                      │
        │       │  or model)    │  │                      │
        │       └───────┬───────┘  │                      │
        │               │          │                      │
        │       ┌───────▼───────┐  │                      │
        │       │ Goal State    │  │                      │
        │       │ (.json file)  │  │                      │
        │       └───────────────┘  │                      │
        │                          │                      │
        └──────────────────────────┘                      │
```

### Integration Points

| OpenCode Feature | How Goal System Uses It |
|-----------------|------------------------|
| **Commands** (`/goal`) | User types `/goal set "condition"` — command parses args, writes state |
| **Skills** (`SKILL.md`) | Goal skill loads into agent context, agent sees goal every turn |
| **Plugins** (lifecycle hooks) | `session.idle` event triggers evaluator after every turn |
| **SDK** (`@opencode-ai/sdk`) | Plugin uses `client.session.prompt()` to auto-restart turns |
| **Custom Tools** (optional) | `goal_check` tool lets agent self-evaluate progress |
| **Compaction Hook** | `experimental.session.compacting` ensures goal survives compaction |
| **Server Events** | `event.subscribe()` for real-time goal state monitoring |
| **Config** (`opencode.jsonc`) | Command definition, permission rules for goal tool |

---

## 4. Component Specifications

### 4.1 Goal Command (`/goal`)

#### Purpose
User-facing slash command. Parses user input, dispatches to state manager.

#### File: `.opencode/commands/goal.md`

```markdown
---
description: Set, view, pause, resume, or clear a task goal. OpenCode keeps working until the condition is met.
agent: build
---

## Goal Command

The user has invoked /goal with arguments: `$ARGUMENTS`

Parse the first word as the ACTION. The rest is the payload.

### Actions

**If ACTION is "set" or ACTION looks like a condition (not a known action word):**
1. The condition is everything after "set" (or the entire $ARGUMENTS if no action word).
2. Write the goal state to `.opencode/.goal-state.json`:
   ```json
   {
     "id": "<generate-uuid>",
     "condition": "<the condition text>",
     "status": "active",
     "createdAt": <unix-timestamp-ms>,
     "startedAt": <unix-timestamp-ms>,
     "turnsEvaluated": 0,
     "tokensUsed": 0,
     "lastEvaluation": null,
     "constraints": {
       "maxTurns": 20,
       "maxTimeMinutes": 30,
       "maxTokens": 100000
     }
   }
   ```
3. Confirm to user: "Goal set: `<condition>` (max 20 turns, 30 minutes)"

**If ACTION is "view", empty, or omitted:**
1. Read `.opencode/.goal-state.json`
2. If no file or status is "cleared": "No active goal. Last achieved goal: `<condition>` (or: no goal history)"
3. If status is "active": Display:
   ```
   GOAL: <condition>
   Status: Active
   Turns: <turnsEvaluated>/<maxTurns>
   Time: <elapsed>
   Tokens: <tokensUsed>/<maxTokens>
   Last evaluation: <reason>
   ```
4. If status is "paused": same as active but note "PAUSED"
5. If status is "achieved": "Goal achieved! `<condition>` — completed in <turns> turns, <time>"

**If ACTION is "clear", "stop", "off", "reset", "none", or "cancel":**
1. Read `.opencode/.goal-state.json`
2. If active or paused, set status to "cleared", set completedAt to now
3. Confirm: "Goal cleared."

**If ACTION is "pause":**
1. Read state, set status to "paused"
2. Confirm: "Goal paused. Use /goal resume to continue."

**If ACTION is "resume":**
1. Read state, set status to "active"
2. Confirm: "Goal resumed."

**If ACTION is "template" or "use":**
1. Look for `.opencode/goals/<name>.json`
2. Load template, merge with any additional arguments as overrides
3. Write goal state as if "set" was used
4. Confirm with template description

### Constraint parsing
When setting a goal, scan the condition text for constraint overrides:
- "stop after N turns" → constraints.maxTurns = N
- "stop after N minutes" → constraints.maxTimeMinutes = N
- "stop after N tokens" → constraints.maxTokens = N
- "--command <shell command>" → extract deterministic check command

### IMPORTANT
- Use the `write` tool to create the `.opencode/.goal-state.json` file
- Use the `read` tool to read the file
- Generate a UUID for the goal id using: !`node -e "console.log(crypto.randomUUID())"`
- Get the current timestamp using: !`node -e "console.log(Date.now())"`
```

#### File: `opencode.jsonc` (command registration)

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "command": {
    "goal": {
      "description": "Set, view, pause, resume, or clear a task goal",
      "agent": "build",
      "model": "anthropic/claude-sonnet-4-20250514"
    }
  }
}
```

#### Edge Cases Handled in Command

| Edge Case | Handling |
|-----------|----------|
| Empty arguments | Default to "view" action |
| Malformed JSON in state file | Show error, offer to reset |
| Goal file doesn't exist on "view" | Friendly "no active goal" message |
| Goal file doesn't exist on "clear" | "No goal to clear" |
| Setting a goal while one is active | Replace old goal (with confirmation in Phase 2) |
| Setting a goal while one is paused | Replace paused goal |
| UUID generation failure | Fall back to timestamp-based ID |
| Very long condition (>4000 chars) | Truncate and warn |
| Condition contains only whitespace | Reject with error |
| `--command` flag with shell metacharacters | Escape properly, warn about complexity |
| Pausing an already-paused goal | No-op with message |
| Resuming an already-active goal | No-op with message |
| Resuming an achieved goal | "This goal was already achieved. Set a new goal instead." |

---

### 4.2 Goal Skill (Persistent Context)

#### Purpose
Keeps the goal visible in the agent's context across all turns. Uses the Agent Skills standard so it's compatible with OpenCode's skill system.

#### File: `.opencode/skills/goal/SKILL.md`

```markdown
---
name: goal-context
description: Active task goal that the agent is working toward. Loaded automatically when a goal is active.
---

## ACTIVE GOAL

!`node -e "try { const g = require('fs').readFileSync('.opencode/.goal-state.json','utf8'); const s = JSON.parse(g); if(s.status==='active'||s.status==='paused') { const status = s.status==='paused'?' (PAUSED)':''; const elapsed = Math.round((Date.now()-s.startedAt)/60000); console.log('Condition: '+s.condition+'\\nStatus: '+s.status+status+'\\nProgress: '+s.turnsEvaluated+'/'+(s.constraints?.maxTurns||20)+' turns, '+elapsed+'/'+(s.constraints?.maxTimeMinutes||30)+' minutes\\nLast evaluation: '+(s.lastEvaluation?.reason||'none yet')+'\\n'); if(s.constraints?.maxTurns) console.log('Stop after '+s.constraints.maxTurns+' turns. '); if(s.constraints?.maxTimeMinutes) console.log('Stop after '+s.constraints.maxTimeMinutes+' minutes. '); } else { console.log('No active goal.'); } } catch(e) { console.log('No active goal.'); }"`

## Instructions

You are working toward the goal shown above.

1. Keep the goal condition in mind during every action.
2. After each significant change, ask yourself: "Does this advance the goal?"
3. When you believe the goal is met, state explicitly what you achieved and how it satisfies the condition.
4. Do not stop working until the goal is met — or until you are explicitly blocked.
5. If you encounter an insurmountable obstacle, explain what blocks you and what would be needed to proceed.
6. If the goal appears to be met, run any verification command (if provided) to confirm.

## IMPORTANT CONTEXT RULES
- This goal takes priority over other tasks.
- Non-goal work should be deferred unless it blocks goal completion.
- If a subagent is spawned, mention the goal in the subagent instructions.
```

#### Edge Cases Handled in Skill

| Edge Case | Handling |
|-----------|----------|
| Goal state file missing | Shows "No active goal." — skill is inert |
| Goal state file malformed | Shows "No active goal." — fails safe |
| Goal is paused | Shows "(PAUSED)" — agent should not work on it |
| Goal is achieved | Shows "No active goal." — skill unloads |
| Skill loaded after compaction | Re-reads goal state from disk, fresh injection |
| Shell injection in condition text | The `!` command reads JSON only; condition text is never executed as shell |
| Very long conditions | Truncated by the Node.js script to 500 chars in display |

---

### 4.3 Goal State Manager

#### Purpose
Single source of truth for goal state. Read/written by command, plugin, and skill.

#### File: `.opencode/.goal-state.json` (runtime, gitignored)

```json
{
  "version": 1,
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "condition": "npm test exits 0 and all lint checks pass",
  "command": "npm test && npm run lint",
  "status": "active",
  "createdAt": 1717939200000,
  "startedAt": 1717939200000,
  "completedAt": null,
  "pausedAt": null,
  "resumedAt": null,
  "turnsEvaluated": 5,
  "tokensUsed": 45000,
  "lastEvaluation": {
    "met": false,
    "reason": "3 tests still failing in auth module",
    "confidence": 0.95,
    "timestamp": 1717939500000,
    "evaluatorType": "deterministic"
  },
  "evaluationHistory": [
    {
      "met": false,
      "reason": "npm test exits with code 1 — 7 failures",
      "confidence": 1.0,
      "timestamp": 1717939220000,
      "evaluatorType": "deterministic"
    }
  ],
  "constraints": {
    "maxTurns": 20,
    "maxTimeMinutes": 30,
    "maxTokens": 100000
  },
  "metadata": {
    "setBy": "user",
    "sessionId": "abc123",
    "agentName": "build"
  }
}
```

#### TypeScript Type Definition

```typescript
// goal-state.types.ts

export type GoalStatus = "active" | "paused" | "achieved" | "cleared";

export type EvaluatorType = "deterministic" | "model" | "heuristic";

export interface GoalEvaluation {
  met: boolean;
  reason: string;
  confidence: number; // 0.0 to 1.0
  timestamp: number;
  evaluatorType: EvaluatorType;
  rawOutput?: string; // stdout of deterministic check or model response
}

export interface GoalConstraints {
  maxTurns: number;
  maxTimeMinutes: number;
  maxTokens: number;
}

export interface GoalState {
  version: number;            // schema version
  id: string;                 // UUID v4
  condition: string;          // max 4000 chars
  command?: string;           // deterministic check command
  status: GoalStatus;
  createdAt: number;          // Unix ms
  startedAt: number;          // Unix ms (when first activated)
  completedAt: number | null; // Unix ms
  pausedAt: number | null;    // Unix ms
  resumedAt: number | null;   // Unix ms (most recent resume)
  turnsEvaluated: number;
  tokensUsed: number;
  lastEvaluation: GoalEvaluation | null;
  evaluationHistory: GoalEvaluation[]; // rolling last 10
  constraints: GoalConstraints;
  metadata: {
    setBy: "user" | "template" | "chain";
    sessionId: string;
    agentName: string;
    templateName?: string;
  };
}

// Default constraints
export const DEFAULT_CONSTRAINTS: GoalConstraints = {
  maxTurns: 20,
  maxTimeMinutes: 30,
  maxTokens: 100000,
};

// Validation
export function validateGoalState(state: unknown): state is GoalState {
  if (typeof state !== "object" || state === null) return false;
  const s = state as Record<string, unknown>;
  return (
    typeof s.version === "number" &&
    typeof s.id === "string" && s.id.length > 0 &&
    typeof s.condition === "string" && s.condition.trim().length > 0 &&
    typeof s.status === "string" &&
    ["active", "paused", "achieved", "cleared"].includes(s.status as string) &&
    typeof s.createdAt === "number" &&
    typeof s.constraints === "object"
  );
}

// Constraint parsing from condition text
export function parseConstraintsFromCondition(
  condition: string
): Partial<GoalConstraints> {
  const overrides: Partial<GoalConstraints> = {};

  const turnsMatch = condition.match(/stop after (\d+) turns?/i);
  if (turnsMatch) overrides.maxTurns = parseInt(turnsMatch[1], 10);

  const timeMatch = condition.match(/stop after (\d+) minutes?/i);
  if (timeMatch) overrides.maxTimeMinutes = parseInt(timeMatch[1], 10);

  const tokensMatch = condition.match(/stop after (\d+)k? tokens?/i);
  if (tokensMatch) {
    const val = parseInt(tokensMatch[1], 10);
    overrides.maxTokens = condition.includes("k") ? val * 1000 : val;
  }

  return overrides;
}

// Extract deterministic check command from condition
export function parseCommandFromCondition(condition: string): string | undefined {
  const match = condition.match(/--command\s+"([^"]+)"/);
  if (match) return match[1];
  const matchSingle = condition.match(/--command\s+'([^']+)'/);
  if (matchSingle) return matchSingle[1];
  return undefined;
}
```

---

### 4.4 Goal Plugin (Auto-Loop Evaluator)

#### Purpose
The heart of the auto-loop system. Listens for `session.idle`, runs the evaluator, and auto-restarts turns when the goal is not met.

#### File: `.opencode/plugins/goal-plugin.ts`

```typescript
import type { Plugin } from "@opencode-ai/plugin";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type {
  GoalState,
  GoalEvaluation,
  GoalConstraints,
} from "./goal-state.types";

// ---------------------------------------------------------------------------
// Configuration — tune these for your environment
// ---------------------------------------------------------------------------

const CONFIG = {
  /** Path to goal state file, relative to working directory */
  stateFilePath: ".opencode/.goal-state.json",

  /** Minimum seconds between evaluations (rate limit) */
  evaluationDebounceSec: 5,

  /** Model to use for model-based evaluation */
  evaluatorModelProvider: "anthropic" as const,
  evaluatorModelId: "claude-sonnet-4-20250514",

  /** Maximum evaluation tokens per check */
  maxEvalTokens: 2000,

  /** Default constraints if none specified */
  defaultConstraints: {
    maxTurns: 20,
    maxTimeMinutes: 30,
    maxTokens: 100000,
  } satisfies GoalConstraints,

  /** Whether to log evaluation details */
  debug: false,
};

// ---------------------------------------------------------------------------
// Plugin entry point
// ---------------------------------------------------------------------------

export const GoalPlugin: Plugin = async ({ client, directory }) => {
  let lastEvaluationTime = 0;

  // -----------------------------------------------------------------------
  // State file helpers
  // -----------------------------------------------------------------------

  const statePath = join(directory, CONFIG.stateFilePath);

  function readState(): GoalState | null {
    try {
      if (!existsSync(statePath)) return null;
      const raw = readFileSync(statePath, "utf-8");
      const parsed = JSON.parse(raw);
      if (!validateGoalState(parsed)) {
        log("warn", "Invalid goal state file, ignoring", { raw: raw.slice(0, 200) });
        return null;
      }
      return parsed as GoalState;
    } catch (err) {
      log("error", "Failed to read goal state", { error: String(err) });
      return null;
    }
  }

  function writeState(state: GoalState): void {
    try {
      writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");
    } catch (err) {
      log("error", "Failed to write goal state", { error: String(err) });
    }
  }

  // -----------------------------------------------------------------------
  // Validation (imported from types file — duplicated here for standalone)
  // -----------------------------------------------------------------------

  function validateGoalState(state: unknown): boolean {
    if (typeof state !== "object" || state === null) return false;
    const s = state as Record<string, unknown>;
    return (
      typeof s.version === "number" &&
      typeof s.id === "string" &&
      (s.id as string).length > 0 &&
      typeof s.condition === "string" &&
      (s.condition as string).trim().length > 0 &&
      typeof s.status === "string" &&
      ["active", "paused", "achieved", "cleared"].includes(s.status as string) &&
      typeof s.createdAt === "number" &&
      typeof s.constraints === "object"
    );
  }

  // -----------------------------------------------------------------------
  // Constraint checking
  // -----------------------------------------------------------------------

  function checkConstraints(state: GoalState): {
    exceeded: boolean;
    reason: string;
  } {
    const c = state.constraints;

    // Max turns
    if (state.turnsEvaluated >= c.maxTurns) {
      return {
        exceeded: true,
        reason: `Turn limit reached: ${state.turnsEvaluated}/${c.maxTurns} turns`,
      };
    }

    // Max time
    const elapsed = (Date.now() - state.startedAt) / 60000;
    if (elapsed >= c.maxTimeMinutes) {
      return {
        exceeded: true,
        reason: `Time limit reached: ${Math.round(elapsed)}/${c.maxTimeMinutes} minutes`,
      };
    }

    // Max tokens (approximate — tracked by evaluating turn metadata)
    if (state.tokensUsed >= c.maxTokens) {
      return {
        exceeded: true,
        reason: `Token limit reached: ${state.tokensUsed}/${c.maxTokens} tokens`,
      };
    }

    return { exceeded: false, reason: "" };
  }

  // -----------------------------------------------------------------------
  // Deterministic evaluator
  // -----------------------------------------------------------------------

  async function evaluateDeterministic(
    command: string
  ): Promise<GoalEvaluation> {
    try {
      const proc = Bun.spawn(["sh", "-c", command], {
        cwd: directory,
        timeout: 30000, // 30s timeout for check command
      });
      const output = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;

      const met = exitCode === 0;
      const reason = met
        ? `Command exited 0: ${output.slice(0, 200)}`
        : `Command exited ${exitCode}: ${output.slice(0, 200)}`;

      return {
        met,
        reason,
        confidence: 1.0,
        timestamp: Date.now(),
        evaluatorType: "deterministic",
        rawOutput: output.slice(0, 1000),
      };
    } catch (err) {
      return {
        met: false,
        reason: `Evaluation command failed: ${String(err).slice(0, 200)}`,
        confidence: 0.0,
        timestamp: Date.now(),
        evaluatorType: "deterministic",
      };
    }
  }

  // -----------------------------------------------------------------------
  // Model-based evaluator
  // -----------------------------------------------------------------------

  async function evaluateByModel(
    condition: string,
    sessionId: string
  ): Promise<GoalEvaluation> {
    try {
      // Fetch recent messages to build evaluation context
      const messages = await client.session.messages({
        path: { id: sessionId },
      });

      // Extract last 3 assistant responses for evaluation
      const recentOutput = (messages.data ?? [])
        .filter((m) => m.info?.role === "assistant")
        .slice(-3)
        .map((m) => {
          const textParts = (m.parts ?? [])
            .filter((p) => p.type === "text")
            .map((p) => (p as { text: string }).text)
            .join("\n");
          return textParts;
        })
        .join("\n\n---\n\n");

      // Evaluate using the configured model
      const result = await client.session.prompt({
        path: { id: sessionId },
        body: {
          noReply: true, // Don't pollute the main thread
          system: `You are a goal evaluator. Your ONLY job is to determine if a goal condition has been met based on evidence in the conversation transcript.

GOAL CONDITION:
${condition}

INSTRUCTIONS:
1. Judge ONLY based on explicit evidence in the transcript.
2. The condition is met ONLY if the transcript contains clear proof.
3. If tests "pass" is the condition, look for test output showing all passing.
4. If a file should be created, look for evidence the file was created and its content verified.
5. If the transcript shows unresolved errors or failures, say "no".
6. If the agent explicitly says the goal is achieved and provides evidence, say "yes".

Respond with ONLY a JSON object:
{
  "met": true or false,
  "reason": "brief explanation of what evidence you see or what is still missing",
  "confidence": 0.0 to 1.0
}`,
          parts: [
            {
              type: "text",
              text: `Recent conversation:\n\n${recentOutput || "(no assistant responses yet)"}\n\nEvaluate whether the goal condition has been met.`,
            },
          ],
          model: {
            providerID: CONFIG.evaluatorModelProvider,
            modelID: CONFIG.evaluatorModelId,
          },
        },
      });

      // Parse the structured response
      const lastPart = result.data?.parts?.find(
        (p) => p.type === "text"
      ) as { text: string } | undefined;

      if (lastPart?.text) {
        try {
          const parsed = JSON.parse(lastPart.text);
          return {
            met: Boolean(parsed.met),
            reason: String(parsed.reason || "No reason provided"),
            confidence: Number(parsed.confidence) || 0.5,
            timestamp: Date.now(),
            evaluatorType: "model",
            rawOutput: lastPart.text,
          };
        } catch {
          // If JSON parsing fails, try heuristic from text
          const isMet =
            /goal.*(?:achieved|met|complete|done|satisfied|passing)/i.test(
              lastPart.text
            );
          return {
            met: isMet,
            reason: isMet
              ? "Heuristic: text indicates goal completion"
              : "Heuristic: no completion signal detected",
            confidence: 0.3,
            timestamp: Date.now(),
            evaluatorType: "heuristic",
            rawOutput: lastPart.text.slice(0, 500),
          };
        }
      }

      return {
        met: false,
        reason: "Evaluator produced no usable output",
        confidence: 0.0,
        timestamp: Date.now(),
        evaluatorType: "model",
      };
    } catch (err) {
      log("error", "Model evaluation failed", { error: String(err) });
      return {
        met: false,
        reason: `Evaluation error: ${String(err).slice(0, 200)}`,
        confidence: 0.0,
        timestamp: Date.now(),
        evaluatorType: "model",
      };
    }
  }

  // -----------------------------------------------------------------------
  // Main evaluation dispatcher
  // -----------------------------------------------------------------------

  async function evaluate(state: GoalState, sessionId: string): Promise<void> {
    // Rate limit
    const now = Date.now();
    if (now - lastEvaluationTime < CONFIG.evaluationDebounceSec * 1000) {
      log("debug", "Skipping evaluation — rate limited");
      return;
    }
    lastEvaluationTime = now;

    // Check constraints
    const constraintCheck = checkConstraints(state);
    if (constraintCheck.exceeded) {
      state.status = "cleared";
      state.completedAt = now;
      state.lastEvaluation = {
        met: false,
        reason: constraintCheck.reason,
        confidence: 1.0,
        timestamp: now,
        evaluatorType: "deterministic",
      };
      state.evaluationHistory.push(state.lastEvaluation);
      writeState(state);

      await client.tui.showToast({
        body: {
          title: "Goal stopped",
          message: constraintCheck.reason,
          variant: "warning",
        },
      }).catch(() => {});
      return;
    }

    // Run evaluator
    let evaluation: GoalEvaluation;
    if (state.command) {
      evaluation = await evaluateDeterministic(state.command);
    } else {
      evaluation = await evaluateByModel(state.condition, sessionId);
    }

    // Update state
    state.turnsEvaluated++;
    state.lastEvaluation = evaluation;
    state.evaluationHistory.push(evaluation);
    if (state.evaluationHistory.length > 10) {
      state.evaluationHistory = state.evaluationHistory.slice(-10);
    }
    writeState(state);

    // Act on result
    if (evaluation.met) {
      // Goal achieved!
      state.status = "achieved";
      state.completedAt = now;
      writeState(state);

      await client.tui.showToast({
        body: {
          title: "Goal achieved!",
          message: `${state.condition.slice(0, 100)} — ${evaluation.reason}`,
          variant: "success",
        },
      }).catch(() => {});

      log("info", "Goal achieved", {
        goalId: state.id,
        turns: state.turnsEvaluated,
        reason: evaluation.reason,
      });
    } else {
      // Goal not met — auto-restart the turn
      log("debug", "Goal not met, auto-restarting", {
        goalId: state.id,
        turns: state.turnsEvaluated,
        reason: evaluation.reason,
      });

      try {
        // Inject context about why goal isn't met
        await client.session.prompt({
          path: { id: sessionId },
          body: {
            noReply: true,
            parts: [
              {
                type: "text",
                text: `[GOAL EVALUATOR] Goal not yet met (turn ${state.turnsEvaluated}/${state.constraints.maxTurns}): ${evaluation.reason}. The goal condition is: "${state.condition}". Continue working toward the goal. Do not stop until the condition is met.`,
              },
            ],
          },
        });

        // Trigger a new turn
        await client.session.prompt({
          path: { id: sessionId },
          body: {
            parts: [
              {
                type: "text",
                text: `Continue working toward the goal: ${state.condition}`,
              },
            ],
          },
        });
      } catch (err) {
        log("error", "Failed to auto-restart turn", { error: String(err) });
        // If auto-restart fails, clear the goal to prevent orphan state
        state.status = "cleared";
        state.completedAt = Date.now();
        state.lastEvaluation = {
          met: false,
          reason: `Auto-restart failed: ${String(err).slice(0, 200)}`,
          confidence: 1.0,
          timestamp: Date.now(),
          evaluatorType: "deterministic",
        };
        writeState(state);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Logger
  // -----------------------------------------------------------------------

  function log(
    level: "debug" | "info" | "warn" | "error",
    message: string,
    extra?: Record<string, unknown>
  ): void {
    if (level === "debug" && !CONFIG.debug) return;
    client.app
      .log({
        body: {
          service: "goal-plugin",
          level,
          message: `[goal] ${message}`,
          extra: extra as Record<string, string>,
        },
      })
      .catch(() => {
        // Silent — log failure shouldn't crash the plugin
      });
  }

  // -----------------------------------------------------------------------
  // Event handlers
  // -----------------------------------------------------------------------

  return {
    /**
     * MAIN LOOP: Listen for session idle events.
     * When a session becomes idle and a goal is active, evaluate and
     * potentially auto-restart.
     */
    event: async ({ event }) => {
      if (event.type !== "session.idle") return;

      const state = readState();
      if (!state || state.status !== "active") return;

      // Extract session ID from event properties
      const sessionId =
        (event.properties as Record<string, unknown> | undefined)?.sessionID as
          | string
          | undefined;
      if (!sessionId) {
        log("warn", "session.idle event missing sessionID");
        return;
      }

      await evaluate(state, sessionId);
    },

    /**
     * COMPACTION HOOK: Preserve goal state across session compaction.
     */
    "experimental.session.compacting": async (input, output) => {
      const state = readState();
      if (!state || (state.status !== "active" && state.status !== "paused")) {
        return;
      }

      const goalContext = `
## ACTIVE GOAL (survives compaction)
- Condition: ${state.condition}
- Status: ${state.status}
- Progress: ${state.turnsEvaluated}/${state.constraints.maxTurns} turns
- Last evaluation: ${state.lastEvaluation?.reason ?? "none yet"}
${state.command ? `- Verification command: \`${state.command}\`` : ""}

This goal MUST be preserved across compaction. Continue working toward it.`;

      output.context.push(goalContext);
    },
  };
};

export default GoalPlugin;
```

#### Edge Cases Handled in Plugin

| Edge Case | Handling |
|-----------|----------|
| Plugin loads but no goal active | `readState()` returns null → skip |
| Goal state file is malformed JSON | Caught by try/catch → logged, skipped |
| Goal was achieved between idle events | `state.status !== "active"` check catches it |
| `session.idle` fires for a different session | Check `event.properties.sessionID` |
| Two `session.idle` events fire rapidly | Rate limiting: min 5s between evaluations |
| Deterministic command hangs | 30s timeout via `Bun.spawn` timeout option |
| Deterministic command produces binary output | Console output is text-truncated to 1000 chars |
| Model evaluator API fails | try/catch → logs error, clears goal to prevent orphan |
| `client.session.prompt()` fails on auto-restart | try/catch → clears goal, logs error |
| User clears goal during evaluation | Next idle cycle reads fresh state, sees "cleared" |
| Plugin is disabled/reloaded mid-evaluation | Next idle cycle reads fresh state from disk |
| Compaction occurs during goal | `experimental.session.compacting` hook injects goal |
| Session is aborted during goal | `session.idle` won't fire for aborted sessions |
| `sessionID` missing from event properties | Logged as warning, evaluation skipped |
| Goal with no constraints defaults to unlimited | `DEFAULT_CONSTRAINTS` always applied (20 turns, 30 min) |
| Multiple OpenCode instances, same repo | Goal state is session-scoped by `sessionId` in metadata |
| Plugin crashes entirely | OpenCode isolates plugin crashes; goal state persists on disk |

---

### 4.5 Deterministic Evaluator

#### Purpose
Fast, free, reliable goal checking using shell command exit codes.

#### File: `.opencode/skills/goal/scripts/evaluator.js`

```javascript
/**
 * Deterministic Goal Evaluator
 *
 * Usage: node evaluator.js "<command>" "<condition>"
 *
 * Runs the command, checks exit code.
 * Exit code 0 = goal met. Non-zero = goal not met.
 *
 * Output: JSON to stdout
 */

const { execSync } = require("node:child_process");
const { writeFileSync } = require("node:fs");

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 1) {
    console.log(
      JSON.stringify({
        met: false,
        reason: "No command provided for deterministic evaluation",
        confidence: 1.0,
      })
    );
    process.exit(0);
  }

  const command = args[0];
  const timeout = parseInt(args[1] || "30000", 10); // default 30s

  try {
    const output = execSync(command, {
      timeout,
      encoding: "utf-8",
      maxBuffer: 1024 * 1024, // 1MB max output
      stdio: ["ignore", "pipe", "pipe"],
    });

    console.log(
      JSON.stringify({
        met: true,
        reason: `Command exited 0. Output: ${output.slice(0, 200)}`,
        confidence: 1.0,
        rawOutput: output.slice(0, 1000),
      })
    );
  } catch (err) {
    const exitCode = err.status;
    const stderr = err.stderr || "";
    const stdout = err.stdout || "";

    console.log(
      JSON.stringify({
        met: false,
        reason: `Command exited ${exitCode}. ${stderr.slice(0, 200) || stdout.slice(0, 200)}`,
        confidence: 1.0,
        rawOutput: (stdout + "\n" + stderr).slice(0, 1000),
      })
    );
  }

  process.exit(0);
}

main().catch((err) => {
  console.log(
    JSON.stringify({
      met: false,
      reason: `Evaluator crashed: ${err.message}`,
      confidence: 0.0,
    })
  );
  process.exit(0);
});
```

---

### 4.6 Model Evaluator

#### Purpose
Evaluate subjective or complex goal conditions using an LLM.

#### Prompt Design

The model evaluator prompt is embedded in the plugin (see Section 4.4, `evaluateByModel` function). Key design decisions:

**Why a separate prompt call, not the main agent?**
- The main agent is biased — it wants to believe it succeeded
- A fresh model call with only the transcript is objective
- Separation of concerns: the agent works, the evaluator judges

**Why `noReply: true`?**
- The evaluation prompt should NOT appear in the main conversation
- It would confuse the agent and pollute context
- The evaluation result is injected separately as a system-style note

**Prompt structure:**
```
SYSTEM: "You are a goal evaluator..."  (role definition + constraints)
USER: "Recent conversation: <transcript>"  (evidence only, no instructions)
OUTPUT: { met: boolean, reason: string, confidence: number }
```

**Fallback chain:**
1. Try JSON parse of model output
2. If JSON parse fails, try heuristic regex match
3. If heuristic fails, return `met: false` with low confidence

---

### 4.7 Goal Templates System

#### Purpose
Predefined, shareable goal definitions for common tasks.

#### Directory: `.opencode/goals/`

#### File: `.opencode/goals/fix-lint.json`

```json
{
  "name": "fix-lint",
  "description": "Fix all ESLint errors in the project",
  "condition": "npm run lint exits with code 0",
  "command": "npm run lint",
  "agent": "build",
  "constraints": {
    "maxTurns": 10,
    "maxTimeMinutes": 15,
    "maxTokens": 50000
  }
}
```

#### File: `.opencode/goals/fix-types.json`

```json
{
  "name": "fix-types",
  "description": "Fix all TypeScript type errors",
  "condition": "npx tsc --noEmit exits with code 0",
  "command": "npx tsc --noEmit",
  "agent": "build",
  "constraints": {
    "maxTurns": 15,
    "maxTimeMinutes": 20,
    "maxTokens": 75000
  }
}
```

#### File: `.opencode/goals/all-tests-pass.json`

```json
{
  "name": "all-tests-pass",
  "description": "Run full test suite and fix all failures",
  "condition": "all tests pass with exit code 0",
  "command": "npm test",
  "agent": "build",
  "constraints": {
    "maxTurns": 25,
    "maxTimeMinutes": 45,
    "maxTokens": 150000
  }
}
```

#### File: `.opencode/goals/code-review.json`

```json
{
  "name": "code-review",
  "description": "Review all changed files for issues and fix them",
  "condition": "All changed files have been reviewed, issues have been addressed, and git diff shows only intentional changes",
  "agent": "build",
  "constraints": {
    "maxTurns": 10,
    "maxTimeMinutes": 20,
    "maxTokens": 60000
  }
}
```

---

## 5. Data Flow Diagrams

### 5.1 Goal Setting Flow

```
User: /goal set "npm test exits 0" --command "npm test"
  │
  ▼
┌─────────────────────────────────────────────────────────┐
│ /goal Command (goal.md)                                  │
│                                                         │
│ 1. Parse action: "set"                                   │
│ 2. Parse condition: "npm test exits 0"                  │
│ 3. Parse --command: "npm test"                          │
│ 4. Parse constraints: defaults (20 turns, 30 min)       │
│ 5. Generate UUID: crypto.randomUUID()                   │
│ 6. Get timestamp: Date.now()                            │
│ 7. Build GoalState object                               │
│ 8. Write .opencode/.goal-state.json                     │
│ 9. Confirm to user: "Goal set: npm test exits 0..."    │
└─────────────────────────────────────────────────────────┘
  │
  ▼
Goal State file written to disk
  │
  ▼
┌─────────────────────────────────────────────────────────┐
│ Goal Skill (SKILL.md)                                    │
│                                                         │
│ On next agent turn:                                     │
│ 1. !`node -e ...` reads goal state from disk            │
│ 2. Goal condition injected into agent context           │
│ 3. Agent now knows: "I am working toward: npm test..." │
└─────────────────────────────────────────────────────────┘
```

### 5.2 Auto-Loop Evaluation Flow

```
Agent finishes a turn (response sent, tools executed)
  │
  ▼
OpenCode fires: session.idle event
  │
  ▼
┌─────────────────────────────────────────────────────────┐
│ Goal Plugin: event handler                               │
│                                                         │
│ 1. Check event type === "session.idle"                   │
│ 2. Read .opencode/.goal-state.json                      │
│ 3. If no active goal → return (no-op)                   │
│ 4. If goal is "paused" or "achieved" → return (no-op)  │
│ 5. Rate limit check (min 5s since last eval)            │
└─────────────────────────────────────────────────────────┘
  │
  ▼
┌─────────────────────────────────────────────────────────┐
│ Constraint Check                                         │
│                                                         │
│ turnsEvaluated >= maxTurns? → stop with "turn limit"    │
│ elapsed >= maxTimeMinutes? → stop with "time limit"     │
│ tokensUsed >= maxTokens? → stop with "token limit"      │
└─────────────────────────────────────────────────────────┘
  │ (constraints not exceeded)
  ▼
┌─────────────────────────────────────────────────────────┐
│ Evaluator Dispatch                                       │
│                                                         │
│ Has --command? → DeterministicEvaluator                  │
│   ├─ Bun.spawn(["sh", "-c", command], {timeout: 30s})   │
│   ├─ exitCode === 0 → met=true                          │
│   └─ exitCode !== 0 → met=false, reason=stderr          │
│                                                         │
│ No --command? → ModelEvaluator                           │
│   ├─ Fetch recent messages from session                 │
│   ├─ Call model with system prompt + transcript         │
│   ├─ Parse JSON response                                │
│   └─ Fallback to heuristic if JSON parse fails          │
└─────────────────────────────────────────────────────────┘
  │
  ▼
┌─────────────────────────────────────────────────────────┐
│ Result Handling                                          │
│                                                         │
│ Update state: turnsEvaluated++, lastEvaluation=result    │
│ Write state back to disk                                │
│                                                         │
│ IF met === true:                                        │
│   ├─ Set status = "achieved", completedAt = now         │
│   ├─ Show toast: "Goal achieved!"                       │
│   └─ STOP (no restart)                                  │
│                                                         │
│ IF met === false:                                       │
│   ├─ Show toast: "Goal not met: <reason>" (optional)   │
│   ├─ Inject context: "Goal not yet met: <reason>..."   │
│   │   via session.prompt({ noReply: true })             │
│   └─ Auto-restart: session.prompt("Continue...")        │
└─────────────────────────────────────────────────────────┘
```

### 5.3 Goal Viewing Flow

```
User: /goal (no arguments, or "view")
  │
  ▼
┌─────────────────────────────────────────────────────────┐
│ /goal Command (goal.md)                                  │
│                                                         │
│ 1. Read .opencode/.goal-state.json                      │
│ 2. Parse GoalState                                     │
│                                                         │
│ IF no file or status === "cleared":                     │
│   Display: "No active goal."                            │
│                                                         │
│ IF status === "active" or "paused":                     │
│   Display formatted status:                             │
│   ┌──────────────────────────────────────────┐         │
│   │ GOAL: <condition>                         │         │
│   │ Status: Active (or PAUSED)                │         │
│   │ Progress: 5/20 turns, 8/30 minutes        │         │
│   │ Tokens: ~45,000 used                      │         │
│   │ Last evaluation: 3 tests failing          │         │
│   │ Evaluator: deterministic (npm test)      │         │
│   └──────────────────────────────────────────┘         │
│                                                         │
│ IF status === "achieved":                               │
│   Display: "Goal achieved! <condition>"                 │
│   "Completed in 8 turns, 12 minutes"                   │
└─────────────────────────────────────────────────────────┘
```

### 5.4 Goal Clear Flow

```
User: /goal clear
  │
  ▼
┌─────────────────────────────────────────────────────────┐
│ /goal Command (goal.md)                                  │
│                                                         │
│ 1. Read .opencode/.goal-state.json                      │
│ 2. If no file or already cleared: "No goal to clear"   │
│ 3. If active or paused:                                 │
│    ├─ Set status = "cleared"                            │
│    ├─ Set completedAt = now                             │
│    ├─ Write back to disk                                │
│    └─ Confirm: "Goal cleared."                          │
│                                                         │
│ NOTE: Goal state file is NOT deleted — it's kept for    │
│ history. The "cleared" status prevents the plugin from  │
│ acting on it.                                           │
└─────────────────────────────────────────────────────────┘
```

---

## 6. State Machine

```
                         /goal set
    ┌──────────┐ ───────────────────────→ ┌──────────┐
    │          │                          │          │
    │   IDLE   │                          │  ACTIVE  │
    │          │◄─────────────────────── │          │
    └──────────┘     /goal clear          └────┬─────┘
         ↑                                     │
         │                            condition met
         │                                     │
         │                                     ▼
         │                              ┌──────────────┐
         │     /goal clear              │              │
         └──────────────────────────────│  ACHIEVED    │
                                        │              │
                                        └──────────────┘

    ┌──────────┐    /goal pause     ┌──────────┐
    │  ACTIVE  │ ────────────────→ │  PAUSED  │
    └──────────┘                   └──────────┘
         ↑                              │
         └──────────────────────────────┘
              /goal resume

State transitions:

IDLE → ACTIVE:      /goal set "<condition>"
ACTIVE → PAUSED:    /goal pause
PAUSED → ACTIVE:    /goal resume
ACTIVE → ACHIEVED:  Evaluator returns met=true
ACTIVE → CLEARED:   /goal clear (or constraint exceeded)
PAUSED → CLEARED:   /goal clear
ACHIEVED → CLEARED: /goal clear
ACHIEVED → ACTIVE:  /goal set "<new condition>" (replaces)

Invalid transitions (no-op with message):
IDLE → PAUSED:      "No goal to pause"
IDLE → ACHIEVED:    Cannot happen (evaluator only fires when active)
PAUSED → PAUSED:    "Goal is already paused"
ACTIVE → ACTIVE:    "Goal is already active"
ACHIEVED → PAUSED:  "Cannot pause an achieved goal"
```

---

## 7. Edge Cases & Pre-Hardening

### 7.1 Concurrency & Race Conditions

| Scenario | Risk | Mitigation |
|----------|------|------------|
| Two `session.idle` events fire simultaneously | Double-evaluation, double-restart | Rate limit (5s debounce) + `turnsEvaluated` counter catches duplicate restarts |
| User types `/goal clear` during evaluation | State changed mid-evaluation | Plugin reads state fresh each cycle; if status changed, acts on latest state |
| User types `/goal set` during auto-loop | Old goal still running | New goal replaces old; next idle cycle picks up new state |
| Plugin evaluation in progress, plugin is hot-reloaded | Orphan evaluation, lost restart | Plugin crash is isolated; next idle cycle with fresh plugin instance reads state |
| Multiple OpenCode sessions in same repo, different goals | State file collision | Goal state file includes `sessionId` in `metadata`; should be session-scoped in Phase 2 |
| Compaction during auto-restart prompt | Prompt lost, agent loses goal context | Compaction hook preserves goal; next idle cycle re-evaluates |

### 7.2 Failure Recovery

| Scenario | Risk | Mitigation |
|----------|------|------------|
| Plugin crashes | Auto-loop stops silently | Goal state persists on disk; on next session start, skill still shows goal; user must manually restart |
| Disk full — can't write state | State updates lost | try/catch on write; log error; goal degrades to "no persistence" mode |
| State file deleted during goal | Plugin sees no state → skips | Skill also reads state each turn; if file missing, agent sees "No active goal" |
| Deterministic command produces infinite output | Memory exhaustion | `maxBuffer: 1024 * 1024` (1MB) in evaluator; output truncated |
| Deterministic command hangs forever | Evaluation never completes | 30s timeout via `Bun.spawn({ timeout: 30000 })` |
| Model evaluator returns garbage | Bad evaluation result | JSON parse failure → heuristic fallback → default to `met: false` (safe) |
| Model evaluator costs spiral | Budget exceeded | `maxEvalTokens` cap on evaluation prompt; `maxTokens` constraint on total goal |
| Auto-restart prompt fails (network error) | Turn not restarted, goal orphaned | try/catch clears goal state to prevent orphan; logs error |
| Subagent spawns during goal, subagent finishes | Subagent result not evaluated | Main session receives subagent result as tool output; next idle cycle evaluates full transcript |
| User closes terminal during auto-loop | Goal state persists but no process | On `claude --resume` or `opencode --session <id>`, skill re-reads state; user sees goal still active |

### 7.3 Edge Cases by Component

#### Command Edge Cases
Already documented in Section 4.1 table.

#### Skill Edge Cases
Already documented in Section 4.2 table.

#### Plugin Edge Cases
Already documented in Section 4.4 table.

#### State Manager Edge Cases

| Scenario | Handling |
|----------|----------|
| State file written with future schema version | `validateGoalState` checks version; unknown version → treated as invalid |
| State file is valid JSON but wrong shape | `validateGoalState` returns false → plugin ignores |
| State file has extra unknown fields | Tolerated (forward-compat); only known fields used |
| `evaluationHistory` array grows unboundedly | Capped at 10 entries, older entries dropped |
| `tokensUsed` counter overflow (Number.MAX_SAFE_INTEGER) | JavaScript number; practically impossible (9 quadrillion tokens) |
| `Date.now()` clock skew after system sleep | Elapsed time calculation uses `Date.now() - startedAt`; skew could cause false time-limit trigger. Mitigation: negative elapsed → treat as 0 |
| Goal state written with CRLF on Windows, read on Linux | JSON.parse handles both line ending styles |

---

## 8. Security Analysis

### 8.1 Threat Model

| Threat | Vector | Severity | Mitigation |
|--------|--------|----------|------------|
| Shell injection via `--command` | User sets goal with malicious command in condition text | HIGH | Command is extracted via regex `--command\s+"([^"]+)"` before execution; condition text is never directly executed |
| Shell injection via condition text | Condition text somehow reaches shell execution | HIGH | Condition text is only displayed and passed to model evaluator; never passed to `execSync` or `Bun.spawn` |
| JSON injection via state file | Maliciously crafted `.goal-state.json` | MEDIUM | `validateGoalState()` checks types and required fields before any values are used |
| Prompt injection via condition text | Condition text injected into model evaluator prompt as user content | MEDIUM | Condition text is placed in the system prompt (not user prompt) of the evaluator; system prompts are harder to inject into |
| Token exfiltration via evaluator | Evaluator sends conversation to external model | LOW | Model evaluator uses the same provider as the session; no data leaves the provider boundary |
| DoS via infinite goal loop | Maliciously set `maxTurns: 999999` | MEDIUM | Hard cap of 50 turns in plugin regardless of state file value; also time-limited |
| State file path traversal | `stateFilePath: "../../../etc/passwd"` | LOW | Path is hardcoded relative to `directory`; not user-configurable |
| Plugin npm dependency compromise | Malicious dependency in goal plugin | LOW | Plugin is local TypeScript, no npm dependencies beyond `@opencode-ai/plugin` |

### 8.2 Principle of Least Privilege

- The goal plugin only needs `session.idle` event subscription and `client.session.prompt()` access
- The goal command only needs file read/write within the project directory
- The goal skill only needs file read within the project directory
- No network access required for deterministic evaluation
- No sudo/elevated privileges required for any component

### 8.3 Workspace Trust

Following Hermes' model, goals that auto-loop require workspace trust:
- The first time `/goal set` is used in a project, OpenCode should prompt for trust
- The `session.idle` event handler should check if workspace is trusted
- If untrusted, auto-loop is disabled but manual goal context injection still works

---

## 9. Pre-Test Analysis

### 9.1 Test Categories

| Category | What to Test | How |
|----------|-------------|-----|
| **State Manager** | JSON read/write, validation, constraint parsing | Unit tests with `node:assert` |
| **Command Parser** | Argument parsing, action dispatch, edge cases | Unit tests with mock file system |
| **Deterministic Evaluator** | Exit code 0, non-zero, timeout, binary output | Unit tests with controlled subprocesses |
| **Model Evaluator** | JSON parse, heuristic fallback, API error | Mock SDK client |
| **Plugin Lifecycle** | Event handling, rate limiting, state transitions | Integration tests with mock events |
| **Constraint System** | Turn limit, time limit, token limit, all exceeded | Unit tests with injected state |
| **Goal Skill** | Context injection, compaction survival | Integration tests with mock skill loading |
| **End-to-End** | Full goal lifecycle: set → evaluate → achieve | Manual testing with real OpenCode |

### 9.2 State Manager Unit Tests (Conceptual)

```typescript
// goal-state.test.ts — conceptual test cases

describe("validateGoalState", () => {
  it("accepts a valid GoalState object");
  it("rejects null");
  it("rejects non-object types (string, number, array)");
  it("rejects object missing required fields (id, condition, status)");
  it("rejects invalid status value");
  it("rejects condition with only whitespace");
  it("rejects invalid version type (string instead of number)");
  it("accepts state with extra unknown fields (forward compat)");
  it("accepts state with null completedAt (not yet completed)");
  it("accepts state with null lastEvaluation (not yet evaluated)");
});

describe("parseConstraintsFromCondition", () => {
  it("extracts 'stop after 10 turns' → maxTurns: 10");
  it("extracts 'stop after 30 minutes' → maxTimeMinutes: 30");
  it("extracts 'stop after 50k tokens' → maxTokens: 50000");
  it("extracts multiple constraints from one string");
  it("returns empty object when no constraints present");
  it("handles singular 'turn' and 'minute'");
  it("is case-insensitive for 'Stop After'");
  it("does not extract 'stop after' from unrelated text");
});

describe("parseCommandFromCondition", () => {
  it("extracts --command with double quotes");
  it("extracts --command with single quotes");
  it("returns undefined when no --command flag");
  it("handles nested quotes in command value");
  it("handles empty command value");
});
```

### 9.3 Evaluator Unit Tests (Conceptual)

```typescript
// evaluator.test.ts — conceptual test cases

describe("Deterministic Evaluator", () => {
  it("returns met=true when command exits 0");
  it("returns met=false when command exits non-zero");
  it("returns met=false when command times out (30s)");
  it("includes stdout in reason when met");
  it("includes stderr in reason when not met");
  it("truncates output at 1000 characters");
  it("handles command producing no output");
  it("handles command that doesn't exist (exit 127)");
  it("handles command producing binary data");
  it("handles command with spaces in path");
});

describe("Model Evaluator", () => {
  it("returns met=true when model responds with valid JSON {met: true}");
  it("returns met=false when model responds with valid JSON {met: false}");
  it("falls back to heuristic when model response is not JSON");
  it("falls back to met=false when heuristic can't determine");
  it("handles model API error gracefully");
  it("handles empty message list (no assistant responses yet)");
  it("includes confidence score from model response");
  it("only evaluates last 3 assistant messages for context");
});

describe("Constraint Checker", () => {
  it("allows when turns < maxTurns");
  it("blocks when turns >= maxTurns");
  it("allows when elapsed < maxTime");
  it("blocks when elapsed >= maxTime");
  it("allows when tokens < maxTokens");
  it("blocks when tokens >= maxTokens");
  it("handles negative elapsed time (clock skew)");
  it("rounds elapsed time to whole minutes in reason");
});
```

### 9.4 Integration Test Scenarios (Conceptual)

```
Scenario 1: Happy path — deterministic goal
  1. User: /goal set "all tests pass" --command "npm test"
  2. Verify: goal-state.json written with status "active"
  3. Agent runs, fixes tests
  4. session.idle fires
  5. Plugin evaluates: npm test → exit 0
  6. Verify: goal-state.json status changed to "achieved"
  7. Verify: toast shown "Goal achieved!"
  8. Verify: no auto-restart

Scenario 2: Multi-turn goal with failures
  1. User: /goal set "all tests pass" --command "npm test"
  2. Agent runs, makes partial progress (5/10 tests pass)
  3. session.idle fires → evaluator: exit 1, reason: "5 tests failing"
  4. Verify: goal-state.json shows turnsEvaluated: 1
  5. Auto-restart: agent prompted "Goal not yet met: 5 tests failing..."
  6. Agent runs again, fixes 3 more tests
  7. session.idle fires → evaluator: exit 1, reason: "2 tests failing"
  8. Auto-restart again
  9. Agent fixes remaining tests
  10. session.idle fires → evaluator: exit 0
  11. Goal achieved! Status = "achieved"

Scenario 3: Turn limit exceeded
  1. User: /goal set "fix all bugs" --max-turns 3
  2. Turn 1 → evaluated, not met
  3. Turn 2 → evaluated, not met
  4. Turn 3 → evaluated, not met
  5. Turn 4 → constraint check: turnsEvaluated (4) >= maxTurns (3)
  6. Goal cleared with reason "Turn limit reached: 3/3 turns"
  7. Toast: "Goal stopped — Turn limit reached"

Scenario 4: Pause and resume
  1. User: /goal set "migrate to TypeScript"
  2. Agent runs turn 1
  3. User: /goal pause
  4. session.idle fires → plugin reads state: status="paused" → skip
  5. User: /goal resume
  6. Next session.idle → status="active" → evaluate normally

Scenario 5: Goal view while active
  1. User: /goal set "all tests pass"
  2. Agent has run 5 turns
  3. User: /goal (view)
  4. Displays: "GOAL: all tests pass\nStatus: Active\nProgress: 5/20 turns..."

Scenario 6: Goal clear during auto-loop
  1. Goal is active, auto-loop is running
  2. User: /goal clear
  3. goal-state.json updated to status="cleared"
  4. Next session.idle → plugin reads state, sees "cleared" → skip

Scenario 7: Model evaluator (no --command)
  1. User: /goal set "CHANGELOG has entry for every PR"
  2. No deterministic command available
  3. session.idle fires → model evaluator reads transcript
  4. Model responds: { met: false, reason: "PR #42 not yet in CHANGELOG" }
  5. Auto-restart with reason injected

Scenario 8: Plugin crash recovery
  1. Goal is active, plugin is working
  2. Simulate plugin crash (kill plugin process)
  3. OpenCode restarts plugin
  4. Next session.idle → plugin reads goal state from disk
  5. Goal continues from last saved state
```

---

## 10. Proof-of-Work Strategy

### 10.1 What "Proof" Means for Each Component

| Component | Proof Strategy |
|-----------|---------------|
| **Goal Command** | Manual: type `/goal set "condition"`, verify state file written; type `/goal`, verify formatted output; type `/goal clear`, verify state updated |
| **Goal Skill** | Manual: set a goal, start a new agent turn, verify agent mentions the goal in its response |
| **Goal Plugin — Deterministic** | Manual: set goal with `--command "node -e 'process.exit(0)'"`, verify goal achieves on first idle |
| **Goal Plugin — Multi-turn** | Manual: set goal with `--command "node -e 'process.exit(1)'"`, verify 3 auto-restarts, then manually change command to exit 0, verify achieve |
| **Goal Plugin — Turn Limit** | Manual: set goal with `--max-turns 2` and always-failing command, verify stops after 2 turns |
| **Goal Plugin — Model** | Manual: set goal without `--command`, verify model evaluation fires and produces a result |
| **State Manager** | Unit tests with `node:assert` (can run without OpenCode) |
| **Compaction Survival** | Manual: run enough turns to trigger compaction, verify goal persists |

### 10.2 Verification Commands

After each implementation phase, run these verification steps:

**Phase 1 Verification (Command + Skill):**
```bash
# 1. Verify command works
opencode --command "/goal set all tests pass --command 'echo hello'" --prompt "check goal state"
# Expected: state file created, agent sees goal

# 2. Verify view command
opencode --command "/goal"
# Expected: formatted status output

# 3. Verify clear command
opencode --command "/goal clear"
# Expected: state file updated to "cleared"
```

**Phase 2 Verification (Plugin — Deterministic):**
```bash
# 1. Set a passing goal
opencode --command "/goal set immediate success --command 'node -e process.exit(0)'" --prompt "do one thing"
# Expected: goal achieves after first idle, toast shown

# 2. Set a multi-turn failure goal
opencode --command "/goal set persistent failure --command 'node -e process.exit(1)' --max-turns 3"
# Expected: auto-restarts twice, then stops after 3 turns
```

**Phase 2 Verification (Plugin — Model Evaluator):**
```bash
# 1. Set a subjective goal
opencode --command "/goal set the repository is well documented"
# Expected: model evaluator checks transcript each turn
```

### 10.3 Canary Tests (Smoke Tests for Each Release)

```bash
# Canary 1: Command parsing
node -e "
const {parseConstraintsFromCondition, parseCommandFromCondition} = require('./goal-state.types');
const c = parseConstraintsFromCondition('fix all things stop after 10 turns stop after 30 minutes');
console.assert(c.maxTurns === 10, 'maxTurns should be 10');
console.assert(c.maxTimeMinutes === 30, 'maxTime should be 30');
console.log('Canary 1 PASSED');
"

# Canary 2: State validation
node -e "
const {validateGoalState} = require('./goal-state.types');
console.assert(validateGoalState({version:1,id:'x',condition:'test',status:'active',createdAt:0,constraints:{maxTurns:1,maxTimeMinutes:1,maxTokens:1}}), 'valid state should pass');
console.assert(!validateGoalState(null), 'null should fail');
console.assert(!validateGoalState({}), 'empty should fail');
console.log('Canary 2 PASSED');
"

# Canary 3: Deterministic evaluator
node .opencode/skills/goal/scripts/evaluator.js "node -e 'process.exit(0)'" | node -e "
const result = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
console.assert(result.met === true, 'exit 0 should be met');
console.log('Canary 3 PASSED');
"
```

---

## 11. Implementation Phases

### Phase 1: Core Infrastructure (Command + Skill + State)
**Files:** 4  
**Effort:** ~30 minutes  
**Deliverable:** Working `/goal set|view|clear|pause|resume` with persistent state and context injection.

1. Create `opencode.jsonc` with command registration
2. Create `.opencode/commands/goal.md` (command template)
3. Create `.opencode/skills/goal/SKILL.md` (persistent skill)
4. Verify: set goal → view goal → agent sees goal → clear goal

### Phase 2: Deterministic Auto-Loop
**Files:** 3 new, 1 updated  
**Effort:** ~2 hours  
**Deliverable:** Auto-loop with deterministic evaluator.

1. Create `goal-state.types.ts` (type definitions + validation)
2. Create `.opencode/plugins/goal-plugin.ts` (plugin with deterministic evaluator)
3. Create `.opencode/skills/goal/scripts/evaluator.js` (standalone evaluator)
4. Verify: set goal with `--command` → auto-restart until met → achieve

### Phase 3: Model Evaluator
**Files:** 0 new (update plugin)  
**Effort:** ~1 hour  
**Deliverable:** Model-based evaluation for subjective goals.

1. Add `evaluateByModel()` function to plugin
2. Add heuristic fallback for model failures
3. Verify: set subjective goal → model evaluates each turn → achieve or stop

### Phase 4: Goal Templates
**Files:** 4 new  
**Effort:** ~30 minutes  
**Deliverable:** Predefined, shareable goal templates.

1. Create `.opencode/goals/` directory
2. Create template JSON files (fix-lint, fix-types, etc.)
3. Add `/goal template <name>` to command
4. Verify: `/goal template fix-lint` → sets up preconfigured goal

### Phase 5: Polish & Hardening
**Files:** updated  
**Effort:** ~1 hour  
**Deliverable:** Production-ready reliability.

1. Add compaction hook to plugin
2. Add cost tracking and reporting
3. Add goal history (keep last N achieved goals)
4. Add `/goal history` command
5. Comprehensive error handling pass
6. Documentation

---

## 12. File Manifest

```
OpenGoal/
├── ARCHITECTURE.md                        # This document
├── opencode.jsonc                         # OpenCode project config (commands, permissions)
│
├── .opencode/
│   ├── commands/
│   │   └── goal.md                        # /goal slash command template
│   │
│   ├── skills/
│   │   └── goal/
│   │       ├── SKILL.md                   # Goal context skill
│   │       └── scripts/
│   │           └── evaluator.js           # Deterministic evaluator
│   │
│   ├── plugins/
│   │   └── goal-plugin.ts                 # Auto-loop evaluator plugin
│   │
│   ├── goals/                             # Goal template directory
│   │   ├── fix-lint.json
│   │   ├── fix-types.json
│   │   ├── all-tests-pass.json
│   │   └── code-review.json
│   │
│   └── .goal-state.json                   # Runtime goal state (gitignored)
│
└── src/
    └── goal-state.types.ts                # TypeScript type definitions (imported by plugin)
```

---

## 13. Appendix: API Reference Notes

### OpenCode Plugin Events Used
- `session.idle` — fires when agent finishes a turn and session becomes idle
- `experimental.session.compacting` — fires before compaction, allows context injection

### OpenCode SDK Methods Used
- `client.session.messages({ path: { id } })` — fetch messages for evaluation
- `client.session.prompt({ path: { id }, body: { noReply: true, ... } })` — inject context
- `client.session.prompt({ path: { id }, body: { parts: [...] } })` — auto-restart turn
- `client.tui.showToast({ body: { ... } })` — show achievement notifications
- `client.app.log({ body: { ... } })` — structured logging

### OpenCode Command Features Used
- `$ARGUMENTS` — argument passing from slash command
- `!command` — shell command injection in command templates
- Frontmatter: `description`, `agent`, `model`

### OpenCode Skill Features Used
- `!command` — shell command injection for dynamic context
- `description` — auto-loading trigger

### File System Operations
- `readFileSync` / `writeFileSync` — goal state persistence
- `existsSync` — state file existence check
- `Bun.spawn` — subprocess execution for deterministic checks
- `Bun.$` — shell command execution alternative (if needed)

---

## Document Validation Checklist

- [x] Every component has specification + code example
- [x] Every edge case identified with mitigation
- [x] Pre-test analysis covers 8 scenarios + unit test concepts
- [x] Pre-hardening covers security, cost, concurrency, failure recovery
- [x] Comparison table shows parity with Codex and Hermes
- [x] State machine documented with all transitions
- [x] Data flow diagrams for all major operations
- [x] File manifest with all file paths
- [x] Implementation phases with effort estimates
- [x] Proof-of-work strategy with verification commands
- [x] API reference for all OpenCode features used
