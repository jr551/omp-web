#!/usr/bin/env bash
# Upgrade every dependency to its latest release and bump the omp-web version.
# Used by .github/workflows/weekly-release.yml; safe to run locally in a scratch
# checkout (it edits package.json and bun.lock in place, nothing else).
#
#   1. `bun update --latest` for everything
#   2. force every @oh-my-pi/* dependency to `~<latest npm version>` so the whole
#      SDK moves in lockstep (update-omp.yml's release step requires one shared
#      `~X.Y.Z` range)
#   3. `bun install` to settle bun.lock
#   4. if anything changed: bump package.json version - patch, or minor when the
#      omp major changed (same policy as update-omp.yml)
#
# Outputs (to $GITHUB_OUTPUT when set, and always to stdout as key=value):
#   changed=true|false  version=<new omp-web version>  omp_from=  omp_to=
# Writes a markdown table of upgraded packages to ${CHANGES_FILE:-$RUNNER_TEMP/upgrade-changes.md}.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"
CHANGES_FILE="${CHANGES_FILE:-${RUNNER_TEMP:-/tmp}/upgrade-changes.md}"
OMP_ANCHOR="@oh-my-pi/pi-coding-agent"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cp package.json "$tmp/before.json"
cp bun.lock "$tmp/before.lock"

omp_latest="$(npm view "$OMP_ANCHOR" version --silent)"
if ! [[ "$omp_latest" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "upgrade-deps: unexpected $OMP_ANCHOR version '$omp_latest'" >&2
  exit 1
fi

echo "upgrade-deps: bun update --latest" >&2
bun update --latest

OMP_VERSION="$omp_latest" node <<'NODE'
const fs = require('node:fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
  for (const name of Object.keys(pkg[field] || {})) {
    if (name.startsWith('@oh-my-pi/')) pkg[field][name] = `~${process.env.OMP_VERSION}`;
  }
}
fs.writeFileSync('package.json', `${JSON.stringify(pkg, null, 2)}\n`);
NODE

bun install

# Resolved versions straight from bun.lock would be more precise, but the ranges
# in package.json are what reviewers read; report those.
node - "$tmp/before.json" "$CHANGES_FILE" <<'NODE' >"$tmp/result"
const fs = require('node:fs');
const [beforePath, changesPath] = process.argv.slice(2);
const before = JSON.parse(fs.readFileSync(beforePath, 'utf8'));
const after = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const rows = [];
for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
  const a = before[field] || {};
  const b = after[field] || {};
  for (const name of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    if (a[name] !== b[name]) rows.push(`| \`${name}\` | ${a[name] ?? '-'} | ${b[name] ?? '-'} |`);
  }
}
const ver = (range) => /(\d+)\.(\d+)\.(\d+)/.exec(range || '');
const ompFrom = ver(before.dependencies?.['@oh-my-pi/pi-coding-agent']);
const ompTo = ver(after.dependencies?.['@oh-my-pi/pi-coding-agent']);
const body = rows.length
  ? ['### Upgraded packages', '', '| Package | From | To |', '|---|---|---|', ...rows, ''].join('\n')
  : 'No dependency ranges changed (lockfile refresh only).\n';
fs.writeFileSync(changesPath, body);
console.log(`rows=${rows.length}`);
console.log(`omp_from=${ompFrom ? ompFrom[0] : ''}`);
console.log(`omp_to=${ompTo ? ompTo[0] : ''}`);
NODE

rows="$(sed -n 's/^rows=//p' "$tmp/result")"
omp_from="$(sed -n 's/^omp_from=//p' "$tmp/result")"
omp_to="$(sed -n 's/^omp_to=//p' "$tmp/result")"

changed=false
if [[ "$rows" != "0" ]] || ! cmp -s bun.lock "$tmp/before.lock"; then changed=true; fi

version="$(node -p "require('./package.json').version")"
if [[ "$changed" == "true" ]]; then
  version="$(OMP_FROM="$omp_from" OMP_TO="$omp_to" node <<'NODE'
const fs = require('node:fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(pkg.version);
if (!m) throw new Error(`Unexpected omp-web version: ${pkg.version}`);
const [major, minor, patch] = m.slice(1).map(Number);
const ompMajor = (v) => /^(\d+)\./.exec(v || '')?.[1];
pkg.version = ompMajor(process.env.OMP_FROM) === ompMajor(process.env.OMP_TO)
  ? `${major}.${minor}.${patch + 1}`
  : `${major}.${minor + 1}.0`;
fs.writeFileSync('package.json', `${JSON.stringify(pkg, null, 2)}\n`);
process.stdout.write(pkg.version);
NODE
)"
  bun install --lockfile-only >/dev/null # keep bun.lock in step with the new version
fi

out="$(printf 'changed=%s\nversion=%s\nomp_from=%s\nomp_to=%s\n' "$changed" "$version" "$omp_from" "$omp_to")"
echo "$out"
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then echo "$out" >>"$GITHUB_OUTPUT"; fi
