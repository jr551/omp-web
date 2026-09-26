"use client";

import { type RefObject, useCallback, useEffect, useRef, useSyncExternalStore } from "react";

/*
 * Reveal the left sidebar / right file panel when a mouse pointer rests at the
 * matching screen edge (issue #53).
 *
 * The decisions live in `stepEdgeReveal()`, a pure state machine driven by
 * pointer samples and clock ticks, so the dwell/grace timing is unit-tested
 * without a DOM. `useEdgeReveal()` only feeds it events and applies the
 * resulting open/close actions.
 */

export type EdgeSide = "left" | "right";

export interface EdgeRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface EdgePanelSnapshot {
  open: boolean;
  /** On-screen box of the panel, used to tell whether the pointer is still on it. */
  rect: EdgeRect | null;
}

export type EdgePanels = Record<EdgeSide, EdgePanelSnapshot>;

export interface EdgeRevealConfig {
  /** Width of the activation strip at each screen edge. */
  stripPx: number;
  /** How long the pointer must rest in the strip before the panel opens. */
  dwellMs: number;
  /** How long a hover-opened panel survives after the pointer leaves it. */
  graceMs: number;
  /** Slack around the panel box (covers its resize handle). */
  panelTolerancePx: number;
}

export const DEFAULT_EDGE_REVEAL_CONFIG: EdgeRevealConfig = {
  stripPx: 6,
  dwellMs: 300,
  graceMs: 400,
  panelTolerancePx: 12,
};

export interface EdgeRevealState {
  /** Pointer resting in an edge strip, and when that becomes an open. */
  dwell: { side: EdgeSide; deadline: number } | null;
  /**
   * Panels opened by hover (and not pinned since). `closeDeadline` is set
   * while the pointer is away from the panel; `seenOpen` records that the
   * open has been applied, so a panel still waiting for its re-render is not
   * mistaken for one the user closed.
   */
  hover: Record<EdgeSide, HoverEntry | null>;
}

export interface HoverEntry {
  closeDeadline: number | null;
  seenOpen: boolean;
}

export const INITIAL_EDGE_REVEAL_STATE: EdgeRevealState = {
  dwell: null,
  hover: { left: null, right: null },
};

export type EdgeRevealInput =
  | {
    type: "move";
    now: number;
    x: number;
    y: number;
    viewportWidth: number;
    panels: EdgePanels;
    /** False while a button is held, a modal is open, or over a control/scrollbar. */
    eligible: boolean;
  }
  | { type: "tick"; now: number; panels: EdgePanels }
  /** The pointer left the window or the window lost focus. */
  | { type: "leave"; now: number; panels: EdgePanels }
  /** The user interacted with a hover-opened panel, or used its toggle button. */
  | { type: "pin"; side: EdgeSide };

export interface EdgeRevealAction {
  type: "open" | "close";
  side: EdgeSide;
}

export interface EdgeRevealStep {
  state: EdgeRevealState;
  actions: EdgeRevealAction[];
}

const SIDES: readonly EdgeSide[] = ["left", "right"];

/** Which edge strip, if any, contains `x`. */
export function edgeZoneAt(x: number, viewportWidth: number, stripPx: number): EdgeSide | null {
  if (viewportWidth <= stripPx * 2) return null;
  if (x <= stripPx - 1) return "left";
  if (x >= viewportWidth - stripPx) return "right";
  return null;
}

function containsPoint(rect: EdgeRect | null, x: number, y: number, tolerance: number): boolean {
  return rect !== null
    && x >= rect.left - tolerance && x <= rect.right + tolerance
    && y >= rect.top - tolerance && y <= rect.bottom + tolerance;
}

