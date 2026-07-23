#!/usr/bin/env bash
# Local install: sets up the Python env and builds the frontend, in place.
# Run from anywhere; it works on the repo it lives in. Safe to re-run.
set -euo pipefail
cd "$(dirname "$0")"

fail() { echo "✗ $1" >&2; exit 1; }

command -v python3 >/dev/null || fail "python3 not found — install Python 3.11+ (mac: brew install python)"

python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)' \
  || fail "Python 3.11+ required (found $(python3 --version))"

echo "→ Python env"
[ -d venv ] || python3 -m venv venv
./venv/bin/pip install -q -r requirements.txt

# Release tarballs ship a prebuilt frontend (frontend/dist/.prebuilt marker),
# so Node/npm aren't needed at all. Git checkouts build from source.
if [ -f frontend/dist/.prebuilt ] && [ "${FORCE_FRONTEND_BUILD:-}" != "1" ]; then
  echo "→ Frontend: prebuilt bundle found — skipping npm build"
  echo "  (set FORCE_FRONTEND_BUILD=1 to rebuild from source; needs Node 20+)"
else
  command -v npm >/dev/null || fail "npm not found — install Node 20+ (mac: brew install node)"
  node -e 'process.exit(parseInt(process.versions.node) >= 20 ? 0 : 1)' \
    || fail "Node 20+ required (found $(node --version))"
  echo "→ Frontend build (first run downloads packages — a few minutes)"
  (cd frontend && npm install --no-audit --no-fund && npm run build)
fi

echo "→ Journal commands (~/.claude/commands)"
CMD_DEST="$HOME/.claude/commands"
mkdir -p "$CMD_DEST"
for f in claude-commands/*.md; do
  [ -e "$f" ] || continue
  name="$(basename "$f")"
  src="$(cd "$(dirname "$f")" && pwd)/$name"
  dst="$CMD_DEST/$name"
  if [ -L "$dst" ] && [ "$(readlink -f "$dst")" = "$(readlink -f "$src")" ]; then
    echo "  $name: already linked"
  elif [ -e "$dst" ]; then
    # Never clobber a real file (or a symlink to something else) — that could be
    # the owner's own command of the same name.
    echo "  $name: skipped — $dst already exists"
  else
    ln -s "$src" "$dst"
    echo "  $name: linked"
  fi
done

echo "→ Claude Code hook (.claude/settings.json)"
mkdir -p .claude
if [ -f .claude/settings.json ]; then
  echo "  .claude/settings.json already exists — leaving it alone"
else
  cat > .claude/settings.json <<'EOF'
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "python3 \"$CLAUDE_PROJECT_DIR/data/_system/keeper_capture.py\""
          }
        ]
      }
    ]
  }
}
EOF
  echo "  wrote .claude/settings.json — wires the journal's capture hook"
fi

echo
echo "✓ Installed. Start it with:"
echo "    ./venv/bin/python3 server.py"
echo "  then open http://localhost:5000 — password: exocortex (change it in Settings)."
echo "  Your data lives in ./data/ — that folder is the thing to back up."
echo "  The journal seeds itself on first server run (data/_system/ is populated"
echo "  automatically) — run /journalstart in Claude Code at this repo's root to begin."
