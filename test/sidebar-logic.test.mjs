/**
 * Tests for the sidebar's pure logic layer.
 *
 * The sidebar itself (`src/sidebar.tsx`) is JSX and runs inside the
 * OpenCode TUI host; it can't be loaded in `node --test`. The pure
 * view-model layer (`src/sidebar-logic.ts`) can be — and these tests
 * exercise the exact same `buildSidebarView`, `buildSidebarTitle`,
 * `buildSidebarContent`, `buildSidebarFooter`, `sanitizeForSidebar`,
 * and `truncate` that the JSX layer calls.
 *
 * The sidebar reuses the validated I/O from `tui-logic.ts`
 * (`readDashboardState`, `computeProgress`) so the "no crash on corrupt
 * state" and "no negative bar length" cases are already covered by
 * `test/tui-logic.test.mjs`. The sidebar-specific risk class is the
 * view-model: does it survive hostile conditions, exotic unicode, and
 * pathological numeric inputs without breaking the sidebar layout?
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildSidebarView,
  buildSidebarTitle,
  buildSidebarContent,
  buildSidebarFooter,
  sanitizeForSidebar,
  truncate,
} from "../dist/sidebar-logic.js";
import { setGoal } from "../dist/goal-state.js";

function freshDir() {
  return mkdtempSync(join(tmpdir(), "opengoal-sidebar-"));
}

function plantCorruptState(dir, payload) {
  mkdirSync(join(dir, ".opencode"), { recursive: true });
  writeFileSync(join(dir, ".opencode", ".goal-state.json"), JSON.stringify(payload));
}

const VALID_STATE = () => ({
  version: 1, id: "test-id", condition: "ship the feature", command: null,
  status: "active",
  createdAt: 1, startedAt: 1, completedAt: null, pausedAt: null, resumedAt: null,
  turnsEvaluated: 0, tokensUsed: 0, lastEvaluation: null, evaluationHistory: [],
  constraints: { maxTurns: 20, maxTimeMinutes: 30, maxTokens: 100000 },
  metadata: { setBy: "user" },
});

// ── sanitizeForSidebar ─────────────────────────────────────────────────────

test("sanitizeForSidebar: drops newlines, tabs, and control chars", () => {
  // A condition like "line1\nline2\tcolumn" should not break the sidebar's
  // single-line title slot. Newlines and tabs become spaces; the C0 control
  // range (0x00-0x1F except 0x09/0x0A/0x0D which become spaces) is dropped.
  const input = "line1\nline2\tcol\x00bell\x07\x1b[31mRED\x1b[0m";
  const out = sanitizeForSidebar(input);
  assert.ok(!out.includes("\n"));
  assert.ok(!out.includes("\t"));
  assert.ok(!out.includes("\x00"));
  assert.ok(!out.includes("\x07"));
  assert.ok(!out.includes("\x1b"));
  assert.ok(out.includes("line1"));
  assert.ok(out.includes("line2"));
  assert.ok(out.includes("col"));
  assert.ok(out.includes("RED"));
});

test("sanitizeForSidebar: drops Unicode zero-width space (U+200B)", () => {
  // The previous sanitizer did NOT catch U+200B; a 3-char ZWSP string
  // would survive. The new sanitizer (delegates to sanitizeForPrompt)
  // drops it. A zero-width char is "empty" for display purposes.
  const out = sanitizeForSidebar("a\u200Bb\u200Bc");
  assert.equal(out, "abc");
});

test("sanitizeForSidebar: drops U+2028 line separator and U+2029 paragraph separator", () => {
  // Some renderers (iTerm2, some LLMs) treat U+2028/U+2029 as line
  // terminators. A condition containing them could break the single-line
  // title slot.
  const out = sanitizeForSidebar("line1\u2028line2\u2029line3");
  assert.equal(out, "line1 line2 line3"); // U+2028 and U+2029 become spaces
});

test("sanitizeForSidebar: drops bidi overrides (U+202A-U+202E)", () => {
  // A planted bidi override can flip a single-line condition RTL and
  // re-arrange visible text. Drop them.
  const out = sanitizeForSidebar("a\u202Eb\u202Dc");
  assert.equal(out, "abc");
});

test("sanitizeForSidebar: drops BOM (U+FEFF)", () => {
  const out = sanitizeForSidebar("\uFEFFhello");
  assert.equal(out, "hello");
});

test("sanitizeForSidebar: a string of only zero-width chars → empty", () => {
  const out = sanitizeForSidebar("\u200B\u200B\u200B");
  assert.equal(out, "");
});

test("sanitizeForSidebar: drops C1 control range (U+0080..U+009F)", () => {
  // C1 controls are the unicode range 0x80..0x9F. They're not printable.
  // A real-world attacker could put these in a condition to inject
  // terminal escapes; the sanitizer drops them.
  const input = "before\x85middle\x9fafter";
  const out = sanitizeForSidebar(input);
  assert.equal(out, "beforemiddleafter");
});

test("sanitizeForSidebar: preserves printable unicode (emoji + CJK)", () => {
  // Emoji and CJK are printable; they should pass through. The sidebar
  // renders unicode in titles/conditions correctly.
  const input = "🎯 ship the 日本語 feature";
  const out = sanitizeForSidebar(input);
  assert.equal(out, input);
});

test("sanitizeForSidebar: collapses runs of spaces to one", () => {
  const input = "a   b     c";
  assert.equal(sanitizeForSidebar(input), "a b c");
});

test("sanitizeForSidebar: trims leading/trailing whitespace", () => {
  assert.equal(sanitizeForSidebar("   hello   "), "hello");
});

test("sanitizeForSidebar: empty string → empty string", () => {
  assert.equal(sanitizeForSidebar(""), "");
});

test("sanitizeForSidebar: non-string input → empty string (defense-in-depth)", () => {
  // The TypeScript type says string. But if a corrupt state file has a
  // number for the condition, the runtime JSON parser will give us a
  // number. The sanitizer should not crash.
  assert.equal(sanitizeForSidebar(undefined), "");
  assert.equal(sanitizeForSidebar(null), "");
  assert.equal(sanitizeForSidebar(42), "");
});

// ── truncate ───────────────────────────────────────────────────────────────

test("truncate: short string returns as-is", () => {
  assert.equal(truncate("hello", 10), "hello");
});

test("truncate: long string gets … suffix", () => {
  const s = "a".repeat(30);
  const out = truncate(s, 10);
  assert.equal(out.length, 10);
  assert.ok(out.endsWith("…"));
  assert.equal(out, "a".repeat(9) + "…");
});

test("truncate: maxLen=1 returns just the ellipsis (no overflow)", () => {
  assert.equal(truncate("hello", 1), "…");
});

test("truncate: maxLen=0 returns the ellipsis (defensive — no crash on bad input)", () => {
  // Out of contract (callers should use maxLen >= 1) but should not crash.
  // The current implementation's early-return guard `maxLen <= 1 → "…"`
  // treats 0 the same as 1, which is acceptable: any caller passing 0 is
  // already misbehaving, and the user sees a single-char indicator
  // instead of a crash.
  assert.equal(truncate("hello", 0), "…");
});

// ── buildSidebarTitle ──────────────────────────────────────────────────────

test("buildSidebarTitle: no state → empty-state title", () => {
  assert.equal(buildSidebarTitle(null), "🎯 no goal");
});

test("buildSidebarTitle: active goal with short condition → icon + body", () => {
  const s = { ...VALID_STATE(), condition: "do the thing" };
  assert.equal(buildSidebarTitle(s), "🎯 do the thing");
});

test("buildSidebarTitle: paused goal → pause icon + body", () => {
  const s = { ...VALID_STATE(), condition: "do the thing", status: "paused" };
  assert.equal(buildSidebarTitle(s), "⏸ do the thing");
});

test("buildSidebarTitle: long condition is truncated to 60 chars with …", () => {
  const long = "x".repeat(200);
  const s = { ...VALID_STATE(), condition: long };
  const out = buildSidebarTitle(s);
  // "🎯 " (3 chars) + 60-char body = 63 chars total
  assert.equal(out.length, 63);
  assert.ok(out.startsWith("🎯 "));
  assert.ok(out.endsWith("…"));
});

test("buildSidebarTitle: condition with newlines gets sanitized (single line)", () => {
  // A hostile condition with embedded newlines should NOT produce a
  // multi-line title. The sanitizer collapses them.
  const s = { ...VALID_STATE(), condition: "first\nsecond\nthird" };
  const out = buildSidebarTitle(s);
  assert.ok(!out.includes("\n"));
  assert.ok(out.includes("first"));
  assert.ok(out.includes("second"));
});

test("buildSidebarTitle: empty condition → (empty condition) placeholder", () => {
  // After sanitization, an all-whitespace condition becomes "". Show a
  // visible placeholder so the user knows the goal exists but has no
  // description.
  const s = { ...VALID_STATE(), condition: "   \t  " };
  assert.equal(buildSidebarTitle(s), "🎯 (empty condition)");
});

test("buildSidebarTitle: condition with only control chars → placeholder", () => {
  const s = { ...VALID_STATE(), condition: "\x00\x07\x1b" };
  assert.equal(buildSidebarTitle(s), "🎯 (empty condition)");
});

// ── buildSidebarContent ────────────────────────────────────────────────────

test("buildSidebarContent: no goal → 5-line empty-state block", () => {
  const out = buildSidebarContent(null, null, null, Date.now());
  const lines = out.split("\n");
  assert.equal(lines.length, 5);
  assert.ok(out.includes("(no active goal)"));
  assert.ok(out.includes("/goal set"));
});

test("buildSidebarContent: active goal at 0% → progress bar at start", () => {
  const s = { ...VALID_STATE(), turnsEvaluated: 0 };
  const out = buildSidebarContent(s, null, null, s.startedAt);
  // First line: bar + " <pct>%"
  const firstLine = out.split("\n")[0];
  assert.ok(firstLine.startsWith("░".repeat(20)));
  assert.ok(firstLine.includes("  0%"));
});

test("buildSidebarContent: active goal at 50% → half bar", () => {
  const s = { ...VALID_STATE(), turnsEvaluated: 10 };
  const out = buildSidebarContent(s, null, null, s.startedAt);
  const firstLine = out.split("\n")[0];
  assert.ok(firstLine.startsWith("█".repeat(10) + "░".repeat(10)));
  assert.ok(firstLine.includes(" 50%"));
});

test("buildSidebarContent: shows turns N/M and time elapsed/M", () => {
  const s = {
    ...VALID_STATE(),
    turnsEvaluated: 5,
    constraints: { maxTurns: 20, maxTimeMinutes: 30, maxTokens: 100000 },
  };
  const out = buildSidebarContent(s, null, null, s.startedAt + 5 * 60_000);
  // Line 2 has the counters. Format: "turns:  5/20    time: 5/30m"
  const countersLine = out.split("\n")[1];
  assert.ok(countersLine.includes("turns:"));
  assert.ok(countersLine.includes("5/20"));
  assert.ok(countersLine.includes("time:"));
  assert.ok(countersLine.includes("5/30m"));
});

test("buildSidebarContent: shows lastEvaluation reason when present", () => {
  const s = {
    ...VALID_STATE(),
    lastEvaluation: { at: 1, reason: "tests pass", output: "ok" },
  };
  const out = buildSidebarContent(s, null, null, Date.now());
  const lastLine = out.split("\n")[2];
  assert.ok(lastLine.startsWith("tokens:"));
  assert.ok(lastLine.includes("last:"));
  assert.ok(lastLine.includes("tests pass"));
});

test("buildSidebarContent: lastEvaluation absent → em dash", () => {
  const s = { ...VALID_STATE(), lastEvaluation: null };
  const out = buildSidebarContent(s, null, null, Date.now());
  const lastLine = out.split("\n")[2];
  assert.ok(lastLine.includes("last:"));
  assert.ok(lastLine.includes("—"));
});

test("buildSidebarContent: lastEvaluation reason with newlines is sanitized", () => {
  // A malicious lastEvaluation.reason (from a hostile state file) should
  // not break the sidebar's line layout. Newlines become spaces.
  const s = {
    ...VALID_STATE(),
    lastEvaluation: { at: 1, reason: "first\nsecond\nthird", output: "" },
  };
  const out = buildSidebarContent(s, null, null, Date.now());
  // The content block's token+last line is a single line
  assert.equal(out.split("\n")[2].includes("first\nsecond"), false);
  assert.ok(out.split("\n")[2].includes("first"));
  assert.ok(out.split("\n")[2].includes("second"));
});

test("buildSidebarContent: never produces negative-length bar even with hostile inputs", () => {
  // Defense-in-depth: a corrupt state with negative turnsEvaluated or
  // zero maxTurns could in principle reach this function. The progress
  // bar should always be 20 chars and contain no NaN/undefined tokens.
  const s = { ...VALID_STATE(), turnsEvaluated: -1, constraints: { maxTurns: 0, maxTimeMinutes: 0, maxTokens: 0 } };
  const out = buildSidebarContent(s, null, null, Date.now());
  const firstLine = out.split("\n")[0];
  // Bar is the first 20 chars
  const bar = firstLine.slice(0, 20);
  assert.equal(bar.length, 20);
  assert.ok(!bar.includes("undefined"));
  assert.ok(!bar.includes("NaN"));
  assert.ok(!bar.includes("null"));
});

test("buildSidebarContent: shows tokens used/max with thousands separators", () => {
  const s = {
    ...VALID_STATE(),
    tokensUsed: 12345,
    constraints: { maxTurns: 20, maxTimeMinutes: 30, maxTokens: 100000 },
  };
  const out = buildSidebarContent(s, null, null, s.startedAt);
  const tokensLine = out.split("\n")[2];
  assert.ok(tokensLine.includes("12,345"));
  assert.ok(tokensLine.includes("100,000"));
});

test("buildSidebarContent: steering count shown when > 0", () => {
  const s = {
    ...VALID_STATE(),
    metadata: { setBy: "user", steering: [{ at: 1, note: "n1" }, { at: 2, note: "n2" }] },
  };
  const out = buildSidebarContent(s, null, null, Date.now());
  // Line 4 has the "ctrl" label
  const ctrlLine = out.split("\n")[3];
  assert.ok(ctrlLine.startsWith("ctrl:"));
  assert.ok(ctrlLine.includes("2 steer notes"));
});

test("buildSidebarContent: handoff indicator shown when handoff present", () => {
  const s = { ...VALID_STATE() };
  const out = buildSidebarContent(s, null, { createdAt: "2026-06-10T00:00:00Z" }, Date.now());
  const ctrlLine = out.split("\n")[3];
  assert.ok(ctrlLine.includes("⤴ handoff"));
});

test("buildSidebarContent: handoff + steering shown together", () => {
  const s = {
    ...VALID_STATE(),
    metadata: { setBy: "user", steering: [{ at: 1, note: "n1" }] },
  };
  const out = buildSidebarContent(s, null, { createdAt: "2026-06-10T00:00:00Z" }, Date.now());
  const ctrlLine = out.split("\n")[3];
  assert.ok(ctrlLine.includes("1 steer note"));
  assert.ok(ctrlLine.includes("⤴ handoff"));
});

test("buildSidebarContent: no ctrl line when no steering and no handoff", () => {
  const s = { ...VALID_STATE() };
  const out = buildSidebarContent(s, null, null, Date.now());
  // Only 3 lines: bar, counters, tokens+last
  assert.equal(out.split("\n").length, 3);
});

test("buildSidebarContent: last 3 evaluations shown in most-recent-first order", () => {
  const s = {
    ...VALID_STATE(),
    evaluationHistory: [
      { at: 1, reason: "first", met: false, confidence: 0.5, evaluatorType: "deterministic" },
      { at: 2, reason: "second", met: false, confidence: 0.5, evaluatorType: "deterministic" },
      { at: 3, reason: "third", met: true, confidence: 1, evaluatorType: "deterministic" },
      { at: 4, reason: "fourth", met: true, confidence: 1, evaluatorType: "deterministic" },
      { at: 5, reason: "fifth", met: true, confidence: 1, evaluatorType: "deterministic" },
    ],
  };
  const out = buildSidebarContent(s, null, null, Date.now());
  const lines = out.split("\n");
  // Find the "──── eval history ────" line and assert the next 3 are the
  // most recent 3 in reverse order.
  const histIdx = lines.findIndex((l) => l.includes("eval history"));
  assert.ok(histIdx > 0);
  assert.ok(lines[histIdx + 1].includes("fifth"));
  assert.ok(lines[histIdx + 2].includes("fourth"));
  assert.ok(lines[histIdx + 3].includes("third"));
  // First and second should NOT be in the strip
  assert.ok(!lines.some((l) => l.includes("first") || l.includes("second")));
});

test("buildSidebarContent: eval strip uses ✓ for met, ! for blocked, · for in-progress", () => {
  // The strip tags are PREPENDED to the reason line. We assert against
  // the specific lines, but the order of the strip is most-recent-first
  // (the last in evaluationHistory). So:
  //   history[0] = met → not in strip (it's the OLDEST)
  //   history[1] = blocked → second-most-recent → ✓ check on lines[histIdx+1]? No, history[1] is the 2nd of 3, the strip's lines are:
  //     lines[histIdx+1] = history[2] (met, ✓)
  //     lines[histIdx+2] = history[1] (blocked, !)
  //     lines[histIdx+3] = history[0] (in-progress, ·)
  // Wait — that's reversed because the strip reverses. Let me re-read:
  //   history = [met, blocked, in-prog]
  //   slice(-3).reverse() = [in-prog, blocked, met]
  // So lines[histIdx+1]=in-prog, lines[histIdx+2]=blocked, lines[histIdx+3]=met.
  // The test below was wrong. Let me redo it correctly.
  const s = {
    ...VALID_STATE(),
    evaluationHistory: [
      { at: 1, reason: "a", met: true, confidence: 1, evaluatorType: "deterministic" },
      { at: 2, reason: "b", met: false, confidence: 0, blocked: true, evaluatorType: "deterministic" },
      { at: 3, reason: "c", met: false, confidence: 0, evaluatorType: "deterministic" },
    ],
  };
  const out = buildSidebarContent(s, null, null, Date.now());
  const lines = out.split("\n");
  const histIdx = lines.findIndex((l) => l.includes("eval history"));
  // strip is most-recent-first: [c (in-prog), b (blocked), a (met)]
  assert.ok(lines[histIdx + 1].includes("·")); // in-prog
  assert.ok(lines[histIdx + 2].includes("!")); // blocked
  assert.ok(lines[histIdx + 3].includes("✓")); // met
});

test("buildSidebarContent: last edit timestamp shown when condition was edited", () => {
  const now = 100_000_000_000;
  const s = {
    ...VALID_STATE(),
    metadata: { setBy: "user", conditionEditedAt: now - 5 * 60_000 },
  };
  const out = buildSidebarContent(s, null, null, now);
  assert.ok(out.includes("last edit:"));
  assert.ok(out.includes("5m ago"));
});

test("buildSidebarContent: no 'last edit' line when conditionEditedAt is absent", () => {
  const s = { ...VALID_STATE() };
  const out = buildSidebarContent(s, null, null, Date.now());
  assert.ok(!out.includes("last edit:"));
});

test("buildSidebarContent: relative time format for hours", () => {
  // Use a large "now" so 3h ago is positive.
  const now = 100_000_000_000; // year ~1973 in ms, large enough
  const s = {
    ...VALID_STATE(),
    metadata: { setBy: "user", conditionEditedAt: now - 3 * 3_600_000 },
  };
  const out = buildSidebarContent(s, null, null, now);
  assert.ok(out.includes("3h ago"));
});

test("buildSidebarContent: relative time format for days", () => {
  const now = 100_000_000_000;
  const s = {
    ...VALID_STATE(),
    metadata: { setBy: "user", conditionEditedAt: now - 2 * 86_400_000 },
  };
  const out = buildSidebarContent(s, null, null, now);
  assert.ok(out.includes("2d ago"));
});

test("buildSidebarContent: relative time 'just now' for sub-minute", () => {
  const now = 100_000_000_000;
  const s = {
    ...VALID_STATE(),
    metadata: { setBy: "user", conditionEditedAt: now - 1000 },
  };
  const out = buildSidebarContent(s, null, null, now);
  assert.ok(out.includes("just now"));
});

// ── buildSidebarFooter ─────────────────────────────────────────────────────

test("buildSidebarFooter: returns dial command hint string", () => {
  const out = buildSidebarFooter("/tmp");
  assert.ok(out.includes("alt+g dashboard"));
  assert.ok(out.includes("alt+s steer"));
  assert.ok(out.includes("alt+p pause"));
  assert.ok(out.includes("/goal-steer"));
  assert.ok(out.length <= 80);
});

test("buildSidebarFooter: contains no newlines (single-line slot)", () => {
  assert.equal(buildSidebarFooter("/tmp").includes("\n"), false);
});

test("buildSidebarFooter: appends '/goal-claim' when handoff is present", () => {
  const out = buildSidebarFooter("/tmp", { createdAt: "2026-06-10T00:00:00Z" });
  assert.ok(out.includes("/goal-claim"));
});

test("buildSidebarFooter: starts with hotkeys, not a fake q prefix", () => {
  // The sidebar is a launcher/status rail. It should lead with actual key
  // chords the user can press, then include slash commands as fallbacks.
  const out = buildSidebarFooter("/tmp");
  assert.ok(out.startsWith("keys:"),
    `footer should start with real key hints; got: ${out}`);
  assert.equal(out.startsWith("q:"), false);
});

// ── buildSidebarView (top-level) ───────────────────────────────────────────

test("buildSidebarView: no state file → empty-state view", () => {
  const dir = freshDir();
  try {
    const view = buildSidebarView(dir);
    assert.equal(view.hasGoal, false);
    assert.equal(view.isPaused, false);
    assert.equal(view.title, "🎯 no goal");
    assert.ok(view.content.includes("(no active goal)"));
    assert.ok(view.footer.includes("/goal"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("buildSidebarView: active goal → live view, hasGoal=true, isPaused=false", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "ship the feature");
    const view = buildSidebarView(dir);
    assert.equal(view.hasGoal, true);
    assert.equal(view.isPaused, false);
    assert.ok(view.title.includes("🎯"));
    assert.ok(view.title.includes("ship the feature"));
    assert.ok(view.content.includes("turns:"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("buildSidebarView: paused goal → live view, isPaused=true, pause icon", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "ship the feature");
    // Toggle to paused
    plantCorruptState(dir, {
      ...VALID_STATE(),
      status: "paused",
      pausedAt: Date.now(),
      condition: "ship the feature",
    });
    const view = buildSidebarView(dir);
    assert.equal(view.hasGoal, true);
    assert.equal(view.isPaused, true);
    assert.ok(view.title.startsWith("⏸"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("buildSidebarView: achieved (terminal) goal → empty-state view", () => {
  const dir = freshDir();
  try {
    plantCorruptState(dir, { ...VALID_STATE(), status: "achieved" });
    const view = buildSidebarView(dir);
    assert.equal(view.hasGoal, false);
    assert.equal(view.isPaused, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("buildSidebarView: cleared (terminal) goal → empty-state view", () => {
  const dir = freshDir();
  try {
    plantCorruptState(dir, { ...VALID_STATE(), status: "cleared" });
    const view = buildSidebarView(dir);
    assert.equal(view.hasGoal, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("buildSidebarView: corrupt state with constraints:{} → empty-state view (no crash)", () => {
  // The cycle-0 silent-infinite-loop case. The validator upstream catches
  // this and returns null; the sidebar should not crash.
  const dir = freshDir();
  try {
    plantCorruptState(dir, {
      version: 1, id: "x", condition: "x", status: "active",
      createdAt: 1, startedAt: 1, completedAt: null, pausedAt: null, resumedAt: null,
      turnsEvaluated: 0, tokensUsed: 0, lastEvaluation: null, evaluationHistory: [],
      constraints: {}, metadata: { setBy: "user" },
    });
    const view = buildSidebarView(dir);
    assert.equal(view.hasGoal, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("buildSidebarView: corrupt state with negative turnsEvaluated → empty-state view (no crash)", () => {
  const dir = freshDir();
  try {
    plantCorruptState(dir, { ...VALID_STATE(), turnsEvaluated: -1 });
    const view = buildSidebarView(dir);
    assert.equal(view.hasGoal, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("buildSidebarView: long condition → title truncated, content still 3 lines", () => {
  const dir = freshDir();
  try {
    setGoal(dir, "x".repeat(500));
    const view = buildSidebarView(dir);
    assert.equal(view.hasGoal, true);
    assert.ok(view.title.length <= 63); // "🎯 " + 60-char body
    // Content should be 3 lines (bar, counters, last)
    assert.equal(view.content.split("\n").length, 3);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("buildSidebarView: now parameter is forwarded to computeProgress", () => {
  // For deterministic time-based assertions. startedAt=1, now=1 → 0 elapsed.
  const dir = freshDir();
  try {
    setGoal(dir, "do the thing");
    const view = buildSidebarView(dir, 1);
    assert.ok(view.content.includes("time:"));
    assert.ok(view.content.includes("0/30m"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
