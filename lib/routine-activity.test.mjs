import assert from "node:assert/strict";
import test from "node:test";

import {
  formatRunDuration,
  latestRunSessionId,
  runScrollTargetId,
  sortRunsNewestFirst,
} from "./routine-activity.ts";

const run = (over) => ({ id: "x", startedAt: "2026-01-01T00:00:00.000Z", status: "success", summary: "", ...over });

test("runScrollTargetId is a stable per-run DOM id", () => {
  assert.equal(runScrollTargetId("abc"), "routine-run-abc");
});

test("sortRunsNewestFirst orders by finishedAt/startedAt desc without mutating", () => {
  const runs = [
    run({ id: "a", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:10.000Z" }),
    run({ id: "b", startedAt: "2026-01-01T01:00:00.000Z", finishedAt: "2026-01-01T01:00:05.000Z" }),
    run({ id: "c", startedAt: "2026-01-01T00:30:00.000Z" }), // running, no finishedAt
  ];
  const sorted = sortRunsNewestFirst(runs);
  assert.deepEqual(sorted.map((r) => r.id), ["b", "c", "a"]);
  // input untouched
  assert.deepEqual(runs.map((r) => r.id), ["a", "b", "c"]);
});

test("sortRunsNewestFirst falls back to id for ties", () => {
  const runs = [
    run({ id: "a", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:00.000Z" }),
    run({ id: "b", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:00.000Z" }),
  ];
  assert.deepEqual(sortRunsNewestFirst(runs).map((r) => r.id), ["b", "a"]);
});

test("formatRunDuration renders finished runs and skips unfinished ones", () => {
  assert.equal(formatRunDuration(run({ finishedAt: "2026-01-01T00:00:12.000Z" })), "12s");
  assert.equal(formatRunDuration(run({ startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:03:04.000Z" })), "3m 4s");
  assert.equal(formatRunDuration(run({ startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T01:02:00.000Z" })), "1h 2m");
  assert.equal(formatRunDuration(run({})), null);
  assert.equal(formatRunDuration(run({ startedAt: "bad", finishedAt: "worse" })), null);
});

test("latestRunSessionId returns the newest run's session id", () => {
  const runs = [
    run({ id: "a", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:10.000Z", sessionId: "sess-a" }),
    run({ id: "b", startedAt: "2026-01-01T02:00:00.000Z", finishedAt: "2026-01-01T02:00:10.000Z", sessionId: "sess-b" }),
    run({ id: "c", startedAt: "2026-01-01T01:00:00.000Z", finishedAt: "2026-01-01T01:00:10.000Z" }),
  ];
  assert.equal(latestRunSessionId(runs), "sess-b");
  assert.equal(latestRunSessionId([run({ id: "z" })]), undefined);
});
