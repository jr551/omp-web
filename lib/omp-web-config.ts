import { mkdirSync, readFileSync } from "fs";
import { join } from "path";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";

/**
 * omp-web's own small config store (separate from omp's config.yml), persisted
 * as JSON at `<agentDir>/omp-web-config.json`, cached on globalThis like the
 * routine and trust stores.
 *
 * Currently holds the external base URL used to build webhook links when
 * omp-web is fronted by a tunnel (Cloudflare, ngrok, …). It is display/link
 * building only — never a security input.
 */

const CONFIG_FILE = "omp-web-config.json";

export interface OmpWebConfig {
  externalBaseUrl?: string;
}

declare global {
  var __ompWebConfig: OmpWebConfig | undefined;
  var __ompWebConfigLoadedFrom: string | undefined;
}

function configFilePath(agentDir: string): string {
  return join(agentDir, CONFIG_FILE);
}

function readConfig(agentDir: string): OmpWebConfig {
  try {
    const parsed: unknown = JSON.parse(readFileSync(configFilePath(agentDir), "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const record = parsed as Record<string, unknown>;
    return {
      ...(typeof record.externalBaseUrl === "string" ? { externalBaseUrl: record.externalBaseUrl } : {}),
    };
  } catch {
    return {};
  }
}

function getConfig(agentDir: string): OmpWebConfig {
  if (!globalThis.__ompWebConfig || globalThis.__ompWebConfigLoadedFrom !== agentDir) {
    globalThis.__ompWebConfig = readConfig(agentDir);
    globalThis.__ompWebConfigLoadedFrom = agentDir;
  }
  return globalThis.__ompWebConfig;
}

function resolveAgentDir(agentDir?: string): string {
  return agentDir ?? getAgentDir();
}

export function getOmpWebConfig(agentDir?: string): OmpWebConfig {
  return { ...getConfig(resolveAgentDir(agentDir)) };
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

/** The configured external base URL, or undefined when unset. */
export function getExternalBaseUrl(agentDir?: string): string | undefined {
  const url = getConfig(resolveAgentDir(agentDir)).externalBaseUrl;
  return url ? normalizeBaseUrl(url) : undefined;
}

/**
 * Persist the external base URL. Pass empty/undefined to clear it. Validates
 * that a non-empty value is an absolute http(s) URL.
 */
export function setExternalBaseUrl(value: string | undefined, agentDir?: string): void {
  const dir = resolveAgentDir(agentDir);
  const config = { ...getConfig(dir) };
  const trimmed = value?.trim();
  if (!trimmed) {
    delete config.externalBaseUrl;
  } else {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new Error("External URL must be an absolute URL, e.g. https://omp.example.com");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("External URL must use http or https");
    }
    config.externalBaseUrl = normalizeBaseUrl(trimmed);
  }
  mkdirSync(dir, { recursive: true });
  writePrivateFileAtomicSync(configFilePath(dir), `${JSON.stringify(config, null, 2)}\n`);
  globalThis.__ompWebConfig = config;
  globalThis.__ompWebConfigLoadedFrom = dir;
}

/**
 * The externally reachable base URL for building webhook links. Prefers the
 * configured value; otherwise auto-detects from forwarded headers (tunnels) and
 * finally the Host header. Never trusted for security decisions.
 */
export function resolveExternalBaseUrl(request: Request, agentDir?: string): string {
  const configured = getExternalBaseUrl(agentDir);
  if (configured) return configured;

  const headers = request.headers;
  const forwardedHost = headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const forwardedProto = headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const host = forwardedHost || headers.get("host")?.trim();
  if (host) {
    const proto = forwardedProto || (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
    return normalizeBaseUrl(`${proto}://${host}`);
  }
  try {
    return normalizeBaseUrl(new URL(request.url).origin);
  } catch {
    return "";
  }
}

/** Test-only: reset the cached config. */
export function __resetOmpWebConfigForTests(): void {
  globalThis.__ompWebConfig = undefined;
  globalThis.__ompWebConfigLoadedFrom = undefined;
}
