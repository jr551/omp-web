import assert from "node:assert/strict";
import test from "node:test";

import {
  exportRoutines,
  importRoutines,
  mergeRoutines,
  parseRoutines,
  ROUTINE_SYNC_FILENAME,
  serializeRoutines,
} from "./routine-git.ts";

const routine = (over) => ({
  id: "r1",
  name: "R1",
  cwd: "/proj",
  trigger: { type: "cron", schedule: "0 9 * * *" },
  prompt: "do it",
  maxExecutionMs: 60000,
  enabled: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

function fakeIo(initial = {}) {
  const files = new Map(Object.entries(initial));
  return {
    files,
    read: (path) => (files.has(path) ? files.get(path) : null),
    write: (path, data) => { files.set(path, data); },
  };
}

function fakeGit() {
  const calls = [];
  const git = async (args) => {
    calls.push(args);
    if (args[0] === "commit" && git.commitFails) throw new Error("nothing to commit");
    return { stdout: "", stderr: "" };
  };
  git.calls = calls;
  git.commitFails = false;
  return git;
}

test("serialize/parse round-trips and parse tolerates junk", () => {
  const json = serializeRoutines([routine({ id: "b" }), routine({ id: "a" })]);
  const parsed = parseRoutines(json);
  assert.deepEqual(parsed.map((r) => r.id), ["a", "b"]); // sorted by id
  assert.deepEqual(parseRoutines("not json"), []);
  assert.deepEqual(parseRoutines('{"routines":[{"nope":1}]}'), []);
  assert.equal(parseRoutines(JSON.stringify([routine({ id: "x" })])).length, 1); // bare array
});

test("mergeRoutines dedupes by id, newest updatedAt wins", () => {
  const local = [
    routine({ id: "a", name: "local-a", updatedAt: "2026-01-02T00:00:00.000Z" }),
    routine({ id: "b", name: "local-b", updatedAt: "2026-01-01T00:00:00.000Z" }),
  ];
  const incoming = [
    routine({ id: "a", name: "remote-a", updatedAt: "2026-01-01T00:00:00.000Z" }), // older, loses
    routine({ id: "b", name: "remote-b", updatedAt: "2026-01-03T00:00:00.000Z" }), // newer, wins
    routine({ id: "c", name: "remote-c" }), // new id, added
  ];
  const merged = mergeRoutines(local, incoming);
  assert.deepEqual(merged.map((r) => `${r.id}:${r.name}`), ["a:local-a", "b:remote-b", "c:remote-c"]);
});

test("mergeRoutines keeps local on a tie", () => {
  const merged = mergeRoutines(
    [routine({ id: "a", name: "local", updatedAt: "2026-01-01T00:00:00.000Z" })],
    [routine({ id: "a", name: "remote", updatedAt: "2026-01-01T00:00:00.000Z" })],
  );
  assert.equal(merged[0].name, "local");
});

test("exportRoutines writes, commits, and pushes with injected git+io", async () => {
  const io = fakeIo();
  const git = fakeGit();
  const result = await exportRoutines({
    routines: [routine()],
    repoDir: "/repo",
    git,
    io,
    remote: "origin",
    branch: "main",
  });
  assert.equal(result.file, `/repo/${ROUTINE_SYNC_FILENAME}`);
  assert.equal(result.committed, true);
  assert.equal(result.pushed, true);
  assert.ok(io.files.get(`/repo/${ROUTINE_SYNC_FILENAME}`).includes('"r1"'));
  assert.deepEqual(git.calls[0], ["add", ROUTINE_SYNC_FILENAME]);
  assert.deepEqual(git.calls.at(-1), ["push", "origin", "main"]);
});

test("exportRoutines reports committed=false when nothing changed", async () => {
  const git = fakeGit();
  git.commitFails = true;
  const result = await exportRoutines({ routines: [routine()], repoDir: "/repo", git, io: fakeIo() });
  assert.equal(result.committed, false);
  assert.equal(result.pushed, false);
});

test("importRoutines pulls then reads the routine file", async () => {
  const io = fakeIo({ [`/repo/${ROUTINE_SYNC_FILENAME}`]: serializeRoutines([routine({ id: "z" })]) });
  const git = fakeGit();
  const { routines } = await importRoutines({ repoDir: "/repo", git, io, remote: "origin", branch: "main" });
  assert.deepEqual(routines.map((r) => r.id), ["z"]);
  assert.deepEqual(git.calls[0], ["pull", "--ff-only", "origin", "main"]);
});

test("importRoutines returns empty when the file is missing", async () => {
  const { routines } = await importRoutines({ repoDir: "/repo", git: fakeGit(), io: fakeIo() });
  assert.deepEqual(routines, []);
});
