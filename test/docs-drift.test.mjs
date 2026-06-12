/**
 * Regression test for defect A-1 (REVIEW-V040-MULTI-ANGLE.md §2.7):
 *
 * 14 references to a non-existent `withStateLock` helper existed across
 * CHANGELOG.md, specs/v0.4.0-roadmap.md, and src/tui-logic.ts even
 * though the helper was removed in commit 4217a13 (v0.3.0). v0.3.0 was
 * also missing from CHANGELOG.md (the file jumped from `## 0.2.1` to
 * `## 0.4.0`).
 *
 * This test pins:
 *   1. `withStateLock` does not appear anywhere under `src/` (the
 *      helper was removed in v0.3.0 and must not be re-introduced).
 *   2. CHANGELOG.md has a `## 0.3.0` section (the entry is
 *      load-bearing historical context for the v0.4.0 concurrency
 *      stance — see src/goal-state.ts:537-550 and
 *      specs/v0.4.0-roadmap.md).
 *
 * If a future maintainer re-introduces the lock by accident (e.g. a
 * code review misses the call, or a refactor copies a stale comment),
 * the test fails with the offending file:line so the fix is cheap.
 *
 * Run from the repo root: `node --test test/docs-drift.test.mjs`.
 * No external dependencies (no `rg` shell-out, no `child_process`) —
 * uses node:fs + node:path + a hand-rolled substring grep so the
 * test works identically on win × ubuntu × node 20/22.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

/**
 * Recursively walk `dir` collecting file paths. Skips common
 * non-source directories (node_modules, dist, .git, hidden).
 */
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === ".git") continue;
    if (entry.startsWith(".")) continue;
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) out.push(...walk(full));
    else if (s.isFile()) out.push(full);
  }
  return out;
}

/**
 * Find every line in `file` that contains `needle` (1-indexed line
 * numbers). Returns `[]` if the file has no match.
 */
function findMatches(file, needle) {
  const text = readFileSync(file, "utf-8");
  const lines = text.split(/\r?\n/);
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(needle)) {
      hits.push({ line: i + 1, text: lines[i] });
    }
  }
  return hits;
}

// ── Test 1: src/ has zero `withStateLock` references ────────────────────

test("docs-drift: src/ has no references to the removed withStateLock helper", () => {
  // The helper was removed in v0.3.0 (commit 4217a13). Any
  // reference in src/ means a stale comment survived a refactor
  // (the original defect was 2 stale comments in
  // src/tui-logic.ts:120, 142) or — worse — someone re-added the
  // helper. Either way, the test fails with the file:line.
  const srcDir = join(repoRoot, "src");
  const files = walk(srcDir);
  const violations = [];
  for (const file of files) {
    const hits = findMatches(file, "withStateLock");
    for (const h of hits) {
      violations.push({ file: relative(repoRoot, file), line: h.line, text: h.text.trim() });
    }
  }
  if (violations.length > 0) {
    const msg = violations
      .map((v) => `  ${v.file}:${v.line}  ${v.text}`)
      .join("\n");
    assert.fail(
      `withStateLock was removed in v0.3.0 (commit 4217a13). ` +
      `Found ${violations.length} stale reference(s) in src/:\n${msg}\n` +
      `See CHANGELOG.md ## 0.3.0 and src/goal-state.ts:537-550 for the ` +
      `current concurrency stance (atomic write + state.id re-read, ` +
      `last-rename-wins is accepted UX).`,
    );
  }
});

// ── Test 2: CHANGELOG.md has a ## 0.3.0 section ─────────────────────────

test("docs-drift: CHANGELOG.md has a ## 0.3.0 section", () => {
  // v0.3.0 is load-bearing historical context: the commit message
  // and the security-review trail that justified removing the
  // advisory file lock. Without it, the v0.4.0 concurrency stance
  // (atomic write + no lock + last-rename-wins) reads as if it
  // appeared from nowhere, and a future maintainer looking for
  // the v0.2.0-rc.10 `withStateLock` helper would be confused.
  const changelog = readFileSync(join(repoRoot, "CHANGELOG.md"), "utf-8");
  // Match the section header at the start of a line, optional
  // leading whitespace, then `## 0.3.0` followed by either EOL or
  // a non-digit (so we don't accidentally match `## 0.3.0-rc.X`).
  const sectionRe = /^## 0\.3\.0(\s|$)/m;
  assert.match(
    changelog,
    sectionRe,
    "CHANGELOG.md is missing a `## 0.3.0` section. The v0.3.0 release " +
    "(commit 4217a13, refactor(lock): remove advisory file lock) is " +
    "load-bearing historical context for the v0.4.0 concurrency stance. " +
    "Insert a `## 0.3.0` section between `## 0.4.0` and `## 0.2.1` " +
    "documenting the withStateLock removal and the replacement pattern.",
  );
});
