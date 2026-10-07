#!/usr/bin/env bash
# pack_python.sh — makes the Python that travels inside the download.
#
# Plain English: a person who downloads the desktop app should not have to
# install Python first. This fetches a ready-made, self-contained Python (the
# "python-build-standalone" builds, which run from any folder), installs the
# app's Python libraries into it, and leaves the result in
# desktop/src-tauri/resources/python/. The window looks for exactly that
# folder (src-tauri/src/main.rs, `server_spec`) and uses it when it is there.
#
# Why this and not PyInstaller: the app starts its own helper scripts with
# "the Python I am running in" (routes/observatory.py does it for every agent
# turn). PyInstaller replaces Python with a single frozen program, which
# cannot run a script handed to it, so those starts would all fail.
#
# Usage:  desktop/pack_python.sh [requirements file]     (default: requirements.txt)
# Needs:  curl, tar, and the checkout's ./venv (only to read a JSON reply).
# Builds for the machine it runs on. Linux x86_64/arm64 and Mac are named
# below; only Linux x86_64 has been run.
#
# Prompt that produced it: "how Python gets bundled so the person installs
# nothing first."
set -euo pipefail
cd "$(dirname "$0")/.."

REQUIREMENTS="${1:-requirements.txt}"
PYTHON_SERIES="3.12"
DEST="desktop/src-tauri/resources/python"

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)  TARGET="x86_64-unknown-linux-gnu" ;;
  Linux-aarch64) TARGET="aarch64-unknown-linux-gnu" ;;
  Darwin-arm64)  TARGET="aarch64-apple-darwin" ;;
  Darwin-x86_64) TARGET="x86_64-apple-darwin" ;;
  *) echo "✗ no packed Python known for $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac

# Ask GitHub for the newest release and pick the one file for this machine:
# the small "install_only_stripped" build of the Python series named above.
echo "→ Finding the newest packed Python $PYTHON_SERIES for $TARGET"
URL="$(curl -fsSL https://api.github.com/repos/astral-sh/python-build-standalone/releases/latest \
  | ./venv/bin/python3 -c "
import json, sys
wanted = ('cpython-$PYTHON_SERIES.', '$TARGET-install_only_stripped.tar.gz')
for asset in json.load(sys.stdin)['assets']:
    name = asset['name']
    if name.startswith(wanted[0]) and name.endswith(wanted[1]):
        print(asset['browser_download_url']); break
")"
[ -n "$URL" ] || { echo "✗ no matching Python build in the latest release" >&2; exit 1; }

echo "→ Downloading $(basename "$URL")"
rm -rf "$DEST"
mkdir -p "$DEST"
curl -fsSL "$URL" | tar -xz -C "$DEST" --strip-components=1

echo "→ Installing the app's libraries from $REQUIREMENTS"
"$DEST/bin/python3" -m pip install -q --no-warn-script-location --no-compile -r "$REQUIREMENTS"

# Drop what a running app never uses: pip itself, test suites, byte-code.
"$DEST/bin/python3" -m pip uninstall -q -y pip setuptools 2>/dev/null || true
find "$DEST" -type d \( -name __pycache__ -o -name tests -o -name test \) -prune -exec rm -rf {} +

echo "✓ $DEST  ($(du -sh "$DEST" | cut -f1) unpacked)"
