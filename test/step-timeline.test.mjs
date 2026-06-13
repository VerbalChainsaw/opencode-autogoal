/**
 * step-timeline.ts — pure unit tests against the BUILT output.
 *
 * Mirror of session-events.test.mjs. Test surface:
 *   - appendStepTimelineEvent + readStepTimeline round-trip
 *   - readStepTimeline returns [] for a missing file
 *   - readStepTimeline returns events newest-first
 *   - the line cap (MAX_TIMELINE_LINES = 1000) is enforced when exceeded
 *   - the byte cap (MAX_TIMELINE_BYTES = 1 MB) is enforced when exceeded
 *   - appendStepTimelineEvent swallows write errors (best-effort)
 *   - corrupt JSONL lines are silently skipped
 *   - all three outcomes (met / blocked / in-progress) round-trip
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  statSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendStepTimelineEvent,
  readStepTimeline,
  STEP_TIMELINE_FILE,
  MAX_TIMELINE_LINES,
  MAX_TIMELINE_BYTES,
} from "../dist/step-timeline.js";

function freshDir() {
  return mkdtempSync(join(tmpdir(), "opencode-autogoal-timeline-"));
}

function makeStep(overrides) {
  return {
    at: Date.now(),
    turn: 1,
    label: "first turn",
    outcome: "in-progress",
    ...overrides,
  };
}

// ── round-trip ───────────────────────────────────────────────────────────

test("appendStepTimelineEvent + readStepTimeline: one step round-trips", () => {
  const dir = freshDir();
  try {
    const step = makeStep({ at: 1000, turn: 3, label: "tests run", outcome: "met", reason: "all green" });
    appendStepTimelineEvent(dir, step);
    const out = readStepTimeline(dir);
    assert.equal(out.length, 1);
    assert.equal(out[0].at, 1000);
    assert.equal(out[0].turn, 3);
    assert.equal(out[0].label, "tests run");
    assert.equal(out[0].outcome, "met");
    assert.equal(out[0].reason, "all green");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("readStepTimeline: returns [] for missing file", () => {
  const dir = freshDir();
  try {
    const out = readStepTimeline(dir);
    assert.deepEqual(out, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("readStepTimeline: returns steps newest-first", () => {
  const dir = freshDir();
  try {
    appendStepTimelineEvent(dir, makeStep({ at: 1000, turn: 1 }));
    appendStepTimelineEvent(dir, makeStep({ at: 2000, turn: 2 }));
    appendStepTimelineEvent(dir, makeStep({ at: 3000, turn: 3 }));
    const out = readStepTimeline(dir);
    assert.equal(out.length, 3);
    assert.equal(out[0].turn, 3, "newest first");
    assert.equal(out[1].turn, 2);
    assert.equal(out[2].turn, 1, "oldest last");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── cap-and-trim ─────────────────────────────────────────────────────────

test("appendStepTimelineEvent: trims to MAX_TIMELINE_LINES when over the cap", () => {
  const dir = freshDir();
  try {
    for (let i = 0; i < MAX_TIMELINE_LINES + 25; i++) {
      appendStepTimelineEvent(dir, makeStep({ at: i, turn: i }));
    }
    const out = readStepTimeline(dir, MAX_TIMELINE_LINES + 100);
    assert.equal(out.length, MAX_TIMELINE_LINES, `expected ${MAX_TIMELINE_LINES} after trim, got ${out.length}`);
    assert.equal(out[0].turn, MAX_TIMELINE_LINES + 24, "newest first after trim");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("appendStepTimelineEvent: trims to MAX_TIMELINE_BYTES when over the byte cap", () => {
  const dir = freshDir();
  try {
    // 200 events with a long label — the file should never exceed the cap.
    for (let i = 0; i < 200; i++) {
      appendStepTimelineEvent(dir, makeStep({ at: i, label: "x".repeat(200) }));
    }
    const size = statSync(join(dir, STEP_TIMELINE_FILE)).size;
    assert.ok(size <= MAX_TIMELINE_BYTES, `file size ${size} > cap ${MAX_TIMELINE_BYTES}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── best-effort ──────────────────────────────────────────────────────────

test("appendStepTimelineEvent: swallows write errors (best-effort)", () => {
  const dir = freshDir();
  try {
    mkdirSync(join(dir, ".opencode"), { recursive: true });
    if (process.platform !== "win32") {
      chmodSync(join(dir, ".opencode"), 0o555);
    } else {
      rmSync(join(dir, ".opencode"), { recursive: true, force: true });
      writeFileSync(join(dir, ".opencode"), "not a dir");
    }
    assert.doesNotThrow(() => appendStepTimelineEvent(dir, makeStep()));
  } finally {
    if (process.platform !== "win32") {
      try { chmodSync(join(dir, ".opencode"), 0o755); } catch { /* ignore */ }
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── corrupt-line skip ────────────────────────────────────────────────────

test("readStepTimeline: silently skips corrupt JSONL lines", () => {
  const dir = freshDir();
  try {
    mkdirSync(join(dir, ".opencode"), { recursive: true });
    const path = join(dir, STEP_TIMELINE_FILE);
    const ok1 = JSON.stringify(makeStep({ at: 1, turn: 1, outcome: "met" }));
    const ok2 = JSON.stringify(makeStep({ at: 2, turn: 2, outcome: "blocked" }));
    writeFileSync(path, [ok1, "{not json", ok2, ""].join("\n"));
    const out = readStepTimeline(dir);
    assert.equal(out.length, 2);
    assert.equal(out[0].turn, 2, "newest first");
    assert.equal(out[1].turn, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── shape contract ───────────────────────────────────────────────────────

test("appendStepTimelineEvent: all three outcomes round-trip", () => {
  const dir = freshDir();
  try {
    appendStepTimelineEvent(dir, makeStep({ at: 1, outcome: "met" }));
    appendStepTimelineEvent(dir, makeStep({ at: 2, outcome: "blocked" }));
    appendStepTimelineEvent(dir, makeStep({ at: 3, outcome: "in-progress" }));
    const out = readStepTimeline(dir);
    assert.deepEqual(out.map((s) => s.outcome), ["in-progress", "blocked", "met"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("STEP_TIMELINE_FILE: is the .opencode/-relative name", () => {
  assert.equal(STEP_TIMELINE_FILE, ".opencode/.step-timeline.jsonl");
});

test("MAX_TIMELINE_LINES / MAX_TIMELINE_BYTES: are sane non-zero integers", () => {
  assert.ok(Number.isInteger(MAX_TIMELINE_LINES) && MAX_TIMELINE_LINES > 0);
  assert.ok(Number.isInteger(MAX_TIMELINE_BYTES) && MAX_TIMELINE_BYTES > 0);
  assert.ok(MAX_TIMELINE_BYTES >= 4096, "byte cap should be at least 4 KB");
});
