// In a Tauri desktop webview, window.open(url, "_blank") opens a new webview
// window instead of a system browser tab, which would silently break OAuth
// login. The desktop build exposes window.__TAURI__ (withGlobalTauri) and the
// opener plugin's `plugin:opener|open_url` IPC command; route through it when
// present, and fall back to the plain browser behavior everywhere else.
export function openExternal(url: string): void {
  const tauri = (
    globalThis as unknown as {
      __TAURI__?: {
        core: {
          invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
        }
      }
    }
  ).__TAURI__

  if (tauri) {
    tauri.core.invoke("plugin:opener|open_url", { url }).catch(() => {
      window.open(url, "_blank", "noopener,noreferrer")
    })
    return
  }

  window.open(url, "_blank", "noopener,noreferrer")
}

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"])

/**
 * Whether this page is served from the machine the browser runs on. OAuth
 * loopback URLs (`http://localhost:<port>/launch`) only resolve there; a
 * browser reaching omp-web remotely needs the provider's full URL instead.
 */
export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(hostname) || hostname.endsWith(".localhost")
}

export function isLoopbackBrowser(): boolean {
  if (typeof window === "undefined") return true
  if ((globalThis as { __TAURI__?: unknown }).__TAURI__) return true
  return isLoopbackHostname(window.location.hostname)
}