/** Forget hover ownership of panels that were closed by something else. */
function syncWithPanels(state: EdgeRevealState, panels: EdgePanels): EdgeRevealState {
  let hover = state.hover;
  for (const side of SIDES) {
    const entry = hover[side];
    if (!entry) continue;
    if (!panels[side].open) {
      if (entry.seenOpen) hover = { ...hover, [side]: null };
    } else if (!entry.seenOpen) {
      hover = { ...hover, [side]: { ...entry, seenOpen: true } };
    }
  }
  const dwell = state.dwell && panels[state.dwell.side].open ? null : state.dwell;
  return hover === state.hover && dwell === state.dwell ? state : { dwell, hover };
}

/** Fire the dwell and grace deadlines that have passed. */
function fireDue(state: EdgeRevealState, now: number, actions: EdgeRevealAction[]): EdgeRevealState {
  let { dwell, hover } = state;
  for (const side of SIDES) {
    const entry = hover[side];
    if (entry?.closeDeadline !== null && entry?.closeDeadline !== undefined && entry.closeDeadline <= now) {
      actions.push({ type: "close", side });
      hover = { ...hover, [side]: null };
    }
  }
  if (dwell && dwell.deadline <= now) {
    actions.push({ type: "open", side: dwell.side });
    hover = { ...hover, [dwell.side]: { closeDeadline: null, seenOpen: false } };
    dwell = null;
  }
  return dwell === state.dwell && hover === state.hover ? state : { dwell, hover };
}

export function stepEdgeReveal(
  current: EdgeRevealState,
  input: EdgeRevealInput,
  config: EdgeRevealConfig = DEFAULT_EDGE_REVEAL_CONFIG,
): EdgeRevealStep {
  const actions: EdgeRevealAction[] = [];

  if (input.type === "pin") {
    if (!current.hover[input.side]) return { state: current, actions };
    return { state: { ...current, hover: { ...current.hover, [input.side]: null } }, actions };
  }

  let state = syncWithPanels(current, input.panels);

  if (input.type === "leave") {
    // Leaving the window through an edge (e.g. to a second monitor) must not
    // count as resting on it. A hover-opened panel is left alone: the pointer
    // is not over the rest of the page either.
    if (state.dwell) state = { ...state, dwell: null };
    return { state: fireDue(state, input.now, actions), actions };
  }

  if (input.type === "move") {
    const { now, x, y } = input;
    const zone = edgeZoneAt(x, input.viewportWidth, config.stripPx);

    let hover = state.hover;
    for (const side of SIDES) {
      const entry = hover[side];
      if (!entry) continue;
      const onPanel = zone === side || containsPoint(input.panels[side].rect, x, y, config.panelTolerancePx);
      if (onPanel && entry.closeDeadline !== null) {
        hover = { ...hover, [side]: { ...entry, closeDeadline: null } };
      } else if (!onPanel && entry.closeDeadline === null) {
        hover = { ...hover, [side]: { ...entry, closeDeadline: now + config.graceMs } };
      }
    }

    let dwell = state.dwell;
    if (input.eligible && zone && !input.panels[zone].open) {
      if (dwell?.side !== zone) dwell = { side: zone, deadline: now + config.dwellMs };
    } else {
      dwell = null;
    }

    if (hover !== state.hover || dwell !== state.dwell) state = { dwell, hover };
    return { state: fireDue(state, now, actions), actions };
  }

  return { state: fireDue(state, input.now, actions), actions };
}

/** Earliest pending deadline, so the hook can schedule a single tick. */
export function nextEdgeRevealDeadline(state: EdgeRevealState): number | null {
  const deadlines = [
    state.dwell?.deadline,
    state.hover.left?.closeDeadline,
    state.hover.right?.closeDeadline,
  ].filter((value): value is number => typeof value === "number");
  return deadlines.length ? Math.min(...deadlines) : null;
}

// ---------------------------------------------------------------------------
// Preference: localStorage-backed, on by default.

export const EDGE_REVEAL_STORAGE_KEY = "omp-edge-reveal";

const enabledListeners = new Set<() => void>();

