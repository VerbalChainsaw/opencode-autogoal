/**
 * opencode-autogoal — SERVER plugin (the whole product on Desktop).
 *
 * Runtime imports: Node builtins, this package's own `goal-state.js`/`command.js`,
 * and `tool` from `@opencode-ai/plugin` (the host-provided plugin API — the only
 * dependency). `tool.schema` is the host's own zod, so no separate zod dependency.
 *
 * Responsibilities:
 *  - `tool` → conversational goal management (set_goal / goal_status / clear_goal /
 *    pause_goal / resume_goal): the user just asks in plain language. PRIMARY UX.
 *  - `config` + `command.execute.before` → the optional `/goal` slash command,
 *    handled deterministically in TS (logic lives in ./command.ts).
 *  - `event` (session.idle) → the auto-loop: evaluate the goal, notify, and nudge
 *    the agent onward until the condition holds or a constraint trips.
 *  - `experimental.session.compacting` → keeps the goal in context across compaction.
 */

import type { Plugin, PluginModule } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import {
  readGoalState,
  readGoalStateResult,
  listCorruptArtifacts,
  writeGoalStateAtomic,
  setGoalFields,
  transitionGoal,
  detectMarker,
  parseShellWords,
  sanitizeForPrompt,
  editMaxTurns,
  editMaxTime,
  editMaxTokens,
  editCondition,
  appendSteering,
  clearSteering,
  restartGoal,
  createHandoff,
  claimHandoff,
  parsePositiveInt,
  COMPLETE_RE,
  BLOCKED_RE,
  type GoalState,
  type GoalEvaluation,
  type GoalStatus,
  type Verification,
} from "./goal-state.js";
import { advanceGoalChain, setChainWebhook } from "./goal-chain.js";
import { dispatchGoalCommand, goalInstructions, plainStatus } from "./command.js";
import { appendGoalArchive } from "./goal-archive.js";
import { appendSessionEvent, type SessionEvent } from "./session-events.js";
import { appendStepTimelineEvent, type StepTimelineEvent, type StepOutcome } from "./step-timeline.js";
import { PendingPermissions } from "./permissions.js";
import {
  buildGoalStatusBlocks,
  buildGoalTransitionBlocks,
} from "./blocks/goal-blocks.js";

const execAsync = promisify(exec);

// ── Blocks helpers ──────────────────────────────────────────────────────────
// context.metadata() is the vNext path for RenderBlock emission (specs/render-protocol-design.md).
// It may not be present in older SDK versions or test harnesses — guard with a runtime check.

function emitBlocks(ctx: any, blocks: unknown[]): void {
  if (typeof ctx.metadata === "function") {
    try { ctx.metadata({ metadata: { blocks } }); } catch { /* best-effort */ }
  }
}

const CONFIG = {
  evaluationDebounceSec: 5,
  commandTimeoutMs: 30_000,
  // Set OPENGOAL_DEBUG=1 to surface debug-level logs while testing/diagnosing.
  debug: process.env.OPENGOAL_DEBUG === "1" || process.env.OPENGOAL_DEBUG === "true",
};

// Minimal fallback template; the real work happens in command.execute.before.
const COMMAND_TEMPLATE =
  "Handle the /goal command. Arguments: $ARGUMENTS\n" +
  "(The goal plugin processes this deterministically; follow the injected instructions.)";

// v0.4.0+ — SSRF guard. Returns true for `localhost` (any port), the entire
// `127.0.0.0/8` loopback range, IPv6 loopback `[::1]`, the unspecified
// addresses `0.0.0.0` / `[::]`, AND the IPv4-mapped IPv6 forms of loopback
// (`[::ffff:127.0.0.1]`, which WHATWG URL normalizes to `[::ffff:7f00:1]`).
// Does NOT block private network ranges (10.x, 172.16.x, 192.168.x) or
// link-local (169.254.x) — CI servers and self-hosted runners commonly live
// on those ranges.
//
// Lifted to module scope (was a factory-closure helper) so it can be
// unit-tested directly; it closes over nothing, so the move is behavior-
// preserving. (v0.5.x hardening.)
//
// STRING-MATCH ONLY: this is a literal hostname check, not a DNS resolve. A
// hostname that *resolves* to a loopback address but isn't written as one
// (e.g. `myrouter.lan` pointing at 127.0.0.1) is not blocked here. The spec
// calls this out explicitly: "the check is a string match." Adding a DNS
// resolve would introduce a TOCTOU window (the name could resolve differently
// by the time the fetch lands) and would block legitimate webhook receivers
// whose DNS is in flux during an incident. The IPv4-mapped IPv6 cases below
// are still pure string matching on the normalized hostname — no resolution.
export function isLocalUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const h = u.hostname;
    if (h === "localhost" || h === "0.0.0.0") return true;
    // `[::1]` is the URL-spec form of the IPv6 loopback; `[::]` / `[::0]` is
    // the unspecified address (the IPv6 analog of the 0.0.0.0 we block above).
    if (h === "[::1]" || h === "[::]" || h === "[::0]") return true;
    // 127.0.0.0/8 — any address in 127.* is a loopback per RFC 1122.
    // 127.x.y.z where each octet is 0-255.
    if (/^127(?:\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)){3}$/.test(h)) return true;
    // IPv4-mapped IPv6 loopback. WHATWG URL normalizes `[::ffff:127.0.0.1]`
    // to the hex form `[::ffff:7f00:1]`, but accept both spellings. We
    // reconstruct the embedded IPv4's first octet and block 127.0.0.0/8.
    const mapped = h.match(/^\[::ffff:(.+)\]$/i);
    if (mapped) {
      const tail = mapped[1]!;
      const dotted = tail.match(/^(\d{1,3})\.\d{1,3}\.\d{1,3}\.\d{1,3}$/);
      if (dotted) {
        if (Number(dotted[1]) === 127) return true;
      } else {
        const hex = tail.match(/^([0-9a-f]{1,4}):[0-9a-f]{1,4}$/i);
        if (hex && ((parseInt(hex[1]!, 16) >> 8) & 0xff) === 127) return true;
      }
    }
    return false;
  } catch { return false; }
}

// ── v0.7.0 (A3) — recordToolEvent ────────────────────────────────────────
// Best-effort recorder for the live session activity feed. Called by the
// `tool.execute.after` hook (and exported so the test can drive it
// directly). NEVER throws — the underlying appendSessionEvent already
// swallows I/O errors; this wrapper adds the input-shape normalization
// (synthesizing summary, truncating args) so the JSONL feed stays
// compact and the Live Session pane never has to defend against a 1 MB
// args payload. The args are NOT sanitized for prompt-injection here —
// the LIVE-SESSION file is a display surface, not a prompt surface; the
// TUI control center's own sanitizer is the trust boundary at read
// time. (See src/control-center-logic.ts.)

