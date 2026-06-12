/**
 * Built-in goal templates, bundled with the package so `/goal template <name>`
 * works out of the box. Users can still add their own at `.opencode/goals/<name>.json`
 * (the server checks that directory first, then falls back to these).
 */

import type { GoalConstraints } from "./goal-state.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, renameSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";

export interface GoalTemplate {
  description: string;
  condition: string;
  command?: string;
  constraints?: Partial<GoalConstraints>;
  /** v0.4.0+ — variable definitions with descriptions and optional defaults. */
  variables?: Record<string, { description: string; default?: string }>;
}

export const BUILTIN_TEMPLATES: Record<string, GoalTemplate> = {
  "fix-lint": {
    description: "Fix all lint errors in the project",
    condition: "the lint command exits with code 0",
    command: "npm run lint",
    constraints: { maxTurns: 10, maxTimeMinutes: 15, maxTokens: 50000 },
  },
  "fix-types": {
    description: "Make the TypeScript type-check pass",
    condition: "tsc reports no type errors",
    command: "npx tsc --noEmit",
    constraints: { maxTurns: 10, maxTimeMinutes: 15, maxTokens: 50000 },
  },
  "pass-tests": {
    description: "Make the test suite pass",
    condition: "the test command exits with code 0 with no failing tests",
    command: "npm test",
    constraints: { maxTurns: 15, maxTimeMinutes: 20 },
  },
};

// ── v0.4.0+ template engine ─────────────────────────────────────────────────

// Cap on template import file size. The `importTemplate` primitive already
// caps the content string length (line 175) — exported here so the CLI's
// file/stdin readers can apply the same cap at the read boundary, BEFORE
// allocating a 50MB+ string. (Red-team audit, Pass 2 — file I/O with user
// paths: a 50MB file is read in full and then rejected downstream.)
export const MAX_TEMPLATE_IMPORT_SIZE = 256 * 1024;

/** Replace {var} placeholders with values. Unresolved vars stay as literal "{var}". */
export function resolveTemplateVars(text: string, vars: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? `{${key}}`);
}

/**
 * Pull every `{name}` token from a string. Matches the same shape
 * `resolveTemplateVars` replaces, so the validator and the resolver
 * stay in lock-step. Names are restricted to \w+ (letters, digits,
 * underscore) — same as the resolver regex.
 */
