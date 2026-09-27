import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createWake,
  getWake,
  listWakes,
  listPendingWakes,
  cancelWake,
  setWakeStatus,
  recordWakePoll,
  deleteWake,
  __resetWakeStoreForTests,
} from "./wake-store.ts";
import { WAKE_TERMINAL_RETENTION_MS, MAX_PENDING_WAKES_PER_SESSION } from "./wake-types.ts";

function freshDir() {
  __resetWakeStoreForTests();
  return mkdtempSync(join(tmpdir(), "omp-wakes-"));
}

function delayedFields(overrides = {}) {
  const now = Date.now();
  return { mode: "delayed", message: "wake up", fireAt: now + 10_000, createdAt: now, expiresAt: now + 60_000, ...overrides };
}

function guardedFields(overrides = {}) {
  const now = Date.now();
  return {
    mode: "guarded",
    message: "done",
    pollCommand: "test -f /tmp/x",
    intervalMs: 60_000,
    guardTimeoutMs: 5_000,
    createdAt: now,
    expiresAt: now + 60_000,
    ...overrides,
  };
}

test("createWake persists a pending wake at 0600 and returns it", () => {
  const dir = freshDir();
  const wake = createWake({ sessionId: "s1", cwd: "/tmp", sessionFile: "/tmp/s1.jsonl", fields: delayedFields() }, dir);
  assert.equal(wake.status, "pending");
  assert.equal(wake.sessionId, "s1");
  assert.equal(wake.mode, "delayed");
  assert.ok(wake.id);
  const mode = statSync(join(dir, "omp-web-wakes.json")).mode & 0o777;
  assert.equal(mode, 0o600);
  assert.deepEqual(getWake(wake.id, dir), wake);
});

test("listWakes filters by session; listPendingWakes returns only pending across sessions", () => {
  const dir = freshDir();
  const a = createWake({ sessionId: "s1", cwd: "/tmp", fields: delayedFields() }, dir);
  const b = createWake({ sessionId: "s2", cwd: "/tmp", fields: guardedFields() }, dir);
  assert.deepEqual(listWakes("s1", dir).map((w) => w.id), [a.id]);
  assert.equal(listPendingWakes(dir).length, 2);
  setWakeStatus(a.id, "fired", Date.now(), undefined, dir);
  assert.deepEqual(listPendingWakes(dir).map((w) => w.id), [b.id]);
});

test("cancelWake only cancels the caller's own pending wake", () => {
  const dir = freshDir();
  const wake = createWake({ sessionId: "s1", cwd: "/tmp", fields: delayedFields() }, dir);
  // Wrong owner: no-op.
  assert.equal(cancelWake(wake.id, "other", Date.now(), dir), undefined);
  assert.equal(getWake(wake.id, dir).status, "pending");
  // Correct owner: cancels.
  const cancelled = cancelWake(wake.id, "s1", Date.now(), dir);
  assert.equal(cancelled.status, "cancelled");
  // Already terminal: no-op.
  assert.equal(cancelWake(wake.id, "s1", Date.now(), dir), undefined);
});

test("setWakeStatus records resolvedAt and reason for terminal states", () => {
  const dir = freshDir();
  const wake = createWake({ sessionId: "s1", cwd: "/tmp", fields: delayedFields() }, dir);
  const now = 1_000;
  const updated = setWakeStatus(wake.id, "failed", now, "boom", dir);
  assert.equal(updated.status, "failed");
  assert.equal(updated.resolvedAt, now);
  assert.equal(updated.statusReason, "boom");
});

test("recordWakePoll updates lastPollAt", () => {
  const dir = freshDir();
  const wake = createWake({ sessionId: "s1", cwd: "/tmp", fields: guardedFields() }, dir);
  recordWakePoll(wake.id, 4242, dir);
  assert.equal(getWake(wake.id, dir).lastPollAt, 4242);
});

test("deleteWake removes a wake", () => {
  const dir = freshDir();
  const wake = createWake({ sessionId: "s1", cwd: "/tmp", fields: delayedFields() }, dir);
  assert.equal(deleteWake(wake.id, dir), true);
  assert.equal(getWake(wake.id, dir), undefined);
});

test("stale terminal wakes are pruned on reload; fresh ones survive", () => {
  const dir = freshDir();
  const stale = createWake({ sessionId: "s1", cwd: "/tmp", fields: delayedFields() }, dir);
  const fresh = createWake({ sessionId: "s1", cwd: "/tmp", fields: delayedFields() }, dir);
  // Stale: resolved long ago; fresh: resolved just now.
  setWakeStatus(stale.id, "fired", Date.now() - WAKE_TERMINAL_RETENTION_MS - 60_000, undefined, dir);
  setWakeStatus(fresh.id, "fired", Date.now(), undefined, dir);
  // Force a reload from disk.
  __resetWakeStoreForTests();
  const ids = listWakes(undefined, dir).map((w) => w.id);
  assert.ok(!ids.includes(stale.id));
  assert.ok(ids.includes(fresh.id));
});

test("createWake enforces the per-session pending cap", () => {
  const dir = freshDir();
  for (let i = 0; i < MAX_PENDING_WAKES_PER_SESSION; i += 1) {
    createWake({ sessionId: "s1", cwd: "/tmp", fields: delayedFields() }, dir);
  }
  assert.throws(() => createWake({ sessionId: "s1", cwd: "/tmp", fields: delayedFields() }, dir), /pending wakes/);
  // A different session is unaffected.
  assert.ok(createWake({ sessionId: "s2", cwd: "/tmp", fields: delayedFields() }, dir));
});
