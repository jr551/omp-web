export type PopupSide = "above" | "below";

export interface PopupPlacement {
  side: PopupSide;
  maxHeight: number;
}

export const POPUP_GAP_PX = 8;
export const POPUP_VIEWPORT_MARGIN_PX = 8;
export const POPUP_MIN_HEIGHT_PX = 120;

export interface PopupPlacementOptions {
  /** Distance between the anchor and the popup. */
  gap?: number;
  /** Space kept between the popup and the viewport edge. */
  margin?: number;
  /** Never shrink below this, so a cramped popup still shows something. */
  minHeight?: number;
  /** Side to use whenever it can hold the popup. */
  prefer?: PopupSide;
}

/**
 * Pick the side of an anchor with room for a popup and cap its height to the
 * space actually available there. Anchor coordinates are viewport-relative
 * (as returned by getBoundingClientRect), so this accounts for browser zoom
 * and, when `viewportHeight` comes from visualViewport, for on-screen
 * keyboards too.
 */
export function computePopupPlacement(
  anchorTop: number,
  anchorBottom: number,
  viewportHeight: number,
  preferredMaxHeight: number,
  options: PopupPlacementOptions = {},
): PopupPlacement {
  const gap = options.gap ?? POPUP_GAP_PX;
  const margin = options.margin ?? POPUP_VIEWPORT_MARGIN_PX;
  const prefer = options.prefer ?? "above";
  // A viewport too short for the floor gets the whole viewport instead, rather
  // than a popup that reaches past both edges.
  const floor = Math.min(options.minHeight ?? POPUP_MIN_HEIGHT_PX, Math.max(0, viewportHeight - margin * 2));

  const spaceAbove = Math.max(0, anchorTop - gap - margin);
  const spaceBelow = Math.max(0, viewportHeight - anchorBottom - gap - margin);
  const preferredSpace = prefer === "above" ? spaceAbove : spaceBelow;
  const otherSpace = prefer === "above" ? spaceBelow : spaceAbove;

  // Stay on the preferred side unless it cannot fit the popup and the other
  // side has more room; flipping for a marginal gain only makes it jumpy.
  const keepPreferred = preferredSpace >= preferredMaxHeight || preferredSpace >= otherSpace;
  const side: PopupSide = keepPreferred ? prefer : (prefer === "above" ? "below" : "above");
  const space = keepPreferred ? preferredSpace : otherSpace;

  return { side, maxHeight: Math.max(floor, Math.min(preferredMaxHeight, space)) };
}

/** Preferred height as a share of the viewport, capped at an absolute value. */
export function preferredPopupHeight(viewportHeight: number, viewportFraction: number, cap: number): number {
  return Math.min(viewportHeight * viewportFraction, cap);
}

export interface PanelAnchorRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** Visible viewport, in the same (layout-viewport) coordinates as getBoundingClientRect. */
export interface PanelViewport {
  width: number;
  height: number;
  /** visualViewport.offsetTop — non-zero while a mobile keyboard pans the page. */
  offsetTop?: number;
  offsetLeft?: number;
}

export interface AnchoredPanelOptions extends PopupPlacementOptions {
  /** Desired width. Defaults to the anchor width (a panel that spans its trigger bar). */
  preferredWidth?: number;
  /** Desired height before clamping to the space available. Defaults to all of it. */
  preferredMaxHeight?: number;
  /** Anchor edge the panel lines up with when it is narrower than the anchor. */
  align?: "start" | "end";
  /** Horizontal room kept free at the viewport edges. */
  horizontalMargin?: number;
  /** Extra horizontal limits (e.g. the top bar) the panel must stay inside. */
  bounds?: { left: number; right: number };
}

export interface AnchoredPanelRect {
  side: PopupSide;
  /** Set when the panel opens below the anchor. */
  top?: number;
  /** Set when the panel opens above the anchor (distance from the layout viewport bottom). */
  bottom?: number;
  left: number;
  width: number;
  maxHeight: number;
}

/**
 * Size and place a fixed-position panel next to an anchor so it never leaves
 * the visible viewport: its width is clamped to the viewport (and optional
 * bounds), it is shifted back inside when it would run past either edge, and
 * its height is capped to the room on the side it opens on — below the anchor
 * by default, flipping above only when that side is roomier. Content taller
 * than `maxHeight` is expected to scroll inside the panel.
 */
export function computeAnchoredPanelRect(
  anchor: PanelAnchorRect,
  viewport: PanelViewport,
  options: AnchoredPanelOptions = {},
): AnchoredPanelRect {
  const hMargin = Math.max(0, options.horizontalMargin ?? 0);
  const offsetLeft = viewport.offsetLeft ?? 0;
  const offsetTop = viewport.offsetTop ?? 0;
  let minLeft = offsetLeft + hMargin;
  let maxRight = offsetLeft + viewport.width - hMargin;
  if (options.bounds) {
    minLeft = Math.max(minLeft, options.bounds.left);
    maxRight = Math.min(maxRight, options.bounds.right);
  }
  const room = Math.max(0, maxRight - minLeft);
  let left: number;
  let width: number;
  if (options.preferredWidth === undefined) {
    // Spanning panel: keep the part of the anchor that is actually on screen.
    const visibleLeft = Math.max(anchor.left, minLeft);
    const visibleRight = Math.min(anchor.right, maxRight);
    if (visibleRight > visibleLeft) {
      left = visibleLeft;
      width = visibleRight - visibleLeft;
    } else {
      left = minLeft;
      width = room;
    }
  } else {
    width = Math.max(0, Math.min(options.preferredWidth, room));
    const desiredLeft = options.align === "end" ? anchor.right - width : anchor.left;
    left = Math.min(Math.max(desiredLeft, minLeft), Math.max(minLeft, maxRight - width));
  }

  // Vertical math runs in visual-viewport coordinates so an on-screen keyboard
  // (which shrinks and pans the visual viewport) is accounted for.
  const gap = options.gap ?? POPUP_GAP_PX;
  const placement = computePopupPlacement(
    anchor.top - offsetTop,
    anchor.bottom - offsetTop,
    viewport.height,
    options.preferredMaxHeight ?? viewport.height,
    { ...options, gap, prefer: options.prefer ?? "below" },
  );
  if (placement.side === "below") {
    return { side: "below", top: anchor.bottom + gap, left, width, maxHeight: placement.maxHeight };
  }
  const layoutBottom = offsetTop + viewport.height;
  return { side: "above", bottom: Math.max(0, layoutBottom - anchor.top + gap), left, width, maxHeight: placement.maxHeight };
}

/** Read the visible viewport in the form `computeAnchoredPanelRect` accepts. */
export function readPanelViewport(): PanelViewport {
  const visual = window.visualViewport;
  return visual
    ? { width: visual.width, height: visual.height, offsetTop: visual.offsetTop, offsetLeft: visual.offsetLeft }
    : { width: window.innerWidth, height: window.innerHeight };
}

export function sameAnchoredPanelRect(a: AnchoredPanelRect | null, b: AnchoredPanelRect | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.side === b.side && a.top === b.top && a.bottom === b.bottom
    && a.left === b.left && a.width === b.width && a.maxHeight === b.maxHeight;
}
