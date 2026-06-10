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
 * `permission.replied` (answered). If a reply never arrives (session abandoned),
 * the session stays "blocked" and the loop simply pauses for it — which fails
 * SAFE (a stalled goal is harmless; an orphaned permission is not).
 */
export class PendingPermissions {
  private readonly bySession = new Map<string, Set<string>>();

  /** Record a permission request as open. */
  add(sessionID: string, permissionID: string): void {
    if (!sessionID || !permissionID) return;
    let set = this.bySession.get(sessionID);
    if (!set) {
      set = new Set<string>();
      this.bySession.set(sessionID, set);
    }
    set.add(permissionID);
  }

  /** Mark a permission request resolved. */
  remove(sessionID: string, permissionID: string): void {
    const set = this.bySession.get(sessionID);
    if (!set) return;
    set.delete(permissionID);
    if (set.size === 0) this.bySession.delete(sessionID);
  }

  /** True if the session has at least one unresolved permission request. */
  has(sessionID: string): boolean {
    return (this.bySession.get(sessionID)?.size ?? 0) > 0;
  }

  /** Total open requests for a session (for diagnostics). */
  count(sessionID: string): number {
    return this.bySession.get(sessionID)?.size ?? 0;
  }
}
