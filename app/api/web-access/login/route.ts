import { NextResponse } from "next/server";
import { loginWithPassword, OMP_WEB_SESSION_COOKIE } from "@/lib/web-auth";

export const dynamic = "force-dynamic";

function isHttps(req: Request): boolean {
  if (req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() === "https") return true;
  try {
    return new URL(req.url).protocol === "https:";
  } catch {
    return false;
  }
}

// POST /api/web-access/login  body: { password: string }
// On success sets the httpOnly session cookie. Reachable while locked (allow-listed
// in proxy.ts); the host + cross-site checks still apply.
export async function POST(req: Request) {
  let password = "";
  try {
    const body = await req.json() as { password?: unknown };
    if (typeof body?.password === "string") password = body.password;
  } catch {
    // fall through with empty password -> invalid
  }

  const result = loginWithPassword(password);

  if (result.status === "unavailable") {
    return NextResponse.json(
      { error: "The omp-web credential file could not be read. Run `omp-web --reset-password` on the server." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (result.status === "open") {
    // No password configured: nothing to sign in to.
    return NextResponse.json({ ok: true, open: true }, { headers: { "Cache-Control": "no-store" } });
  }
  if (result.status === "invalid") {
    return NextResponse.json({ error: "Incorrect password" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }

  const response = NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  response.cookies.set(OMP_WEB_SESSION_COOKIE, result.token, {
    httpOnly: true,
    sameSite: "lax",
    secure: isHttps(req),
    path: "/",
    maxAge: result.maxAgeSeconds,
  });
  return response;
}
