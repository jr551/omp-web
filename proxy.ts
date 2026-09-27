import { NextResponse, type NextRequest } from "next/server";
import {
  isApiRequestAllowed,
  isApiRequestHostAllowed,
} from "@/lib/request-security";
import { authorizeWebRequest, OMP_WEB_SESSION_COOKIE } from "@/lib/web-auth";

/**
 * The password-recovery surface, and the only thing that answers without
 * credentials. It cannot hand out access on its own: the recovery code it mints
 * is printed on the server's console, never returned over HTTP.
 */
const RECOVERY_PAGE = "/recover";
const RECOVERY_API = "/api/web-access/recovery";

/** The form-login surface: a page and the endpoints that set/clear its cookie. */
const LOGIN_PAGE = "/login";
const LOGIN_API = "/api/web-access/login";
const LOGOUT_API = "/api/web-access/logout";

// Reachable without a session so a locked-out browser can sign in or recover.
// Each still passes the host + cross-site checks above before it is served.
const UNAUTHENTICATED_PATHS = new Set([
  RECOVERY_PAGE,
  RECOVERY_API,
  LOGIN_PAGE,
  LOGIN_API,
  LOGOUT_API,
]);

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isApiRequest = pathname === "/api" || pathname.startsWith("/api/");
  const isTrustedRequest = isApiRequest
    ? isApiRequestAllowed(request)
    : isApiRequestHostAllowed(request);

  if (!isTrustedRequest) {
    if (!isApiRequest) {
      return new NextResponse("Untrusted request", { status: 403 });
    }
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }

  // Login and recovery stay reachable while locked out — that is the whole point
  // of them — but only after the host and cross-site checks above have run.
  if (UNAUTHENTICATED_PATHS.has(pathname)) return NextResponse.next();

  const decision = authorizeWebRequest(request.headers.get("authorization"), {
    cookie: request.cookies.get(OMP_WEB_SESSION_COOKIE)?.value ?? null,
  });

  if (decision === "unavailable") {
    const message = "Password access is enabled but the omp-web credential file could not be read."
      + " Run `omp-web --reset-password` on the server to set a new password.";
    return isApiRequest
      ? NextResponse.json({ error: message }, { status: 503, headers: NO_STORE_HEADERS })
      : new NextResponse(message, { status: 503, headers: NO_STORE_HEADERS });
  }

  if (decision === "unauthorized") {
    // Browser navigations go to the form; API calls get a 401 (no Basic
    // WWW-Authenticate header, so no native dialog) with the login path.
    if (isApiRequest) {
      return NextResponse.json(
        { error: "Authentication required", loginPath: LOGIN_PAGE },
        { status: 401, headers: NO_STORE_HEADERS },
      );
    }
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = LOGIN_PAGE;
    loginUrl.search = "";
    const next = `${pathname}${request.nextUrl.search}`;
    if (next && next !== "/") loginUrl.searchParams.set("next", next);
    return NextResponse.redirect(loginUrl, { headers: NO_STORE_HEADERS });
  }

  return NextResponse.next();
}

export const config = { matcher: ["/", "/login", "/recover", "/api/:path*"] };
