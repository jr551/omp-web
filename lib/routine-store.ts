import { existsSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { isValidCron } from "./cron";
import { generateWebhookToken, tokensEqual } from "./webhook-tokens";
import {
  DEFAULT_EXECUTION_MS,
  DEFAULT_GUARD_TIMEOUT_MS,
  HISTORY_CAP,
  MAX_EXECUTION_MS,
  MAX_GUARD_INTERVAL_MS,
  MAX_GUARD_TIMEOUT_MS,
  MIN_EXECUTION_MS,
  MIN_GUARD_INTERVAL_MS,
  MIN_GUARD_TIMEOUT_MS,
  type Routine,
  type RoutineRun,
  type RoutineTrigger,
} from "./routine-types";

/**
 * Native scheduler ("Routines") store for omp-web.
 *
 * Routines run a prompt in a project on a trigger (cron schedule, or a guard
 * command that gates the run), unattended, in the omp-web server process. They
 * are persisted as JSON next to the agent config so they survive restarts and
 * are shared by every omp-web instance pointed at the same agent directory —
 * the same pattern lib/project-trust.ts uses.
 */

const ROUTINES_FILE = "omp-web-routines.json";

export type { Routine, RoutineRun, RoutineRunStatus, RoutineTrigger } from "./routine-types";
export {
  DEFAULT_EXECUTION_MS,
  DEFAULT_GUARD_INTERVAL_MS,
  DEFAULT_GUARD_TIMEOUT_MS,
  HISTORY_CAP,
  MAX_EXECUTION_MS,
  MAX_GUARD_INTERVAL_MS,
  MAX_GUARD_TIMEOUT_MS,
  MIN_EXECUTION_MS,
  MIN_GUARD_INTERVAL_MS,
  MIN_GUARD_TIMEOUT_MS,
} from "./routine-types";

/** Fields a client may supply when creating or updating a routine. */
export interface RoutineInput {
  name?: unknown;
  cwd?: unknown;
  trigger?: unknown;
  /** Legacy: a bare cron string, treated as { type: "cron" }. */
  schedule?: unknown;
  prompt?: unknown;
  provider?: unknown;
  modelId?: unknown;
  maxExecutionMs?: unknown;
  enabled?: unknown;
  askWebhookUrl?: unknown;
}

export type ValidationResult =
  | { ok: true; value: ValidatedRoutineFields }
  | { ok: false; error: string };

export interface ValidatedRoutineFields {
  name: string;
  cwd: string;
  trigger: RoutineTrigger;
  prompt: string;
  provider?: string;
  modelId?: string;
  maxExecutionMs: number;
  enabled: boolean;
  askWebhookUrl?: string;
}

declare global {
  var __ompRoutines: Map<string, Routine> | undefined;
  /**
   * Persistent set of session ids created by routine RUNS. Every routine run
   * gets a fresh session (lib/routine-runner.ts) that clutters the normal
   * session list; the sidebar filters these out. Unlike the 20-entry run
   * `history`, this set is NOT capped, so a session stays hidden even after its
   * run scrolls out of history.
   */
  var __ompRoutineSessionIds: Set<string> | undefined;
  var __ompRoutinesLoadedFrom: string | undefined;
}

function routinesFilePath(agentDir: string): string {
  return join(agentDir, ROUTINES_FILE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Validation (pure, filesystem-free so it is easy to unit test)
// ---------------------------------------------------------------------------

/** Coerce a legacy `schedule` string and/or a `trigger` object into a trigger. */
export function normalizeTrigger(input: RoutineInput): RoutineTrigger | { error: string } {
  const raw = input.trigger;
  if (raw === undefined || raw === null) {
    // Legacy shape: a bare cron `schedule` string.
    if (typeof input.schedule === "string") {
      return normalizeTrigger({ trigger: { type: "cron", schedule: input.schedule } });
    }
    return { error: "trigger is required" };
  }
  if (!isRecord(raw)) return { error: "trigger must be an object" };

  if (raw.type === "cron") {
    const schedule = typeof raw.schedule === "string" ? raw.schedule.trim() : "";
    if (!schedule) return { error: "cron schedule is required" };
    if (!isValidCron(schedule)) return { error: `invalid cron schedule: "${schedule}"` };
    return { type: "cron", schedule };
  }

  if (raw.type === "webhook") {
    // The token is assigned/managed by the store, not the client; pass through
    // an existing one so updates keep the same URL.
    return { type: "webhook", token: typeof raw.token === "string" ? raw.token : "" };
  }

  if (raw.type === "guard") {
    const command = typeof raw.command === "string" ? raw.command.trim() : "";
    if (!command) return { error: "guard command is required" };

    const intervalMs = typeof raw.intervalMs === "number" ? Math.floor(raw.intervalMs) : NaN;
    if (!Number.isFinite(intervalMs) || intervalMs < MIN_GUARD_INTERVAL_MS || intervalMs > MAX_GUARD_INTERVAL_MS) {
      return { error: `guard intervalMs must be between ${MIN_GUARD_INTERVAL_MS} and ${MAX_GUARD_INTERVAL_MS}` };
    }

    let guardTimeoutMs = DEFAULT_GUARD_TIMEOUT_MS;
    if (raw.guardTimeoutMs !== undefined) {
      const parsed = typeof raw.guardTimeoutMs === "number" ? Math.floor(raw.guardTimeoutMs) : NaN;
      if (!Number.isFinite(parsed) || parsed < MIN_GUARD_TIMEOUT_MS || parsed > MAX_GUARD_TIMEOUT_MS) {
        return { error: `guard timeout must be between ${MIN_GUARD_TIMEOUT_MS} and ${MAX_GUARD_TIMEOUT_MS}` };
      }
      guardTimeoutMs = parsed;
    }

    let expectOutputMatches: string | undefined;
    if (raw.expectOutputMatches !== undefined && raw.expectOutputMatches !== null && raw.expectOutputMatches !== "") {
      if (typeof raw.expectOutputMatches !== "string") return { error: "expectOutputMatches must be a string" };
      try {
        new RegExp(raw.expectOutputMatches);
      } catch (error) {
        return { error: `invalid expectOutputMatches regex: ${error instanceof Error ? error.message : String(error)}` };
      }
      expectOutputMatches = raw.expectOutputMatches;
    }

    return {
      type: "guard",
      intervalMs,
      command,
      guardTimeoutMs,
      ...(expectOutputMatches !== undefined ? { expectOutputMatches } : {}),
    };
  }

  return { error: `unknown trigger type: ${String(raw.type)}` };
}

/**
 * Validate the client-supplied fields of a routine. Pure — does not touch the
 * filesystem, so callers layer their own cwd authorization on top.
 */
export function validateRoutineFields(input: RoutineInput): ValidationResult {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) return { ok: false, error: "name is required" };
  if (name.length > 120) return { ok: false, error: "name is too long (max 120 characters)" };

  const cwd = typeof input.cwd === "string" ? input.cwd.trim() : "";
  if (!cwd) return { ok: false, error: "cwd is required" };

  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  if (!prompt) return { ok: false, error: "prompt is required" };

  const trigger = normalizeTrigger(input);
  if ("error" in trigger) return { ok: false, error: trigger.error };

  const provider = typeof input.provider === "string" && input.provider.trim() ? input.provider.trim() : undefined;
  const modelId = typeof input.modelId === "string" && input.modelId.trim() ? input.modelId.trim() : undefined;
  if ((provider && !modelId) || (!provider && modelId)) {
    return { ok: false, error: "provider and modelId must be provided together" };
  }

  let maxExecutionMs = DEFAULT_EXECUTION_MS;
  if (input.maxExecutionMs !== undefined) {
    const parsed = typeof input.maxExecutionMs === "number" ? Math.floor(input.maxExecutionMs) : NaN;
    if (!Number.isFinite(parsed) || parsed < MIN_EXECUTION_MS || parsed > MAX_EXECUTION_MS) {
      return { ok: false, error: `maxExecutionMs must be between ${MIN_EXECUTION_MS} and ${MAX_EXECUTION_MS}` };
    }
    maxExecutionMs = parsed;
  }

  const enabled = input.enabled === undefined ? true : input.enabled === true;

  let askWebhookUrl: string | undefined;
  if (input.askWebhookUrl !== undefined && input.askWebhookUrl !== null && input.askWebhookUrl !== "") {
    if (typeof input.askWebhookUrl !== "string") return { ok: false, error: "askWebhookUrl must be a string" };
    let parsed: URL;
    try {
      parsed = new URL(input.askWebhookUrl.trim());
    } catch {
      return { ok: false, error: "askWebhookUrl must be an absolute URL" };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { ok: false, error: "askWebhookUrl must use http or https" };
    }
    askWebhookUrl = input.askWebhookUrl.trim();
  }

  return {
    ok: true,
    value: {
      name,
      cwd,
      trigger,
      prompt,
      ...(provider && modelId ? { provider, modelId } : {}),
      maxExecutionMs,
      enabled,
      ...(askWebhookUrl ? { askWebhookUrl } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function migrateRoutine(raw: unknown): Routine | null {
  if (!isRecord(raw)) return null;
  const id = typeof raw.id === "string" ? raw.id : null;
  if (!id) return null;

  const triggerResult = normalizeTrigger({
    trigger: raw.trigger,
    schedule: raw.schedule,
  });
  if ("error" in triggerResult) return null;

  const name = typeof raw.name === "string" ? raw.name : id;
  const cwd = typeof raw.cwd === "string" ? raw.cwd : "";
  const prompt = typeof raw.prompt === "string" ? raw.prompt : "";
  const maxExecutionMs = typeof raw.maxExecutionMs === "number" ? raw.maxExecutionMs : DEFAULT_EXECUTION_MS;
  const now = new Date().toISOString();

  return {
    id,
    name,
    cwd,
    trigger: triggerResult,
    prompt,
    ...(typeof raw.provider === "string" ? { provider: raw.provider } : {}),
    ...(typeof raw.modelId === "string" ? { modelId: raw.modelId } : {}),
    maxExecutionMs,
    enabled: raw.enabled === true,
    ...(typeof raw.askWebhookUrl === "string" ? { askWebhookUrl: raw.askWebhookUrl } : {}),
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : now,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : now,
    ...(isRecord(raw.lastRun) ? { lastRun: raw.lastRun as unknown as RoutineRun } : {}),
    ...(Array.isArray(raw.history) ? { history: raw.history as unknown as RoutineRun[] } : {}),
  };
}

/** Collect the run session ids recorded on a routine's lastRun + history. */
function sessionIdsFromRoutine(routine: Routine, into: Set<string>): void {
  if (routine.lastRun?.sessionId) into.add(routine.lastRun.sessionId);
  for (const run of routine.history ?? []) {
    if (run.sessionId) into.add(run.sessionId);
  }
}

function readStoreFromDisk(agentDir: string): { routines: Map<string, Routine>; sessionIds: Set<string> } {
  const routines = new Map<string, Routine>();
  const sessionIds = new Set<string>();
  try {
    const parsed: unknown = JSON.parse(readFileSync(routinesFilePath(agentDir), "utf8"));
    const list = Array.isArray(parsed)
      ? parsed
      : isRecord(parsed) && Array.isArray(parsed.routines)
        ? parsed.routines
        : [];
    for (const entry of list) {
      const routine = migrateRoutine(entry);
      if (routine) routines.set(routine.id, routine);
    }
    // The persisted, uncapped set is authoritative.
    if (isRecord(parsed) && Array.isArray(parsed.routineSessionIds)) {
      for (const id of parsed.routineSessionIds) {
        if (typeof id === "string" && id) sessionIds.add(id);
      }
    }
    // Backfill from run histories so existing stores (written before this set
    // existed) still hide the runs they can still see.
    for (const routine of routines.values()) sessionIdsFromRoutine(routine, sessionIds);
  } catch {
    // Missing or unreadable file -> empty store.
  }
  return { routines, sessionIds };
}

function ensureLoaded(agentDir: string): void {
  if (globalThis.__ompRoutines && globalThis.__ompRoutinesLoadedFrom === agentDir) return;
  const { routines, sessionIds } = readStoreFromDisk(agentDir);
  globalThis.__ompRoutines = routines;
  globalThis.__ompRoutineSessionIds = sessionIds;
  globalThis.__ompRoutinesLoadedFrom = agentDir;
}

function getStore(agentDir: string): Map<string, Routine> {
  ensureLoaded(agentDir);
  return globalThis.__ompRoutines!;
}

function getSessionIdStore(agentDir: string): Set<string> {
  ensureLoaded(agentDir);
  return globalThis.__ompRoutineSessionIds!;
}

function persist(agentDir: string, store: Map<string, Routine>): void {
  mkdirSync(agentDir, { recursive: true });
  const routines = [...store.values()];
  const routineSessionIds = [...getSessionIdStore(agentDir)];
  writePrivateFileAtomicSync(
    routinesFilePath(agentDir),
    `${JSON.stringify({ routines, routineSessionIds }, null, 2)}\n`,
  );
}

function resolveAgentDir(agentDir?: string): string {
  return agentDir ?? getAgentDir();
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export function listRoutines(agentDir?: string): Routine[] {
  const dir = resolveAgentDir(agentDir);
  return [...getStore(dir).values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function getRoutine(id: string, agentDir?: string): Routine | undefined {
  const dir = resolveAgentDir(agentDir);
  return getStore(dir).get(id);
}

/**
 * Create a routine from validated fields. Callers must validate + authorize the
 * cwd first (see validateRoutineFields and the API's allowed-roots check); this
 * additionally requires the directory to exist.
 */
/** Ensure a webhook trigger has a token, generating or preserving as needed. */
function withWebhookToken(trigger: RoutineTrigger, previous?: RoutineTrigger): RoutineTrigger {
  if (trigger.type !== "webhook") return trigger;
  if (trigger.token) return trigger;
  const carried = previous?.type === "webhook" ? previous.token : "";
  return { type: "webhook", token: carried || generateWebhookToken() };
}

export function createRoutine(fields: ValidatedRoutineFields, agentDir?: string): Routine {
  const dir = resolveAgentDir(agentDir);
  if (!existsSync(fields.cwd)) throw new Error(`Directory does not exist: ${fields.cwd}`);
  const store = getStore(dir);
  const now = new Date().toISOString();
  const routine: Routine = {
    id: randomUUID(),
    ...fields,
    trigger: withWebhookToken(fields.trigger),
    createdAt: now,
    updatedAt: now,
    history: [],
  };
  store.set(routine.id, routine);
  persist(dir, store);
  return routine;
}

export function updateRoutine(id: string, fields: ValidatedRoutineFields, agentDir?: string): Routine {
  const dir = resolveAgentDir(agentDir);
  const store = getStore(dir);
  const existing = store.get(id);
  if (!existing) throw new Error(`Routine not found: ${id}`);
  if (!existsSync(fields.cwd)) throw new Error(`Directory does not exist: ${fields.cwd}`);
  const updated: Routine = {
    ...existing,
    ...fields,
    trigger: withWebhookToken(fields.trigger, existing.trigger),
    // askWebhookUrl is only present in fields when set; clear it otherwise.
    askWebhookUrl: fields.askWebhookUrl,
    id: existing.id,
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
  };
  if (updated.askWebhookUrl === undefined) delete updated.askWebhookUrl;
  store.set(id, updated);
  persist(dir, store);
  return updated;
}

/** Regenerate a webhook routine's token (revokes the old URL). */
export function regenerateWebhookToken(id: string, agentDir?: string): Routine {
  const dir = resolveAgentDir(agentDir);
  const store = getStore(dir);
  const existing = store.get(id);
  if (!existing) throw new Error(`Routine not found: ${id}`);
  if (existing.trigger.type !== "webhook") throw new Error("Routine is not webhook-triggered");
  const updated: Routine = {
    ...existing,
    trigger: { type: "webhook", token: generateWebhookToken() },
    updatedAt: new Date().toISOString(),
  };
  store.set(id, updated);
  persist(dir, store);
  return updated;
}

/** Find a webhook routine by token using a constant-time comparison. */
export function findRoutineByWebhookToken(token: string, agentDir?: string): Routine | undefined {
  if (!token) return undefined;
  const dir = resolveAgentDir(agentDir);
  let match: Routine | undefined;
  for (const routine of getStore(dir).values()) {
    if (routine.trigger.type === "webhook" && tokensEqual(routine.trigger.token, token)) {
      match = routine;
    }
  }
  return match;
}

/** Patch a subset of mutable fields (e.g. the enabled toggle) without full validation. */
export function patchRoutine(id: string, patch: Partial<Pick<Routine, "enabled">>, agentDir?: string): Routine {
  const dir = resolveAgentDir(agentDir);
  const store = getStore(dir);
  const existing = store.get(id);
  if (!existing) throw new Error(`Routine not found: ${id}`);
  const updated: Routine = {
    ...existing,
    ...(patch.enabled !== undefined ? { enabled: patch.enabled === true } : {}),
    updatedAt: new Date().toISOString(),
  };
  store.set(id, updated);
  persist(dir, store);
  return updated;
}

export function deleteRoutine(id: string, agentDir?: string): boolean {
  const dir = resolveAgentDir(agentDir);
  const store = getStore(dir);
  const removed = store.delete(id);
  if (removed) persist(dir, store);
  return removed;
}

/**
 * Record (or update) a run on a routine. Passing a run whose id already exists
 * on lastRun updates it in place (running -> terminal); otherwise it becomes the
 * new lastRun and is pushed onto the capped history.
 */
export function recordRun(id: string, run: RoutineRun, agentDir?: string): Routine | undefined {
  const dir = resolveAgentDir(agentDir);
  const store = getStore(dir);
  const existing = store.get(id);
  if (!existing) return undefined;

  const history = existing.history ? [...existing.history] : [];
  const historyIndex = history.findIndex((entry) => entry.id === run.id);
  if (historyIndex >= 0) {
    history[historyIndex] = run;
  } else {
    history.push(run);
  }
  while (history.length > HISTORY_CAP) history.shift();

  const updated: Routine = {
    ...existing,
    lastRun: run,
    history,
  };
  store.set(id, updated);
  // Track the run's fresh session id so the sidebar can hide it from the normal
  // session list (persistent + uncapped, unlike `history`).
  if (run.sessionId) getSessionIdStore(dir).add(run.sessionId);
  persist(dir, store);
  return updated;
}

/**
 * Every session id created by a routine RUN (persistent + uncapped). The sidebar
 * filters these out of the normal session list; the sessions themselves are
 * still reachable by id via the routine activity view's "Open transcript".
 */
export function listRoutineSessionIds(agentDir?: string): string[] {
  return [...getSessionIdStore(resolveAgentDir(agentDir))];
}

/** Whether a session id belongs to a routine run (hidden from the session list). */
export function isRoutineSessionId(sessionId: string, agentDir?: string): boolean {
  return getSessionIdStore(resolveAgentDir(agentDir)).has(sessionId);
}

/**
 * Merge imported routines into the store (git pull sync): dedupe by id, newest
 * `updatedAt` wins. Only well-formed routines are adopted; unknown/older ones
 * are ignored. Returns the number of routines added or updated.
 */
export function mergeRoutinesIntoStore(incoming: Routine[], agentDir?: string): number {
  const dir = resolveAgentDir(agentDir);
  const store = getStore(dir);
  let changed = 0;
  for (const routine of incoming) {
    const migrated = migrateRoutine(routine);
    if (!migrated) continue;
    const existing = store.get(migrated.id);
    if (existing && Date.parse(migrated.updatedAt) <= Date.parse(existing.updatedAt)) continue;
    store.set(migrated.id, migrated);
    // Adopt any run session ids the incoming routine carries so they stay hidden.
    sessionIdsFromRoutine(migrated, getSessionIdStore(dir));
    changed += 1;
  }
  if (changed > 0) persist(dir, store);
  return changed;
}

/** Test-only: reset the in-memory cache so a test can point at a fresh dir. */
export function __resetRoutineStoreForTests(): void {
  globalThis.__ompRoutines = undefined;
  globalThis.__ompRoutineSessionIds = undefined;
  globalThis.__ompRoutinesLoadedFrom = undefined;
}
