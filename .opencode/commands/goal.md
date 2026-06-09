---
description: Set, view, pause, resume, or clear a task goal. Usage: /goal set "<condition>" [--command "<check>"] [stop after N turns] [stop after N minutes] — or /goal [view|clear|pause|resume]
agent: build
---

## Goal Command

The user invoked /goal with arguments: `$ARGUMENTS`

Parse the first word as the ACTION. The rest after the action word is the PAYLOAD.

### ACTION: "set" (or no action word — treat as implicit set)

When the first word is "set" (or $ARGUMENTS doesn't start with a known action word):

1. Extract the CONDITION from PAYLOAD (everything after "set", or all of $ARGUMENTS if no action word).
2. Parse constraint overrides from the condition text:
   - `stop after N turns` or `stop after N turn` → maxTurns = N
   - `stop after N minutes` or `stop after N minute` → maxTimeMinutes = N
   - `stop after Nk tokens` or `stop after N tokens` → maxTokens = N (or N*1000 if "k" present)
   - `--command "..."` or `--command '...'` → deterministic check command
3. Strip constraint phrases and --command flag from the condition before storing (so the evaluator sees a clean condition).
4. If condition is empty or only whitespace, respond: "Error: Goal condition cannot be empty. Usage: /goal set \"<condition>\""
5. If condition exceeds 4000 characters, respond: "Error: Goal condition must be 4000 characters or fewer."
6. Check if `.opencode/.goal-state.json` already exists and has status "active" or "paused":
   - If yes, note: "Replacing existing goal: `<old condition>`"
7. Generate a UUID and timestamp using Node.js:
   ```
   UUID: !`node -e "process.stdout.write(crypto.randomUUID())"`
   TIMESTAMP: !`node -e "process.stdout.write(String(Date.now()))"`
   ```
8. Write `.opencode/.goal-state.json` with:
   ```json
   {
     "version": 1,
     "id": "<UUID>",
     "condition": "<cleaned condition>",
     "command": "<extracted command or null>",
     "status": "active",
     "createdAt": <TIMESTAMP>,
     "startedAt": <TIMESTAMP>,
     "completedAt": null,
     "pausedAt": null,
     "resumedAt": null,
     "turnsEvaluated": 0,
     "tokensUsed": 0,
     "lastEvaluation": null,
     "evaluationHistory": [],
     "constraints": {
       "maxTurns": <parsed or 20>,
       "maxTimeMinutes": <parsed or 30>,
       "maxTokens": <parsed or 100000>
     },
     "metadata": {
       "setBy": "user"
     }
   }
   ```
9. Confirm to user with a summary:
   ```
   Goal set: "<condition>"
   Constraints: max <N> turns, max <N> minutes
   Verification: <command or "model-based evaluation">
   ```
   If a previous goal was replaced, prefix with "Replaced previous goal. "

### ACTION: "view", empty, or omitted

1. Attempt to read `.opencode/.goal-state.json`.
2. If file does not exist or is unreadable:
   Respond: "No active goal. Set one with `/goal set \"<condition>\"`"
3. If file exists but status is "cleared":
   Respond: "No active goal (last goal was cleared). Set one with `/goal set \"<condition>\"`"
4. If status is "active" or "paused":
   Calculate elapsed time from `startedAt` to now.
   Display formatted status:
   ```
   ╔══════════════════════════════════════════════════════╗
   ║ GOAL: <condition>                                    ║
   ║ Status: <Active or PAUSED>                           ║
   ║ Progress: <turnsEvaluated>/<maxTurns> turns          ║
   ║ Time: <elapsed minutes>m / <maxTimeMinutes>m         ║
   ║ Tokens: ~<tokensUsed> / <maxTokens>                  ║
   ║ Verification: <command or "model evaluation">        ║
   ║ Last check: <lastEvaluation.reason or "none yet">    ║
   ╚══════════════════════════════════════════════════════╝
   ```
5. If status is "achieved":
   ```
   Goal achieved! "<condition>"
   Completed in <turnsEvaluated> turns, <elapsed> minutes
   ```

### ACTION: "clear", "stop", "off", "reset", "none", or "cancel"

1. Read `.opencode/.goal-state.json`.
2. If no file or status is already "cleared" or "achieved" (cleared after achievement):
   Respond: "No active goal to clear."
3. If status is "active" or "paused":
   Set `status` to "cleared", set `completedAt` to now.
   Write the file back.
   Respond: "Goal cleared. `<turnsEvaluated>` turns were evaluated before clearing."

### ACTION: "pause"

1. Read state file.
2. If no file or status is not "active":
   If paused: "Goal is already paused."
   If cleared/achieved: "No active goal to pause."
   If no file: "No goal to pause."
3. Set `status` to "paused", set `pausedAt` to now. Write back.
   Respond: "Goal paused. Use `/goal resume` to continue. The goal condition will be preserved."

### ACTION: "resume"

1. Read state file.
2. If no file or status is not "paused":
   If active: "Goal is already active."
   If achieved: "This goal was already achieved. Set a new goal instead."
   If cleared: "This goal was cleared. Set a new goal instead."
   If no file: "No goal to resume."
3. Set `status` to "active", set `resumedAt` to now. Write back.
   Respond: "Goal resumed. `<turnsEvaluated>` turns completed so far."

### ACTION: "template" or "use"

1. Extract template name from PAYLOAD (first word after "template"/"use").
2. If no template name: "Usage: /goal template <name>. Available templates are in .opencode/goals/"
3. Look for `.opencode/goals/<name>.json`.
4. If template file not found: "Template '<name>' not found. Create it at .opencode/goals/<name>.json"
5. Load template JSON. Merge with any remaining arguments as overrides.
6. Write goal state as if "set" was used (same ID/timestamp generation).
7. Confirm: "Goal set from template '<name>': <template.description>"

### IMPORTANT IMPLEMENTATION NOTES

- Use the `write` tool to create/modify `.opencode/.goal-state.json`
- Use the `read` tool to read `.opencode/.goal-state.json`
- Timestamps are Unix milliseconds
- The condition text in the state file must be CLEAN — constraint phrases and --command flag removed
- If Node.js is unavailable for UUID/timestamp generation, fall back to: `!`date +%s%3N`` (Unix) or a timestamp-based identifier
- Always handle the case where the state file exists but is malformed JSON: treat as "no goal" and offer to overwrite
- Never delete the state file — always update it in place so evaluation history is preserved
