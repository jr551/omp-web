import { randomUUID } from "crypto";
import { parseCron, cronMatches } from "./cron";
import {
  guardPasses,
  runGuardCommand,
  type GuardCommandRunner as GuardRunner,
  type GuardVerdict,
} from "./guard-command";
import { runPromptInFreshSession, type RunOutcome } from "./routine-runner";
import {
  listRoutines as storeListRoutines,
  getRoutine as storeGetRoutine,
  recordRun as storeRecordRun,
  type Routine,
  type RoutineRun,
} from "./routine-store";
import type { RoutineWithStatus } from "./routine-types";

/**
 * Native scheduler ("Routines") service.
 *
 * A globalThis singleton, started once from instrumentation.ts. A setInterval
 * ticks roughly every 30s; on each tick every enabled routine whose trigger is
 * due (a cron minute match, or a guard whose interval elapsed and command
 * passes) is run unattended in the omp-web server process.
 *
 * The tick, runner, and guard command runner are all injectable so the logic can
 * be unit-tested with a fake clock and fake runners — no real agents or shells.
 */

export const TICK_INTERVAL_MS = 30_000;
export const DEFAULT_GLOBAL_CONCURRENCY = 3;
export const SUMMARY_MAX_LENGTH = 280;

export { guardPasses } from "./guard-command";
export type { GuardCommandResult, GuardVerdict, GuardCommandRunner as GuardRunner } from "./guard-command";
export type { RunOutcome } from "./routine-runner";

export type RoutineRunner = (routine: Routine, signal: AbortSignal) => Promise<RunOutcome>;

export interface SchedulerDeps {
  now: () => Date;
  listRoutines: () => Routine[];
  getRoutine: (id: string) => Routine | undefined;
  recordRun: (id: string, run: RoutineRun) => void;
  runner: RoutineRunner;
  guardRunner: GuardRunner;
  concurrency: number;
  onChange?: () => void;
}

export interface SchedulerState {
  running: Set<string>;
  guardChecking: Set<string>;
  lastTriggeredMinute: Map<string, string>;
  lastGuardCheck: Map<string, number>;
  pending: Set<Promise<void>>;
}

export function createSchedulerState(): SchedulerState {
  return {
    running: new Set(),
    guardChecking: new Set(),
    lastTriggeredMinute: new Map(),
    lastGuardCheck: new Map(),
    pending: new Set(),
  };
}

// ---------------------------------------------------------------------------
// Pure helpers (unit tested)
// ---------------------------------------------------------------------------

