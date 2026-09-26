#!/usr/bin/env bash
# Autonomous maintainer loop: let a free OpenCode Zen model implement TASK, prove
# it with .github/scripts/ci.sh, and hand the result over as a pull request.
#
#   for MODEL in $(select-models.sh):
#     reset the tree to the starting commit
#     opencode run --model opencode/$MODEL "<task + rules>"        (timeout)
#     model errored and changed nothing  -> next model (rate limit, unavailable, ...)
#     up to CI_ATTEMPTS runs of ci.sh; after each failure feed `tail -n 300` of the
#       log back into the same session and let the model fix it
#     green -> commit, push branch, open PR (or update the branch in repair mode)
#
# Never pushes to the base branch. Never talks to the upstream repository.
#
# Usage: opencode-agent.sh "task text"    (or TASK=... / TASK_FILE=...)
#
# Environment:
#   OPENCODE_API_KEY   Zen API key (read by opencode itself)
#   GH_TOKEN           token used for `git push` and `gh pr create` only. It is
#                      removed from the environment of every opencode process.
#   TASK / TASK_FILE   the task (argv[1] wins)
#   CONTEXT_FILE       optional extra context appended to the prompt (truncated)
#   MODE               "pr" (default): new branch + PR against BASE_BRANCH
#                      "repair": commit onto the current branch and push it back
#                                to BRANCH (used for failing bot PRs)
#   BASE_BRANCH        default main
#   BRANCH             pr mode default opencode/agent-<run id>; repair mode: required
#   ISSUE_NUMBER       adds "Closes #N" to the PR body
#   PR_TITLE           default derived from the task
#   PR_BODY_FILE       optional markdown prepended to the generated PR body
#   MODELS             space-separated model ids; default: select-models.sh output
#   MAX_MODELS         try at most this many models (default 6)
#   CI_SCRIPT          default .github/scripts/ci.sh (a pristine copy is executed)
#   CI_ATTEMPTS        default 3
#   OPENCODE_TIMEOUT   first-pass timeout (default 30m); FIX_TIMEOUT (default 20m)
#   OPENCODE_CONFIG_FILE  default .github/opencode/opencode.json -> OPENCODE_CONFIG_CONTENT
#   NO_PUSH=1          stop after a green local commit (local testing)
#   NOOP_OK=1          a model that finishes cleanly without changing anything has
#                      decided there is nothing to do: stop with result=noop instead
#                      of trying the next model (used by the maintenance sweep)
#   LOG_DIR            default $RUNNER_TEMP/opencode-agent or a mktemp dir
set -euo pipefail

log() { echo "opencode-agent: $*" >&2; }
die() { log "ERROR: $*"; exit 2; }

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

task="${1:-${TASK:-}}"
if [[ -z "$task" && -n "${TASK_FILE:-}" ]]; then task="$(cat "$TASK_FILE")"; fi
[[ -n "$task" ]] || die "no task given (argv[1], TASK or TASK_FILE)"

MODE="${MODE:-pr}"
BASE_BRANCH="${BASE_BRANCH:-main}"
run_id="${GITHUB_RUN_ID:-local-$(date +%s)}"
CI_SCRIPT="${CI_SCRIPT:-$script_dir/ci.sh}"
CI_ATTEMPTS="${CI_ATTEMPTS:-3}"
MAX_MODELS="${MAX_MODELS:-6}"
OPENCODE_TIMEOUT="${OPENCODE_TIMEOUT:-30m}"
FIX_TIMEOUT="${FIX_TIMEOUT:-20m}"
NO_PUSH="${NO_PUSH:-0}"
NOOP_OK="${NOOP_OK:-0}"
LOG_DIR="${LOG_DIR:-${RUNNER_TEMP:+$RUNNER_TEMP/opencode-agent}}"
if [[ -z "$LOG_DIR" ]]; then LOG_DIR="$(mktemp -d)"; fi
mkdir -p "$LOG_DIR"

case "$MODE" in
  pr) BRANCH="${BRANCH:-opencode/agent-$run_id}" ;;
  repair) [[ -n "${BRANCH:-}" ]] || die "MODE=repair needs BRANCH" ;;
  *) die "unknown MODE '$MODE'" ;;
