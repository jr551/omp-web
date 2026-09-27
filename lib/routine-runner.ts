import { randomUUID } from "crypto";
import type { AgentSessionWrapper } from "./rpc-manager";

/**
 * The "deliver a prompt into a session run" path, factored out of the scheduler
 * so other features (e.g. a future "smartwake" tool that re-enters an existing
 * session on a delay or condition) can reuse it. Kept free of the routine data
 * model on purpose — it operates on a session wrapper + a prompt string.
 */

export interface RunOutcome {
  summary: string;
  sessionId?: string;
}

export interface RunPromptOptions {
  /** Shut the session down once the run settles (fresh unattended sessions). */
  shutdownOnDone?: boolean;
}

/**
 * Send a prompt into an existing session and resolve once it completes with the
 * last assistant text as the summary. Rejects on prompt error or abort.
 */
export function runPromptInSession(
  session: AgentSessionWrapper,
  prompt: string,
  signal: AbortSignal,
  options: RunPromptOptions = {},
): Promise<RunOutcome> {
  const sessionId = session.sessionId;
  return new Promise<RunOutcome>((resolve, reject) => {
    let done = false;
    const shutdown = () => { if (options.shutdownOnDone) void session.shutdown().catch(() => {}); };

    const finishSuccess = () => {
      if (done) return;
      done = true;
      cleanup();
      void session.send({ type: "get_last_assistant_text" })
        .then((result) => resolve({ summary: (result as { text?: string })?.text ?? "", sessionId }))
        .catch(() => resolve({ summary: "", sessionId }))
        .finally(shutdown);
    };
    const finishError = (message: string) => {
      if (done) return;
      done = true;
      cleanup();
      shutdown();
      reject(new Error(message));
    };

    const unsubscribe = session.onEvent((event) => {
      if (event.type === "prompt_error") {
        finishError(typeof event.errorMessage === "string" ? event.errorMessage : "Prompt failed");
      } else if (event.type === "prompt_done") {
        finishSuccess();
      }
    });
    const onAbort = () => finishError("aborted");
    signal.addEventListener("abort", onAbort);
    function cleanup() {
      unsubscribe();
      signal.removeEventListener("abort", onAbort);
    }

    if (signal.aborted) {
      finishError("aborted");
      return;
    }
    void session.send({ type: "prompt", message: prompt }).catch((error) => {
      finishError(error instanceof Error ? error.message : String(error));
    });
  });
}

export interface FreshSessionRunOptions {
  cwd: string;
  prompt: string;
  provider?: string;
  modelId?: string;
  toolNames?: string[];
}

/**
 * Create a fresh unattended session in `cwd`, deliver the prompt, and shut it
 * down when finished. This is the runner the routine scheduler uses.
 */
export async function runPromptInFreshSession(options: FreshSessionRunOptions, signal: AbortSignal): Promise<RunOutcome> {
  const { startRpcSession } = await import("./rpc-manager");
  const { allowFileRoot } = await import("./file-access");
  const { PRESET_DEFAULT } = await import("./tool-presets");

  allowFileRoot(options.cwd);
  const tempKey = `__routine__${randomUUID()}`;
  const { session } = await startRpcSession(tempKey, "", options.cwd, {
    toolNames: options.toolNames ?? PRESET_DEFAULT,
    ...(options.provider && options.modelId ? { initialModel: { provider: options.provider, modelId: options.modelId } } : {}),
  });
  return runPromptInSession(session, options.prompt, signal, { shutdownOnDone: true });
}
