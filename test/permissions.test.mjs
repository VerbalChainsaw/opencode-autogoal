/**
 * Tests for PendingPermissions — the guard that stops the loop from nudging
 * while a tool-permission request is open (the "permission request not found" bug).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PendingPermissions } from "../dist/permissions.js";

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
