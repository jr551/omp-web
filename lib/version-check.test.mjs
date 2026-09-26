import assert from "node:assert/strict";
import test from "node:test";
import { serverVersionFromPayload, shouldShowBanner } from "./version-check.ts";

test("serverVersionFromPayload: extracts a non-empty ompWebVersion string", () => {
  assert.equal(
    serverVersionFromPayload({ ok: true, ompWebVersion: "0.5.4", ompVersion: "17.3.0" }),
    "0.5.4",
  );
});

test("serverVersionFromPayload: missing field yields undefined", () => {
  assert.equal(serverVersionFromPayload({ ok: true }), undefined);
  assert.equal(serverVersionFromPayload({}), undefined);
});

test("serverVersionFromPayload: non-string or empty values yield undefined", () => {
  assert.equal(serverVersionFromPayload({ ompWebVersion: 7 }), undefined);
  assert.equal(serverVersionFromPayload({ ompWebVersion: null }), undefined);
  assert.equal(serverVersionFromPayload({ ompWebVersion: "" }), undefined);
});

test("serverVersionFromPayload: non-object payloads yield undefined", () => {
  assert.equal(serverVersionFromPayload(null), undefined);
  assert.equal(serverVersionFromPayload("0.5.4"), undefined);
  assert.equal(serverVersionFromPayload(42), undefined);
});

test("shouldShowBanner: mismatched versions show the banner", () => {
  assert.equal(shouldShowBanner("0.3.8", "0.5.4", null), true);
});

test("shouldShowBanner: rollback (server older than client) also shows", () => {
  assert.equal(shouldShowBanner("0.5.4", "0.3.8", null), true);
});

test("shouldShowBanner: matching versions never show", () => {
  assert.equal(shouldShowBanner("0.5.4", "0.5.4", null), false);
});

test("shouldShowBanner: unknown or empty versions never show", () => {
  assert.equal(shouldShowBanner(undefined, "0.5.4", null), false);
  assert.equal(shouldShowBanner("0.3.8", undefined, null), false);
  assert.equal(shouldShowBanner("", "0.5.4", null), false);
  assert.equal(shouldShowBanner("0.3.8", "", null), false);
});

test("shouldShowBanner: dismissal suppresses only the dismissed server version", () => {
  // Same mismatch the user dismissed: stays hidden on every later poll.
  assert.equal(shouldShowBanner("0.3.8", "0.5.4", "0.5.4"), false);
  // A further upgrade re-shows the banner.
  assert.equal(shouldShowBanner("0.3.8", "0.5.5", "0.5.4"), true);
  // A rollback to an unseen server version re-shows too.
  assert.equal(shouldShowBanner("0.5.4", "0.3.8", "0.5.3"), true);
});

test("shouldShowBanner: matching versions stay hidden regardless of dismissal", () => {
  assert.equal(shouldShowBanner("0.5.4", "0.5.4", "0.5.3"), false);
});
