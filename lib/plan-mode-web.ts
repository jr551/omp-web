// Plan-mode transitions for browser sessions.
//
// The SDK's `/plan` slash command is TUI-only (`builtin-modes.ts` ships just
// `handleTui`), so `executeAcpBuiltinSlashCommand` leaves it unhandled and the
// browser used to send it to the model as a plain prompt. These helpers mirror
// the SDK's ACP mode change (`acp-agent.ts #applyModeChange`): set or clear
// `PlanModeState` plus the plan-proposal handler, and persist a `mode_change`
// entry so the journal the TUI writes and reads stays the source of truth
// across TUI <-> web restores. The module has no runtime imports so the client
// can use the `/plan` parser too.

/** Mirrors the ACP agent's default plan file (`DEFAULT_PLAN_FILE_URL`). */
export const WEB_DEFAULT_PLAN_FILE_URL = "local://PLAN.md";

export interface WebPlanModeSnapshot {
  enabled: boolean;
  planFilePath: string;
  workflow?: "parallel" | "sequential";
  reentry?: boolean;
}

/** Serializable plan-mode state shared by `get_state`, `set_plan_mode` and the session detail endpoint. */
export interface WebPlanModeInfo {
  enabled: boolean;
  planFilePath?: string;
}

export type WebPlanProposalHandler = (title: string) => Promise<{
  content: Array<{ type: "text"; text: string }>;
  details?: unknown;
}>;

/** Structural slice of the SDK session these helpers touch. */
export interface WebPlanModeSession {
  getPlanModeState?(): WebPlanModeSnapshot | undefined;
  setPlanModeState?(state: WebPlanModeSnapshot | undefined): void;
  setPlanProposalHandler?(handler: WebPlanProposalHandler | null): void;
  sessionManager: {
    appendModeChange(mode: string, data?: Record<string, unknown>): unknown;
  };
}

export type ModeChangeEntryLike = {
  type?: string;
  mode?: string;
  data?: Record<string, unknown>;
};

/**
 * Plan-mode state recorded in a session journal: the last `mode_change` entry
 * wins. A `plan` entry without a plan file path is ignored, because recovery
 * needs the file to steer proposals.
 */
export function readPersistedPlanModeState(
  entries: readonly ModeChangeEntryLike[],
): WebPlanModeSnapshot | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== "mode_change") continue;
    const planFilePath = entry.data?.planFilePath;
    if (entry.mode === "plan" && typeof planFilePath === "string" && planFilePath.length > 0) {
      return {
        enabled: true,
        planFilePath,
        workflow: entry.data?.workflow === "sequential" ? "sequential" : "parallel",
        reentry: true,
      };
    }
    return undefined;
  }
  return undefined;
}

export function toWebPlanModeInfo(state: WebPlanModeSnapshot | undefined): WebPlanModeInfo {
  return state?.enabled ? { enabled: true, planFilePath: state.planFilePath } : { enabled: false };
}

/**
 * Enter or exit plan mode with ACP semantics: entering sets `PlanModeState`
 * (keeping an earlier plan file, `reentry` when plan mode ran before) and
 * installs the handler that consumes `xd://propose`; exiting clears both. Each
 * real transition persists a `mode_change` entry. The SDK's plan-mode guard
 * enforces the read-only working tree from the state alone.
 */
export function applyWebPlanModeTransition(
  session: WebPlanModeSession,
  enabled: boolean,
  proposalHandler: WebPlanProposalHandler,
): WebPlanModeInfo {
  const previous = session.getPlanModeState?.();
  if (enabled) {
    const planFilePath = previous?.planFilePath ?? WEB_DEFAULT_PLAN_FILE_URL;
    session.setPlanModeState?.({
      enabled: true,
      planFilePath,
      workflow: previous?.workflow ?? "parallel",
      reentry: previous !== undefined,
    });
    session.setPlanProposalHandler?.(proposalHandler);
    if (!previous?.enabled || previous.planFilePath !== planFilePath) {
      session.sessionManager.appendModeChange("plan", { planFilePath });
    }
    return { enabled: true, planFilePath };
  }

  session.setPlanProposalHandler?.(null);
  session.setPlanModeState?.(undefined);
  if (previous?.enabled) session.sessionManager.appendModeChange("none");
  return { enabled: false };
}

/**
 * `/plan` with TUI toggle semantics: when plan mode is off it enters it and any
 * trailing text becomes the first planning prompt; when it is on it exits.
 * Returns null for any other input.
 */
export function planSlashCommandIntent(
  text: string,
  currentEnabled: boolean,
): { enabled: boolean; prompt?: string } | null {
  const match = text.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
  if (!match || match[1] !== "plan") return null;
  if (currentEnabled) return { enabled: false };
  const prompt = (match[2] ?? "").trim();
  return prompt ? { enabled: true, prompt } : { enabled: true };
}

/**
 * Result of the web `/plan` builtin. A failed transition returns `error`, so
 * the composer keeps the unsent text and nothing is dispatched; only a
 * successful transition clears the input (and sends a trailing prompt).
 */
export function planSlashCommandOutcome(
  intent: { enabled: boolean; prompt?: string },
  transitionError: string | null,
): { handled: true; error?: string; prompt?: string; message?: string } {
  if (transitionError !== null) return { handled: true, error: transitionError };
  return {
    handled: true,
    ...(intent.prompt ? { prompt: intent.prompt } : {}),
    message: intent.enabled ? "Plan mode enabled" : "Plan mode disabled",
  };
}
