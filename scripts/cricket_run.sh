#!/bin/bash
# Origin: personal vault scripts/cricket_run.sh. Scrubbed modular copy — plug-in points marked PLUG-IN(...)
#
# ============================================================================
# DEPRECATED — historical reference only, not wired into any cron in this repo.
#
# This was the original single-agent nightly runner, superseded by the swarm
# (cricket_swarm.sh, many small crickets) plus the separate weekly close
# (cricket_housekeep.sh). It's kept here so the lineage is legible — the swarm's
# design (target-date math, 2 AM / "yesterday" logic, staged-vs-direct writes)
# grew directly out of this monolith once its single prompt got too big for one
# job.
#
# It is NOT fully functional as migrated: the prompt file it invokes
# (prompts/cricket.md, the "legacy monolith") was deliberately left in the vault
# and not copied into this repo — see docs/scrub-log/B-crickets.md for why. If
# you want to run this for real, either resurrect an equivalent prompt file of
# your own and point PROMPT_FILE at it, or — better — use the swarm instead;
# every job this script did now has a small, focused cricket under
# agents/crickets/.
# ============================================================================
#
# cricket_run.sh — nightly headless run of Cricket, the vault housekeeper.
#
# Cricket reads the day that just ended and files it away: extracts food / sleep /
# symptoms / exercise into tulku/habits.csv, stages the judgment calls, and on the
# Monday run (target day = Sunday) does the full end-of-week close (weekly summary,
# people files, about.md). Its full spec lived at prompts/cricket.md (not migrated).
#
# WHY 2 AM + "yesterday": if your capture hook keys journal files by calendar date,
# a day seals at midnight. Running at 2 AM means the day being digested — *yesterday*
# — is already frozen and complete. We compute that date HERE with `date`, which is
# exact across month/year boundaries, and hand it to Cricket, rather than letting
# the model guess "today" (it can't reliably do date math, and at 2 AM the clock
# already reads tomorrow).
#
#   cricket_run.sh              -> target = yesterday   (normal cron use)
#   cricket_run.sh 2026-07-04   -> target = explicit    (backfill / testing)
#   CRICKET_DRY_RUN=1 cricket_run.sh 2026-07-04  -> print what would run, do nothing

set -u

VAULT="${EXOCORTEX_VAULT_DIR:-/opt/exocortex/vault}"
CLAUDE_BIN="${CLAUDE_BIN:-$HOME/.local/bin/claude}"
# PLUG-IN(LEGACY_PROMPT): prompts/cricket.md was not migrated (see scrub log) — this
# path won't exist unless you supply your own equivalent.
PROMPT_FILE="${CRICKET_LEGACY_PROMPT:-prompts/cricket.md}"

LOG="$VAULT/scripts/cricket_run.log"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"; }

# Target day: an explicit arg wins; otherwise yesterday (we run after midnight).
TARGET="${1:-$(date -d yesterday +%Y-%m-%d)}"

if ! [[ "$TARGET" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
  log "ERROR: bad target date '$TARGET' (want YYYY-MM-DD)"
  echo "bad target date '$TARGET' (want YYYY-MM-DD)" >&2
  exit 2
fi

PROMPT="Read ${PROMPT_FILE} and follow its instructions for the date $TARGET."

if [ "${CRICKET_DRY_RUN:-0}" = "1" ]; then
  echo "[dry-run] cd $VAULT"
  echo "[dry-run] $CLAUDE_BIN -p \"$PROMPT\" --dangerously-skip-permissions"
  exit 0
fi

cd "$VAULT" || { log "ERROR: cannot cd to $VAULT"; exit 1; }

log "=== cricket run start (target=$TARGET) ==="
OUT="$("$CLAUDE_BIN" -p "$PROMPT" --dangerously-skip-permissions 2>&1)"
STATUS=$?
# Keep Cricket's final report in the log so there's a trail of what it touched.
echo "$OUT" >> "$LOG"
log "=== cricket run end (exit=$STATUS) ==="
exit $STATUS
