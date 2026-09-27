import { evaluateGuard, type GuardVerdict } from "./guard-command";
import {
  listPendingWakes as storeListPendingWakes,
  recordWakePoll as storeRecordWakePoll,
  setWakeStatus as storeSetWakeStatus,
  type Wake,
} from "./wake-store";
import { DEFAULT_WAKE_GUARD_TIMEOUT_MS } from "./wake-types";

/**
 * The `smartwake` watcher.
 *
 * It piggybacks on the Routines scheduler's globalThis singleton / setInterval
 * (see lib/routine-scheduler.ts, which calls {@link tickWakes} from its own
 * tick), so there is only one timer in the process. Each tick:
 *  - drops wakes whose expiry has passed,
 *  - fires delayed wakes once `now >= fireAt`,
 *  - polls guarded wakes (reusing lib/guard-command.ts) when their interval has
 *    elapsed and fires them when the command passes,
 * with in-flight de-duplication so a wake fires exactly once.
 *
 * The tick, guard evaluation and delivery are all injectable so the logic can be
 * unit-tested with a fake clock / guard / delivery — no real agents or shells.
 */

export const DEFAULT_WAKE_CONCURRENCY = 3;

export type { GuardVerdict } from "./guard-command";

/** Outcome of delivering a wake's message back into its session. */
export interface WakeDeliveryOutcome {
  /** The message was delivered (or reliably queued); mark the wake fired. */
  delivered?: boolean;
  /** The session is busy right now; leave the wake pending and retry next tick. */
  retry?: boolean;
  /** Delivery is impossible (e.g. session gone and unresumable); mark failed. */
  reason?: string;
}

export interface WakeGuardEvaluator {
  (command: string, options: { timeoutMs: number; expectOutputMatches?: string; signal: AbortSignal }): Promise<GuardVerdict>;
}

export interface WakeSchedulerDeps {
  now: () => number;
  listPending: () => Wake[];
  setStatus: (id: string, status: "fired" | "expired" | "failed", now: number, reason?: string) => void;
  recordPoll: (id: string, now: number) => void;
  evaluateGuard: WakeGuardEvaluator;
  deliver: (wake: Wake) => Promise<WakeDeliveryOutcome>;
  concurrency: number;
  onChange?: () => void;
}

export interface WakeSchedulerState {
  firing: Set<string>;
  guardChecking: Set<string>;
  lastPoll: Map<string, number>;
  pending: Set<Promise<void>>;
}

export function createWakeSchedulerState(): WakeSchedulerState {
  return {
    firing: new Set(),
    guardChecking: new Set(),
    lastPoll: new Map(),
    pending: new Set(),
  };
}

function track(state: WakeSchedulerState, promise: Promise<void>): void {
  state.pending.add(promise);
  void promise.finally(() => state.pending.delete(promise));
}

/** Await every fire/guard-eval started so far (test helper). */
export async function settleWakeScheduler(state: WakeSchedulerState): Promise<void> {
  while (state.pending.size > 0) {
    await Promise.all([...state.pending]);
  }
}

/** Run one wake-scheduler tick against injected deps and mutable state. */
export async function runWakeTick(deps: WakeSchedulerDeps, state: WakeSchedulerState): Promise<void> {
  const now = deps.now();

  for (const wake of deps.listPending()) {
    if (wake.status !== "pending") continue;
    if (state.firing.has(wake.id)) continue; // fire once

    if (now >= wake.expiresAt) {
      deps.setStatus(wake.id, "expired", now, "expiry reached before firing");
      deps.onChange?.();
      continue;
    }

    if (wake.mode === "delayed") {
      if (typeof wake.fireAt !== "number" || now < wake.fireAt) continue;
      if (state.firing.size >= deps.concurrency) continue; // retry next tick
      track(state, fireWake(deps, state, wake));
    } else if (wake.mode === "guarded") {
      if (state.guardChecking.has(wake.id)) continue; // an eval is already in flight
      const last = state.lastPoll.get(wake.id) ?? wake.lastPollAt ?? 0;
      if (now - last < (wake.intervalMs ?? 0)) continue;
      if (state.firing.size >= deps.concurrency) continue; // no capacity to act on a pass
      state.lastPoll.set(wake.id, now);
      deps.recordPoll(wake.id, now);
      track(state, evaluateGuardThenFire(deps, state, wake));
    }
  }
}

async function fireWake(deps: WakeSchedulerDeps, state: WakeSchedulerState, wake: Wake): Promise<void> {
  state.firing.add(wake.id);
  try {
    const outcome = await deps.deliver(wake);
    if (outcome.retry) return; // stays pending; next tick retries
    if (outcome.delivered) {
      deps.setStatus(wake.id, "fired", deps.now());
    } else {
      deps.setStatus(wake.id, "failed", deps.now(), outcome.reason ?? "delivery failed");
    }
    deps.onChange?.();
  } catch (error) {
    deps.setStatus(wake.id, "failed", deps.now(), error instanceof Error ? error.message : String(error));
    deps.onChange?.();
  } finally {
    state.firing.delete(wake.id);
  }
}

