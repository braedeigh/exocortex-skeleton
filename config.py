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

# The Linear room's live board (linear_api.py, routes/linear_room.py) talks
# to Linear's GraphQL API with a personal API key. The agents' `linear` MCP
# login can't be reused: it lives in Claude's own config. The key is a secret,
# so it's never in this repo. EXOCORTEX_LINEAR_API_KEY wins if it's set.
# Otherwise it's the file `linear_api_key` in the data dir, which the page's
# paste box writes (and which the vault's .gitignore keeps out of backups).
# EXOCORTEX_LINEAR_TEAM names the team the board shows, by key (e.g. "ENG").
# Blank means the first team the key can see.
LINEAR_TEAM_KEY = os.environ.get("EXOCORTEX_LINEAR_TEAM", "").strip()

# The Linear feed (linear_feed.py): once a minute the app asks Linear what
# changed, writes down what someone other than the owner did, wakes the
# Linear helper with it, and sends her phone the ones that call on her.
#   LINEAR_FEED               — the minute check itself. On; it does nothing
#                               until a key is saved.
#   LINEAR_FEED_BACKFILL_DAYS — how far back the very first look reads. Those
#                               are listed on the page; nobody is woken for them.
#   LINEAR_FEED_PUSH          — also notify her phone.
#   LINEAR_HELPER_DAYS        — a session that used Linear this recently is
#                               one of the sessions the Linear helper is shown.
# Prompt: "I want to create something that pushes linear stuff to my app. And
# the helpers notice it and can send out info".
LINEAR_FEED = os.environ.get("EXOCORTEX_LINEAR_FEED", "1") != "0"
LINEAR_FEED_BACKFILL_DAYS = float(os.environ.get("EXOCORTEX_LINEAR_FEED_BACKFILL_DAYS", "3"))
LINEAR_FEED_PUSH = os.environ.get("EXOCORTEX_LINEAR_FEED_PUSH", "1") != "0"
LINEAR_HELPER_DAYS = float(os.environ.get("EXOCORTEX_LINEAR_HELPER_DAYS", "3"))
# The push door a cron script knocks on (routes/push.py's /api/push/notify).
PUSH_NOTIFY_URL = os.environ.get("EXOCORTEX_PUSH_NOTIFY_URL",
                                 "http://127.0.0.1:5000/api/push/notify")


def linear_api_key_path():
    """Where the pasted Linear API key is kept: a plain file in the data dir,
    like the push and terrain-mirror secrets, never a store collection."""
    import store
    return store.DATA_DIR / "linear_api_key"


def linear_api_key():
    """The Linear API key, or "" when none is set. Read at call time, so a
    key pasted into the page works on the very next request."""
    from_env = os.environ.get("EXOCORTEX_LINEAR_API_KEY", "").strip()
    if from_env:
        return from_env
    try:
        return linear_api_key_path().read_text().strip()
    except OSError:
        return ""


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
# Prompt for the Opus and Fable numbers: "increase the token limit for opus to
# 200k and fable to 500k".
CONTEXT_CAPS = {"opus": 200000, "fable": 500000, "sonnet": 150000, "haiku": 100000}
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
# The helper's chat (helper_chat.py) starts every turn fresh, seeded with a
# doc, the active sessions, and this many of the owner's latest messages to
# the helper, each whole and with the helper's reply. Turns she didn't start
# (a wake-up, a watch, an agent's mail) don't count toward it.
# Prompt: "the rolling context of 15 inputs and outputs" — "specifically my
# messages to the agent" — "always 15 no matter what."
HELPER_CHAT_EXCHANGES = int(os.environ.get("EXOCORTEX_HELPER_CHAT_EXCHANGES", "15"))
# The helper's wake-up (helper_chat.wake_tick): the app starts a turn in a
# helper's chat when the sessions it watches change, and the helper may stay
# silent. HELPER_WAKE_ON is what counts as a change:
#   "new-or-files" — a session has a new summary AND it is new to the helper
#                    or has edited a file it hadn't edited before (the default);
#   "new-or-any-files" — the same, and a file it hadn't READ before counts too.
#                    A busy session reads something new nearly every turn, so
#                    this wakes about as often as "summary";
#   "summary"      — a session has a new summary;
#   "edit"         — a session edited a file;
#   "off"          — never.
# HELPER_WAKE_MIN_SEC is the shortest gap between two wake-ups of one helper
# (changes inside it are folded into the next one). HELPER_WAKE_ROLES is
# which helpers are woken.
# Prompt: "notified and performs a 'turn' every time a new session is
# activated ... it doesn't necessarily have to do anything."
HELPER_WAKE_ON = os.environ.get("EXOCORTEX_HELPER_WAKE_ON", "new-or-files")
HELPER_WAKE_MIN_SEC = int(os.environ.get("EXOCORTEX_HELPER_WAKE_MIN_SEC", "300"))
HELPER_WAKE_ROLES = tuple(
    role.strip() for role in os.environ.get(
        "EXOCORTEX_HELPER_WAKE_ROLES", "room_helper,swarm_helper").split(",") if role.strip())
