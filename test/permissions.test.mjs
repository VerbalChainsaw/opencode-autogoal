/**
 * Tests for PendingPermissions — the guard that stops the loop from nudging
 * while a tool-permission request is open (the "permission request not found" bug).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PendingPermissions, classifyPermissionEvent } from "../dist/permissions.js";

test("no permissions → not pending", () => {
  const p = new PendingPermissions();
  assert.equal(p.has("s1"), false);
  assert.equal(p.count("s1"), 0);
});

test("add marks the session pending; remove clears it", () => {
  const p = new PendingPermissions();
  p.add("s1", "perm-a");
  assert.equal(p.has("s1"), true);
  assert.equal(p.count("s1"), 1);
  p.remove("s1", "perm-a");
  assert.equal(p.has("s1"), false);
});

test("multiple permissions in one session; cleared only when all resolved", () => {
  const p = new PendingPermissions();
  p.add("s1", "a");
  p.add("s1", "b");
  assert.equal(p.count("s1"), 2);
  p.remove("s1", "a");
  assert.equal(p.has("s1"), true); // b still open
  p.remove("s1", "b");
  assert.equal(p.has("s1"), false);
});

test("sessions are independent", () => {
  const p = new PendingPermissions();
  p.add("s1", "a");
  assert.equal(p.has("s1"), true);
  assert.equal(p.has("s2"), false);
});

test("duplicate add is idempotent; removing unknown is a no-op", () => {
  const p = new PendingPermissions();
  p.add("s1", "a");
  p.add("s1", "a");
  assert.equal(p.count("s1"), 1);
  p.remove("s1", "ghost"); // not tracked
  assert.equal(p.has("s1"), true);
  p.remove("nope", "a"); // unknown session
  assert.equal(p.has("s1"), true);
});

test("ignores empty ids", () => {
  const p = new PendingPermissions();
  p.add("", "a");
  p.add("s1", "");
  assert.equal(p.has("s1"), false);
});

// ── classifyPermissionEvent — tolerant of OpenCode v1/v2 event-name drift ──
//
// REGRESSION (the "permission request not found" orphan on the v2 Desktop
// host): the host renamed the permission events between OpenCode versions —
//   ask:    v1 "permission.updated"  → v2 "permission.v2.asked"
//   replied:v1 "permission.replied"  → v2 "permission.v2.replied"
// and the reply payload field permissionID → requestID. The plugin matched
// only the v1 names, so its pending-permission guard went blind on the v2
// host: the loop nudged while a permission was open, the nudge aborted the
// turn, and the abort evicted the permission → "permission request not found".
// The classifier must recognize BOTH taxonomies so the guard works on either
// host version.

test("classify: v1 permission.updated → add", () => {
  assert.deepEqual(
    classifyPermissionEvent({ type: "permission.updated", properties: { sessionID: "s1", id: "per_1" } }),
    { kind: "add", sessionID: "s1", permissionID: "per_1" },
  );
});

test("classify: v2 permission.v2.asked → add (renamed host event)", () => {
  assert.deepEqual(
    classifyPermissionEvent({ type: "permission.v2.asked", properties: { sessionID: "s1", id: "per_1" } }),
    { kind: "add", sessionID: "s1", permissionID: "per_1" },
  );
});

// REGRESSION (opencode v1.17.x desktop host): the host emits "permission.asked"
// — NOT "permission.updated" nor "permission.v2.asked". The classifier matched
// only the older two names, so the guard went blind on v1.17: the loop nudged
// while a tool-permission dialog was open, the nudge aborted the turn, the host
// evicted the request, and the user's "Allow" hit a missing request
// ("Permission request not found: per_…"). The classifier must recognize the
// live host event name.
test("classify: v1.17 permission.asked → add (REGRESSION: live host event that went blind)", () => {
  assert.deepEqual(
    classifyPermissionEvent({ type: "permission.asked", properties: { sessionID: "s1", id: "per_ec73" } }),
    { kind: "add", sessionID: "s1", permissionID: "per_ec73" },
  );
});

test("classify: permission.asked tolerates a requestID id field", () => {
  assert.deepEqual(
    classifyPermissionEvent({ type: "permission.asked", properties: { sessionID: "s1", requestID: "per_ec73" } }),
    { kind: "add", sessionID: "s1", permissionID: "per_ec73" },
  );
});

test("classify: v1 permission.replied → remove (permissionID field)", () => {
  assert.deepEqual(
    classifyPermissionEvent({ type: "permission.replied", properties: { sessionID: "s1", permissionID: "per_1" } }),
    { kind: "remove", sessionID: "s1", permissionID: "per_1" },
  );
});

test("classify: v2 permission.v2.replied → remove (requestID field drift)", () => {
  assert.deepEqual(
    classifyPermissionEvent({ type: "permission.v2.replied", properties: { sessionID: "s1", requestID: "per_1" } }),
    { kind: "remove", sessionID: "s1", permissionID: "per_1" },
  );
});

test("classify: unrelated / malformed events → null", () => {
  assert.equal(classifyPermissionEvent({ type: "session.idle", properties: { sessionID: "s1" } }), null);
  assert.equal(classifyPermissionEvent(null), null);
  assert.equal(classifyPermissionEvent(undefined), null);
  assert.equal(classifyPermissionEvent({}), null);
  assert.equal(classifyPermissionEvent({ type: 42 }), null);
  assert.equal(classifyPermissionEvent({ type: "permission.v2.asked" }), null); // no properties
});

test("classify: missing ids degrade to empty strings (PendingPermissions then ignores them)", () => {
  // A malformed ask with no id must not crash; the empty permissionID is
  // dropped by PendingPermissions.add (see "ignores empty ids" above).
  const r = classifyPermissionEvent({ type: "permission.v2.asked", properties: { sessionID: "s1" } });
  assert.deepEqual(r, { kind: "add", sessionID: "s1", permissionID: "" });
  const p = new PendingPermissions();
  p.add(r.sessionID, r.permissionID);
  assert.equal(p.has("s1"), false);
});

test("classify + PendingPermissions: v2 ask then reply round-trips the guard", () => {
  const p = new PendingPermissions();
  const ask = classifyPermissionEvent({ type: "permission.v2.asked", properties: { sessionID: "s1", id: "per_x" } });
  p.add(ask.sessionID, ask.permissionID);
  assert.equal(p.has("s1"), true); // guard now blocks the nudge
  const rep = classifyPermissionEvent({ type: "permission.v2.replied", properties: { sessionID: "s1", requestID: "per_x" } });
  p.remove(rep.sessionID, rep.permissionID);
  assert.equal(p.has("s1"), false); // guard releases after the reply
});

test("classify + PendingPermissions: v1.17 host ask/reply round-trips the guard (the live bug)", () => {
  // The exact event pair the v1.17 desktop host emits: permission.asked (id)
  // then permission.replied (requestID). This is the round-trip that was broken.
  const p = new PendingPermissions();
  const ask = classifyPermissionEvent({ type: "permission.asked", properties: { sessionID: "s1", id: "per_ec73" } });
  p.add(ask.sessionID, ask.permissionID);
  assert.equal(p.has("s1"), true); // guard blocks the nudge while the dialog is open
  const rep = classifyPermissionEvent({ type: "permission.replied", properties: { sessionID: "s1", requestID: "per_ec73" } });
  p.remove(rep.sessionID, rep.permissionID);
  assert.equal(p.has("s1"), false); // guard releases after the user answers
});