function referencedVars(text: string): Set<string> {
  const out = new Set<string>();
  const re = /\{(\w+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.add(m[1]!);
  return out;
}

/**
 * Validate a template:
 *  - shape check (condition is a string, command/description optional strings,
 *    variables is an optional object);
 *  - **v0.4.0**: every declared variable must appear in `condition` OR `command`
 *    (spec §"Template import security" step 5);
 *  - **v0.4.0**: no UNDEFINED variable may appear in `condition` (spec
 *    "validateTemplate: undefined vars in condition detected").
 *
 * Returning false in either case is what the import path relies on
 * (see `importTemplate`); the dispatcher never sees the difference
 * between "wrong shape" and "wrong variables" — both are
 * `Template must have at least a 'condition' string field.`
 */
export function validateTemplate(tpl: unknown): tpl is GoalTemplate {
  if (!tpl || typeof tpl !== "object" || Array.isArray(tpl)) return false;
  const t = tpl as Record<string, unknown>;
  if (typeof t.condition !== "string") return false;
  if (t.command !== undefined && t.command !== null && typeof t.command !== "string") return false;
  if (t.description !== undefined && typeof t.description !== "string") return false;
  // variables is optional
  if (t.variables !== undefined) {
    if (typeof t.variables !== "object" || Array.isArray(t.variables) || t.variables === null) return false;
  }

  const declaredKeys = t.variables ? Object.keys(t.variables as Record<string, unknown>) : [];
  const condRefs = referencedVars(t.condition as string);
  const cmdRefs = typeof t.command === "string" ? referencedVars(t.command) : new Set<string>();

  // Every declared var must be referenced in condition OR command.
  for (const k of declaredKeys) {
    if (!condRefs.has(k) && !cmdRefs.has(k)) return false;
  }
  // No undeclared var may appear in condition (command can have ad-hoc
  // tokens, but condition text drives the goal so we hold the line there).
  for (const r of condRefs) {
    if (!declaredKeys.includes(r)) return false;
  }
  return true;
}

/**
 * Discover all available templates (builtins + user).
 * Returns array of {name, description, builtin}.
 */
export function discoverTemplates(directory: string): { name: string; description: string; builtin: boolean }[] {
  const results: { name: string; description: string; builtin: boolean }[] = [];

  // Builtins
  for (const [name, tpl] of Object.entries(BUILTIN_TEMPLATES)) {
    results.push({ name, description: tpl.description, builtin: true });
  }

  // User templates in .opencode/goals/
  const userDir = join(directory, ".opencode", "goals");
  if (existsSync(userDir)) {
    try {
      for (const entry of readdirSync(userDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const name = entry.name.slice(0, -5);
        if (!/^[A-Za-z0-9_-]+$/.test(name)) continue;
        try {
          const raw = JSON.parse(readFileSync(join(userDir, entry.name), "utf-8"));
          // Run the same validator the import path uses. A user file
          // missing `condition` (or with declared-but-unused vars) is
          // a corrupt template, not a usable one — skip it from `list`
          // AND from `use` (see exportTemplate).
          if (validateTemplate(raw)) {
            results.push({ name, description: (raw as GoalTemplate).description, builtin: false });
          }
        } catch { /* skip invalid files */ }
      }
    } catch { /* directory read failed */ }
  }

  return results;
}

/** Export a template by name. User template takes priority over builtin. */
export function exportTemplate(directory: string, name: string): GoalTemplate | null {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) return null;
  const userPath = join(directory, ".opencode", "goals", `${name}.json`);
  if (existsSync(userPath)) {
    try {
      const raw = JSON.parse(readFileSync(userPath, "utf-8"));
      if (validateTemplate(raw)) return raw;
    } catch { /* fall through to builtin */ }
  }
  return BUILTIN_TEMPLATES[name] ?? null;
}

/** Import a user template. Returns ok or error.
 *
 * Order of checks is deliberate:
 *  1. **name regex** — reject path traversal / special chars before any I/O.
 *  2. **size cap** — 256KB (spec §"Template import oversized"). Done
 *     BEFORE `JSON.parse` so a 10MB attack payload doesn't burn CPU
 *     on parse just to be rejected.
 *  3. **JSON.parse** + **validateTemplate** — shape + variable rules.
 *  4. **atomic write** — temp + rename into `.opencode/goals/`.
 *
 * The temp filename includes pid + timestamp so two concurrent imports
 * with the same name (e.g. from the CLI test suite) don't clobber
 * each other's temp files.
 */
export function importTemplate(
  directory: string,
  name: string,
  content: string,
): { ok: true; path: string } | { ok: false; error: string } {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    return { ok: false, error: `Invalid template name '${name}'. Use letters, numbers, hyphens, and underscores only.` };
  }
  if (content.length > MAX_TEMPLATE_IMPORT_SIZE) {
    return { ok: false, error: `Template file too large (max ${MAX_TEMPLATE_IMPORT_SIZE} bytes / 256KB).` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err: any) {
    return { ok: false, error: `Invalid JSON: ${err?.message ?? err}` };
  }
  if (!validateTemplate(parsed)) {
    return { ok: false, error: "Template must have at least a 'condition' string field, and every declared variable must be referenced in condition or command." };
  }

  const userDir = join(directory, ".opencode", "goals");
  if (!existsSync(userDir)) mkdirSync(userDir, { recursive: true });

  const targetPath = join(userDir, `${name}.json`);
  const tmp = `${targetPath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  try {
    writeFileSync(tmp, JSON.stringify(parsed, null, 2) + "\n", "utf-8");
    renameSync(tmp, targetPath);
  } catch (err: any) {
    try { unlinkSync(tmp); } catch { }
    return { ok: false, error: `Failed to write template: ${err?.message ?? err}` };
  }

  return { ok: true, path: targetPath };
}
