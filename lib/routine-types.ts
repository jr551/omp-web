/**
 * Client-safe types and bounds for the Routines scheduler.
 *
 * This module has no server-only imports (no `fs`, no omp SDK), so both the
 * server store (lib/routine-store.ts) and the browser UI can import it.
 */

export const MIN_EXECUTION_MS = 10_000; // 10s
export const MAX_EXECUTION_MS = 2 * 60 * 60 * 1000; // 2h
export const DEFAULT_EXECUTION_MS = 15 * 60 * 1000; // 15m

export const MIN_GUARD_INTERVAL_MS = 30_000; // 30s
export const MAX_GUARD_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h
export const DEFAULT_GUARD_INTERVAL_MS = 5 * 60 * 1000; // 5m

export const MIN_GUARD_TIMEOUT_MS = 1_000; // 1s
export const MAX_GUARD_TIMEOUT_MS = 5 * 60 * 1000; // 5m
export const DEFAULT_GUARD_TIMEOUT_MS = 30_000; // 30s

export const HISTORY_CAP = 20;

export type RoutineRunStatus = "running" | "success" | "error" | "timeout" | "skipped";

export interface RoutineRun {
  id: string;
  startedAt: string;
  finishedAt?: string;
  status: RoutineRunStatus;
  summary: string;
  sessionId?: string;
  error?: string;
}

export type RoutineTrigger =
  | { type: "cron"; schedule: string }
  | {
      type: "guard";
      intervalMs: number;
      command: string;
      guardTimeoutMs: number;
      expectOutputMatches?: string;
    }
  | { type: "webhook"; token: string };

export interface Routine {
  id: string;
  name: string;
  cwd: string;
  trigger: RoutineTrigger;
  prompt: string;
  provider?: string;
  modelId?: string;
  maxExecutionMs: number;
  enabled: boolean;
  /** Optional outgoing webhook to ask the user a question during a headless run. */
  askWebhookUrl?: string;
  createdAt: string;
  updatedAt: string;
  lastRun?: RoutineRun;
  history?: RoutineRun[];
}

/** A routine plus live scheduler state, as returned by the API. */
export interface RoutineWithStatus extends Routine {
  running: boolean;
  /** Full incoming webhook URL for webhook-triggered routines (never the token alone elsewhere). */
  webhookUrl?: string;
}

export interface RoutinesListResponse {
  routines: RoutineWithStatus[];
  /** Session ids created by routine runs, hidden from the normal session list. */
  routineSessionIds?: string[];
}
