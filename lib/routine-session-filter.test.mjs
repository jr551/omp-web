import assert from "node:assert/strict";
import test from "node:test";

import { hideRoutineSessions } from "./routine-session-filter.ts";

const sessions = [
  { id: "user-1" },
  { id: "routine-run-1" },
  { id: "user-2" },
  { id: "routine-run-2" },
];

test("hideRoutineSessions removes ids in the set, keeping others in order", () => {
  const out = hideRoutineSessions(sessions, new Set(["routine-run-1", "routine-run-2"]));
  assert.deepEqual(out.map((s) => s.id), ["user-1", "user-2"]);
});

test("hideRoutineSessions is a no-op (copy) for an empty set", () => {
  const out = hideRoutineSessions(sessions, new Set());
  assert.deepEqual(out.map((s) => s.id), sessions.map((s) => s.id));
  assert.notEqual(out, sessions); // returns a fresh array
});

test("hideRoutineSessions keeps a session not in the set (e.g. a smartwake re-enter of the worker's own session)", () => {
  // The worker's own session is NOT a routine-run session, so it must stay.
  const out = hideRoutineSessions([{ id: "own-session" }], new Set(["routine-run-1"]));
  assert.deepEqual(out.map((s) => s.id), ["own-session"]);
});
