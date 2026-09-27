import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

// Import through jiti because useAudio.ts is a "use client" TS module. Only the
// pure tone/config logic is exercised — no AudioContext is ever constructed, so
// no sound is (or can be) played in tests.
const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { getCueTones } = await jiti.import("./useAudio.ts");

const CUES = ["done", "attention", "error"];

test("every cue resolves to at least one well-formed tone", () => {
  for (const cue of CUES) {
    const tones = getCueTones(cue);
    assert.ok(Array.isArray(tones) && tones.length >= 1, `${cue} has tones`);
    for (const tone of tones) {
      assert.ok(tone.freq > 0, `${cue} freq positive`);
      assert.ok(tone.duration > 0, `${cue} duration positive`);
      assert.ok(tone.peakGain > 0 && tone.peakGain <= 1, `${cue} gain in range`);
      assert.ok(tone.startOffset >= 0, `${cue} startOffset non-negative`);
      assert.ok(["sine", "triangle", "square", "sawtooth"].includes(tone.type), `${cue} valid waveform`);
    }
  }
});

test("the completion cue is two ascending sine notes", () => {
  const done = getCueTones("done");
  assert.equal(done.length, 2);
  assert.ok(done[1].freq > done[0].freq, "second note is higher");
  assert.ok(done.every((tone) => tone.type === "sine"));
});

test("the error cue descends and uses a harsher waveform", () => {
  const error = getCueTones("error");
  assert.ok(error[error.length - 1].freq < error[0].freq, "final note is lower");
  assert.ok(error.some((tone) => tone.type === "triangle"));
});

test("each cue is acoustically distinct from the others", () => {
  const signature = (cue) => getCueTones(cue).map((t) => `${t.freq}:${t.type}`).join("|");
  const signatures = CUES.map(signature);
  assert.equal(new Set(signatures).size, CUES.length, "no two cues share a signature");
});
