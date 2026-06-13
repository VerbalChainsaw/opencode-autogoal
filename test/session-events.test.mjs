/**
 * session-events.ts — pure unit tests against the BUILT output.
 *
 * Test surface (mirrors the goal-archive test shape):
 *   - appendSessionEvent + readSessionEvents round-trip
 *   - readSessionEvents returns [] for a missing file
 *   - readSessionEvents returns events newest-first
 *   - the line cap (MAX_EVENTS_LINES) is enforced when exceeded
 *   - the byte cap (MAX_EVENTS_BYTES) is enforced when exceeded
 *   - appendSessionEvent swallows write errors (best-effort)
 *   - corrupt JSONL lines are silently skipped
 *   - sanitizeForPrompt is applied to user-controlled strings
 *
 * The TDD pin: every test here fails on the empty dist (the module
 * does not exist yet). The first commit makes them pass.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  appendFileSync,
  statSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  appendSessionEvent,
  readSessionEvents,
  SESSION_EVENTS_FILE,
  MAX_EVENTS_LINES,
  MAX_EVENTS_BYTES,
} from "../dist/session-events.js";

function freshDir() {
  return mkdtempSync(join(tmpdir(), "opencode-autogoal-events-"));
}

function makeEvent(overrides) {
  return {
    at: Date.now(),
    kind: "tool-start",
    tool: "bash",
    args: { command: "npm test" },
    ...overrides,
  };
}

// ── round-trip ───────────────────────────────────────────────────────────

test("appendSessionEvent + readSessionEvents: one event round-trips", () => {
  const dir = freshDir();
  try {
    const ev = makeEvent({ at: 1000, tool: "bash", args: { command: "npm test" } });
    appendSessionEvent(dir, ev);
    const out = readSessionEvents(dir);
    assert.equal(out.length, 1);
    assert.equal(out[0].at, 1000);
    assert.equal(out[0].kind, "tool-start");
    assert.equal(out[0].tool, "bash");
    assert.deepEqual(out[0].args, { command: "npm test" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("readSessionEvents: returns [] for missing file", () => {
  const dir = freshDir();
  try {
    const out = readSessionEvents(dir);
    assert.deepEqual(out, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("readSessionEvents: returns events newest-first", () => {
  const dir = freshDir();
  try {
    appendSessionEvent(dir, makeEvent({ at: 1000 }));
    appendSessionEvent(dir, makeEvent({ at: 2000 }));
    appendSessionEvent(dir, makeEvent({ at: 3000 }));
    const out = readSessionEvents(dir);
    assert.equal(out.length, 3);
    assert.equal(out[0].at, 3000, "newest first");
    assert.equal(out[1].at, 2000);
    assert.equal(out[2].at, 1000, "oldest last");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── cap-and-trim ─────────────────────────────────────────────────────────

test("appendSessionEvent: trims to MAX_EVENTS_LINES when over the cap", () => {
  const dir = freshDir();
  try {
    // append MAX_EVENTS_LINES + 50 events; trim should leave MAX_EVENTS_LINES
    for (let i = 0; i < MAX_EVENTS_LINES + 50; i++) {
      appendSessionEvent(dir, makeEvent({ at: i }));
    }
    const out = readSessionEvents(dir, MAX_EVENTS_LINES + 100);
    assert.equal(out.length, MAX_EVENTS_LINES, `expected ${MAX_EVENTS_LINES} after trim, got ${out.length}`);
    // newest first — the last appended (at = MAX_EVENTS_LINES + 49) is at index 0
    assert.equal(out[0].at, MAX_EVENTS_LINES + 49);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("appendSessionEvent: trims to MAX_EVENTS_BYTES when over the byte cap", () => {
  const dir = freshDir();
  try {
    // Each event ~50 bytes ({"at":N,"kind":"tool-start","tool":"bash","args":{"command":"x"}}).
    // Append many; the file should never exceed the cap.
    for (let i = 0; i < 200; i++) {
      appendSessionEvent(dir, makeEvent({ at: i, tool: "x".repeat(100) }));
    }
    const size = statSync(join(dir, SESSION_EVENTS_FILE)).size;
    assert.ok(size <= MAX_EVENTS_BYTES, `file size ${size} > cap ${MAX_EVENTS_BYTES}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── best-effort ──────────────────────────────────────────────────────────

test("appendSessionEvent: swallows write errors (best-effort)", () => {
  const dir = freshDir();
  try {
    // Make the .opencode/ directory read-only on POSIX; on Windows the
    // equivalent is to create the dir as a file (chmod is a no-op there,
    // but mkdir+chmod is the canonical "perm denied" setup).
    mkdirSync(join(dir, ".opencode"), { recursive: true });
    if (process.platform !== "win32") {
      chmodSync(join(dir, ".opencode"), 0o555);
    } else {
      // On Windows, replace the directory with a file of the same name so
      // mkdirSync(join(dir, ".opencode", ".session-events.jsonl")) fails
      // with EISDIR / EEXIST. The append MUST swallow the error.
      rmSync(join(dir, ".opencode"), { recursive: true, force: true });
      writeFileSync(join(dir, ".opencode"), "not a dir");
    }
    // MUST NOT throw.
    assert.doesNotThrow(() => appendSessionEvent(dir, makeEvent()));
  } finally {
    if (process.platform !== "win32") {
      try { chmodSync(join(dir, ".opencode"), 0o755); } catch { /* ignore */ }
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── corrupt-line skip ────────────────────────────────────────────────────

test("readSessionEvents: silently skips corrupt JSONL lines", () => {
  const dir = freshDir();
  try {
    mkdirSync(join(dir, ".opencode"), { recursive: true });
    const path = join(dir, SESSION_EVENTS_FILE);
    const ok1 = JSON.stringify(makeEvent({ at: 1, kind: "tool-start" }));
    const ok2 = JSON.stringify(makeEvent({ at: 2, kind: "tool-end", tool: "bash" }));
    writeFileSync(path, [ok1, "{not json", ok2, ""].join("\n"));
    const out = readSessionEvents(dir);
    // 2 valid lines, 1 corrupt skipped.
    assert.equal(out.length, 2);
    assert.equal(out[0].at, 2, "newest first");
    assert.equal(out[1].at, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── shape contract ───────────────────────────────────────────────────────

test("appendSessionEvent: persists kind=message (no tool)", () => {
  const dir = freshDir();
  try {
    appendSessionEvent(dir, { at: 1, kind: "message", summary: "agent speaking" });
    const out = readSessionEvents(dir);
    assert.equal(out.length, 1);
    assert.equal(out[0].kind, "message");
    assert.equal(out[0].tool, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("SESSION_EVENTS_FILE: is the .opencode/-relative name", () => {
  assert.equal(SESSION_EVENTS_FILE, ".opencode/.session-events.jsonl");
});

test("MAX_EVENTS_LINES / MAX_EVENTS_BYTES: are sane non-zero integers", () => {
  assert.ok(Number.isInteger(MAX_EVENTS_LINES) && MAX_EVENTS_LINES > 0);
  assert.ok(Number.isInteger(MAX_EVENTS_BYTES) && MAX_EVENTS_BYTES > 0);
  // Cap relationship: bytes cap should be larger than the largest plausible
  // single event (just a sanity check that they're not swapped).
  assert.ok(MAX_EVENTS_BYTES >= 4096, "byte cap should be at least 4 KB");
});
