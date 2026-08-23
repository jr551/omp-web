import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { createWebOAuthAuthEvent, selectWebOAuthLoginId } = await jiti.import("./oauth-web-login.ts");

test("web login prefers OpenAI device authorization over the localhost callback flow", () => {
  const candidates = [
    { id: "openai-codex" },
    { id: "openai-codex-device", storeCredentialsAs: "openai-codex" },
  ];

  assert.equal(selectWebOAuthLoginId("openai-codex", candidates), "openai-codex-device");
  assert.equal(selectWebOAuthLoginId("openai-codex-device", candidates), undefined);
});

test("web login preserves the normal provider flow", () => {
  assert.equal(selectWebOAuthLoginId("anthropic", [{ id: "anthropic" }]), "anthropic");
});

test("OpenAI device authorization becomes a code event for the browser", () => {
  assert.deepEqual(
    createWebOAuthAuthEvent("openai-codex-device", {
      url: "https://auth.openai.com/codex/device",
      instructions: "Enter code: ABCD-EFGH",
    }),
    {
      type: "device_code",
      userCode: "ABCD-EFGH",
      verificationUri: "https://auth.openai.com/codex/device",
      intervalSeconds: null,
      expiresInSeconds: null,
    },
  );
});

test("normal callback authorization keeps its launch URL and manual token", () => {
  assert.deepEqual(
    createWebOAuthAuthEvent("anthropic", {
      url: "https://provider.example/authorize?long=true",
      launchUrl: "http://localhost:9876/launch",
      instructions: "Sign in",
    }, "login-token"),
    {
      type: "auth",
      url: "http://localhost:9876/launch",
      fullUrl: "https://provider.example/authorize?long=true",
      instructions: "Sign in",
      token: "login-token",
    },
  );
});
