/**
 * ID Generator — produces a UUID and Unix timestamp for goal creation.
 *
 * Called by: command.md via !`node .opencode/skills/goal/scripts/gen-id.js`
 *
 * Output: JSON on stdout: { "id": "uuid", "timestamp": 1234567890 }
 * Exit code: 0 on success
 *
 * On Windows without Node.js in PATH, use PowerShell:
 *   pwsh -File .opencode/skills/goal/scripts/gen-id.ps1
 * (A matching gen-id.ps1 provides the same JSON output)
 */

const crypto = require("node:crypto");

function main() {
  const id = crypto.randomUUID();
  const timestamp = Date.now();

  process.stdout.write(JSON.stringify({ id, timestamp }));
  process.exit(0);
}

main();
