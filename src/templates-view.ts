/**
 * templates-view.ts — UI-friendly view over `discoverTemplates`.
 *
 * Wraps `discoverTemplates` (in templates.ts) with two ordering
 * policies the standalone TUI control center's `T` templates
 * picker needs:
 *
 *   1. Builtins come first, then user templates. The picker can
 *      group them visually (or split into two pages) without
 *      re-sorting on every keystroke.
 *   2. Both groups are sorted alphabetically by name, so the
 *      picker's `↑/↓` navigation is predictable.
 *
 * The wrapper also adds a `source` field ("builtin" | "user")
 * that the TUI renderer can use to render a small badge. This
 * duplicates `builtin` for backwards compat — the existing
 * `discoverTemplates` returns `builtin: boolean`, and the new
 * `source: "builtin" | "user"` is the picker-friendly spelling.
 *
 * Invalid user templates (missing fields, malformed JSON,
 * undeclared template vars) are silently skipped — same
 * contract as the underlying `discoverTemplates`. The
 * `template use` command is the canonical "I want a real
 * validation error" path; the picker is read-only.
 *
 * The `discoverTemplates` helper in templates.ts is the source
 * of truth for "what's discoverable" — this module does not
 * re-implement any of that logic.
 */

import { discoverTemplates } from "./templates.js";

export type TemplateSource = "builtin" | "user";

export interface TemplateSummary {
  name: string;
  description: string;
  builtin: boolean;
  source: TemplateSource;
}

/**
 * Discover all templates in a directory, sorted for the TUI
 * picker: builtins first (alphabetical by name), then user
 * templates (alphabetical by name). Returns `[]` on a
 * non-existent directory — `discoverTemplates` already handles
 * the missing `.opencode/goals/` case.
 */
export function discoverTemplatesForUi(directory: string): TemplateSummary[] {
  const raw = discoverTemplates(directory);
  const builtins = raw
    .filter((t) => t.builtin)
    .map(toSummary)
    .sort(byName);
  const user = raw
    .filter((t) => !t.builtin)
    .map(toSummary)
    .sort(byName);
  return [...builtins, ...user];
}

function toSummary(t: { name: string; description: string; builtin: boolean }): TemplateSummary {
  return {
    name: t.name,
    description: t.description,
    builtin: t.builtin,
    source: t.builtin ? "builtin" : "user",
  };
}

function byName(a: TemplateSummary, b: TemplateSummary): number {
  if (a.name < b.name) return -1;
  if (a.name > b.name) return 1;
  return 0;
}
