import test from "node:test";
import assert from "node:assert/strict";

const { sessionInfoGridLayout } = await import("./session-info-layout.ts");

test("keeps three columns only when the panel can hold them", () => {
  const layout = sessionInfoGridLayout(1100, false);
  assert.equal(layout.columns.match(/minmax/g).length, 3);
  assert.equal(layout.infoSpansRow, false);
});

test("stacks into two columns for a centre column squeezed by the side panels", () => {
  const layout = sessionInfoGridLayout(640, false);
  assert.equal(layout.columns, "minmax(0, 1fr) minmax(0, 1fr)");
  assert.equal(layout.infoSpansRow, true);
});

test("uses one shrinkable column on mobile or very narrow panels", () => {
  assert.equal(sessionInfoGridLayout(1100, true).columns, "minmax(0, 1fr)");
  assert.equal(sessionInfoGridLayout(400, false).columns, "minmax(0, 1fr)");
});

test("no layout has fixed minimums wider than the panel it was chosen for", () => {
  for (const width of [320, 459, 460, 700, 799, 800, 1400]) {
    const { columns, gap } = sessionInfoGridLayout(width, false);
    const floors = [...columns.matchAll(/minmax\((\d+)px/g)].map((match) => Number(match[1]));
    // 32px = the popover's horizontal padding.
    const floor = floors.reduce((sum, n) => sum + n, 0) + gap * Math.max(0, floors.length - 1) + 32;
    assert.ok(floor <= width, `width ${width}: floor ${floor}`);
  }
});
