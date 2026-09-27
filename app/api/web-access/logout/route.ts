import { NextResponse } from "next/server";
import { OMP_WEB_SESSION_COOKIE } from "@/lib/web-auth";

export const dynamic = "force-dynamic";

// POST /api/web-access/logout — clears the session cookie.
export async function POST() {
  const response = NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  response.cookies.set(OMP_WEB_SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return response;
}
