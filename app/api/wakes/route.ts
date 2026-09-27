import { NextResponse } from "next/server";
import { isApiRequestAllowed } from "@/lib/request-security";
import { listPendingWakesSummary } from "@/lib/wake-store";

export const dynamic = "force-dynamic";

/**
 * GET /api/wakes — pending `smartwake` wakes, grouped by sessionId and cwd.
 *
 * Returns only browser-safe fields (never the stored message or poll command);
 * the sidebar polls this to show the pending 😎 indicator on session and
 * routine rows, and AppShell to badge the open session's chat header. Authed
 * like the other API routes.
 */
export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  try {
    return NextResponse.json(listPendingWakesSummary());
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
