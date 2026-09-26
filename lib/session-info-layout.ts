export interface SessionInfoGridLayout {
  columns: string;
  gap: number;
  /** Whether the session-info section spans the whole first row. */
  infoSpansRow: boolean;
}

/** Narrowest panel that fits the three-column layout without overflowing. */
export const SESSION_INFO_THREE_COLUMN_MIN_WIDTH = 800;
/** Narrowest panel that fits messages and tokens side by side. */
export const SESSION_INFO_TWO_COLUMN_MIN_WIDTH = 460;

const THREE_COLUMNS = "minmax(360px, 1.7fr) minmax(140px, 0.55fr) minmax(190px, 0.75fr)";
const TWO_COLUMNS = "minmax(0, 1fr) minmax(0, 1fr)";

/**
 * Pick the session-info popover's grid for the width it was actually given.
 * The three-column layout has a ~770px floor (column minimums, gaps and
 * padding), so a narrower panel — a small window, or a centre column squeezed
 * by the sidebar and file panel — falls back to two or one columns instead of
 * overflowing past the right edge.
 */
export function sessionInfoGridLayout(panelWidth: number, isMobile: boolean): SessionInfoGridLayout {
  if (isMobile || panelWidth < SESSION_INFO_TWO_COLUMN_MIN_WIDTH) {
    return { columns: "minmax(0, 1fr)", gap: 16, infoSpansRow: false };
  }
  if (panelWidth < SESSION_INFO_THREE_COLUMN_MIN_WIDTH) {
    return { columns: TWO_COLUMNS, gap: 20, infoSpansRow: true };
  }
  return { columns: THREE_COLUMNS, gap: 24, infoSpansRow: false };
}
