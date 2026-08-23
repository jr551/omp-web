import { NextResponse } from "next/server";
import { createChildDirectory } from "@/lib/directory-browser";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

function errorResponse(error: unknown): NextResponse {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const message = error instanceof Error ? error.message : String(error);

  if (code === "ENOENT") {
    return NextResponse.json({ error: "Parent directory does not exist" }, { status: 404 });
  }
  if (code === "EEXIST") {
    return NextResponse.json({ error: "A file or folder with that name already exists" }, { status: 409 });
  }
  if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
    return NextResponse.json({ error: "You do not have permission to create a folder here" }, { status: 403 });
  }
  if (code === "ENOTDIR" || /folder name|required/i.test(message)) {
    return NextResponse.json({ error: message }, { status: 400 });
  }

  return NextResponse.json({ error: message }, { status: 500 });
}

export async function POST(request: Request) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(request)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  try {
    const body = await request.json() as { parentPath?: unknown; name?: unknown };
    const parentPath = typeof body.parentPath === "string" ? body.parentPath.trim() : "";
    const name = typeof body.name === "string" ? body.name : "";

    if (!parentPath) {
      return NextResponse.json({ error: "Parent path is required" }, { status: 400 });
    }

    const created = await createChildDirectory(parentPath, name);
    return NextResponse.json(created, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
