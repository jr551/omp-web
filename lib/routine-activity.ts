/**
 * Pure helpers for the Routine activity view (components/RoutineActivityView.tsx).
 *
 * Kept filesystem/React-free so the ordering and scroll-target logic can be
 * unit tested with plain objects (lib/routine-activity.test.mjs).
 */

import type { RoutineRun } from "./routine-types";

/** DOM id used to scroll to a specific run inside the activity view. */
export function runScrollTargetId(runId: string): string {
  return `routine-run-${runId}`;
}

/**
 * Runs newest-first: by finishedAt (or startedAt when still running), falling
 * back to startedAt, then id for a stable order. Does not mutate the input.
 */
export function sortRunsNewestFirst(runs: readonly RoutineRun[]): RoutineRun[] {
  return [...runs].sort((a, b) => {
    const ta = runTimestamp(a);
    const tb = runTimestamp(b);
    if (tb !== ta) return tb - ta;
    return b.id.localeCompare(a.id);
  });
}

function runTimestamp(run: RoutineRun): number {
  const source = run.finishedAt ?? run.startedAt;
  const parsed = Date.parse(source);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Human duration of a run ("12s", "3m 4s", "1h 2m"), or null when it has not
 * finished or the timestamps are unusable.
 */
export function formatRunDuration(run: RoutineRun): string | null {
  if (!run.finishedAt) return null;
  const start = Date.parse(run.startedAt);
  const end = Date.parse(run.finishedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  const totalSec = Math.round((end - start) / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  if (minutes < 60) return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes ? `${hours}h ${remMinutes}m` : `${hours}h`;
}

/** The most recent run's session id, if any run recorded one (newest wins). */
export function latestRunSessionId(runs: readonly RoutineRun[]): string | undefined {
  for (const run of sortRunsNewestFirst(runs)) {
    if (run.sessionId) return run.sessionId;
  }
  return undefined;
}
