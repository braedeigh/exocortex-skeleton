#!/bin/sh
# install.sh — installs the desktop app from a terminal, in one pasted line:
#
#   curl -fsSL https://raw.githubusercontent.com/braedeigh/exocortex-skeleton/main/desktop/install.sh | sh
#
# Plain English: this works out which system and chip the computer has,
# downloads the matching app file from the project's public releases, checks
# the download is the file that was published (a SHA-256 checksum), and puts
# it where the system will find it, with a menu entry. It asks for no
# password and writes only inside the person's own home folder.
#
#   install:    sh install.sh
#   remove:     sh install.sh --remove     (leaves the person's data alone)
#
# Where things go (Linux):
#   ~/.local/bin/exocortex                             the app, one file
#   ~/.local/share/applications/exocortex.desktop      the menu entry
#   ~/.local/share/icons/hicolor/128x128/apps/exocortex.png   its picture
#
# What it expects on the releases page, named exactly so:
#   Exocortex-linux-x86_64.AppImage, Exocortex-linux-aarch64.AppImage
#   SHA256SUMS      one "checksum  filename" line per file (sha256sum's format)
#   exocortex.png   the menu picture, 128 pixels square (optional; skipped if
#                   absent). src-tauri/icons/128x128.png is the one to publish.
# Mac is recognised but not installed yet: no Mac build exists.
#
# EXOCORTEX_RELEASES overrides where the files are fetched from (any address
# curl understands, a file:// folder included), for testing or a mirror.
#
# State: tested against a local folder of stand-in files. No release has been
# published yet, so the real download has never been run.
#
# Touches: nothing else in this repository; ../README.md describes it.
# Prompt that produced it: "installable with terminal" / "build it".
set -eu

RELEASES="${EXOCORTEX_RELEASES:-https://github.com/braedeigh/exocortex-skeleton/releases/latest/download}"
BIN_DIR="$HOME/.local/bin"
APP="$BIN_DIR/exocortex"
MENU_ENTRY="$HOME/.local/share/applications/exocortex.desktop"
ICON="$HOME/.local/share/icons/hicolor/128x128/apps/exocortex.png"

say() { printf '%s\n' "$*"; }
fail() { printf 'x %s\n' "$*" >&2; exit 1; }

# Remove: take away the three files this script puts in place. The person's
# data (projects, chats) lives elsewhere and is left alone; say where.
if [ "${1:-}" = "--remove" ]; then
  rm -f "$APP" "$MENU_ENTRY" "$ICON"
  say "Removed the app, its menu entry and its picture."
  say "Your data was left alone: ${XDG_DATA_HOME:-$HOME/.local/share}/exocortex-desktop"
  exit 0
fi

# Work out which file this computer needs.
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)            FILE="Exocortex-linux-x86_64.AppImage" ;;
  Linux-aarch64|Linux-arm64) FILE="Exocortex-linux-aarch64.AppImage" ;;
  Darwin-*) fail "There is no Mac build yet. This installer covers Linux for now." ;;
  *) fail "No build for $(uname -s) on $(uname -m)." ;;
esac
command -v curl >/dev/null 2>&1 || fail "curl is needed to download the app."
command -v sha256sum >/dev/null 2>&1 || fail "sha256sum is needed to check the download."

SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

say "-> Downloading $FILE"
curl -fL --progress-bar -o "$SCRATCH/$FILE" "$RELEASES/$FILE" \
  || fail "Could not download $RELEASES/$FILE"
curl -fsSL -o "$SCRATCH/SHA256SUMS" "$RELEASES/SHA256SUMS" \
  || fail "Could not download the checksum list, so the download cannot be checked."

# Check the download against the published checksum. Nothing is installed
# unless the list names this file and the checksums match.
EXPECTED="$(awk -v file="$FILE" '$2 == file || $2 == "*" file { print $1 }' "$SCRATCH/SHA256SUMS")"
[ -n "$EXPECTED" ] || fail "The checksum list does not name $FILE."
ACTUAL="$(sha256sum "$SCRATCH/$FILE" | awk '{ print $1 }')"
[ "$EXPECTED" = "$ACTUAL" ] || fail "The download does not match its published checksum. Nothing was installed."
say "-> Checksum matches"

# Put the app in place, replacing an older copy in one step.
mkdir -p "$BIN_DIR" "$(dirname "$MENU_ENTRY")" "$(dirname "$ICON")"
chmod +x "$SCRATCH/$FILE"
mv -f "$SCRATCH/$FILE" "$APP"

# The picture is optional: without it the menu entry shows a plain icon.
if curl -fsSL -o "$SCRATCH/exocortex.png" "$RELEASES/exocortex.png" 2>/dev/null; then
  mv -f "$SCRATCH/exocortex.png" "$ICON"
fi

cat > "$MENU_ENTRY" <<ENTRY
[Desktop Entry]
Type=Application
Name=Exocortex
Comment=The Observatory and Terrain
Exec=$APP
Icon=exocortex
Terminal=false
Categories=Development;
ENTRY

say "Installed: $APP"
say "Open it from the applications menu, or run: $APP"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) say "($BIN_DIR is not on your PATH, so the short name 'exocortex' will not work in a terminal; the full path above does.)" ;;
esac
# An AppImage needs a small system library (FUSE 2) that newer Ubuntu
# versions no longer install by default.
if ! ldconfig -p 2>/dev/null | grep -q 'libfuse\.so\.2'; then
  say "Note: this computer has no libfuse2, which the app file needs to start."
  say "      On Ubuntu or Debian: sudo apt install libfuse2t64   (libfuse2 on older versions)"
fi
say "To remove it later: run this installer again with --remove"
