import { join } from "path";
import type { Routine } from "./routine-types";

/**
 * Sync the Routines store to and from a git repository.
 *
 * The export/import/merge logic is pure and dependency-injected: the caller
 * supplies a git runner and a tiny file-IO shim, so unit tests exercise the
 * real merge semantics with fakes and never touch git or the filesystem
 * (lib/routine-git.test.mjs). The API route (app/api/routines/sync) wires in a
 * real `git` via execFile and a `node:fs` shim.
 */

/** The file the routine set is written to inside the target repo. */
export const ROUTINE_SYNC_FILENAME = "omp-web-routines.json";

export interface GitExec {
  /** Run git with args in `cwd`; reject on non-zero exit. */
  (args: string[]): Promise<{ stdout: string; stderr: string }>;
}

export interface RoutineFileIO {
  /** Read a file, or return null when it does not exist. */
  read(path: string): string | null;
  write(path: string, data: string): void;
}

export interface ExportRoutinesDeps {
  routines: Routine[];
  repoDir: string;
  git: GitExec;
  io: RoutineFileIO;
  remote?: string;
  branch?: string;
  message?: string;
}

export interface ImportRoutinesDeps {
  repoDir: string;
  git: GitExec;
  io: RoutineFileIO;
  remote?: string;
  branch?: string;
}

// --- Pure serialization / merge -----------------------------------------

/** Stable, id-sorted JSON so exports produce minimal diffs. */
export function serializeRoutines(routines: Routine[]): string {
  const sorted = [...routines].sort((a, b) => a.id.localeCompare(b.id));
  return `${JSON.stringify({ routines: sorted }, null, 2)}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse an exported file into routines, tolerating array or `{ routines: [] }`. */
export function parseRoutines(json: string): Routine[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.routines)
      ? parsed.routines
      : [];
  return list.filter(
    (entry): entry is Routine => isRecord(entry) && typeof entry.id === "string" && typeof entry.updatedAt === "string",
  );
}

/**
 * Merge two routine sets, deduping by id: for a shared id the routine with the
 * newer `updatedAt` wins (ties keep the local copy). Routines present on only
 * one side are kept. Result is sorted by id for determinism. Pure.
 */
export function mergeRoutines(local: Routine[], incoming: Routine[]): Routine[] {
  const byId = new Map<string, Routine>();
  for (const routine of local) byId.set(routine.id, routine);
  for (const routine of incoming) {
    const existing = byId.get(routine.id);
    if (!existing) {
      byId.set(routine.id, routine);
      continue;
    }
    // Newer updatedAt wins; on a tie keep the existing (local) copy.
    if (Date.parse(routine.updatedAt) > Date.parse(existing.updatedAt)) {
      byId.set(routine.id, routine);
    }
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

// --- Git-backed export / import (injected git + io) ---------------------

export interface ExportResult {
  file: string;
  committed: boolean;
  pushed: boolean;
}

/** Write the routine set into the repo and commit (and optionally push) it. */
export async function exportRoutines(deps: ExportRoutinesDeps): Promise<ExportResult> {
  const file = join(deps.repoDir, ROUTINE_SYNC_FILENAME);
  deps.io.write(file, serializeRoutines(deps.routines));

  await deps.git(["add", ROUTINE_SYNC_FILENAME]);

  let committed = false;
  try {
    await deps.git(["commit", "-m", deps.message ?? "chore(omp-web): sync routines"]);
    committed = true;
  } catch {
    // Nothing to commit (the file is unchanged) — not an error.
    committed = false;
  }

  let pushed = false;
  if (deps.remote) {
    await deps.git(["push", deps.remote, ...(deps.branch ? [deps.branch] : [])]);
    pushed = true;
  }

  return { file, committed, pushed };
}

export interface ImportResult {
  file: string;
  routines: Routine[];
}

/** Pull (optional) then read the routine set from the repo. */
export async function importRoutines(deps: ImportRoutinesDeps): Promise<ImportResult> {
  if (deps.remote) {
    await deps.git(["pull", "--ff-only", deps.remote, ...(deps.branch ? [deps.branch] : [])]);
  }
  const file = join(deps.repoDir, ROUTINE_SYNC_FILENAME);
  const contents = deps.io.read(file);
  return { file, routines: contents ? parseRoutines(contents) : [] };
}
