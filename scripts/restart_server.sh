#!/bin/bash
# Origin: personal vault scripts/restart_server.sh. Scrubbed modular copy — plug-in points marked PLUG-IN(...)
systemctl restart exocortex.service
sleep 2
systemctl status exocortex.service
journalctl -u exocortex.service --no-pager -n 20
