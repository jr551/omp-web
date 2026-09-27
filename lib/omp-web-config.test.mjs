import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  getExternalBaseUrl,
  setExternalBaseUrl,
  resolveExternalBaseUrl,
  __resetOmpWebConfigForTests,
} from "./omp-web-config.ts";

function freshDir() {
  __resetOmpWebConfigForTests();
  return mkdtempSync(join(tmpdir(), "omp-web-config-"));
}

function request(headers, url = "http://localhost/api/x") {
  return new Request(url, { headers });
}

test("set/get external base URL persists 0600 and trims trailing slash", () => {
  const dir = freshDir();
  assert.equal(getExternalBaseUrl(dir), undefined);
  setExternalBaseUrl("https://omp.example.com/", dir);
  assert.equal(getExternalBaseUrl(dir), "https://omp.example.com");
  const mode = statSync(join(dir, "omp-web-config.json")).mode & 0o777;
  assert.equal(mode, 0o600);
  setExternalBaseUrl("", dir);
  assert.equal(getExternalBaseUrl(dir), undefined);
});

test("setExternalBaseUrl rejects non-absolute or non-http URLs", () => {
  const dir = freshDir();
  assert.throws(() => setExternalBaseUrl("not a url", dir));
  assert.throws(() => setExternalBaseUrl("ftp://x.example.com", dir));
});

test("resolveExternalBaseUrl prefers configured value", () => {
  const dir = freshDir();
  setExternalBaseUrl("https://configured.example.com", dir);
  const url = resolveExternalBaseUrl(request({ host: "ignored.local" }), dir);
  assert.equal(url, "https://configured.example.com");
});

test("resolveExternalBaseUrl auto-detects from forwarded headers", () => {
  const dir = freshDir();
  const url = resolveExternalBaseUrl(request({ "x-forwarded-proto": "https", "x-forwarded-host": "tunnel.example.com" }), dir);
  assert.equal(url, "https://tunnel.example.com");
});

test("resolveExternalBaseUrl falls back to Host with sensible protocol", () => {
  const dir = freshDir();
  assert.equal(resolveExternalBaseUrl(request({ host: "localhost:30141" }), dir), "http://localhost:30141");
  assert.equal(resolveExternalBaseUrl(request({ host: "example.com" }), dir), "https://example.com");
});
