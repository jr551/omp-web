import { stripAnsi } from "./ansi";

// Pure helpers shared by the collapsible command/bash execution blocks in
// MessageView. Command and shell blocks (bash tool calls, BashExecutionMessage,
// and any exec-style tool routed through the console renderer) render collapsed
// by default: only the command line plus a one-line status/preview shows until
// the block is expanded.

/** Command/bash execution blocks render collapsed by default. */
export const COMMAND_BLOCK_DEFAULT_EXPANDED = false;

/**
 * Resolves the effective initial expanded state for a console block, given any
 * per-block state persisted from a previous render/toggle. Defaults to collapsed
 * so a freshly-loaded transcript never shows every command's full output.
 */
export function initialCommandBlockExpanded(persisted: boolean | undefined): boolean {
  return persisted ?? COMMAND_BLOCK_DEFAULT_EXPANDED;
}

/**
 * The one-line preview shown next to the command while a console block is
 * collapsed: the first non-empty output line (ANSI stripped), trimmed to
 * `maxLen`. Empty string when there is no output yet.
 */
export function firstCommandOutputLine(output: string, maxLen = 120): string {
  if (!output) return "";
  for (const raw of output.split(/\r?\n/)) {
    const line = stripAnsi(raw).trim();
    if (line) return line.length > maxLen ? `${line.slice(0, maxLen - 1)}…` : line;
  }
  return "";
}
