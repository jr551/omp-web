#!/usr/bin/env bash
# Rank the free OpenCode Zen models for the autonomous maintainer.
#
# Output (stdout): one line per candidate, best first:  score<TAB>id<TAB>name
# `id` is the bare Zen model id; run it as `opencode run --model opencode/<id>`.
# Diagnostics go to stderr, so `cut -f2` of stdout is a clean model list.
#
# Sources (both are consulted because they disagree in practice):
#   1. https://opencode.ai/zen/v1/models  - OpenAI-style {"object":"list","data":[{"id",...}]}.
#      Carries no pricing or names, so "free" is inferred from the id ("-free").
#   2. `opencode models opencode --verbose` - the CLI catalog (from models.dev) with
#      names and cost. A model with cost.input == cost.output == 0 counts as free even
#      without "free" in its id (e.g. big-pickle). The CLI can only run models in its
#      catalog; API-only ids fail with "Model not found", so CLI-confirmed models get
#      a bonus. The runtime loop still tries every candidate and falls through.
#
# Environment:
#   MODEL_BLOCKLIST   extended regex (case-insensitive) matched against id and name;
#                     default 'pickle'. Set to '' to disable.
#   ZEN_MODELS_URL    default https://opencode.ai/zen/v1/models
#   OPENCODE_BIN      default: `opencode` on PATH, else $HOME/.opencode/bin/opencode
#   CLI_BONUS         score bonus for models present in the CLI catalog (default 100)
#   SKIP_CLI=1        do not consult the CLI
#   FALLBACK_MODELS   space-separated ids used when neither source yields anything
set -euo pipefail

MODEL_BLOCKLIST="${MODEL_BLOCKLIST-pickle}"
ZEN_MODELS_URL="${ZEN_MODELS_URL:-https://opencode.ai/zen/v1/models}"
CLI_BONUS="${CLI_BONUS:-100}"
SKIP_CLI="${SKIP_CLI:-0}"
FALLBACK_MODELS="${FALLBACK_MODELS:-space-bunny-free nemotron-3-ultra-free mimo-v2.6-flash-free ling-3.0-flash-fin-free muse-spark-1.3-contributor-free nemotron-3.5-lightning-free}"
KNOWN_FAMILIES='gpt|claude|gemini|deepseek|qwen|mimo|nemotron|minimax|glm|kimi|muse|grok|llama|mistral'

log() { echo "select-models: $*" >&2; }

if ! command -v jq >/dev/null 2>&1; then
  log "jq not found; emitting static fallback list"
  score=100
  read -r -a fallback <<<"$FALLBACK_MODELS"
  for id in "${fallback[@]}"; do
    printf '%s\t%s\t%s\n' "$score" "$id" "$id"
    score=$((score - 1))
  done
  exit 0
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# --- source 1: Zen API ------------------------------------------------------
api_ok=0
if curl -fsS --max-time 20 --retry 2 "$ZEN_MODELS_URL" -o "$tmp/api.json" 2>"$tmp/api.err" \
  && jq -e '.data | type == "array"' "$tmp/api.json" >/dev/null 2>&1; then
  jq -r '.data[].id // empty' "$tmp/api.json" | sort -u >"$tmp/api_ids"
  api_ok=1
  log "API: $(wc -l <"$tmp/api_ids") models"
else
  log "API unavailable ($(head -c 200 "$tmp/api.err" 2>/dev/null || true))"
  : >"$tmp/api_ids"
fi

# --- source 2: OpenCode CLI catalog ------------------------------------------
cli_ok=0
: >"$tmp/cli_ids"
: >"$tmp/cli_free"
: >"$tmp/cli_names"
opencode_bin="${OPENCODE_BIN:-}"
if [[ -z "$opencode_bin" ]]; then
  if command -v opencode >/dev/null 2>&1; then
    opencode_bin="$(command -v opencode)"
  elif [[ -x "$HOME/.opencode/bin/opencode" ]]; then
    opencode_bin="$HOME/.opencode/bin/opencode"
  fi
