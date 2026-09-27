import { resolveLocalFileHref } from "./file-links";
import { encodeFilePathForApi } from "./file-paths";

/**
 * Resolve a markdown image `src` to something the browser can actually load.
 *
 * A local filesystem path (absolute, `file:` URL, or a relative path under the
 * session cwd) is routed through `/api/files`, the same mechanism markdown file
 * links already use, so images produced by the agent referencing on-disk files
 * render inline. Remote URLs (http/https, data:) and anything that does not
 * resolve to a local file are passed through unchanged.
 */
export function resolveMarkdownImageSrc(
  src: string | undefined,
  cwd?: string,
): string | undefined {
  if (typeof src !== "string" || src.length === 0) return src;
  const filePath = resolveLocalFileHref(src, cwd);
  if (!filePath) return src;
  return `/api/files/${encodeFilePathForApi(filePath)}?type=read`;
}
