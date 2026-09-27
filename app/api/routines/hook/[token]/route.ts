import { NextResponse } from "next/server";
import { findRoutineByWebhookToken } from "@/lib/routine-store";
import { runRoutineNow } from "@/lib/routine-scheduler";

export const dynamic = "force-dynamic";

/**
 * POST /api/routines/hook/[token] — trigger a webhook routine.
 *
 * UNAUTHENTICATED BY DESIGN: the token is the capability. It is allow-listed in
 * proxy.ts (like /recover) and compared in constant time. An unknown or revoked
 * token yields 404 so it is indistinguishable from a wrong path. An optional
 * JSON/text body is appended to the routine's prompt as trigger context.
 */
export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const routine = findRoutineByWebhookToken(token);
  if (!routine) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!routine.enabled) return NextResponse.json({ error: "Routine is disabled" }, { status: 409 });

  let extraContext: string | undefined;
  try {
    const text = await req.text();
    if (text.trim()) extraContext = text.slice(0, 8_000); // cap the injected context
  } catch {
    // Ignore body read errors; the trigger still fires.
  }

  try {
    await runRoutineNow(routine.id, extraContext ? { extraContext } : {});
    return NextResponse.json({ ok: true, routineId: routine.id }, { status: 202 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
