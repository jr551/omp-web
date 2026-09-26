#!/usr/bin/env bash
# Attach an installable npm tarball to a GitHub Release.
#
# The fork cannot publish to npm under the `omp-web` name (owned upstream), so
# every release carries the package itself:
#   omp-web-X.Y.Z.tgz   versioned asset
#   omp-web.tgz         stable name, so this always works:
#     bun add -g https://github.com/<owner>/omp-web/releases/latest/download/omp-web.tgz
#
# Usage: release-assets.sh <tag>        (run from a checkout of the tagged commit)
# Env:   BUILD=1  force `bun run build` even if .next/BUILD_ID exists
#        NO_UPLOAD=1  pack and verify only (local testing)
#        GH_TOKEN, GITHUB_REPOSITORY  for `gh release upload`
set -euo pipefail

tag="${1:?usage: release-assets.sh <tag>}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

version="$(node -p "require('./package.json').version")"
if [[ "$tag" != "v$version" ]]; then
  echo "release-assets: tag $tag does not match package.json version $version" >&2
  exit 1
fi

if [[ "${BUILD:-0}" == "1" || ! -f .next/BUILD_ID ]]; then
  if [[ ! -d node_modules ]]; then bun install --frozen-lockfile; fi
  bun run build
fi

out="${RUNNER_TEMP:-$(mktemp -d)}/release-assets"
rm -rf "$out"
mkdir -p "$out"
# --ignore-scripts: nothing to run at pack time, and it keeps a stray `prepack`
# from rebuilding into a different .next than the one CI just verified.
npm pack --ignore-scripts --pack-destination "$out" >"$out/pack.log" 2>&1 || { cat "$out/pack.log" >&2; exit 1; }
tarball="$out/omp-web-$version.tgz"
if [[ ! -f "$tarball" ]]; then
  echo "release-assets: npm pack did not produce $tarball" >&2
  ls -la "$out" >&2
  exit 1
fi

# The package is useless without the production build: fail loudly if it is missing.
listing="$(tar -tzf "$tarball")"
for required in package/.next/BUILD_ID package/bin/omp-web.js package/package.json; do
  if ! grep -qxF "$required" <<<"$listing"; then
    echo "release-assets: $required missing from $tarball" >&2
    exit 1
  fi
done
cp "$tarball" "$out/omp-web.tgz"
echo "release-assets: $(du -h "$tarball" | cut -f1) $tarball ($(wc -l <<<"$listing") files)"

if [[ "${NO_UPLOAD:-0}" == "1" ]]; then exit 0; fi
gh release upload "$tag" "$tarball" "$out/omp-web.tgz" --clobber --repo "${GITHUB_REPOSITORY:?}"
echo "release-assets: uploaded to $tag"