fi
if [[ "$SKIP_CLI" != "1" && -n "$opencode_bin" ]]; then
  if timeout 60 "$opencode_bin" models opencode --verbose >"$tmp/cli.txt" 2>"$tmp/cli.err"; then
    # The verbose format is "opencode/<id>" lines, each followed by a JSON object.
    # Dropping the header lines leaves a valid JSON stream.
    if grep -v '^opencode/' "$tmp/cli.txt" \
      | jq -r '[.id, ((.cost.input // 1) == 0 and (.cost.output // 1) == 0 | tostring), (.name // .id)] | @tsv' \
        >"$tmp/cli.tsv" 2>/dev/null; then
      cut -f1 "$tmp/cli.tsv" | sort -u >"$tmp/cli_ids"
      awk -F'\t' '$2 == "true" { print $1 }' "$tmp/cli.tsv" | sort -u >"$tmp/cli_free"
      awk -F'\t' '{ print $1 "\t" $3 }' "$tmp/cli.tsv" >"$tmp/cli_names"
      if [[ -s "$tmp/cli_ids" ]]; then
        cli_ok=1
        log "CLI: $(wc -l <"$tmp/cli_ids") models, $(wc -l <"$tmp/cli_free") at zero cost"
      fi
    fi
  fi
  if [[ "$cli_ok" != "1" ]]; then
    log "CLI catalog unavailable ($(head -c 200 "$tmp/cli.err" 2>/dev/null || true))"
  fi
fi

# --- candidates -------------------------------------------------------------
{
  # `|| true`: grep exits 1 when nothing matches, which is not an error here.
  grep -i 'free' "$tmp/api_ids" || true
  grep -i 'free' "$tmp/cli_ids" || true
  cat "$tmp/cli_free"
} | sort -u >"$tmp/candidates"

if [[ ! -s "$tmp/candidates" ]]; then
  log "no free models discovered (api_ok=$api_ok cli_ok=$cli_ok); using static fallback list"
  read -r -a fallback <<<"$FALLBACK_MODELS"
  printf '%s\n' "${fallback[@]}" >"$tmp/candidates"
fi

# --- scoring ----------------------------------------------------------------
score_model() {
  local id="$1" name="$2" lc score
  lc="$(printf '%s %s' "$id" "$name" | tr '[:upper:]' '[:lower:]')"
  if [[ "$lc" == *bunny* ]]; then
    score=1000
  elif ! [[ "$id" =~ ($KNOWN_FAMILIES) ]]; then
    # Unknown codename: usually a stealth preview of a frontier model.
    score=800
  elif [[ "$lc" == *deepseek* ]]; then
    score=500
  elif [[ "$lc" == *nemotron* && "$lc" == *ultra* ]]; then
    score=450
  elif [[ "$lc" == *nemotron* ]]; then
    score=400
  elif [[ "$lc" == *mimo* ]]; then
    score=350
  elif [[ "$lc" == *minimax* ]]; then
    score=300
  elif [[ "$lc" == *qwen* ]]; then
    score=250
  else
    score=200
  fi
  if [[ "$lc" == *code* ]]; then
    score=$((score + 50))
  fi
  if [[ "$cli_ok" == "1" ]] && grep -qxF "$id" "$tmp/cli_ids"; then
    score=$((score + CLI_BONUS))
  fi
  printf '%s' "$score"
}

: >"$tmp/scored"
while IFS= read -r id; do
  if [[ -z "$id" ]]; then continue; fi
  name="$(awk -F'\t' -v id="$id" '$1 == id { print $2; exit }' "$tmp/cli_names")"
  if [[ -z "$name" ]]; then name="$id"; fi
  if [[ -n "$MODEL_BLOCKLIST" ]] && printf '%s\n%s\n' "$id" "$name" | grep -qiE -- "$MODEL_BLOCKLIST"; then
    log "blocklisted: $id"
    continue
  fi
  printf '%s\t%s\t%s\n' "$(score_model "$id" "$name")" "$id" "$name" >>"$tmp/scored"
done <"$tmp/candidates"

if [[ ! -s "$tmp/scored" ]]; then
  log "every candidate was blocklisted; nothing to select"
  exit 1
fi

sort -t$'\t' -k1,1nr -k2,2 "$tmp/scored"
