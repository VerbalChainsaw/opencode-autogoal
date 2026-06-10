/**
 * Tests for the /goal command dispatcher (the previously-untested server logic,
 * extracted to be testable). Runs against the built `dist/command.js`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dispatchGoalCommand } from "../dist/command.js";

function freshDir() {
  return mkdtempSync(join(tmpdir(), "opengoal-cmd-"));
}

test("bare /goal (empty args) shows status, NOT an empty-set error", () => {
  const dir = freshDir();
  try {
    const out = dispatchGoalCommand(dir, "");
    assert.match(out, /No active goal/);
    assert.doesNotMatch(out, /cannot be empty/); // the regression guard
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bare /goal after a goal is set shows the active goal", () => {
  const dir = freshDir();
  try {
    dispatchGoalCommand(dir, 'set "refactor the parser" --command "npm test"');
    const out = dispatchGoalCommand(dir, "   "); // whitespace-only = bare
    assert.match(out, /Condition: refactor the parser/);
    assert.match(out, /Verification: `npm test`/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("/goal set returns working instructions incl. the completion protocol", () => {
  const dir = freshDir();
  try {
    const out = dispatchGoalCommand(dir, 'set "make the build green"');
    assert.match(out, /GOAL: make the build green/);
    assert.match(out, /GOAL_COMPLETE:/);
    assert.match(out, /GOAL_BLOCKED:/);
    assert.match(out, /Begin now\./);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("implicit set (unknown first word) treats whole input as the condition", () => {
  const dir = freshDir();
  try {
    const out = dispatchGoalCommand(dir, "frobnicate the widget thoroughly");
    assert.match(out, /GOAL: frobnicate the widget thoroughly/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("/goal set with no condition reports the empty error (relayed to user)", () => {
  const dir = freshDir();
  try {
    const out = dispatchGoalCommand(dir, "set    ");
    assert.match(out, /Goal not set/);
    assert.match(out, /cannot be empty/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("clear / pause / resume report their outcomes", () => {
  const dir = freshDir();
  try {
    dispatchGoalCommand(dir, 'set "do it"');
    assert.match(dispatchGoalCommand(dir, "pause"), /Goal paused/);
    assert.match(dispatchGoalCommand(dir, "resume"), /continue working toward it/);
    assert.match(dispatchGoalCommand(dir, "clear"), /Goal cleared/);
    assert.match(dispatchGoalCommand(dir, "clear"), /No active goal to clear/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("clear aliases (stop/off/reset/none/cancel) all clear", () => {
  for (const alias of ["stop", "off", "reset", "none", "cancel"]) {
    const dir = freshDir();
    try {
      dispatchGoalCommand(dir, 'set "x"');
      assert.match(dispatchGoalCommand(dir, alias), /Goal cleared/, `alias ${alias}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("/goal template <builtin> seeds condition + command", () => {
  const dir = freshDir();
  try {
    const out = dispatchGoalCommand(dir, "template fix-lint");
    assert.match(out, /from template "Fix all lint errors/);
    assert.match(out, /npm run lint/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SECURITY: /goal template rejects path-traversal names", () => {
  const dir = freshDir();
  try {
    for (const evil of ["../../../../etc/passwd", "..\\..\\secrets", "foo/bar", "a.b"]) {
      const out = dispatchGoalCommand(dir, `template ${evil}`);
      assert.match(out, /Invalid template name/, `should reject ${evil}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("/goal template <missing> lists built-ins", () => {
  const dir = freshDir();
  try {
    const out = dispatchGoalCommand(dir, "template does-not-exist");
    assert.match(out, /not found/);
    assert.match(out, /fix-lint/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("/goal history with none yet", () => {
  const dir = freshDir();
  try {
    dispatchGoalCommand(dir, 'set "x"');
    assert.match(dispatchGoalCommand(dir, "history"), /No evaluation history/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