/**
 * Record a single tool-end event to `.opencode/.session-events.jsonl`.
 * Best-effort: any failure is swallowed (the underlying
 * `appendSessionEvent` already handles I/O). Safe to call from the
 * `tool.execute.after` hook — a tool execution MUST NOT fail because
 * the events log is full or unwritable.
 *
 * Input shape matches the OpenCode plugin SDK's `tool.execute.after`
 * hook input/output. The `args` are kept as a `Record<string, unknown>`
 * in the JSONL but the `summary` field is truncated to 120 chars and
 * the `output` is not persisted (would be too large). The `metadata`
 * field is used to extract `durationMs` and `exitCode` when present.
 */
export function recordToolEvent(
  directory: string,
  input: { tool: string; sessionID: string; callID: string; args: any },
  output: { title: string; output: string; metadata: any },
): void {
  const md = (output && typeof output.metadata === "object" && output.metadata !== null)
    ? output.metadata as Record<string, unknown>
    : {};
  const durationMs = typeof md.durationMs === "number" && Number.isFinite(md.durationMs)
    ? md.durationMs
    : undefined;
  const exitCode = typeof md.exitCode === "number" && Number.isFinite(md.exitCode)
    ? md.exitCode
    : undefined;
  const ok = exitCode === undefined ? undefined : exitCode === 0;
  const summary = (output?.title ?? "").toString().slice(0, 120);
  const ev: SessionEvent = {
    at: Date.now(),
    kind: "tool-end",
    tool: input.tool,
    args: input.args && typeof input.args === "object" ? input.args : undefined,
    durationMs,
    ok,
    summary,
  };
  // v0.7.0 — recordToolEvent propagates the SDK's callID through the
  // SessionEvent args so the Live Session pane can group tool-start /
  // tool-end pairs by callID. The SessionEvent type does not currently
  // carry callID (it was designed as a flat display surface), so we
  // tuck it inside `args` (the args is already a free-form object).
  // A future v0.7.x can promote callID to a top-level field if the
  // pane ever needs to display it.
  if (input.callID && typeof input.callID === "string") {
    if (!ev.args || typeof ev.args !== "object") {
      ev.args = { callID: input.callID };
    } else {
      ev.args = { ...ev.args, callID: input.callID };
    }
  }
  appendSessionEvent(directory, ev);
}

// ── v0.7.0 (A4) — recordStepEvaluation ───────────────────────────────────
// Best-effort recorder for the per-turn step timeline. Called by the
// `session.idle` handler after the auto-loop records an evaluation.
// The session.idle handler already calls writeGoalStateAtomic with the
// new state.turnsEvaluated; this function reads from the just-written
// state to assemble a timeline event with the right turn index.

/**
 * Record one step-timeline event to `.opencode/.step-timeline.jsonl`.
 * Best-effort: any failure is swallowed. Safe to call from inside the
 * session.idle handler — a failed timeline write MUST NOT block the
 * auto-loop.
 *
 * Maps a `GoalEvaluation` to a `StepOutcome`:
 *   - met=true                  → "met"
 *   - met=false, blocked=true   → "blocked"
 *   - met=false, blocked=false  → "in-progress"
 */
export function recordStepEvaluation(
  directory: string,
  args: {
    at: number;
    turn: number;
    label: string;
    evaluation: { met: boolean; blocked?: boolean; reason?: string; evaluatorType: string };
  },
): void {
  let outcome: StepOutcome;
  if (args.evaluation.met) outcome = "met";
  else if (args.evaluation.blocked) outcome = "blocked";
  else outcome = "in-progress";
  const reason = args.evaluation.reason
    ? sanitizeForPrompt(args.evaluation.reason).slice(0, 240) || undefined
    : undefined;
  const ev: StepTimelineEvent = {
    at: args.at,
    turn: args.turn,
    label: args.label.slice(0, 80),
    outcome,
    reason,
  };
  appendStepTimelineEvent(directory, ev);
}

