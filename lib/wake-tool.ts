import type { CustomTool, CustomToolContext } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/types";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import {
  cancelWake,
  createWake,
  listWakes,
  type Wake,
} from "./wake-store";
import {
  MAX_WAKE_DELAY_MS,
  MAX_WAKE_EXPIRY_MS,
  MAX_WAKE_GUARD_TIMEOUT_MS,
  MAX_WAKE_INTERVAL_MS,
  MIN_WAKE_DELAY_MS,
  MIN_WAKE_EXPIRY_MS,
  MIN_WAKE_INTERVAL_MS,
  summarizeWake,
  validateWakeInput,
  type WakeInput,
} from "./wake-types";

/**
 * The `smartwake` custom tool.
 *
 * Registered on EVERY omp-web session via `createAgentSession`'s `customTools`
 * option (see lib/rpc-manager.ts `startRpcSession`). It lets a worker schedule a
 * future wake of its OWN session: after a delay, or when a bash poll command
 * starts passing. When the wake fires, the stored message is delivered back into
 * the session so the agent resumes (lib/wake-scheduler.ts).
 */

const DESCRIPTION = [
  "Schedule a future wake of YOUR OWN session, so you can pause now and resume later with a message.",
  "",
  "op=\"create\" (default) schedules a wake. Two modes:",
  "- delayed: give `delayMs` (ms from now) OR `at` (epoch ms / ISO date), plus a `message`.",
  "- guarded: give a `pollCommand` (run via `bash -lc`), `intervalMs`, optional `guardTimeoutMs` and",
  "  `expectOutputMatches` (a regex the stdout must match), plus a `message`. The wake fires the first",
  "  time the command exits 0 (and matches the regex, if given).",
  "Both modes accept `expiresInMs`: if the wake has not fired by then it is dropped. When the wake fires,",
  "`message` is delivered back into this session as a new turn.",
  "",
  "op=\"list\" lists your session's pending wakes. op=\"cancel\" (with `id`) cancels one of your wakes.",
].join("\n");

const PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    op: {
      type: "string",
      enum: ["create", "list", "cancel"],
      description: "Operation. Defaults to \"create\".",
    },
    message: {
      type: "string",
      description: "The text delivered back into this session when the wake fires (required for create).",
    },
    delayMs: {
      type: "number",
      description: `Delayed mode: fire this many ms from now (${MIN_WAKE_DELAY_MS}..${MAX_WAKE_DELAY_MS}).`,
    },
    at: {
      description: "Delayed mode: absolute wake time as epoch ms (number) or an ISO date string.",
    },
    pollCommand: {
      type: "string",
      description: "Guarded mode: shell command run via `bash -lc`; the wake fires when it exits 0.",
    },
    intervalMs: {
      type: "number",
      description: `Guarded mode: poll the command every this many ms (${MIN_WAKE_INTERVAL_MS}..${MAX_WAKE_INTERVAL_MS}).`,
    },
    guardTimeoutMs: {
      type: "number",
      description: `Guarded mode: per-poll timeout in ms (up to ${MAX_WAKE_GUARD_TIMEOUT_MS}).`,
    },
    expectOutputMatches: {
      type: "string",
      description: "Guarded mode: optional regex the command's stdout must match for the wake to fire.",
    },
    expiresInMs: {
      type: "number",
      description: `Drop the wake if it has not fired within this many ms (${MIN_WAKE_EXPIRY_MS}..${MAX_WAKE_EXPIRY_MS}, default 1h).`,
    },
    id: {
      type: "string",
      description: "Wake id to cancel (op=\"cancel\").",
    },
  },
} as const;

function textResult(text: string, isError = false): AgentToolResult<{ wake?: Wake; wakes?: Wake[] }> {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

function describeWakeLine(wake: Wake, now: number): string {
  return `- ${wake.id} [${wake.mode}]: ${summarizeWake(wake, now)}`;
}

/** Build a CustomTool instance. A fresh instance is created per session; the
 *  session identity is read from `ctx.sessionManager` at execute time. */
export function createSmartwakeTool(): CustomTool {
  return {
    name: "smartwake",
    label: "Smart Wake",
    description: DESCRIPTION,
    // Keep it top-level (not hidden behind tool search) so a worker can always reach it.
    loadMode: "essential",
    // The call itself only writes a small JSON record; the eventual guarded poll
    // is equivalent to the bash the agent already has. Classify as read so it does
    // not raise an approval prompt that would block an unattended worker.
    approval: "read",
    parameters: PARAMETERS,
    async execute(_toolCallId, params, _onUpdate, ctx: CustomToolContext) {
      const args = (params ?? {}) as Record<string, unknown> & WakeInput & { op?: unknown; id?: unknown };
      const op = typeof args.op === "string" ? args.op : "create";
      const now = Date.now();

      const sessionId = ctx.sessionManager.getSessionId();
      const cwd = ctx.sessionManager.getCwd();
      const sessionFile = ctx.sessionManager.getSessionFile();

      if (op === "list") {
        const pending = listWakes(sessionId).filter((wake) => wake.status === "pending");
        if (pending.length === 0) return textResult("No pending wakes for this session.");
        const lines = pending.map((wake) => describeWakeLine(wake, now));
        return textResult(`${pending.length} pending wake(s):\n${lines.join("\n")}`);
      }

      if (op === "cancel") {
        const id = typeof args.id === "string" ? args.id.trim() : "";
        if (!id) return textResult("Provide the `id` of the wake to cancel.", true);
        const cancelled = cancelWake(id, sessionId, now);
        if (!cancelled) return textResult(`No pending wake with id "${id}" belongs to this session.`, true);
        return textResult(`Cancelled wake ${id}.`);
      }

      if (op !== "create") {
        return textResult(`Unknown op "${op}". Use "create", "list", or "cancel".`, true);
      }

      const validation = validateWakeInput(args, now);
      if (!validation.ok) return textResult(`smartwake: ${validation.error}`, true);

      let wake: Wake;
      try {
        wake = createWake({
          sessionId,
          cwd,
          ...(sessionFile ? { sessionFile } : {}),
          fields: validation.value,
        });
      } catch (error) {
        return textResult(`smartwake: ${error instanceof Error ? error.message : String(error)}`, true);
      }

      return {
        content: [{ type: "text", text: `Scheduled wake ${wake.id}: ${summarizeWake(wake, now)}` }],
        details: { wake },
      };
    },
  };
}
