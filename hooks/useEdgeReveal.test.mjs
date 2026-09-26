import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const {
  DEFAULT_EDGE_REVEAL_CONFIG,
  EDGE_REVEAL_STORAGE_KEY,
  INITIAL_EDGE_REVEAL_STATE,
  edgeZoneAt,
  nextEdgeRevealDeadline,
  stepEdgeReveal,
} = await import("./useEdgeReveal.ts");

const hookSource = readFileSync(new URL("./useEdgeReveal.ts", import.meta.url), "utf8");
const appShellSource = readFileSync(new URL("../components/AppShell.tsx", import.meta.url), "utf8");
const settingsSource = readFileSync(new URL("../components/SettingsConfig.tsx", import.meta.url), "utf8");
const agentsDoc = readFileSync(new URL("../AGENTS.md", import.meta.url), "utf8");

const { dwellMs, graceMs } = DEFAULT_EDGE_REVEAL_CONFIG;
const VW = 1280;
const SIDEBAR = { left: 0, right: 260, top: 0, bottom: 800 };
const FILES = { left: 880, right: 1280, top: 0, bottom: 800 };

function panels({ left = false, right = false } = {}) {
  return {
    left: { open: left, rect: left ? SIDEBAR : null },
    right: { open: right, rect: right ? FILES : null },
  };
}

function move(state, now, x, opts = {}) {
  return stepEdgeReveal(state, {
    type: "move",
    now,
    x,
    y: opts.y ?? 400,
    viewportWidth: VW,
    panels: opts.panels ?? panels(),
    eligible: opts.eligible ?? true,
  });
}

function tick(state, now, open = {}) {
  return stepEdgeReveal(state, { type: "tick", now, panels: panels(open) });
}

test("the activation strip is a few pixels wide on each edge", () => {
  assert.equal(DEFAULT_EDGE_REVEAL_CONFIG.stripPx, 6);
  assert.ok(dwellMs >= 250 && dwellMs <= 350);
  assert.equal(edgeZoneAt(0, VW, 6), "left");
  assert.equal(edgeZoneAt(5, VW, 6), "left");
  assert.equal(edgeZoneAt(6, VW, 6), null);
  assert.equal(edgeZoneAt(VW - 7, VW, 6), null);
  assert.equal(edgeZoneAt(VW - 6, VW, 6), "right");
  assert.equal(edgeZoneAt(VW - 1, VW, 6), "right");
});

test("resting at the left edge opens the sidebar after the dwell delay", () => {
  let step = move(INITIAL_EDGE_REVEAL_STATE, 1000, 2);
  assert.deepEqual(step.actions, []);
  assert.equal(nextEdgeRevealDeadline(step.state), 1000 + dwellMs);
  // Still resting: small moves inside the strip do not restart the dwell.
  step = move(step.state, 1100, 3);
  assert.equal(nextEdgeRevealDeadline(step.state), 1000 + dwellMs);
  step = tick(step.state, 1000 + dwellMs - 1);
  assert.deepEqual(step.actions, []);
  step = tick(step.state, 1000 + dwellMs);
  assert.deepEqual(step.actions, [{ type: "open", side: "left" }]);
  assert.ok(step.state.hover.left);
});

test("the right edge opens the file panel", () => {
  let step = move(INITIAL_EDGE_REVEAL_STATE, 0, VW - 1);
  step = tick(step.state, dwellMs);
  assert.deepEqual(step.actions, [{ type: "open", side: "right" }]);
});

test("passing through the strip does not open anything", () => {
  let step = move(INITIAL_EDGE_REVEAL_STATE, 0, 1);
  step = move(step.state, 80, 40);
  assert.equal(step.state.dwell, null);
  step = tick(step.state, dwellMs + 10);
  assert.deepEqual(step.actions, []);
});

test("ineligible pointers (button held, modal, control, scrollbar) never start a dwell", () => {
  let step = move(INITIAL_EDGE_REVEAL_STATE, 0, 1, { eligible: false });
  assert.equal(step.state.dwell, null);
  step = move(INITIAL_EDGE_REVEAL_STATE, 0, 1);
  step = move(step.state, 100, 1, { eligible: false });
  assert.equal(step.state.dwell, null);
});

test("an already open panel is not re-opened", () => {
  const step = move(INITIAL_EDGE_REVEAL_STATE, 0, 1, { panels: panels({ left: true }) });
  assert.equal(step.state.dwell, null);
});

test("leaving the window at the edge cancels the dwell", () => {
  let step = move(INITIAL_EDGE_REVEAL_STATE, 0, 1);
  step = stepEdgeReveal(step.state, { type: "leave", now: 50, panels: panels() });
  assert.equal(step.state.dwell, null);
  step = tick(step.state, dwellMs + 10);
  assert.deepEqual(step.actions, []);
});

