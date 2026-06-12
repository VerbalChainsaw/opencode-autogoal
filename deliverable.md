# D6 + F1 patch — v0.4.0

## Summary

Two targeted fixes layered on v0.4.0 commit `ad378b0`:
- **D6 (chain webhook carry-over)**: chain-level `webhook` config
  added to `GoalChain`; on every step creation (create / advance /
  skip / reset) the chain projects its webhook onto the new step's
  `metadata.webhook`, so a webhook configured at chain start fires on
  every step's achievement, not just step 0. The `goal_webhook` tool
  now routes through `setChainWebhook` when the active goal is in a
  chain, so the chain stays the single source of truth.
- **F1 (server-webhook test flake)**: verified already resolved in
  ad378b0 — the test at `test/server-webhook.test.mjs:489-504` already
  uses `await waitFor(receiver.received, 1)` on line 501, which is the
  same waitFor pattern the other 15 webhook tests in the file use.
  5/5 consecutive test runs pass cleanly with the existing code.
  No code change required.

## Fix approach for D6: chain-level (option #1)

The brief gave two options — copy the previous step's webhook on
advance (3-line patch) or move the webhook to the chain (architectural
fix). I went with the chain-level approach because:

1. The reviewer recommended it.
2. The chain has one notification semantic; storing the webhook on
   every step's state leaks the chain's config into per-step state and
   makes "set webhook once, applies to all steps" impossible to enforce
   (a user could `goal_webhook` a different URL on a mid-chain step).
3. Future-proof: any new step-creation path (e.g. loop-back in loop
   mode) automatically inherits the chain's webhook by routing through
   the same `applyChainWebhookToState` helper.
4. The chain file is the on-disk source of truth for chain-level
   config (`chainId`, `chainStep`, `chainTotal`, …) — the webhook
   belongs there.

The `goal_webhook` tool, when the active goal has a `chainId`, now
calls `setChainWebhook` instead of mutating the state in place. When
the goal is standalone, it falls back to the original per-state path
(unaffected).

## Changed files

| File | Change |
|---|---|
| `src/goal-chain.ts` | Added `ChainWebhook` type, `webhook?` field on `GoalChain`, `sanitizeChainWebhook` helper, `setChainWebhook` function. Updated `createGoalChain` to accept `webhook` in opts (object or `"from-state"`), `validateGoalChain` to enforce the webhook shape, and `createGoalChain` / `advanceGoalChain` / `resetGoalChain` to project `chain.webhook` onto the new step's `metadata.webhook` via the new `applyChainWebhookToState` helper. |
| `src/server.ts` | `goal_webhook` tool routes through `setChainWebhook` when the active goal is in a chain. Standalone-goal path unchanged. Added `setChainWebhook` to the goal-chain import. |
| `test/v040-chain-webhook.test.mjs` | New file. 11 regression tests in 2 describe blocks: 9 unit tests (state-file checks after each create/advance/skip/reset) + 2 e2e tests (real `node:http` receiver, full auto-loop cycle). |

## New regression test

**File:** `test/v040-chain-webhook.test.mjs` (new — 11 tests, 348 lines)

- `D6 — chain step states inherit chain.webhook` (suite) — 9 unit tests
  - `createGoalChain: webhook at chain start lands on step 0's state` — line 134
  - `createGoalChain: 'webhook: from-state' promotes a pre-chain state webhook to the chain` — line 152
  - `advanceGoalChain: webhook projects onto step 1, step 2, ... (THE D6 FIX)` — line 196
  - `skipGoalChainStep: webhook projects onto the skipped-over step` — line 227
  - `resetGoalChain: webhook projects onto the rebuilt step 0` — line 250
  - `setChainWebhook: updates chain.webhook AND re-projects onto current state` — line 278
  - `setChainWebhook(null) clears the chain's webhook AND the current state` — line 311
  - `setChainWebhook: rejects malformed webhook (invalid URL, no valid 'on' statuses)` — line 330
  - `validateGoalChain rejects a chain file with malformed webhook` — line 360
