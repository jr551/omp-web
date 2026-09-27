import { generateWebhookToken, tokensEqual } from "./webhook-tokens";

/**
 * Outgoing "ask" webhook for headless routine runs.
 *
 * A headless run has no browser attached, so when the agent asks the user
 * something the run would otherwise hang until its maxExecutionMs abort. If the
 * routine configures an `askWebhookUrl`, the question is POSTed there with a
 * single-use, expiring `respondUrl`; whoever holds that URL may answer that ONE
 * question and nothing else. If no webhook is configured, or no answer arrives
 * before expiry, the ask resolves with a safe default so the run never hangs.
 *
 * The wait/respond/expire logic is injectable (fetch + token generator) so it is
 * unit-tested with no real network.
 */

export interface PendingQuestionResult {
  answer: string;
  timedOut: boolean;
}

interface PendingQuestion {
  token: string;
  settle: (result: PendingQuestionResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

declare global {
  var __ompPendingQuestions: Map<string, PendingQuestion> | undefined;
}

function registry(): Map<string, PendingQuestion> {
  if (!globalThis.__ompPendingQuestions) globalThis.__ompPendingQuestions = new Map();
  return globalThis.__ompPendingQuestions;
}

/**
 * Register a pending question. Resolves when {@link resolvePendingQuestion} is
 * called with the token, or after `timeoutMs` with the default answer.
 */
export function registerPendingQuestion(token: string, timeoutMs: number, defaultAnswer: string): Promise<PendingQuestionResult> {
  const map = registry();
  return new Promise<PendingQuestionResult>((resolve) => {
    let settled = false;
    const settle = (result: PendingQuestionResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      map.delete(token);
      resolve(result);
    };
    const timer = setTimeout(() => settle({ answer: defaultAnswer, timedOut: true }), Math.max(0, timeoutMs));
    if (typeof timer === "object" && "unref" in timer) (timer as { unref: () => void }).unref();
    map.set(token, { token, settle, timer });
  });
}

/**
 * Answer a pending question. Single-use and constant-time: the token is compared
 * against every live entry, and a match resolves and removes it.
 */
export function resolvePendingQuestion(token: string, answer: string): boolean {
  if (!token) return false;
  const map = registry();
  for (const entry of map.values()) {
    if (tokensEqual(entry.token, token)) {
      entry.settle({ answer, timedOut: false });
      return true;
    }
  }
  return false;
}

export interface AskViaWebhookOptions {
  question: string;
  askWebhookUrl: string;
  respondBaseUrl: string;
  routineId: string;
  runId: string;
  timeoutMs: number;
  defaultAnswer: string;
  now?: () => number;
  fetchImpl?: typeof fetch;
  generateToken?: () => string;
}

export interface AskOutcome {
  answer: string;
  asked: boolean;
  answered: boolean;
  timedOut: boolean;
}

/**
 * Ask a question via the outgoing webhook and wait for the answer. Falls back to
 * the default answer if the POST fails or the answer does not arrive in time.
 */
export async function askViaWebhook(options: AskViaWebhookOptions): Promise<AskOutcome> {
  const now = options.now ?? Date.now;
  const fetchImpl = options.fetchImpl ?? fetch;
  const token = (options.generateToken ?? generateWebhookToken)();
  const respondUrl = `${options.respondBaseUrl.replace(/\/+$/, "")}/api/routines/respond/${token}`;
  const expiresAt = new Date(now() + options.timeoutMs).toISOString();

  const waiting = registerPendingQuestion(token, options.timeoutMs, options.defaultAnswer);

  try {
    await fetchImpl(options.askWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        routineId: options.routineId,
        runId: options.runId,
        question: options.question,
        respondUrl,
        expiresAt,
      }),
    });
  } catch {
    // The question could not be delivered; resolve immediately with the default.
    resolvePendingQuestion(token, options.defaultAnswer);
    const result = await waiting;
    return { answer: result.answer, asked: false, answered: false, timedOut: false };
  }

  const result = await waiting;
  return { answer: result.answer, asked: true, answered: !result.timedOut, timedOut: result.timedOut };
}

/** Test-only: clear the pending-question registry. */
export function __resetPendingQuestionsForTests(): void {
  const map = globalThis.__ompPendingQuestions;
  if (map) {
    for (const entry of map.values()) clearTimeout(entry.timer);
    map.clear();
  }
  globalThis.__ompPendingQuestions = undefined;
}
