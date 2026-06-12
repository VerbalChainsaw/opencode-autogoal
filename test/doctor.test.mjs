/**
 * F-2 (v0.5.0) — `doctor` health check.
 *
 * Spec: specs/v0.5.0-feature-work-orders.md §F-2.
 *   - clean dir → healthy, exit 0
 *   - corrupt state planted → fail + artifact named + file actually
 *     quarantined
 *   - quarantined artifacts present → warn (newest 3, count, suggest
 *     deletion)
 *   - `--json doctor` parses and `healthy === false` ⇒ exit 1
 *
 * runDoctor() is a pure function (all I/O is `readX` reads + one
 * statSync on node version + readFileSync of own package.json), so
 * unit tests can call it directly with a fresh mkdtempSync dir. The
 * e2e test spawns the real CLI binary to confirm the parser-wiring
 * (`--json` + command) and the exit-code path.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { runDoctor } from "../dist/cli.js";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "dist", "cli.js");
const NODE = process.execPath;

function freshDir() {
  return mkdtempSync(join(tmpdir(), "opengoal-doctor-"));
}

function plantCorruptState(dir) {
  mkdirSync(join(dir, ".opencode"), { recursive: true });
  writeFileSync(join(dir, ".opencode", ".goal-state.json"), "{ not valid json", "utf-8");
}

function plantQuarantineArtifact(dir, suffix) {
  mkdirSync(join(dir, ".opencode"), { recursive: true });
  writeFileSync(join(dir, ".opencode", `.goal-state.json.corrupt.${suffix}`), "garbage", "utf-8");
}

// ── runDoctor unit tests ─────────────────────────────────────────────

test("doctor: clean dir → healthy and exit 0", () => {
  const dir = freshDir();
  try {
    const result = runDoctor(dir);
    assert.equal(result.healthy, true);
    assert.deepEqual(
      result.checks.map((c) => c.name),
      [
        "goal state",
        "chain file",
        "handoff file",
        "quarantined artifacts",
        "node version",
        "package version",
      ],
    );
    for (const c of result.checks) {
      assert.notEqual(c.status, "fail", `${c.name} should not be fail in clean dir, got: ${c.status} (${c.detail})`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("doctor: absent goal state (no .opencode dir) → ok/absent, healthy", () => {
  const dir = freshDir();
  try {
    const result = runDoctor(dir);
    const goalState = result.checks.find((c) => c.name === "goal state");
    assert.equal(goalState?.status, "ok");
    assert.match(goalState?.detail ?? "", /absent/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("doctor: corrupt state file → fail, healthy=false, file actually quarantined", () => {
  const dir = freshDir();
  try {
    plantCorruptState(dir);
    const result = runDoctor(dir);
    const goalState = result.checks.find((c) => c.name === "goal state");
    assert.equal(goalState?.status, "fail");
    assert.match(goalState?.detail ?? "", /corrupt/);
    assert.match(goalState?.detail ?? "", /\.corrupt\./, "detail should name the quarantine artifact");
    assert.equal(result.healthy, false);

    // The act of readGoalStateResult quarantines the file - verify the
    // quarantine artifact exists. (The original state file may or may
    // not still be present; the contract is that a .corrupt.<ts> copy
    // is created, not that the original is moved.)
    const opencodeDir = join(dir, ".opencode");
    const entries = readdirSync(opencodeDir);
    const quarantined = entries.filter((e) => e.startsWith(".goal-state.json.corrupt."));
    assert.ok(
      quarantined.length >= 1,
      `expected at least one quarantine artifact, got: ${entries.join(", ")}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("doctor: quarantined artifacts present → warn, detail lists newest 3 and count", () => {
  const dir = freshDir();
  try {
    plantQuarantineArtifact(dir, "100");
    plantQuarantineArtifact(dir, "200");
    plantQuarantineArtifact(dir, "300");
    plantQuarantineArtifact(dir, "400");
    const result = runDoctor(dir);
    const qa = result.checks.find((c) => c.name === "quarantined artifacts");
    assert.equal(qa?.status, "warn");
    assert.match(qa?.detail ?? "", /^4 found /, `detail should start with count, got: ${qa?.detail}`);
    assert.match(qa?.detail ?? "", /newest:/, "detail should list newest 3");
    assert.match(qa?.detail ?? "", /\+1 more/, "detail should indicate overflow when >3");
    // Quarantined artifacts are WARN, not FAIL — doctor stays healthy.
    assert.equal(result.healthy, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("doctor: package version check always reads its own package.json", () => {
  const dir = freshDir();
  try {
    const result = runDoctor(dir);
    const pkg = result.checks.find((c) => c.name === "package version");
    assert.equal(pkg?.status, "ok");
    assert.match(pkg?.detail ?? "", /opencode-autogoal v\d/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── e2e: spawn the real binary, verify the CLI surface ───────────────

function runCli(cwd, args) {
  return spawnSync(NODE, [CLI, ...args], { cwd, encoding: "utf-8", timeout: 10_000 });
}

test("CLI: doctor in clean dir → exit 0, prose output, all checks ok", () => {
  const dir = freshDir();
  try {
    const r = runCli(dir, ["doctor"]);
    assert.equal(r.status, 0, `doctor should exit 0 in clean dir, got ${r.status}\nstderr: ${r.stderr}`);
    assert.match(r.stdout, /goal state:/);
    assert.match(r.stdout, /node version:/);
    assert.match(r.stdout, /package version:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: --json doctor in clean dir → one-line JSON, healthy=true, exit 0", () => {
  const dir = freshDir();
  try {
    const r = runCli(dir, ["--json", "doctor"]);
    assert.equal(r.status, 0);
    const lines = r.stdout.trim().split("\n");
    assert.equal(lines.length, 1, `expected one line of JSON, got: ${r.stdout}`);
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.healthy, true);
    assert.ok(Array.isArray(parsed.checks));
    assert.ok(parsed.checks.length >= 6);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: --json doctor with corrupt state → healthy=false, exit 1", () => {
  const dir = freshDir();
  try {
    plantCorruptState(dir);
    const r = runCli(dir, ["--json", "doctor"]);
    assert.equal(r.status, 1, `doctor should exit 1 when unhealthy, got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout.trim());
    assert.equal(parsed.healthy, false);
    const goalState = parsed.checks.find((c) => c.name === "goal state");
    assert.equal(goalState.status, "fail");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: doctor is not in the dispatcher's command set (regression)", () => {
  // The dispatcher should reject `doctor` if it ever gets there - the
  // CLI handles it BEFORE the dispatcher. We exercise this by sending
  // a known-bad dispatcher form (doctor with extra args that would
  // confuse the dispatcher) and verifying the CLI's doctor still
  // succeeds. If the wiring regresses and `doctor` falls through to
  // the dispatcher, we'd get exit 1 with a "unknown command" error.
  const dir = freshDir();
  try {
    const r = runCli(dir, ["doctor", "--json"]);
    // `--json doctor` is a flag ordering test - the CLI parses it as
    // json=true + action="doctor" + payload=["--json"]. The doctor
    // branch ignores payload, so it should still succeed. If the
    // parser is broken, we'd see exit 1 and an "unknown command"
    // message.
    assert.notEqual(r.status, 1, `doctor should not be rejected; got: stderr=${r.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