async function evaluateGuardThenFire(deps: WakeSchedulerDeps, state: WakeSchedulerState, wake: Wake): Promise<void> {
  if (wake.mode !== "guarded" || !wake.pollCommand) return;
  state.guardChecking.add(wake.id);
  try {
    const controller = new AbortController();
    let verdict: GuardVerdict;
    try {
      verdict = await deps.evaluateGuard(wake.pollCommand, {
        timeoutMs: wake.guardTimeoutMs ?? DEFAULT_WAKE_GUARD_TIMEOUT_MS,
        ...(wake.expectOutputMatches ? { expectOutputMatches: wake.expectOutputMatches } : {}),
        signal: controller.signal,
      });
    } catch (error) {
      verdict = { passed: false, reason: `condition check failed: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (!verdict.passed) return; // keep waiting; poll again after the interval

    // Passed: fire now unless another fire started meanwhile or the cap is full.
    if (state.firing.has(wake.id) || state.firing.size >= deps.concurrency) return;
    await fireWake(deps, state, wake);
  } finally {
    state.guardChecking.delete(wake.id);
  }
}

// -------------------------------------------------------------------------
// Real dependencies (server runtime)
// -------------------------------------------------------------------------

const realGuardEvaluator: WakeGuardEvaluator = (command, options) =>
  evaluateGuard(command, {
    timeoutMs: options.timeoutMs,
    ...(options.expectOutputMatches ? { expectOutputMatches: options.expectOutputMatches } : {}),
    signal: options.signal,
  });

/**
 * Deliver a wake's message back into its originating session.
 *
 * - If the session is live in the registry and idle, the message is sent as a
 *   prompt (non-blocking; the browser, if watching, sees the agent resume).
 * - If the session is live but busy, delivery is deferred (retry next tick).
 * - If the session is not live, it is resumed from its `.jsonl` and the message
 *   is delivered as a headless turn via lib/routine-runner (blocking UI is
 *   declined so it never hangs). Without a stored `sessionFile` the wake fails.
 */
async function deliverWakeReal(wake: Wake): Promise<WakeDeliveryOutcome> {
  const { getRpcSession, startRpcSession } = await import("./rpc-manager");

  const live = getRpcSession(wake.sessionId);
  if (live?.isAlive()) {
    if (live.isRunning()) return { retry: true };
    try {
      await live.send({ type: "prompt", message: wake.message });
      return { delivered: true };
    } catch (error) {
      // A transient "session busy" style error: retry rather than fail.
      return { retry: true, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  if (!wake.sessionFile) {
    return { reason: "session is not live and has no session file to resume" };
  }

  try {
    const { allowFileRoot } = await import("./file-access");
    allowFileRoot(wake.cwd);
    const { session } = await startRpcSession(wake.sessionId, wake.sessionFile, wake.cwd);
    if (session.isRunning()) return { retry: true };
    const { runPromptInSession } = await import("./routine-runner");
    // Fire-and-forget the resumed headless turn; it declines blocking UI so it
    // never hangs, and the session idle-times out on its own afterwards.
    void runPromptInSession(session, wake.message, new AbortController().signal, {}).catch(() => {});
    return { delivered: true };
  } catch (error) {
    return { reason: error instanceof Error ? error.message : String(error) };
  }
}

function buildRealWakeDeps(): WakeSchedulerDeps {
  return {
    now: () => Date.now(),
    listPending: () => storeListPendingWakes(),
    setStatus: (id, status, now, reason) => { storeSetWakeStatus(id, status, now, reason); },
    recordPoll: (id, now) => { storeRecordWakePoll(id, now); },
    evaluateGuard: realGuardEvaluator,
    deliver: deliverWakeReal,
    concurrency: DEFAULT_WAKE_CONCURRENCY,
  };
}

interface WakeSchedulerSingleton {
  state: WakeSchedulerState;
  deps: WakeSchedulerDeps;
}

declare global {
  var __ompWakeScheduler: WakeSchedulerSingleton | undefined;
}

function getSingleton(): WakeSchedulerSingleton {
  if (!globalThis.__ompWakeScheduler) {
    globalThis.__ompWakeScheduler = { state: createWakeSchedulerState(), deps: buildRealWakeDeps() };
  }
  return globalThis.__ompWakeScheduler;
}

/**
 * Run one real wake tick. Called from the Routines scheduler's interval so the
 * two features share a single timer (lib/routine-scheduler.ts).
 */
export function tickWakes(): Promise<void> {
  const singleton = getSingleton();
  return runWakeTick(singleton.deps, singleton.state);
}