esac
if [[ "$BRANCH" == "$BASE_BRANCH" ]]; then die "refusing to push to the base branch '$BASE_BRANCH'"; fi

export PATH="$HOME/.opencode/bin:$PATH"
command -v opencode >/dev/null 2>&1 || die "opencode CLI not found (install: curl -fsSL https://opencode.ai/install | bash)"
command -v jq >/dev/null 2>&1 || die "jq is required"

# Non-interactive permissions. OPENCODE_CONFIG_CONTENT wins over files in the repo.
config_file="${OPENCODE_CONFIG_FILE:-$repo_root/.github/opencode/opencode.json}"
if [[ -z "${OPENCODE_CONFIG_CONTENT:-}" && -f "$config_file" ]]; then
  OPENCODE_CONFIG_CONTENT="$(cat "$config_file")"
  export OPENCODE_CONFIG_CONTENT
fi
auto_flag=()
if opencode run --help 2>&1 | grep -q -- '--auto'; then auto_flag=(--auto); fi

# Freeze the judge: run the CI script as it was before the model touched anything.
ci_copy="$LOG_DIR/ci.sh"
cp "$CI_SCRIPT" "$ci_copy"
chmod +x "$ci_copy"

start_sha="$(git rev-parse HEAD)"
log "start $start_sha, mode=$MODE, branch=$BRANCH, logs in $LOG_DIR"

if [[ -n "${MODELS:-}" ]]; then
  read -r -a models <<<"$MODELS"
else
  mapfile -t models < <("$script_dir/select-models.sh" | cut -f2)
fi
[[ "${#models[@]}" -gt 0 ]] || die "no models to try"
if [[ "${#models[@]}" -gt "$MAX_MODELS" ]]; then models=("${models[@]:0:$MAX_MODELS}"); fi
log "models: ${models[*]}"

context=""
if [[ -n "${CONTEXT_FILE:-}" && -f "$CONTEXT_FILE" ]]; then
  context="$(head -c 60000 "$CONTEXT_FILE")"
fi

prompt="$(cat <<EOF
You are the autonomous maintainer of this repository (omp-web, a Next.js web UI for the
omp / oh-my-pi coding agent, running on Bun). You are running non-interactively in CI.

TASK:
$task

RULES:
- Read AGENTS.md first and follow it. Keep changes focused on the task; if CI fails for a
  pre-existing reason, fix it minimally and say so in your summary.
- Verify your work with: bash .github/scripts/ci.sh  (install, typecheck, lint, bun test, build).
  It must pass. Add or update tests for behaviour you change.
- Do NOT modify anything under .github/ (workflows, scripts, config); those edits are discarded.
- Do NOT weaken, skip or delete tests or checks to make CI pass.
- Do NOT git push, open PRs, or post comments/issues anywhere. You have no GitHub credentials;
  the harness commits and opens the PR for you. Local git commits and merges are fine.
- Never print, log or write secrets or environment variables.
- The upstream project (github.com/ddallabenetta/omp-web) is read-only for you. If a ref
  named upstream/main exists you may merge or cherry-pick from it.
- When done, reply with a short summary of what you changed and why.
EOF
)"
if [[ -n "$context" ]]; then
  prompt+=$'\n\nCONTEXT (gathered by the harness, may be truncated):\n'"$context"
fi

# Run opencode without any GitHub credentials in its environment.
# (An array, not a function: `timeout` can only run real commands.)
oc=(env -u GH_TOKEN -u GITHUB_TOKEN -u ACTIONS_RUNTIME_TOKEN -u ACTIONS_ID_TOKEN_REQUEST_TOKEN
  opencode run "${auto_flag[@]}" --format json)

# Extract the first error message from an opencode JSON event log ("" if none).
oc_error() { jq -Rr 'fromjson? | select(.type == "error") | (.error.data.message // .error.name // "error")' "$1" | head -n 1; }
oc_session() { jq -Rr 'fromjson? | .sessionID // .part.sessionID // empty' "$1" | head -n 1; }

reset_tree() {
  git reset -q --hard "$start_sha"
  git clean -fdq # keeps ignored files (node_modules, .next)
}

has_changes() {
  [[ -n "$(git status --porcelain)" || "$(git rev-parse HEAD)" != "$start_sha" ]]
}

