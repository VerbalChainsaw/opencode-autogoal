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