/** A stable key for the local minute of `date`, used to dedupe cron firings. */
export function minuteKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}T${date.getHours()}:${date.getMinutes()}`;
}

/** Condense assistant text into a short summary for the sidebar/history. */
export function summarize(text: string | undefined | null): string {
  const trimmed = (text ?? "").replace(/\s+/g, " ").trim();
  if (!trimmed) return "No output";
  if (trimmed.length <= SUMMARY_MAX_LENGTH) return trimmed;
  return `${trimmed.slice(0, SUMMARY_MAX_LENGTH - 1).trimEnd()}…`;
}

// ---------------------------------------------------------------------------
// Tick
// ---------------------------------------------------------------------------

/**
 * Run one scheduler tick against injected dependencies and mutable state.
 * Runs are started fire-and-forget; their promises are tracked in
 * `state.pending` so tests can await them with {@link settleScheduler}.
 */
export async function runSchedulerTick(deps: SchedulerDeps, state: SchedulerState): Promise<void> {
  const now = deps.now();
  const routines = deps.listRoutines();

  for (const routine of routines) {
    if (!routine.enabled) continue;
    if (state.running.has(routine.id)) continue; // at most one run per routine

    if (routine.trigger.type === "cron") {
      const spec = parseCron(routine.trigger.schedule);
      if ("error" in spec) continue;
      if (!cronMatches(spec, now)) continue;
      const key = minuteKey(now);
      if (state.lastTriggeredMinute.get(routine.id) === key) continue; // dedupe within the minute
      if (state.running.size >= deps.concurrency) continue; // global cap; retry next tick
      state.lastTriggeredMinute.set(routine.id, key);
      track(state, startRun(deps, state, routine, now));
    } else if (routine.trigger.type === "guard") {
      if (state.guardChecking.has(routine.id)) continue; // an eval is already in flight
      const last = state.lastGuardCheck.get(routine.id) ?? 0;
      if (now.getTime() - last < routine.trigger.intervalMs) continue;
      if (state.running.size >= deps.concurrency) continue; // no capacity to act on a pass
      state.lastGuardCheck.set(routine.id, now.getTime());
      track(state, evaluateGuardThenRun(deps, state, routine, now));
    }
  }
}

function track(state: SchedulerState, promise: Promise<void>): void {
  state.pending.add(promise);
  void promise.finally(() => state.pending.delete(promise));
}

/** Await every run/guard-eval started so far (test helper). */
export async function settleScheduler(state: SchedulerState): Promise<void> {
  while (state.pending.size > 0) {
    await Promise.all([...state.pending]);
  }
}

async function startRun(deps: SchedulerDeps, state: SchedulerState, routine: Routine, now: Date): Promise<void> {
  state.running.add(routine.id);
  const runId = randomUUID();
  const run: RoutineRun = { id: runId, startedAt: now.toISOString(), status: "running", summary: "Running…" };
  deps.recordRun(routine.id, run);
  deps.onChange?.();

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, routine.maxExecutionMs);

  try {
    const outcome = await deps.runner(routine, controller.signal);
    clearTimeout(timer);
    deps.recordRun(routine.id, {
      ...run,
      finishedAt: deps.now().toISOString(),
      status: "success",
      summary: summarize(outcome.note ? `[${outcome.note}] ${outcome.summary}` : outcome.summary),
      ...(outcome.sessionId ? { sessionId: outcome.sessionId } : {}),
    });
  } catch (error) {
    clearTimeout(timer);
    const message = error instanceof Error ? error.message : String(error);
    deps.recordRun(routine.id, {
      ...run,
      finishedAt: deps.now().toISOString(),
      status: timedOut ? "timeout" : "error",
      summary: timedOut ? "Run exceeded its maximum execution time." : summarize(message),
      error: message,
    });
  } finally {
    state.running.delete(routine.id);
    deps.onChange?.();
  }
}

async function evaluateGuardThenRun(deps: SchedulerDeps, state: SchedulerState, routine: Routine, now: Date): Promise<void> {
  if (routine.trigger.type !== "guard") return;
  const { command, guardTimeoutMs, expectOutputMatches } = routine.trigger;
  state.guardChecking.add(routine.id);
  try {
    const controller = new AbortController();
    let verdict: GuardVerdict;
    try {
      const result = await deps.guardRunner(command, guardTimeoutMs, controller.signal);
      verdict = guardPasses(result, expectOutputMatches);
    } catch (error) {
      verdict = { passed: false, reason: `condition check failed: ${error instanceof Error ? error.message : String(error)}` };
    }

    if (!verdict.passed) {
      recordSkip(deps, routine.id, verdict.reason ?? "condition not met", now);
      deps.onChange?.();
      return;
    }

    // Passed: run now, unless another run started meanwhile or the cap is full.
    if (state.running.has(routine.id) || state.running.size >= deps.concurrency) return;
    await startRun(deps, state, routine, deps.now());
  } finally {
    state.guardChecking.delete(routine.id);
  }
}

/**
 * Record a guard skip, collapsing consecutive identical skips into one entry so
 * a frequently-checked guard does not flood the capped history.
 */
function recordSkip(deps: SchedulerDeps, routineId: string, reason: string, now: Date): void {
  const existing = deps.getRoutine(routineId);
  const last = existing?.lastRun;
  const reuseId = last && last.status === "skipped" && last.summary === reason ? last.id : randomUUID();
  deps.recordRun(routineId, {
    id: reuseId,
    startedAt: last && last.id === reuseId ? last.startedAt : now.toISOString(),
    finishedAt: now.toISOString(),
    status: "skipped",
    summary: reason,
  });
}

// ---------------------------------------------------------------------------
// Real dependencies (server runtime)
// ---------------------------------------------------------------------------

/** The default guard command runner (real shell). Re-exported for reuse. */
export const defaultGuardRunner: GuardRunner = runGuardCommand;

/** Run a routine's prompt in a fresh unattended session (real agent). */
export const defaultRunner: RoutineRunner = (routine, signal) =>
  runPromptInFreshSession(
    {
      cwd: routine.cwd,
      prompt: routine.prompt,
      routineId: routine.id,
      maxExecutionMs: routine.maxExecutionMs,
      ...(routine.provider && routine.modelId ? { provider: routine.provider, modelId: routine.modelId } : {}),
      ...(routine.askWebhookUrl ? { askWebhookUrl: routine.askWebhookUrl } : {}),
    },
    signal,
  );

// ---------------------------------------------------------------------------
// Singleton (server runtime)
// ---------------------------------------------------------------------------

interface SchedulerSingleton {
  state: SchedulerState;
  interval: ReturnType<typeof setInterval> | null;
  deps: SchedulerDeps;
}

declare global {
  var __ompRoutineScheduler: SchedulerSingleton | undefined;
}

function buildRealDeps(): SchedulerDeps {
  return {
    now: () => new Date(),
    listRoutines: () => storeListRoutines(),
    getRoutine: (id) => storeGetRoutine(id),
    recordRun: (id, run) => { storeRecordRun(id, run); },
    runner: defaultRunner,
    guardRunner: defaultGuardRunner,
    concurrency: DEFAULT_GLOBAL_CONCURRENCY,
  };
}

/** Start the scheduler singleton once. Safe to call repeatedly. */
export function startRoutineScheduler(): void {
  if (globalThis.__ompRoutineScheduler) return;
  const singleton: SchedulerSingleton = {
    state: createSchedulerState(),
    interval: null,
    deps: buildRealDeps(),
  };
  const tick = () => {
    void runSchedulerTick(singleton.deps, singleton.state).catch((error) => {
      console.error("[omp-web] routine scheduler tick failed:", error instanceof Error ? error.message : error);
    });
  };
  singleton.interval = setInterval(tick, TICK_INTERVAL_MS);
  if (typeof singleton.interval === "object" && "unref" in singleton.interval) {
    (singleton.interval as { unref: () => void }).unref();
  }
  globalThis.__ompRoutineScheduler = singleton;
  console.log("[omp-web] routine scheduler started");
  // Kick a first tick shortly after startup so due routines do not wait 30s.
  setTimeout(tick, 2_000);
}

/** Trigger a scheduler tick immediately (used by the "run now" API and tests). */
export function tickNow(): Promise<void> {
  const singleton = globalThis.__ompRoutineScheduler;
  if (!singleton) return Promise.resolve();
  return runSchedulerTick(singleton.deps, singleton.state);
}

/**
 * Run a single routine immediately, bypassing its trigger (the "run now" API).
 * Respects the single-run-per-routine guard but not the global cap, so an
 * operator-requested run is never silently dropped.
 */
export async function runRoutineNow(routineId: string, options: { extraContext?: string } = {}): Promise<void> {
  if (!globalThis.__ompRoutineScheduler) startRoutineScheduler();
  const singleton = globalThis.__ompRoutineScheduler!;
  const stored = singleton.deps.getRoutine(routineId);
  if (!stored) throw new Error(`Routine not found: ${routineId}`);
  if (singleton.state.running.has(routineId)) return; // already running
  // Append caller-supplied context (e.g. a webhook body) without mutating the store.
  const routine: Routine = options.extraContext
    ? { ...stored, prompt: `${stored.prompt}\n\n---\nTrigger context:\n${options.extraContext}` }
    : stored;
  const state = singleton.state;
  state.running.add(routineId);
  const runId = randomUUID();
  const now = singleton.deps.now();
  const run: RoutineRun = { id: runId, startedAt: now.toISOString(), status: "running", summary: "Running…" };
  singleton.deps.recordRun(routineId, run);
  singleton.deps.onChange?.();

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, routine.maxExecutionMs);
  const promise = (async () => {
    try {
      const outcome = await singleton.deps.runner(routine, controller.signal);
      clearTimeout(timer);
      singleton.deps.recordRun(routineId, {
        ...run,
        finishedAt: singleton.deps.now().toISOString(),
        status: "success",
        summary: summarize(outcome.note ? `[${outcome.note}] ${outcome.summary}` : outcome.summary),
        ...(outcome.sessionId ? { sessionId: outcome.sessionId } : {}),
      });
    } catch (error) {
      clearTimeout(timer);
      const message = error instanceof Error ? error.message : String(error);
      singleton.deps.recordRun(routineId, {
        ...run,
        finishedAt: singleton.deps.now().toISOString(),
        status: timedOut ? "timeout" : "error",
        summary: timedOut ? "Run exceeded its maximum execution time." : summarize(message),
        error: message,
      });
    } finally {
      state.running.delete(routineId);
      singleton.deps.onChange?.();
    }
  })();
  track(state, promise);
  // Do not await: run-now returns immediately and the run continues in the background.
}

/** Whether a routine currently has a run in flight (for the API/sidebar). */
export function isRoutineRunning(routineId: string): boolean {
  return globalThis.__ompRoutineScheduler?.state.running.has(routineId) ?? false;
}

/** All routine ids with a run in flight. */
export function getRunningRoutineIds(): string[] {
  return [...(globalThis.__ompRoutineScheduler?.state.running ?? [])];
}

/** Serialize a routine with its live running state, as the API returns it. */
export function toRoutineWithStatus(routine: Routine, baseUrl?: string): RoutineWithStatus {
  const running = isRoutineRunning(routine.id);
  if (routine.trigger.type === "webhook" && baseUrl) {
    return { ...routine, running, webhookUrl: `${baseUrl}/api/routines/hook/${routine.trigger.token}` };
  }
  return { ...routine, running };
}