export const server: Plugin = async ({ client, directory }) => {
  let lastEvaluationTime = 0;
  let isEvaluating = false;
  // Tracks open tool-permission requests; the loop must not nudge while one is open.
  const pendingPermissions = new PendingPermissions();

  function log(level: "debug" | "info" | "warn" | "error", message: string, extra?: any) {
    if (!CONFIG.debug && level === "debug") return;
    client.app.log({ body: { service: "opencode-autogoal", level, message: `[goal] ${message}`, extra } }).catch(() => {});
  }

  // ── User-facing notifications, frontend-agnostic ──────────────────────────
  // `client.tui.showToast` only renders in the terminal TUI; on the Desktop
  // (Electron) app it is a no-op. The conversation is the one shared surface, so
  // we ALSO write a `noReply` status line into the session.
  async function notify(sessionId: string, title: string, message: string, variant: "info" | "success" | "warning" | "error") {
    await client.tui.showToast({ body: { title, message, variant } }).catch(() => {});
    await client.session
      .prompt({ path: { id: sessionId }, body: { noReply: true, parts: [{ type: "text", text: `🎯 [${title}] ${message}` }] } })
      .catch((err) => log("error", "notify (session message) failed", { error: String(err) }));
  }

  // Command handling lives in ./command.ts (pure + unit-tested).

  // ── Auto-loop evaluation ──────────────────────────────────────────────────
  function checkConstraints(state: GoalState): { exceeded: boolean; reason: string } {
    const c = state.constraints;
    if (state.turnsEvaluated >= c.maxTurns)
      return { exceeded: true, reason: `Turn limit reached: ${state.turnsEvaluated}/${c.maxTurns} turns` };
    const elapsedMin = (Date.now() - state.startedAt) / 60_000;
    if (elapsedMin >= c.maxTimeMinutes)
      return { exceeded: true, reason: `Time limit reached: ${Math.round(elapsedMin)}/${c.maxTimeMinutes} minutes` };
    // maxTokens is intentionally not enforced: the SDK exposes no per-session token count.
    return { exceeded: false, reason: "" };
  }

  async function evaluateDeterministic(command: string): Promise<GoalEvaluation> {
    const now = Date.now();
    // Debug-only: log the portable argv view of the command. The execution
    // path still uses `exec` (the user expects shell semantics — `2>&1`,
    // pipes, `&&`). The argv view is for diagnostics; it's the same on every
    // platform and lets users verify their command parses as they expect.
    if (CONFIG.debug) {
      log("debug", "verification command argv", { argv: parseShellWords(command) });
    }
    try {
      const { stdout } = await execAsync(command, {
        cwd: directory,
        timeout: CONFIG.commandTimeoutMs,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      });
      return {
        met: true,
        reason: sanitizeForPrompt(`Verified (exit 0): ${stdout.slice(0, 200).trim()}`),
        confidence: 1.0,
        timestamp: now,
        evaluatorType: "deterministic",
        rawOutput: stdout.slice(0, 1000),
      };
    } catch (err: any) {
      const timedOut = err?.killed && (err?.signal === "SIGTERM" || err?.signal === "SIGKILL");
      const stderr = String(err?.stderr ?? "").trim();
      const stdout = String(err?.stdout ?? "").trim();
      const reason = timedOut
        ? `Command timed out after ${CONFIG.commandTimeoutMs}ms`
        : sanitizeForPrompt(`Not met (exit ${err?.code ?? "?"}): ${(stderr || stdout || String(err?.message ?? err)).slice(0, 200)}`);
      return { met: false, reason, confidence: 1.0, timestamp: now, evaluatorType: "deterministic", rawOutput: `${stdout}\n${stderr}`.slice(0, 1000) };
    }
  }

  async function getLatestAssistantText(sessionId: string): Promise<string> {
    try {
      const res = await client.session.messages({ path: { id: sessionId } });
      const msgs = (res.data ?? []) as any[];
      const last = msgs.filter((m) => m?.info?.role === "assistant").at(-1);
      if (!last) return "";
      return (last.parts ?? []).filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n");
    } catch (err) {
      log("debug", "Could not read messages", { error: String(err) });
      return "";
    }
  }

  function evaluateByTranscript(latest: string): GoalEvaluation {
    const now = Date.now();
    const detail = detectMarker(latest, COMPLETE_RE);
    if (detail !== null) {
      return { met: true, reason: `Agent reported completion: ${detail.slice(0, 200) || "(no detail)"}`, confidence: 0.8, timestamp: now, evaluatorType: "heuristic" };
    }
    return { met: false, reason: "No GOAL_COMPLETE signal in latest output yet", confidence: 0.5, timestamp: now, evaluatorType: "heuristic" };
  }

  // ── v0.4.0+ verification dispatcher ───────────────────────────────────
  async function evaluateGoal(state: GoalState, latestTranscript: string): Promise<GoalEvaluation> {
    const v = state.verification;
    if (!v) {
      if (state.command) return evaluateDeterministic(state.command);
      return evaluateByTranscript(latestTranscript);
    }
    switch (v.type) {
      case "shell":  return evaluateDeterministic(v.command);
      case "http":   return evaluateHttp(v);
      case "file":   return evaluateFile(v);
      case "marker": return evaluateByTranscript(latestTranscript);
    }
  }

  async function evaluateHttp(v: { url: string; expectStatus?: number; expectBody?: string; timeoutMs?: number }): Promise<GoalEvaluation> {
    const now = Date.now();
    const timeout = v.timeoutMs ?? 10_000;
    try {
      const res = await fetch(v.url, { signal: AbortSignal.timeout(timeout) });
      const expectStatus = v.expectStatus ?? 200;
      if (res.status !== expectStatus) {
        return { met: false, reason: `HTTP ${res.status} (expected ${expectStatus})`, confidence: 1.0, timestamp: now, evaluatorType: "deterministic" };
      }
      if (v.expectBody) {
        const body = await res.text();
        if (!new RegExp(v.expectBody).test(body)) {
          return { met: false, reason: `Body didn't match /${v.expectBody}/`, confidence: 1.0, timestamp: now, evaluatorType: "deterministic" };
        }
      }
      return { met: true, reason: `HTTP ${res.status} OK`, confidence: 1.0, timestamp: now, evaluatorType: "deterministic" };
    } catch (err: any) {
      return { met: false, reason: `HTTP check failed: ${err?.message ?? err}`, confidence: 1.0, timestamp: now, evaluatorType: "deterministic" };
    }
  }

  async function evaluateFile(v: { path: string; exists?: boolean; contains?: string }): Promise<GoalEvaluation> {
    const now = Date.now();
    const { resolve, relative, isAbsolute } = await import("node:path");
    const resolved = resolve(directory, v.path);
    // Path traversal guard. On POSIX, `relative(/a, /etc/passwd)` returns
    // `../../etc/passwd` and `startsWith("..")` catches it. On Windows,
    // cross-drive `relative(C:/..., D:/x)` returns the absolute D:/x path
    // verbatim — does NOT start with `..` — so we ALSO check `isAbsolute`.
    // Without this, a user-supplied `D:\sensitive\file.txt` from a C:
    // directory would bypass the guard. (v0.4.0 hardening, Phase 2 audit.)
    const rel = relative(directory, resolved);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      return { met: false, reason: "Path traversal blocked", confidence: 1.0, timestamp: now, evaluatorType: "deterministic" };
    }
    try {
      const { existsSync, readFileSync } = await import("node:fs");
      const fileExists = existsSync(resolved);
      if (v.exists === false) {
        return { met: !fileExists, reason: fileExists ? "File exists (expected absent)" : "File absent (as expected)", confidence: 1.0, timestamp: now, evaluatorType: "deterministic" };
      }
      if (!fileExists) {
        return { met: false, reason: "File not found", confidence: 1.0, timestamp: now, evaluatorType: "deterministic" };
      }
      if (v.contains) {
        const content = readFileSync(resolved, "utf-8");
        if (!new RegExp(v.contains).test(content)) {
          return { met: false, reason: `Content doesn't match /${v.contains}/`, confidence: 1.0, timestamp: now, evaluatorType: "deterministic" };
        }
      }
      return { met: true, reason: "File check passed", confidence: 1.0, timestamp: now, evaluatorType: "deterministic" };
    } catch (err: any) {
      return { met: false, reason: `File check failed: ${err?.message ?? err}`, confidence: 1.0, timestamp: now, evaluatorType: "deterministic" };
    }
  }

  // ── v0.4.0+ webhook notification ──────────────────────────────────────
  // Fires fire-and-forget POSTs to a user-configured URL when a goal
  // transitions into a status the user opted into (`wh.on`).
  //
  // SECURITY: `lastReason` and `condition` are routed through
  // `sanitizeForPrompt` before serialization. The state file is
  // user-controlled and the underlying `lastEvaluation.reason` is
  // constructed from agent-transcript text (a v0.1.0 prompt-injection
  // class). Sending a raw reason to a webhook receiver would smuggle
  // C0/C1 control chars and Unicode format chars into a different
  // trust boundary (a Slack/Discord/Teams integration is a likely
  // target) where they could trigger renderer bugs in the receiving
  // service. sanitizeForPrompt strips those without altering the
  // visible text. (Regression test: server-webhook.test.mjs
  // "fireWebhook sanitizes lastReason".)
  async function fireWebhook(state: GoalState, previousStatus: GoalStatus | null) {
    const wh = state.metadata.webhook;
    if (!wh || !wh.on.includes(state.status)) return;
    if (!wh.allowLocal && isLocalUrl(wh.url)) {
      log("warn", "webhook blocked: localhost URL", { url: wh.url });
      return;
    }
    const payload = {
      goalId: state.id,
      chainId: state.metadata.chainId ?? null,
      condition: sanitizeForPrompt(state.condition),
      status: state.status,
      previousStatus,
      turnsEvaluated: state.turnsEvaluated,
      lastReason: state.lastEvaluation?.reason
        ? sanitizeForPrompt(state.lastEvaluation.reason).slice(0, 1000)
        : null,
      timestamp: Date.now(),
    };
    fetch(wh.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    }).catch(() => { /* fire-and-forget */ });
  }

  function recordEvaluation(state: GoalState, evaluation: GoalEvaluation): void {
    state.turnsEvaluated++;
    state.lastEvaluation = evaluation;
    state.evaluationHistory.push(evaluation);
    if (state.evaluationHistory.length > 10) state.evaluationHistory.shift();
  }

  // v0.7.0 (A4) — write a step-timeline event alongside every recorded
  // evaluation. Calls the exported recordStepEvaluation (which itself
  // delegates to the best-effort appendStepTimelineEvent). The turn
  // index is state.turnsEvaluated - 1 because recordEvaluation above
  // already incremented it. The label is a short, human-readable
  // description of what was just evaluated — heuristic, blocked-marker,
  // and constraint-clear paths all get distinct labels so the timeline
  // tells the user "what kind of step" each turn was.
  function recordTimelineFor(state: GoalState, evaluation: GoalEvaluation, label: string): void {
    recordStepEvaluation(directory, {
      at: evaluation.timestamp,
      turn: Math.max(0, state.turnsEvaluated - 1),
      label,
      evaluation: {
        met: !!evaluation.met,
        blocked: !!evaluation.blocked,
        reason: evaluation.reason,
        evaluatorType: evaluation.evaluatorType,
      },
    });
  }

  async function evaluate(state: GoalState, sessionId: string): Promise<void> {
    if (isEvaluating) return;
    const now = Date.now();
    // Debounce rapid idle bursts. Fails SAFE: if an injected turn finishes within
    // the window the loop stalls rather than spins; turns normally exceed it.
    if (now - lastEvaluationTime < CONFIG.evaluationDebounceSec * 1000) return;
    isEvaluating = true;
    lastEvaluationTime = now;
    try {
      // Run the constraint check inside the lock so it operates on fresh state
      // (the `state` parameter is a snapshot from the idle handler, read without
      // the lock — a user could edit constraints upward between that read and
      // here, causing a false-positive "limit exceeded" clearing).
      const constraintResult = (() => {
        const f = readGoalState(directory);
        if (!f || f.status !== "active" || f.id !== state.id) return null;
        const constraint = checkConstraints(f);
        if (constraint.exceeded) {
          f.status = "cleared";
          f.completedAt = now;
          f.lastEvaluation = { met: false, reason: constraint.reason, confidence: 1.0, timestamp: now, evaluatorType: "deterministic" };
          recordEvaluation(f, f.lastEvaluation);
          // v0.7.0 (A4) — record a timeline event for the constraint
          // clear so the Live Session pane shows the user "turn N: goal
          // cleared (constraint tripped)" in the timeline.
          recordTimelineFor(f, f.lastEvaluation, "constraint-clear");
          writeGoalStateAtomic(directory, f);
          return { cleared: true as const, reason: constraint.reason };
        }
        return { cleared: false as const };
      })();
      if (!constraintResult) return;
      if (constraintResult.cleared) {
        // v0.4.0+ webhook: fire on the active → cleared transition
        // (spec call site: "Goal timed out"). The fresh state is
        // read back so the payload reflects the cleared state (and
        // the webhook's `on` filter can match `"cleared"`). We pass
        // previousStatus="active" explicitly because the in-place
        // mutation in the IIFE above has already moved the state to
        // "cleared" by the time we read it.
        const cleared = readGoalState(directory);
        if (cleared) fireWebhook(cleared, "active");
        await notify(sessionId, "Goal stopped", constraintResult.reason, "warning");
        return;
      }

      const latest = await getLatestAssistantText(sessionId);
      const blockedText = detectMarker(latest, BLOCKED_RE);
      if (blockedText !== null) {
        const fresh = (() => {
          const f = readGoalState(directory);
          if (!f || f.status !== "active" || f.id !== state.id) return null;
          recordEvaluation(f, { met: false, blocked: true, reason: `Agent reported blocked: ${sanitizeForPrompt(blockedText).slice(0, 200) || "(no detail)"}`, confidence: 0.8, timestamp: now, evaluatorType: "heuristic" });
          // v0.7.0 (A4) — record a timeline event for the blocked-by-marker
          // path so the Live Session pane shows the user "turn N: blocked".
          recordTimelineFor(f, f.lastEvaluation!, "blocked-marker");
          f.status = "paused";
          f.pausedAt = now;
          writeGoalStateAtomic(directory, f);
          return f;
        })();
        if (!fresh) return;
        // v0.4.0+ webhook: fire on the active → paused transition
        // (spec call site: "Goal blocked"). The state file is
        // already at "paused" by the time we read it (the IIBE above
        // persisted it), so the webhook's `on` filter looks for
        // "paused" and `previousStatus` is "active" — the spec
        // interpretation of the blocked transition.
        fireWebhook(fresh, "active");
        await notify(sessionId, "Goal paused (blocked)", fresh.lastEvaluation!.reason, "warning");
        return;
      }

      const evaluation = await evaluateGoal(state, latest);

      const snapshot = (() => {
        const f = readGoalState(directory);
        if (!f || f.status !== "active" || f.id !== state.id) return null;
        recordEvaluation(f, evaluation);

        if (evaluation.met) {
          f.status = "achieved";
          f.completedAt = Date.now();
          // v0.7.0 (A4) — record a timeline event for the met path so
          // the Live Session pane shows the user "turn N: met" before
          // the archive hook fires. Label includes the evaluator type
          // for context (deterministic / heuristic / model).
          recordTimelineFor(f, evaluation, `met-${evaluation.evaluatorType}`);
          writeGoalStateAtomic(directory, f);
          // v0.5.0 (F-3) — archive the achieved outcome. Best-effort:
          // a full disk or permission failure here must not block the
          // goal transition (the archive is a bonus, not the contract).
          appendGoalArchive(directory, f, "achieved");
          return { achieved: true as const, reason: evaluation.reason };
        }

        writeGoalStateAtomic(directory, f);
        // v0.7.0 (A4) — record a timeline event for the in-progress
        // (not-met) path so the Live Session pane shows the user the
        // most recent turn's outcome.
        recordTimelineFor(f, evaluation, `step-${evaluation.evaluatorType}`);
        return {
          achieved: false as const,
          condition: f.condition,
          steering: Array.isArray(f.metadata.steering) ? [...f.metadata.steering] : [],
        };
      })();

      if (!snapshot) return;
      if (snapshot.achieved) {
        // v0.4.0: fire webhook BEFORE chain advancement (captures "achieved" not "new step active")
        const achievedState = readGoalState(directory);
        if (achievedState) fireWebhook(achievedState, "active");
        await notify(sessionId, "Goal achieved", snapshot.reason, "success");
        // v0.4.0: auto-advance chain if the achieved goal is part of one
        const chainResult = advanceGoalChain(directory);
        if (chainResult.ok && chainResult.message) {
          await notify(sessionId, "Chain advanced", chainResult.message, "success");
        }
        if (chainResult.completed) {
          await notify(sessionId, "Chain completed", chainResult.message!, "success");
        }
        return;
      }

      // Build the continue-prompt. The base text is the "not yet met" nudge;
      // if the user has appended steering notes via /goal steer (or the
      // sidebar dial), include the most recent one as a "user hint" — this
      // is the channel for "next time, try X" without changing the goal
      // itself. The agent sees the hint on the next nudge only.
      //
      // SECURITY: route evaluation.reason and the steering note through
      // sanitizeForPrompt. The state file is user-controlled and the prior
      // version of the loop interpolated these values verbatim — a planted
      // `evaluation.reason` with embedded GOAL_COMPLETE: would trip the
      // marker detector (the v0.1.0 prompt-injection class). The
      // sanitizer drops C0/C1/Unicode-format chars (see goal-state.ts).
      //
      // LENGTH CAP: cap the condition at 500 chars, matching the compaction
      // cap below. A 4000-char condition (MAX_CONDITION_LEN) is allowed
      // in storage but would burn ~1000 tokens of context per nudge. The
      // agent still has the full condition in the state file; the cap is
      // a presentation choice. (v0.3.0 hardening, F15.)
      const lastSteer = snapshot.steering.length > 0 ? snapshot.steering[snapshot.steering.length - 1] : null;
      const safeReason = sanitizeForPrompt(evaluation.reason ?? "").slice(0, 200);
      const safeSteer = lastSteer ? sanitizeForPrompt(lastSteer.note ?? "").slice(0, 200) : "";
      const safeConditionForNudge = sanitizeForPrompt(snapshot.condition).slice(0, 500);
      const steerSuffix = safeSteer
        ? `\nUser hint (most recent): ${safeSteer}`
        : "";
      await client.session
        .prompt({
          path: { id: sessionId },
          body: {
            parts: [
              {
                type: "text",
                text:
                  `[GOAL] Not yet met (${safeReason}). Keep working toward: ${safeConditionForNudge}\n` +
                  `When satisfied, write a line beginning "GOAL_COMPLETE:" with the evidence. ` +
                  `If truly blocked, write a line beginning "GOAL_BLOCKED:" explaining why.` +
                  steerSuffix,
              },
            ],
          },
        })
        .catch((err) => log("error", "Failed to inject continue prompt", { error: String(err) }));
    } catch (err) {
      log("error", "Evaluation loop failed", { error: String(err) });
    } finally {
      isEvaluating = false;
    }
  }

  return {
    // ── Conversational tools ─────────────────────────────────────────────────
    // These let the user manage goals by just TALKING to OpenCode ("keep going
    // until the tests pass", "what's my goal?", "stop the goal") — no /goal
    // syntax. The agent picks the right tool from these descriptions. `tool.schema`
    // is the host's own zod instance, so no separate dependency is needed.
    tool: {
      set_goal: tool({
        description:
          "Set a persistent goal that you must keep working toward until it is met — even across multiple turns. " +
          "Call this whenever the user expresses an ongoing objective: \"keep going until X\", \"don't stop until Y\", " +
          "\"work until the tests pass\", \"loop until the build is green\", or similar. " +
          "Prefer a `command` when success is checkable by a shell command (it's verified deterministically, exit 0 = done).",
        args: {
          condition: tool.schema.string().describe("The success condition in plain language, e.g. 'all unit tests pass'."),
          command: tool.schema
            .string()
            .optional()
            .describe("Optional shell command that exits 0 exactly when the goal is met, e.g. 'npm test'. Strongly preferred when one exists."),
          maxTurns: tool.schema.number().int().positive().optional().describe("Stop after this many evaluation turns (default 20)."),
          maxMinutes: tool.schema.number().int().positive().optional().describe("Stop after this many minutes (default 30)."),
          verification: tool.schema.object({}).optional()
            .describe("v0.4.0+ — how to verify the goal. Prefer over 'command'. Shape: {type:'shell'|'http'|'file'|'marker', ...}."),
        },
        async execute(args, ctx) {
          const res = setGoalFields(ctx.directory, {
            condition: args.condition,
            command: args.command ?? null,
            verification: (args.verification ?? null) as Verification | null,
            maxTurns: args.maxTurns,
            maxMinutes: args.maxMinutes,
          });
          // C-1 fix: the failure branch's `error` is preserved. The
          // message prefixes the typed `reason` for the agent's surface
          // — the agent sees "invalid-value: ..." vs "write-failed: ..."
          // and can pick the right user-facing wording.
          if (!res.ok) {
            return `Could not set the goal (${res.reason}): ${res.error}`;
          }
          // v0.4.0+ webhook: fire on the null → active transition.
          // (Spec call site: "Goal set".) We read the state again
          // because the freshly-set one is the one with status="active".
          const fresh = readGoalState(ctx.directory);
          if (fresh) fireWebhook(fresh, null);
          // OK branch: `state` and `replaced` are always present (no
          // non-null assertion needed; discriminated union narrows it).
          return goalInstructions(res.state, res.replaced);
        },
      }),

      goal_status: tool({
        description: "Report the current goal and its progress (condition, status, turns/time used, verification command). Use when the user asks 'what's my goal?', 'how's it going?', or 'is there an active goal?'.",
        args: {},
        async execute(_args, ctx) {
          const statusText = plainStatus(ctx.directory);
          const state = readGoalState(ctx.directory);
          if (state) emitBlocks(ctx, buildGoalStatusBlocks(state));
          return statusText;
        },
      }),

      clear_goal: tool({
        description: "Clear/stop the active goal so OpenCode stops working toward it. Use when the user says 'stop the goal', 'cancel it', 'we're done with that goal', or 'clear the goal'.",
        args: {},
        async execute(_args, ctx) {
          // Capture the pre-transition status so the webhook payload
          // can carry the correct `previousStatus` (spec: "active/paused
          // → cleared"). After the transition the state file already
          // shows status="cleared" and we'd lose the source state.
          const before = readGoalState(ctx.directory);
          const previousStatus = before ? before.status : null;
          const res = transitionGoal(ctx.directory, "clear");
          if (!res.ok) return res.error!;
          // v0.4.0+ webhook: fire on the active/paused → cleared
          // transition. (Spec call site: "Goal cleared".)
          const fresh = readGoalState(ctx.directory);
          if (fresh) {
            fireWebhook(fresh, previousStatus);
            emitBlocks(ctx, buildGoalTransitionBlocks(fresh, "clear"));
          }
          return res.message!;
        },
      }),

      pause_goal: tool({
        description: "Pause the active goal (the auto-loop stops nudging) without discarding it, so unrelated work can happen. Use for 'pause the goal' / 'hold off on the goal for a sec'.",
        args: {},
        async execute(_args, ctx) {
          // Capture the pre-transition status so the webhook payload
          // can carry the correct `previousStatus`. transitionGoal
          // only fires for the active → paused transition; for the
          // no-op "already paused" case we never reach the webhook.
          const before = readGoalState(ctx.directory);
          const previousStatus = before ? before.status : null;
          const res = transitionGoal(ctx.directory, "pause");
          if (!res.ok) return res.error!;
          // v0.4.0+ webhook: fire on the active → paused transition.
          // (Spec call site: "Goal paused".)
          const fresh = readGoalState(ctx.directory);
          if (fresh && previousStatus !== "paused") fireWebhook(fresh, previousStatus);
          if (fresh) emitBlocks(ctx, buildGoalTransitionBlocks(fresh, "pause"));
          return res.message!;
        },
      }),

      resume_goal: tool({
        description: "Resume a paused goal and continue working toward it. Use for 'resume the goal' / 'back to the goal'.",
        args: {},
        async execute(_args, ctx) {
          // Capture the pre-transition status so the webhook payload
          // can carry the correct `previousStatus` (paused → active).
          const before = readGoalState(ctx.directory);
          const previousStatus = before ? before.status : null;
          const res = transitionGoal(ctx.directory, "resume");
          if (!res.ok) return res.error!;
          // v0.4.0+ webhook: fire on the paused → active transition.
          // (Spec call site: "Goal resumed".) Only fires when the
          // transition actually moved (not the already-active no-op).
          const fresh = readGoalState(ctx.directory);
          if (fresh && previousStatus === "paused") fireWebhook(fresh, previousStatus);
          if (fresh) emitBlocks(ctx, buildGoalTransitionBlocks(fresh, "resume"));
          return fresh ? `Goal resumed. Continue working toward: ${fresh.condition}` : res.message!;
        },
      }),

      // v0.3.0 — GUI-ready data contract. Returns the current goal state as
      // a JSON string (or the literal "null" if no state file). GUI
      // consumers (e.g. the OpenCode Desktop Goals tab) call this on
      // mount and poll on a timer; the contract is a stable shape they
      // can render against. See docs/gui-integration.md for the full
      // schema. The tool returns a JSON string (not a parsed object)
      // because the OpenCode tool API expects a string return; the
      // GUI does a JSON.parse on the result.
      goal_get_state: tool({
        description: "Read the current goal state (or null if no goal is set). Returns a JSON string. The shape is documented in docs/gui-integration.md. GUI consumers call this on mount and poll on a timer (e.g. every 2s); the OpenCode plugin has no event-emit API for live updates, so polling is the real-time mechanism.",
        args: {},
        async execute(_args, ctx) {
          // v0.4.2 — thread the corrupt signal instead of collapsing it to
          // "null" (which told the GUI "no goal" when the truth was "your
          // state file was destroyed and quarantined"). The corrupt payload
          // is an object that fails validateGoalState, which the documented
          // consumer contract already handles: "if the validator returns
          // false, treat the state as corrupt" (docs/gui-integration.md).
          // Corrupt-unaware consumers therefore degrade exactly as before.
          const result = readGoalStateResult(ctx.directory);
          if (result.kind === "absent") return "null";
          if (result.kind === "corrupt") {
            return JSON.stringify({ $corrupt: { reason: result.reason, quarantined: listCorruptArtifacts(ctx.directory)[0] ?? null } });
          }
          const state = result.value;
          // Sanitize all user-controlled string fields before returning to GUI
          // consumers. The state file content is user-controlled and may contain
          // bidi overrides, control chars, or other Unicode format characters
          // that a GUI renderer might interpret unsafely.
          const safe = {
            ...state,
            condition: sanitizeForPrompt(state.condition),
            command: typeof state.command === "string" ? sanitizeForPrompt(state.command) : state.command,
            lastEvaluation: state.lastEvaluation
              ? { ...state.lastEvaluation, reason: sanitizeForPrompt(state.lastEvaluation.reason ?? "") }
              : null,
            evaluationHistory: (state.evaluationHistory || []).map((e) => ({
              ...e,
              reason: sanitizeForPrompt(e.reason ?? ""),
            })),
            metadata: {
              ...state.metadata,
              steering: Array.isArray(state.metadata?.steering)
                ? state.metadata.steering.map((s: { at: number; note: string }) => ({
                    at: s.at,
                    note: sanitizeForPrompt(s.note ?? ""),
                  }))
                : state.metadata?.steering,
            },
            blocks: buildGoalStatusBlocks(state),
          };
          return JSON.stringify(safe);
        },
      }),

      // ── v0.2.0+ Dial tools ─────────────────────────────────────────────
      // The 9 goal_* dial tools let external surfaces (GUI, sidebar, CLI)
      // mutate goal state by invoking them as tools. Each is a thin wrapper
      // around the corresponding goal-state primitive. All return strings
      // suitable for displaying in a toast. See docs/gui-integration.md.

      goal_turns: tool({
        description: "Set the max turns for the current goal. n must be an integer in [1, 10000].",
        args: {
          n: tool.schema.number().int().positive().describe("Max turns (1-10000)."),
        },
        async execute(args, ctx) {
          const res = editMaxTurns(ctx.directory, args.n);
          if (res.ok) return res.message;
          if (res.reason === "no-goal") return "No active goal.";
          if (res.reason === "terminal-state") return res.error ?? "Goal is in a terminal state.";
          return res.error ?? "Failed to update max turns.";
        },
      }),

      goal_time: tool({
        description: "Set the max time in minutes for the current goal. n must be an integer in [1, 10000].",
        args: {
          n: tool.schema.number().int().positive().describe("Max time in minutes (1-10000)."),
        },
        async execute(args, ctx) {
          const res = editMaxTime(ctx.directory, args.n);
          if (res.ok) return res.message;
          if (res.reason === "no-goal") return "No active goal.";
          if (res.reason === "terminal-state") return res.error ?? "Goal is in a terminal state.";
          return res.error ?? "Failed to update max time.";
        },
      }),

      goal_tokens: tool({
        description: "Set the max tokens for the current goal. n must be an integer in [1, 10000000].",
        args: {
          n: tool.schema.number().int().positive().describe("Max tokens (1-10000000)."),
        },
        async execute(args, ctx) {
          const res = editMaxTokens(ctx.directory, args.n);
          if (res.ok) return res.message;
          if (res.reason === "no-goal") return "No active goal.";
          if (res.reason === "terminal-state") return res.error ?? "Goal is in a terminal state.";
          return res.error ?? "Failed to update max tokens.";
        },
      }),

      goal_condition: tool({
        description: "Replace the current goal condition with new text.",
        args: {
          text: tool.schema.string().describe("The new goal condition text."),
        },
        async execute(args, ctx) {
          const res = editCondition(ctx.directory, args.text);
          if (res.ok) return res.message;
          if (res.reason === "no-goal") return "No active goal.";
          if (res.reason === "terminal-state") return res.error ?? "Goal is in a terminal state.";
          return res.error ?? "Failed to update condition.";
        },
      }),

      goal_steer: tool({
        description: "Append a steering note (hint) for the agent on the next auto-loop nudge. Notes are append-only, capped at 20, each up to 500 chars.",
        args: {
          text: tool.schema.string().describe("Steering hint text for the agent."),
        },
        async execute(args, ctx) {
          const res = appendSteering(ctx.directory, args.text);
          if (res.ok) return res.message;
          if (res.reason === "no-goal") return "No active goal.";
          if (res.reason === "terminal-state") return res.error ?? "Goal is in a terminal state.";
          return res.error ?? "Failed to add steering note.";
        },
      }),

      goal_clear_steering: tool({
        description: "Clear all steering notes from the current goal.",
        args: {},
        async execute(_args, ctx) {
          const res = clearSteering(ctx.directory);
          if (res.ok) return res.message;
          if (res.reason === "no-goal") return "No active goal.";
          return res.error ?? "Failed to clear steering notes.";
        },
      }),

      goal_restart: tool({
        description: "Restart the current goal with the same condition and constraints but fresh counters and a new id.",
        args: {},
        async execute(_args, ctx) {
          // Capture the pre-transition status so the webhook payload
          // can carry the correct `previousStatus` (any → active).
          const before = readGoalState(ctx.directory);
          const previousStatus = before ? before.status : null;
          const res = restartGoal(ctx.directory);
          if (!res.ok) {
            if (res.reason === "no-goal") return "No active goal to restart.";
            if (res.reason === "terminal-state") return res.error ?? "Goal is in a terminal state.";
            if (res.reason === "handoff-pending") return res.error ?? "A handoff is pending. Claim it first or delete the handoff file.";
            return res.error ?? "Failed to restart goal.";
          }
          // v0.4.0+ webhook: fire on the any → active transition.
          // (Spec call site: "Goal restarted".) sanitizeMetadata
          // preserves the webhook config across restartGoal so this
          // is the only webhook config that survives a restart — see
          // server-webhook.test.mjs "sanitizeMetadata preserves
          // webhook (restartGoal)".
          const fresh = readGoalState(ctx.directory);
          if (fresh) {
            fireWebhook(fresh, previousStatus);
            emitBlocks(ctx, buildGoalTransitionBlocks(fresh, "restart"));
          }
          return res.message;
        },
      }),

      goal_handoff: tool({
        description: "Write a handoff snapshot for a future session. Optionally attach a note.",
        args: {
          note: tool.schema.string().optional().describe("Optional note for the future session."),
        },
        async execute(args, ctx) {
          const res = createHandoff(ctx.directory, args.note);
          if (res.ok) return res.message;
          if (res.reason === "no-goal") return "No active goal to handoff.";
          if (res.reason === "terminal-state") return res.error ?? "Goal is in a terminal state.";
          if (res.reason === "handoff-exists") return res.error ?? "A handoff is already pending. Claim it first or delete the file.";
          return res.error ?? "Failed to create handoff.";
        },
      }),

      goal_claim: tool({
        description: "Claim a pending handoff and resume the goal. The handoff file is deleted after claiming.",
        args: {},
        async execute(_args, ctx) {
          const res = claimHandoff(ctx.directory);
          if (res.ok) return res.message;
          if (res.reason === "no-handoff") return "No handoff to claim.";
          if (res.reason === "current-goal") return res.error ?? "A goal is already active. Clear it before claiming the handoff.";
          return res.error ?? "Failed to claim handoff.";
        },
      }),

      // v0.4.0+ webhook
      goal_webhook: tool({
        description: "Set or clear a notification webhook URL. POSTs goal state changes to the URL when the status enters one of the configured states.",
        args: {
          url: tool.schema.string().optional().describe("Webhook URL (http/https). Omit or pass '-' to clear."),
          on: tool.schema.array(tool.schema.string()).optional().describe("Statuses that trigger the webhook, e.g. ['achieved','cleared']."),
          allowLocal: tool.schema.boolean().optional().describe("Allow localhost URLs (blocked by default)."),
        },
        async execute(args, ctx) {
          const state = readGoalState(ctx.directory);
          if (!state || (state.status !== "active" && state.status !== "paused")) {
            return "No active goal to configure webhook for.";
          }
          if (!args.url || args.url === "-") {
            // Clear: route through setChainWebhook if the goal is in a
            // chain (v0.4.0 D6 fix — the chain owns the webhook), else
            // clear directly from the state.
            if (state.metadata.chainId) {
              const clr = setChainWebhook(ctx.directory, null);
              if (!clr.ok) return `Failed to clear chain webhook: ${clr.error}`;
              return "Chain webhook cleared.";
            }
            delete state.metadata.webhook;
            writeGoalStateAtomic(ctx.directory, state);
            return "Webhook cleared.";
          }
          if (!/^https?:\/\//.test(args.url)) {
            return "Webhook URL must start with http:// or https://";
          }
          const on = (args.on || []).filter((s: string) => ["active","paused","achieved","cleared"].includes(s));
          if (on.length === 0) {
            return "At least one valid status must be specified in 'on' (active, paused, achieved, cleared).";
          }
          const newWh = { url: args.url, on: on as GoalStatus[], allowLocal: args.allowLocal === true };
          // v0.4.0 D6 fix: when the active goal is in a chain, route the
          // webhook update through setChainWebhook so the chain file is
          // the source of truth and the new config re-projects to the
          // current step's metadata. Otherwise (standalone goal), write
          // directly to the state as before.
          if (state.metadata.chainId) {
            const r = setChainWebhook(ctx.directory, newWh);
            if (!r.ok) return `Failed to set chain webhook: ${r.error}`;
            return `Chain webhook set: ${newWh.url} (on: ${on.join(",")})${newWh.allowLocal ? " [local allowed]" : ""}`;
          }
          state.metadata.webhook = newWh;
          writeGoalStateAtomic(ctx.directory, state);
          return `Webhook set: ${args.url} (on: ${on.join(",")})${args.allowLocal ? " [local allowed]" : ""}`;
        },
      }),
    },

    config: async (cfg: any) => {
      try {
        cfg.command ??= {};
        if (!cfg.command.goal) {
          cfg.command.goal = {
            template: COMMAND_TEMPLATE,
            description: "Set/view/clear/pause/resume a task goal; OpenCode keeps working until it's met.",
            agent: "build",
          };
        }
      } catch (err) {
        log("error", "config hook failed to register /goal command", { error: String(err) });
      }
    },

    "command.execute.before": async (input, output) => {
      if (input.command !== "goal") return;
      const text = dispatchGoalCommand(directory, input.arguments ?? "");
      // We hand the host an input-shaped text part; OpenCode fills id/sessionID/
      // messageID. The cast is deliberate (the hook's output.parts is typed as
      // the fully-resolved Part, but the host treats command.execute.before as
      // a rewrite hook that supplies just the content — see the smoke test in
      // the README). We APPEND rather than wholesale-replace so any preamble
      // parts the host put in (e.g. an icon or a slash-command descriptor) are
      // preserved. This is the one piece that can only be confirmed against a
      // live OpenCode — see the smoke test in the README.
      const part = { type: "text", text } as unknown as (typeof output.parts)[number];
      output.parts = [...output.parts, part];
    },

    // v0.7.0 (A3) — recordToolEvent. After every tool call, append a
    // tool-end event to `.opencode/.session-events.jsonl` for the
    // standalone TUI control center's Live Session pane. Best-effort:
    // a failure here is silently swallowed (recordToolEvent itself is
    // a thin wrapper over appendSessionEvent which catches).
    "tool.execute.after": async (input, output) => {
      recordToolEvent(directory, input, output);
    },

    event: async ({ event }) => {
      // The host invokes this for every SDK event. We dispatch on the
      // discriminated union type so a future SDK addition forces a compile
      // error here (the `default` is exhaustive-checked). The two events we
      // care about for the auto-loop:
      //
      //   - "permission.updated" → a tool wants to ask the user for permission;
      //     we add the permission id to the pending set so the session.idle
      //     handler skips evaluation. Otherwise nudging would orphan the
      //     request ("permission request not found" — the v0.1.0 bug).
      //   - "permission.replied" → the user answered; we remove the id from
      //     the pending set. If a reply never arrives (e.g. dialog left open),
      //     the entry auto-expires after 5 minutes (see permissions.ts).
      //   - "session.idle" → the auto-loop fires (below).
      //   - "session.error" → the session is in a fatal error state
      //     (e.g. ProviderAuthError, MessageOutputLengthError, ApiError).
      //     The auto-loop's session.idle handler won't fire from a dead
      //     session, so the goal would stay "active" forever with no
      //     user signal. We transition active → paused here, fire the
      //     webhook on that transition (best-effort), and surface a
      //     toast + session message via notify() so the user knows to
      //     look. (v0.4.1, defect B-3b.)
      switch (event.type) {
        case "permission.updated": {
          const { sessionID, id } = event.properties;
          pendingPermissions.add(sessionID, id);
          return;
        }
        case "permission.replied": {
          const { sessionID, permissionID } = event.properties;
          pendingPermissions.remove(sessionID, permissionID);
          return;
        }
        case "session.idle": {
          const sessionId = event.properties.sessionID;
          if (!sessionId) return;
          if (pendingPermissions.has(sessionId)) {
            log("debug", "skipping evaluation: permission request pending", { sessionId });
            return;
          }
          const state = readGoalState(directory);
          if (!state || state.status !== "active") return;
          await evaluate(state, sessionId);
          return;
        }
        case "session.error": {
          const sessionId = event.properties.sessionID;
          if (!sessionId) return;
          const current = readGoalState(directory);
          if (!current || current.status !== "active") return;
          // Build a human-readable reason. The SDK's `error` is a
          // discriminated union (ProviderAuthError | UnknownError |
          // MessageOutputLengthError | MessageAbortedError | ApiError);
          // each variant has a `name` field, and most carry a
          // `data.message`. We route the string through sanitizeForPrompt
          // because the error text originates from the agent runtime and
          // could contain format chars / bidi overrides (same class as
          // the BLOCKED_RE reason path on line 357). Truncate to 200
          // chars to match the notify() patterns elsewhere.
          const errInfo: any = event.properties.error;
          let errText: string;
          if (errInfo && typeof errInfo === "object" && typeof errInfo.name === "string") {
            const msg = errInfo.data && typeof errInfo.data.message === "string" ? errInfo.data.message : "";
            errText = msg ? `${errInfo.name}: ${msg}` : errInfo.name;
          } else {
            errText = "unknown session error";
          }
          errText = sanitizeForPrompt(errText).slice(0, 200);
          const reason = `Session error: ${errText || "unknown session error"}`;
          // transitionGoal is the only path that flips status to
          // "paused" (see the pause_goal tool at line 551). It returns
          // ok:false on no-op / already-in-state; we capture the result
          // so we don't double-notify if two error events arrive in
          // quick succession. After a successful pause we post-hoc
          // patch `lastEvaluation.reason` so the webhook payload's
          // `lastReason` field reflects the error (matches the blocked
          // transition's IIFE pattern, but routed through transitionGoal
          // per the B-3b fix spec).
          const res = transitionGoal(directory, "pause");
          if (!res.ok) return;
          const fresh = readGoalState(directory);
          if (fresh) {
            fresh.lastEvaluation = {
              met: false,
              blocked: true,
              reason,
              confidence: 1.0,
              timestamp: Date.now(),
              evaluatorType: "deterministic",
            };
            writeGoalStateAtomic(directory, fresh);
            // v0.4.0+ webhook: fire on the active → paused transition.
            // The `on` filter looks for "paused" and `previousStatus`
            // is "active" (the only path that reaches here). Fire-and-
            // forget; we don't await.
            fireWebhook(fresh, "active");
          }
          await notify(sessionId, "Session error — goal paused", reason, "error");
          return;
        }
        // All other event types are intentionally unhandled. The `default`
        // case is a defensive no-op so a future SDK event (one not in the
        // TypeScript discriminated union at compile time) cannot crash
        // the plugin at runtime. The compile-time exhaustiveness check
        // would catch a NEW event type that the SDK adds to its *type*
        // union, but the runtime event stream is a separate concern — an
        // SDK release could add a new event type without a corresponding
        // type update, and the plugin would silently no-op. The `default`
        // branch here is what makes that safe. (v0.3.0 hardening, F16.)
        default:
          return;
      }
    },

    "experimental.session.compacting": async (_input, output) => {
      const state = readGoalState(directory);
      if (!state || (state.status !== "active" && state.status !== "paused")) return;
      const steering = Array.isArray(state.metadata.steering) ? state.metadata.steering : [];
      const lastSteer = steering.length > 0 ? steering[steering.length - 1] : null;
      // SECURITY: route the condition + steering note through
      // sanitizeForPrompt. The state file is user-controlled; the
      // compacting context is injected back into the agent on every
      // compaction and is a prompt-injection surface if any field
      // contains a marker, bidi override, or other format char.
      const safeCondition = sanitizeForPrompt(state.condition).slice(0, 500);
      const safeSteer = lastSteer ? sanitizeForPrompt(lastSteer.note ?? "").slice(0, 240) : "";
      const steerLine = safeSteer
        ? `Latest user hint: ${safeSteer}\n`
        : "";
      output.context.push(
        `\n## ACTIVE GOAL\nCondition: ${safeCondition}\nStatus: ${state.status}\n` +
        `Progress: ${state.turnsEvaluated}/${state.constraints.maxTurns} turns\n` +
        steerLine
      );
    },
  };
};

const plugin: PluginModule = { id: "goal", server };
export default plugin;
