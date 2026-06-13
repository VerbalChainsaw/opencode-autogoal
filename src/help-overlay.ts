/**
 * help-overlay.ts — pure renderer for the v0.7.0 help
 * overlay. (E25 of the plan.)
 *
 * Takes the categorized sections, the current page index,
 * a search query, and a width, and returns the rendered
 * lines. The shell owns the page/search state; this module
 * is purely a function of its inputs.
 *
 * The shape mirrors the v0.7.0 `buildSessionPane` / `buildHelpOverlay`
 * pattern: pure data, no I/O, no state. The test surface in
 * `help-overlay.test.mjs` asserts: section header, key:action
 * rendering, page navigation, search filtering, and width
 * clamping.
 *
 * ── WHY PURE ────────────────────────────────────────────────────────
 *
 * The shell handles keystrokes (next/prev page, search) and
 * state (current page, current query). It calls
 * `buildHelpOverlay(sections, page, query, width)` every
 * time the help is rendered. The function is a function of
 * its inputs — same input always produces the same output —
 * which is the property the tests depend on.
 *
 * ── SEARCH SEMANTICS ───────────────────────────────────────────────
 *
 * Case-insensitive substring match against either `key` or
 * `action` of each entry. Empty query shows everything on the
 * current page. A query that matches nothing shows a
 * dedicated "no matches" line.
 */

import { truncate } from "./format.js";
import type { HelpSection } from "./help-content.js";

export function buildHelpOverlay(
  sections: ReadonlyArray<HelpSection>,
  page: number,
  query: string,
  width: number,
): string[] {
  const w = Math.max(20, Math.floor(width));

  // Clamp the page to the valid range. An out-of-range
  // page clamps to the last section (matches the test
  // "out-of-range page index clamps to the last page").
  const safePage = Math.max(0, Math.min(sections.length - 1, page));
  const section = sections[safePage];
  if (!section) {
    return [truncate("No help available.", w)];
  }

  const q = query.trim().toLowerCase();
  const filtered = q === ""
    ? section.entries
    : section.entries.filter((e) =>
        e.key.toLowerCase().includes(q) || e.action.toLowerCase().includes(q)
      );

  if (filtered.length === 0) {
    return [truncate(`─── ${section.label.toUpperCase()} ───`, w), truncate(`  (no matches for "${query}")`, w)];
  }

  const out: string[] = [];
  out.push(truncate(`─── ${section.label.toUpperCase()} ───`, w));
  for (const e of filtered) {
    out.push(truncate(`  ${e.key.padEnd(8)}  ${e.action}`, w));
  }
  // Pagination hint at the bottom.
  const nav = `Page ${safePage + 1}/${sections.length}  ·  n=next p=prev /=search Esc=close`;
  out.push(truncate(nav, w));
  return out;
}
