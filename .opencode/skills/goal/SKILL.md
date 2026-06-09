---
name: goal-context
description: Active task goal that the agent is working toward. Loads automatically when a goal is active and keeps the condition visible across turns.
---

## ACTIVE GOAL

!`node -e "try { const g = require('fs').readFileSync('.opencode/.goal-state.json','utf8'); const s = JSON.parse(g); if(s.status==='active'||s.status==='paused') { const status = s.status==='paused'?' (PAUSED)':''; const elapsed = Math.round((Date.now()-s.startedAt)/60000); const maxTime = s.constraints?.maxTimeMinutes||30; process.stdout.write('Condition: '+s.condition+'\\nStatus: '+s.status+status+'\\nProgress: '+s.turnsEvaluated+'/'+(s.constraints?.maxTurns||20)+' turns, '+elapsed+'/'+maxTime+' minutes\\nLast evaluation: '+(s.lastEvaluation?.reason||'none yet')+'\\n'); if(s.constraints?.maxTurns) process.stdout.write('Constraint: Stop after '+s.constraints.maxTurns+' turns.\\n'); if(s.constraints?.maxTimeMinutes) process.stdout.write('Constraint: Stop after '+s.constraints.maxTimeMinutes+' minutes.\\n'); if(s.command) process.stdout.write('Verification: `'+s.command+'`\\n'); } else { process.stdout.write('No active goal.\\n'); } } catch(e) { process.stdout.write('No active goal.\\n'); }"`

## Goal-Driven Instructions

You are working toward the goal shown above. Follow these rules:

### Priority
1. **The goal takes priority** over other requests or tangential improvements.
2. Non-goal work should be deferred unless it directly blocks goal completion.
3. If the user asks you to do something unrelated, acknowledge it but note that the active goal takes precedence.

### Progress
4. After each significant action, ask yourself: "Does this advance the goal?"
5. When you believe the goal is met, **state explicitly** what you achieved and how it satisfies the condition.
6. If a verification command is provided above, run it to confirm completion.
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
