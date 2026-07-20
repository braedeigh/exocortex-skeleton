#!/usr/bin/env bash
# Origin: personal vault scripts/link_commands.sh. Scrubbed modular copy — plug-in points marked PLUG-IN(...)
#
# Link Claude Code's slash-command files to the versioned copies in this repo.
#
# Why: ~/.claude/commands/<cmd>.md is what Claude Code actually loads, but the
# real, git-backed-up copy lives in this repo at claude-commands/<cmd>.md. If
# they're two separate files they drift — edit one, the other goes stale, and
# the backup can capture the wrong version. Symlinking makes them ONE file:
# editing either path edits the same backed-up bytes, so they can't disagree.
#
# Idempotent — safe to re-run. Run as the user who owns ~/.claude (NOT root).
#   bash scripts/link_commands.sh
set -euo pipefail

# This repo's command dir = ../claude-commands relative to this script.
REPO_CMDS="$(cd "$(dirname "${BASH_SOURCE[0]}")/../claude-commands" && pwd)"
DEST="$HOME/.claude/commands"
mkdir -p "$DEST"

# PLUG-IN(COMMAND_LIST): links whatever *.md files exist in claude-commands/ —
# add a new slash-command file there and it's picked up automatically, no
# edit needed here.
shopt -s nullglob
for src in "$REPO_CMDS"/*.md; do
  f="$(basename "$src" .md)"
  dst="$DEST/$f.md"

  # Already the right symlink? Leave it.
  if [ -L "$dst" ] && [ "$(readlink -f "$dst")" = "$(readlink -f "$src")" ]; then
    echo "$f: already linked"; continue
  fi

  # A real file that differs from the repo copy? Back it up, don't clobber.
  if [ -e "$dst" ] && [ ! -L "$dst" ] && ! diff -q "$dst" "$src" >/dev/null 2>&1; then
    cp -a "$dst" "$dst.bak"
    echo "$f: backed up differing real file -> $dst.bak"
  fi

  ln -sfn "$src" "$dst"
  echo "$f: linked"
done
shopt -u nullglob

if [ -z "$(ls -A "$REPO_CMDS"/*.md 2>/dev/null)" ]; then
  echo "No *.md commands found in $REPO_CMDS — nothing to link."
fi
