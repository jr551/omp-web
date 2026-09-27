import assert from "node:assert/strict";
import test from "node:test";

import {
  createWakeSchedulerState,
  runWakeTick,
  settleWakeScheduler,
} from "./wake-scheduler.ts";

// A tiny in-memory wake store for the tick tests.
function makeStore(wakes) {
  const map = new Map(wakes.map((w) => [w.id, { ...w }]));
  return {
    map,
    listPending: () => [...map.values()].filter((w) => w.status === "pending"),
    setStatus: (id, status, now, reason) => {
      const w = map.get(id);
      if (w) map.set(id, { ...w, status, resolvedAt: now, ...(reason ? { statusReason: reason } : {}) });
    },
    recordPoll: (id, now) => {
      const w = map.get(id);
      if (w) map.set(id, { ...w, lastPollAt: now });
    },
  };
}

function delayedWake(overrides = {}) {
  return {
    id: "d1",
    sessionId: "s1",
    cwd: "/tmp",
    mode: "delayed",
    message: "wake",
    fireAt: 10_000,
    createdAt: 0,
    expiresAt: 1_000_000,
    status: "pending",
    ...overrides,
  };
}

function guardedWake(overrides = {}) {
  return {
    id: "g1",
    sessionId: "s1",
    cwd: "/tmp",
    mode: "guarded",
    message: "done",
    pollCommand: "check",
    intervalMs: 60_000,
    guardTimeoutMs: 5_000,
    createdAt: 0,
    expiresAt: 1_000_000,
    status: "pending",
    ...overrides,
  };
}

function baseDeps(store, over = {}) {
  return {
    now: () => 0,
    listPending: store.listPending,
    setStatus: store.setStatus,
    recordPoll: store.recordPoll,
    evaluateGuard: async () => ({ passed: true }),
    deliver: async () => ({ delivered: true }),
    concurrency: 3,
    ...over,
  };
}

test("delayed wake does not fire before fireAt", async () => {
  const store = makeStore([delayedWake({ fireAt: 10_000 })]);
  let delivered = 0;
  const deps = baseDeps(store, { now: () => 5_000, deliver: async () => { delivered += 1; return { delivered: true }; } });
  const state = createWakeSchedulerState();
  await runWakeTick(deps, state);
  await settleWakeScheduler(state);
  assert.equal(delivered, 0);
  assert.equal(store.map.get("d1").status, "pending");
});

test("delayed wake fires once at/after fireAt and dedupes across ticks", async () => {
  const store = makeStore([delayedWake({ fireAt: 10_000 })]);
  let delivered = 0;
  const deps = baseDeps(store, { now: () => 20_000, deliver: async () => { delivered += 1; return { delivered: true }; } });
  const state = createWakeSchedulerState();
  await runWakeTick(deps, state);
  await settleWakeScheduler(state);
  // A second tick must NOT re-fire (status is now terminal).
  await runWakeTick(deps, state);
  await settleWakeScheduler(state);
  assert.equal(delivered, 1);
  assert.equal(store.map.get("d1").status, "fired");
});

test("expired wake is dropped without delivery", async () => {
  const store = makeStore([delayedWake({ fireAt: 10_000, expiresAt: 15_000 })]);
  let delivered = 0;
  const deps = baseDeps(store, { now: () => 20_000, deliver: async () => { delivered += 1; return { delivered: true }; } });
  const state = createWakeSchedulerState();
  await runWakeTick(deps, state);
  await settleWakeScheduler(state);
  assert.equal(delivered, 0);
  assert.equal(store.map.get("d1").status, "expired");
});

test("delivery retry leaves the wake pending, then fires on a later tick", async () => {
  const store = makeStore([delayedWake({ fireAt: 0 })]);
  let calls = 0;
  const deps = baseDeps(store, {
    now: () => 5_000,
    deliver: async () => {
      calls += 1;
      return calls === 1 ? { retry: true } : { delivered: true };
    },
  });
  const state = createWakeSchedulerState();
  await runWakeTick(deps, state);
  await settleWakeScheduler(state);
  assert.equal(store.map.get("d1").status, "pending"); // busy -> retry
  await runWakeTick(deps, state);
  await settleWakeScheduler(state);
  assert.equal(store.map.get("d1").status, "fired");
  assert.equal(calls, 2);
});

test("guarded wake fires only when the guard passes; records each poll", async () => {
  const store = makeStore([guardedWake({ intervalMs: 60_000 })]);
  let passed = false;
  let delivered = 0;
  let clock = 100_000;
  const deps = baseDeps(store, {
    now: () => clock,
    evaluateGuard: async () => ({ passed }),
    deliver: async () => { delivered += 1; return { delivered: true }; },
  });
  const state = createWakeSchedulerState();

  await runWakeTick(deps, state);
  await settleWakeScheduler(state);
  assert.equal(delivered, 0);
  assert.equal(store.map.get("g1").status, "pending");
  assert.equal(store.map.get("g1").lastPollAt, 100_000);

  // Before the interval elapses, no re-poll.
  clock = 130_000;
  await runWakeTick(deps, state);
  await settleWakeScheduler(state);
  assert.equal(store.map.get("g1").lastPollAt, 100_000);

  // Interval elapsed and now the guard passes -> fire.
  clock = 200_000;
  passed = true;
  await runWakeTick(deps, state);
  await settleWakeScheduler(state);
  assert.equal(delivered, 1);
  assert.equal(store.map.get("g1").status, "fired");
});

test("guard evaluation errors do not fire the wake", async () => {
  const store = makeStore([guardedWake()]);
  let delivered = 0;
  const deps = baseDeps(store, {
    now: () => 100_000,
    evaluateGuard: async () => { throw new Error("nope"); },
    deliver: async () => { delivered += 1; return { delivered: true }; },
  });
  const state = createWakeSchedulerState();
  await runWakeTick(deps, state);
  await settleWakeScheduler(state);
  assert.equal(delivered, 0);
  assert.equal(store.map.get("g1").status, "pending");
});

test("concurrency cap limits simultaneous fires", async () => {
  const wakes = [0, 1, 2, 3].map((i) => delayedWake({ id: `d${i}`, fireAt: 0 }));
  const store = makeStore(wakes);
  let inFlight = 0;
  let maxInFlight = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const deps = baseDeps(store, {
    now: () => 10_000,
    concurrency: 2,
    deliver: async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await gate;
      inFlight -= 1;
      return { delivered: true };
    },
  });
  const state = createWakeSchedulerState();
  await runWakeTick(deps, state);
  assert.equal(state.firing.size, 2); // only 2 started this tick
  release();
  await settleWakeScheduler(state);
  assert.ok(maxInFlight <= 2);
});

test("failed delivery marks the wake failed", async () => {
  const store = makeStore([delayedWake({ fireAt: 0 })]);
  const deps = baseDeps(store, {
    now: () => 5_000,
    deliver: async () => ({ reason: "session gone" }),
  });
  const state = createWakeSchedulerState();
  await runWakeTick(deps, state);
  await settleWakeScheduler(state);
  assert.equal(store.map.get("d1").status, "failed");
  assert.equal(store.map.get("d1").statusReason, "session gone");
});
