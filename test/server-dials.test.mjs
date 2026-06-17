/**
 * Spec-compliance tests for the server plugin dial tools.
 *
 * Verifies that the source file `src/server.ts` defines every tool
 * listed in the `docs/gui-integration.md` tool table. This is a
 * source-level audit that catches drift between the spec and the
 * implementation.
 *
 * Because the tools are closures inside the server factory function,
 * we can't easily import them (they need the full OpenCode plugin
 * host). Instead we:
 *   1. Grep source for tool definitions — assert each spec tool exists.
 *   2. Verify the export count matches the spec (16 tools).
 *   3. Verify the compiled dist/server.js re-exports the module.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// ── Constants ───────────────────────────────────────────────────────────────

/** The full tool table from docs/gui-integration.md. */
const SPEC_TOOLS = [
  // Conversational tools (v0.1.0+)
  "set_goal",
  "goal_status",
  "clear_goal",
  "pause_goal",
  "resume_goal",
  // v0.3.0 data contract
  "goal_get_state",
  // v0.2.0+ dials (the 9 dial tools)
  "goal_turns",
  "goal_time",
  "goal_tokens",
  "goal_condition",
  "goal_steer",
  "goal_clear_steering",
  "goal_restart",
  "goal_handoff",
  "goal_claim",
  // v0.4.0+
  "goal_webhook",
  // Desktop GUI deterministic command bridge
  "goal_control",
];

/** Tools that MUST take a numeric `n` argument (zod number().int().positive()). */
const NUMERIC_TOOLS = new Set(["goal_turns", "goal_time", "goal_tokens"]);

/** Tools that MUST take a string `text` argument. */
const STRING_TOOLS = new Set(["goal_condition", "goal_steer"]);

/** Tools that take an optional `note` argument. */
const OPTIONAL_NOTE_TOOLS = new Set(["goal_handoff"]);

/** Tools that MUST have no arguments. */
const NO_ARG_TOOLS = new Set([
  "goal_get_state", "goal_status", "clear_goal", "pause_goal", "resume_goal",
  "goal_clear_steering", "goal_restart", "goal_claim",
]);

// ── Source audit ────────────────────────────────────────────────────────────

