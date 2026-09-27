/**
 * Pure helper for pulling image files out of a paste (clipboard) event's items,
 * so the composer's onPaste can feed them through the same path as the
 * "Attach image" button. Kept DOM-free (aside from the structural item/file
 * shapes) so it can be unit-tested without a real ClipboardEvent.
 */

/** The subset of `DataTransferItem` this helper reads. */
export interface ClipboardItemLike {
  kind: string;
  type: string;
  getAsFile: () => File | null;
}

/**
 * Extract the image files from a paste event's items.
 *
 * A clipboard image can arrive as a `file` item whose `type` is empty (several
 * OSes/browsers do this for screenshots), so items are considered when they are
 * a file OR advertise an `image/*` type, and the final say is `isImage`, which
 * mirrors the composer's mime resolution (extension fallback included).
 */
export function extractPastedImageFiles(
  items: ClipboardItemLike[],
  isImage: (file: { name: string; type: string }) => boolean,
): File[] {
  return items
    .filter((item) => item.kind === "file" || item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null && isImage(file));
}
