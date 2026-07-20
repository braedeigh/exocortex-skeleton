#!/bin/bash
# Origin: personal vault scripts/cricket_housekeep.sh. Scrubbed modular copy — plug-in points marked PLUG-IN(...)
#
# cricket_housekeep.sh — the WEEKLY close. Runs Cricket's housekeeping shift only:
# the end-of-week passes (weekly summary, people files, about.md prune, thread
# archival). NOT the nightly data extraction — that's the swarm (cricket_swarm.sh).
#
# WHY Monday, target=Sunday: the weekly summary covers Monday→Sunday, so it can only
# be written once the whole week (Sunday included) has sealed at midnight. We run
# Monday after midnight and hand Cricket the Sunday that just ended. `date` computes
# it exactly across month/year; the model never guesses the date.
#
#   cricket_housekeep.sh              -> target = yesterday (Sunday, on the Monday cron)
#   cricket_housekeep.sh 2026-07-05   -> target = explicit Sunday (backfill / testing)
#   CRICKET_DRY_RUN=1 cricket_housekeep.sh 2026-07-05 -> print what would run, do nothing
#
# PLUG-IN(HOUSEKEEP_PROMPT): points at agents/crickets/housekeep.md in THIS repo
# (SKELETON) — the prompt files are a versioned module here, not vault content. See
# that file's own PLUG-IN note: it assumes a tulku/SUNDAY.md protocol file and the
# thread/people CLIs, which are extensions on top of the base content-scaffold.

set -u

VAULT="${EXOCORTEX_VAULT_DIR:-/opt/exocortex/vault}"
SKELETON="${EXOCORTEX_SKELETON_DIR:-/opt/exocortex/skeleton}"
CLAUDE_BIN="${CLAUDE_BIN:-$HOME/.local/bin/claude}"

LOG="$VAULT/scripts/cricket_housekeep.log"
HOUSEKEEP_PROMPT="$SKELETON/agents/crickets/housekeep.md"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"; }

# Target day: an explicit arg wins; otherwise yesterday (Monday run -> Sunday).
TARGET="${1:-$(date -d yesterday +%Y-%m-%d)}"

if ! [[ "$TARGET" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
  log "ERROR: bad target date '$TARGET' (want YYYY-MM-DD)"
  echo "bad target date '$TARGET' (want YYYY-MM-DD)" >&2
  exit 2
fi

PROMPT="Read ${HOUSEKEEP_PROMPT} and do the weekly close for the week ending on the target Sunday $TARGET, operating in the vault at ${VAULT}."

if [ "${CRICKET_DRY_RUN:-0}" = "1" ]; then
  echo "[dry-run] cd $VAULT"
  echo "[dry-run] $CLAUDE_BIN -p \"$PROMPT\" --dangerously-skip-permissions"
  exit 0
fi

cd "$VAULT" || { log "ERROR: cannot cd to $VAULT"; exit 1; }

log "=== housekeep start (target Sunday=$TARGET) ==="
OUT="$("$CLAUDE_BIN" -p "$PROMPT" --dangerously-skip-permissions 2>&1)"
STATUS=$?
echo "$OUT" >> "$LOG"
log "=== housekeep end (exit=$STATUS) ==="
exit $STATUS
