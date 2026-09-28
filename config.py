"""Instance configuration — the single home for values that change per deployment
or per person.

Rule of thumb: if a value is personal (a name), install-specific (a domain), or a
deployment choice (a default password), it belongs HERE, not hardcoded in the code.
Everything is overridable by an environment variable with a sensible default, so a new
user can stand up their own instance without editing source.

(Per-user *data* — habits, streaks, reminders, etc. — lives in DATA_DIR as JSON, not
here. This file is for instance-level settings, not user content.)
"""
import os

# Display identity
APP_NAME = os.environ.get("EXOCORTEX_APP_NAME", "Exocortex")
# Shown next to the app name in the header/footer. Blank = omitted entirely.
OWNER_NAME = os.environ.get("EXOCORTEX_OWNER_NAME", "")

# App version — single source of truth for the version label shown in the UI
# (dashboard footer, public header, fake-terminal banner). Bump here only.
APP_VERSION = "0.6"

# First-run admin password — only used to SEED auth.json on first boot, and
# ignored afterward (change it in Settings after logging in). No baked-in
# fallback: when this env var is unset, server.py generates a random one-time
# password and prints it to the log on first boot — a fixed default shared by
# every install is guessable by anyone who has read the source.
DEFAULT_PASSWORD = os.environ.get("EXOCORTEX_DEFAULT_PASSWORD", "")


def public_only() -> bool:
    """True when this install is a read-only public mirror (EXOCORTEX_PUBLIC_ONLY=1).

    In that mode every request is served in the "public" view — the frosted,
    stranger-safe one — no matter what cookie or proxy header it carries, and
    /login answers 404. It's how a second copy of the site (a portfolio
    mirror on a public host) can run against a copy of the data without
    becoming a second door into the private site. Read at call time, not
    import time, so tests can flip it with monkeypatch.setenv.

    Prompt that produced it: "add a public-only switch to the app, an env var
    that forces every request into public view and turns off the login page."
    """
    return os.environ.get("EXOCORTEX_PUBLIC_ONLY", "").strip().lower() in ("1", "true", "yes")


def frame_ancestors():
    """Origins allowed to put this site in an <iframe>, read from
    EXOCORTEX_FRAME_ANCESTORS (space-separated, e.g.
    "https://mudscryer.org https://www.mudscryer.org"). Only consulted on a
    public-only mirror (see server.frame_policy): the portfolio page frames the
    Terrain map's embed view, and nothing else on the mirror may be framed by
    anyone. Empty (the default) means nobody. Read at call time, like
    public_only(), so tests can flip it."""
    return os.environ.get("EXOCORTEX_FRAME_ANCESTORS", "").split()


def get_profile():
    """The owner profile, precedence stored value (non-empty) -> env var -> default.

    Backs /api/profile (routes/profile.py) and the two identity outflows
    (server.py's context processor, routes/spa.py's APP_META) — this is now
    the single place that resolves "what name/email/app-name do we show".

    Reads env vars at CALL time (not import time), same reasoning as
    schemas.validate()'s kill switch: lets tests monkeypatch env without a
    reimport, and lets an ops env change take effect without a restart-free
    reload. Imports store lazily to avoid a cycle (store doesn't import this
    module, but plenty of modules import both).

    An empty stored value is treated as "unset" so an explicit clear (PUT
    {"owner_name": ""}) falls back to the env var / default rather than
    pinning an empty string.
    """
    import store
    stored = store.read("profile", {})

    def _resolve(key, env_var, default):
        value = stored.get(key)
        if isinstance(value, str) and value:
            return value
        return os.environ.get(env_var, default)

    return {
        "owner_name": _resolve("owner_name", "EXOCORTEX_OWNER_NAME", ""),
        "owner_email": _resolve("owner_email", "EXOCORTEX_OWNER_EMAIL", ""),
        "app_name": _resolve("app_name", "EXOCORTEX_APP_NAME", "Exocortex"),
    }


