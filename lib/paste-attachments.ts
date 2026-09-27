/**
 * Pure helpers for the composer's "paste as attachment" behaviour.
 *
 * Pasting a large blob of text into the composer used to dump the whole thing
 * inline, burying whatever the user actually wanted to type. Above a threshold
 * the paste becomes a "pasted text" chip instead (mirroring the image
 * attachment chips) and is folded back into the outgoing message as a fenced
 * block on send. Small pastes stay inline as before.
 *
 * Everything here is deliberately framework-free so it can be unit-tested
 * without a DOM.
 */

/** A paste large enough to become an attachment rather than inline text. */
export const PASTE_ATTACH_CHAR_THRESHOLD = 2000;
/** A paste with more than this many lines also becomes an attachment. */
export const PASTE_ATTACH_LINE_THRESHOLD = 15;

export interface PastedText {
  /** Client-only temp id; these are never persisted. */
  id: string;
  text: string;
}

/** Number of lines in `text` (a trailing newline does not add an empty line). */
export function countLines(text: string): number {
  if (text === "") return 0;
  const withoutTrailingNewline = text.endsWith("\n") ? text.slice(0, -1) : text;
  return withoutTrailingNewline.split("\n").length;
}

export interface PastedTextStats {
  chars: number;
  lines: number;
}

export function pastedTextStats(text: string): PastedTextStats {
  return { chars: text.length, lines: countLines(text) };
}

/**
 * Whether a pasted string is big enough to attach instead of inserting inline.
 * True when it exceeds the char threshold or the line threshold.
 */
export function shouldAttachPastedText(text: string): boolean {
  if (!text) return false;
  if (text.length > PASTE_ATTACH_CHAR_THRESHOLD) return true;
  return countLines(text) > PASTE_ATTACH_LINE_THRESHOLD;
}

/** A short single-line preview of a pasted attachment for the chip. */
export function pastedTextPreview(text: string, maxChars = 72): string {
  const firstLine = text.split("\n", 1)[0]?.trim() ?? "";
  const source = firstLine || text.trim();
  if (source.length <= maxChars) return source;
  return `${source.slice(0, maxChars - 1).trimEnd()}…`;
}

/**
 * Wrap text in a fenced block whose fence is always longer than any run of
 * backticks inside it, so pasted markdown / code cannot break out of the fence.
 */
export function fencePastedText(text: string): string {
  const longestBacktickRun = (text.match(/`+/g) ?? []).reduce(
    (max, run) => Math.max(max, run.length),
    0,
  );
  const fence = "`".repeat(Math.max(3, longestBacktickRun + 1));
  const body = text.replace(/\n+$/, "");
  return `${fence}\n${body}\n${fence}`;
}

/**
 * Fold pasted-text attachments into the outgoing message. Attachments are
 * prepended as fenced blocks, in order, followed by whatever the user typed.
 * With no attachments the message is returned unchanged.
 */
export function assembleMessageWithPastedTexts(
  message: string,
  attachments: PastedText[],
): string {
  const usable = attachments.filter((attachment) => attachment.text.trim().length > 0);
  if (usable.length === 0) return message;
  const blocks = usable.map((attachment) => fencePastedText(attachment.text)).join("\n\n");
  const trimmedMessage = message.trim();
  return trimmedMessage ? `${blocks}\n\n${trimmedMessage}` : blocks;
}
