/**
 * Tests for src/templates.ts and the v0.4.0 template CLI surface
 * (template list / export / import <path> / import -).
 *
 * Covers the ~20 spec scenarios in `specs/v0.4.0-roadmap.md` Phase 4
 * (lines 469-571) plus the CLI's stdin guard, which lives in src/cli.ts
 * (added because the spec CLI form `template import -` needs I/O the
 * dispatcher can't do directly).
 *
 * Each test uses a fresh temp dir; nothing on disk is shared between
 * tests. Spawned CLI subprocesses run against their own fresh cwd.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync,
  readdirSync, openSync, statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "dist", "cli.js");
const NODE = process.execPath;

const {
  BUILTIN_TEMPLATES,
  resolveTemplateVars,
  validateTemplate,
  discoverTemplates,
  exportTemplate,
  importTemplate,
} = await import("../dist/templates.js");

const { dispatchGoalCommandStructured, dispatchGoalCommand } =
  await import("../dist/command.js");

// Re-importing dist/cli.js is safe — its bottom-of-file main() check
// (`isCliEntry`) returns false when argv[1] doesn't match the module
// URL, so it does NOT auto-run as a CLI.
const { handleTemplateImport } = await import("../dist/cli.js");

function freshDir() {
  return mkdtempSync(join(tmpdir(), "opengoal-tpl-"));
}
function cleanDir(d) { try { rmSync(d, { recursive: true, force: true }); } catch {} }

function writeTpl(dir, name, obj) {
  const dir2 = join(dir, ".opencode", "goals");
  mkdirSync(dir2, { recursive: true });
  const p = join(dir2, `${name}.json`);
  writeFileSync(p, JSON.stringify(obj, null, 2));
  return p;
}

// ──────────────────────────────────────────────────────────────────────────
// 1. resolveTemplateVars
// ──────────────────────────────────────────────────────────────────────────

describe("resolveTemplateVars", () => {
  test("simple substitution: {branch} → feature/x", () => {
    assert.equal(resolveTemplateVars("tests pass in {branch}", { branch: "feature/x" }),
      "tests pass in feature/x");
  });

  test("multiple variables: all substituted", () => {
    assert.equal(
      resolveTemplateVars("checkout {branch} then run {tool}", { branch: "main", tool: "npm test" }),
      "checkout main then run npm test",
    );
  });

  test("missing variable kept as literal {var}", () => {
    assert.equal(
      resolveTemplateVars("hello {name} from {place}", { name: "alice" }),
      "hello alice from {place}",
    );
  });

  test("no variables in text — returned unchanged", () => {
    assert.equal(
      resolveTemplateVars("plain text with no placeholders", { foo: "bar" }),
      "plain text with no placeholders",
    );
  });

  test("variable embedded in larger string: prefix {key} suffix", () => {
    // Regression: the regex must match the inner {key}, not the
    // outer "prefix {key} suffix" as one token.
    assert.equal(
      resolveTemplateVars("prefix {key} suffix", { key: "VALUE" }),
      "prefix VALUE suffix",
    );
  });

  test("does NOT greedily re-substitute: substituted value is not re-scanned", () => {
    // If we re-substituted, {b} would become X → "prefix X suffix".
    // We must get "prefix {b} suffix" (one-shot replacement).
    assert.equal(
      resolveTemplateVars("prefix {a} suffix", { a: "{b}", b: "X" }),
      "prefix {b} suffix",
      "resolving {a}→{b} must NOT cascade to {b}→X",
    );
  });

  test("empty vars object — all placeholders kept literal", () => {
    assert.equal(
      resolveTemplateVars("a {x} b {y} c", {}),
      "a {x} b {y} c",
    );
  });

  test("same variable used multiple times — all replaced", () => {
    assert.equal(
      resolveTemplateVars("{x} and {x} again", { x: "Z" }),
      "Z and Z again",
    );
  });
});

// ──────────────────────────────────────────────────────────────────────────
// 2. validateTemplate
// ──────────────────────────────────────────────────────────────────────────

describe("validateTemplate", () => {
  test("accepts minimal valid template (condition only)", () => {
    assert.equal(validateTemplate({ condition: "x" }), true);
  });

  test("accepts template with command + description + variables (all used)", () => {
    assert.equal(validateTemplate({
      condition: "tests pass in {branch}",
      command: "git checkout {branch} && npm test",
      description: "Run tests on a branch",
      variables: { branch: { description: "branch name", default: "main" } },
    }), true);
  });

  test("accepts old template without variables (backward compat)", () => {
    // Spec line 492: "Old templates without 'variables' field work unchanged."
    assert.equal(validateTemplate({
      condition: "the lint command exits with code 0",
      command: "npm run lint",
      description: "Fix all lint errors",
    }), true);
  });

  test("rejects missing condition", () => {
    assert.equal(validateTemplate({ description: "no condition" }), false);
    assert.equal(validateTemplate({}), false);
    assert.equal(validateTemplate({ condition: 42 }), false);
  });

  test("rejects non-object input", () => {
    assert.equal(validateTemplate(null), false);
    assert.equal(validateTemplate(undefined), false);
    assert.equal(validateTemplate("a string"), false);
    assert.equal(validateTemplate(42), false);
    assert.equal(validateTemplate([]), false);
  });

  test("rejects variables object that is an array", () => {
    assert.equal(validateTemplate({ condition: "x", variables: [] }), false);
  });

  test("rejects declared-but-unused variable (v0.4.0 spec)", () => {
    // Spec test list: "validateTemplate: unused vars detected"
    assert.equal(validateTemplate({
      condition: "no placeholders here",
      command: null,
      variables: { orphan: { description: "never referenced" } },
    }), false);
  });

  test("rejects undeclared variable used in condition (v0.4.0 spec)", () => {
    // Spec test list: "validateTemplate: undefined vars in condition"
    assert.equal(validateTemplate({
      condition: "this references {undeclared}",
      command: null,
      variables: {},
    }), false);
  });

  test("accepts variable used in command even if not in condition", () => {
    // Variables are valid in either condition OR command, not both required.
    assert.equal(validateTemplate({
      condition: "all tests pass",
      command: "npm test --branch={branch}",
      variables: { branch: { description: "branch" } },
    }), true);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// 3. discoverTemplates
// ──────────────────────────────────────────────────────────────────────────

describe("discoverTemplates", () => {
  test("returns builtins when no user dir exists", () => {
    const dir = freshDir();
    try {
      const list = discoverTemplates(dir);
      // All three builtins present.
      const names = list.map(t => t.name);
      assert.ok(names.includes("fix-lint"), `missing fix-lint in ${names.join(",")}`);
      assert.ok(names.includes("fix-types"), `missing fix-types in ${names.join(",")}`);
      assert.ok(names.includes("pass-tests"), `missing pass-tests in ${names.join(",")}`);
      // All three are marked builtin.
      for (const t of list.filter(t => ["fix-lint","fix-types","pass-tests"].includes(t.name))) {
        assert.equal(t.builtin, true);
      }
    } finally { cleanDir(dir); }
  });

  test("includes user templates alongside builtins", () => {
    const dir = freshDir();
    try {
      writeTpl(dir, "my-tpl", { condition: "x", description: "my custom template" });
      const list = discoverTemplates(dir);
      const names = list.map(t => t.name);
      assert.ok(names.includes("fix-lint"));
      assert.ok(names.includes("my-tpl"));
      const my = list.find(t => t.name === "my-tpl");
      assert.equal(my.builtin, false);
      assert.equal(my.description, "my custom template");
    } finally { cleanDir(dir); }
  });

  test("does not crash when .opencode/goals/ does not exist", () => {
    const dir = freshDir();
    try {
      // No .opencode/goals/ — should still return builtins.
      const list = discoverTemplates(dir);
      assert.ok(list.length >= 3, "builtins should still be listed");
    } finally { cleanDir(dir); }
  });

  test("skips malformed user template files", () => {
    const dir = freshDir();
    try {
      const goalsDir = join(dir, ".opencode", "goals");
      mkdirSync(goalsDir, { recursive: true });
      // Garbage JSON
      writeFileSync(join(goalsDir, "broken.json"), "{not valid json");
      // Valid JSON but no condition
      writeFileSync(join(goalsDir, "no-cond.json"), JSON.stringify({ description: "x" }));
      // Valid template
      writeFileSync(join(goalsDir, "good.json"), JSON.stringify({ condition: "x", description: "good" }));
      const list = discoverTemplates(dir);
      const names = list.map(t => t.name);
      assert.ok(names.includes("good"), `good should be listed; got ${names.join(",")}`);
      assert.ok(!names.includes("broken"), "broken file must be skipped");
      assert.ok(!names.includes("no-cond"), "shape-invalid file must be skipped");
    } finally { cleanDir(dir); }
  });

  test("skips files whose basename does not match the slug regex", () => {
    const dir = freshDir();
    try {
      const goalsDir = join(dir, ".opencode", "goals");
      mkdirSync(goalsDir, { recursive: true });
      writeFileSync(join(goalsDir, "evil space.json"), JSON.stringify({ condition: "x", description: "x" }));
      writeFileSync(join(goalsDir, "good.json"), JSON.stringify({ condition: "x", description: "good" }));
      const list = discoverTemplates(dir);
      const names = list.map(t => t.name);
      assert.ok(names.includes("good"));
      assert.ok(!names.includes("evil space"));
    } finally { cleanDir(dir); }
  });
});

// ──────────────────────────────────────────────────────────────────────────
// 4. exportTemplate
// ──────────────────────────────────────────────────────────────────────────

describe("exportTemplate", () => {
  test("returns null for non-slug name (defense in depth)", () => {
    const dir = freshDir();
    try {
      assert.equal(exportTemplate(dir, "../etc/passwd"), null);
      assert.equal(exportTemplate(dir, ""), null);
      assert.equal(exportTemplate(dir, "name/with/slash"), null);
    } finally { cleanDir(dir); }
  });

  test("returns builtin by name", () => {
    const dir = freshDir();
    try {
      const tpl = exportTemplate(dir, "fix-lint");
      assert.ok(tpl);
      assert.equal(tpl.description, "Fix all lint errors in the project");
      assert.equal(tpl.command, "npm run lint");
    } finally { cleanDir(dir); }
  });

  test("returns null for unknown name", () => {
    const dir = freshDir();
    try {
      assert.equal(exportTemplate(dir, "this-does-not-exist"), null);
    } finally { cleanDir(dir); }
  });

  test("user template overrides builtin (user file wins)", () => {
    const dir = freshDir();
    try {
      writeTpl(dir, "fix-lint", { condition: "user override", description: "user's fix-lint" });
      const tpl = exportTemplate(dir, "fix-lint");
      assert.ok(tpl);
      assert.equal(tpl.description, "user's fix-lint");
      assert.equal(tpl.condition, "user override");
    } finally { cleanDir(dir); }
  });
});

// ──────────────────────────────────────────────────────────────────────────
// 5. importTemplate
// ──────────────────────────────────────────────────────────────────────────

describe("importTemplate", () => {
  test("valid template → file created in .opencode/goals/", () => {
    const dir = freshDir();
    try {
      const res = importTemplate(dir, "my-tpl", JSON.stringify({
        condition: "tests pass", description: "my template",
      }));
      assert.equal(res.ok, true);
      assert.ok(res.path);
      assert.ok(existsSync(res.path));
      const written = JSON.parse(readFileSync(res.path, "utf-8"));
      assert.equal(written.condition, "tests pass");
    } finally { cleanDir(dir); }
  });

  test("invalid JSON → error, NO file created", () => {
    const dir = freshDir();
    try {
      const res = importTemplate(dir, "my-tpl", "{not valid json");
      assert.equal(res.ok, false);
      assert.match(res.error, /Invalid JSON/);
      const goalsDir = join(dir, ".opencode", "goals");
      assert.ok(!existsSync(goalsDir) || !existsSync(join(goalsDir, "my-tpl.json")),
        "no file should be written for invalid JSON");
    } finally { cleanDir(dir); }
  });

  test("bad name: path traversal rejected", () => {
    const dir = freshDir();
    try {
      for (const bad of ["../etc/passwd", "name/with/slash", "", "name with space", "name.with.dot"]) {
        const res = importTemplate(dir, bad, JSON.stringify({ condition: "x" }));
        assert.equal(res.ok, false, `name '${bad}' should be rejected`);
        assert.match(res.error, /Invalid template name/);
      }
    } finally { cleanDir(dir); }
  });

  test("oversized (>256KB) → error, no file", () => {
    const dir = freshDir();
    try {
      const huge = "x".repeat(257 * 1024);
      const res = importTemplate(dir, "my-tpl", huge);
      assert.equal(res.ok, false);
      assert.match(res.error, /too large|max 256KB/i);
      assert.ok(!existsSync(join(dir, ".opencode", "goals", "my-tpl.json")),
        "oversized template must not be written");
    } finally { cleanDir(dir); }
  });

  test("size check is BEFORE JSON.parse (no CPU DoS on huge input)", () => {
    // If the order were parse-then-size-check, this huge INVALID JSON
    // would have to be parsed first. With size-first, the cheap byte
    // length check rejects before we touch JSON.parse.
    //
    // We can't directly assert parse wasn't called, but we CAN assert
    // the error is the size error (not "Invalid JSON"), proving the
    // size check fired first.
    const dir = freshDir();
    try {
      const huge = "{not valid json ".repeat(100_000); // ~1.6MB
      const res = importTemplate(dir, "my-tpl", huge);
      assert.equal(res.ok, false);
      assert.match(res.error, /too large|max 256KB/i,
        `size error should fire first; got: ${res.error}`);
    } finally { cleanDir(dir); }
  });

  test("template missing condition → error", () => {
    const dir = freshDir();
    try {
      const res = importTemplate(dir, "my-tpl", JSON.stringify({ description: "no condition" }));
      assert.equal(res.ok, false);
      assert.match(res.error, /condition|template/i);
    } finally { cleanDir(dir); }
  });

  test("template with declared-but-unused vars → error", () => {
    const dir = freshDir();
    try {
      const res = importTemplate(dir, "my-tpl", JSON.stringify({
        condition: "no placeholders",
        variables: { orphan: { description: "never used" } },
      }));
      assert.equal(res.ok, false);
      assert.match(res.error, /condition|template/i);
    } finally { cleanDir(dir); }
  });

  test("atomic write: temp file is cleaned up on success", () => {
    const dir = freshDir();
    try {
      importTemplate(dir, "my-tpl", JSON.stringify({ condition: "x", description: "x" }));
      const goalsDir = join(dir, ".opencode", "goals");
      // No .tmp.* files left behind.
      const files = readdirSync(goalsDir);
      const stragglers = files.filter(f => f.includes(".tmp."));
      assert.equal(stragglers.length, 0,
        `atomic write should leave no temp files; found: ${stragglers.join(",")}`);
    } finally { cleanDir(dir); }
  });
});

// ──────────────────────────────────────────────────────────────────────────
// 6. Dispatcher: template use with --var
// ──────────────────────────────────────────────────────────────────────────

describe("dispatchGoalCommandStructured: template use", () => {
  test("template <name> --var key=val: condition + command resolved", () => {
    const dir = freshDir();
    try {
      writeTpl(dir, "branch-tests", {
        condition: "tests pass in {branch}",
        command: "git checkout {branch} && npm test",
        description: "branch tests",
        variables: { branch: { description: "branch", default: "main" } },
      });
      const res = dispatchGoalCommandStructured(dir, "template branch-tests --var branch=feature/x");
      assert.equal(res.kind, "set");
      assert.match(res.message, /GOAL: tests pass in feature\/x/);
      const state = JSON.parse(readFileSync(join(dir, ".opencode", ".goal-state.json"), "utf-8"));
      assert.equal(state.command, "git checkout feature/x && npm test");
    } finally { cleanDir(dir); }
  });

  test("template use with default variable: default value applied (no --var)", () => {
    // Spec v0.4.0 line 566: "Template use with default variable |
    // default value applied." The dispatcher must read the template's
    // declared `variables.<key>.default` and use it as a fallback when
    // no explicit --var is passed.
    const dir = freshDir();
    try {
      writeTpl(dir, "branch-tests", {
        condition: "tests pass in {branch}",
        command: "git checkout {branch} && npm test",
        description: "branch tests",
        variables: { branch: { description: "branch", default: "main" } },
      });
      const res = dispatchGoalCommandStructured(dir, "template branch-tests");
      assert.equal(res.kind, "set");
      // Default "main" should appear in BOTH the condition text and the command.
      assert.match(res.message, /GOAL: tests pass in main/,
        `default "main" should be applied to condition; got: ${res.message}`);
      const state = JSON.parse(readFileSync(join(dir, ".opencode", ".goal-state.json"), "utf-8"));
      assert.equal(state.command, "git checkout main && npm test",
        `default "main" should be applied to command; got: ${state.command}`);
    } finally { cleanDir(dir); }
  });

  test("template use with --var override beats declared default", () => {
    // Precedence: explicit --var > declared default. Spec scenario
    // "Template use with --var: condition + command resolved".
    const dir = freshDir();
    try {
      writeTpl(dir, "branch-tests", {
        condition: "tests pass in {branch}",
        command: "git checkout {branch} && npm test",
        description: "branch tests",
        variables: { branch: { description: "branch", default: "main" } },
      });
      const res = dispatchGoalCommandStructured(
        dir,
        "template branch-tests --var branch=develop",
      );
      assert.equal(res.kind, "set");
      assert.match(res.message, /GOAL: tests pass in develop/);
      const state = JSON.parse(readFileSync(join(dir, ".opencode", ".goal-state.json"), "utf-8"));
      assert.equal(state.command, "git checkout develop && npm test",
        "explicit --var must win over declared default");
    } finally { cleanDir(dir); }
  });

  test("template with no default and no --var: literal {var} kept in condition", () => {
    // Spec scenario: "Template use with missing --var | unresolved
    // variable kept as literal." This is the case where the template
    // declares a variable but does NOT provide a default AND the user
    // doesn't pass --var. The {var} literal stays.
    const dir = freshDir();
    try {
      writeTpl(dir, "branch-tests", {
        condition: "tests pass in {branch}",
        command: "git checkout {branch} && npm test",
        description: "branch tests",
        variables: { branch: { description: "branch" } }, // no default
      });
      const res = dispatchGoalCommandStructured(dir, "template branch-tests");
      assert.equal(res.kind, "set");
      assert.match(res.message, /GOAL: tests pass in \{branch\}/,
        `no default and no --var → literal {branch} must remain; got: ${res.message}`);
    } finally { cleanDir(dir); }
  });

  test("template with default AND --var: --var wins (precedence pin)", () => {
    // More specific precedence test — default and override coexist.
    const dir = freshDir();
    try {
      writeTpl(dir, "deploy", {
        condition: "{env} deploy",
        command: "deploy --env {env}",
        description: "deploy",
        variables: { env: { description: "env", default: "staging" } },
      });
      const res = dispatchGoalCommandStructured(
        dir,
        "template deploy --var env=production",
      );
      assert.equal(res.kind, "set");
      assert.match(res.message, /GOAL: production deploy/);
      const state = JSON.parse(readFileSync(join(dir, ".opencode", ".goal-state.json"), "utf-8"));
      assert.equal(state.command, "deploy --env production");
    } finally { cleanDir(dir); }
  });

  test("template use with multiple --var", () => {
    const dir = freshDir();
    try {
      writeTpl(dir, "deploy", {
        condition: "{env} deploy of {service}",
        command: "deploy {service} --to {env}",
        description: "deploy a service to an env",
        variables: {
          env: { description: "env" },
          service: { description: "service name" },
        },
      });
      const res = dispatchGoalCommandStructured(
        dir,
        "template deploy --var env=prod --var service=api",
      );
      assert.equal(res.kind, "set");
      assert.match(res.message, /GOAL: prod deploy of api/);
      const state = JSON.parse(readFileSync(join(dir, ".opencode", ".goal-state.json"), "utf-8"));
      assert.equal(state.command, "deploy api --to prod");
    } finally { cleanDir(dir); }
  });

  test("template use with bad var name: literal kept (no injection)", () => {
    const dir = freshDir();
    try {
      writeTpl(dir, "branch-tests", {
        condition: "tests in {branch}",
        command: "echo {branch}",
        description: "bt",
        variables: { branch: { description: "branch" } },
      });
      // --var key=value — only \w+ keys are accepted by the dispatcher regex.
      // Adversarial: try to inject via value (no var-name trickery).
      // The dispatcher's value regex is `\S+` (non-whitespace), so use a
      // single-token adversarial value. The safety property we assert
      // is "value is a literal string in the goal state, never a shell command".
      const res = dispatchGoalCommandStructured(
        dir,
        "template branch-tests --var branch=$(whoami)",
      );
      assert.equal(res.kind, "set");
      const state = JSON.parse(readFileSync(join(dir, ".opencode", ".goal-state.json"), "utf-8"));
      assert.equal(state.command, "echo $(whoami)",
        "value is taken literally — it's a goal description, not a shell command");
    } finally { cleanDir(dir); }
  });
});

// ──────────────────────────────────────────────────────────────────────────
// 7. End-to-end: export → import → use roundtrip
// ──────────────────────────────────────────────────────────────────────────

describe("template export → import → use roundtrip", () => {
  test("export a builtin, re-import it under a new name, then use it", () => {
    const dirA = freshDir();
    const dirB = freshDir();
    try {
      // 1. Export builtin from dirA.
      const exported = exportTemplate(dirA, "fix-lint");
      assert.ok(exported);

      // 2. Re-import into dirB under a new name.
      const content = JSON.stringify(exported);
      const res = importTemplate(dirB, "my-lint", content);
      assert.equal(res.ok, true);

      // 3. Use it from dirB.
      const use = dispatchGoalCommandStructured(dirB, "template my-lint");
      assert.equal(use.kind, "set");
      assert.match(use.message, /npm run lint/);
    } finally { cleanDir(dirA); cleanDir(dirB); }
  });

  test("full variable roundtrip: write user tpl, export, re-import, use --var", () => {
    const dirA = freshDir();
    const dirB = freshDir();
    try {
      // Write user template in dirA.
      writeTpl(dirA, "branch-tpl", {
        condition: "tests pass in {branch}",
        command: "git checkout {branch}",
        description: "branch tests",
        variables: { branch: { description: "branch", default: "main" } },
      });

      // Export it.
      const exported = exportTemplate(dirA, "branch-tpl");
      assert.ok(exported);
      assert.equal(exported.condition, "tests pass in {branch}");

      // Re-import in dirB (re-stringify to lose in-memory identity).
      const res = importTemplate(dirB, "branch-tpl-2", JSON.stringify(exported));
      assert.equal(res.ok, true);

      // Use the new name with --var.
      const use = dispatchGoalCommandStructured(
        dirB,
        "template branch-tpl-2 --var branch=feature/y",
      );
      assert.equal(use.kind, "set");
      assert.match(use.message, /GOAL: tests pass in feature\/y/);
      const state = JSON.parse(readFileSync(join(dirB, ".opencode", ".goal-state.json"), "utf-8"));
      assert.equal(state.command, "git checkout feature/y");
    } finally { cleanDir(dirA); cleanDir(dirB); }
  });
});

// ──────────────────────────────────────────────────────────────────────────
// 8. CLI: template list / export / import
// ──────────────────────────────────────────────────────────────────────────

function runCli(cwd, args, opts = {}) {
  return spawnSync(NODE, [CLI, ...args], {
    cwd,
    encoding: "utf-8",
    timeout: 10_000,
    ...opts,
  });
}

function runCliWithStdin(cwd, args, stdinContent) {
  // spawn (not spawnSync) so we can pipe stdin to a real child.
  return new Promise((resolve) => {
    const child = spawn(NODE, [CLI, ...args], { cwd, timeout: 10_000 });
    let stdout = "", stderr = "";
    child.stdout.on("data", d => stdout += d);
    child.stderr.on("data", d => stderr += d);
    child.on("close", code => resolve({ status: code, stdout, stderr }));
    child.on("error", err => resolve({ status: -1, stdout, stderr: stderr + err.message }));
    if (stdinContent !== undefined) {
      child.stdin.write(stdinContent);
    }
    child.stdin.end();
  });
}

describe("CLI: template subcommands", () => {
  test("template list — builtins visible", () => {
    const dir = freshDir();
    try {
      const r = runCli(dir, ["template", "list"]);
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      assert.match(r.stdout, /fix-lint/);
      assert.match(r.stdout, /fix-types/);
      assert.match(r.stdout, /pass-tests/);
    } finally { cleanDir(dir); }
  });

  test("template export <name> — prints JSON", () => {
    const dir = freshDir();
    try {
      const r = runCli(dir, ["template", "export", "fix-lint"]);
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      const parsed = JSON.parse(r.stdout);
      assert.equal(parsed.description, "Fix all lint errors in the project");
    } finally { cleanDir(dir); }
  });

  test("template export <unknown> — exits 1 with usage", () => {
    const dir = freshDir();
    try {
      const r = runCli(dir, ["template", "export", "this-does-not-exist"]);
      assert.equal(r.status, 1);
      assert.match(r.stdout, /not found/);
    } finally { cleanDir(dir); }
  });

  test("template import <path> — valid file, file created", async () => {
    const dir = freshDir();
    try {
      const tplPath = join(dir, "my-tpl.json");
      writeFileSync(tplPath, JSON.stringify({
        condition: "tests pass",
        description: "my template",
      }));
      const r = runCli(dir, ["template", "import", tplPath]);
      assert.equal(r.status, 0, `stderr: ${r.stderr}\nstdout: ${r.stdout}`);
      assert.match(r.stdout, /imported/);
      assert.ok(existsSync(join(dir, ".opencode", "goals", "my-tpl.json")),
        "file should be created in .opencode/goals/");
    } finally { cleanDir(dir); }
  });

  test("template import <path> — bad name (path traversal) rejected", () => {
    const dir = freshDir();
    try {
      // Write a file with a name that's outside the slug regex so the
      // dispatcher-derived name also fails.
      const tplPath = join(dir, "evil space.json");
      writeFileSync(tplPath, JSON.stringify({ condition: "x" }));
      const r = runCli(dir, ["template", "import", tplPath]);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /template name|name field/);
    } finally { cleanDir(dir); }
  });

  test("template import <path> — file not found", () => {
    const dir = freshDir();
    try {
      const r = runCli(dir, ["template", "import", join(dir, "nope.json")]);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /not found/);
    } finally { cleanDir(dir); }
  });

  test("template import - with piped stdin — succeeds", async () => {
    const dir = freshDir();
    try {
      const content = JSON.stringify({
        name: "from-stdin",
        condition: "tests pass in {branch}",
        command: "echo {branch}",
        description: "from stdin",
        variables: { branch: { description: "branch" } },
      });
      const r = await runCliWithStdin(dir, ["template", "import", "-"], content);
      assert.equal(r.status, 0,
        `expected exit 0; got ${r.status}\nstderr: ${r.stderr}\nstdout: ${r.stdout}`);
      assert.match(r.stdout, /imported/);
      assert.ok(existsSync(join(dir, ".opencode", "goals", "from-stdin.json")),
        "file should be created with name from JSON's 'name' field");
    } finally { cleanDir(dir); }
  });

  test("template import - with piped invalid JSON — errors, no file", async () => {
    const dir = freshDir();
    try {
      const r = await runCliWithStdin(dir, ["template", "import", "-"], "{not valid");
      assert.equal(r.status, 1);
      assert.match(r.stderr, /not valid JSON|condition/);
      assert.ok(!existsSync(join(dir, ".opencode", "goals", "from-stdin.json")));
    } finally { cleanDir(dir); }
  });

  test("template import - with piped JSON missing 'name' field — errors", async () => {
    const dir = freshDir();
    try {
      const r = await runCliWithStdin(dir, ["template", "import", "-"],
        JSON.stringify({ condition: "x", description: "no name" }));
      assert.equal(r.status, 1);
      assert.match(r.stderr, /name/);
    } finally { cleanDir(dir); }
  });

  test("template import - with no stdin and TTY is guarded by the unit-level design", () => {
    // Spec §"Stdin import guard": if isTTY is true, error with the
    // exact spec message and DO NOT block on read.
    //
    // Spawning a TTY child from node:test is non-portable, so we
    // assert the contract via the source: re-read src/cli.ts and
    // confirm the isTTY branch + message string. If a future refactor
    // removes the guard, this test catches it.
    const cliSrc = readFileSync(join(here, "..", "src", "cli.ts"), "utf-8");
    assert.match(cliSrc, /process\.stdin\.isTTY/,
      "CLI must check process.stdin.isTTY for stdin imports");
    assert.match(cliSrc, /stdin is a terminal/,
      "TTY error message must match spec wording");
  });
});

// ──────────────────────────────────────────────────────────────────────────
// 9. CLI: stdin guard — TTY behavior verified via in-process bridge
// ──────────────────────────────────────────────────────────────────────────

describe("CLI: handleTemplateImport unit-level (in-process)", () => {
  function withStdinTtyMocked(value, fn) {
    const orig = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { value, configurable: true });
    try { fn(); } finally {
      if (orig) Object.defineProperty(process.stdin, "isTTY", orig);
      else delete process.stdin.isTTY;
    }
  }

  function captureStdout(fn) {
    const orig = process.stdout.write.bind(process.stdout);
    const origErr = process.stderr.write.bind(process.stderr);
    let out = "", err = "";
    let code;
    process.stdout.write = (s) => { out += s; return true; };
    process.stderr.write = (s) => { err += s; return true; };
    try { code = fn(); } finally {
      process.stdout.write = orig;
      process.stderr.write = origErr;
    }
    return { out, err, code };
  }

  test("TTY + import - → exit 1 with spec error message (no hang)", () => {
    const dir = freshDir();
    try {
      withStdinTtyMocked(true, () => {
        const captured = captureStdout(() => handleTemplateImport(dir, ["-"]));
        assert.equal(captured.code, 1, "TTY stdin must return exit 1");
        assert.match(captured.err, /stdin is a terminal/);
      });
      // No file created.
      assert.ok(!existsSync(join(dir, ".opencode", "goals", "from-stdin.json")));
    } finally { cleanDir(dir); }
  });

  test("TTY=false + import - → reads stdin, processes JSON, returns exit code", () => {
    // Simulate piped stdin by faking isTTY=false AND replacing stdin.fd
    // with a regular file fd. We use a real temp file so the read works
    // portably.
    const dir = freshDir();
    const tplPath = join(dir, "stdin-payload.json");
    try {
      writeFileSync(tplPath, JSON.stringify({
        name: "piped",
        condition: "piped template",
        description: "from piped stdin",
      }));
      // Swap process.stdin.fd to our temp file's fd for the duration
      // of the test, then restore.
      const newFd = openSync(tplPath, "r");
      const origFd = process.stdin.fd;
      Object.defineProperty(process.stdin, "fd", { value: newFd, configurable: true });
      const origIsTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
      Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
      try {
        const captured = captureStdout(() => {
          return handleTemplateImport(dir, ["-"]);
        });
        assert.equal(captured.code, 0,
          `expected exit 0; got ${captured.code}\nout: ${captured.out}\nstderr: ${captured.err}`);
        assert.equal(captured.err, "", "no error output expected for happy path");
        assert.match(captured.out, /imported/);
        assert.ok(existsSync(join(dir, ".opencode", "goals", "piped.json")),
          "file should be created from piped stdin");
      } finally {
        Object.defineProperty(process.stdin, "fd", { value: origFd, configurable: true });
        if (origIsTTY) Object.defineProperty(process.stdin, "isTTY", origIsTTY);
        else delete process.stdin.isTTY;
      }
    } finally {
      cleanDir(dir);
    }
  });

  test("import with no path arg → exit 1, usage", () => {
    const dir = freshDir();
    try {
      const captured = captureStdout(() => handleTemplateImport(dir, []));
      assert.equal(captured.code, 1);
    } finally { cleanDir(dir); }
  });

  // Red-team audit regression: oversized stdin (B3 fix). A 50MB+ stdin
  // payload must be rejected by the CLI BEFORE the importTemplate
  // primitive allocates a 50MB+ string. We can't easily fake a 50MB
  // pipe in-process (the read would have to happen first), so this
  // test exercises the chunked-read path with a 300KB file on the
  // stdin fd — large enough to exceed the 256KB cap, small enough
  // to fit in memory during the test setup. The fixture is
  // structurally valid JSON so the size cap (not a JSON error) is
  // what produces the rejection.
  test("oversized stdin payload (300KB) → exit 1, size error (no allocation)", () => {
    const dir = freshDir();
    const tplPath = join(dir, "stdin-payload.json");
    try {
      // 300KB valid template JSON. The condition field is absurdly
      // long; the size cap must fire FIRST, not the JSON parse / per-
      // step content checks.
      const tpl = {
        name: "oversize",
        condition: "a".repeat(300 * 1024),
      };
      writeFileSync(tplPath, JSON.stringify(tpl), "utf-8");
      const stat = statSync(tplPath);
      assert.ok(stat.size > 256 * 1024, "fixture must exceed the 256KB cap");

      const newFd = openSync(tplPath, "r");
      const origFd = process.stdin.fd;
      Object.defineProperty(process.stdin, "fd", { value: newFd, configurable: true });
      const origIsTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
      Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
      try {
        const captured = captureStdout(() => handleTemplateImport(dir, ["-"]));
        assert.equal(captured.code, 1, `expected exit 1; got ${captured.code}\nout: ${captured.out}\nstderr: ${captured.err}`);
        // The size-cap error mentions "stdin template too large" (the
        // CLI's own message). If we see "Template file too large"
        // (the primitive's message), the CLI cap fired AFTER the
        // primitive — bug is back.
        assert.match(captured.err, /stdin template too large/i, `expected CLI-level size cap; got: ${captured.err || captured.out}`);
        // No goal file was created.
        assert.ok(!existsSync(join(dir, ".opencode", "goals", "oversize.json")),
          "oversized stdin must not create a template file");
      } finally {
        Object.defineProperty(process.stdin, "fd", { value: origFd, configurable: true });
        if (origIsTTY) Object.defineProperty(process.stdin, "isTTY", origIsTTY);
        else delete process.stdin.isTTY;
      }
    } finally { cleanDir(dir); }
  });

  // Red-team audit regression: oversized file (B2 fix). A 50MB+ template
  // file at the path argument must be rejected by the CLI BEFORE the
  // importTemplate primitive allocates a 50MB+ string. Same fixture
  // pattern as the chain start test: structurally valid JSON whose
  // condition is too long, so the size cap must fire FIRST.
  test("oversized template file (300KB) → exit 1, size error (no allocation)", () => {
    const dir = freshDir();
    const tplPath = join(dir, "huge.json");
    try {
      const tpl = { name: "huge", condition: "a".repeat(300 * 1024) };
      writeFileSync(tplPath, JSON.stringify(tpl), "utf-8");
      const stat = statSync(tplPath);
      assert.ok(stat.size > 256 * 1024, "fixture must exceed the 256KB cap");

      const captured = captureStdout(() => handleTemplateImport(dir, [tplPath]));
      assert.equal(captured.code, 1, `expected exit 1; got ${captured.code}\nout: ${captured.out}\nstderr: ${captured.err}`);
      // The CLI's own size error must fire FIRST. The primitive's
      // "Template file too large" message has different wording.
      assert.match(captured.err, /template file too large \(/i, `expected CLI-level size cap message; got: ${captured.err}`);
      assert.ok(!existsSync(join(dir, ".opencode", "goals", "huge.json")),
        "oversized template file must not be created");
    } finally { cleanDir(dir); }
  });
});
