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


MIN_SPAWN_MB = 700  # refuse to start another ~400MB `claude` process below this


def _mem_available_mb():
    """MemAvailable from /proc/meminfo, in MB, or None if unreadable (e.g.
    non-Linux dev boxes lack /proc — callers should just skip the check)."""
    try:
        with open("/proc/meminfo") as f:
            for line in f:
                if line.startswith("MemAvailable:"):
                    return int(line.split()[1]) // 1024
    except OSError:
        return None
    return None


def ensure_claude_session(name, cwd, dirs=()):
    """Create the named tmux session running Claude Code (cwd = its working dir),
    after mkdir-ing `dirs`. Registers the session in sessions.json so the
    terminal UI shows it. Returns True if the session was newly spawned.

    Refuses to spawn (raises RuntimeError) if MemAvailable is below
    MIN_SPAWN_MB — a backstop against OOMing the box, since every button that
    starts a Claude session (triage, person, kitchen, research runner/deep/
    filer, and the annotation-batch worker dispatcher) funnels through here."""
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
    # '=' forces an exact-name match — tmux otherwise prefix-matches, and the
    # worker names collide that way (rw-...-1148 is a prefix of rw-...-1148-10).
    check = tmux(f"has-session -t '={name}'")
    if check.returncode != 0:
        avail = _mem_available_mb()
        if avail is not None and avail < MIN_SPAWN_MB:
            raise RuntimeError(
                f"refusing to spawn Claude session '{name}': only {avail}MB available"
            )
        tmux(f"new-session -d -s {name} -c {shlex.quote(str(cwd))} 'claude'")
        return True
    return False


def send_prompt(session, text, delay=4.0, block=False):
    """Send text to the session after a delay (lets Claude finish loading).

    Defaults to a daemon thread so route handlers return immediately — but a
    daemon thread dies with its process, so a SHORT-LIVED caller (the research
    dispatcher, any cron script) must pass block=True or the prompt is
    silently never typed."""
    def _send():
        time.sleep(delay)
        safe = text.replace("'", "'\\''")
        tmux(f"send-keys -t '={session}' -l '{safe}'")
        tmux(f"send-keys -t '={session}' Enter")
    if block:
        _send()
    else:
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
