"""Instance configuration — the single home for values that change per deployment
or per person.

Rule of thumb: if a value is personal ("Bradie"), install-specific (a domain), or a
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

# First-run admin password — only used to SEED auth.json on first boot.
# Change it in Settings after logging in; this value is ignored afterward.
DEFAULT_PASSWORD = os.environ.get("EXOCORTEX_DEFAULT_PASSWORD", "exocortex")
