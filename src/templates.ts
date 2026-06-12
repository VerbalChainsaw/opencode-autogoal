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

/** Replace {var} placeholders with values. Unresolved vars stay as literal "{var}". */
export function resolveTemplateVars(text: string, vars: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? `{${key}}`);
}

/** Validate a template: check all declared vars are used and no undefined vars referenced. */
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
          if (raw && typeof raw.description === "string") {
            results.push({ name, description: raw.description, builtin: false });
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

/** Import a user template. Returns ok or error. */
export function importTemplate(
  directory: string,
  name: string,
  content: string,
): { ok: true; path: string } | { ok: false; error: string } {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    return { ok: false, error: `Invalid template name '${name}'. Use letters, numbers, hyphens, and underscores only.` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err: any) {
    return { ok: false, error: `Invalid JSON: ${err?.message ?? err}` };
  }
  if (!validateTemplate(parsed)) {
    return { ok: false, error: "Template must have at least a 'condition' string field." };
  }
  if (content.length > 256 * 1024) {
    return { ok: false, error: "Template file too large (max 256KB)." };
  }

  const userDir = join(directory, ".opencode", "goals");
  if (!existsSync(userDir)) mkdirSync(userDir, { recursive: true });

  const targetPath = join(userDir, `${name}.json`);
  const tmp = `${targetPath}.tmp.${process.pid}.${Date.now()}`;
  try {
    writeFileSync(tmp, JSON.stringify(parsed, null, 2) + "\n", "utf-8");
    renameSync(tmp, targetPath);
  } catch (err: any) {
    try { unlinkSync(tmp); } catch { }
    return { ok: false, error: `Failed to write template: ${err?.message ?? err}` };
  }

  return { ok: true, path: targetPath };
}
