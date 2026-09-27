import { NextResponse } from "next/server";
import { existsSync } from "fs";
import { allowFileRoot, getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import {
  deleteRoutine,
  getRoutine,
  patchRoutine,
  updateRoutine,
  validateRoutineFields,
} from "@/lib/routine-store";
import { toRoutineWithStatus as withStatus } from "@/lib/routine-scheduler";

export const dynamic = "force-dynamic";

// GET /api/routines/[id]
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const { id } = await params;
  const routine = getRoutine(id);
  if (!routine) return NextResponse.json({ error: "Routine not found" }, { status: 404 });
  return NextResponse.json({ routine: withStatus(routine) });
}

async function authorizeCwd(cwd: string): Promise<string | null> {
  if (!existsSync(cwd)) return `Directory does not exist: ${cwd}`;
  const allowedRoots = await getAllowedFileRoots();
  if (!isExistingFilePathAllowed(cwd, allowedRoots)) return "Access denied for the target directory";
  return null;
}

// PUT /api/routines/[id] — replace all editable fields.
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  const { id } = await params;
  try {
    if (!getRoutine(id)) return NextResponse.json({ error: "Routine not found" }, { status: 404 });
    const body = await req.json() as Record<string, unknown>;
    const validated = validateRoutineFields(body);
    if (!validated.ok) return NextResponse.json({ error: validated.error }, { status: 400 });

    const cwdError = await authorizeCwd(validated.value.cwd);
    if (cwdError) {
      return NextResponse.json({ error: cwdError }, { status: cwdError.startsWith("Access") ? 403 : 400 });
    }

    const routine = updateRoutine(id, validated.value);
    allowFileRoot(validated.value.cwd);
    return NextResponse.json({ routine: withStatus(routine) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

// PATCH /api/routines/[id] — partial update (currently the enabled toggle).
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  const { id } = await params;
  try {
    if (!getRoutine(id)) return NextResponse.json({ error: "Routine not found" }, { status: 404 });
    const body = await req.json() as { enabled?: unknown };
    if (typeof body.enabled !== "boolean") {
      return NextResponse.json({ error: "enabled (boolean) is required" }, { status: 400 });
    }
    const routine = patchRoutine(id, { enabled: body.enabled });
    return NextResponse.json({ routine: withStatus(routine) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

// DELETE /api/routines/[id]
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const { id } = await params;
  const removed = deleteRoutine(id);
  if (!removed) return NextResponse.json({ error: "Routine not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
