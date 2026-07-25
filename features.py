"""Feature flags — this fork's non-destructive excision layer.

The deployment goal (Michael, 2026-07-24): keep a sustainable merge line with
upstream while running a tighter personal surface. So the things this fork
turns off are not deleted — they are gated here, and the gate's state lives
OUTSIDE the code tree so no upstream merge can ever overwrite it:

    $EXOCORTEX_DATA_DIR/features.json      e.g. {"web_terminal": false}

Resolution order per flag (first hit wins), read at CALL time like
config.get_profile() so tests can monkeypatch env without reimports:

    1. env var  EXOCORTEX_FEATURE_<NAME>   ("1"/"true"/"yes" on, "0"/"false"/"no" off)
    2. features.json in the data dir
    3. DEFAULTS below — deliberately ALL ON, matching stock upstream behavior,
       so this layer is upstreamable without changing anyone's install. The
       tightening lives in each deployment's features.json, never in code.

Flags gate at exactly one chokepoint each (grep the flag name to find it):
    web_terminal  — the remote-shell API (/api/terminal/send|capture|scroll|
                    refresh|session): routes/terminal.py before_request gate.
    reading_room  — the headless-claude bot surface (spawns `claude -p` as the
                    app user): registration gate in server.py. Off until the
                    owner's agent-spawn policy allows it.
    mcp_server    — the stdio MCP surface for LLM clients: startup check in
                    mcp_server.py (it is a separate process; the flag lets one
                    config file speak for the whole install).
"""
import json
import os

import store

DEFAULTS = {
    "web_terminal": True,
    "reading_room": True,
    "mcp_server": True,
}

_TRUE = {"1", "true", "yes", "on"}
_FALSE = {"0", "false", "no", "off"}


def _file_flags():
    try:
        raw = json.loads((store.DATA_DIR / "features.json").read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return {}
    return raw if isinstance(raw, dict) else {}


def enabled(name):
    """Is feature `name` on? Unknown names resolve False (fail closed)."""
    env = os.environ.get(f"EXOCORTEX_FEATURE_{name.upper()}")
    if env is not None:
        v = env.strip().lower()
        if v in _TRUE:
            return True
        if v in _FALSE:
            return False
    file_val = _file_flags().get(name)
    if isinstance(file_val, bool):
        return file_val
    return bool(DEFAULTS.get(name, False))


def snapshot():
    """Every known flag resolved — for /api/features and debugging."""
    names = set(DEFAULTS) | set(_file_flags())
    return {n: enabled(n) for n in sorted(names)}
