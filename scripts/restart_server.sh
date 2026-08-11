#!/bin/bash
# Origin: personal vault scripts/restart_server.sh. Scrubbed modular copy — plug-in points marked PLUG-IN(...)
#
# Deploys a Python edit WITHOUT killing other agents' work.
#
# This used to run `systemctl restart`, which SIGTERMs every process in the
# service's cgroup — and agent turns live there, because each `claude -p` is
# spawned as a child of a gunicorn worker. So a routine deploy took down every
# session running on the box. Across the stored transcripts that is 59 turns
# killed by restart against 1 by reload.
#
# Reload SIGHUPs the gunicorn master instead: fresh workers on the new code,
# old ones drained, cgroup untouched.
#
# Pass --restart when the change is to the unit file, an Environment= line, or
# anything else read at master start — reload cannot pick those up.
set -euo pipefail

MODE=reload
if [ "${1:-}" = "--restart" ]; then
  MODE=restart
  echo "!! full restart: this kills every running agent turn on the box"
fi

systemctl "$MODE" exocortex.service
sleep 2
systemctl status exocortex.service
journalctl -u exocortex.service --no-pager -n 20
