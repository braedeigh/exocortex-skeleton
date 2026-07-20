#!/bin/bash
# Origin: personal vault mailclaude/bin/session.sh. Scrubbed modular copy —
# plug-in points marked PLUG-IN(...)
#
# SSH landing for group members (sshd ForceCommand for the `mail` user):
# straight into the clerk, no shell. When claude exits, the connection closes.

# PLUG-IN(SRV_DIR): base install directory. Default matches install.sh and the
# systemd units; override with MAILCLAUDE_BASE if you relocate the tree (you
# must also update sshd_config's ForceCommand invocation to match).
BASE="${MAILCLAUDE_BASE:-/srv/mailclaude}"

cd "$BASE/clerk" && exec claude
