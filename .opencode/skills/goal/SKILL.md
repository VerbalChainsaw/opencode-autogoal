---
name: goal-context
description: Active task goal that the agent is working toward. Invoke this skill at the start of each turn to see the current goal condition and progress.
---

## ACTIVE GOAL

!`node .opencode/skills/goal/scripts/read-state.js 2>$null`

If the above shows "No active goal.", there is no goal to work toward.

If Node.js is unavailable, try the PowerShell fallback:
!`pwsh -File .opencode/skills/goal/scripts/read-state.ps1 2>$null`

## Goal-Driven Instructions

You are working toward the goal shown above. Follow these rules.

### At the Start of Every Turn
**CRITICAL**: At the beginning of each response turn, re-read the goal state file using the `read` tool to check if the goal has changed (paused, resumed, cleared, or achieved by the evaluator). The goal state file is at `.opencode/.goal-state.json`. Do NOT rely on stale context from previous turns.

### Priority
1. **The goal takes priority** over other requests or tangential improvements.
2. Non-goal work should be deferred unless it directly blocks goal completion.
3. If the user asks you to do something unrelated, acknowledge it but note that the active goal takes precedence.

### Progress
4. After each significant action, ask yourself: "Does this advance the goal?"
5. When you believe the goal is met, **state explicitly** what you achieved and how it satisfies the condition.
6. If a verification command is provided in the goal state, run it to confirm completion.
7. Do not stop working until the goal is met — or until you are explicitly blocked by an insurmountable obstacle.

### Blockers
8. If you encounter an obstacle you cannot overcome, explain:
   - What specifically blocks you
   - What would be needed to proceed
   - Whether the goal should be modified or abandoned
9. Do not silently give up. Always communicate status.

### Subagents
10. If you spawn a subagent for part of the work, include the goal condition in the subagent's instructions.
11. When a subagent returns results, verify those results against the goal condition.

### Completion
12. When the goal is met, celebrate briefly and clearly state the evidence.
13. If the goal includes a verification command and it passes, note the exit code and output.
14. The goal will be automatically cleared by the evaluator when the condition is confirmed met.
