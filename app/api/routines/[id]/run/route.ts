import { NextResponse } from "next/server";
import { isApiRequestAllowed } from "@/lib/request-security";
import { getRoutine } from "@/lib/routine-store";
import { runRoutineNow } from "@/lib/routine-scheduler";

export const dynamic = "force-dynamic";

// POST /api/routines/[id]/run — kick off a run immediately and return at once.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const { id } = await params;
  const routine = getRoutine(id);
  if (!routine) return NextResponse.json({ error: "Routine not found" }, { status: 404 });
  try {
    // Never block the request on the run: runRoutineNow returns as soon as the
    // run is scheduled (or is a no-op if one is already in flight).
    await runRoutineNow(id);
    return NextResponse.json({ ok: true }, { status: 202 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
