import { NextResponse } from "next/server";
import { existsSync } from "fs";
import { allowFileRoot, getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import {
  createRoutine,
  listRoutines,
  listRoutineSessionIds,
  validateRoutineFields,
} from "@/lib/routine-store";
import { toRoutineWithStatus } from "@/lib/routine-scheduler";
import { resolveExternalBaseUrl } from "@/lib/omp-web-config";

export const dynamic = "force-dynamic";

// GET /api/routines — list all routines with live running state.
export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  try {
    const baseUrl = resolveExternalBaseUrl(req);
    return NextResponse.json({
      routines: listRoutines().map((routine) => toRoutineWithStatus(routine, baseUrl)),
      // Session ids created by routine runs — the sidebar hides these from the
      // normal session list (still reachable via the routine activity view).
      routineSessionIds: listRoutineSessionIds(),
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

// POST /api/routines — create a routine.
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  try {
    const body = await req.json() as Record<string, unknown>;
    const validated = validateRoutineFields(body);
    if (!validated.ok) {
      return NextResponse.json({ error: validated.error }, { status: 400 });
    }

    const { cwd } = validated.value;
    if (!existsSync(cwd)) {
      return NextResponse.json({ error: `Directory does not exist: ${cwd}` }, { status: 400 });
    }
    const allowedRoots = await getAllowedFileRoots();
    if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
      return NextResponse.json({ error: "Access denied for the target directory" }, { status: 403 });
    }

    const routine = createRoutine(validated.value);
    allowFileRoot(cwd);
    return NextResponse.json({ routine: toRoutineWithStatus(routine, resolveExternalBaseUrl(req)) }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
