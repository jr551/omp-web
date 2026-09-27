import assert from "node:assert/strict";
import test from "node:test";

import {
  summarizePendingWakes,
  toSafeWake,
  describePendingWakes,
  truncateCommand,
} from "./wake-types.ts";

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

test("toSafeWake strips message but keeps the poll command for display", () => {
  const safe = toSafeWake(wake({ pollCommand: "echo hi", intervalMs: 5000, fireAt: 5000 }));
  assert.equal(safe.id, "w");
  assert.equal(safe.sessionId, "sess");
  assert.equal(safe.cwd, "/proj");
  assert.equal(safe.fireAt, 5000);
  assert.equal(safe.intervalMs, 5000);
  assert.equal(safe.status, "pending");
  // message stays stripped; pollCommand is now exposed for the descriptive badge.
  assert.equal("message" in safe, false);
  assert.equal(safe.pollCommand, "echo hi");
});

test("summarizePendingWakes groups by session and cwd with earliest fire and wakes", () => {
  const wakes = [
    wake({ id: "a", sessionId: "s1", cwd: "/p1", fireAt: 5000 }),
    wake({ id: "b", sessionId: "s1", cwd: "/p1", fireAt: 3000 }),
    wake({ id: "c", sessionId: "s2", cwd: "/p2", mode: "guarded" }), // no fireAt
    wake({ id: "d", sessionId: "s3", cwd: "/p1", status: "fired" }), // terminal, ignored
  ];
  const summary = summarizePendingWakes(wakes);

  assert.equal(summary.wakes.length, 3);
  assert.equal(summary.bySession.s1.count, 2);
  assert.equal(summary.bySession.s1.nextFireAt, 3000);
  assert.deepEqual(summary.bySession.s1.wakes.map((w) => w.id), ["a", "b"]);
  assert.equal(summary.bySession.s2.count, 1);
  assert.equal(summary.bySession.s2.nextFireAt, null);
  assert.equal(summary.bySession.s3, undefined);
  assert.equal(summary.byCwd["/p1"].count, 2);
  assert.equal(summary.byCwd["/p1"].nextFireAt, 3000);
  assert.equal(summary.byCwd["/p2"].count, 1);
  // The exposed wakes carry no stored message.
  assert.equal("message" in summary.bySession.s1.wakes[0], false);
});

test("summarizePendingWakes is empty for no pending wakes", () => {
  const summary = summarizePendingWakes([wake({ status: "cancelled" })]);
  assert.deepEqual(summary, { wakes: [], bySession: {}, byCwd: {} });
});

test("truncateCommand shortens long commands with an ellipsis", () => {
  assert.equal(truncateCommand("echo hi"), "echo hi");
  assert.equal(truncateCommand("  echo hi  "), "echo hi");
  const long = "x".repeat(60);
  const out = truncateCommand(long, 10);
  assert.equal(out.length, 10);
  assert.ok(out.endsWith("…"));
});

test("describePendingWakes returns null when nothing is pending", () => {
  assert.equal(describePendingWakes([], 0), null);
  assert.equal(describePendingWakes([toSafeWake(wake({ status: "fired" }))], 0), null);
});

test("describePendingWakes describes a single delayed wake", () => {
  const now = 1000;
  const w = toSafeWake(wake({ mode: "delayed", fireAt: now + 2 * 60 * 60 * 1000, expiresAt: now + 3 * 60 * 60 * 1000 }));
  const badge = describePendingWakes([w], now);
  assert.equal(badge.label, "Waking in 2h");
  assert.ok(badge.title.includes("will wake in 2h"));
  assert.ok(badge.title.includes("expires in"));
});

test("describePendingWakes describes a single guarded wake and truncates the command", () => {
  const now = 1000;
  const command = "while true; do check-a-really-long-condition-name --flag; done";
  const w = toSafeWake(wake({ mode: "guarded", pollCommand: command, intervalMs: 60_000, fireAt: undefined, expiresAt: now + 60 * 60 * 1000 }));
  const badge = describePendingWakes([w], now);
  assert.ok(badge.label.startsWith("Watching: "));
  assert.ok(badge.label.length < command.length + "Watching: ".length);
  assert.ok(badge.title.includes(command)); // full command in the tooltip
});

test("describePendingWakes collapses multiple wakes into a count", () => {
  const now = 1000;
  const w1 = toSafeWake(wake({ id: "a", mode: "delayed", fireAt: now + 60_000, expiresAt: now + 120_000 }));
  const w2 = toSafeWake(wake({ id: "b", mode: "guarded", pollCommand: "ls", intervalMs: 30_000, fireAt: undefined, expiresAt: now + 120_000 }));
  const badge = describePendingWakes([w1, w2], now);
  assert.equal(badge.label, "2 watches");
  assert.equal(badge.title.split("\n").length, 2);
});
