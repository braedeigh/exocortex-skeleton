#!/bin/bash
# Origin: personal vault scripts/keeper_rollover.sh. Scrubbed modular copy — plug-in points marked PLUG-IN(...)
#
# keeper_rollover.sh — automatic nightly Keeper journal-session rollover.
#
# Injects slash commands into the Keeper's tmux pane exactly as if you'd
# typed them, so the journaling day closes and reopens on its own overnight.
#
#   close  -> sends /endsession   (writes the diary entry, updates threads)
#   open   -> sends /clear then /journalstart  (fresh keeper incarnation, new day)
#
# Driven by cron (see deploy/crontab.template.txt): close at 3:00, open at 3:10.

set -u

TMUX_BIN="${TMUX_BIN:-/usr/bin/tmux}"
# PLUG-IN(TMUX_SOCKET): must match the socket exocortex-tmux.service (or
# whatever owns your tmux server) creates.
TMUX_SOCK="${EXOCORTEX_TMUX_SOCKET:-/tmp/exocortex-tmux/default}"
SESSION="${KEEPER_TMUX_SESSION:-chat}"
VAULT="${EXOCORTEX_VAULT_DIR:-/opt/exocortex/vault}"
LOG="${KEEPER_ROLLOVER_LOG:-$VAULT/scripts/keeper_rollover.log}"
mkdir -p "$(dirname "$LOG")" 2>/dev/null || true

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') [$SESSION] $*" >> "$LOG"; }

tm() { "$TMUX_BIN" -S "$TMUX_SOCK" "$@"; }

# Type a line into the pane and submit it (text, pause, Enter — the TUI needs a
# beat between the text landing and the Enter to register it as a submit).
send_cmd() {
  local text="$1"
  tm send-keys -t "$SESSION" -l "$text"
  sleep 0.5
  tm send-keys -t "$SESSION" Enter
  log "sent: $text"
}

if ! tm has-session -t "$SESSION" 2>/dev/null; then
  log "ERROR: tmux session '$SESSION' not found — nothing sent"
  exit 1
fi

case "${1:-}" in
  close)
    send_cmd "/endsession"
    ;;
  open)
    send_cmd "/clear"
    sleep 3          # /clear is near-instant; give the TUI a moment to reset
    send_cmd "/journalstart"
    ;;
  *)
    echo "usage: $0 {close|open}" >&2
    exit 2
    ;;
esac
