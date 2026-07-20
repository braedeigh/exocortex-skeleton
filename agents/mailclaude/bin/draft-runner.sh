#!/bin/bash
# Origin: personal vault mailclaude/bin/draft-runner.sh. Scrubbed modular
# copy — plug-in points marked PLUG-IN(...)
#
# Draft replies for pending inbox records. Runs as `mail`, triggered by
# mail-draft.path whenever data/inbox/ is non-empty.
#
# An inbox file is removed once its draft exists (the draft record carries a
# full copy), so "inbox non-empty" always means "work pending". A record that
# fails to draft moves to data/failed/ so the path unit can't spin on it —
# move it back to inbox/ by hand to retry.
set -u

# PLUG-IN(SRV_DIR): base install directory. Default matches install.sh and the
# systemd units; override with MAILCLAUDE_BASE if you relocate the tree (you
# must also update the systemd units and clerk/.claude/settings.json).
BASE="${MAILCLAUDE_BASE:-/srv/mailclaude}"

exec 9>"$BASE/data/.draft.lock"
flock -n 9 || exit 0

shopt -s nullglob
for f in "$BASE"/data/inbox/*.json; do
    id=$(basename "$f" .json)
    if [[ -e "$BASE/data/drafts/$id.json" || -e "$BASE/data/sent/$id.json" ]]; then
        rm -f "$f"
        continue
    fi
    (
        cd "$BASE/clerk" &&
        claude -p "New message in $BASE/data/inbox/$id.json — read it and draft a reply per your CLAUDE.md."
    )
    if [[ -e "$BASE/data/drafts/$id.json" ]]; then
        rm -f "$f"
    else
        mkdir -p "$BASE/data/failed"
        mv "$f" "$BASE/data/failed/$id.json"
        echo "no draft produced for $id; moved to data/failed/" >&2
    fi
done
