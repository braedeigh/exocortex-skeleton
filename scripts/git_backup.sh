#!/bin/bash
# Origin: personal vault scripts/git_backup.sh. Scrubbed modular copy — plug-in points marked PLUG-IN(...)
#
# Auto-backup — commit + push repos to GitHub. Runs via cron (see
# deploy/crontab.template.txt). A backup failure must be LOUD: it drops a
# flag file at the vault root (visible in every Claude session and in `git
# status`) instead of only a log line — don't let a silent `git add -A`
# failure roll on to "nothing to commit".

set -u

# --- config (env-overridable) ------------------------------------------------
VAULT="${EXOCORTEX_VAULT_DIR:-/opt/exocortex/vault}"
SKELETON="${EXOCORTEX_SKELETON_DIR:-/opt/exocortex/skeleton}"
# PLUG-IN(RS_DIR): optional Rust strangler-proxy repo (exocortex-rs); leave
# unset if you don't run one — this script skips it gracefully.
RS_DIR="${EXOCORTEX_RS_DIR:-}"
# PLUG-IN(GIT_IDENTITY): the commit author used for automated backup commits.
GIT_NAME="${EXOCORTEX_GIT_NAME:-$(git config --global user.name 2>/dev/null || echo "Exocortex Backup")}"
GIT_EMAIL="${EXOCORTEX_GIT_EMAIL:-$(git config --global user.email 2>/dev/null || echo "backup@example.invalid")}"

FLAG="$VAULT/BACKUP_FAILING.txt"

backup() {
  local dir="$1"
  cd "$dir" 2>/dev/null || { echo "$(date): $dir missing"; return; }
  rm -f "$FLAG"
  if ! git add -A; then
    echo "$(date): $dir GIT ADD FAILED — backups are NOT running" | tee -a "$FLAG"
    return 1
  fi
  if git diff --cached --quiet; then echo "$(date): $dir nothing to commit"; return; fi
  git -c user.name="$GIT_NAME" -c user.email="$GIT_EMAIL" commit -m "Auto-backup $(date +%Y-%m-%d_%H%M)"
  if git push origin main; then echo "$(date): $dir pushed"; else echo "$(date): $dir PUSH FAILED"; fi
}

# PLUG-IN(SQLITE_SNAPSHOT): if you run the optional Rust strangler proxy with
# its own SQLite databases, snapshot them into the vault so the commit below
# picks them up. Guarded both ways (binary may not be built, /srv path may not
# exist) and must never break the commit/push that follows.
SRV="${EXOCORTEX_SRV_DIR:-/srv/exocortex}"
EXO_BIN="$RS_DIR/target/release/exo"
if [ -n "$RS_DIR" ] && [ -x "$EXO_BIN" ] && [ -f "$SRV/system.db" ]; then
  mkdir -p "$VAULT/data/sqlite-snapshots"
  "$EXO_BIN" backup --config "$RS_DIR/exo.toml" --out "$VAULT/data/sqlite-snapshots" \
    || echo "$(date): sqlite snapshot failed" >&2
fi

backup "$VAULT"       # vault (data + content): auto-commit + push

# Skeleton is code: commits are deliberate (named, per change, made by hand
# when a thing ships). This cron only pushes what's already committed, so a
# same-day commit doesn't sit local-only until the next session.
cd "$SKELETON" 2>/dev/null || { echo "$(date): skeleton missing"; exit 0; }
if git push origin main; then echo "$(date): skeleton pushed"; else echo "$(date): skeleton PUSH FAILED"; fi

# PLUG-IN(RS_REPO): same push-only treatment for the optional Rust repo, if present.
if [ -n "$RS_DIR" ] && [ -d "$RS_DIR" ]; then
  cd "$RS_DIR" 2>/dev/null || { echo "$(date): $RS_DIR missing"; exit 0; }
  if git push origin main; then echo "$(date): $(basename "$RS_DIR") pushed"; else echo "$(date): $(basename "$RS_DIR") PUSH FAILED"; fi
fi
