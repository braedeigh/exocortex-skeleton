#!/bin/bash
# Origin: personal vault scripts/restart_server.sh. Scrubbed modular copy — plug-in points marked PLUG-IN(...)
#
# Deploys a Python edit without killing anyone's work.
#
# TWO WAYS A DEPLOY DESTROYS A RUNNING AGENT, and this guards both.
#
#   `restart` empties the service's cgroup, which is where every `claude -p`
#   lives (each is spawned as a child of a gunicorn worker). The agent dies and
#   the transcript records "claude exited 143". 59 turns died this way.
#
#   `reload` is gentler on the agent — it survives — but the RELAY THREAD that
#   writes down what the agent says lives inside the gunicorn worker being
#   drained. So the agent keeps working and talking into a room where nobody is
#   taking notes: the conversation stops mid-sentence, with no error anywhere,
#   because the thing whose job was to report the error is the thing that died.
#   15 of 23 silent turn deaths in one measured week were reloads.
#
# So reload is the DEFAULT (it is right for a Python edit and spares the agent
# processes), and neither mode runs while a turn is live. Guarding is the whole
# point of this file: the "use reload, not restart" rule was written down on
# 2026-08-03 and ignored for eight days, because instructions do not stop a
# tired agent at 2 AM and a non-zero exit code does.
#
#   ./scripts/restart_server.sh              reload, refusing if work is live
#   ./scripts/restart_server.sh --force      reload anyway (you will kill turns)
#   ./scripts/restart_server.sh --restart    full restart; also waits for detached jobs
#
# The real fix is hosting agents in their own systemd service so no deploy can
# reach them; this is the seatbelt until that lands.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="$HERE/venv/bin/python3"
MODE=reload
FORCE=0

for arg in "$@"; do
  case "$arg" in
    --restart) MODE=restart ;;
    --force)   FORCE=1 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

# Refuse while work is live. A reload only reaches turns; a restart also kills
# detached jobs (scripts/run_detached.py), so it counts those too. Exit 2 from
# the check means it couldn't find the turn index, and that refuses as well.
if [ "$FORCE" -eq 0 ]; then
  CHECK=(--turns-only)
  [ "$MODE" = restart ] && CHECK=()
  if ! "$PY" "$HERE/scripts/live_turns.py" "${CHECK[@]}"; then
    cat >&2 <<'MSG'

REFUSING TO DEPLOY — the work listed above is running right now (or the check
couldn't tell, which counts the same).

A reload kills turns' relay threads: the agents keep working but nothing writes
their output down, so those conversations stop mid-sentence with no error and
no way for their owner to tell what happened. A restart also kills every
detached job outright.

  - wait for them to finish (re-run this; it clears itself), or
  - --force if you accept killing them.
MSG
    exit 1
  fi
fi

if [ "$MODE" = restart ]; then
  echo "!! full restart: SIGTERMs every agent process in the service cgroup"
fi

sudo systemctl "$MODE" exocortex.service
sleep 2
systemctl status exocortex.service --no-pager | head -12
