#!/usr/bin/env bash
# Build a distributable release tarball: exocortex-<version>.tar.gz
#
# Contents = every git-TRACKED file (working-tree versions) + a freshly built
# frontend/dist marked .prebuilt, so installers on machines without Node can
# skip the npm build entirely. Data, logs, venv, secrets, and anything
# gitignored (CLAUDE.local.md, auth.json, ...) can never leak in, because the
# file list comes from `git ls-files`.
#
# The frontend is built in a scratch copy of its tracked files — the checkout's
# own frontend/dist (served live by the running server) is never touched, and
# the gitignored frontend/.env.local is never read.
#
# Usage: scripts/make-release.sh          → release/exocortex-<version>.tar.gz
set -euo pipefail
cd "$(dirname "$0")/.."

VER="$(sed -n 's/^APP_VERSION = "\(.*\)"/\1/p' config.py)"
[ -n "$VER" ] || { echo "✗ could not read APP_VERSION from config.py" >&2; exit 1; }
NAME="exocortex-$VER"

command -v git >/dev/null || { echo "✗ git required" >&2; exit 1; }
command -v npm >/dev/null || { echo "✗ npm required to build the frontend" >&2; exit 1; }

if [ -n "$(git status --porcelain)" ]; then
  echo "⚠ working tree has uncommitted changes — the tarball uses working-tree"
  echo "  contents of TRACKED files; untracked files are NOT included."
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Build the page in a scratch copy of the tracked frontend files, not in
# frontend/ itself. frontend/.env.local (gitignored, install-specific settings
# such as home coordinates) is then not there to read: a build writes its
# values into the JavaScript as plain text, and they would travel in the
# tarball. The libraries are linked in, not copied. desktop/stage_app.sh does
# the same.
echo "→ Frontend build (in a scratch copy — frontend/ and its .env.local are not used)"
(cd frontend && npm install --no-audit --no-fund >/dev/null)
mkdir -p "$TMP/build"
git ls-files -z frontend | tar --null -T - -cf - | tar -xf - -C "$TMP/build"
ln -s "$PWD/frontend/node_modules" "$TMP/build/frontend/node_modules"
(cd "$TMP/build/frontend" \
  && npx vite build --outDir "$TMP/dist" --emptyOutDir \
  && npx tsc --noEmit)

# Refuse to go on if any value from the settings file reached the built page.
# Only values of six characters or more are looked for: a short one ("1",
# "true") would match by accident.
if [ -f frontend/.env.local ]; then
  while IFS='=' read -r name value; do
    value="${value%\"}"; value="${value#\"}"
    case "$name" in VITE_*) ;; *) continue ;; esac
    [ "${#value}" -ge 6 ] || continue
    if grep -rqF -- "$value" "$TMP/dist"; then
      echo "✗ the value of $name from frontend/.env.local is in the built page; stopping" >&2
      exit 1
    fi
  done < frontend/.env.local
fi

echo "→ Staging tracked files"
mkdir -p "$TMP/$NAME"
git ls-files -z | tar --null -T - -cf - | tar -xf - -C "$TMP/$NAME"

mkdir -p "$TMP/$NAME/frontend"
cp -r "$TMP/dist" "$TMP/$NAME/frontend/dist"
touch "$TMP/$NAME/frontend/dist/.prebuilt"

mkdir -p release
tar -czf "release/$NAME.tar.gz" -C "$TMP" "$NAME"
echo "✓ release/$NAME.tar.gz ($(du -h "release/$NAME.tar.gz" | cut -f1))"
echo "  Install: tar -xzf $NAME.tar.gz && cd $NAME && ./install.sh"
