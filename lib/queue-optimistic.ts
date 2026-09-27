/**
 * Optimistic reconciliation for the steer / follow-up message queue.
 *
 * Queuing a message while the agent is generating used to only appear after the
 * network round-trip returned the authoritative queue (via the `queue_update`
 * SSE event), which felt laggy. Instead the queued message is added optimistically
 * and shown instantly; the network call runs in the background and, when the
 * server's queue arrives, the optimistic entry is reconciled away without
 * duplicating it.
 *
 * Pure and framework-free so the add-then-reconcile logic can be unit-tested.
 */

/** A queued message the client has shown before the server confirmed it. */
export interface OptimisticQueueEntry {
  /** Client-only temp id used to roll back on failure. */
  id: string;
  kind: "steering" | "followUp";
  text: string;
}

/** The steer/follow-up queue as the UI renders it. */
export interface QueueSnapshot {
  steering: string[];
  followUp: string[];
}

const EMPTY: QueueSnapshot = { steering: [], followUp: [] };

/**
 * The visible queue: the server's authoritative entries followed by any
 * still-pending optimistic entries, preserving insertion order per kind.
 */
export function mergeQueued(
  server: QueueSnapshot | null | undefined,
  pending: readonly OptimisticQueueEntry[],
): QueueSnapshot {
  const base = server ?? EMPTY;
  const pendingOf = (kind: OptimisticQueueEntry["kind"]) =>
    pending.filter((entry) => entry.kind === kind).map((entry) => entry.text);
  return {
    steering: [...base.steering, ...pendingOf("steering")],
    followUp: [...base.followUp, ...pendingOf("followUp")],
  };
}

/**
 * Drop pending entries the server now reports (matched greedily by kind + text,
 * one server slot per pending entry so duplicate texts reconcile one at a time),
 * returning the entries still awaiting confirmation.
 */
/**
 * Remove a single queued entry whose (trimmed) text matches `text`, used when pi
 * delivers a queued steer/follow-up as a chat message but does not emit a
 * follow-up `queue_update` shrinking the queue.
 *
 * A server slot is preferred over a pending optimistic entry (the server is the
 * authority); only one entry is dropped per call so duplicate texts disappear
 * one delivery at a time. When nothing matches the queue is returned unchanged.
 */
export function dropOneQueued(
  server: QueueSnapshot | null | undefined,
  pending: readonly OptimisticQueueEntry[],
  text: string,
): { server: QueueSnapshot; pending: OptimisticQueueEntry[] } {
  const base = server ?? EMPTY;
  const target = text.trim();
  const nextServer: QueueSnapshot = {
    steering: [...base.steering],
    followUp: [...base.followUp],
  };

  // Prefer a server slot, checking steering then follow-up.
  for (const kind of ["steering", "followUp"] as const) {
    const index = nextServer[kind].findIndex((entry) => entry.trim() === target);
    if (index >= 0) {
      nextServer[kind].splice(index, 1);
      return { server: nextServer, pending: [...pending] };
    }
  }

  // Otherwise drop the first matching pending optimistic entry.
  const pendingIndex = pending.findIndex((entry) => entry.text.trim() === target);
  if (pendingIndex >= 0) {
    const nextPending = [...pending];
    nextPending.splice(pendingIndex, 1);
    return { server: nextServer, pending: nextPending };
  }

  // No match — leave the queue untouched.
  return { server: nextServer, pending: [...pending] };
}

export function reconcilePending(
  pending: readonly OptimisticQueueEntry[],
  server: QueueSnapshot | null | undefined,
): OptimisticQueueEntry[] {
  const base = server ?? EMPTY;
  const available: Record<OptimisticQueueEntry["kind"], string[]> = {
    steering: [...base.steering],
    followUp: [...base.followUp],
  };
  const remaining: OptimisticQueueEntry[] = [];
  for (const entry of pending) {
    const slots = available[entry.kind];
    const index = slots.indexOf(entry.text);
    if (index >= 0) {
      slots.splice(index, 1); // confirmed by the server — drop from pending
    } else {
      remaining.push(entry);
    }
  }
  return remaining;
}
