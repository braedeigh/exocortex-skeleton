#!/bin/bash
# Origin: personal vault scripts/fix_ownership.sh. Scrubbed modular copy — plug-in points marked PLUG-IN(...)
#
# Fix root-owned files in the vault.
#
# WHY THIS EXISTS: running `sudo bash some_script.sh` inside the repo can leave
# files owned by root:root. The app user (+ the backup cron) then can't read
# or write them, which silently breaks BOTH the hourly git backup (`git add -A`
# errors) and any app feature that reads the file. Run this whenever a
# BACKUP_FAILING.txt flag appears, or a tab that reads from the vault goes blank.
#
# Usage:  ./scripts/fix_ownership.sh            # scan + fix everything wrong
#         ./scripts/fix_ownership.sh --dry-run  # just show what's wrong
set -euo pipefail

APP_USER="${EXOCORTEX_APP_USER:-$(whoami)}"
VAULT="${EXOCORTEX_VAULT_DIR:-/opt/exocortex/vault}"
OWNER="$APP_USER:$APP_USER"
DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

cd "$VAULT"

# Find everything not owned by the app user (skip .git internals — those are
# fine and there are thousands of them).
mapfile -t bad < <(find "$VAULT" -not -user "$APP_USER" -not -path "$VAULT/.git/*" 2>/dev/null)

if [ "${#bad[@]}" -eq 0 ]; then
    echo "✓ All vault files are owned by $APP_USER. Nothing to fix."
    exit 0
fi

echo "Found ${#bad[@]} file(s) not owned by $APP_USER:"
for f in "${bad[@]}"; do
    printf '  %s  ' "$(stat -c '%U:%G' "$f")"; echo "$f"
done

if [ "$DRY_RUN" -eq 1 ]; then
    echo "(dry run — nothing changed)"
    exit 0
fi

echo
echo "Fixing ownership → $OWNER (needs sudo)..."
sudo chown "$OWNER" "${bad[@]}"

# If any of these were git-tracked and had been skip-worktree'd as a bandaid
# (so backups could run past the unreadable file), un-skip them now that
# they're readable again, so real edits get committed.
for f in "${bad[@]}"; do
    rel="${f#$VAULT/}"
    if git ls-files --error-unmatch "$rel" >/dev/null 2>&1; then
        git update-index --no-skip-worktree "$rel" 2>/dev/null || true
    fi
done

echo "✓ Fixed. Verifying git can read them all..."
if git add -A --dry-run >/dev/null 2>&1; then
    echo "✓ git add works — backups will run clean."
    rm -f "$VAULT/BACKUP_FAILING.txt"
else
    echo "✗ git add still failing — run: git add -A   to see the offending path."
    exit 1
fi
