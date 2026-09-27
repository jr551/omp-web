import assert from "node:assert/strict";
import test from "node:test";

import { isScratchProjectRoot, SCRATCH_PROJECT_LABEL } from "./scratch-project.ts";

const HOME = "/home/tester";
const TEMP = "/tmp";

test("default omp-cwd working directories are scratch", () => {
  assert.equal(isScratchProjectRoot("/home/tester/omp-cwd-20260101", HOME, TEMP), true);
  assert.equal(isScratchProjectRoot("/home/tester/omp-cwd-20260101/", HOME, TEMP), true);
});

test("omp-cwd outside home is not treated as the default scratch dir", () => {
  assert.equal(isScratchProjectRoot("/somewhere/omp-cwd-20260101", HOME, TEMP), false);
});

test("directories under the temp dir are scratch", () => {
  assert.equal(isScratchProjectRoot("/tmp/foo", HOME, TEMP), true);
  assert.equal(isScratchProjectRoot("/tmp", HOME, TEMP), true);
});

test("real project roots are not scratch", () => {
  assert.equal(isScratchProjectRoot("/home/tester/projects/app", HOME, TEMP), false);
  assert.equal(isScratchProjectRoot("/home/tester/omp-cwd-bad", HOME, TEMP), false);
  assert.equal(isScratchProjectRoot("", HOME, TEMP), false);
  assert.equal(isScratchProjectRoot(null, HOME, TEMP), false);
  assert.equal(isScratchProjectRoot(undefined, HOME, TEMP), false);
});

test("exposes a stable label", () => {
  assert.equal(SCRATCH_PROJECT_LABEL, "Non Project Related");
});
