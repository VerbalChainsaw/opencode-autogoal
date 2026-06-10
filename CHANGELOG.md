# Changelog

## 0.1.1

**Fix: the auto-loop no longer collides with tool-permission prompts.**

A session can go idle *while waiting for the user to approve a tool permission*.
In 0.1.0 the loop would inject its "continue" nudge anyway, which started a new
turn and orphaned the pending request — surfacing as **"permission request not
found"** and an agent that churned (re-building, re-editing) instead of waiting.

0.1.1 tracks open permission requests via the `permission.updated` /
`permission.replied` events and **skips evaluation/nudging while any permission is
open** for that session. If a reply never arrives, the loop simply pauses for that
session — failing safe. (New `PendingPermissions` helper, unit-tested.)

Reminder (unchanged behavior worth repeating): an active goal steers every turn
until it's met. Prefer `--command` goals (deterministic), keep conditions
specific, and use `/goal pause` or `/goal clear` the moment it drifts.

## 0.1.0

Initial release.

- Conversational tools (`set_goal` / `goal_status` / `clear_goal` / `pause_goal` /
  `resume_goal`) — set goals by talking to OpenCode.
- `/goal` command + a `session.idle` auto-loop.
- Deterministic `--command` verification (exit 0 = met) and a read-only
  `GOAL_COMPLETE` / `GOAL_BLOCKED` completion protocol.
- Turn/time limits, built-in + project templates, pause/resume/clear.
- Cross-platform TypeScript core; ships compiled `dist/`; zero installed deps
  beyond the OpenCode plugin API.