# Discard anything the model did under .github/ (GITHUB_TOKEN cannot push workflow
# changes anyway, and the harness must not be editable by the agent).
drop_github_changes() {
  git checkout -q "$start_sha" -- .github 2>/dev/null || true
  git clean -fdq -- .github
}

winner=""
attempts_used=0
for model in "${models[@]}"; do
  reset_tree
  slug="${model//[^A-Za-z0-9._-]/_}"
  mlog="$LOG_DIR/$slug.opencode.jsonl"
  log "=== model opencode/$model"
  status=0
  timeout "$OPENCODE_TIMEOUT" "${oc[@]}" --model "opencode/$model" --title "agent $run_id" "$prompt" >"$mlog" 2>&1 || status=$?
  err="$(oc_error "$mlog")"
  if [[ "$status" -eq 124 ]]; then err="timed out after $OPENCODE_TIMEOUT${err:+; $err}"; fi
  if ! has_changes; then
    if [[ "$NOOP_OK" == "1" && "$status" -eq 0 && -z "$err" ]]; then
      log "model $model finished without changes; treating as 'nothing to do'"
      echo "OpenCode agent run $run_id: model $model found nothing to change." >"$LOG_DIR/summary.md"
      if [[ -n "${GITHUB_OUTPUT:-}" ]]; then echo "result=noop" >>"$GITHUB_OUTPUT"; fi
      exit 0
    fi
    log "model $model produced no changes (exit $status${err:+: $err}); next model"
    continue
  fi
  if [[ -n "$err" || "$status" -ne 0 ]]; then
    log "model $model reported a problem (exit $status${err:+: $err}) but left changes; checking them"
  fi
  session="$(oc_session "$mlog")"

  green=0
  for ((attempt = 1; attempt <= CI_ATTEMPTS; attempt++)); do
    attempts_used="$attempt"
    drop_github_changes
    clog="$LOG_DIR/$slug.ci-$attempt.log"
    log "ci attempt $attempt/$CI_ATTEMPTS for $model"
    if env -u GH_TOKEN -u GITHUB_TOKEN -u ACTIONS_RUNTIME_TOKEN -u ACTIONS_ID_TOKEN_REQUEST_TOKEN -u OPENCODE_API_KEY REPO_ROOT="$repo_root" "$ci_copy" >"$clog" 2>&1; then
      green=1
      break
    fi
    cp "$clog" "$LOG_DIR/last-ci.log"
    log "ci failed (attempt $attempt); tail:"
    tail -n 20 "$clog" >&2
    if [[ "$attempt" -ge "$CI_ATTEMPTS" ]]; then break; fi
    fix_prompt="$(printf 'The CI check (bash .github/scripts/ci.sh) FAILED. Fix the cause, keep the task done, and run it again yourself before finishing. Do not weaken tests or edit .github/. Last 300 lines of the CI log:\n\n%s' "$(tail -n 300 "$clog")")"
    flog="$LOG_DIR/$slug.fix-$attempt.jsonl"
    resume=(--continue)
    if [[ -n "$session" ]]; then resume=(--session "$session"); fi
    status=0
    timeout "$FIX_TIMEOUT" "${oc[@]}" --model "opencode/$model" "${resume[@]}" "$fix_prompt" >"$flog" 2>&1 || status=$?
    err="$(oc_error "$flog")"
    if [[ -n "$err" || "$status" -ne 0 ]]; then
      log "fix pass for $model failed (exit $status${err:+: $err})"
      if [[ -n "$err" ]]; then break; fi # model unavailable/rate limited: next model
    fi
  done

  if [[ "$green" -eq 1 ]]; then
    winner="$model"
    break
  fi
  log "model $model could not get CI green; next model"
done

summary="$LOG_DIR/summary.md"
if [[ -z "$winner" ]]; then
  reset_tree
  {
    echo "OpenCode agent run $run_id failed: no model produced a change that passes CI."
    echo
    echo "Models tried: ${models[*]}"
  } >"$summary"
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then echo "result=failed" >>"$GITHUB_OUTPUT"; fi
  log "no model succeeded"
  exit 1
fi

