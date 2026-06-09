/**
 * Goal State Reader — reads and displays active goal state from disk.
 *
 * Called by: SKILL.md via !`node .opencode/skills/goal/scripts/read-state.js`
 * Called by: command.md via !`node .opencode/skills/goal/scripts/read-state.js`
 *
 * Output: plain text goal summary to stdout (for injection into agent context)
 * Exit code: 0 on success (state found), 1 if no active goal, 2 on error
 */

const fs = require("node:fs");
const path = require("node:path");

const STATE_FILE = ".opencode/.goal-state.json";

/**
 * Resolve the project root by walking up from CWD until we find
 * .opencode/ directory or hit the filesystem root.
 */
function findProjectRoot() {
  let dir = process.cwd();
  for (let i = 0; i < 20; i++) {
    if (fs.existsSync(path.join(dir, ".opencode"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd(); // fallback
}

function main() {
  const projectRoot = findProjectRoot();
  const statePath = path.join(projectRoot, STATE_FILE);

  let state;
  try {
    if (!fs.existsSync(statePath)) {
      process.stdout.write("No active goal.\n");
      process.exit(1);
    }
    const raw = fs.readFileSync(statePath, "utf-8");
    state = JSON.parse(raw);
  } catch (err) {
    process.stdout.write("No active goal.\n");
    process.exit(1);
  }

  // Only show active or paused goals
  if (state.status !== "active" && state.status !== "paused") {
    process.stdout.write("No active goal.\n");
    process.exit(1);
  }

  const status = state.status === "paused" ? " (PAUSED)" : "";
  const elapsed = Math.round((Date.now() - state.startedAt) / 60000);
  const maxTurns = state.constraints?.maxTurns ?? 20;
  const maxTime = state.constraints?.maxTimeMinutes ?? 30;
  const lastEval = state.lastEvaluation?.reason ?? "none yet";

  process.stdout.write(`Condition: ${state.condition}\n`);
  process.stdout.write(`Status: ${state.status}${status}\n`);
  process.stdout.write(
    `Progress: ${state.turnsEvaluated}/${maxTurns} turns, ${elapsed}/${maxTime} minutes\n`
  );
  process.stdout.write(`Last evaluation: ${lastEval}\n`);

  if (state.constraints?.maxTurns) {
    process.stdout.write(`Constraint: Stop after ${state.constraints.maxTurns} turns.\n`);
  }
  if (state.constraints?.maxTimeMinutes) {
    process.stdout.write(
      `Constraint: Stop after ${state.constraints.maxTimeMinutes} minutes.\n`
    );
  }
  if (state.command) {
    process.stdout.write(`Verification: \`${state.command}\`\n`);
  }

  process.exit(0);
}

main();
