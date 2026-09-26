import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  buildInstallPlan,
  compareVersions,
  getOmpWebUpdateStatus,
} = await jiti.import("./omp-updates.ts");

function response(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function fetcher({ release }) {
  return async (url) => {
    assert.ok(!url.includes("registry.npmjs.org"), "the fork must not consult upstream's npm package");
    if (url.includes("api.github.com/repos/jr551/omp-web/")) return release === null ? response({}, 503) : response(release);
    throw new Error(`Unexpected URL: ${url}`);
  };
}

const release = {
  tag_name: "v0.1.8",
  name: "v0.1.8",
  body: "## Fixed\n\n- A release fix",
  html_url: "https://github.com/jr551/omp-web/releases/tag/v0.1.8",
  published_at: "2026-08-05T01:32:09Z",
  assets: [{ name: "omp-web-0.1.8.tgz" }, { name: "omp-web.tgz" }],
};

const TARBALL = "https://github.com/jr551/omp-web/releases/latest/download/omp-web.tgz";

test("compares release versions with prerelease ordering", () => {
  assert.equal(compareVersions("v0.1.8", "0.1.7"), 1);
  assert.equal(compareVersions("0.1.8-rc.1", "0.1.8"), -1);
  assert.equal(compareVersions("0.1.8+build.2", "0.1.8+build.1"), 0);
  assert.equal(compareVersions("not-a-version", "0.1.8"), 0);
});

test("reports a fork release with its changelog and installs its tarball", async () => {
  const status = await getOmpWebUpdateStatus({
    currentAppVersion: "0.1.7",
    fetcher: fetcher({ release }),
    env: { OMP_WEB_UPDATE_MANAGER: "bun" },
  });

  assert.equal(status.updateAvailable, true);
  assert.equal(status.availability, "installable");
  assert.equal(status.currentAppVersion, "0.1.7");
  assert.equal(status.latestRelease.version, "0.1.8");
  assert.equal(status.latestRelease.body, release.body);
  assert.equal(status.latestRelease.htmlUrl, release.html_url);
  assert.equal(status.latestPackage?.version, "0.1.8");
  assert.equal(status.install.canInstall, true);
  assert.equal(status.install.command, `bun add --global ${TARBALL}`);
  assert.equal(status.install.alternateCommand, `npm install --global ${TARBALL}`);
});

test("does not offer an install before the release tarball is uploaded", async () => {
  const status = await getOmpWebUpdateStatus({
    currentAppVersion: "0.1.7",
    fetcher: fetcher({ release: { ...release, assets: [] } }),
  });

  assert.equal(status.updateAvailable, false);
  assert.equal(status.availability, "up-to-date");
  assert.equal(status.latestPackage, null);
  assert.equal(status.latestRelease.version, "0.1.8");
});

test("self-update can be disabled without hiding the manual commands", () => {
  const plan = buildInstallPlan({
    currentAppVersion: "0.1.7",
    latestPackage: { version: "0.1.8" },
    env: { OMP_WEB_UPDATE_MANAGER: "bun", OMP_WEB_DISABLE_SELF_UPDATE: "1" },
  });

  assert.equal(plan.canInstall, false);
  assert.equal(plan.reason, "disabled");
  assert.equal(plan.command, `bun add --global ${TARBALL}`);
});
