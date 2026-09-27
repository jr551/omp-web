import { mkdirSync, readFileSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";
import {
  MAX_PENDING_WAKES_PER_SESSION,
  WAKE_TERMINAL_RETENTION_MS,
  summarizePendingWakes,
  type PendingWakesSummary,
  type ValidatedWake,
  type Wake,
  type WakeStatus,
} from "./wake-types";

/**
 * Persistence for `smartwake` wakes.
 *
 * Pending wakes are stored as JSON next to the agent config
 * (`<agentDir>/omp-web-wakes.json`, `0600`, atomic replace) with an in-memory
 * copy cached on `globalThis` so it survives Next.js hot-reload — the same
 * pattern lib/routine-store.ts / lib/project-trust.ts use. The store is shared
 * by every omp-web instance pointed at the same agent directory.
 */

const WAKES_FILE = "omp-web-wakes.json";

export type { Wake, WakeStatus, WakeMode } from "./wake-types";

declare global {
  var __ompWakes: Map<string, Wake> | undefined;
  var __ompWakesLoadedFrom: string | undefined;
}

const TERMINAL_STATUSES: ReadonlySet<WakeStatus> = new Set(["fired", "expired", "cancelled", "failed"]);

function isTerminal(status: WakeStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

function wakesFilePath(agentDir: string): string {
  return join(agentDir, WAKES_FILE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveAgentDir(agentDir?: string): string {
  return agentDir ?? getAgentDir();
}

// --- Load / persist ------------------------------------------------------

function reviveWake(raw: unknown): Wake | null {
  if (!isRecord(raw)) return null;
  const id = typeof raw.id === "string" ? raw.id : null;
  const sessionId = typeof raw.sessionId === "string" ? raw.sessionId : null;
  const mode = raw.mode === "delayed" || raw.mode === "guarded" ? raw.mode : null;
  if (!id || !sessionId || !mode) return null;
  const status: WakeStatus =
    raw.status === "fired" || raw.status === "expired" || raw.status === "cancelled" || raw.status === "failed"
      ? raw.status
      : "pending";
  return {
    id,
    sessionId,
    cwd: typeof raw.cwd === "string" ? raw.cwd : "",
    ...(typeof raw.sessionFile === "string" ? { sessionFile: raw.sessionFile } : {}),
    mode,
    message: typeof raw.message === "string" ? raw.message : "",
    ...(typeof raw.fireAt === "number" ? { fireAt: raw.fireAt } : {}),
    ...(typeof raw.pollCommand === "string" ? { pollCommand: raw.pollCommand } : {}),
    ...(typeof raw.intervalMs === "number" ? { intervalMs: raw.intervalMs } : {}),
    ...(typeof raw.guardTimeoutMs === "number" ? { guardTimeoutMs: raw.guardTimeoutMs } : {}),
    ...(typeof raw.expectOutputMatches === "string" ? { expectOutputMatches: raw.expectOutputMatches } : {}),
    createdAt: typeof raw.createdAt === "number" ? raw.createdAt : Date.now(),
    expiresAt: typeof raw.expiresAt === "number" ? raw.expiresAt : Date.now(),
    ...(typeof raw.lastPollAt === "number" ? { lastPollAt: raw.lastPollAt } : {}),
    ...(typeof raw.resolvedAt === "number" ? { resolvedAt: raw.resolvedAt } : {}),
    status,
    ...(typeof raw.statusReason === "string" ? { statusReason: raw.statusReason } : {}),
  };
}

function readWakesFromDisk(agentDir: string): Map<string, Wake> {
  const map = new Map<string, Wake>();
  try {
    const parsed: unknown = JSON.parse(readFileSync(wakesFilePath(agentDir), "utf8"));
    const list = Array.isArray(parsed)
      ? parsed
      : isRecord(parsed) && Array.isArray(parsed.wakes)
        ? parsed.wakes
        : [];
    const now = Date.now();
    for (const entry of list) {
      const wake = reviveWake(entry);
      if (!wake) continue;
      // Drop stale terminal wakes so the file stays bounded.
      if (isTerminal(wake.status) && wake.resolvedAt && now - wake.resolvedAt > WAKE_TERMINAL_RETENTION_MS) continue;
      map.set(wake.id, wake);
    }
  } catch {
    // Missing or unreadable file -> empty store.
  }
  return map;
}

function getStore(agentDir: string): Map<string, Wake> {
  if (!globalThis.__ompWakes || globalThis.__ompWakesLoadedFrom !== agentDir) {
    globalThis.__ompWakes = readWakesFromDisk(agentDir);
    globalThis.__ompWakesLoadedFrom = agentDir;
  }
  return globalThis.__ompWakes;
}

function persist(agentDir: string, store: Map<string, Wake>): void {
  mkdirSync(agentDir, { recursive: true });
  const wakes = [...store.values()];
  writePrivateFileAtomicSync(wakesFilePath(agentDir), `${JSON.stringify({ wakes }, null, 2)}\n`);
}

// --- CRUD ----------------------------------------------------------------

export interface CreateWakeArgs {
  sessionId: string;
  cwd: string;
  sessionFile?: string;
  fields: ValidatedWake;
}

export function createWake(args: CreateWakeArgs, agentDir?: string): Wake {
  const dir = resolveAgentDir(agentDir);
  const store = getStore(dir);
  const pendingForSession = [...store.values()].filter(
    (wake) => wake.sessionId === args.sessionId && wake.status === "pending",
  ).length;
  if (pendingForSession >= MAX_PENDING_WAKES_PER_SESSION) {
    throw new Error(`This session already has ${MAX_PENDING_WAKES_PER_SESSION} pending wakes; cancel some first`);
  }
  const wake: Wake = {
    id: randomUUID(),
    sessionId: args.sessionId,
    cwd: args.cwd,
    ...(args.sessionFile ? { sessionFile: args.sessionFile } : {}),
    ...args.fields,
    status: "pending",
  };
  store.set(wake.id, wake);
  persist(dir, store);
  return wake;
}

export function getWake(id: string, agentDir?: string): Wake | undefined {
  return getStore(resolveAgentDir(agentDir)).get(id);
}

/** All wakes, optionally filtered to one session. */
export function listWakes(sessionId?: string, agentDir?: string): Wake[] {
  const wakes = [...getStore(resolveAgentDir(agentDir)).values()];
  const filtered = sessionId ? wakes.filter((wake) => wake.sessionId === sessionId) : wakes;
  return filtered.sort((a, b) => a.createdAt - b.createdAt);
}

/** Every pending wake across all sessions (the scheduler's view). */
export function listPendingWakes(agentDir?: string): Wake[] {
  return [...getStore(resolveAgentDir(agentDir)).values()]
    .filter((wake) => wake.status === "pending")
    .sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Browser-safe summary of pending wakes, grouped by sessionId and cwd. The
 * stored message/pollCommand are never included — see summarizePendingWakes.
 * Drives the sidebar/chat-header pending 😎 indicators via GET /api/wakes.
 */
export function listPendingWakesSummary(agentDir?: string): PendingWakesSummary {
  return summarizePendingWakes(listPendingWakes(agentDir));
}

/**
 * Cancel a pending wake. When `sessionId` is given the wake must belong to it
 * (a worker may only cancel its own wakes). Returns the cancelled wake or
 * undefined if not found / not owned / already terminal.
 */
export function cancelWake(id: string, sessionId: string | undefined, now: number, agentDir?: string): Wake | undefined {
  const dir = resolveAgentDir(agentDir);
  const store = getStore(dir);
  const existing = store.get(id);
  if (!existing) return undefined;
  if (sessionId !== undefined && existing.sessionId !== sessionId) return undefined;
  if (existing.status !== "pending") return undefined;
  const updated: Wake = { ...existing, status: "cancelled", resolvedAt: now, statusReason: "cancelled" };
  store.set(id, updated);
  persist(dir, store);
  return updated;
}

/** Set a wake's terminal status (used by the scheduler on fire/expire/fail). */
export function setWakeStatus(id: string, status: WakeStatus, now: number, reason?: string, agentDir?: string): Wake | undefined {
  const dir = resolveAgentDir(agentDir);
  const store = getStore(dir);
  const existing = store.get(id);
  if (!existing) return undefined;
  const updated: Wake = {
    ...existing,
    status,
    ...(isTerminal(status) ? { resolvedAt: now } : {}),
    ...(reason ? { statusReason: reason } : {}),
  };
  store.set(id, updated);
  persist(dir, store);
  return updated;
}

/** Record the timestamp of a guard poll (guarded wakes). */
export function recordWakePoll(id: string, now: number, agentDir?: string): void {
  const dir = resolveAgentDir(agentDir);
  const store = getStore(dir);
  const existing = store.get(id);
  if (!existing) return;
  store.set(id, { ...existing, lastPollAt: now });
  persist(dir, store);
}

export function deleteWake(id: string, agentDir?: string): boolean {
  const dir = resolveAgentDir(agentDir);
  const store = getStore(dir);
  const removed = store.delete(id);
  if (removed) persist(dir, store);
  return removed;
}

/** Test-only: reset the in-memory cache so a test can point at a fresh dir. */
export function __resetWakeStoreForTests(): void {
  globalThis.__ompWakes = undefined;
  globalThis.__ompWakesLoadedFrom = undefined;
}
