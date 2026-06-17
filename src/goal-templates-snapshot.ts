/**
 * Goal templates snapshot — a UI-ready mirror of the available goal
 * templates (builtins + the user's `.opencode/goals/<name>.json` files),
 * written to `.opencode/goal-templates.json` for the desktop dock to poll.
 *
 * Why a snapshot file? The dock lives in a separate repo (the OpenCode
 * desktop app) and can only read JSON via the SDK's `file.read`; it cannot
 * call `discoverTemplates` across the repo boundary. So the plugin projects
 * the discovered templates into a small file the dock renders as quick-start
 * buttons — the same pattern as `goal-history.json` (see goal-history.ts).
 *
 * The snapshot is materialized lazily: it is only written when there are
 * user templates to surface (or the file already exists), so a workspace
 * that never defines custom templates does not get an extra file written
 * into `.opencode/`. The dock falls back to the built-in three when the
 * file is absent, so old plugin versions degrade gracefully.
 *
 * Writing is best-effort: any failure is swallowed so a snapshot write can
 * never break a goal command or plugin initialization.
 */

import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { discoverTemplates, exportTemplate, type GoalTemplate } from "./templates.js";

export const GOAL_TEMPLATES_FILE = ".opencode/goal-templates.json";

export interface TemplateButton {
  /** Template id — what `/goal template <id>` expects. Matches /^[A-Za-z0-9_-]+$/. */
  id: string;
  /** Short, button-friendly label derived from the id ("fix-lint" → "Fix lint"). */
  label: string;
  /** The template's one-line description (used as a tooltip in the dock). */
  description: string;
  /** The actual goal condition the template will set, before variable substitution. */
  condition: string;
  /** Optional verification command, before variable substitution. */
  command?: string;
  /** Optional per-template constraints. */
  constraints?: GoalTemplate["constraints"];
  /** Optional variable definitions used by condition/command placeholders. */
  variables?: GoalTemplate["variables"];
  /** True for the package's built-in templates, false for user templates. */
  builtin: boolean;
}

export interface TemplatesSnapshot {
  version: 1;
  templates: TemplateButton[];
}

/**
 * Derive a short, capitalized button label from a template id.
 * "fix-lint" → "Fix lint", "pass-tests" → "Pass tests",
 * "my_custom_goal" → "My custom goal". Falls back to the raw id.
 */
export function templateLabel(id: string): string {
  const spaced = id.replace(/[-_]+/g, " ").trim();
  if (!spaced) return id;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Build the snapshot view-model from the workspace's discovered templates. */
export function buildTemplatesSnapshot(directory: string): TemplatesSnapshot {
  const discovered = discoverTemplates(directory);
  const byId = new Map<string, TemplateButton>();
  const order: string[] = [];
  for (const t of discovered) {
    const tpl = exportTemplate(directory, t.name);
    if (!tpl) continue;
    if (!byId.has(t.name)) order.push(t.name);
    const description = typeof tpl.description === "string" ? tpl.description : t.description ?? "";
    byId.set(t.name, {
      id: t.name,
      label: templateLabel(t.name),
      description,
      condition: tpl.condition,
      ...(typeof tpl.command === "string" ? { command: tpl.command } : {}),
      ...(tpl.constraints ? { constraints: tpl.constraints } : {}),
      ...(tpl.variables ? { variables: tpl.variables } : {}),
      builtin: t.builtin,
    });
  }
  return {
    version: 1,
    templates: order.flatMap((id) => {
      const item = byId.get(id);
      return item ? [item] : [];
    }),
  };
}

/**
 * Write (or refresh) the templates snapshot. Best-effort and lazily gated:
 * the file is only written when there is at least one user template to show,
 * or when the file already exists (so it stays accurate after a user removes
 * their last custom template). A workspace that only ever uses the builtins
 * never gets the file — the dock's built-in fallback covers that case.
 */
export function writeTemplatesSnapshot(directory: string): void {
  try {
    const snapshot = buildTemplatesSnapshot(directory);
    const path = join(directory, GOAL_TEMPLATES_FILE);
    const hasUserTemplates = snapshot.templates.some((t) => !t.builtin);
    if (!hasUserTemplates && !existsSync(path)) return;
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
    writeFileSync(tmp, JSON.stringify(snapshot, null, 2) + "\n", "utf-8");
    renameSync(tmp, path);
  } catch {
    // Best-effort: a snapshot write must never break a command or init.
  }
}
