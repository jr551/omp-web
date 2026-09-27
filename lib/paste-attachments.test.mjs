import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./paste-attachments.ts");
}

test("counts lines without counting a trailing newline as an extra line", async () => {
  const { countLines } = await loadSubject();
  assert.equal(countLines(""), 0);
  assert.equal(countLines("one"), 1);
  assert.equal(countLines("one\ntwo"), 2);
  assert.equal(countLines("one\ntwo\n"), 2);
  assert.equal(countLines("one\ntwo\n\n"), 3);
});

test("attaches long pastes but keeps small ones inline", async () => {
  const { shouldAttachPastedText, PASTE_ATTACH_CHAR_THRESHOLD } = await loadSubject();

  assert.equal(shouldAttachPastedText(""), false);
  assert.equal(shouldAttachPastedText("just a short line"), false);
  // Just under / over the char threshold.
  assert.equal(shouldAttachPastedText("a".repeat(PASTE_ATTACH_CHAR_THRESHOLD)), false);
  assert.equal(shouldAttachPastedText("a".repeat(PASTE_ATTACH_CHAR_THRESHOLD + 1)), true);
  // Many short lines still attach even under the char threshold.
  assert.equal(shouldAttachPastedText(Array.from({ length: 15 }, () => "x").join("\n")), false);
  assert.equal(shouldAttachPastedText(Array.from({ length: 16 }, () => "x").join("\n")), true);
});

test("reports char and line stats for a paste", async () => {
  const { pastedTextStats } = await loadSubject();
  assert.deepEqual(pastedTextStats("ab\ncd"), { chars: 5, lines: 2 });
});

test("builds a compact single-line preview", async () => {
  const { pastedTextPreview } = await loadSubject();
  assert.equal(pastedTextPreview("first line\nsecond line"), "first line");
  assert.equal(pastedTextPreview("  padded  \nnext"), "padded");
  assert.equal(pastedTextPreview("x".repeat(100), 10), "xxxxxxxxx…");
});

test("fences pasted text with a fence longer than any inner backtick run", async () => {
  const { fencePastedText } = await loadSubject();

  assert.equal(fencePastedText("hello"), "```\nhello\n```");
  // Inner triple backticks force a four-backtick fence.
  const withFence = fencePastedText("```\ncode\n```");
  assert.ok(withFence.startsWith("````\n"));
  assert.ok(withFence.endsWith("\n````"));
  assert.ok(withFence.includes("```\ncode\n```"));
});

test("assembles the outgoing message with attachments prepended as fenced blocks", async () => {
  const { assembleMessageWithPastedTexts } = await loadSubject();

  assert.equal(assembleMessageWithPastedTexts("hi", []), "hi");

  const one = assembleMessageWithPastedTexts("please review", [{ id: "a", text: "big blob" }]);
  assert.equal(one, "```\nbig blob\n```\n\nplease review");

  // No typed message: just the blocks.
  const noMessage = assembleMessageWithPastedTexts("   ", [{ id: "a", text: "blob" }]);
  assert.equal(noMessage, "```\nblob\n```");

  // Multiple attachments keep their order, joined by a blank line.
  const many = assembleMessageWithPastedTexts("go", [
    { id: "a", text: "first" },
    { id: "b", text: "second" },
  ]);
  assert.equal(many, "```\nfirst\n```\n\n```\nsecond\n```\n\ngo");

  // Empty/whitespace-only attachments are ignored.
  assert.equal(assembleMessageWithPastedTexts("go", [{ id: "a", text: "   " }]), "go");
});