# Every session's summary is written by a model call of its own, and one run's
# calls are made side by side (swarm_helper.side_by_side). This is how many may
# run at once: each is a `claude` process holding a few hundred MB.
HELPER_SUMMARY_PARALLEL = int(os.environ.get("EXOCORTEX_HELPER_SUMMARY_PARALLEL", "4"))
# How long a finished swarm member (done, archived or handed on) stays in the
# swarm helper's view — its runs and its chat seed — before it drops out of
# what the helper checks. It stays a member; only the helper stops rereading it.
SWARM_HELPER_FORGET_HOURS = float(os.environ.get("EXOCORTEX_SWARM_HELPER_FORGET_HOURS", "24"))
# The room helper (room_helper.py), a layer above the swarm helpers: the rooms
# that have one, how often at most it runs (only when something in the room
# has happened since), and the window within which members who messaged each
# other count as one cluster — clusters active together within it are never split.
ROOM_HELPER_ROOMS = tuple(
    room.strip() for room in os.environ.get("EXOCORTEX_ROOM_HELPER_ROOMS", "coding").split(",")
    if room.strip())
ROOM_HELPER_MIN_SEC = int(os.environ.get("EXOCORTEX_ROOM_HELPER_MIN_SEC", "900"))
ROOM_HELPER_QUIET_HOURS = float(os.environ.get("EXOCORTEX_ROOM_HELPER_QUIET_HOURS", "2"))
# How far back the room helper's "Files being edited now" section looks
# (edited_files.py): a file an open session changed within it is listed.
ROOM_HELPER_FILES_HOURS = float(os.environ.get("EXOCORTEX_ROOM_HELPER_FILES_HOURS", "2"))
# File overlaps (file_alerts.py): once a minute the app looks for two open
# sessions in the same file and writes each one down, once, for the helpers
# — which decide whether to say anything. The sessions are told nothing.
# FILE_OVERLAPS=0 stops the check. FILE_ALERT_ROOMS are the rooms watched
# (pairs are only ever within one room); FILE_ALERT_HOURS is how far back an
# edit or a read still counts.
# Prompt: "That should only be read by the helper."
FILE_OVERLAPS = os.environ.get("EXOCORTEX_FILE_OVERLAPS", "1") != "0"
FILE_ALERT_ROOMS = tuple(
    room.strip() for room in os.environ.get("EXOCORTEX_FILE_ALERT_ROOMS", "coding").split(",")
    if room.strip())
FILE_ALERT_HOURS = float(os.environ.get("EXOCORTEX_FILE_ALERT_HOURS", "2"))
# A helper's watches (watches.py): how long a watched session must go without
# writing a line before it counts as `stalled` (a turn's tool calls write
# lines every few minutes, so 90 minutes of nothing means it's stuck or
# sitting idle with its work unfinished), and how long a watch that never
# fires stands before it's retired — the helper is told either way.
HELPER_WATCH_STALLED_MINUTES = int(os.environ.get("EXOCORTEX_HELPER_WATCH_STALLED_MINUTES", "90"))
HELPER_WATCH_EXPIRE_DAYS = float(os.environ.get("EXOCORTEX_HELPER_WATCH_EXPIRE_DAYS", "7"))

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

# Context on mention (tools/mention_context.py): the first time the owner names
# a person or a thread in a session, a hook hands the agent her recent journal
# cards about them. MENTION_CONTEXT=0 turns it off. MENTION_CONTEXT_ROOMS are
# the Observatory rooms whose sessions get it (a journaling session always
# does); the default leaves build rooms out, so journal text never lands in a
# build chat. The amount: the newest MENTION_CONTEXT_CARDS cards about them
# that the session has not already been handed, however far back that reaches.
# Prompt: "The first time someone is mentioned in a session, the hook runs and
# pulls up the last month of data or the last 20 messages about them." / "load
# more context that doesn't overlap"
MENTION_CONTEXT = os.environ.get("EXOCORTEX_MENTION_CONTEXT", "1") != "0"
MENTION_CONTEXT_ROOMS = tuple(
    room.strip() for room in os.environ.get("EXOCORTEX_MENTION_CONTEXT_ROOMS", "personal").split(",")
    if room.strip())
MENTION_CONTEXT_CARDS = int(os.environ.get("EXOCORTEX_MENTION_CONTEXT_CARDS", "20"))
