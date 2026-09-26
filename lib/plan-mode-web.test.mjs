import assert from "node:assert/strict";
import test from "node:test";
import {
  applyWebPlanModeTransition,
  planSlashCommandIntent,
  planSlashCommandOutcome,
  readPersistedPlanModeState,
  toWebPlanModeInfo,
  WEB_DEFAULT_PLAN_FILE_URL,
} from "./plan-mode-web.ts";

/** Minimal recording stand-in for the SDK session slice these helpers touch. */
function makeSession(options) {
  const session = {
    state: options?.state,
    handler: null,
    modeChanges: [],
    getPlanModeState() {
      return session.state;
    },
    setPlanModeState(next) {
      session.state = next;
    },
    setPlanProposalHandler(handler) {
      session.handler = handler;
    },
    sessionManager: {
      appendModeChange(mode, data) {
        session.modeChanges.push({ mode, data });
        return "entry";
      },
    },
  };
  return session;
}

const proposalHandler = async () => ({ content: [] });

test("enter: sets ACP-shaped state, installs the proposal handler, persists mode_change", () => {
  const session = makeSession();
  const info = applyWebPlanModeTransition(session, true, proposalHandler);

  assert.deepEqual(info, { enabled: true, planFilePath: WEB_DEFAULT_PLAN_FILE_URL });
  assert.deepEqual(
    session.state,
    { enabled: true, planFilePath: WEB_DEFAULT_PLAN_FILE_URL, workflow: "parallel", reentry: false },
  );
  assert.equal(session.handler, proposalHandler);
  assert.deepEqual(session.modeChanges, [{ mode: "plan", data: { planFilePath: WEB_DEFAULT_PLAN_FILE_URL } }]);
});

test("enter while already planning keeps the plan file and adds no journal entry", () => {
  const session = makeSession({
    state: { enabled: true, planFilePath: "local://custom-plan.md", workflow: "parallel", reentry: false },
  });
  const info = applyWebPlanModeTransition(session, true, proposalHandler);

  assert.equal(info.planFilePath, "local://custom-plan.md");
  assert.equal(session.state?.reentry, true);
  assert.equal(session.handler, proposalHandler);
  assert.deepEqual(session.modeChanges, []);
});

test("exit: clears state and handler, persists mode_change none", () => {
  const session = makeSession({
    state: { enabled: true, planFilePath: "local://PLAN.md", workflow: "parallel", reentry: true },
  });
  const info = applyWebPlanModeTransition(session, false, proposalHandler);

  assert.deepEqual(info, { enabled: false });
  assert.equal(session.state, undefined);
  assert.equal(session.handler, null);
  assert.deepEqual(session.modeChanges, [{ mode: "none", data: undefined }]);
});

test("exit when already off: no redundant journal entry", () => {
  const session = makeSession();
  assert.deepEqual(applyWebPlanModeTransition(session, false, proposalHandler), { enabled: false });
  assert.deepEqual(session.modeChanges, []);
});

test("toWebPlanModeInfo reflects the live state", () => {
  assert.deepEqual(toWebPlanModeInfo(undefined), { enabled: false });
  assert.deepEqual(
    toWebPlanModeInfo({ enabled: true, planFilePath: "local://PLAN.md" }),
    { enabled: true, planFilePath: "local://PLAN.md" },
  );
});

test("TUI <-> web restore: the last mode_change journal entry decides the mode", () => {
  assert.deepEqual(
    readPersistedPlanModeState([
      { type: "user" },
      { type: "mode_change", mode: "plan", data: { planFilePath: "local://PLAN.md" } },
      { type: "assistant" },
    ]),
    { enabled: true, planFilePath: "local://PLAN.md", workflow: "parallel", reentry: true },
  );
  assert.equal(
    readPersistedPlanModeState([
      { type: "mode_change", mode: "plan", data: { planFilePath: "local://PLAN.md" } },
      { type: "mode_change", mode: "none" },
      { type: "assistant" },
    ]),
    undefined,
  );
  // A "plan" entry without a plan file path cannot steer proposals.
  assert.equal(readPersistedPlanModeState([{ type: "mode_change", mode: "plan", data: {} }]), undefined);
  assert.equal(readPersistedPlanModeState([{ type: "user" }]), undefined);
});

test("round trip: a wrapper restart mid-plan restores the entered mode, and exiting persists none", () => {
  const first = makeSession();
  applyWebPlanModeTransition(first, true, proposalHandler);

  const journal = first.modeChanges.map((change) => ({ type: "mode_change", ...change }));
  const second = makeSession({ state: readPersistedPlanModeState(journal) });
  assert.deepEqual(toWebPlanModeInfo(second.getPlanModeState()), { enabled: true, planFilePath: WEB_DEFAULT_PLAN_FILE_URL });

  applyWebPlanModeTransition(second, false, proposalHandler);
  assert.deepEqual(second.modeChanges, [{ mode: "none", data: undefined }]);
  const finalJournal = [...journal, ...second.modeChanges.map((change) => ({ type: "mode_change", ...change }))];
  assert.equal(readPersistedPlanModeState(finalJournal), undefined);
});

test("/plan intent: TUI toggle semantics", () => {
  assert.deepEqual(planSlashCommandIntent("/plan", false), { enabled: true });
  assert.deepEqual(planSlashCommandIntent("/plan draft the migration", false), {
    enabled: true,
    prompt: "draft the migration",
  });
  assert.deepEqual(planSlashCommandIntent("/plan", true), { enabled: false });
  assert.deepEqual(planSlashCommandIntent("/plan more words", true), { enabled: false });

  assert.equal(planSlashCommandIntent("/compact", false), null);
  assert.equal(planSlashCommandIntent("/planning ahead", false), null);
  assert.equal(planSlashCommandIntent("hello /plan", false), null);
  assert.equal(planSlashCommandIntent("", false), null);
});

test("/plan failure keeps the composer: an error result carries no prompt or success message", () => {
  const failed = planSlashCommandOutcome({ enabled: true, prompt: "draft the migration" }, "Exit goal mode first.");
  assert.deepEqual(failed, { handled: true, error: "Exit goal mode first." });

  assert.deepEqual(planSlashCommandOutcome({ enabled: true }, null), { handled: true, message: "Plan mode enabled" });
  assert.deepEqual(planSlashCommandOutcome({ enabled: false }, null), { handled: true, message: "Plan mode disabled" });
  assert.deepEqual(
    planSlashCommandOutcome({ enabled: true, prompt: "draft the migration" }, null),
    { handled: true, prompt: "draft the migration", message: "Plan mode enabled" },
  );
});
