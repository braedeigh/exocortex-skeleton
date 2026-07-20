#!/bin/bash
# Origin: personal vault scripts/cricket_swarm.sh. Scrubbed modular copy — plug-in points marked PLUG-IN(...)
#
# cricket_swarm.sh — run the cricket swarm.
#
# A roster of one-job crickets (agents/crickets/), each of which reads the day that
# just ended and files its one kind of thing. This is the shared runner: it owns the
# overlapping mechanics (target-date math, spawning each cricket the same way, logging)
# so an individual cricket is just a small prompt file + a roster line.
#
#   cricket_swarm.sh                 -> run all `on` crickets for yesterday
#   cricket_swarm.sh 2026-07-03      -> ... for an explicit target date
#   cricket_swarm.sh 2026-07-03 todos-> run ONE cricket by id (ignores on/off; for testing)
#   CRICKET_DRY_RUN=1 cricket_swarm.sh -> print what would run, spawn nothing
#
# WHY yesterday: if your capture hook keys journal files by calendar date the way this
# repo's stream-cards engine does (see content-scaffold/_system/STREAM.md), a day seals
# at midnight. Running after midnight (2 AM) means yesterday is frozen and complete. We
# compute that date here with `date` (exact across month/year), never in the model.
#
# PLUG-IN(CRICKETS_DIR): the prompt files (roster, _base.md, each cricket) live in THIS
# repo (SKELETON), not the vault — that's what makes them a shareable, versioned module
# distinct from the vault's private content. The swarm still spawns each cricket with
# its working directory in the VAULT, so the relative paths inside those prompt files
# (`tulku/Journal/Daily/...`, `data/pending_changes.json`) resolve against your data.

set -u

VAULT="${EXOCORTEX_VAULT_DIR:-/opt/exocortex/vault}"
SKELETON="${EXOCORTEX_SKELETON_DIR:-/opt/exocortex/skeleton}"
CLAUDE_BIN="${CLAUDE_BIN:-$HOME/.local/bin/claude}"
OWNER_NAME="${EXOCORTEX_OWNER_NAME:-the owner}"

CRICKETS="$SKELETON/agents/crickets"
ROSTER="$CRICKETS/roster"
LOG="$VAULT/scripts/cricket_swarm.log"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"; }

TARGET="${1:-$(date -d yesterday +%Y-%m-%d)}"
ONLY="${2:-}"   # optional single cricket id (test mode: runs even if roster says off)

if ! [[ "$TARGET" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
  echo "bad target date '$TARGET' (want YYYY-MM-DD)" >&2
  exit 2
fi

cd "$VAULT" || { log "ERROR: cannot cd to $VAULT"; exit 1; }

# Build the list of cricket ids to run.
IDS=()
if [ -n "$ONLY" ]; then
  IDS=("$ONLY")
else
  # Parse the plain-text roster (no jq): skip blank/comment lines, take `on` rows.
  while read -r id model state _rest; do
    [[ -z "$id" || "$id" == \#* ]] && continue
    [[ "$state" == "on" ]] && IDS+=("$id:$model")
  done < "$ROSTER"
fi

if [ "${#IDS[@]}" -eq 0 ]; then
  log "no crickets to run (target=$TARGET, only='$ONLY')"
  echo "no crickets to run" >&2
  exit 0
fi

log "=== swarm start (target=$TARGET) — ${#IDS[@]} cricket(s) ==="

run_one() {
  local id="$1" model="$2"
  local file="$CRICKETS/${id}.md"
  if [ ! -f "$file" ]; then
    log "cricket:$id SKIP — no prompt file ($file)"
    return
  fi
  local prompt="You are one cricket in ${OWNER_NAME}'s swarm. Read ${CRICKETS}/_base.md and ${file}, then do your one job for the target date ${TARGET}, operating in the vault at ${VAULT}. Read only what those files and your job require."
  if [ "${CRICKET_DRY_RUN:-0}" = "1" ]; then
    echo "[dry-run] cricket:$id  model=$model  target=$TARGET"
    return
  fi
  log "--- cricket:$id (model=$model) start ---"
  local out st
  out="$("$CLAUDE_BIN" -p "$prompt" --model "$model" --dangerously-skip-permissions 2>&1)"
  st=$?
  echo "$out" >> "$LOG"
  log "--- cricket:$id done (exit=$st) ---"
}

# Sequential on purpose: crickets can append to the same pending_changes.json, and the
# writers aren't cross-process locked, so we avoid a read-modify-write race. (Parallel
# is a later optimization once staging goes through a locked writer.)
for entry in "${IDS[@]}"; do
  id="${entry%%:*}"
  model="${entry#*:}"
  [ -n "$ONLY" ] && model="${model:-sonnet}"
  # If ONLY was given without a model, look it up from the roster (default sonnet).
  if [ -n "$ONLY" ]; then
    model="$(awk -v i="$id" '$1==i {print $2; exit}' "$ROSTER")"
    model="${model:-sonnet}"
  fi
  run_one "$id" "$model"
done

log "=== swarm end (target=$TARGET) ==="