function hoverOpened(side = "left") {
  let step = move(INITIAL_EDGE_REVEAL_STATE, 0, side === "left" ? 1 : VW - 1);
  step = tick(step.state, dwellMs);
  return step.state;
}

test("a hover-opened panel closes after a grace delay once the pointer leaves it", () => {
  const open = panels({ left: true });
  let step = move(hoverOpened(), 1000, 120, { panels: open });
  assert.deepEqual(step.actions, []);
  step = move(step.state, 1200, 600, { panels: open });
  assert.equal(nextEdgeRevealDeadline(step.state), 1200 + graceMs);
  step = tick(step.state, 1200 + graceMs - 1, { left: true });
  assert.deepEqual(step.actions, []);
  step = tick(step.state, 1200 + graceMs, { left: true });
  assert.deepEqual(step.actions, [{ type: "close", side: "left" }]);
  assert.equal(step.state.hover.left, null);
});

test("coming back within the grace delay keeps the panel open", () => {
  const open = panels({ left: true });
  let step = move(hoverOpened(), 1000, 600, { panels: open });
  step = move(step.state, 1000 + graceMs / 2, 200, { panels: open });
  assert.equal(nextEdgeRevealDeadline(step.state), null);
  step = tick(step.state, 1000 + graceMs * 2, { left: true });
  assert.deepEqual(step.actions, []);
});

test("the resize handle just outside the panel counts as on the panel", () => {
  const step = move(hoverOpened(), 1000, SIDEBAR.right + 6, { panels: panels({ left: true }) });
  assert.equal(nextEdgeRevealDeadline(step.state), null);
});

test("interacting with or pinning a hover-opened panel keeps it open", () => {
  let step = stepEdgeReveal(hoverOpened(), { type: "pin", side: "left" });
  assert.equal(step.state.hover.left, null);
  step = move(step.state, 1000, 600, { panels: panels({ left: true }) });
  step = tick(step.state, 1000 + graceMs * 2, { left: true });
  assert.deepEqual(step.actions, []);
});

test("a hover-opened panel closed by the user is forgotten", () => {
  // The open is applied (panel seen open), then the user closes it.
  let step = tick(hoverOpened(), dwellMs + 1, { left: true });
  assert.ok(step.state.hover.left?.seenOpen);
  step = tick(step.state, dwellMs + 2, { left: false });
  assert.equal(step.state.hover.left, null);
});

test("a pending open is not mistaken for a user close before the re-render", () => {
  // The pointer moves before React applied the open: the panel still reads closed.
  const step = move(hoverOpened(), dwellMs + 1, 2, { panels: panels() });
  assert.ok(step.state.hover.left);
});

test("the hook only listens for a hovering fine pointer and plain mouse moves", () => {
  assert.match(hookSource, /"\(hover: hover\) and \(pointer: fine\)"/);
  assert.match(hookSource, /const listening = options\.active && finePointer;/);
  assert.match(hookSource, /if \(event\.pointerType !== "mouse"\) return;/);
  assert.match(hookSource, /event\.buttons !== 0/);
  assert.match(hookSource, /document\.querySelector\("\[aria-modal='true'\]"\)/);
  assert.match(hookSource, /document\.addEventListener\("pointermove", onPointerMove, \{ passive: true \}\)/);
});

test("the preference is a localStorage flag, on by default", () => {
  assert.equal(EDGE_REVEAL_STORAGE_KEY, "omp-edge-reveal");
  assert.match(hookSource, /localStorage\.getItem\(EDGE_REVEAL_STORAGE_KEY\) !== "false"/);
  assert.match(settingsSource, /\{ id: "interface", label: "Web UI", icon: "interaction" \}/);
  assert.match(settingsSource, /onClick=\{\(\) => setEdgeRevealEnabled\(!edgeReveal\)\}/);
  assert.match(agentsDoc, /omp-edge-reveal/);
});

test("AppShell wires both panels, skips mobile, and pins from the toggle buttons", () => {
  assert.match(appShellSource, /active: edgeRevealEnabled && !isMobile,/);
  assert.match(appShellSource, /leftPanelRef: sidebarResizer\.panelRef,/);
  assert.match(appShellSource, /rightPanelRef: rightPanelResizer\.panelRef,/);
  assert.match(appShellSource, /else if \(pinEdgeRevealedPanel\("left"\)\) return;/);
  assert.match(appShellSource, /if \(!isMobile && pinEdgeRevealedPanel\("right"\)\) return;/);
  assert.match(appShellSource, /onClick=\{handleRightPanelToggle\}/);
  // Stable callbacks only: the reveal/conceal handlers must not be inline.
  assert.match(appShellSource, /onReveal: revealEdgePanel,\s*onConceal: concealEdgePanel,/);
});
