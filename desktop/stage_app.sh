#!/usr/bin/env bash
# stage_app.sh — puts the app's own code and a freshly built page where the
# download is assembled from.
#
# Plain English: the desktop download carries three things beside the window:
# a Python (pack_python.sh makes it), the app's Python code, and the built
# page. This makes the last two, in desktop/src-tauri/resources/app/. The
# window looks for exactly that folder (src-tauri/src/main.rs, `server_spec`),
# and tauri.bundle.conf.json tells the installer build to pack it.
#
# What goes in: every file git tracks, minus the folders a running app never
# reads (the page's source, the tests, this desktop folder), plus the built
# page. Because the list comes from `git ls-files`, nothing gitignored (data,
# logs, the venv, CLAUDE.local.md) can get in. Same idea as
# scripts/make-release.sh.
#
# The page is built in a scratch copy of frontend/, not in frontend/ itself.
# Two reasons: the live site serves frontend/dist and must not be touched, and
# frontend/.env.local (gitignored, install-specific settings such as the
# owner's home coordinates) must not be read, because the build writes its
# values into the JavaScript as plain text. The scratch copy holds tracked
# files only, so that file is not there to read.
#
# Usage:  desktop/stage_app.sh
# Needs:  git, npm, and frontend/node_modules already installed.
#
# Prompt that produced it: "copy the app's code + a freshly built page into
# the download; build the page without the owner's settings file."
set -euo pipefail
cd "$(dirname "$0")/.."

DEST="desktop/src-tauri/resources/app"
[ -d frontend/node_modules ] || { echo "✗ frontend/node_modules missing: run npm install in frontend/ first" >&2; exit 1; }

SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

# Build the page in a scratch copy of the tracked frontend files. The
# libraries are linked in, not copied.
echo "→ Building the page in a scratch copy (frontend/ and its .env.local are not used)"
git ls-files -z frontend | tar --null -T - -cf - | tar -xf - -C "$SCRATCH"
ln -s "$PWD/frontend/node_modules" "$SCRATCH/frontend/node_modules"
(cd "$SCRATCH/frontend" && npx vite build --outDir "$SCRATCH/dist" --emptyOutDir >/dev/null)

# Refuse to go on if any value from the settings file reached the built page.
# Only values of six characters or more are looked for: a short one ("1",
# "true") would match by accident.
if [ -f frontend/.env.local ]; then
  while IFS='=' read -r name value; do
    value="${value%\"}"; value="${value#\"}"
    case "$name" in VITE_*) ;; *) continue ;; esac
    [ "${#value}" -ge 6 ] || continue
    if grep -rqF -- "$value" "$SCRATCH/dist"; then
      echo "✗ the value of $name from frontend/.env.local is in the built page; stopping" >&2
      exit 1
    fi
  done < frontend/.env.local
fi

# Copy the tracked files, leaving out what a running app never reads.
echo "→ Staging the app's code"
rm -rf "$DEST"
mkdir -p "$DEST/frontend"
git ls-files -z -- . ':!frontend' ':!tests' ':!desktop' | tar --null -T - -cf - | tar -xf - -C "$DEST"
cp -r "$SCRATCH/dist" "$DEST/frontend/dist"
touch "$DEST/frontend/dist/.prebuilt"

echo "✓ $DEST  ($(du -sh "$DEST" | cut -f1): code $(du -sh --exclude=frontend "$DEST" | cut -f1), page $(du -sh "$DEST/frontend/dist" | cut -f1))"
