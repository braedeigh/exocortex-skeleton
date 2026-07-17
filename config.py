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
