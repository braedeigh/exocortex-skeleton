"""Helpers shared across the kitchen submodules.

Two unrelated groups live here, kept together because they're each a few lines
and both receipts + recipes need them:

  1. Claude agent sessions — the receipt and recipe pipelines hand work to a
     Claude Code instance running in a named tmux session. ensure_claude_session
     spawns it on demand (and registers it in sessions.json so the terminal UI
     lists it); send_prompt types the request into it after a settle delay.
  2. Grocery categorization rules — substring-match rules (learned from receipt
     imports) + the kitchen catalog, used to map a raw item name to a category
     and canonical catalog name.
"""
import json
import re
import shlex
import subprocess
import threading
import time

from data_helpers import DATA_DIR
import store

SESSIONS_PATH = DATA_DIR / "sessions.json"  # user data lives in the data layer, not the code dir
TMUX_SOCKET = "/tmp/tmux-1000/default"


def slug(s):
    s = (s or "").lower()
    s = re.sub(r"[^a-z0-9]+", "-", s)
    return s.strip("-")[:30] or "unknown"


def tmux(cmd_str):
    return subprocess.run(
        f"tmux -S {TMUX_SOCKET} {cmd_str}",
        shell=True, capture_output=True, text=True
    )


def ensure_claude_session(name, cwd, dirs=()):
    """Create the named tmux session running Claude Code (cwd = its working dir),
    after mkdir-ing `dirs`. Registers the session in sessions.json so the
    terminal UI shows it. Returns True if the session was newly spawned."""
    for d in dirs:
        d.mkdir(parents=True, exist_ok=True)
    sessions = []
    if SESSIONS_PATH.exists():
        try:
            sessions = json.loads(SESSIONS_PATH.read_text())
        except json.JSONDecodeError:
            sessions = []
    if name not in sessions:
        sessions.append(name)
        SESSIONS_PATH.write_text(json.dumps(sessions, indent=2))
    check = tmux(f"has-session -t {name}")
    if check.returncode != 0:
        tmux(f"new-session -d -s {name} -c {shlex.quote(str(cwd))} 'claude'")
        return True
    return False


def send_prompt(session, text, delay=4.0):
    """Send text to the session after a delay (lets Claude finish loading)."""
    def _send():
        time.sleep(delay)
        safe = text.replace("'", "'\\''")
        tmux(f"send-keys -t {session} -l '{safe}'")
        tmux(f"send-keys -t {session} Enter")
    threading.Thread(target=_send, daemon=True).start()


def chmod_for_claude(path, dir_mode=0o777, file_mode=0o666):
    """Flask may run as root while the Claude agent runs as a non-root user.
    Open up dir/file modes so the agent can write siblings (e.g. .parsed.json)."""
    import os
    try:
        if path.is_dir():
            os.chmod(path, dir_mode)
        else:
            os.chmod(path, file_mode)
    except OSError:
        pass


# --- Grocery categorization rules (learned from receipt imports) ---------------

def load_grocery_rules():
    return store.read("grocery_item_rules.json", {"patterns": []})


def save_grocery_rules(rules):
    store.write("grocery_item_rules.json", rules)


def categorize_grocery_item(name, rules, kitchen_catalog):
    """Return (category, catalog_name) by substring match against rules + catalog."""
    nlow = (name or "").lower()
    # 1) Custom rules — first substring match wins
    for p in rules.get("patterns", []):
        if p.get("match", "").lower() in nlow:
            return p.get("category", "other"), p.get("catalog_name", "")
    # 2) Kitchen catalog substring match
    for cat_name, cat in (kitchen_catalog or {}).items():
        if cat_name in nlow:
            return cat, cat_name
    return None, None  # uncategorized — needs user input
