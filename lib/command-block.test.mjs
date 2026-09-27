import test from "node:test";
import assert from "node:assert/strict";

async function loadSubject() {
  return import("./command-block.ts");
}

test("command/bash blocks default to collapsed", async () => {
  const { COMMAND_BLOCK_DEFAULT_EXPANDED } = await loadSubject();
  assert.equal(COMMAND_BLOCK_DEFAULT_EXPANDED, false);
});

test("initialCommandBlockExpanded defaults to collapsed but honours persisted state", async () => {
  const { initialCommandBlockExpanded } = await loadSubject();
  assert.equal(initialCommandBlockExpanded(undefined), false);
  assert.equal(initialCommandBlockExpanded(true), true);
  assert.equal(initialCommandBlockExpanded(false), false);
});

test("firstCommandOutputLine picks the first non-empty, ANSI-stripped line", async () => {
  const { firstCommandOutputLine } = await loadSubject();
  assert.equal(firstCommandOutputLine(""), "");
  assert.equal(firstCommandOutputLine("\n\n  hello\nworld"), "hello");
  assert.equal(firstCommandOutputLine("\u001b[31merror here\u001b[0m\nmore"), "error here");
});

test("firstCommandOutputLine truncates long lines", async () => {
  const { firstCommandOutputLine } = await loadSubject();
  const long = "x".repeat(200);
  const preview = firstCommandOutputLine(long, 10);
  assert.equal(preview.length, 10);
  assert.ok(preview.endsWith("…"));
});
