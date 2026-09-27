import assert from "node:assert/strict";
import test from "node:test";

import { evaluateGuard, guardPasses, runGuardCommand } from "./guard-command.ts";

test("guardPasses handles exit code, timeout, and regex", () => {
  assert.deepEqual(guardPasses({ exitCode: 0, stdout: "", stderr: "", timedOut: false }), { passed: true });
  assert.equal(guardPasses({ exitCode: 2, stdout: "", stderr: "", timedOut: false }).passed, false);
  assert.equal(guardPasses({ exitCode: 0, stdout: "", stderr: "", timedOut: true }).passed, false);
  assert.equal(guardPasses({ exitCode: 0, stdout: "OK ready", stderr: "", timedOut: false }, "ready").passed, true);
  assert.equal(guardPasses({ exitCode: 0, stdout: "busy", stderr: "", timedOut: false }, "ready").passed, false);
  assert.equal(guardPasses({ exitCode: 0, stdout: "x", stderr: "", timedOut: false }, "(").passed, false);
});

test("evaluateGuard uses an injectable runner", async () => {
  const fakeRunner = async () => ({ exitCode: 0, stdout: "healthy", stderr: "", timedOut: false });
  const verdict = await evaluateGuard("curl x", { timeoutMs: 1000, expectOutputMatches: "healthy", runner: fakeRunner });
  assert.equal(verdict.passed, true);

  const failing = await evaluateGuard("curl x", { timeoutMs: 1000, runner: async () => ({ exitCode: 7, stdout: "", stderr: "", timedOut: false }) });
  assert.equal(failing.passed, false);
});

test("evaluateGuard reports runner exceptions as not-passed", async () => {
  const verdict = await evaluateGuard("x", { timeoutMs: 1000, runner: async () => { throw new Error("spawn failed"); } });
  assert.equal(verdict.passed, false);
  assert.match(verdict.reason, /spawn failed/);
});

test("runGuardCommand runs a real bash command", async () => {
  const controller = new AbortController();
  const result = await runGuardCommand("echo hello && exit 0", 5000, controller.signal);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /hello/);
  assert.equal(result.timedOut, false);
});

test("runGuardCommand reports a non-zero exit", async () => {
  const controller = new AbortController();
  const result = await runGuardCommand("exit 3", 5000, controller.signal);
  assert.equal(result.exitCode, 3);
});

test("runGuardCommand enforces a timeout", async () => {
  const controller = new AbortController();
  const result = await runGuardCommand("sleep 5", 200, controller.signal);
  assert.equal(result.timedOut, true);
});
