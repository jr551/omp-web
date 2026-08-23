import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { POST } = await jiti.import("./route.ts");

function createRequest(body, headers = {}) {
  return new Request("http://localhost:30141/api/cwd/create", {
    method: "POST",
    headers: {
      host: "localhost:30141",
      origin: "http://localhost:30141",
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

test("POST creates one child folder through the real route contract", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "omp-web-create-route-"));
  try {
    const response = await POST(createRequest({ parentPath: root, name: "project-alpha" }));
    const body = await response.json();

    assert.equal(response.status, 201);
    assert.equal(body.name, "project-alpha");
    assert.equal(body.path, path.join(body.parentPath, "project-alpha"));
    await access(body.path);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("POST rejects duplicate and nested folder names", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "omp-web-create-route-invalid-"));
  try {
    await mkdir(path.join(root, "existing"));
    const duplicate = await POST(createRequest({ parentPath: root, name: "existing" }));
    const nested = await POST(createRequest({ parentPath: root, name: "nested/child" }));

    assert.equal(duplicate.status, 409);
    assert.match((await duplicate.json()).error, /already exists/i);
    assert.equal(nested.status, 400);
    assert.match((await nested.json()).error, /single folder/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("POST rejects cross-site and non-JSON requests before touching disk", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "omp-web-create-route-security-"));
  try {
    const crossSite = await POST(createRequest(
      { parentPath: root, name: "cross-site" },
      { origin: "https://attacker.example", "sec-fetch-site": "cross-site" },
    ));
    const wrongType = await POST(createRequest(
      { parentPath: root, name: "wrong-type" },
      { "content-type": "text/plain" },
    ));

    assert.equal(crossSite.status, 403);
    assert.equal(wrongType.status, 415);
    await assert.rejects(access(path.join(root, "cross-site")));
    await assert.rejects(access(path.join(root, "wrong-type")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
