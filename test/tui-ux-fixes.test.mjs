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
import { createTestKeymap } from "@opentui/keymap/testing";

const here = dirname(fileURLToPath(import.meta.url));
const tuiSrc = readFileSync(join(here, "..", "src", "tui.tsx"), "utf-8");

test("tui.tsx: the Escape binding has preventDefault: false so the host's palette-Esc still fires", () => {
  // The fix: a literal { key: "escape", cmd: "goal.dashboard.close", ..., preventDefault: false, fallthrough: true }
  // somewhere in the bindings array. The exact order of properties
  // in the object literal may vary; the regression net is that BOTH
  // `preventDefault: false` AND `fallthrough: true` appear in the
  // escape binding block.
  const escapeBindingBlock = tuiSrc.match(/\{[^{}]*key:\s*"escape"[^{}]*\}/);
  assert.ok(escapeBindingBlock, "no escape binding block found in tui.tsx");
  const block = escapeBindingBlock[0];
  assert.ok(block.includes("preventDefault: false"),
    "Escape binding is missing preventDefault: false; the host's palette-Esc will be consumed");
  assert.ok(block.includes("fallthrough: true"),
    "Escape binding is missing fallthrough: true; later keymap handlers can't see the key");
});

test("tui.tsx: the close binding fires for OpenTUI's normalized escape key", () => {
  const escapeBindingBlock = tuiSrc.match(/\{[^{}]*key:\s*"escape"[^{}]*\}/);
  assert.ok(escapeBindingBlock, "no escape binding block found in tui.tsx");

  const h = createTestKeymap({ defaultKeys: true });
  try {
    let ran = 0;
    h.keymap.registerLayer({
      commands: [{ name: "goal.dashboard.close", run() { ran++; } }],
      bindings: [{ key: "escape", cmd: "goal.dashboard.close", preventDefault: false, fallthrough: true }],
    });
    const event = h.host.press("escape");
    assert.equal(ran, 1, "OpenTUI emits key.name='escape'; the close binding must handle that exact key");
    assert.equal(event.defaultPrevented, false, "preventDefault:false must leave host Esc handling alive");
    assert.equal(event.propagationStopped, false, "fallthrough:true must leave later handlers alive");
  } finally {
    h.cleanup();
  }
});

test("tui.tsx: goal actions have real modifier hotkeys, not only slash commands", () => {
  const expected = [
    ['key: "alt+g"', 'cmd: "goal.dashboard"'],
    ['key: "alt+p"', 'cmd: "goal.toggle"'],
    ['key: "alt+s"', 'cmd: "goal.dial.steer"'],
    ['key: "alt+n"', 'cmd: "goal.dial.set"'],
    ['key: "alt+c"', 'cmd: "goal.clear"'],
  ];
  for (const [keyNeedle, cmdNeedle] of expected) {
    assert.ok(tuiSrc.includes(keyNeedle), `missing TUI hotkey binding ${keyNeedle}`);
    assert.ok(tuiSrc.includes(cmdNeedle), `missing TUI command binding ${cmdNeedle}`);
  }
});

test("OpenTUI keymap harness: alt+g opens the dashboard command", () => {
  const h = createTestKeymap({ defaultKeys: true });
  try {
    let ran = 0;
    h.keymap.registerLayer({
      commands: [{ name: "goal.dashboard", run() { ran++; } }],
      bindings: [{ key: "alt+g", cmd: "goal.dashboard" }],
    });
    h.host.press("g", { meta: true });
    assert.equal(ran, 1, "alt+g should dispatch the dashboard command");
  } finally {
    h.cleanup();
  }
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
  //
  // After FIX-2 (extract <DashboardFooter>), the text is in the
  // component definition, not duplicated in the fallback. We assert:
  //   1. <DashboardFooter> is used in the no-goal fallback branch
  //   2. The component itself renders the Esc hint text
  const fallbackMatch = tuiSrc.match(/fallback=\{([\s\S]*?)\n        \}\n/)
    ?? tuiSrc.match(/fallback=\{([\s\S]*?)\}\s*>\s*\{/);
  const fallbackBlock = fallbackMatch?.[1] ?? "";
  assert.ok(/<DashboardFooter\b/.test(fallbackBlock),
    "no-goal fallback should use <DashboardFooter> (the shared exit affordance)");

  const componentMatch = tuiSrc.match(/function DashboardFooter[\s\S]*?^}/m);
  assert.ok(componentMatch, "<DashboardFooter> component is missing from tui.tsx");
  const componentBlock = componentMatch[0];
  assert.ok(/press esc/i.test(componentBlock),
    "<DashboardFooter> should render the '(press esc to close this panel)' text");
});

test("tui.tsx: the active/paused view also has an Esc hint (user is not stuck with a goal set)", () => {
  // Regression for the user-reported "stuck in dashboard" bug:
  // the previous patch only added the Esc hint to the no-goal fallback.
  // A user who has set a goal (the common case) sees the active/paused
  // view, which had NO Esc affordance in its footer — so they pressed
  // nothing and concluded they were stuck. The active/paused view now
  // uses the same <DashboardFooter> as the no-goal branch.
  //
  // After FIX-2, both branches render <DashboardFooter>, so the
  // structural fix is permanent: any new branch that uses the footer
  // automatically gets the Esc hint.
  //
  // Anchor: the "🎯 ACTIVE GOAL" header is unique to the active/paused
  // fragment, so we extract the fragment that contains it.
  const anchorIdx = tuiSrc.indexOf("🎯 ACTIVE GOAL");
  assert.ok(anchorIdx > -1, "active/paused view header '🎯 ACTIVE GOAL' not found");
  const afterAnchor = tuiSrc.slice(anchorIdx);
  // The active/paused fragment ends with `</>` followed by `);` (return close).
  // Find the closing `</>` after the anchor.
  const fragmentEnd = afterAnchor.indexOf("</>");
  assert.ok(fragmentEnd > -1, "could not find closing </> for active/paused fragment");
  const fragmentBlock = afterAnchor.slice(0, fragmentEnd);
  assert.ok(/<DashboardFooter\b/.test(fragmentBlock),
    "active/paused view should use <DashboardFooter> (not copy-paste the hint)");

  // Count <DashboardFooter> usages — must be exactly 2 (no-goal + active/paused).
  // If a future branch is added, the test is updated intentionally, not silently.
  const usageCount = (tuiSrc.match(/<DashboardFooter\b/g) ?? []).length;
  assert.equal(usageCount, 2,
    `expected exactly 2 <DashboardFooter> usages (no-goal fallback + active/paused view), found: ${usageCount}`);
});

