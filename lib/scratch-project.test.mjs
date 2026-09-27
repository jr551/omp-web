import assert from "node:assert/strict";
import test from "node:test";

import { collapseScratchGroups, isScratchProjectRoot, SCRATCH_PROJECT_LABEL } from "./scratch-project.ts";

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

test("collapseScratchGroups merges every scratch root into one pinned group", () => {
  const groups = [
    { project: "/tmp/a", name: "a", isScratch: true, sessions: ["s1"], routines: ["r1"] },
    { project: "/home/tester/projects/app", name: "app", isScratch: false, sessions: ["s2"], routines: [] },
    { project: "/tmp/b", name: "b", isScratch: true, sessions: ["s3"], routines: ["r2", "r3"] },
    { project: "/home/tester/omp-cwd-20260101", name: "cwd", isScratch: true, sessions: [], routines: ["r4"] },
  ];
  const merged = collapseScratchGroups(groups, SCRATCH_PROJECT_LABEL);

  assert.equal(merged.length, 2);
  const [scratch, app] = merged;
  assert.equal(scratch.name, SCRATCH_PROJECT_LABEL);
  assert.equal(scratch.isScratch, true);
  assert.equal(scratch.project, "/tmp/a"); // first scratch group's key
  assert.deepEqual(scratch.sessions, ["s1", "s3"]);
  assert.deepEqual(scratch.routines, ["r1", "r2", "r3", "r4"]);
  assert.equal(app.name, "app");
});

test("collapseScratchGroups is a no-op without scratch groups", () => {
  const groups = [
    { project: "/p/a", name: "a", isScratch: false, sessions: ["s1"], routines: [] },
    { project: "/p/b", name: "b", isScratch: false, sessions: ["s2"], routines: [] },
  ];
  const result = collapseScratchGroups(groups, SCRATCH_PROJECT_LABEL);
  assert.deepEqual(result, groups);
});
