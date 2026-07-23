#!/usr/bin/env bash
# Build a distributable release tarball: exocortex-<version>.tar.gz
#
# Contents = every git-TRACKED file (working-tree versions) + a freshly built
# frontend/dist marked .prebuilt, so installers on machines without Node can
# skip the npm build entirely. Data, logs, venv, secrets, and anything
# gitignored (CLAUDE.local.md, auth.json, ...) can never leak in, because the
# file list comes from `git ls-files`.
#
# The frontend is built into a staging dir — the checkout's own frontend/dist
# (served live by the running server) is never touched.
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

echo "→ Frontend build (staged — does not touch frontend/dist)"
(cd frontend && npm install --no-audit --no-fund >/dev/null \
  && npx vite build --outDir "$TMP/dist" --emptyOutDir \
  && npx tsc --noEmit)

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
