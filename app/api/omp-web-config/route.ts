import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { getExternalBaseUrl, resolveExternalBaseUrl, setExternalBaseUrl } from "@/lib/omp-web-config";

export const dynamic = "force-dynamic";

// GET /api/omp-web-config — omp-web's own settings (external base URL).
export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  return NextResponse.json({
    externalBaseUrl: getExternalBaseUrl() ?? "",
    resolvedBaseUrl: resolveExternalBaseUrl(req),
  });
}

// PUT /api/omp-web-config — set/clear the external base URL.
export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  try {
    const body = await req.json() as { externalBaseUrl?: unknown };
    if (body.externalBaseUrl !== undefined && typeof body.externalBaseUrl !== "string") {
      return NextResponse.json({ error: "externalBaseUrl must be a string" }, { status: 400 });
    }
    setExternalBaseUrl(typeof body.externalBaseUrl === "string" ? body.externalBaseUrl : undefined);
    return NextResponse.json({
      externalBaseUrl: getExternalBaseUrl() ?? "",
      resolvedBaseUrl: resolveExternalBaseUrl(req),
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
