#!/bin/bash
# Origin: personal vault deploy/deploy-rust-door.sh. Scrubbed modular copy — plug-in points marked PLUG-IN(...)
#
# Deploy the optional Rust "door" (exocortex-rs) — installs the two-probe
# healthcheck (door:8100/_exo/healthz -> restart exocortex-rs; flask:5000 ->
# restart exocortex) and restarts the door onto the newest release binary.
# Only relevant if you run exocortex-rs in front of Flask; skip entirely
# otherwise — Flask alone is a complete app.
#
# PLUG-IN(RENDER_TEMPLATE): deploy/exocortex-healthcheck.service.template has
# <PLACEHOLDER> tokens in it — render it (fill in the placeholders, see
# deploy/README.md) into a real unit file before this script copies it, or
# point EXOCORTEX_HEALTHCHECK_UNIT at an already-rendered copy.
set -euo pipefail

SKELETON="${EXOCORTEX_SKELETON_DIR:-/opt/exocortex/skeleton}"
HEALTHCHECK_UNIT="${EXOCORTEX_HEALTHCHECK_UNIT:-$SKELETON/deploy/exocortex-healthcheck.service}"

sudo cp "$HEALTHCHECK_UNIT" /etc/systemd/system/exocortex-healthcheck.service
sudo systemctl daemon-reload
sudo systemctl restart exocortex-rs
sudo systemctl start exocortex-healthcheck
systemctl status exocortex-healthcheck --no-pager -n 5
curl -s --max-time 5 http://127.0.0.1:8100/_exo/healthz && echo " <- door heartbeat OK"