function readEnabled(): boolean {
  try {
    return window.localStorage.getItem(EDGE_REVEAL_STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

function subscribeEnabled(cb: () => void): () => void {
  enabledListeners.add(cb);
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === EDGE_REVEAL_STORAGE_KEY) cb();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    enabledListeners.delete(cb);
    window.removeEventListener("storage", onStorage);
  };
}

export function setEdgeRevealEnabled(enabled: boolean): void {
  try {
    window.localStorage.setItem(EDGE_REVEAL_STORAGE_KEY, String(enabled));
  } catch {
    // Storage unavailable (private mode): the toggle still applies to this tab.
  }
  enabledListeners.forEach((cb) => cb());
}

/** Whether edge-hover reveal is enabled (default on). */
export function useEdgeRevealEnabled(): boolean {
  return useSyncExternalStore(subscribeEnabled, readEnabled, () => true);
}

// Only a real hovering mouse/trackpad can "rest" at an edge.
const FINE_POINTER_QUERY = "(hover: hover) and (pointer: fine)";

function subscribeFinePointer(cb: () => void): () => void {
  if (!window.matchMedia) return () => {};
  const mql = window.matchMedia(FINE_POINTER_QUERY);
  mql.addEventListener("change", cb);
  return () => mql.removeEventListener("change", cb);
}

function readFinePointer(): boolean {
  return window.matchMedia?.(FINE_POINTER_QUERY).matches ?? false;
}

export function useFinePointer(): boolean {
  return useSyncExternalStore(subscribeFinePointer, readFinePointer, () => false);
}

// ---------------------------------------------------------------------------
// Hook

export interface UseEdgeRevealOptions {
  /** Master switch: the user preference, and false on the mobile layout. */
  active: boolean;
  /** Temporarily ignore the edges (e.g. while a modal is open). */
  suspended?: boolean;
  leftOpen: boolean;
  rightOpen: boolean;
  leftPanelRef: RefObject<HTMLElement | null>;
  rightPanelRef: RefObject<HTMLElement | null>;
  /** Open/close a panel. Should be stable callbacks. */
  onReveal: (side: EdgeSide) => void;
  onConceal: (side: EdgeSide) => void;
  config?: EdgeRevealConfig;
}

export interface EdgeRevealControls {
  /**
   * Pin a hover-opened panel so it stays open. Returns true when the panel was
   * hover-opened — a toggle button should then keep it open instead of closing.
   * Stable across renders.
   */
  pinIfRevealed: (side: EdgeSide) => boolean;
}

const INTERACTIVE_SELECTOR = "button, a[href], input, textarea, select, summary, [role='button'], [contenteditable='true'], [data-resize-handle]";

/** True when (x, y) is over a scrollbar of `target` (dragging it must not open a panel). */
function isOverScrollbar(target: Element, x: number, y: number): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const rect = target.getBoundingClientRect();
  // Gutter = outer minus inner size; borders alone (a pixel or two) are not a scrollbar.
  const verticalBar = target.offsetWidth - target.clientWidth - target.clientLeft;
  const horizontalBar = target.offsetHeight - target.clientHeight - target.clientTop;
  return (verticalBar > 2 && x >= rect.left + target.clientLeft + target.clientWidth)
    || (horizontalBar > 2 && y >= rect.top + target.clientTop + target.clientHeight);
}

function rectOf(ref: RefObject<HTMLElement | null>): EdgeRect | null {
  const rect = ref.current?.getBoundingClientRect();
  return rect && rect.width > 0 ? { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom } : null;
}

