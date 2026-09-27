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

/**
 * A sidebar project group as the sidebar builds it, generic over the session and
 * routine row types so this helper stays pure and unit-testable.
 */
export interface ScratchGroupInput<S, R> {
  project: string;
  name: string;
  isScratch: boolean;
  sessions: S[];
  routines: R[];
}

/**
 * Collapse every scratch project group (`~/omp-cwd-*`, temp dirs) into a SINGLE
 * "Non Project Related" group so multiple scratch roots do not each render as a
 * separate group. The merged group keeps the first scratch group's `project`
 * key (the sidebar sorts scratch-first by recency, so that is the most recent
 * root), gets the shared `label` as its name, and concatenates the sessions and
 * routines of every scratch root. The merged group is pinned to the very top;
 * non-scratch groups keep their original relative order after it.
 *
 * Pure — no filesystem access — so it can be unit tested with plain arrays.
 */
export function collapseScratchGroups<S, R>(
  groups: ScratchGroupInput<S, R>[],
  label: string,
): ScratchGroupInput<S, R>[] {
  const scratch = groups.filter((group) => group.isScratch);
  const nonScratch = groups.filter((group) => !group.isScratch);
  if (scratch.length === 0) return nonScratch;

  const merged: ScratchGroupInput<S, R> = {
    project: scratch[0].project,
    name: label,
    isScratch: true,
    sessions: scratch.flatMap((group) => group.sessions),
    routines: scratch.flatMap((group) => group.routines),
  };
  return [merged, ...nonScratch];
}
