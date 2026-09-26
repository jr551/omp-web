import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const css = read("../app/globals.css");
const appShell = read("./AppShell.tsx");

test("shared dialog rules clamp to the visible viewport with a safe margin", () => {
  assert.match(css, /--dialog-viewport-height: var\(--app-viewport-height, 100dvh\)/);
  assert.match(css, /\.viewport-dialog-backdrop \{[^}]*height: var\(--dialog-viewport-height\) !important;[^}]*overflow: auto;/);
  assert.match(css, /\.viewport-dialog \{[^}]*max-width: min\(100%, calc\(100vw - 2 \* var\(--dialog-viewport-margin\)\)\) !important;/);
  assert.match(css, /\.viewport-dialog \{[^}]*max-height: min\(\s*100%,\s*calc\(\s*var\(--dialog-viewport-height\)[\s\S]*?\) !important;/);
});

for (const file of ["ModelsConfig.tsx", "PluginsConfig.tsx", "SkillsConfig.tsx", "SettingsConfig.tsx", "ProjectTrustDialog.tsx", "DirectoryPicker.tsx", "ChatWindow.tsx"]) {
  test(`${file} keeps its modal inside the viewport`, () => {
    const source = read(`./${file}`);
    assert.match(source, /["` ]viewport-dialog["`]/);
    // A modal must not be sized from the layout viewport: 100vh ignores
    // mobile browser chrome and the on-screen keyboard.
    assert.doesNotMatch(source, /calc\(100vh/);
    assert.doesNotMatch(source, /100vh - /);
  });
}

test("full-screen modal backdrops follow the visual viewport height", () => {
  for (const file of ["ModelsConfig.tsx", "PluginsConfig.tsx", "SkillsConfig.tsx", "SettingsConfig.tsx", "ProjectTrustDialog.tsx", "DirectoryPicker.tsx"]) {
    assert.match(read(`./${file}`), /viewport-dialog-backdrop/, file);
  }
});

test("embedded settings panes do not pick up the modal clamp", () => {
  for (const file of ["ModelsConfig.tsx", "PluginsConfig.tsx", "SkillsConfig.tsx"]) {
    assert.match(read(`./${file}`), /className=\{embedded \? undefined : "viewport-dialog"\}/, file);
  }
});

test("dialogs without their own scroll body scroll internally", () => {
  assert.match(read("./ProjectTrustDialog.tsx"), /className="viewport-dialog"\s+style=\{\{[\s\S]*?overflowY: "auto"/);
});

test("top-bar dropdowns are measured against the viewport and re-measured on layout changes", () => {
  assert.match(appShell, /const next = computeAnchoredPanelRect\(/);
  assert.match(appShell, /readPanelViewport\(\)/);
  assert.match(appShell, /observeViewportLayout\(\[topBarRef\.current, languageBtnRef\.current, document\.documentElement\], schedule\)/);
  assert.match(appShell, /document\.addEventListener\("transitionend", schedule, true\)/);
  assert.match(appShell, /\}, \[activeTopPanel, isMobile, sidebarOpen, rightPanelOpen\]\);/);
  assert.match(appShell, /maxHeight: topPanelPos\.maxHeight,\s*overflowX: "hidden",\s*overflowY: "auto",/);
  assert.doesNotMatch(appShell, /calc\(100dvh - \$\{topPanelPos\.top\}px\)/);
});

test("session info columns follow the measured panel width", () => {
  assert.match(appShell, /const sessionInfoLayout = sessionInfoGridLayout\(topPanelPos\.width, isMobile\);/);
  assert.match(appShell, /gridTemplateColumns: sessionInfoLayout\.columns,/);
  assert.doesNotMatch(appShell, /"minmax\(360px, 1\.7fr\)/);
});
