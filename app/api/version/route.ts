import { NextResponse } from "next/server";
import { isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

// GET /api/version — the version of the running server build. No network
// calls (unlike /api/updates), so open tabs can poll it cheaply to notice that
// the server was upgraded underneath them.
export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  return NextResponse.json(
    { ompWebVersion: process.env.NEXT_PUBLIC_APP_VERSION ?? null },
    { headers: { "Cache-Control": "no-store" } },
  );
}
