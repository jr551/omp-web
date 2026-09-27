import { NextResponse } from "next/server";
import { execFile } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { promisify } from "util";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { listRoutines, mergeRoutinesIntoStore } from "@/lib/routine-store";
import {
  exportRoutines,
  importRoutines,
  type GitExec,
  type RoutineFileIO,
} from "@/lib/routine-git";

export const dynamic = "force-dynamic";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 30_000;

/** A git runner bound to `cwd`, matching the guard-command/worktree exec pattern. */
function gitInDir(cwd: string): GitExec {
  return async (args) => {
    const { stdout, stderr } = await execFileAsync("git", ["-C", cwd, ...args], {
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, LC_ALL: "C" },
    });
    return { stdout: stdout.toString(), stderr: stderr.toString() };
  };
}

const nodeIo: RoutineFileIO = {
  read: (path) => (existsSync(path) ? readFileSync(path, "utf8") : null),
  write: (path, data) => writeFileSync(path, data),
};

/**
 * POST /api/routines/sync — sync the routine store with a git repo.
 * Body: { direction: "push" | "pull", repoDir, remote?, branch? }.
 */
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  let body: { direction?: unknown; repoDir?: unknown; remote?: unknown; branch?: unknown };
  try {
    body = await req.json() as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const direction = body.direction === "push" || body.direction === "pull" ? body.direction : null;
  if (!direction) {
    return NextResponse.json({ error: 'direction must be "push" or "pull"' }, { status: 400 });
  }
  const repoDir = typeof body.repoDir === "string" ? body.repoDir.trim() : "";
  if (!repoDir) {
    return NextResponse.json({ error: "repoDir is required" }, { status: 400 });
  }
  const remote = typeof body.remote === "string" && body.remote.trim() ? body.remote.trim() : undefined;
  const branch = typeof body.branch === "string" && body.branch.trim() ? body.branch.trim() : undefined;

  if (!existsSync(repoDir)) {
    return NextResponse.json({ error: `Directory does not exist: ${repoDir}` }, { status: 400 });
  }
  const allowedRoots = await getAllowedFileRoots();
  if (!isExistingFilePathAllowed(repoDir, allowedRoots)) {
    return NextResponse.json({ error: "Access denied for the target directory" }, { status: 403 });
  }

  const git = gitInDir(repoDir);
  try {
    // Confirm it is a git working tree before touching anything.
    await git(["rev-parse", "--is-inside-work-tree"]);

    if (direction === "push") {
      const result = await exportRoutines({
        routines: listRoutines(),
        repoDir,
        git,
        io: nodeIo,
        ...(remote ? { remote } : {}),
        ...(branch ? { branch } : {}),
      });
      return NextResponse.json({ ok: true, direction, committed: result.committed, pushed: result.pushed });
    }

    const { routines } = await importRoutines({
      repoDir,
      git,
      io: nodeIo,
      ...(remote ? { remote } : {}),
      ...(branch ? { branch } : {}),
    });
    const merged = mergeRoutinesIntoStore(routines);
    return NextResponse.json({ ok: true, direction, imported: routines.length, merged });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
