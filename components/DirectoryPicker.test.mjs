import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./DirectoryPicker.tsx", import.meta.url), "utf8");

test("directory picker exposes an inline New folder flow", () => {
  assert.match(source, /directoryPicker\.newFolder/);
  assert.match(source, /directoryPicker\.folderName/);
  assert.match(source, /directoryPicker\.create/);
  assert.match(source, /role="alert"/);
  assert.match(source, /autoFocus/);
});

test("folder creation posts the current parent and navigates into the result", () => {
  assert.match(source, /fetch\("\/api\/cwd\/create"/);
  assert.match(source, /method: "POST"/);
  assert.match(source, /JSON\.stringify\(\{ parentPath: currentPath, name/);
  assert.match(source, /await navigateTo\(data\.path\)/);
});

test("Escape cancels folder creation before it closes the picker", () => {
  assert.match(source, /event\.key === "Escape"[\s\S]*?creatingFolder[\s\S]*?setCreatingFolder\(false\)/);
});
