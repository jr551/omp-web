import assert from "node:assert/strict";
import test from "node:test";

import {
  registerPendingQuestion,
  resolvePendingQuestion,
  askViaWebhook,
  __resetPendingQuestionsForTests,
} from "./routine-ask.ts";

test("a pending question resolves when answered before expiry", async () => {
  __resetPendingQuestionsForTests();
  const waiting = registerPendingQuestion("tok-1", 5000, "DEFAULT");
  assert.equal(resolvePendingQuestion("tok-1", "hello"), true);
  const result = await waiting;
  assert.deepEqual(result, { answer: "hello", timedOut: false });
});

test("a pending question expires with the default answer", async () => {
  __resetPendingQuestionsForTests();
  const waiting = registerPendingQuestion("tok-2", 30, "DECLINE");
  const result = await waiting;
  assert.deepEqual(result, { answer: "DECLINE", timedOut: true });
});

test("resolving is single-use and unknown tokens fail", async () => {
  __resetPendingQuestionsForTests();
  const waiting = registerPendingQuestion("tok-3", 5000, "d");
  assert.equal(resolvePendingQuestion("tok-3", "a"), true);
  assert.equal(resolvePendingQuestion("tok-3", "b"), false); // already settled/removed
  assert.equal(resolvePendingQuestion("nope", "b"), false);
  await waiting;
});

test("askViaWebhook posts the question and resolves with the answer", async () => {
  __resetPendingQuestionsForTests();
  let posted = null;
  const fetchImpl = async (url, init) => {
    posted = { url, body: JSON.parse(init.body) };
    // Simulate the receiver answering via the respond endpoint.
    resolvePendingQuestion(posted.body.respondUrl.split("/").pop(), "the answer");
    return { ok: true };
  };
  const outcome = await askViaWebhook({
    question: "Proceed?",
    askWebhookUrl: "https://hooks.example.com/ask",
    respondBaseUrl: "https://omp.example.com",
    routineId: "r1",
    runId: "run1",
    timeoutMs: 5000,
    defaultAnswer: "",
    fetchImpl,
    generateToken: () => "fixed-token",
  });
  assert.equal(posted.url, "https://hooks.example.com/ask");
  assert.equal(posted.body.respondUrl, "https://omp.example.com/api/routines/respond/fixed-token");
  assert.equal(posted.body.question, "Proceed?");
  assert.deepEqual(outcome, { answer: "the answer", asked: true, answered: true, timedOut: false });
});

test("askViaWebhook times out with the default when unanswered", async () => {
  __resetPendingQuestionsForTests();
  const outcome = await askViaWebhook({
    question: "Q",
    askWebhookUrl: "https://hooks.example.com/ask",
    respondBaseUrl: "https://omp.example.com",
    routineId: "r1",
    runId: "run1",
    timeoutMs: 30,
    defaultAnswer: "DEFAULT",
    fetchImpl: async () => ({ ok: true }),
    generateToken: () => "t2",
  });
  assert.equal(outcome.answered, false);
  assert.equal(outcome.timedOut, true);
  assert.equal(outcome.answer, "DEFAULT");
});

test("askViaWebhook falls back when the POST fails", async () => {
  __resetPendingQuestionsForTests();
  const outcome = await askViaWebhook({
    question: "Q",
    askWebhookUrl: "https://hooks.example.com/ask",
    respondBaseUrl: "https://omp.example.com",
    routineId: "r1",
    runId: "run1",
    timeoutMs: 5000,
    defaultAnswer: "SAFE",
    fetchImpl: async () => { throw new Error("network down"); },
    generateToken: () => "t3",
  });
  assert.equal(outcome.asked, false);
  assert.equal(outcome.answer, "SAFE");
});
