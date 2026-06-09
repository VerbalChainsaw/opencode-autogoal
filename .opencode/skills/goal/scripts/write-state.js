/**
 * Goal State Writer — creates or overwrites the goal state file.
 *
 * Called by: command.md via !`node .opencode/skills/goal/scripts/write-state.js <json>`
 *
 * Input: JSON string as first argument containing the full GoalState object
 * Uses atomic write (write-to-tmp-then-rename) to prevent corruption.
 *
 * Output: "OK" on success, error message on failure
 * Exit code: 0 on success, 1 on failure
 */

const fs = require("node:fs");
const path = require("node:path");

const STATE_FILE = ".opencode/.goal-state.json";
const TMP_SUFFIX = ".tmp." + Date.now();

function findProjectRoot() {
  let dir = process.cwd();
  for (let i = 0; i < 20; i++) {
    if (fs.existsSync(path.join(dir, ".opencode"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    process.stderr.write("ERROR: No JSON state provided\n");
    process.exit(1);
  }

  const jsonStr = args[0];

  // Validate JSON before writing
  let state;
  try {
    state = JSON.parse(jsonStr);
  } catch (err) {
    process.stderr.write(`ERROR: Invalid JSON: ${err.message}\n`);
    process.exit(1);
  }

  // Validate required fields
  const required = ["version", "id", "condition", "status", "createdAt", "constraints"];
  for (const field of required) {
    if (!(field in state)) {
      process.stderr.write(`ERROR: Missing required field '${field}'\n`);
      process.exit(1);
    }
  }

  const projectRoot = findProjectRoot();
  const statePath = path.join(projectRoot, STATE_FILE);
  const tmpPath = statePath + TMP_SUFFIX;

  try {
    // Ensure .opencode directory exists
    const opencodeDir = path.dirname(statePath);
    if (!fs.existsSync(opencodeDir)) {
      fs.mkdirSync(opencodeDir, { recursive: true });
    }

    // Atomic write: write to temp file, then rename
    fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), "utf-8");
    fs.renameSync(tmpPath, statePath);

    process.stdout.write("OK\n");
    process.exit(0);
  } catch (err) {
    // Clean up temp file on failure
    try {
      fs.unlinkSync(tmpPath);
    } catch (_) {
      /* ignore cleanup errors */
    }
    process.stderr.write(`ERROR: Failed to write state: ${err.message}\n`);
    process.exit(1);
  }
}

main();
