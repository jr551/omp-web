import { tmpdir } from "os";
import { resolve, sep } from "path";

/**
 * Display label for "scratch" project groups in the sidebar — sessions that live
 * in a throwaway default working directory rather than a real project.
 */
export const SCRATCH_PROJECT_LABEL = "Non Project Related";

function isInside(candidate: string, root: string): boolean {
  const normalizedCandidate = resolve(candidate);
  const normalizedRoot = resolve(root);
  if (normalizedCandidate === normalizedRoot) return true;
  const rootWithSep = normalizedRoot.endsWith(sep) ? normalizedRoot : normalizedRoot + sep;
  return normalizedCandidate.startsWith(rootWithSep);
}

/**
 * Whether a project root is a scratch/default working directory:
 *  - the `~/omp-cwd-YYYYMMDD` default dir created by /api/default-cwd, or
 *  - anything under the OS temp dir (`/tmp`, `os.tmpdir()`).
 *
 * These are grouped as "Non Project Related", pinned to the top of the sidebar.
 */
export function isScratchProjectRoot(
  path: string | null | undefined,
  home: string = homeDirSafe(),
  temp: string = tmpdir(),
): boolean {
  if (!path) return false;
  const resolved = resolve(path);

  // The default working directory: <home>/omp-cwd-YYYYMMDD
  if (home && /(?:^|[\\/])omp-cwd-\d{8}$/.test(resolved) && isInside(resolved, home)) {
    return true;
  }

  // Anything under the OS temp dir.
  if (temp && isInside(resolved, temp)) return true;

  return false;
}

function homeDirSafe(): string {
  try {
    // Lazy import to keep this module usable in tests that pass explicit args.
    return process.env.HOME ?? process.env.USERPROFILE ?? "";
  } catch {
    return "";
  }
}
