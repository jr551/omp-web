import assert from "node:assert/strict";
import test from "node:test";

const roster = (...advisors) => ({ advisors, cost: 0 });

test("advisor tone follows the TUI badge precedence", async () => {
  const { getAdvisorTone } = await import("./AdvisorBadge.tsx");

  assert.equal(getAdvisorTone(roster({ name: "a", status: "running", yielded: false })), "active");
  assert.equal(getAdvisorTone(roster({ name: "a", status: "running", yielded: true })), "idle");
  assert.equal(getAdvisorTone(roster({ name: "a", status: "paused", yielded: false })), "idle");
  assert.equal(getAdvisorTone(roster(
    { name: "a", status: "running", yielded: false },
    { name: "b", status: "quota_exhausted", yielded: false },
  )), "warning");
  assert.equal(getAdvisorTone(roster(
    { name: "a", status: "quota_exhausted", yielded: false },
    { name: "b", status: "error", yielded: true },
  )), "error");
});
