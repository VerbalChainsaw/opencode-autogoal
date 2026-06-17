/**
 * Tracks open (pending) permission requests per session.
 *
 * WHY: the auto-loop injects a "continue" prompt when a session goes idle. But a
 * session can go idle *while waiting for the user to approve a tool permission*.
 * Injecting a prompt then starts a new turn and orphans the pending request —
 * the symptom is OpenCode reporting "permission request not found". The loop must
 * therefore skip nudging while any permission is open for that session.
 *
 * A permission is open between `permission.updated` (asked) and
 * `permission.replied` (answered). If a reply never arrives (e.g. the user
 * leaves the security dialog open and walks away), the permission auto-expires
 * after PENDING_TIMEOUT_MS (default 5 minutes). Once all permissions for a
 * session have expired, the loop resumes normally — a stalled goal is worse
 * than a guarded nudge.
 */
export class PendingPermissions {
  /** Auto-expire permission entries older than this (ms). */
  private static readonly PENDING_TIMEOUT_MS = 5 * 60_000; // 5 minutes

  /** Map of sessionID → Map<permissionID, timestampMs> */
  private readonly bySession = new Map<string, Map<string, number>>();

  /** Record a permission request as open. */
  add(sessionID: string, permissionID: string): void {
    if (!sessionID || !permissionID) return;
    let map = this.bySession.get(sessionID);
    if (!map) {
      map = new Map<string, number>();
      this.bySession.set(sessionID, map);
    }
    map.set(permissionID, Date.now());
  }

  /** Mark a permission request resolved. */
  remove(sessionID: string, permissionID: string): void {
    const map = this.bySession.get(sessionID);
    if (!map) return;
    map.delete(permissionID);
    if (map.size === 0) this.bySession.delete(sessionID);
  }

  /**
   * True if the session has at least one unresolved permission request
   * that hasn't expired. Auto-prunes expired entries on every call so
   * a stale permission dialog can't permanently block the auto-loop.
   */
  has(sessionID: string, now: number = Date.now()): boolean {
    const map = this.bySession.get(sessionID);
    if (!map || map.size === 0) return false;
    // Prune expired entries
    for (const [id, ts] of map) {
      if (now - ts > PendingPermissions.PENDING_TIMEOUT_MS) {
        map.delete(id);
      }
    }
    // If all entries expired, clean up the session entirely
    if (map.size === 0) {
      this.bySession.delete(sessionID);
    }
    return map.size > 0;
  }

  /** Total open requests for a session (for diagnostics). */
  count(sessionID: string): number {
    return this.bySession.get(sessionID)?.size ?? 0;
  }
}

/** The action a host event maps to for the pending-permission guard. */
export type PermissionEventAction =
  | { kind: "add"; sessionID: string; permissionID: string }
  | { kind: "remove"; sessionID: string; permissionID: string }
  | null;

/**
 * Extract the permission ID from event properties, using a consistent
 * field-resolution order shared by BOTH the ask and reply paths.
 *
 * Field priority (matches the OpenCode SDK v1 + v2 type definitions):
 *   1. `id`          — v1/v2 ask events (PermissionV1.Request, PermissionV2.Request)
 *   2. `requestID`   — v1/v2 reply events (PermissionV1.ReplyInput, PermissionV2.ReplyInput)
 *   3. `permissionID`— legacy fallback (not in current SDK types; kept for
 *                      backward compat with any host version that uses it)
 *
 * Previously the ask and reply paths had DIVERGENT priority orders (ask
 * checked `id` → `requestID`, reply checked `permissionID` → `requestID`).
 * If a future host version added a `permissionID` field with a different
 * value than `requestID`, the remove path would silently fail to match the
 * add path, the Map would accumulate ghost entries, and the auto-loop would
 * be permanently blocked ("projecting it over and over").
 */
function getPermissionId(props: Record<string, unknown>): string {
  if (typeof props.id === "string") return props.id;
  if (typeof props.requestID === "string") return props.requestID;
  if (typeof props.permissionID === "string") return props.permissionID;
  return "";
}

/**
 * Classify a host event into a pending-permission guard action, tolerant of
 * the OpenCode permission event-name drift ACROSS HOST VERSIONS.
 *
 * The plugin runs inside whichever OpenCode build loads it, and the host's
 * event taxonomy changed between versions:
 *
 *   ask (open):  v1 "permission.updated"  | v2 "permission.v2.asked"
 *   replied:     v1 "permission.replied"  | v2 "permission.v2.replied"
 *
 * Field drift, too: both ask payloads carry `id` + `sessionID`, but the reply
 * payload's request id is `requestID` in both v1 and v2.
 *
 * WHY THIS EXISTS: matching only the v1 names made the guard go BLIND on a v2
 * host — `PendingPermissions` never saw a request, so the auto-loop nudged
 * while a tool permission was open. The nudge (`session.prompt`) aborts the
 * in-flight turn, and the host evicts the pending permission on that abort, so
 * the user's "Allow" hit a request that no longer existed ("permission request
 * not found"). Recognizing BOTH taxonomies restores the guard on either host.
 *
 * Pure + defensive: never throws on malformed input; missing ids degrade to
 * "" which `PendingPermissions.add`/`remove` already ignore. Returns null for
 * any event that is not a permission ask/reply.
 */
export function classifyPermissionEvent(event: unknown): PermissionEventAction {
  if (!event || typeof event !== "object") return null;
  const type = (event as { type?: unknown }).type;
  if (typeof type !== "string") return null;
  const props = (event as { properties?: unknown }).properties;
  if (!props || typeof props !== "object") return null;
  const p = props as Record<string, unknown>;
  const sessionID = typeof p.sessionID === "string" ? p.sessionID : "";

  switch (type) {
    case "permission.updated":
    case "permission.asked":
    case "permission.v2.asked": {
      const id = getPermissionId(p);
      return { kind: "add", sessionID, permissionID: id };
    }
    case "permission.replied":
    case "permission.v2.replied": {
      const id = getPermissionId(p);
      return { kind: "remove", sessionID, permissionID: id };
    }
    default: {
      // v0.7.x: log unrecognized permission events so we discover new
      // event names in production. The guard is silent by design — a
      // permission event we don't recognize is treated as a non-permission
      // event and falls through to the switch in the event handler.
      // But if the host adds a new permission event name (e.g.
      // "permission.v3.asked"), we want to know about it so we can add it.
      if (typeof type === "string" && type.startsWith("permission")) {
        // Best-effort: console.debug is harmless in production and
        // grep-able in development logs.
        try { console.debug(`[opencode-autogoal] unrecognized permission event type: ${type}`); } catch { /* ignore */ }
      }
      return null;
    }
  }
}
