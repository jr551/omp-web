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
  /** Human-readable note about interaction (e.g. a question was asked). */
  note?: string;
}

/** A response to a blocking extension-UI request during a headless run. */
export type UiResolution =
  | { value: string }
  | { confirmed: boolean }
  | { cancelled: true };

interface UiRequestEvent {
  type: string;
  id?: string;
  method?: string;
  title?: string;
  message?: string;
  placeholder?: string;
  options?: string[];
}

const BLOCKING_UI_METHODS = new Set(["select", "ask", "confirm", "input", "editor", "custom"]);

export interface RunPromptOptions {
  /** Shut the session down once the run settles (fresh unattended sessions). */
  shutdownOnDone?: boolean;
  /**
   * Resolve a blocking extension-UI request (a question) during the run. When
   * omitted, every blocking request is safely declined so the run never hangs.
   * Returning a resolution answers it; the note (if any) is surfaced on the
   * outcome.
   */
  onBlockingUiRequest?: (request: UiRequestEvent) => Promise<{ resolution: UiResolution; note?: string }>;
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
  let note: string | undefined;
  return new Promise<RunOutcome>((resolve, reject) => {
    let done = false;
    const shutdown = () => { if (options.shutdownOnDone) void session.shutdown().catch(() => {}); };

    const finishSuccess = () => {
      if (done) return;
      done = true;
      cleanup();
      void session.send({ type: "get_last_assistant_text" })
        .then((result) => resolve({ summary: (result as { text?: string })?.text ?? "", sessionId, ...(note ? { note } : {}) }))
        .catch(() => resolve({ summary: "", sessionId, ...(note ? { note } : {}) }))
        .finally(shutdown);
    };
    const finishError = (message: string) => {
      if (done) return;
      done = true;
      cleanup();
      shutdown();
      reject(new Error(message));
    };

    const handleUiRequest = (event: UiRequestEvent) => {
      const id = event.id;
      if (!id || !event.method || !BLOCKING_UI_METHODS.has(event.method)) return;
      const respond = (resolution: UiResolution) => {
        void session.send({ type: "extension_ui_response", id, ...resolution }).catch(() => {});
      };
      if (!options.onBlockingUiRequest) {
        respond({ cancelled: true }); // no handler: decline so we never hang
        return;
      }
      void options.onBlockingUiRequest(event)
        .then(({ resolution, note: askNote }) => {
          if (askNote) note = askNote;
          respond(resolution);
        })
        .catch(() => respond({ cancelled: true }));
    };

    const unsubscribe = session.onEvent((event) => {
      if (event.type === "extension_ui_request") {
        handleUiRequest(event as UiRequestEvent);
      } else if (event.type === "prompt_error") {
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
  /** Outgoing ask webhook + budget for routing headless questions to the user. */
  askWebhookUrl?: string;
  maxExecutionMs?: number;
  routineId?: string;
}

/** Build a short human-readable question from a blocking UI request. */
function questionText(request: UiRequestEvent): string {
  const parts = [request.title, request.message, request.placeholder].filter((p): p is string => Boolean(p));
  if (request.options?.length) parts.push(`Options: ${request.options.join(", ")}`);
  return parts.join("\n") || "The routine is asking for input.";
}

/** Map a free-text answer back into the response the UI request expects. */
function resolutionFromAnswer(request: UiRequestEvent, answer: string): UiResolution {
  if (request.method === "confirm") return { confirmed: /^(y|yes|true|1|confirm|ok)/i.test(answer.trim()) };
  if (!answer.trim()) return { cancelled: true };
  return { value: answer };
}

/**
 * Create a fresh unattended session in `cwd`, deliver the prompt, and shut it
 * down when finished. This is the runner the routine scheduler uses.
 *
 * Blocking questions during the run are routed to the routine's ask webhook when
 * configured, and otherwise declined — either way the run never hangs.
 */
export async function runPromptInFreshSession(options: FreshSessionRunOptions, signal: AbortSignal): Promise<RunOutcome> {
  const { startRpcSession } = await import("./rpc-manager");
  const { allowFileRoot } = await import("./file-access");
  const { PRESET_DEFAULT } = await import("./tool-presets");

  allowFileRoot(options.cwd);
  const tempKey = `__routine__${randomUUID()}`;
  const { session, realSessionId } = await startRpcSession(tempKey, "", options.cwd, {
    toolNames: options.toolNames ?? PRESET_DEFAULT,
    ...(options.provider && options.modelId ? { initialModel: { provider: options.provider, modelId: options.modelId } } : {}),
  });

  // Only the simple, unambiguous question methods are routed to the webhook; the
  // complex multi-question `ask`/`editor`/`custom` dialogs are declined.
  const askable = new Set(["input", "confirm", "select"]);
  const onBlockingUiRequest = options.askWebhookUrl
    ? async (request: UiRequestEvent): Promise<{ resolution: UiResolution; note?: string }> => {
        if (!request.method || !askable.has(request.method)) {
          return { resolution: { cancelled: true }, note: "declined an unsupported headless prompt" };
        }
        const { askViaWebhook } = await import("./routine-ask");
        const { getExternalBaseUrl } = await import("./omp-web-config");
        const outcome = await askViaWebhook({
          question: questionText(request),
          askWebhookUrl: options.askWebhookUrl!,
          respondBaseUrl: getExternalBaseUrl() ?? "",
          routineId: options.routineId ?? realSessionId,
          runId: realSessionId,
          timeoutMs: Math.max(5_000, Math.min(options.maxExecutionMs ?? 60_000, 60 * 60_000)),
          defaultAnswer: "",
        });
        if (!outcome.answered) {
          return { resolution: { cancelled: true }, note: outcome.timedOut ? "asked the user (no answer, declined)" : "could not reach ask webhook (declined)" };
        }
        return { resolution: resolutionFromAnswer(request, outcome.answer), note: "asked the user and got an answer" };
      }
    : undefined;

  return runPromptInSession(session, options.prompt, signal, { shutdownOnDone: true, ...(onBlockingUiRequest ? { onBlockingUiRequest } : {}) });
}
