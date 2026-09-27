import assert from "node:assert/strict";
import test from "node:test";

import { generateWebhookToken, tokensEqual } from "./webhook-tokens.ts";

test("generateWebhookToken produces long, unique, url-safe tokens", () => {
  const a = generateWebhookToken();
  const b = generateWebhookToken();
  assert.notEqual(a, b);
  assert.ok(a.length >= 40, `expected >=40 chars, got ${a.length}`);
  assert.match(a, /^[A-Za-z0-9_-]+$/);
});

test("tokensEqual compares correctly", () => {
  const token = generateWebhookToken();
  assert.equal(tokensEqual(token, token), true);
  assert.equal(tokensEqual(token, generateWebhookToken()), false);
  assert.equal(tokensEqual(token, token + "x"), false); // length mismatch
  assert.equal(tokensEqual("", ""), true);
  // @ts-expect-error runtime guard for non-strings
  assert.equal(tokensEqual(undefined, token), false);
});
