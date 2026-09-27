import assert from "node:assert/strict";
import test from "node:test";

import {
  createSchedulerState,
  runSchedulerTick,
  settleScheduler,
  guardPasses,
  summarize,
  minuteKey,
} from "./routine-scheduler.ts";

// A tiny in-memory routine store for the tick tests.
function makeStore(routines) {
  const map = new Map(routines.map((r) => [r.id, { ...r, history: r.history ?? [] }]));
  return {
    listRoutines: () => [...map.values()],
    getRoutine: (id) => map.get(id),
    recordRun: (id, run) => {
      const existing = map.get(id);
      if (!existing) return;
      const history = existing.history ? [...existing.history] : [];
      const index = history.findIndex((entry) => entry.id === run.id);
      if (index >= 0) history[index] = run;
      else history.push(run);
      map.set(id, { ...existing, lastRun: run, history });
    },
    map,
  };
}

function cronRoutine(overrides = {}) {
  return {
    id: "cron-1",
    name: "Cron",
    cwd: "/tmp",
    trigger: { type: "cron", schedule: "* * * * *" },
    prompt: "do it",
    maxExecutionMs: 60_000,
    enabled: true,
    ...overrides,
  };
}

function guardRoutine(overrides = {}) {
  return {
    id: "guard-1",
    name: "Guard",
    cwd: "/tmp",
    trigger: { type: "guard", intervalMs: 60_000, command: "check", guardTimeoutMs: 5_000 },
    prompt: "do it",
    maxExecutionMs: 60_000,
    enabled: true,
    ...overrides,
  };
}

test("summarize truncates and falls back", () => {
  assert.equal(summarize(""), "No output");
  assert.equal(summarize(null), "No output");
  assert.equal(summarize("  hello   world  "), "hello world");
  const long = "x".repeat(400);
  const summary = summarize(long);
  assert.ok(summary.length <= 280);
  assert.ok(summary.endsWith("…"));
});

test("guardPasses evaluates exit code, timeout, and regex", () => {
  assert.deepEqual(guardPasses({ exitCode: 0, stdout: "", stderr: "", timedOut: false }), { passed: true });
  assert.equal(guardPasses({ exitCode: 1, stdout: "", stderr: "", timedOut: false }).passed, false);
  assert.equal(guardPasses({ exitCode: 0, stdout: "", stderr: "", timedOut: true }).passed, false);
  assert.equal(guardPasses({ exitCode: 0, stdout: "all good", stderr: "", timedOut: false }, "good").passed, true);
  assert.equal(guardPasses({ exitCode: 0, stdout: "nope", stderr: "", timedOut: false }, "good").passed, false);
});

test("cron routine fires once per matching minute and re-fires next minute", async () => {
  const store = makeStore([cronRoutine()]);
  let runs = 0;
  const clock = { current: new Date("2026-03-02T09:30:00") };
  const deps = {
    now: () => clock.current,
    ...store,
    runner: async () => { runs += 1; return { summary: "ok" }; },
    guardRunner: async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false }),
    concurrency: 3,
  };
  const state = createSchedulerState();

  await runSchedulerTick(deps, state);
  await settleScheduler(state);
  assert.equal(runs, 1);

  // Same minute, later second: no re-fire.
  clock.current = new Date("2026-03-02T09:30:45");
  await runSchedulerTick(deps, state);
  await settleScheduler(state);
  assert.equal(runs, 1);

  // Next minute: fires again.
  clock.current = new Date("2026-03-02T09:31:00");
  await runSchedulerTick(deps, state);
  await settleScheduler(state);
  assert.equal(runs, 2);

  assert.equal(store.map.get("cron-1").lastRun.status, "success");
  assert.equal(store.map.get("cron-1").lastRun.summary, "ok");
});

test("disabled routines never run", async () => {
  const store = makeStore([cronRoutine({ enabled: false })]);
  let runs = 0;
  const deps = {
    now: () => new Date("2026-03-02T09:30:00"),
    ...store,
    runner: async () => { runs += 1; return { summary: "ok" }; },
    guardRunner: async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false }),
    concurrency: 3,
  };
  const state = createSchedulerState();
  await runSchedulerTick(deps, state);
  await settleScheduler(state);
  assert.equal(runs, 0);
});

test("a routine already running is not started again", async () => {
  const store = makeStore([cronRoutine()]);
  let active = 0;
  let maxActive = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const deps = {
    now: () => new Date("2026-03-02T09:30:00"),
    ...store,
    runner: async () => {
      active += 1; maxActive = Math.max(maxActive, active);
      await gate;
      active -= 1;
      return { summary: "ok" };
    },
    guardRunner: async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false }),
    concurrency: 3,
  };
  const state = createSchedulerState();
  await runSchedulerTick(deps, state);
  // Same minute won't re-trigger anyway, but running-set also blocks it.
  await runSchedulerTick(deps, state);
  release();
  await settleScheduler(state);
  assert.equal(maxActive, 1);
});

