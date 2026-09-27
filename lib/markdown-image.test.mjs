import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./markdown-image.ts");
}

test("routes an absolute local path through /api/files", async () => {
  const { resolveMarkdownImageSrc } = await loadSubject();
  assert.equal(
    resolveMarkdownImageSrc("/home/user/pics/shot.png", "/home/user/proj"),
    "/api/files/home/user/pics/shot.png?type=read",
  );
});

test("routes a relative path under the cwd through /api/files", async () => {
  const { resolveMarkdownImageSrc } = await loadSubject();
  assert.equal(
    resolveMarkdownImageSrc("assets/logo.png", "/home/user/proj"),
    "/api/files/home/user/proj/assets/logo.png?type=read",
  );
});

test("percent-encodes path segments with spaces", async () => {
  const { resolveMarkdownImageSrc } = await loadSubject();
  assert.equal(
    resolveMarkdownImageSrc("/home/user/my pics/a b.png"),
    "/api/files/home/user/my%20pics/a%20b.png?type=read",
  );
});

test("passes remote http(s) URLs through unchanged", async () => {
  const { resolveMarkdownImageSrc } = await loadSubject();
  const url = "https://example.com/cat.png";
  assert.equal(resolveMarkdownImageSrc(url, "/home/user/proj"), url);
});

test("passes data URLs through unchanged", async () => {
  const { resolveMarkdownImageSrc } = await loadSubject();
  const dataUrl = "data:image/png;base64,AAAA";
  assert.equal(resolveMarkdownImageSrc(dataUrl), dataUrl);
});

test("returns undefined/empty inputs untouched", async () => {
  const { resolveMarkdownImageSrc } = await loadSubject();
  assert.equal(resolveMarkdownImageSrc(undefined), undefined);
  assert.equal(resolveMarkdownImageSrc(""), "");
});
