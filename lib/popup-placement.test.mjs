import test from "node:test";
import assert from "node:assert/strict";

async function loadSubject() {
  return import("./popup-placement.ts");
}

test("keeps the preferred side when it can hold the popup", async () => {
  const { computePopupPlacement } = await loadSubject();
  // Composer near the bottom: 600px of room above for a 400px popup.
  assert.deepEqual(
    computePopupPlacement(620, 660, 700, 400, { prefer: "above" }),
    { side: "above", maxHeight: 400 },
  );
});

test("flips to the roomier side when the preferred one is too small", async () => {
  const { computePopupPlacement } = await loadSubject();
  // Fresh session: the composer sits mid-viewport with little room above it.
  const placement = computePopupPlacement(120, 170, 900, 460, { prefer: "above" });
  assert.equal(placement.side, "below");
  assert.equal(placement.maxHeight, 460);
});

test("caps the height to the space on the chosen side", async () => {
  const { computePopupPlacement } = await loadSubject();
  // 300px above and 220px below: stay above, but do not claim the full 460px.
  const placement = computePopupPlacement(316, 460, 700, 460, { prefer: "above" });
  assert.equal(placement.side, "above");
  assert.equal(placement.maxHeight, 300);
});

test("opens a settings dropdown upwards when it would run past the viewport", async () => {
  const { computePopupPlacement } = await loadSubject();
  // Trigger near the bottom of a 125%-zoom viewport: only 40px left below.
  const placement = computePopupPlacement(560, 594, 640, 296, { prefer: "below", gap: 5, minHeight: 160 });
  assert.equal(placement.side, "above");
  assert.equal(placement.maxHeight, 296);
});

test("never shrinks below the floor, and never past a very short viewport", async () => {
  const { computePopupPlacement } = await loadSubject();
  assert.equal(computePopupPlacement(30, 60, 400, 360, { prefer: "above" }).maxHeight, 324);
  // Viewport shorter than the floor: use the viewport minus its margins.
  assert.equal(computePopupPlacement(40, 70, 100, 360, { prefer: "above" }).maxHeight, 84);
});

test("derives the preferred height from the viewport with an absolute cap", async () => {
  const { preferredPopupHeight } = await loadSubject();
  assert.equal(preferredPopupHeight(1000, 0.56, 460), 460);
  assert.equal(preferredPopupHeight(500, 0.56, 460), 280);
});

test("anchored panel spans its bar and opens below with the remaining height", async () => {
  const { computeAnchoredPanelRect } = await loadSubject();
  const rect = computeAnchoredPanelRect(
    { top: 0, bottom: 36, left: 260, right: 1280 },
    { width: 1280, height: 800 },
    { gap: 0, margin: 8 },
  );
  assert.deepEqual(rect, { side: "below", top: 36, left: 260, width: 1020, maxHeight: 756 });
});

test("anchored panel is clamped to the viewport when its bar is wider than the screen", async () => {
  const { computeAnchoredPanelRect } = await loadSubject();
  // Sidebar + file panel minimums push the centre column past the right edge.
  const rect = computeAnchoredPanelRect(
    { top: 0, bottom: 36, left: 320, right: 1400 },
    { width: 1024, height: 700 },
    { gap: 0 },
  );
  assert.equal(rect.left, 320);
  assert.equal(rect.left + rect.width, 1024);
});

test("anchored panel with a preferred width is shifted back inside the right edge", async () => {
  const { computeAnchoredPanelRect } = await loadSubject();
  const rect = computeAnchoredPanelRect(
    { top: 0, bottom: 36, left: 1200, right: 1376 },
    { width: 1280, height: 800 },
    { preferredWidth: 176, horizontalMargin: 8, gap: 0 },
  );
  assert.equal(rect.width, 176);
  assert.equal(rect.left, 1280 - 8 - 176);
});

test("anchored panel respects extra bounds such as the top bar", async () => {
  const { computeAnchoredPanelRect } = await loadSubject();
  const rect = computeAnchoredPanelRect(
    { top: 0, bottom: 36, left: 900, right: 1076 },
    { width: 1280, height: 800 },
    { preferredWidth: 176, bounds: { left: 260, right: 1000 }, gap: 0 },
  );
  assert.equal(rect.left, 1000 - 176);
  // Narrower than the preferred width: never wider than the room available.
  const narrow = computeAnchoredPanelRect(
    { top: 0, bottom: 36, left: 10, right: 186 },
    { width: 120, height: 800 },
    { preferredWidth: 176, horizontalMargin: 8, gap: 0 },
  );
  assert.deepEqual([narrow.left, narrow.width], [8, 104]);
});

test("anchored panel height follows the visual viewport under a keyboard", async () => {
  const { computeAnchoredPanelRect } = await loadSubject();
  // Keyboard leaves 400px visible and the page is panned down by 100px.
  const rect = computeAnchoredPanelRect(
    { top: 100, bottom: 136, left: 0, right: 390 },
    { width: 390, height: 400, offsetTop: 100 },
    { gap: 0, margin: 8 },
  );
  assert.equal(rect.side, "below");
  assert.equal(rect.top, 136);
  assert.equal(rect.maxHeight, 400 - 36 - 8);
});

test("anchored panel flips above when below is too cramped", async () => {
  const { computeAnchoredPanelRect } = await loadSubject();
  const rect = computeAnchoredPanelRect(
    { top: 600, bottom: 640, left: 0, right: 200 },
    { width: 800, height: 700 },
    { gap: 4, margin: 8, preferredMaxHeight: 300 },
  );
  assert.equal(rect.side, "above");
  assert.equal(rect.bottom, 700 - 600 + 4);
  assert.equal(rect.top, undefined);
  assert.equal(rect.maxHeight, 300);
});

test("compares anchored panel rects by value", async () => {
  const { sameAnchoredPanelRect } = await loadSubject();
  const a = { side: "below", top: 36, left: 0, width: 10, maxHeight: 100 };
  assert.equal(sameAnchoredPanelRect(a, { ...a }), true);
  assert.equal(sameAnchoredPanelRect(a, { ...a, width: 11 }), false);
  assert.equal(sameAnchoredPanelRect(null, a), false);
});
