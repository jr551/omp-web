#!/usr/bin/env bash
# Single source of truth for "the tests pass" in this repository.
#
# Every workflow that needs to decide whether a tree is releasable (ci.yml,
# update-omp.yml, weekly-release.yml, opencode-agent.yml) runs this script, and
# so does the OpenCode repair loop. Change the definition of "green" here, not
# in the workflows.
#
# Environment knobs:
#   SKIP_INSTALL=1   skip `bun install --frozen-lockfile` (dependencies already installed)
#   SKIP_BUILD=1     skip `bun run build` (faster inner loop; CI never sets this)
#   LINT_STRICT=1    make `bun run lint` fatal. Default 0: the tree currently has
#                    pre-existing React Compiler lint errors
#                    (react-hooks/preserve-manual-memoization), so lint is reported
#                    but does not fail the run. Flip the default once lint is clean.
#
# Note: `bun run build` writes .next/. AGENTS.md forbids that during local dev
# because it breaks a running `bun run dev`; in CI and in throwaway checkouts it
# is exactly what we want to verify.
set -euo pipefail

#   REPO_ROOT=dir    run against this checkout instead of the one containing this
#                    script (the OpenCode loop runs a pristine copy of ci.sh so the
#                    model cannot weaken the definition of green it is judged by)
repo_root="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "$repo_root"

LINT_STRICT="${LINT_STRICT:-0}"
SKIP_INSTALL="${SKIP_INSTALL:-0}"
SKIP_BUILD="${SKIP_BUILD:-0}"

in_actions() { [[ "${GITHUB_ACTIONS:-}" == "true" ]]; }

group_start() {
  if in_actions; then echo "::group::$1"; else printf '\n==> %s\n' "$1"; fi
}
group_end() {
  if in_actions; then echo "::endgroup::"; fi
}

run_step() {
  local name="$1"
  shift
  group_start "$name"
  local status=0
  "$@" || status=$?
  group_end
  if [[ "$status" -ne 0 ]]; then
    echo "ci.sh: step '$name' failed (exit $status): $*" >&2
    return "$status"
  fi
  echo "ci.sh: step '$name' passed"
}

echo "ci.sh: bun $(bun --version), node $(node --version 2>/dev/null || echo 'n/a')"

if [[ "$SKIP_INSTALL" != "1" ]]; then
  run_step "install" bun install --frozen-lockfile
fi

run_step "typecheck" bun run typecheck

if [[ "$LINT_STRICT" == "1" ]]; then
  run_step "lint" bun run lint
else
  if ! run_step "lint (non-fatal)" bun run lint; then
    msg="lint failed but LINT_STRICT!=1, continuing (pre-existing lint errors)"
    if in_actions; then echo "::warning title=lint::$msg"; else echo "ci.sh: WARNING: $msg" >&2; fi
  fi
fi

run_step "test" bun test

if [[ "$SKIP_BUILD" != "1" ]]; then
  run_step "build" bun run build
fi

echo "ci.sh: all required steps passed"
