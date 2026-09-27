import assert from "node:assert/strict";
import test from "node:test";

import {
  validateWakeInput,
  summarizeWake,
  humanizeDuration,
  DEFAULT_WAKE_EXPIRY_MS,
  DEFAULT_WAKE_GUARD_TIMEOUT_MS,
  MAX_WAKE_DELAY_MS,
} from "./wake-types.ts";
import { createSmartwakeTool } from "./wake-tool.ts";
import { __resetWakeStoreForTests } from "./wake-store.ts";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";
import { setAgentDir } from "@oh-my-pi/pi-utils";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const NOW = 1_000_000;

test("validateWakeInput rejects a missing message", () => {
  const r = validateWakeInput({ delayMs: 10_000 }, NOW);
  assert.equal(r.ok, false);
  assert.match(r.error, /message is required/);
});

test("validateWakeInput requires a mode hint", () => {
  const r = validateWakeInput({ message: "hi" }, NOW);
  assert.equal(r.ok, false);
  assert.match(r.error, /delayMs or at.*pollCommand/);
});

test("validateWakeInput parses a delayed wake with delayMs and default expiry", () => {
  const r = validateWakeInput({ message: "resume", delayMs: 600_000 }, NOW);
  assert.equal(r.ok, true);
  assert.equal(r.value.mode, "delayed");
  assert.equal(r.value.fireAt, NOW + 600_000);
  assert.equal(r.value.expiresAt, NOW + DEFAULT_WAKE_EXPIRY_MS);
});

test("validateWakeInput accepts an absolute `at` as ISO or epoch ms", () => {
  const target = NOW + 3_600_000;
  const iso = validateWakeInput({ message: "x", at: new Date(target).toISOString(), expiresInMs: 7_200_000 }, NOW);
  assert.equal(iso.ok, true);
  assert.equal(iso.value.fireAt, target);
  const epoch = validateWakeInput({ message: "x", at: target, expiresInMs: 7_200_000 }, NOW);
  assert.equal(epoch.ok, true);
  assert.equal(epoch.value.fireAt, target);
});

test("validateWakeInput enforces delay bounds and expiry ordering", () => {
  assert.equal(validateWakeInput({ message: "x", delayMs: 10 }, NOW).ok, false); // below min
  assert.equal(validateWakeInput({ message: "x", delayMs: MAX_WAKE_DELAY_MS + 1 }, NOW).ok, false); // above max
  // fireAt after expiry.
  const r = validateWakeInput({ message: "x", delayMs: 600_000, expiresInMs: 60_000 }, NOW);
  assert.equal(r.ok, false);
  assert.match(r.error, /after the expiry/);
});

test("validateWakeInput parses a guarded wake and defaults the guard timeout", () => {
  const r = validateWakeInput({ message: "built", pollCommand: "make", intervalMs: 60_000 }, NOW);
  assert.equal(r.ok, true);
  assert.equal(r.value.mode, "guarded");
  assert.equal(r.value.pollCommand, "make");
  assert.equal(r.value.intervalMs, 60_000);
  assert.equal(r.value.guardTimeoutMs, DEFAULT_WAKE_GUARD_TIMEOUT_MS);
});

test("validateWakeInput requires intervalMs and a valid regex for guarded wakes", () => {
  assert.equal(validateWakeInput({ message: "x", pollCommand: "make" }, NOW).ok, false); // no interval
  const bad = validateWakeInput({ message: "x", pollCommand: "make", intervalMs: 60_000, expectOutputMatches: "(" }, NOW);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /invalid expectOutputMatches/);
});

test("humanizeDuration renders seconds/minutes/hours", () => {
  assert.equal(humanizeDuration(45_000), "45s");
  assert.equal(humanizeDuration(600_000), "10m");
  assert.equal(humanizeDuration(90_000), "1m 30s");
  assert.equal(humanizeDuration(2 * 3_600_000 + 5 * 60_000), "2h 5m");
});

test("summarizeWake produces human summaries for both modes", () => {
  const delayed = summarizeWake({ mode: "delayed", fireAt: NOW + 600_000, expiresAt: NOW + 3_600_000 }, NOW);
  assert.match(delayed, /will wake in 10m/);
  assert.match(delayed, /expires in 1h/);
  const guarded = summarizeWake(
    { mode: "guarded", pollCommand: "make test", intervalMs: 120_000, expiresAt: NOW + 7_200_000 },
    NOW,
  );
  assert.match(guarded, /will wake when `make test` succeeds/);
  assert.match(guarded, /polling every 2m/);
  assert.match(guarded, /expires in 2h/);
});

test("createSmartwakeTool exposes the expected CustomTool contract", () => {
  const tool = createSmartwakeTool();
  assert.equal(tool.name, "smartwake");
  assert.equal(tool.loadMode, "essential");
  assert.equal(tool.approval, "read");
  assert.equal(typeof tool.execute, "function");
  assert.equal(tool.parameters.type, "object");
  assert.ok(tool.parameters.properties.op);
  assert.ok(tool.parameters.properties.message);
  assert.ok(tool.parameters.properties.pollCommand);
});

test("smartwake execute create/list/cancel round-trips via a fake context", async () => {
  // Redirect the agent dir to a temp dir so the tool's default-dir store writes
  // are isolated, then restore it so no other test suite is affected.
  const original = getAgentDir();
  const temp = mkdtempSync(join(tmpdir(), "omp-wake-tool-"));
  __resetWakeStoreForTests();
  setAgentDir(temp);
  try {
    const tool = createSmartwakeTool();
    const sessionId = "sess-round-trip";
    const ctx = {
      sessionManager: {
        getSessionId: () => sessionId,
        getCwd: () => "/tmp",
        getSessionFile: () => `/tmp/${sessionId}.jsonl`,
      },
    };

    const created = await tool.execute("c1", { message: "resume me", delayMs: 600_000 }, undefined, ctx);
    assert.equal(created.isError, undefined);
    assert.match(created.content[0].text, /Scheduled wake/);
    const wakeId = created.details.wake.id;
    assert.equal(created.details.wake.sessionId, sessionId);

    const listed = await tool.execute("c2", { op: "list" }, undefined, ctx);
    assert.match(listed.content[0].text, new RegExp(wakeId));

    // Another session cannot cancel this wake.
    const otherCtx = { sessionManager: { getSessionId: () => "someone-else", getCwd: () => "/tmp", getSessionFile: () => "/tmp/o.jsonl" } };
    const denied = await tool.execute("c3", { op: "cancel", id: wakeId }, undefined, otherCtx);
    assert.equal(denied.isError, true);

    const cancelled = await tool.execute("c4", { op: "cancel", id: wakeId }, undefined, ctx);
    assert.match(cancelled.content[0].text, /Cancelled wake/);

    const emptied = await tool.execute("c5", { op: "list" }, undefined, ctx);
    assert.match(emptied.content[0].text, /No pending wakes/);
  } finally {
    setAgentDir(original);
    __resetWakeStoreForTests();
  }
});
