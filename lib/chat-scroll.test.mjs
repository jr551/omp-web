import test from "node:test";
import assert from "node:assert/strict";

async function loadSubject() {
  return import("./chat-scroll.ts");
}

test("distanceFromBottom measures px below the viewport", async () => {
  const { distanceFromBottom } = await loadSubject();
  assert.equal(distanceFromBottom(2000, 1000, 500), 500);
  assert.equal(distanceFromBottom(2000, 1500, 500), 0);
});

test("isNearBottom honours the default threshold", async () => {
  const { isNearBottom, AUTO_FOLLOW_BOTTOM_THRESHOLD_PX } = await loadSubject();
  assert.equal(AUTO_FOLLOW_BOTTOM_THRESHOLD_PX, 72);
  // exactly at the threshold still counts as near the bottom
  assert.equal(isNearBottom(2000, 1428, 500), true); // distance 72
  assert.equal(isNearBottom(2000, 1427, 500), false); // distance 73
  assert.equal(isNearBottom(2000, 1500, 500), true); // distance 0
});

test("computeAutoFollow re-arms following when the user reaches the bottom", async () => {
  const { computeAutoFollow } = await loadSubject();
  assert.equal(computeAutoFollow(false, { distanceFromBottom: 0, userDriven: true }), true);
  assert.equal(computeAutoFollow(false, { distanceFromBottom: 10, userDriven: false }), true);
});

test("computeAutoFollow pauses following when the user scrolls up", async () => {
  const { computeAutoFollow } = await loadSubject();
  assert.equal(computeAutoFollow(true, { distanceFromBottom: 400, userDriven: true }), false);
});

test("computeAutoFollow ignores programmatic scrolls away from the bottom", async () => {
  const { computeAutoFollow } = await loadSubject();
  // not user-driven, not near bottom -> keep whatever we had
  assert.equal(computeAutoFollow(true, { distanceFromBottom: 400, userDriven: false }), true);
  assert.equal(computeAutoFollow(false, { distanceFromBottom: 400, userDriven: false }), false);
});