log "model $winner is green after $attempts_used CI attempt(s)"
drop_github_changes
git_id=(-c "user.name=${GIT_AUTHOR_NAME:-opencode-agent[bot]}" -c "user.email=${GIT_AUTHOR_EMAIL:-41898282+github-actions[bot]@users.noreply.github.com}")
# First sentence of the task, cut at a word boundary: a PR title, not the prompt.
derive_title() {
  local line
  line="$(printf '%s' "$1" | head -n 1 | sed -E 's/[[:space:]]+/ /g; s/^ //')"
  line="${line%%. *}"
  line="${line%.}"
  if (( ${#line} > 72 )); then
    line="${line:0:69}"
    line="${line% *}..."
  fi
  printf '%s' "$line"
}
title="${PR_TITLE:-$(derive_title "$task")}"
if [[ -n "$(git status --porcelain)" ]]; then
  git add -A
  git "${git_id[@]}" commit -q -m "$title" -m "Implemented by OpenCode ($winner), verified by .github/scripts/ci.sh." -m "Agent run: $run_id"
fi
git checkout -q -B "$BRANCH"
changed="$(git diff --stat "$start_sha" HEAD | tail -n 1)"

{
  if [[ -n "${PR_BODY_FILE:-}" && -f "$PR_BODY_FILE" ]]; then cat "$PR_BODY_FILE"; echo; fi
  echo "Automated change by the OpenCode maintainer agent."
  echo
  echo "- Model: \`opencode/$winner\`"
  echo "- CI: \`.github/scripts/ci.sh\` passed locally in the agent run (attempt $attempts_used/$CI_ATTEMPTS)"
  echo "- Diff: $changed"
  if [[ -n "${GITHUB_SERVER_URL:-}" && -n "${GITHUB_REPOSITORY:-}" && -n "${GITHUB_RUN_ID:-}" ]]; then
    echo "- Run: $GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID"
  fi
  if [[ -n "${ISSUE_NUMBER:-}" ]]; then echo; echo "Closes #$ISSUE_NUMBER"; fi
  echo
  echo "<details><summary>Task</summary>"
  echo
  printf '%s\n' "$task" | head -c 20000
  echo
  echo "</details>"
  echo
  echo "Review before merging: this PR was written by an AI model."
} >"$summary"

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  { echo "result=success"; echo "model=$winner"; echo "branch=$BRANCH"; } >>"$GITHUB_OUTPUT"
fi

if [[ "$NO_PUSH" == "1" ]]; then
  log "NO_PUSH=1: leaving commit $(git rev-parse --short HEAD) on local branch $BRANCH"
  exit 0
fi

[[ -n "${GH_TOKEN:-}" && -n "${GITHUB_REPOSITORY:-}" ]] || die "GH_TOKEN and GITHUB_REPOSITORY are required to push"
remote="${PUSH_REMOTE:-https://x-access-token:${GH_TOKEN}@github.com/${GITHUB_REPOSITORY}.git}" # PUSH_REMOTE: tests only
# pr mode: the branch is new. repair mode: only overwrite the branch if it still
# points at the commit we started from.
lease=()
if [[ "$MODE" == "repair" ]]; then lease=("--force-with-lease=refs/heads/$BRANCH:$start_sha"); fi
push() { git push -q "${lease[@]}" "$remote" "HEAD:refs/heads/$BRANCH"; }

if ! push 2>"$LOG_DIR/push.err"; then
  # Typical cause: merged upstream history touches .github/workflows, which a
  # GITHUB_TOKEN may not push. Squash to a single commit without those paths.
  log "push rejected ($(sed "s#${GH_TOKEN}#***#g" "$LOG_DIR/push.err" | tail -n 3)); retrying as one squashed commit"
  git reset -q --soft "$start_sha"
  drop_github_changes
  git "${git_id[@]}" commit -q -m "$title" -m "Implemented by OpenCode ($winner), verified by .github/scripts/ci.sh (squashed)." -m "Agent run: $run_id"
  if [[ "$MODE" == "pr" ]]; then lease=(--force); fi # our own fresh branch from the failed first push
  push
fi
log "pushed $BRANCH"

if [[ "$MODE" == "pr" ]]; then
  pr_url="$(gh pr create --repo "$GITHUB_REPOSITORY" --base "$BASE_BRANCH" --head "$BRANCH" \
    --title "$title" --body-file "$summary")"
  log "opened $pr_url"
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then echo "pr_url=$pr_url" >>"$GITHUB_OUTPUT"; fi
fi
