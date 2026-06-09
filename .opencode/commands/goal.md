---
description: Set, view, pause, resume, or clear a task goal. Usage: /goal set "<condition>" [--command "<check>"] [stop after N turns] [stop after N minutes] — or /goal [view|clear|pause|resume]
agent: build
---

## Goal Command

The user invoked /goal with arguments: `$ARGUMENTS`

Parse the first word as the ACTION. Everything after the action word is the PAYLOAD.

Known action words: set, view, clear, stop, off, reset, none, cancel, pause, resume, template, use
If the first word is NOT one of these, treat as implicit "set" and use the entire $ARGUMENTS as the condition.

**Platform detection (do first):**
Check if Node.js is available:
```
!`node -e "process.exit(0)" 2>$null && echo "HAS_NODE" || echo "NO_NODE"`
```
If the output contains "HAS_NODE", use `node .opencode/skills/goal/scripts/...js` for script execution.
If the output contains "NO_NODE", use `pwsh -File .opencode/skills/goal/scripts/...ps1` instead.

Define these helpers (use the appropriate one based on platform):
- ID_CMD: `node .opencode/skills/goal/scripts/gen-id.js` or `pwsh -File .opencode/skills/goal/scripts/gen-id.ps1`
- WRITE_CMD_PREFIX: `node .opencode/skills/goal/scripts/write-state.js` or `pwsh -File .opencode/skills/goal/scripts/write-state.ps1`
- READ_CMD: `node .opencode/skills/goal/scripts/read-state.js` or `pwsh -File .opencode/skills/goal/scripts/read-state.ps1`

---

### ACTION: "set" (or implicit set when no action word matched)

1. Extract the CONDITION from PAYLOAD (everything after "set", or all of $ARGUMENTS if implicit set).

2. If condition is empty or only whitespace:
   Respond: "Error: Goal condition cannot be empty. Usage: /goal set \"<condition>\""

3. If condition exceeds 4000 characters:
   Respond: "Error: Goal condition must be 4000 characters or fewer. Current length: <N>"

4. Parse constraint overrides from the condition text:
   - Match `stop after (\d+) turns?` → maxTurns = captured number
   - Match `stop after (\d+) minutes?` → maxTimeMinutes = captured number
   - Match `stop after (\d+)k? tokens?` → maxTokens = captured number (×1000 if "k" present)
   - Match `--command "([^"]+)"` or `--command '([^']+)'` → command = captured string
   Defaults if not specified: maxTurns=20, maxTimeMinutes=30, maxTokens=100000

5. Strip constraint phrases and --command flag from the condition text to produce CLEAN_CONDITION.

6. Check if `.opencode/.goal-state.json` already exists and has status "active" or "paused":
   Use the Read tool to read `.opencode/.goal-state.json`.
   If it exists and has an active/paused goal, note the old condition for the confirmation message.

7. Generate an ID and timestamp — run ONE of these commands and parse the JSON output:
   ```
   !`{{ID_CMD}}`
   ```
   The output is JSON: `{"id":"<uuid>","timestamp":<unix-ms>}`
   Parse it. Extract `id` and `timestamp` values.

8. Construct the goal state JSON object. Here is the exact structure:
   ```json
   {
     "version": 1,
     "id": "<id from gen-id>",
     "condition": "<CLEAN_CONDITION>",
     "command": "<parsed command or null>",
     "status": "active",
     "createdAt": <timestamp from gen-id>,
     "startedAt": <timestamp from gen-id>,
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
   This must be valid JSON. Escape any double quotes in the condition text.

9. Write the state file using the atomic write script. Pass the JSON as a single argument:
   ```
   !`{{WRITE_CMD_PREFIX}} '<json-string>'`
   ```
   IMPORTANT: The JSON must be on a single line and properly escaped for the shell.
   If the condition contains single quotes, use double-quote wrapping and escape internal double quotes.
   Verify the output contains "OK". If it contains "ERROR", report the error to the user.

10. Confirm to user:
    If replacing an old goal: "Replaced previous goal: `<old condition>`\n"
    "Goal set: `<CLEAN_CONDITION>`"
    If command was extracted: "Verification: `<command>`"
    "Constraints: max <maxTurns> turns, max <maxTimeMinutes> minutes"
    If constraints were overridden from defaults, note: "(custom)"

---

### ACTION: "view", empty, or omitted

1. Run the read-state script and capture output:
   ```
   !`{{READ_CMD}}`
   ```

2. If the output starts with "No active goal":
   Check if there's a `.opencode/.goal-state.json` file at all (use the Read tool).
   If no file: "No active goal. Set one with `/goal set \"<condition>\"`"
   If file exists but status is "cleared": "No active goal (last goal was cleared)."
   If file exists but status is "achieved": Display "Goal achieved! `<condition>` — completed in `<turns>` turns, `<time>` minutes" using data from the state file.