test("global concurrency cap limits simultaneous runs", async () => {
  const routines = [
    cronRoutine({ id: "a" }),
    cronRoutine({ id: "b" }),
    cronRoutine({ id: "c" }),
    cronRoutine({ id: "d" }),
  ];
  const store = makeStore(routines);
  let active = 0;
  let maxActive = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const deps = {
    now: () => new Date("2026-03-02T09:30:00"),
    ...store,
    runner: async () => {
      active += 1; maxActive = Math.max(maxActive, active);
      await gate;
      active -= 1;
      return { summary: "ok" };
    },
    guardRunner: async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false }),
    concurrency: 2,
  };
  const state = createSchedulerState();
  await runSchedulerTick(deps, state);
  assert.equal(state.running.size, 2);
  release();
  await settleScheduler(state);
  assert.equal(maxActive, 2);
});

test("timeout marks the run as timeout", async () => {
  const store = makeStore([cronRoutine({ maxExecutionMs: 10 })]);
  const deps = {
    now: () => new Date("2026-03-02T09:30:00"),
    ...store,
    runner: (routine, signal) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")));
    }),
    guardRunner: async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false }),
    concurrency: 3,
  };
  const state = createSchedulerState();
  await runSchedulerTick(deps, state);
  await settleScheduler(state);
  assert.equal(store.map.get("cron-1").lastRun.status, "timeout");
});

test("runner error is recorded", async () => {
  const store = makeStore([cronRoutine()]);
  const deps = {
    now: () => new Date("2026-03-02T09:30:00"),
    ...store,
    runner: async () => { throw new Error("boom"); },
    guardRunner: async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false }),
    concurrency: 3,
  };
  const state = createSchedulerState();
  await runSchedulerTick(deps, state);
  await settleScheduler(state);
  assert.equal(store.map.get("cron-1").lastRun.status, "error");
  assert.equal(store.map.get("cron-1").lastRun.error, "boom");
});

test("guard: passing command triggers a run", async () => {
  const store = makeStore([guardRoutine()]);
  let runs = 0;
  let guardCalls = 0;
  const deps = {
    now: () => new Date("2026-03-02T09:30:00"),
    ...store,
    runner: async () => { runs += 1; return { summary: "job done" }; },
    guardRunner: async () => { guardCalls += 1; return { exitCode: 0, stdout: "ready", stderr: "", timedOut: false }; },
    concurrency: 3,
  };
  const state = createSchedulerState();
  await runSchedulerTick(deps, state);
  await settleScheduler(state);
  assert.equal(guardCalls, 1);
  assert.equal(runs, 1);
  assert.equal(store.map.get("guard-1").lastRun.status, "success");
});

test("guard: failing command records a skip and does not run", async () => {
  const store = makeStore([guardRoutine()]);
  let runs = 0;
  const deps = {
    now: () => new Date("2026-03-02T09:30:00"),
    ...store,
    runner: async () => { runs += 1; return { summary: "x" }; },
    guardRunner: async () => ({ exitCode: 1, stdout: "", stderr: "", timedOut: false }),
    concurrency: 3,
  };
  const state = createSchedulerState();
  await runSchedulerTick(deps, state);
  await settleScheduler(state);
  assert.equal(runs, 0);
  const routine = store.map.get("guard-1");
  assert.equal(routine.lastRun.status, "skipped");
  assert.match(routine.lastRun.summary, /condition not met/);
});

test("guard: honors interval between checks and collapses repeat skips", async () => {
  const store = makeStore([guardRoutine({ trigger: { type: "guard", intervalMs: 60_000, command: "c", guardTimeoutMs: 1000 } })]);
  let guardCalls = 0;
  const clock = { current: new Date("2026-03-02T09:30:00") };
  const deps = {
    now: () => clock.current,
    ...store,
    runner: async () => ({ summary: "x" }),
    guardRunner: async () => { guardCalls += 1; return { exitCode: 1, stdout: "", stderr: "", timedOut: false }; },
    concurrency: 3,
  };
  const state = createSchedulerState();

  await runSchedulerTick(deps, state);
  await settleScheduler(state);
  assert.equal(guardCalls, 1);

  // 30s later: interval not elapsed -> no new check.
  clock.current = new Date("2026-03-02T09:30:30");
  await runSchedulerTick(deps, state);
  await settleScheduler(state);
  assert.equal(guardCalls, 1);

  // 60s later: check again.
  clock.current = new Date("2026-03-02T09:31:00");
  await runSchedulerTick(deps, state);
  await settleScheduler(state);
  assert.equal(guardCalls, 2);

  // Consecutive identical skips are collapsed into a single history entry.
  const routine = store.map.get("guard-1");
  const skips = routine.history.filter((r) => r.status === "skipped");
  assert.equal(skips.length, 1);
});

test("minuteKey is stable within a minute", () => {
  assert.equal(minuteKey(new Date("2026-03-02T09:30:00")), minuteKey(new Date("2026-03-02T09:30:59")));
  assert.notEqual(minuteKey(new Date("2026-03-02T09:30:00")), minuteKey(new Date("2026-03-02T09:31:00")));
});