export function useEdgeReveal(options: UseEdgeRevealOptions): EdgeRevealControls {
  const finePointer = useFinePointer();
  const listening = options.active && finePointer;

  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });
  const stateRef = useRef<EdgeRevealState>(INITIAL_EDGE_REVEAL_STATE);

  const readPanels = useCallback((): EdgePanels => {
    const current = optionsRef.current;
    return {
      left: { open: current.leftOpen, rect: current.leftOpen ? rectOf(current.leftPanelRef) : null },
      right: { open: current.rightOpen, rect: current.rightOpen ? rectOf(current.rightPanelRef) : null },
    };
  }, []);

  const pinIfRevealed = useCallback((side: EdgeSide): boolean => {
    const wasRevealed = stateRef.current.hover[side] !== null;
    stateRef.current = stepEdgeReveal(stateRef.current, { type: "pin", side }).state;
    return wasRevealed;
  }, []);

  useEffect(() => {
    if (!listening) {
      stateRef.current = INITIAL_EDGE_REVEAL_STATE;
      return;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;

    const apply = (input: EdgeRevealInput) => {
      const current = optionsRef.current;
      const { state, actions } = stepEdgeReveal(stateRef.current, input, current.config);
      stateRef.current = state;
      for (const action of actions) {
        if (action.type === "open") current.onReveal(action.side);
        else current.onConceal(action.side);
      }
      if (timer !== null) clearTimeout(timer);
      timer = null;
      const deadline = nextEdgeRevealDeadline(state);
      if (deadline !== null) {
        timer = setTimeout(() => {
          timer = null;
          apply({ type: "tick", now: performance.now(), panels: readPanels() });
        }, Math.max(0, deadline - performance.now()));
      }
    };

    const isEligible = (event: PointerEvent): boolean => {
      if (event.buttons !== 0 || optionsRef.current.suspended) return false;
      if (document.querySelector("[aria-modal='true']")) return false;
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return true;
      return !target.closest(INTERACTIVE_SELECTOR) && !isOverScrollbar(target, event.clientX, event.clientY);
    };

    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") return;
      const viewportWidth = window.innerWidth;
      const config = optionsRef.current.config ?? DEFAULT_EDGE_REVEAL_CONFIG;
      const state = stateRef.current;
      const zone = edgeZoneAt(event.clientX, viewportWidth, config.stripPx);
      // Fast path: nothing to track away from the edges when no panel is hover-open.
      if (!zone && !state.dwell && !state.hover.left && !state.hover.right) return;
      apply({
        type: "move",
        now: performance.now(),
        x: event.clientX,
        y: event.clientY,
        viewportWidth,
        panels: readPanels(),
        eligible: zone !== null && isEligible(event),
      });
    };

    const onLeave = () => apply({ type: "leave", now: performance.now(), panels: readPanels() });
    const onMouseOut = (event: MouseEvent) => {
      if (event.relatedTarget === null) onLeave();
    };

    // Clicking or typing inside a hover-opened panel means the user is using
    // it: keep it open until they close it themselves.
    const pinFromEvent = (event: Event) => {
      const target = event.target instanceof Node ? event.target : null;
      if (!target) return;
      const current = optionsRef.current;
      const handle = target instanceof Element ? target.closest("[data-resize-handle]")?.getAttribute("data-resize-handle") : null;
      if (handle === "sidebar" || current.leftPanelRef.current?.contains(target)) pinIfRevealed("left");
      if (handle === "right-panel" || current.rightPanelRef.current?.contains(target)) pinIfRevealed("right");
    };

    document.addEventListener("pointermove", onPointerMove, { passive: true });
    document.addEventListener("mouseout", onMouseOut);
    document.addEventListener("pointerdown", pinFromEvent, true);
    document.addEventListener("keydown", pinFromEvent, true);
    window.addEventListener("blur", onLeave);
    return () => {
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("mouseout", onMouseOut);
      document.removeEventListener("pointerdown", pinFromEvent, true);
      document.removeEventListener("keydown", pinFromEvent, true);
      window.removeEventListener("blur", onLeave);
      if (timer !== null) clearTimeout(timer);
      stateRef.current = INITIAL_EDGE_REVEAL_STATE;
    };
  }, [listening, pinIfRevealed, readPanels]);

  return { pinIfRevealed };
}