3. If the read-state script produced output (status is active or paused):
   Display it as-is. The script already formats the status nicely.

---

### ACTION: "clear", "stop", "off", "reset", "none", or "cancel"

1. Read the current state file using the Read tool: read `.opencode/.goal-state.json`.

2. If file doesn't exist:
   Respond: "No active goal to clear."

3. Parse the JSON. If status is already "cleared" or "achieved":
   Respond: "No active goal to clear."

4. If status is "active" or "paused":
   - Change `status` to "cleared"
   - Set `completedAt` to the current timestamp:
     ```
     !`node -e "process.stdout.write(String(Date.now()))" 2>$null || pwsh -Command "[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()"`
     ```
   - Write the updated JSON back using the Write tool to `.opencode/.goal-state.json`
   - Respond: "Goal cleared. <turnsEvaluated> turns were evaluated before clearing."

---

### ACTION: "pause"

1. Read `.opencode/.goal-state.json` using the Read tool.

2. If no file or status is "paused": "Goal is already paused."
   If status is "cleared" or "achieved": "No active goal to pause."

3. If status is "active":
   - Change `status` to "paused"
   - Set `pausedAt` to the current timestamp (use same technique as clear action)
   - Write back using the Write tool
   - Respond: "Goal paused. Use `/goal resume` to continue."

---

### ACTION: "resume"

1. Read `.opencode/.goal-state.json` using the Read tool.

2. If no file or status is "active": "Goal is already active."
   If status is "achieved": "This goal was already achieved. Set a new goal instead."
   If status is "cleared": "This goal was cleared. Set a new goal instead."

3. If status is "paused":
   - Change `status` to "active"
   - Set `resumedAt` to the current timestamp
   - Write back using the Write tool
   - Respond: "Goal resumed. <turnsEvaluated> turns completed so far."

---

### ACTION: "template" or "use"

1. Extract template name from PAYLOAD (first word after "template"/"use").
2. If no template name: "Usage: /goal template <name>. Templates live in .opencode/goals/"
3. Read `.opencode/goals/<name>.json` using the Read tool.
4. If file not found: "Template '<name>' not found. Create it at .opencode/goals/<name>.json"
5. Parse the template JSON. It should have: condition, command (optional), constraints (optional), description.
6. Use the template's condition and merge with any remaining arguments as constraint overrides.
7. Follow the "set" action flow from step 6 onward to write the goal state.
8. Confirm: "Goal set from template '<name>': <template.description>"

---

### IMPORTANT IMPLEMENTATION NOTES

- Always prefer external scripts (read-state.js, write-state.js, gen-id.js) over inline `node -e "..."` one-liners. The scripts handle error cases, path resolution, and atomic writes.
- When passing JSON to a shell command, escape carefully. If the JSON contains single quotes, wrap the argument in double quotes and escape internal double quotes with backslashes.
- After any write to `.opencode/.goal-state.json`, verify the write succeeded by reading the file back (use the Read tool).
- If writing the state file fails, report the exact error to the user. Do not silently continue.
- The state file is JSON. Always validate the structure before trusting its contents.
- For timestamp generation: prefer `gen-id.js`/`gen-id.ps1` for initial creation. For updates (clear/pause/resume), use the inline timestamp commands shown above.
- Never delete the state file — always update in place so evaluation history is preserved.
