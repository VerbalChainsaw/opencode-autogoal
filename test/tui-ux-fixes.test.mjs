/**
 * Regression tests for the tui.tsx UX fixes (commit a8b9xxx):
 *
 *  - The Esc binding on the dashboard-close keymap must have
 *    `preventDefault: false, fallthrough: true` so the host's
 *    command-palette Esc-to-close handler can also fire. Without
 *    these, the plugin's Esc binding consumed the key event for
 *    the dashboard AND for the command palette, leaving the user
 *    "stuck" inside the palette with no way to back out except Ctrl-C.
 *
 *  - The dashboard's no-goal fallback must wrap the placeholder
 *    text in a `<box flexGrow={1}>` so Yoga doesn't collapse the
 *    parent (which would produce a "black screen" when there's no
 *    goal and the only JSX child is a text element).
 *
 * These tests are "shape of fix" tests — they read the source file
 * and assert the relevant pattern is present. They can't smoke-test
 * the rendered output (that needs a live OpenCode TUI host), but they
 * catch regressions where the fix is lost in a refactor.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const tuiSrc = readFileSync(join(here, "..", "src", "tui.tsx"), "utf-8");

test("tui.tsx: the Esc binding has preventDefault: false so the host's palette-Esc still fires", () => {
  // The fix: a literal { key: "esc", cmd: "goal.dashboard.close", ..., preventDefault: false, fallthrough: true }
  // somewhere in the bindings array. The exact order of properties
  // in the object literal may vary; the regression net is that BOTH
  // `preventDefault: false` AND `fallthrough: true` appear in the
  // esc binding block.
  const escBindingBlock = tuiSrc.match(/\{[^{}]*key:\s*"esc"[^{}]*\}/);
  assert.ok(escBindingBlock, "no esc binding block found in tui.tsx");
  const block = escBindingBlock[0];
  assert.ok(block.includes("preventDefault: false"),
    "Esc binding is missing preventDefault: false; the host's palette-Esc will be consumed");
  assert.ok(block.includes("fallthrough: true"),
    "Esc binding is missing fallthrough: true; later keymap handlers can't see the key");
});

test("tui.tsx: the no-goal fallback wraps placeholder text in a flexGrow=1 box (anti-black-screen)", () => {
  // The fix: the Show's fallback is no longer a single <text> — it's
  // a <box flexGrow={1} ... > that contains the placeholder text(s).
  // This ensures Yoga has a child with measurable intrinsic size and
  // the parent doesn't collapse to zero (which is what was producing
  // the "black screen" symptom on no-goal).
  // We assert the pattern: inside the Show's fallback, a <box
  // flexGrow={1}> appears. The fallback is a JSX expression between
  // `fallback={` and the matching `}`.
  const fallbackMatch = tuiSrc.match(/fallback=\{([\s\S]*?)\n        \}\n/);
  // If the regex above doesn't match, the fallback structure has
  // changed. We tolerate a different shape and instead look for
  // the specific pattern: a fallback containing a flexGrow={1} box.
  const fallbackBlock = fallbackMatch
    ? fallbackMatch[1]
    : (tuiSrc.match(/fallback=\{([\s\S]*?)\}\s*>\s*\{/)?.[1] ?? "");
  assert.ok(fallbackBlock.length > 0, "could not locate Show fallback block in tui.tsx");
  assert.ok(/<box[^>]*flexGrow=\{1\}/.test(fallbackBlock),
    "no-goal fallback is missing <box flexGrow={1}>; the parent may collapse to a black screen when no goal is set");
});

test("tui.tsx: the no-goal fallback text mentions pressing Esc (user is not stuck)", () => {
  // The fix: the no-goal fallback's text includes a hint about
  // pressing Esc. The user reported being unable to back out of
  // the dashboard; the explicit "(press esc to close this panel)"
  // text is the affordance.
  const fallbackMatch = tuiSrc.match(/fallback=\{([\s\S]*?)\n        \}\n/)
    ?? tuiSrc.match(/fallback=\{([\s\S]*?)\}\s*>\s*\{/);
  const fallbackBlock = fallbackMatch?.[1] ?? "";
  assert.ok(/press esc/i.test(fallbackBlock),
    "no-goal fallback should tell the user to press Esc");
});