# Tables the agents' SQL door refuses to read. scripts/exo_query.py passes this
# to sqlquery.run_query as its deny-list; comma-separated table names in
# EXOCORTEX_SQL_AGENT_DENY_TABLES, blank meaning no table is fenced. It is
# blank by default ON PURPOSE: the owner chose to let agents read every table.
# It exists as the one-line fence for later — the day she wants agents kept
# out of, say, `tool_calls` (whose rows can carry other people's words
# verbatim), this env var is the whole change; no code moves. The browser's
# own SQL console never consults it: that window is hers. Parsed at import
# time like the display identity above; the CLI reads
# config.SQL_AGENT_DENY_TABLES at call time, so a test can monkeypatch it.
SQL_AGENT_DENY_TABLES = frozenset(
    name.strip()
    for name in os.environ.get("EXOCORTEX_SQL_AGENT_DENY_TABLES", "").split(",")
    if name.strip()
)

# Agents talking to each other (peermail.py, docs/peers.md) has no count
# limits: no hop brake, no daily cap. The owner's call — agents are kept in
# bounds by judgement (message only when it serves your own build), which the
# prompt in peermail.prompt spells out, not by a number that holds messages.

# Keep each turn's input open so messages can be handed to an agent mid-turn
# (Claude Code's `--input-format stream-json`). "0" turns it off: every turn
# goes back to sending one prompt and closing, and waiting messages are
# delivered only between turns.
TURN_STREAM_INPUT = os.environ.get("EXOCORTEX_TURN_STREAM_INPUT", "1") != "0"

# Self-continuing Coding sessions (continuation.py, docs/swarms.md). When a
# Coding session's context passes its model's cap, it isn't interrupted: the
# turn it's on finishes, then it writes a handoff and a fresh session picks the
# work up from it. The caps are soft, in tokens of context, per model family.
# EXOCORTEX_CONTEXT_CAPS overrides any of them as JSON, e.g. '{"opus": 150000}'.
CONTEXT_CAPS = {"opus": 120000, "fable": 250000, "sonnet": 150000, "haiku": 100000}
try:
    import json as _json
    CONTEXT_CAPS.update({str(k): int(v) for k, v in _json.loads(
        os.environ.get("EXOCORTEX_CONTEXT_CAPS", "{}")).items()})
except (ValueError, TypeError, AttributeError):
    pass
# The rooms whose sessions continue themselves with nobody watching.
CONTINUE_LANES = frozenset(
    lane.strip() for lane in os.environ.get("EXOCORTEX_CONTINUE_LANES", "coding").split(",")
    if lane.strip())

# The swarm helper (swarm_helper.py): which model it runs on, how often at most
# it re-summarises a swarm after member turns (messages to it are answered
# straight away regardless), and how long one run may take.
SWARM_HELPER_MODEL = os.environ.get("EXOCORTEX_SWARM_HELPER_MODEL", "sonnet")
SWARM_HELPER_MIN_SEC = int(os.environ.get("EXOCORTEX_SWARM_HELPER_MIN_SEC", "300"))
SWARM_HELPER_TIMEOUT_SEC = int(os.environ.get("EXOCORTEX_SWARM_HELPER_TIMEOUT_SEC", "240"))
# The helper's chat (helper_chat.py) starts every turn fresh, seeded with the
# swarm, the chat summary, and this many of the owner's latest messages word for word.
HELPER_CHAT_MESSAGES = int(os.environ.get("EXOCORTEX_HELPER_CHAT_MESSAGES", "10"))

# The privileged commands an agent may ask the owner to run for it (sudo_requests.py,
# routes/sudo.py). An agent names one of these KEYS, never a command line — the list
# is the whole of what the page's password box can ever run as root. The default is
# the one thing agents need most: reloading this service after a Python edit.
# EXOCORTEX_SUDO_ACTIONS replaces the list as JSON, e.g.
# '{"reload": {"label": "Reload the web server", "argv": ["systemctl", "reload", "exo.service"]}}'.
SERVICE_NAME = os.environ.get("EXOCORTEX_SERVICE_NAME", "exocortex.service")
SUDO_ACTIONS = {
    "reload": {"label": "Reload the web server",
               "argv": ["systemctl", "reload", SERVICE_NAME]},
}
try:
    _sudo_override = _json.loads(os.environ.get("EXOCORTEX_SUDO_ACTIONS", "null"))
    if isinstance(_sudo_override, dict):
        SUDO_ACTIONS = {str(k): {"label": str(v.get("label") or k),
                                 "argv": [str(a) for a in v["argv"]]}
                        for k, v in _sudo_override.items()}
except (ValueError, TypeError, AttributeError, KeyError):
    pass
