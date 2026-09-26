import assert from "node:assert/strict";
import test from "node:test";

test("treats only loopback hostnames as the omp-web host", async () => {
  const { isLoopbackHostname } = await import("./open-external.ts");

  for (const host of ["localhost", "127.0.0.1", "::1", "[::1]", "omp.localhost"]) {
    assert.equal(isLoopbackHostname(host), true, host);
  }
  for (const host of ["omp.example.com", "192.168.1.20", "10.0.0.5"]) {
    assert.equal(isLoopbackHostname(host), false, host);
  }
});

test("the login dialog links the full authorization URL for remote browsers", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../components/ModelsConfig.tsx", import.meta.url), "utf-8");
  assert.match(source, /openExternal\(isLoopbackBrowser\(\) \? data\.url! : fullUrl\)/);
  assert.match(source, /href=\{loginState\.fullUrl\}/);
});
