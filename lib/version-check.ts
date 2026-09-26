/**
 * Pure decision helpers for the stale-tab refresh banner.
 *
 * After omp-web is upgraded (in-app update, `npm i -g`, a package manager) and
 * the server restarts onto the new build, open tabs keep running the old client
 * bundle for hours. `VersionRefreshBanner` polls `GET /api/version` and compares
 * the server's `ompWebVersion` against the `NEXT_PUBLIC_APP_VERSION` inlined
 * into the loaded bundle; these helpers keep that decision testable without a
 * browser.
 */

/** Extract a usable `ompWebVersion` from a `/api/version` JSON payload. */
export function serverVersionFromPayload(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  if (!("ompWebVersion" in payload)) return undefined;
  const version = payload.ompWebVersion;
  if (typeof version !== "string" || version.length === 0) return undefined;
  return version;
}

/**
 * Whether the staleness banner should be visible: both versions are known and
 * differ (plain string inequality, so a rollback counts too), and the server
 * version is not the one the user already dismissed.
 *
 * @param clientVersion  Version baked into the loaded JS bundle, constant per page load.
 * @param serverVersion  Latest `ompWebVersion` observed from `/api/version`.
 * @param dismissedServerVersion Server version the user dismissed, if any; the
 *                       banner re-shows only once the server version changes again.
 */
export function shouldShowBanner(
  clientVersion: string | null | undefined,
  serverVersion: string | null | undefined,
  dismissedServerVersion: string | null | undefined,
): boolean {
  if (!clientVersion || !serverVersion) return false;
  if (clientVersion === serverVersion) return false;
  return serverVersion !== dismissedServerVersion;
}