describe("server.ts tool definitions (source audit)", () => {
  const sourcePath = join(here, "..", "src", "server.ts");
  const source = readFileSync(sourcePath, "utf-8");
  const lines = source.split("\n");

  for (const toolName of SPEC_TOOLS) {
    it(`defines tool "${toolName}"`, () => {
      // Each tool is defined as `toolName: tool({`
      // Look for the pattern with the tool name as a key in the tool object.
      // The pattern is: <tool_name>: tool({
      const re = new RegExp(`^\\s{6}${toolName}:\\s+tool\\(\\{`);
      const found = lines.some((l) => re.test(l));
      assert.ok(found, `Tool "${toolName}" not found in src/server.ts. Expected pattern: "${toolName}: tool({");
Look for it around the tool object (lines 276-498).`);
    });
  }

  it("defines exactly 16 tools (spec coverage)", () => {
    // Count all `[name]: tool({` patterns at the right indentation level
    const toolDefRe = /^\s{6}\w+: tool\(\{/;
    const toolCount = lines.filter((l) => toolDefRe.test(l)).length;
    assert.equal(toolCount, SPEC_TOOLS.length,
      `Expected ${SPEC_TOOLS.length} tools, found ${toolCount} in src/server.ts`);
  });

  it("numeric tools (turns/time/tokens) define args with zod number", () => {
    for (const toolName of NUMERIC_TOOLS) {
      // Find the args section by searching a few lines after the tool definition
      const idx = lines.findIndex((l) => l.trim().startsWith(`${toolName}: tool({`));
      assert.ok(idx >= 0, `Could not find tool ${toolName} definition`);
      const block = lines.slice(idx, idx + 12).join("\n");
      assert.ok(block.includes("args: {"), `Tool ${toolName} missing args block`);
      assert.ok(block.includes(".number()"), `Tool ${toolName} missing .number() schema`);
      assert.ok(block.includes(".int()"), `Tool ${toolName} missing .int() schema`);
      assert.ok(block.includes(".positive()"), `Tool ${toolName} missing .positive() schema`);
    }
  });

  it("string tools (condition/steer) define args with zod string", () => {
    for (const toolName of STRING_TOOLS) {
      const idx = lines.findIndex((l) => l.trim().startsWith(`${toolName}: tool({`));
      assert.ok(idx >= 0, `Could not find tool ${toolName} definition`);
      const block = lines.slice(idx, idx + 12).join("\n");
      assert.ok(block.includes("args: {"), `Tool ${toolName} missing args block`);
      assert.ok(block.includes(".string()"), `Tool ${toolName} missing .string() schema`);
    }
  });

  it("handoff tool defines optional note argument", () => {
    for (const toolName of OPTIONAL_NOTE_TOOLS) {
      const idx = lines.findIndex((l) => l.trim().startsWith(`${toolName}: tool({`));
      assert.ok(idx >= 0, `Could not find tool ${toolName} definition`);
      const block = lines.slice(idx, idx + 14).join("\n");
      assert.ok(block.includes(".optional()"), `Tool ${toolName} missing .optional() on note arg`);
    }
  });

  it("no-arg tools have empty args: {}", () => {
    for (const toolName of NO_ARG_TOOLS) {
      const idx = lines.findIndex((l) => l.trim().startsWith(`${toolName}: tool({`));
      assert.ok(idx >= 0, `Could not find tool ${toolName} definition`);
      const block = lines.slice(idx, idx + 8).join("\n");
      assert.ok(block.includes("args: {}"), `Tool ${toolName} should have empty args: {}`);
    }
  });
});

// ── Compiled module check ───────────────────────────────────────────────────

describe("compiled server module exports", () => {
  it("dist/server.js exists and exports a default plugin module", async () => {
    const distPath = join(here, "..", "dist", "server.js");
    assert.ok(existsSync(distPath), "dist/server.js does not exist. Run `npm run build`.");

    // Dynamic import to verify it loads without errors
    let mod;
    try {
      mod = await import(`file://${distPath.replace(/\\/g, "/")}`);
    } catch (e) {
      assert.fail(`Failed to import dist/server.js: ${e.message}`);
    }
    assert.ok(mod, "dist/server.js should export something");
    assert.ok(mod.default, "dist/server.js default export should be the plugin module");
    assert.equal(mod.default.id, "goal", "Plugin id should be 'goal'");
    assert.equal(typeof mod.default.server, "function", "Plugin server should be a factory function");
  });

  it("command hook replaces host prompt parts in-place so dial commands cannot become new goals", async () => {
    const distPath = join(here, "..", "dist", "server.js");
    const commandPath = join(here, "..", "dist", "command.js");
    const dir = mkdtempSync(join(tmpdir(), "opengoal-command-hook-"));

    try {
      const [{ default: mod }, commandMod] = await Promise.all([
        import(`file://${distPath.replace(/\\/g, "/")}`),
        import(`file://${commandPath.replace(/\\/g, "/")}`),
      ]);

      commandMod.dispatchGoalCommandStructured(dir, 'set "budget target" --command "node -e process.exit(1)"');

      const plugin = await mod.server({
        directory: dir,
        client: {
          app: { log: async () => {} },
          tui: { showToast: async () => {} },
          session: { prompt: async () => {}, message: async () => {} },
        },
      });

      const parts = [{ type: "text", text: "Handle the /goal command. Arguments: turns 21" }];
      const output = { parts };

      await plugin["command.execute.before"](
        { command: "goal", sessionID: "session-1", arguments: "turns 21" },
        output,
      );

      assert.strictEqual(output.parts, parts, "hook must mutate the host-owned parts array, not replace it");
      assert.equal(parts.length, 1);
      assert.match(parts[0].text, /Turns set to 21|Max turns: 21/);
      assert.doesNotMatch(parts[0].text, /Handle the \/goal command/);

      const view = commandMod.dispatchGoalCommandStructured(dir, "view");
      assert.match(view.message, /Condition: budget target/);
      assert.match(view.message, /Progress: 0\/21 turns/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("goal_control executes GUI commands without returning agent turn scaffolding", async () => {
    const distPath = join(here, "..", "dist", "server.js");
    const commandPath = join(here, "..", "dist", "command.js");
    const dir = mkdtempSync(join(tmpdir(), "opengoal-control-tool-"));

    try {
      const [{ default: mod }, commandMod] = await Promise.all([
        import(`file://${distPath.replace(/\\/g, "/")}`),
        import(`file://${commandPath.replace(/\\/g, "/")}`),
      ]);

      const plugin = await mod.server({
        directory: dir,
        client: {
          app: { log: async () => {} },
          tui: { showToast: async () => {} },
          session: { prompt: async () => {}, message: async () => {} },
        },
      });

      assert.ok(plugin.tool.goal_control, "goal_control tool should be registered for Desktop GUI control calls");

      const setOutput = await plugin.tool.goal_control.execute(
        { command: 'set "control path target" --command "node -e process.exit(0)"' },
        { directory: dir },
      );
      assert.match(setOutput, /A goal has been set/);
      assert.doesNotMatch(setOutput, /How to proceed:/);
      assert.doesNotMatch(setOutput, /Begin now\./);

      const turnOutput = await plugin.tool.goal_control.execute({ command: "turns 21" }, { directory: dir });
      assert.match(turnOutput, /Turns set to 21|Max turns: .*21/);

      const view = commandMod.dispatchGoalCommandStructured(dir, "view");
      assert.match(view.message, /Condition: control path target/);
      assert.match(view.message, /Progress: 0\/21 turns/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── Spec document audit ─────────────────────────────────────────────────────

describe("spec document (docs/gui-integration.md) coverage", () => {
  it("spec document exists and lists all 16 tools", () => {
    const specPath = join(here, "..", "docs", "gui-integration.md");
    assert.ok(existsSync(specPath), "docs/gui-integration.md does not exist");

    const spec = readFileSync(specPath, "utf-8");

    // Check the tool table has all 16 tools mentioned
    for (const toolName of SPEC_TOOLS) {
      // In the markdown table, tools are listed in the first column with backticks
      assert.ok(spec.includes(`\`${toolName}\``),
        `Spec document should mention \`${toolName}\` in the tool table`);
    }
  });
});
