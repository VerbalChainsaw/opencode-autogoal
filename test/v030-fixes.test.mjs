/**
 * Regression tests for v0.3.0 hardening pass.
 *
 * Each test pins a specific fix so it can't regress. Runs against the
 * built dist/ (the same harness as the rest of test/*.mjs).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { setGoal } from "../dist/goal-state.js";

const here = dirname(fileURLToPath(import.meta.url));
const distDir = join(here, "..", "dist");

function readDist(name) {
  return readFileSync(join(distDir, name), "utf-8");
}

// ── F13: recordEvaluation cap (writer/validator symmetry) ────────────────
// The writer (recordEvaluation) caps evaluationHistory with
// `if (length > 10) shift()`, producing a length-10 state. The
// validator reads it back with `if (length > 10) return false`.
// The contract: any state the writer writes must be readable by the
// validator. The shape-of-fix test pins the writer's cap to be
// `length > 10` (the cap is 10, not 11, and not 9).

test("F13: writer cap is at length > 10 (not > 9, not > 11)", () => {
  // Read both the source and the built dist; the cap check must
  // appear in both with the exact operator.
  const src = readFileSync(join(here, "..", "src", "goal-state.ts"), "utf-8");
  const dist = readDist("goal-state.js");
  // The writer uses the exact check `state.evaluationHistory.length > 10`.
  // The validator uses the same check.
  // Pin both: any change to `<` vs `>` or `9` vs `10` vs `11` is a regression.
  const writerRe = /evaluationHistory\.length\s*>\s*10/;
  const validatorRe = /evaluationHistory\.length\s*>\s*10/;
  assert.ok(writerRe.test(src), "writer cap check `length > 10` not found in src/goal-state.ts");
  assert.ok(validatorRe.test(dist), "validator cap check `length > 10` not found in dist/goal-state.js");
});

test("F13: writer can never produce a length-11 state file", () => {
  // The exact contract: any state the writer writes is `length <= 10`.
  // The cap is `> 10` (rejects at 11) and the writer pushes then
  // shifts, so the post-write length is 10. Validator accepts `<= 10`.
  // The two checks must match across the two files they live in.
  // (Before v0.3.0, the constraint-clear path in server.ts:184
  // did a direct push without a shift, allowing a length-11 state
  // file that the validator would reject as corrupt on the next
  // read, silently killing the auto-loop.)
  const serverDist = readDist("server.js");
  const stateDist = readDist("goal-state.js");
  // The writer uses `recordEvaluation` (server.ts), which caps with
  // `length > 10`. All evaluation push sites in server.ts must go
  // through recordEvaluation — no direct `evaluationHistory.push` calls.
  const writerRe = /evaluationHistory\.length\s*>\s*10/;
  assert.ok(writerRe.test(serverDist),
    "writer cap check `length > 10` not found in dist/server.js (recordEvaluation)");
  assert.ok(writerRe.test(stateDist),
    "validator cap check `length > 10` not found in dist/goal-state.js");
  // No direct push in dist/server.js outside of recordEvaluation.
  // (recordEvaluation's own push is the only legitimate one.)
  // Strip the recordEvaluation function body before checking.
  const recordEvalBody = (serverDist.match(/function\s+recordEvaluation[\s\S]*?\n\s*}/) || [""])[0];
  const serverDistOutsideRecordEval = serverDist.replace(recordEvalBody, "");
  const directPush = /evaluationHistory\.push\s*\(/;
  assert.ok(!directPush.test(serverDistOutsideRecordEval),
    "direct `evaluationHistory.push(...)` found in dist/server.js outside recordEvaluation — every push must go through recordEvaluation so the cap is enforced");
});

// ── F15: continue-prompt condition length cap ────────────────────────────
// The continue-prompt in server.ts must cap the condition to the same
// 500 chars the compaction context uses, otherwise a 4000-char
// condition burns ~1000 tokens of context per nudge.

test("F15: continue-prompt in dist caps condition at 500 chars (matches compaction cap)", () => {
  const dist = readDist("server.js");
  // The continue-prompt must NOT inject a >500-char condition. The
  // slice may be inlined in the template literal OR pulled out into
  // a local variable (current implementation); both are valid.
  // Pin the cap presence somewhere on the dist's continue-prompt
  // build path for `snapshot.condition`. We accept either:
  //   - `${sanitizeForPrompt(snapshot.condition)}.slice(0, 500)`  (inlined)
  //   - `sanitizeForPrompt(snapshot.condition).slice(0, 500)`  (assigned)
  // Both must appear in the file.
  const inlined = /Keep working toward:\s*\$\{sanitizeForPrompt\(snapshot\.condition\)\}\.slice\(0,\s*500\)/;
  const assigned = /sanitizeForPrompt\(snapshot\.condition\)\.slice\(0,\s*500\)/;
  assert.ok(inlined.test(dist) || assigned.test(dist),
    "continue-prompt condition cap is not `.slice(0, 500)` (inlined or assigned) — a 4000-char condition would be injected verbatim");
});

test("F15: compaction context also caps condition at 500 chars (consistency check)", () => {
  const dist = readDist("server.js");
  const re = /sanitizeForPrompt\(state\.condition\)\.slice\(0,\s*500\)/;
  assert.ok(re.test(dist),
    "compaction context condition cap is not `.slice(0, 500)`");
});

// ── F18: readGoalStateSafe sanitizes user-controlled strings ────────────
// The GUI helper readGoalStateSafe must apply sanitizeForPrompt to
// condition, command, and lastEvaluation.reason before returning the
// state. Defense in depth: GUI consumers that bypass presentGoalState
// should still get sanitized strings.

test("F18: readGoalStateSafe in dist sanitizes condition / command / reason", () => {
  const dist = readDist("gui.js");
  // The function body (or its delegated helper, if the implementation
  // factored sanitization into a separate function) must call
  // sanitizeForPrompt on user-controlled string fields. The dist
  // may inline the calls or delegate to a helper — both are valid.
  // The contract is: readGoalStateSafe's returned `state` is
  // sanitized. The test pins the function calls `sanitizeForPrompt`
  // (whether inline or via a helper that is invoked by readGoalStateSafe).
  // Locate the function body (which may now be larger because the
  // sanitization helper is defined alongside it). Use a
  // line-based window: from `function readGoalStateSafe` to the
  // next `function ` declaration or end-of-file.
  const startMatch = dist.match(/function\s+readGoalStateSafe\b/);
  assert.ok(startMatch, "readGoalStateSafe function not found in dist/gui.js");
  const after = dist.slice(startMatch.index);
  // Find the next top-level `function` declaration (the helper or
  // a subsequent function). The helper, if present, counts.
  const endMatch = after.slice(50).match(/\nfunction\s+[a-z]/);
  const body = endMatch ? after.slice(0, 50 + endMatch.index) : after.slice(0, 2000);
  // The body must call sanitizeForPrompt at least once (inlined),
  // OR delegate to a helper whose name includes "sanitize" (factored).
  // The dist may inline the calls or delegate — both are valid.
  assert.ok(/sanitizeForPrompt\s*\(/.test(body) || /sanitizeGoalStateForGui\s*\(/.test(body),
    "readGoalStateSafe (or its delegated helper) does not call sanitizeForPrompt — defense-in-depth gap on the GUI read path");
  // Additionally, the returned state's condition must be sanitized —
  // find the literal pattern that ships the sanitized condition.
  assert.ok(/condition:\s*sanitizeForPrompt\(state\.condition\)/.test(dist) ||
            /condition:\s*sanitizeForPrompt\(raw\.condition\)/.test(dist),
    "no sanitization of the returned state's `condition` field — GUI consumers will see unsanitized state.condition");
});

test("F18: presentGoalState still sanitizes via sanitizeSummary (regression net)", () => {
  // The pre-existing GUI egress sanitizer must still be in place.
  const dist = readDist("gui.js");
  assert.ok(/sanitizeForPrompt\s*\(s\)/.test(dist),
    "sanitizeSummary helper is missing or no longer delegates to sanitizeForPrompt");
});

// ── F21: tsc -p tsconfig.json catches JSX syntax errors that ────────────
//          tsc -p tsconfig.build.json does NOT (build exclude JSX).
// The fix is in the test script (tsc -p tsconfig.json runs first).
// This test pins the test script contains the typecheck step.

test("F21: package.json test script runs tsc -p tsconfig.json BEFORE tsc -p tsconfig.build.json", () => {
  const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf-8"));
  const script = pkg.scripts?.test ?? "";
  // The test script must typecheck (tsc -p tsconfig.json) so a JSX
  // syntax error in tui.tsx / sidebar.tsx / sidebar-logic.tsx would
  // fail the test run. Accept either:
  //   - `tsc -p tsconfig.json` directly in the test script
  //   - `npm run typecheck` (which itself runs the typecheck)
  // because the second is the project's actual convention.
  const directRe = /tsc\s+-p\s+tsconfig\.json/;
  const indirectRe = /npm\s+run\s+typecheck/;
  assert.ok(directRe.test(script) || indirectRe.test(script),
    "package.json scripts.test is missing 'tsc -p tsconfig.json' (or 'npm run typecheck') — JSX errors in tui.tsx would not be caught");
  // The typecheck must run BEFORE the build (or, equivalently, before node --test).
  const typecheckIdx = script.search(directRe.source + "|" + indirectRe.source);
  const buildIdx = script.search(/tsc\s+-p\s+tsconfig\.build\.json|npm\s+run\s+build/);
  const testIdx = script.search(/node\s+--test/);
  if (buildIdx >= 0) {
    assert.ok(typecheckIdx < buildIdx, `typecheck must run before build; typecheckIdx=${typecheckIdx} buildIdx=${buildIdx}`);
  }
  if (testIdx >= 0) {
    assert.ok(typecheckIdx < testIdx, `typecheck must run before node --test; typecheckIdx=${typecheckIdx} testIdx=${testIdx}`);
  }
});
