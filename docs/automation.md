# Automation (AI-maintained fork)

This repository (`jr551/omp-web`) is an AI-maintained fork of
[`ddallabenetta/omp-web`](https://github.com/ddallabenetta/omp-web). GitHub
Actions keeps dependencies current, cuts releases, and runs an autonomous
maintainer built on [OpenCode](https://opencode.ai) with free OpenCode Zen
models. Every code change made by a model arrives as a pull request; nothing
an agent writes is pushed to `main`.

## "Tests pass" means `.github/scripts/ci.sh`

One script defines green for every workflow and for the agent:

1. `bun install --frozen-lockfile`
2. `bun run typecheck`
3. `bun run lint` — fatal (set `LINT_STRICT=0` to only report).
4. `bun test`
5. `bun run build`

Knobs: `SKIP_INSTALL=1`, `SKIP_BUILD=1`, `LINT_STRICT=0`, `REPO_ROOT=<dir>`.
The build writes `.next/`; do not run the script in a checkout where
`bun run dev` is running (see AGENTS.md).

## Workflows

| Workflow | Trigger | What it does |
|---|---|---|
| `ci.yml` | PRs, pushes to `main`, `workflow_dispatch` | Runs `ci.sh`. The dispatch trigger exists because branches pushed by `GITHUB_TOKEN` do not trigger `pull_request`; the automation dispatches CI on bot branches instead. |
| `update-omp.yml` | daily 05:17 UTC, dispatch, PR closed | Checks the latest stable `can1357/oh-my-pi` release. If it is newer and on npm, bumps all `@oh-my-pi/*` to `~X.Y.Z`, bumps the version (patch, or minor on an omp major), runs `ci.sh`, opens `automation/omp-X.Y.Z` (a draft if CI failed). **If CI failed it dispatches `opencode-agent.yml` to repair that branch in place.** Merging the PR creates tag + GitHub Release with the installable tarball and dispatches the Docker build. |
| `weekly-release.yml` | Monday 06:00 UTC, dispatch, PR closed | `upgrade-deps.sh`: `bun update --latest` for everything, all `@oh-my-pi/*` forced to one `~<latest>` range, lockfile refreshed, version bumped (patch; minor on an omp major). Then `ci.sh`. **Green:** commit to `main`, tag `vX.Y.Z`, GitHub Release listing the upgraded packages plus generated notes, tarball attached, Docker build dispatched — all inside the same run. **Red:** the OpenCode repair loop runs on `automation/weekly-<date>-<run>`; if it gets CI green a PR is opened, and merging it runs `ci.sh` on the merge commit before releasing. If the repair fails, an issue labeled `automation-failure` is opened (or refreshed) with the CI log tail. Nothing changed → no release. |
| `opencode-agent.yml` | dispatch (`task`, optional `branch`/`pr`/`models`), issue labeled `opencode`, Wednesday 04:00 UTC sweep | The autonomous maintainer (below). |
| `docker.yml` | release published, dispatch (`tag`) | Builds the `Dockerfile` and pushes `ghcr.io/<owner>/omp-web:<version>` and `:latest` (amd64). |
| `publish-npm.yml` | tag push, dispatch | Upstream-only: skipped unless the repository is `ddallabenetta/omp-web` or the repo variable `NPM_PUBLISH=true` is set (the fork cannot publish the `omp-web` name). |
| `publish-desktop.yml` | tag push, dispatch (both release workflows dispatch it) | macOS universal app + Windows NSIS installer, signed for the in-app updater (`latest.json`). Skipped unless the `TAURI_SIGNING_PRIVATE_KEY` secret exists (it is set on this fork). |

### Releases without npm

The fork cannot publish `omp-web` to npm, so each release carries the package
(`.github/scripts/release-assets.sh`): `omp-web-X.Y.Z.tgz` and a stable
`omp-web.tgz`. Install with:

```bash
bun add -g https://github.com/jr551/omp-web/releases/latest/download/omp-web.tgz
```

### Why workflows dispatch each other

Pushes, tags, PRs and releases created with `GITHUB_TOKEN` do not trigger other
workflows (GitHub's loop protection). `workflow_dispatch` via `gh workflow run`
*is* allowed with `GITHUB_TOKEN`, so the automation dispatches `ci.yml`,
`opencode-agent.yml`, `docker.yml` and the publish workflows explicitly, and the
weekly release does its tagging and release creation in the same run.

## The OpenCode agent

`.github/scripts/opencode-agent.sh`, driven by `opencode-agent.yml`:

```
for MODEL in $(select-models.sh):
  reset the tree to the starting commit (git reset --hard; git clean -fd — ignored files kept)
  timeout 30m opencode run --model opencode/$MODEL "<task + rules>"
  model errored and changed nothing (rate limit, unavailable, not found) -> next model
  up to 3 x ci.sh; after a failure, `tail -n 300` of the log goes back into the same
    OpenCode session (--session <id>) for a fix pass
  green -> commit, push branch opencode/agent-<run_id>, gh pr create against main
```

`opencode run` exits 0 even when the model call fails, so the script runs it
with `--format json` and treats `{"type":"error"}` events as failures.

### Triggering it

- **Label an issue `opencode`.** The title and body become the task; the PR
  says `Closes #N` and the issue gets a comment with the PR link (or with the CI
  log tail if every model failed). Only collaborators with triage access can add
  labels — that is the gate against prompt injection via issue text.
- **Actions → OpenCode agent → Run workflow** with a `task`. Give `branch` (and
  `pr`) to repair an existing branch in place instead of opening a new PR.
- **Weekly sweep** (Wednesday): the workflow gathers open issues/PRs of this fork
  *and* of upstream (read-only `gh issue/pr list -R ddallabenetta/omp-web`) and
  `git log HEAD..upstream/main`, and asks the model to merge worthwhile upstream
  commits and then implement the single most valuable unaddressed item. A model
  that deliberately changes nothing ends the run as a no-op.

### Model selection (`.github/scripts/select-models.sh`)

Prints `score<TAB>id<TAB>name`, best first. Sources:

- `https://opencode.ai/zen/v1/models` — `{"object":"list","data":[{"id","object","created","owned_by"}]}`.
  No names or prices, so "free" means the id contains `free`.
- `opencode models opencode --verbose` — the CLI catalog, with names and
  `cost.input`/`cost.output`; zero cost also counts as free (e.g. `big-pickle`).
  The CLI can only run models in its catalog, so those get `+100` (`CLI_BONUS`).
  The API lists some free ids the CLI does not know (they fail with
  "Model not found"); the loop falls through them.

Scoring: `bunny` 1000; unknown codenames (id outside
`gpt|claude|gemini|deepseek|qwen|mimo|nemotron|minimax|glm|kimi|muse|grok|llama|mistral`)
800; deepseek 500; nemotron ultra 450; nemotron 400; mimo 350; minimax 300;
qwen 250; other known families 200; `+50` for `code`/`coder`.
`MODEL_BLOCKLIST` (extended regex, default `pickle`) removes models; if the API
and CLI both fail a static list is used. Override the whole list per run with the
`models` dispatch input or `MODELS=...`.

### Secret and settings

- **`OPENCODE_API_KEY`** (repository secret) — the OpenCode Zen key; OpenCode
  reads it from the environment. Free models are used, but the key identifies the
  client.
- **Settings → Actions → General → Workflow permissions:** "Read and write
  permissions" and **"Allow GitHub Actions to create and approve pull
  requests"** (required for `gh pr create` with `GITHUB_TOKEN`).
- The weekly release pushes a commit and tag to `main` with `GITHUB_TOKEN`. If
  `main` is protected, allow GitHub Actions to bypass, or the green path fails
  (the red path uses PRs and is unaffected).
- Labels `opencode` and `automation-failure` (the latter is created on demand).

OpenCode's non-interactive permissions come from `.github/opencode/opencode.json`
(passed as `OPENCODE_CONFIG_CONTENT`, so nothing is added to the repo root), plus
`--auto` when the installed CLI supports it.

## Safety rules

- **No direct pushes to `main` by an agent.** The script refuses to push to the
  base branch; agent work lands on `opencode/agent-<run_id>` (or the bot branch it
  was asked to repair, with `--force-with-lease` against the starting commit).
- **The model never holds GitHub credentials.** Checkouts use
  `persist-credentials: false`; `GH_TOKEN`/`GITHUB_TOKEN`/Actions runtime tokens
  are stripped from every `opencode` process; the harness pushes and opens PRs.
- **The judge is frozen.** The agent runs a copy of `ci.sh` taken before the model
  started, and every change under `.github/` is discarded before commit
  (`GITHUB_TOKEN` cannot push workflow changes anyway).
- **Upstream is read-only.** Only `gh issue list` / `gh pr list` / `git fetch`
  against `ddallabenetta/omp-web`; nothing is ever posted there.
- **Humans merge.** Every agent PR is reviewed and merged by a person; the PR
  body names the model and the run.
- Secrets are never printed; the prompt tells the model not to either. Agent logs
  are uploaded as a 7-day artifact.

## Running locally

```bash
export OPENCODE_API_KEY=...                 # never commit it
.github/scripts/select-models.sh
# in a throwaway clone, never your working checkout:
NO_PUSH=1 CI_SCRIPT=/path/to/stub.sh MODELS="space-bunny-free" \
  .github/scripts/opencode-agent.sh "Create hello.txt containing hi"
```
