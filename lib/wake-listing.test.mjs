import assert from "node:assert/strict";
import test from "node:test";

import { summarizePendingWakes, toSafeWake } from "./wake-types.ts";

const wake = (over) => ({
  id: "w",
  sessionId: "sess",
  cwd: "/proj",
  mode: "delayed",
  message: "secret message",
  createdAt: 1000,
  expiresAt: 9000,
  status: "pending",
  ...over,
});

test("toSafeWake strips message and pollCommand", () => {
  const safe = toSafeWake(wake({ pollCommand: "echo hi", intervalMs: 5000, fireAt: 5000 }));
  assert.equal(safe.id, "w");
  assert.equal(safe.sessionId, "sess");
  assert.equal(safe.cwd, "/proj");
  assert.equal(safe.fireAt, 5000);
  assert.equal(safe.intervalMs, 5000);
  assert.equal(safe.status, "pending");
  assert.equal("message" in safe, false);
  assert.equal("pollCommand" in safe, false);
});

test("summarizePendingWakes groups by session and cwd with earliest fire", () => {
  const wakes = [
    wake({ id: "a", sessionId: "s1", cwd: "/p1", fireAt: 5000 }),
    wake({ id: "b", sessionId: "s1", cwd: "/p1", fireAt: 3000 }),
    wake({ id: "c", sessionId: "s2", cwd: "/p2", mode: "guarded" }), // no fireAt
    wake({ id: "d", sessionId: "s3", cwd: "/p1", status: "fired" }), // terminal, ignored
  ];
  const summary = summarizePendingWakes(wakes);

  assert.equal(summary.wakes.length, 3);
  assert.deepEqual(summary.bySession.s1, { count: 2, nextFireAt: 3000 });
  assert.deepEqual(summary.bySession.s2, { count: 1, nextFireAt: null });
  assert.equal(summary.bySession.s3, undefined);
  assert.deepEqual(summary.byCwd["/p1"], { count: 2, nextFireAt: 3000 });
  assert.deepEqual(summary.byCwd["/p2"], { count: 1, nextFireAt: null });
});

test("summarizePendingWakes is empty for no pending wakes", () => {
  const summary = summarizePendingWakes([wake({ status: "cancelled" })]);
  assert.deepEqual(summary, { wakes: [], bySession: {}, byCwd: {} });
});
