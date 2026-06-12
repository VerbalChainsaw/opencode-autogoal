# v0.4.0 End-to-End Integration Test Report

**Task:** v0.4.0 end-to-end integration test (cross-feature)
**Date:** 2026-06-12
**Status:** ✅ Complete — 5/5 it() blocks pass, 723/723 in full suite, typecheck clean

---

## File created

| File | Lines | `it()` blocks |
|------|-------|---------------|
| `test/v040-e2e.test.mjs` | 597 | 5 |

The new file follows the existing test style:
- `node:test` + `node:assert/strict` (matching `test/cli-e2e.test.mjs`)
- Fresh temp dir per test via `mkdtempSync(join(tmpdir(), ...))` + `rmSync` in `afterEach`
- Real `node:http.createServer` receivers (not mocks) — both for (a) and (c)
- Real subprocess spawning of `node dist/cli.js` for (d)
- Imports compiled `dist/*.js` modules via Windows-safe `file:///` dynamic import

## What it covers

The 5 `it()` blocks fall under 4 `describe()` groups per the brief:

### (a) CHAIN + VERIFICATION + WEBHOOK — 1 test
3-step chain with a `file` verification object (Phase 2 union) on step 1. A real file
is placed inside the temp dir to satisfy `evaluateFile`'s path-traversal guard, and
the auto-loop is driven via the plugin's `event` hook. Asserts: the webhook receiver
gets one POST with `chainId`, `status="achieved"`, `previousStatus="active"`, and the
on-disk state advances to step 2 (`chainStep=1`).

### (b) TEMPLATE + CHAIN — 1 test
Writes a user template with a `{name}` placeholder to `.opencode/goals/`, runs
`template e2e-test --var name=foo` through the dispatcher, then wraps the resolved
goal in a 2-step chain. Asserts: the active goal's condition has `foo` substituted
(no literal `{name}` survives), the chain's step 0 inherits the resolved text, and
`chain.cycles=0`, `chain.current=0`.

### (c) WEBHOOK + CHAIN AUTO-ADVANCE — 2 tests
- `chain with shell verification fires webhook on achieved; advanceGoalChain progresses the chain`:
  2-step chain with `shell: "node -e \"process.exit(0)\""` verification on each step.
  First auto-loop pass fires the webhook and advances the chain. Then a manual
  `advanceGoalChain` call (simulating the second evaluation loop, which the real
  auto-loop's 5s debounce would otherwise suppress) advances past the last step.
  Asserts the chainId is on the POST, status progression is correct, and
  `chain.cycles=0` (stop mode).
- `loop-mode chain: cycles counter increments when onComplete=loop`:
  1-step chain with `onComplete="loop", maxCycles=5`. After one auto-loop pass,
  `chain.cycles=1` and `chain.current=0` (looped back). A second manual advance
  pushes cycles to 2.

### (d) HARNESS-LEVEL CLI e2e — 1 test
Spawns `node dist/cli.js chain start <json>` and `node dist/cli.js chain` as real
subprocesses. Both must exit 0. Then reads `.opencode/.goal-state.json` directly
(as an external tool would) and asserts `metadata.chainId`, `chainStep=0`,
`chainTotal=3` are all set.

## Defect found and fixed

While writing test (a), the auto-loop ran `evaluateByTranscript` (marker) instead
of the file verification. Root cause: `createGoalChain` in `src/goal-chain.ts`
built the active state from the step's `condition` and `command` only — it did
NOT propagate the step's `verification` field. The new `Verification` union from
Phase 2 was being dropped on the floor when a goal was created as part of a chain.

**Fix:** `src/goal-chain.ts`
- Added `verification?: Verification | null` to `GoalChainStep` (with the matching
  `import type { Verification }` from `goal-state.js`).
- Passed `step.verification ?? null` into `createGoalState` in all three
  construction sites: `createGoalChain` (step 0), `advanceGoalChain` (subsequent
  steps), and `resetGoalChain`.

This is the same class of defect that the prior `template-thickener` track
caught for templates — the dispatcher resolved the template's seed command with
the `--var` values, but the chain primitive had the symmetric gap on
verification. Pin regression: the new test (a) asserts the state file actually
carries `verification` after `createGoalChain` (via the auto-loop evaluating
it and firing the webhook with the right reason).

The validator (`validateGoalChain`) already tolerates unknown step fields, so
existing chain JSON files on disk remain valid.

## Required output

### `node --test test/v040-e2e.test.mjs` (last 10 lines)
```
ok 579 - (d) HARNESS-LEVEL CLI e2e
  ---
  duration_ms: 149.9513
  type: 'suite'
  ...
1..4
# tests 5
# suites 4
# pass 5
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 571.6317
```

### `npm test` (last 5 lines)
```
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 11274.702
```

(Full output: `# tests 723 / # pass 723 / # fail 0` — up from the 718 baseline
established by the prior red-team-audit track, +5 from the new e2e tests.)

### `npx tsc -p tsconfig.json` (last 3 lines)
```
$ npx tsc -p tsconfig.json
$ # (no output — clean run, exit 0)
```

## Files changed
- **Created:** `test/v040-e2e.test.mjs` (597 lines, 5 it() blocks)
- **Modified:** `src/goal-chain.ts` (3-site fix: `GoalChainStep` gets
  `verification?`; `createGoalChain`/`advanceGoalChain`/`resetGoalChain` pass it
  through to `createGoalState`)

## Files unchanged
- `dist/goal-chain.js` / `dist/goal-chain.d.ts` — rebuilt by `npm run build` (run
  as part of `npm test`); the new behavior is in the new build.
- No test files in the existing chain / verify / webhook / template suites
  needed changes — they continue to pass (718 → 723).
