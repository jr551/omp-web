import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./paste-images.ts");
}

function fakeFile(name, type) {
  return { name, type };
}

function fakeItem(kind, type, file) {
  return { kind, type, getAsFile: () => file };
}

const isImage = (file) => file.type.startsWith("image/") ||
  (file.type === "" && /\.(png|jpe?g|gif|webp)$/i.test(file.name));

test("extracts image files from paste items advertising an image type", async () => {
  const { extractPastedImageFiles } = await loadSubject();
  const png = fakeFile("shot.png", "image/png");
  const items = [
    fakeItem("string", "text/plain", null),
    fakeItem("file", "image/png", png),
  ];
  assert.deepEqual(extractPastedImageFiles(items, isImage), [png]);
});

test("accepts a screenshot file item that has an empty type via name fallback", async () => {
  const { extractPastedImageFiles } = await loadSubject();
  const screenshot = fakeFile("Screenshot.png", "");
  const items = [fakeItem("file", "", screenshot)];
  assert.deepEqual(extractPastedImageFiles(items, isImage), [screenshot]);
});

test("ignores non-image files and null getAsFile results", async () => {
  const { extractPastedImageFiles } = await loadSubject();
  const doc = fakeFile("notes.txt", "text/plain");
  const items = [
    fakeItem("file", "text/plain", doc),
    fakeItem("file", "image/png", null),
    fakeItem("string", "text/plain", null),
  ];
  assert.deepEqual(extractPastedImageFiles(items, isImage), []);
});

test("returns every pasted image when several are present", async () => {
  const { extractPastedImageFiles } = await loadSubject();
  const a = fakeFile("a.png", "image/png");
  const b = fakeFile("b.jpg", "image/jpeg");
  const items = [fakeItem("file", "image/png", a), fakeItem("file", "image/jpeg", b)];
  assert.deepEqual(extractPastedImageFiles(items, isImage), [a, b]);
});
