// Pure helpers for the chat auto-scroll / auto-follow decision. Kept free of
// React and the DOM so the "should we stay pinned to the bottom?" logic can be
// unit-tested in isolation (see lib/chat-scroll.test.mjs). useAgentSession wires
// these to the live scroll container.

/**
 * How close to the bottom (in px) counts as "at the bottom" for the purpose of
 * resuming auto-follow. A small slack so sub-pixel rounding and a trailing
 * spacer element don't read as "scrolled up".
 */
export const AUTO_FOLLOW_BOTTOM_THRESHOLD_PX = 72;

/** Distance in px from the current scroll position to the very bottom. */
export function distanceFromBottom(scrollHeight: number, scrollTop: number, clientHeight: number): number {
  return scrollHeight - scrollTop - clientHeight;
}

/** True when the viewport is within `threshold` px of the bottom. */
export function isNearBottom(
  scrollHeight: number,
  scrollTop: number,
  clientHeight: number,
  threshold: number = AUTO_FOLLOW_BOTTOM_THRESHOLD_PX,
): boolean {
  return distanceFromBottom(scrollHeight, scrollTop, clientHeight) <= threshold;
}

/**
 * The next auto-follow state after a scroll event.
 * - Reaching the bottom always re-arms following (even from a paused state).
 * - Otherwise a scroll the user actually drove pauses following.
 * - A purely programmatic scroll that is not near the bottom leaves the state
 *   unchanged, so streaming re-scrolls can't flip a user's paused state back on.
 */
export function computeAutoFollow(
  current: boolean,
  opts: { distanceFromBottom: number; userDriven: boolean; threshold?: number },
): boolean {
  const threshold = opts.threshold ?? AUTO_FOLLOW_BOTTOM_THRESHOLD_PX;
  if (opts.distanceFromBottom <= threshold) return true;
  if (opts.userDriven) return false;
  return current;
}
