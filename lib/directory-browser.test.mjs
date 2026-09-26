import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

async function loadSubject() {
  return import("./directory-browser.ts");
}

test("lists directories and directory symlinks without returning files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "omp-web-browse-"));
  try {
    await mkdir(path.join(root, "project"));
    await writeFile(path.join(root, "notes.txt"), "test", "utf8");
    await symlink(path.join(root, "project"), path.join(root, "linked-project"));

    const { listDirectories } = await loadSubject();
    const directories = await listDirectories(root);

    assert.deepEqual(directories.map((entry) => entry.name), ["linked-project", "project"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("expands home-relative paths and rejects missing directories", async () => {
  const {
    getBrowseStartDirectory,
    normalizeDirectory,
    resolveDirectory,
    shouldShowWindowsDrivePicker,
  } = await loadSubject();
  assert.equal(getBrowseStartDirectory(), homedir());
  assert.equal(getBrowseStartDirectory("/project"), "/project");
  assert.equal(shouldShowWindowsDrivePicker(undefined, "win32"), true);
  assert.equal(shouldShowWindowsDrivePicker(undefined, "darwin"), false);
  assert.equal(shouldShowWindowsDrivePicker(undefined, "linux"), false);
  assert.equal(shouldShowWindowsDrivePicker("C:\\Projects", "win32"), false);
  assert.equal(normalizeDirectory("~/project"), path.join(homedir(), "project"));
  assert.equal(normalizeDirectory("~\\project\\nested"), path.join(homedir(), "project", "nested"));
  await assert.rejects(resolveDirectory(path.join(tmpdir(), `omp-web-missing-${Date.now()}`)));
});

test("builds every Windows drive-letter candidate", async () => {
  const { getWindowsDriveCandidates } = await loadSubject();
  const drives = getWindowsDriveCandidates();

  assert.equal(drives.length, 26);
  assert.deepEqual(drives[0], { name: "A:", path: "A:\\" });
  assert.deepEqual(drives.at(-1), { name: "Z:", path: "Z:\\" });
});

test("finds parent directories across POSIX and Windows paths", async () => {
  const { getParentDirectory } = await loadSubject();

  assert.equal(getParentDirectory("/Users/alex/project"), "/Users/alex");
  assert.equal(getParentDirectory("/"), null);
  assert.equal(getParentDirectory("C:\\Users\\Alex\\project"), "C:\\Users\\Alex");
  assert.equal(getParentDirectory("C:\\"), null);
});

test("restores the separator Bun drops on a Windows drive root", async () => {
  const { restoreDriveRootSeparator } = await loadSubject();

  assert.equal(restoreDriveRootSeparator("C:"), "C:\\");
  assert.equal(restoreDriveRootSeparator("d:"), "d:\\");
  assert.equal(restoreDriveRootSeparator("C:\\Users"), "C:\\Users");
  assert.equal(restoreDriveRootSeparator("/"), "/");
});

test("resolves a Windows drive root into a path that can be listed", { skip: process.platform !== "win32" }, async () => {
  const { listDirectories, resolveDirectory } = await loadSubject();

  const root = await resolveDirectory("C:\\");
  assert.equal(root, "C:\\");
  assert.ok(Array.isArray(await listDirectories(root)));
});

test("creates exactly one child directory and returns its canonical path", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "omp-web-create-"));
  try {
    const { createChildDirectory } = await loadSubject();
    const created = await createChildDirectory(root, "new-project");

    assert.equal(created.name, "new-project");
    assert.equal(created.parentPath, await import("node:fs/promises").then(({ realpath }) => realpath(root)));
    assert.equal(created.path, path.join(created.parentPath, "new-project"));
    assert.equal((await import("node:fs/promises").then(({ stat }) => stat(created.path))).isDirectory(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects traversal, nested paths, empty names, and duplicates", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "omp-web-create-invalid-"));
  try {
    const { createChildDirectory } = await loadSubject();
    for (const name of ["", "   ", ".", "..", "nested/child", "nested\\child", "bad\0name"]) {
      await assert.rejects(createChildDirectory(root, name), /folder name|single folder/i);
    }

    await mkdir(path.join(root, "existing"));
    await assert.rejects(createChildDirectory(root, "existing"), (error) => error?.code === "EEXIST");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
