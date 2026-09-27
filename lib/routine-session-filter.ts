/**
 * Pure helper shared by the sidebar: hide routine-RUN sessions from the normal
 * session list.
 *
 * Each routine run creates a fresh session (lib/routine-runner.ts) whose id is
 * tracked in a persistent set (lib/routine-store.ts, exposed via GET
 * /api/routines as `routineSessionIds`). Those sessions clutter the sidebar, so
 * the list filters them out in BOTH project groups and the "Non Project Related"
 * group. They stay reachable by id via the routine activity view's "Open
 * transcript" (which fetches /api/sessions directly).
 *
 * IMPORTANT: only routine-RUN fresh sessions are hidden. A smartwake re-enters
 * the worker's OWN existing session (never a routine-fresh one), so those are
 * normal user sessions and are never in the set — they stay visible.
 *
 * Generic over `{ id }` so it is trivially unit-testable with plain objects.
 */
export function hideRoutineSessions<T extends { id: string }>(
  sessions: readonly T[],
  routineSessionIds: ReadonlySet<string>,
): T[] {
  if (routineSessionIds.size === 0) return [...sessions];
  return sessions.filter((session) => !routineSessionIds.has(session.id));
}
