# Traceability Matrix

> **Requirement → Implementation → Test**
> Filled as changes are made. Empty rows are gaps.

---

| Req ID | Description | Files | Tests | Verification | Status |
|--------|-------------|-------|-------|-------------|--------|
| REQ-001 | CLI Entry Point | `src/cli.ts` | `test/cli.test.mjs`, `test/command-envelope.test.mjs` | `npm test` | COVERED |
| REQ-002 | Goal State Management | `src/goal-state.ts` | `test/goal-state.test.mjs`, `test/v042-corrupt-surfacing.test.mjs` | `npm test` | COVERED |
| REQ-003 | CLI Commands | `src/cli.ts`, `src/command.ts` | `test/command.test.mjs`, `test/command-dials.test.mjs`, `test/cli.test.mjs` | `npm test` | COVERED |
| REQ-004 | Conversational Tools | `src/server.ts` | `test/server-dials.test.mjs` | `npm test` | COVERED |
| REQ-005 | Auto-Loop | `src/server.ts` | `test/server-verify.test.mjs`, `test/server-error.test.mjs`, `test/server-webhook.test.mjs` | `npm test` | COVERED |
| REQ-006 | Session Events & Timeline | `src/session-events.ts`, `src/step-timeline.ts` | `test/session-events.test.mjs`, `test/step-timeline.test.mjs` | `npm test` | COVERED |
| REQ-007 | TUI Control Center | `src/control-center.ts`, `src/control-center-logic.ts`, `src/control-center-pane.ts`, `src/control-center-history.ts`, `src/help-content.ts`, `src/help-overlay.ts`, `src/picker.ts` | `test/control-center.test.mjs`, `test/control-center-logic.test.mjs`, `test/control-center-pane.test.mjs`, `test/help-content.test.mjs`, `test/help-overlay.test.mjs`, `test/probe-v070.test.mjs`, `test/walkthrough-v070.test.mjs` | `npm test` | COVERED |
| REQ-008 | GUI Integration | `src/gui.ts` | `test/gui.test.mjs` | `npm test` | COVERED |
| REQ-009 | Goal Chains | `src/goal-chain.ts` | `test/goal-chain.test.mjs`, `test/v040-chain-webhook.test.mjs` | `npm test` | COVERED |
| REQ-010 | Goal Archive | `src/goal-archive.ts` | `test/goal-archive.test.mjs` | `npm test` | COVERED |
| REQ-011 | Goal Templates | `src/templates.ts`, `src/templates-view.ts` | `test/template.test.mjs`, `test/templates-view.test.mjs` | `npm test` | COVERED |
| REQ-012 | Webhook Notifications | `src/server.ts` | `test/server-webhook.test.mjs` | `npm test` | COVERED |
| REQ-013 | No Standalone Web Server | `src/cli.ts`, `package.json` | `test/cli.test.mjs` | `npm test` | COVERED |
| REQ-014 | Security Model | `src/goal-state.ts`, `src/server.ts` | `test/security.test.mjs`, `test/server-verify.test.mjs` | `npm test` | COVERED |
| REQ-015 | Sidebar Plugin | `src/sidebar-logic.ts`, `src/sidebar.tsx` | `test/sidebar-logic.test.mjs` | `npm test` | COVERED |
| REQ-016 | TUI Dashboard | `src/tui-logic.ts`, `src/tui.tsx`, `src/tui-dials-logic.ts` | `test/tui-logic.test.mjs`, `test/tui-ux-fixes.test.mjs`, `test/tui-dials-logic.test.mjs` | `npm test` | COVERED |
| REQ-I001 | Handoff System | `src/goal-state.ts` | `test/goal-state.test.mjs` | `npm test` | COVERED |
| REQ-I002 | Compaction Hook | `src/server.ts` | `test/e2e.test.mjs` | `npm test` | COVERED |
| REQ-I003 | Pre-commit Hook | `tools/guard-spec-ref.sh` | (manual) | — | UNTRACKED |
| REQ-I004 | AGENTS.md | `AGENTS.md` | (manual) | — | UNTRACKED |
| REQ-017 | RenderBlock Protocol | `src/blocks/types.ts`, `src/blocks/validate.ts`, `src/blocks/factories.ts`, `src/blocks/goal-blocks.ts`, `src/server.ts` | `test/blocks-validate.test.mjs`, `test/blocks-goal-blocks.test.mjs` | `npm test` | COVERED |
