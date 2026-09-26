import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

// Guards for "Tab switching performance" in AGENTS.md: the pieces that keep
// file-tab switches and unrelated AppShell renders from redoing the heavy
// markdown/highlighting work.

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const REACT_MEMO = Symbol.for("react.memo");

const appShellSource = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const chatWindowSource = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
const fileViewerSource = await readFile(new URL("./FileViewer.tsx", import.meta.url), "utf8");
const sidebarSource = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");

test("markdown and file viewers are memoized components", async () => {
  const { MarkdownBody } = await jiti.import("./MarkdownBody.tsx");
  const { FileViewer } = await jiti.import("./FileViewer.tsx");
  assert.equal(MarkdownBody.$$typeof, REACT_MEMO);
  assert.equal(FileViewer.$$typeof, REACT_MEMO);
});

test("AppShell children that re-render on every AppShell state change are memoized", () => {
  assert.match(chatWindowSource, /export const ChatWindow = memo\(function ChatWindow\(/);
  assert.match(sidebarSource, /export const SessionSidebar = memo\(function SessionSidebar\(/);
});

test("open file tabs stay mounted behind Activity instead of sharing one viewer", () => {
  assert.match(appShellSource, /import \{ Activity,/);
  assert.match(
    appShellSource,
    /fileTabs\.map\(\(tab\) => \(\s*<Activity key=\{tab\.id\} mode=\{tab\.id === activeFileTab\?\.id \? "visible" : "hidden"\}>/,
  );
  // A single <FileViewer filePath={activeFileTab.filePath}> would refetch and
  // re-highlight on every switch.
  assert.doesNotMatch(appShellSource, /filePath=\{activeFileTab\.filePath\}/);
});

test("revealing a hidden file tab revalidates instead of resetting the view", () => {
  assert.match(fileViewerSource, /const revalidating = loadedPathRef\.current === filePath;/);
  assert.match(fileViewerSource, /if \(revalidating\) void fetchContent\(filePath\);/);
  assert.match(fileViewerSource, /setData\(\(previous\) => \(sameFileData\(previous, d\) \? previous : d\)\);/);
  assert.match(fileViewerSource, /usePreservedScroll\(contentRef, showsContent\);/);
  assert.match(fileViewerSource, /const sourceView = useMemo\(/);
});

test("chat transcript grouping is memoized and derived answers keep identity", () => {
  assert.match(chatWindowSource, /const transcript = useMemo\(\(\) => \{/);
  assert.match(chatWindowSource, /\{transcript\}/);
  assert.match(chatWindowSource, /const finalAssistantPartsCache = new WeakMap</);
  assert.match(chatWindowSource, /const finalSplit = getFinalAssistantParts\(finalAssistant, displayOptions\);/);
});
