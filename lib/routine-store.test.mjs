import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  validateRoutineFields,
  normalizeTrigger,
  createRoutine,
  updateRoutine,
  patchRoutine,
  deleteRoutine,
  listRoutines,
  recordRun,
  getRoutine,
  regenerateWebhookToken,
  findRoutineByWebhookToken,
  __resetRoutineStoreForTests,
  HISTORY_CAP,
  DEFAULT_EXECUTION_MS,
  DEFAULT_GUARD_TIMEOUT_MS,
} from "./routine-store.ts";

function freshDir() {
  __resetRoutineStoreForTests();
  return mkdtempSync(join(tmpdir(), "omp-routines-"));
}

test("validateRoutineFields accepts a valid cron routine", () => {
  const result = validateRoutineFields({
    name: "Nightly",
    cwd: "/tmp/project",
    trigger: { type: "cron", schedule: "0 9 * * *" },
    prompt: "Do the thing",
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.trigger.type, "cron");
  assert.equal(result.value.maxExecutionMs, DEFAULT_EXECUTION_MS);
  assert.equal(result.value.enabled, true);
});

test("validateRoutineFields rejects empties and bad input", () => {
  assert.equal(validateRoutineFields({ name: "", cwd: "/x", prompt: "p", trigger: { type: "cron", schedule: "* * * * *" } }).ok, false);
  assert.equal(validateRoutineFields({ name: "n", cwd: "", prompt: "p", trigger: { type: "cron", schedule: "* * * * *" } }).ok, false);
  assert.equal(validateRoutineFields({ name: "n", cwd: "/x", prompt: "", trigger: { type: "cron", schedule: "* * * * *" } }).ok, false);
  assert.equal(validateRoutineFields({ name: "n", cwd: "/x", prompt: "p", trigger: { type: "cron", schedule: "nope" } }).ok, false);
  assert.equal(validateRoutineFields({ name: "n", cwd: "/x", prompt: "p" }).ok, false);
});

test("validateRoutineFields enforces model pairing and exec bounds", () => {
  assert.equal(validateRoutineFields({ name: "n", cwd: "/x", prompt: "p", trigger: { type: "cron", schedule: "* * * * *" }, provider: "anthropic" }).ok, false);
  assert.equal(validateRoutineFields({ name: "n", cwd: "/x", prompt: "p", trigger: { type: "cron", schedule: "* * * * *" }, maxExecutionMs: 5 }).ok, false);
  assert.equal(validateRoutineFields({ name: "n", cwd: "/x", prompt: "p", trigger: { type: "cron", schedule: "* * * * *" }, maxExecutionMs: 999999999 }).ok, false);
  const ok = validateRoutineFields({ name: "n", cwd: "/x", prompt: "p", trigger: { type: "cron", schedule: "* * * * *" }, provider: "anthropic", modelId: "claude" });
  assert.equal(ok.ok, true);
  assert.equal(ok.value.provider, "anthropic");
});

test("validateRoutineFields validates guard triggers", () => {
  const ok = validateRoutineFields({
    name: "Guarded",
    cwd: "/x",
    prompt: "p",
    trigger: { type: "guard", intervalMs: 60000, command: "curl -f https://x", expectOutputMatches: "ok" },
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.value.trigger.type, "guard");
  assert.equal(ok.value.trigger.guardTimeoutMs, DEFAULT_GUARD_TIMEOUT_MS);
  assert.equal(ok.value.trigger.expectOutputMatches, "ok");

  assert.equal(validateRoutineFields({ name: "n", cwd: "/x", prompt: "p", trigger: { type: "guard", intervalMs: 60000, command: "" } }).ok, false);
  assert.equal(validateRoutineFields({ name: "n", cwd: "/x", prompt: "p", trigger: { type: "guard", intervalMs: 5, command: "x" } }).ok, false);
  assert.equal(validateRoutineFields({ name: "n", cwd: "/x", prompt: "p", trigger: { type: "guard", intervalMs: 60000, command: "x", expectOutputMatches: "(" } }).ok, false);
});

test("normalizeTrigger migrates a legacy schedule string", () => {
  const trigger = normalizeTrigger({ schedule: "0 0 * * *" });
  assert.deepEqual(trigger, { type: "cron", schedule: "0 0 * * *" });
});

test("CRUD lifecycle persists to disk atomically with 0600", () => {
  const dir = freshDir();
  const validated = validateRoutineFields({
    name: "Nightly",
    cwd: dir, // an existing dir
    trigger: { type: "cron", schedule: "0 9 * * *" },
    prompt: "Summarize",
  });
  assert.equal(validated.ok, true);

  const created = createRoutine(validated.value, dir);
  assert.ok(created.id);
  assert.equal(listRoutines(dir).length, 1);

  const filePath = join(dir, "omp-web-routines.json");
  const mode = statSync(filePath).mode & 0o777;
  assert.equal(mode, 0o600);

  const patched = patchRoutine(created.id, { enabled: false }, dir);
  assert.equal(patched.enabled, false);

  const reValidated = validateRoutineFields({
    name: "Renamed",
    cwd: dir,
    trigger: { type: "cron", schedule: "0 10 * * *" },
    prompt: "Summarize v2",
  });
  const updated = updateRoutine(created.id, reValidated.value, dir);
  assert.equal(updated.name, "Renamed");
  assert.equal(updated.createdAt, created.createdAt);

  assert.equal(deleteRoutine(created.id, dir), true);
  assert.equal(listRoutines(dir).length, 0);
});

test("createRoutine rejects a non-existent cwd", () => {
  const dir = freshDir();
  const validated = validateRoutineFields({
    name: "Bad",
    cwd: "/no/such/dir/hopefully",
    trigger: { type: "cron", schedule: "* * * * *" },
    prompt: "x",
  });
  assert.throws(() => createRoutine(validated.value, dir), /does not exist/);
});

test("recordRun caps history and updates a running entry in place", () => {
  const dir = freshDir();
  const validated = validateRoutineFields({
    name: "R",
    cwd: dir,
    trigger: { type: "cron", schedule: "* * * * *" },
    prompt: "x",
  });
  const routine = createRoutine(validated.value, dir);

  for (let i = 0; i < HISTORY_CAP + 5; i += 1) {
    recordRun(routine.id, { id: `run-${i}`, startedAt: new Date().toISOString(), status: "success", summary: `run ${i}` }, dir);
  }
  const after = getRoutine(routine.id, dir);
  assert.equal(after.history.length, HISTORY_CAP);
  assert.equal(after.lastRun.summary, `run ${HISTORY_CAP + 4}`);

  // Update a running entry in place.
  recordRun(routine.id, { id: "live", startedAt: new Date().toISOString(), status: "running", summary: "…" }, dir);
  recordRun(routine.id, { id: "live", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), status: "success", summary: "done" }, dir);
  const live = getRoutine(routine.id, dir);
  assert.equal(live.history.filter((r) => r.id === "live").length, 1);
  assert.equal(live.lastRun.status, "success");
});

test("webhook routines get a token, and can be found and regenerated by token", () => {
  const dir = freshDir();
  const validated = validateRoutineFields({
    name: "Hooked",
    cwd: dir,
    trigger: { type: "webhook" },
    prompt: "run",
  });
  assert.equal(validated.ok, true);
  const created = createRoutine(validated.value, dir);
  assert.equal(created.trigger.type, "webhook");
  const token = created.trigger.token;
  assert.ok(token && token.length >= 40);

  const found = findRoutineByWebhookToken(token, dir);
  assert.equal(found?.id, created.id);
  assert.equal(findRoutineByWebhookToken("wrong-token", dir), undefined);

  const regenerated = regenerateWebhookToken(created.id, dir);
  assert.notEqual(regenerated.trigger.token, token);
  assert.equal(findRoutineByWebhookToken(token, dir), undefined); // old token revoked
  assert.equal(findRoutineByWebhookToken(regenerated.trigger.token, dir)?.id, created.id);
});

test("updating a webhook routine preserves its token", () => {
  const dir = freshDir();
  const created = createRoutine(validateRoutineFields({ name: "H", cwd: dir, trigger: { type: "webhook" }, prompt: "p" }).value, dir);
  const token = created.trigger.token;
  const updated = updateRoutine(created.id, validateRoutineFields({ name: "H2", cwd: dir, trigger: { type: "webhook" }, prompt: "p2" }).value, dir);
  assert.equal(updated.trigger.token, token);
});

test("askWebhookUrl is validated and stored", () => {
  const dir = freshDir();
  assert.equal(validateRoutineFields({ name: "n", cwd: dir, trigger: { type: "cron", schedule: "* * * * *" }, prompt: "p", askWebhookUrl: "not-a-url" }).ok, false);
  const created = createRoutine(validateRoutineFields({ name: "n", cwd: dir, trigger: { type: "cron", schedule: "* * * * *" }, prompt: "p", askWebhookUrl: "https://ask.example.com" }).value, dir);
  assert.equal(created.askWebhookUrl, "https://ask.example.com");
});

test("legacy on-disk schedule field is migrated on load", () => {
  __resetRoutineStoreForTests();
  const dir = mkdtempSync(join(tmpdir(), "omp-routines-legacy-"));
  mkdirSync(dir, { recursive: true });
  const legacy = {
    routines: [
      { id: "legacy-1", name: "Old", cwd: dir, schedule: "0 0 * * *", prompt: "hi", enabled: true, createdAt: "2020-01-01T00:00:00.000Z", updatedAt: "2020-01-01T00:00:00.000Z" },
    ],
  };
  writeFileSync(join(dir, "omp-web-routines.json"), JSON.stringify(legacy));
  const loaded = getRoutine("legacy-1", dir);
  assert.ok(loaded);
  assert.deepEqual(loaded.trigger, { type: "cron", schedule: "0 0 * * *" });
  assert.ok(readFileSync(join(dir, "omp-web-routines.json"), "utf8"));
});
