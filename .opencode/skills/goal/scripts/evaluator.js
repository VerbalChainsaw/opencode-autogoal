#!/usr/bin/env node
/**
 * Deterministic Goal Evaluator
 *
 * Usage: node evaluator.js "<command>" [timeout_ms]
 *
 * Runs the command, checks exit code.
 * Exit code 0 = goal met. Non-zero = goal not met.
 *
 * Output: JSON to stdout — { met, reason, confidence, rawOutput }
 * Exit code: always 0 (errors reported in JSON, not process exit)
 *
 * Platform-safe: uses child_process.execSync with shell:true,
 * which auto-selects cmd.exe on Windows and sh on Unix.
 */

const { execSync } = require("node:child_process");

function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log(
      JSON.stringify({
        met: false,
        reason: "No command provided for deterministic evaluation",
        confidence: 1.0,
        evaluatorType: "deterministic",
        timestamp: Date.now(),
      })
    );
    process.exit(0);
  }

  const command = args[0];
  const timeout = parseInt(args[1] || "30000", 10); // default 30s

  try {
    const start = Date.now();
    const output = execSync(command, {
      timeout,
      encoding: "utf-8",
      maxBuffer: 1024 * 1024, // 1MB max output
      shell: true, // auto-selects platform shell
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true, // no console window flash on Windows
    });
    const elapsed = Date.now() - start;

    console.log(
      JSON.stringify({
        met: true,
        reason: `Command exited 0 in ${elapsed}ms. Output: ${output.slice(0, 200).trim()}`,
        confidence: 1.0,
        timestamp: Date.now(),
        evaluatorType: "deterministic",
        rawOutput: output.slice(0, 1000),
      })
    );
  } catch (err) {
    const exitCode = err.status ?? "unknown";
    const stderr = (err.stderr || "").trim();
    const stdout = (err.stdout || "").trim();
    const killed = err.killed || (err.signal !== undefined);
    const timedOut = killed && err.signal === "SIGTERM";

    let reason;
    if (timedOut) {
      reason = `Command timed out after ${timeout}ms`;
    } else if (killed) {
      reason = `Command killed by signal ${err.signal}`;
    } else {
      reason = `Command exited ${exitCode}. ${stderr.slice(0, 200) || stdout.slice(0, 200)}`;
    }

    console.log(
      JSON.stringify({
        met: false,
        reason,
        confidence: 1.0,
        timestamp: Date.now(),
        evaluatorType: "deterministic",
        rawOutput: (stdout + "\n" + stderr).slice(0, 1000),
      })
    );
  }

  process.exit(0);
}

main();
