import { NextResponse } from "next/server";
import { resolvePendingQuestion } from "@/lib/routine-ask";

export const dynamic = "force-dynamic";

/**
 * POST /api/routines/respond/[token] — answer one pending headless question.
 *
 * UNAUTHENTICATED BY DESIGN: the token is a single-use, expiring capability that
 * only ever unblocks THAT one question — it authorizes no other action. It is
 * allow-listed in proxy.ts and compared in constant time. Unknown, used, or
 * expired tokens yield 404.
 */
export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  let answer = "";
  try {
    const contentType = req.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const body = await req.json() as { answer?: unknown };
      answer = typeof body.answer === "string" ? body.answer : "";
    } else {
      answer = (await req.text()).trim();
    }
  } catch {
    // Treat an unreadable body as an empty answer.
  }

  const delivered = resolvePendingQuestion(token, answer);
  if (!delivered) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