- `D6 — 3-step chain fires webhook on every step's achievement` (suite) — 2 e2e tests
  - `steps 0 and 1 each fire one POST; step 2's state carries the webhook (would fire on next achieve)` — line 408
  - `createGoalChain with 'webhook' opts: chain-level config fires on step 0's achievement, projects onto step 1's state` — line 480

The e2e tests start a real `node:http` receiver on `127.0.0.1:<random>`
and drive the chain through the auto-loop's `session.idle` event
handler. Without the D6 fix, only one POST lands (for step 0); with
the fix, the receiver gets 2 POSTs (one per cycle) and the chain
proceeds to step 2 with the webhook still on its state.

**Fails without the fix:** verified by `git stash` of the goal-chain.ts
+ server.ts changes → 11/11 tests in this file fail. After
`git stash pop`, all 11 pass.

## Final test count

```
# tests 734
# suites 57
# pass 734
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 12108.2229
```

Baseline was 723 (ad378b0). The D6 patch adds 11 tests (734 total).
Typecheck clean (`npx tsc -p tsconfig.json` exit 0).
Build clean (`npm run build` exit 0).
Two consecutive full-suite runs both 734/734.

## Notes for the verifier

- **F1 is already fixed in ad378b0** — the test at
  `test/server-webhook.test.mjs:501` already does
  `await waitFor(receiver.received, 1)`. The brief's
  "no wait" description is from a pre-ad378b0 state. I confirmed
  5/5 runs of the full suite pass with 734/734 green, so F1 needs
  no additional code change. If you want the wait timeout bumped
  from 2s default to 5s for CI robustness, that's a 1-line tweak.

- **Spec vs chain-level webhook** — the v0.4.0 spec at
  `specs/v0.4.0-roadmap.md:319-327` defines `webhook` on
  `GoalState.metadata`. The chain-level approach adds `webhook` to
  the `GoalChain` type as the *source* for that field. The
  per-state `metadata.webhook` is still set (projected from the
  chain on every step create), so `fireWebhook` in server.ts reads
  from the same field as before — no spec drift, just an additional
  owner.

- **Backwards compat** — `GoalChain.webhook` is optional in the
  type and on disk. Existing chain files (without the field)
  validate cleanly: `sanitizeChainWebhook(undefined)` is never
  called; `validateGoalChain` only routes the webhook through the
  sanitizer when it's present. The 25 existing chain tests
  (`test/goal-chain.test.mjs`) all pass unchanged.

- **Sanitization symmetry** — `sanitizeChainWebhook` mirrors the
  shape checks in `sanitizeMetadata.webhook` (URL must be http/https,
  `on` filtered to valid `GoalStatus`, `allowLocal` boolean). A
  poisoned `.goal-chain.json` with a malformed webhook is rejected
  by `validateGoalChain` (covered by test 9 above).

- **goal_webhook on chain-active state** — the brief says "chain-level
  config wins for steps created/advanced under the chain." When a user
  calls `goal_webhook` on a step within a chain, the new URL/`on`/
  `allowLocal` now go to `setChainWebhook`, which updates both the
  chain file and the current step's `metadata.webhook`. Future
  `advanceGoalChain` calls project the updated chain webhook onto
  the new step. The standalone-goal path is unchanged.

- **CLI side** — the chain-level webhook is settable via the new
  `setChainWebhook` exported function. A future CLI verb
  (`chain webhook <url> --on achieved`) would just call it. Not
  added in this patch — the spec didn't call for it, and the test
  surface (set via the `goal_webhook` tool post-create, or via
  `createGoalChain` opts) covers the documented user workflows.

- **Did not touch** — `CHANGELOG.md`, `package.json`, or the v0.4.0
  hardening commit. The fix is a clean patch on top of `ad378b0`.