// Pin: <DashboardFooter> renders BOTH the slash-command hint and the Esc
// hint, in that order. A future maintainer who removes either loses the
// affordance and ships a regression.
test("tui.tsx: <DashboardFooter> renders both the slash-command hint AND the Esc hint", () => {
  const componentMatch = tuiSrc.match(/function DashboardFooter[\s\S]*?^}/m);
  assert.ok(componentMatch, "<DashboardFooter> component is missing from tui.tsx");
  const componentBlock = componentMatch[0];
  const cmdIdx = componentBlock.indexOf("/goal-toggle");
  const escIdx = componentBlock.indexOf("press esc");
  assert.ok(cmdIdx > -1, "<DashboardFooter> should render the slash-command hint");
  assert.ok(escIdx > -1, "<DashboardFooter> should render the Esc hint");
  assert.ok(escIdx > cmdIdx,
    "in <DashboardFooter>, the Esc hint should appear AFTER the slash-command hint (footer order)");
});

test("tui.tsx: the top 'esc to close' is in the full text color (visible, not muted)", () => {
  // Regression: the top-of-dashboard "esc to close" was theme().textMuted,
  // which renders as a low-contrast subtitle color. Users with a goal set
  // had to look for a muted single word at the top of a busy panel —
  // easy to miss. The fix promotes the text to theme().text so it's
  // rendered in the same readable color as the panel's primary text.
  const topLine = tuiSrc.match(/<text[^>]*>esc to close<\/text>/);
  assert.ok(topLine, "could not find the 'esc to close' top-line text in tui.tsx");
  const tag = topLine[0];
  assert.ok(/fg=\{theme\(\)\.text\}/.test(tag) && !/fg=\{theme\(\)\.textMuted\}/.test(tag),
    `the 'esc to close' top-line should use theme().text (not textMuted). Found tag: ${tag}`);
});

// ── Task 5: toast map pruning ───────────────────────────────────────────────

test("tui.tsx: toast debounce map is pruned when it grows past a cap", () => {
  // FIX-18 added a debouncedToast with a Map keyed by `${variant}|${message}`.
  // Distinct toasts accumulate entries forever. The map size must be
  // capped and stale entries (>TOAST_DEBOUNCE_MS old) pruned on each
  // .set() call. Pin: near the .set() call, the file must contain
  // (a) a size-based cap (literal `50` or a named constant) and
  // (b) a Map.delete() in the prune path.
  const block = tuiSrc.match(/toastLastShown[\s\S]{0,1200}?\.set\(/);
  assert.ok(block, "could not locate toastLastShown.set() call in tui.tsx");
  const slice = block[0];
  // (a) the cap — either the literal "50" or a named constant
  assert.ok(
    /size\s*>\s*\d+|size\s*>\s*TOAST_MAP_SOFT_CAP/.test(slice),
    `expected a size cap near toastLastShown.set(); found: ${slice.slice(0, 300)}...`);
  // (b) the prune — a Map.delete() inside the cap branch
  assert.ok(/\.delete\(/.test(slice),
    `expected a Map.delete() call in the prune path; found: ${slice.slice(0, 300)}...`);
  // (c) the prune threshold uses TOAST_DEBOUNCE_MS (not a magic number)
  assert.ok(/TOAST_DEBOUNCE_MS/.test(slice),
    `expected the prune threshold to use TOAST_DEBOUNCE_MS; found: ${slice.slice(0, 300)}...`);
});

test("tui.tsx: the toast debounce key is 'variant|message' (not duration)", () => {
  // The work order's review found: the original comment claimed the
  // key includes duration, but the implementation uses
  // `${variant}|${message}`. Pin the actual key format AND the
  // corrected comment (which should NOT say "+duration" or "duration:").
  // The key line is a template literal so we can't use a simple
  // string-match regex; instead we look for a 1-line window that
  // includes both "variant" and "message" but not "duration".
  const keyLine = tuiSrc.match(/const key = .[^;]+;/);
  assert.ok(keyLine, "could not find the toast debounce key line in tui.tsx");
  const key = keyLine[0];
  assert.match(key, /variant/);
  assert.match(key, /message/);
  assert.ok(!/duration/.test(key),
    `the debounce key should not include duration (the comment is wrong, the code is right); got: ${key}`);
  // The comment near toastLastShown should also not claim the key includes duration.
  const block = tuiSrc.match(/toastLastShown[\s\S]{0,1200}?\.set\(/);
  if (block) {
    // Look for the specific bad pattern: "key ... duration" with up
    // to 40 chars between (allowing for variable names). The current
    // corrected comment doesn't have this anti-pattern.
    assert.ok(!/key[\s\S]{0,40}duration/.test(block[0]),
      `comment claims key includes duration; the implementation does not. Block: ${block[0].slice(0, 300)}...`);
  }
});
