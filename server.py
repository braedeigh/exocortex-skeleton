from flask import Flask, render_template, jsonify, request, session, redirect
from werkzeug.middleware.proxy_fix import ProxyFix
from pathlib import Path
import json
import hashlib
import sys
import secrets
import bcrypt
import time
import traceback
from datetime import datetime, timedelta

from data_helpers import (
    BUILD_DIR, DATA_DIR, CONTENT_DIR,
    parse_md_sections, load_health_data,
    load_todos, roll_todos, todos_to_sections, todos_for_tab,
    validate_on_startup, sweep_uploads_throttled,
)
from public_config import filter_for_view, is_public_path
import store
import config
import features
import proxy_auth
from routes import (
    kitchen, habits, todos, places, health, inventory, money, car,
    meditation, media, movement, reminders, food_test, terminal, settings,
    devnotes, ideas, ecosystem, keeper, pending, housing, triage, decisions,
    entities, threads, person, shell, cards, archivals, research,
    research_search, research_sources, research_import, research_text,
    annotations, spa, fronts, wiki, travel, profile, usage, streaks, spinoff,
    reading_room, automations, push,
)
from routes.shell import VALID_TABS

app = Flask(__name__)
# Two trusted proxy hops since the v2 cutover: nginx (TLS) → exo-server
# (Rust strangler proxy, :8100) → Flask. Each appends to X-Forwarded-For.
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=2, x_proto=1)
app.config['TEMPLATES_AUTO_RELOAD'] = True
# Long-lived static caching is safe because every /static/ URL rendered through
# templates is stamped with a file-mtime version query param by the v_static()
# context processor below — a changed file gets a new URL, so browsers never
# serve a stale cached asset across a redeploy.
app.config['SEND_FILE_MAX_AGE_DEFAULT'] = 31536000

# --- Logging ---
from logging.handlers import RotatingFileHandler
import logging
import os

def _make_file_handler(path, max_bytes, fmt, level):
    """Build a RotatingFileHandler, falling back to a no-op if the file isn't
    writable (e.g. tests running as non-owner of a root-created log file)."""
    try:
        h = RotatingFileHandler(path, maxBytes=max_bytes, backupCount=1)
    except (PermissionError, OSError):
        return logging.NullHandler()
    h.setFormatter(logging.Formatter(*fmt))
    h.setLevel(level)
    return h

LOG_PATH = Path(__file__).parent / "server.log"
file_handler = _make_file_handler(
    LOG_PATH, 1_000_000,
    ("%(asctime)s [%(levelname)s] %(message)s", "%Y-%m-%d %H:%M:%S"),
    logging.WARNING,
)
app.logger.addHandler(file_handler)
app.logger.setLevel(logging.INFO)

# Request logging
ACCESS_LOG = Path(__file__).parent / "access.log"
access_handler = _make_file_handler(
    ACCESS_LOG, 500_000,
    ("%(asctime)s %(message)s", "%Y-%m-%d %H:%M:%S"),
    logging.INFO,
)
access_logger = logging.getLogger('access')
access_logger.addHandler(access_handler)
access_logger.setLevel(logging.INFO)

@app.after_request
def log_request(response):
    if request.path.startswith('/api/'):
        access_logger.info(f"{request.method} {request.path} → {response.status_code}")
    return response


# The dashboard polls /api/version + /api/data/<tab> every 5s (static/js/polling.js)
# and again on every visibilitychange, re-downloading the full JSON payload (up to
# ~1.5MB) even when nothing changed. Turn those endpoints into conditional GETs: tag
# the response with an ETag of its body, and let Werkzeug turn a matching
# If-None-Match into a bodyless 304. fetch() handles the revalidation transparently
# (a 304 is served to JS as a normal 200 from the HTTP cache) — no frontend change
# needed. Cache-Control: no-cache forces revalidation every time rather than letting
# the browser skip the request altogether (data can change server-side).
def add_conditional_cache(response):
    if request.method != 'GET' or response.status_code != 200:
        return response
    if not (request.path.startswith('/api/data') or request.path == '/api/version'):
        return response
    if response.direct_passthrough:
        return response
    response.add_etag()
    response.cache_control.no_cache = True
    response.cache_control.private = True
    return response.make_conditional(request)


app.after_request(add_conditional_cache)

# Cache-busting
@app.context_processor
def static_versioning():
    def versioned_static(filename):
        filepath = Path(__file__).parent / "static" / filename
        try:
            mtime = int(filepath.stat().st_mtime)
        except FileNotFoundError:
            mtime = 0
        return f"/static/{filename}?v={mtime}"
    return dict(v_static=versioned_static)

# Session auth — the password hash + secret key are personal secrets, so they live
# in the data layer (DATA_DIR), not the shared code dir.
auth_path = store.DATA_DIR / "auth.json"
if auth_path.exists():
    _auth = json.loads(auth_path.read_text())
    app.secret_key = _auth["secret_key"]
    AUTH_HASH = _auth["password_hash"]
    AUTH_ALGO = _auth.get("hash_algo", "sha256")
else:
    sk = secrets.token_hex(32)
    seed_pw = config.DEFAULT_PASSWORD
    if not seed_pw:
        # No EXOCORTEX_DEFAULT_PASSWORD set: mint a random one-time password
        # rather than seeding a well-known default every reader of this source
        # could guess. Printed once, at first boot only — change it in
        # Settings after logging in.
        seed_pw = secrets.token_urlsafe(9)
        print(f"[exocortex] First boot: generated admin password: {seed_pw}\n"
              f"[exocortex] Log in with it and change it in Settings "
              f"(or set EXOCORTEX_DEFAULT_PASSWORD before first boot).",
              file=sys.stderr, flush=True)
    ph = bcrypt.hashpw(seed_pw.encode(), bcrypt.gensalt()).decode()
    auth_path.write_text(json.dumps({"secret_key": sk, "password_hash": ph, "hash_algo": "bcrypt"}, indent=2))
    app.secret_key = sk
    AUTH_HASH = ph
    AUTH_ALGO = "bcrypt"


def _verify_password(pw: str) -> bool:
    """Verify pw against the stored hash, regardless of algo."""
    if AUTH_ALGO == "bcrypt":
        try:
            return bcrypt.checkpw(pw.encode(), AUTH_HASH.encode())
        except ValueError:
            return False
    # legacy sha256
    return hashlib.sha256(pw.encode()).hexdigest() == AUTH_HASH


def _save_auth(new_hash: str, algo: str) -> None:
    """Persist a new password hash and update module globals."""
    global AUTH_HASH, AUTH_ALGO
    data = json.loads(auth_path.read_text())
    data["password_hash"] = new_hash
    data["hash_algo"] = algo
    auth_path.write_text(json.dumps(data, indent=2))
    AUTH_HASH = new_hash
    AUTH_ALGO = algo


def _migrate_to_bcrypt(plaintext: str) -> None:
    """If the stored hash is still SHA-256, re-hash with bcrypt on successful login."""
    if AUTH_ALGO != "bcrypt":
        new_hash = bcrypt.hashpw(plaintext.encode(), bcrypt.gensalt()).decode()
        _save_auth(new_hash, "bcrypt")
        app.logger.info("Auth: migrated password hash from sha256 → bcrypt")

app.config['SESSION_COOKIE_SAMESITE'] = 'Lax'
app.config['SESSION_COOKIE_SECURE'] = True
app.config['PERMANENT_SESSION_LIFETIME'] = timedelta(days=90)

# --- Proxy trust header (exocortex-rs handoff) ---
# Inert unless EXO_PROXY_SECRET_FILE is set to a readable 32-byte hex secret file.
_PROXY_SECRET = proxy_auth.load_secret(app.logger)


def _exo_proxied_user():
    """Return the authenticated slug from a valid X-Exo-Proxied header, or None."""
    return proxy_auth.verify_header(request.headers.get("X-Exo-Proxied"), _PROXY_SECRET, time.time())


def _is_authed() -> bool:
    """Single auth predicate going forward: proxy-asserted user OR legacy session cookie."""
    return getattr(request, 'exo_user', None) is not None or session.get('authed')


@app.before_request
def gate():
    slug = _exo_proxied_user()
    if slug:
        request.exo_user = slug
        request.view_mode = "authed"
        return
    request.view_mode = "authed" if session.get('authed') else "public"
    if request.view_mode == "authed":
        return
    if is_public_path(request.path):
        return
    if request.path.startswith('/api/'):
        return jsonify({"error": "unauthorized"}), 401
    return redirect('/login')


@app.context_processor
def inject_view_mode():
    from flask import has_request_context
    if has_request_context():
        return {"view_mode": getattr(request, "view_mode", "authed")}
    return {"view_mode": "authed"}


APP_VERSION = config.APP_VERSION  # re-export; canonical value lives in config.py


@app.context_processor
def inject_app_version():
    profile = config.get_profile()
    return {"app_version": APP_VERSION, "app_name": profile["app_name"], "owner_name": profile["owner_name"]}


@app.context_processor
def inject_theme_overrides():
    return {"theme_overrides_json": json.dumps(settings.load_theme())}


def get_code_hash():
    h = hashlib.md5()
    for f in sorted(Path(__file__).parent.glob("templates/*.html")):
        h.update(f.read_bytes())
    h.update(Path(__file__).read_bytes())
    return h.hexdigest()[:12]


# --- Page routes ---

# --- Login rate limiting ---
# In-memory sliding window per IP. Per-worker (gunicorn = 2 workers, so effective
# cap is ~2x). Good enough to neuter brute force; not a substitute for a real
# distributed limiter.
_LOGIN_FAILS = {}            # ip -> [timestamp, ...]
LOGIN_WINDOW_SEC = 300       # 5-minute window
LOGIN_MAX_FAILS = 5          # max failures per window before lockout


def _check_login_rate(ip):
    """Return (allowed, retry_after_sec). Prunes stale entries as a side-effect."""
    now = time.time()
    fails = [t for t in _LOGIN_FAILS.get(ip, []) if now - t < LOGIN_WINDOW_SEC]
    _LOGIN_FAILS[ip] = fails
    if len(fails) >= LOGIN_MAX_FAILS:
        retry = int(LOGIN_WINDOW_SEC - (now - fails[0])) + 1
        return False, retry
    return True, 0


def _record_login_fail(ip):
    _LOGIN_FAILS.setdefault(ip, []).append(time.time())


def _clear_login_fails(ip):
    _LOGIN_FAILS.pop(ip, None)


@app.route("/login", methods=["GET", "POST"])
def login():
    ip = request.remote_addr or "unknown"
    if request.method == "POST":
        allowed, retry_after = _check_login_rate(ip)
        if not allowed:
            app.logger.warning(f"Login rate-limited: {ip} (retry in {retry_after}s)")
            mins = max(1, retry_after // 60)
            resp = render_template(
                "login.html",
                error=f"Too many attempts. Try again in ~{mins} minute{'s' if mins != 1 else ''}.",
            )
            return resp, 429, {"Retry-After": str(retry_after)}
        pw = request.form.get("password", "")
        if _verify_password(pw):
            _clear_login_fails(ip)
            session.permanent = True
            session['authed'] = True
            _migrate_to_bcrypt(pw)
            return redirect('/')
        _record_login_fail(ip)
        app.logger.warning(f"Login failed: {ip}")
        return render_template("login.html", error="Wrong password")
    return render_template("login.html", error=None)


@app.route("/logout")
def logout():
    session.clear()
    return redirect('/login')


@app.route("/api/version")
def version():
    return jsonify({"hash": get_code_hash()})


@app.route("/api/auth-check")
def auth_check():
    # nginx auth_request gate for /files/ and /terminal/. The before_request
    # gate already 401s anonymous callers, but check again here so this can
    # never silently become public via PUBLIC_PATHS.
    if not session.get('authed'):
        return "", 401
    return "", 204


@app.route("/api/auth/change-password", methods=["POST"])
def api_change_password():
    if getattr(request, 'exo_user', None) is not None:
        return jsonify({"error": "password is managed by the new login system — use `exo user passwd`"}), 410
    if not session.get('authed'):
        return jsonify({"error": "not authed"}), 401
    data = request.get_json(silent=True) or {}
    cur = data.get('current', '')
    new = data.get('new', '')
    if not _verify_password(cur):
        return jsonify({"error": "current password incorrect"}), 403
    if len(new) < 6:
        return jsonify({"error": "new password must be at least 6 characters"}), 400
    new_hash = bcrypt.hashpw(new.encode(), bcrypt.gensalt()).decode()
    _save_auth(new_hash, "bcrypt")
    return jsonify({"ok": True})


# --- Dev Notes + Idea Notes (per-tab panels) — routes live in routes/devnotes.py ---

_load_dev_notes = devnotes.load_dev_notes
_load_idea_notes = devnotes.load_idea_notes


# --- Journal ---

@app.route("/api/journal/dates")
def journal_dates():
    daily_dir = CONTENT_DIR / "Journal" / "Daily"
    dates = sorted(f.stem for f in daily_dir.glob("*.md"))
    return jsonify({"dates": dates})


@app.route("/api/journal/<date>")
def journal_get(date):
    try:
        datetime.strptime(date, "%Y-%m-%d")
    except ValueError:
        return jsonify({"error": "invalid date"}), 400
    path = CONTENT_DIR / "Journal" / "Daily" / f"{date}.md"
    content = path.read_text() if path.exists() else ""
    daily_dir = CONTENT_DIR / "Journal" / "Daily"
    dates = sorted(f.stem for f in daily_dir.glob("*.md"))
    # prev = newest date strictly before `date`; next = oldest date strictly after `date`.
    # Works whether or not `date` itself has an entry — so an empty today still navigates back.
    earlier = [d for d in dates if d < date]
    later = [d for d in dates if d > date]
    prev_date = earlier[-1] if earlier else None
    next_date = later[0] if later else None
    return jsonify({"date": date, "content": content, "prev": prev_date, "next": next_date})


@app.route("/api/journal/<date>", methods=["POST"])
def journal_save(date):
    try:
        datetime.strptime(date, "%Y-%m-%d")
    except ValueError:
        return jsonify({"error": "invalid date"}), 400
    data = request.json or {}
    content = data.get("content", "")
    path = CONTENT_DIR / "Journal" / "Daily" / f"{date}.md"
    store.write_text_file(path, content)
    return jsonify({"ok": True})


# --- Personality (goal-personality.md) ---

PERSONALITY_PATH = CONTENT_DIR / "manifestation" / "goal-personality.md"


@app.route("/api/personality")
def personality_get():
    content = PERSONALITY_PATH.read_text() if PERSONALITY_PATH.exists() else ""
    return jsonify({"content": content})


@app.route("/api/personality", methods=["POST"])
def personality_save():
    data = request.json or {}
    content = data.get("content", "")
    store.write_text_file(PERSONALITY_PATH, content)
    return jsonify({"ok": True})


# --- Data loading helpers ---

# The owner's safe/hurts/unsure food lists are DATA (data/food_guide.json),
# not code — a person's trigger foods are health information and never belong
# in the shareable skeleton. Read fresh so edits land without a restart.
_FOOD_GUIDE_DEFAULT = {"safe": [], "hurts": [], "unsure": [], "inflammatory": []}


def _food_guide():
    guide = store.read("food_guide", None) or {}
    return {**_FOOD_GUIDE_DEFAULT, **guide}


def _common_data():
    now = datetime.now()
    hour = now.hour
    if 5 <= hour < 11:
        time_of_day = "morning"
    elif 11 <= hour < 18:
        time_of_day = "afternoon"
    else:
        time_of_day = "evening"
    return {
        "time_of_day": time_of_day,
        "server_hour": now.hour + now.minute / 60,
        "server_day_of_year": now.timetuple().tm_yday,
        "server_date": now.strftime("%Y-%m-%d"),
        "date": now.strftime("%A, %B %-d"),
        # Active counters only — retired ones leave the Today tab and live on
        # the Life Map (retired_streaks in /api/data/map). routes/streaks.py
        # owns the whole lifecycle now.
        "streaks": streaks.load_streaks("active"),
    }


def _load_car():
    return store.read("car_maintenance.json", {"entries": []})


def _load_car_notes():
    return store.read("car_notes.json", {"text": ""})


def _load_meditation():
    return store.read("meditation_log.json", {"entries": []})


def _load_deity_profiles():
    return store.read("deity_profiles.json", {"profiles": []})


def _load_meditation_notes():
    return store.read("meditation_notes.json", {"text": ""})


def _load_media():
    return store.read("media.json", {"items": []})


def _load_movement():
    return store.read("movement.json", {"routines": []})


def _load_research():
    return store.read("research.json", {"topics": [], "entries": []})


def _load_ecosystem():
    return store.read("ecosystem.json", {"sources": []})


def _load_reminders():
    return store.read("reminders.json", {}).get("reminders", [])


# Activity types that must stay hidden on the public/shared calendar. Exposed as
# a plain list of type strings (safe in public view) so the calendar can filter
# dots + legend even though the full reminder list itself is hidden publicly.
def _private_act_types():
    types = {"estradiol", "peptides"}  # fallback even if a reminder is missing
    for r in _load_reminders():
        if r.get("private") and r.get("type"):
            types.add(r["type"])
    return sorted(types)


def _load_contacts():
    now = datetime.now()
    contacts = store.read("contacts.json", {}).get("contacts", [])
    today = now.replace(hour=0, minute=0, second=0, microsecond=0)
    for c in contacts:
        if c.get("last_contact"):
            last_dt = datetime.strptime(c["last_contact"], "%Y-%m-%d")
            c["days_since"] = (today - last_dt).days
        else:
            c["days_since"] = None
    return contacts


def _load_habits_log():
    # data_helpers.load_habits_log migrates legacy bare-text keys to the
    # section-qualified form on the way out.
    from data_helpers import load_habits_log
    return load_habits_log()


def _load_habits():
    habits_path = CONTENT_DIR / "HABITS.md"
    return parse_md_sections(habits_path) if habits_path.exists() else []


def _load_habit_settings():
    return store.read("habit_settings.json", {"hidden": []})


def _load_habit_starts():
    return store.read("habit_start_dates.json", {})


def _load_habit_cadence():
    # Reconciles graduated habits' spot-checks against the log on the way out
    # (pass/miss/demote/reschedule). Cheap; safe on every data load.
    import habit_cadence
    return habit_cadence.reconcile(_load_habits_log())


def _cadence_config():
    import habit_cadence
    return habit_cadence.CONFIG


def _load_habit_meta():
    return store.read("habit_meta.json", {})


def _load_activity_log():
    return store.read("activity_log.json", {}).get("entries", [])


def _load_meal_defaults():
    return store.read("meal_defaults.json", {})


def _load_kitchen_data():
    kitchen_list = []
    kitchen_category_map = {}
    kitchen_purchase_counts = {}
    kitchen_item_notes = {}
    kitchen_pantry = {}
    kitchen_aisles = {}
    kitchen_last_bought = {}
    kitchen_safety_tags = {}
    kitchen_category_order = ['vegetables','produce','fruit','grains','drinks','snacks','dessert','other','@aisles','dairy','protein','pharmacy','supplements']
    gdata = store.read("kitchen.json", {})
    if gdata:
        kitchen_list = gdata.get("items", [])
        kitchen_category_map = gdata.get("category_map", {})
        kitchen_purchase_counts = gdata.get("purchase_counts", {})
        kitchen_item_notes = gdata.get("item_notes", {})
        kitchen_pantry = gdata.get("pantry", {})
        kitchen_aisles = gdata.get("aisles", {})
        kitchen_last_bought = gdata.get("last_bought", {})
        kitchen_safety_tags = gdata.get("safety_tags", {})
        kitchen_category_order = gdata.get("category_order", kitchen_category_order)
    return {
        "kitchen_list": kitchen_list,
        "kitchen_known_items": kitchen_category_map,
        "kitchen_purchase_counts": kitchen_purchase_counts,
        "kitchen_item_notes": kitchen_item_notes,
        "kitchen_pantry": kitchen_pantry,
        "kitchen_aisles": kitchen_aisles,
        "kitchen_last_bought": kitchen_last_bought,
        "kitchen_safety_tags": kitchen_safety_tags,
        "kitchen_category_order": kitchen_category_order,
    }


# --- Tab-specific data endpoints ---

@app.route("/api/data/today")
def get_data_today():
  try:
    data = _common_data()
    # Transient terminal uploads self-clean after 24h; this hot path is the
    # reliable trigger (throttled to once an hour).
    sweep_uploads_throttled()

    habits = _load_habits()
    todo_data = load_todos()
    todo_data = roll_todos(todo_data)

    growth_notes = store.read("growth_notes.json", {}).get("items", [])
    applications = store.read("shrike_applied.json", [])

    data.update({
        "habits": habits,
        "habit_settings": _load_habit_settings(),
        "habit_starts": _load_habit_starts(),
        "growth_notes": growth_notes,
        "todos": todos_to_sections(todo_data),
        "places": store.read("places", {}).get("places", []),
        "habits_log": _load_habits_log(),
        "habit_cadence": _load_habit_cadence(),
        "cadence_config": _cadence_config(),
        "habit_meta": _load_habit_meta(),
        "health_data": load_health_data(),
        "contacts": _load_contacts(),
        "applications": applications,
        "meal_defaults": _load_meal_defaults(),
        "food_guide": _food_guide(),
        "activity_log": _load_activity_log(),
        "reminders": _load_reminders(),
        "private_act_types": _private_act_types(),
        # Context-gating rules for the To Do list (see todoHelpers.gateHides).
        # Personal config, lives in the vault; absent file → no gating. Not in
        # STREAMS, so the public filter drops it (it encodes her schedule).
        "todo_view_rules": store.read("todo_view_rules.json", {}),
    })
    data["dev_notes"] = _load_dev_notes().get("tabs", {}).get("today", [])
    data["idea_notes"] = _load_idea_notes().get("tabs", {}).get("today", [])
    return jsonify(filter_for_view(data, request.view_mode))
  except Exception as e:
    app.logger.error(f"/api/data/today failed: {e}\n{traceback.format_exc()}")
    return jsonify({"error": str(e)}), 500


@app.route("/api/data/map")
def get_data_map():
  try:
    data = _common_data()

    supplements = store.read("supplements.json", {}).get("supplements", [])
    runs_data = store.read("runs.json", {"target_per_week": 3, "runs": []})
    kitchen_trips = store.read("kitchen_trips.json", {}).get("trips", [])

    data.update({
        "health_data": load_health_data(),
        "habits_log": _load_habits_log(),
        "habit_cadence": _load_habit_cadence(),
        "cadence_config": _cadence_config(),
        "habit_meta": _load_habit_meta(),
        "habits": _load_habits(),
        "habit_starts": _load_habit_starts(),
        "habit_settings": _load_habit_settings(),
        "supplements": supplements,
        "runs": runs_data,
        "kitchen_trips": kitchen_trips,
        "activity_log": _load_activity_log(),
        "meal_defaults": _load_meal_defaults(),
        "food_guide": _food_guide(),
        "contacts": _load_contacts(),
        "reminders": _load_reminders(),
        "private_act_types": _private_act_types(),
        # Retired day counters — the Life Map's "Retired day counts" card.
        "retired_streaks": streaks.load_streaks("retired"),
    })
    data["dev_notes"] = _load_dev_notes().get("tabs", {}).get("map", [])
    data["idea_notes"] = _load_idea_notes().get("tabs", {}).get("map", [])
    data["tab_todos"] = todos_for_tab("map")
    return jsonify(filter_for_view(data, request.view_mode))
  except Exception as e:
    app.logger.error(f"/api/data/map failed: {e}\n{traceback.format_exc()}")
    return jsonify({"error": str(e)}), 500


@app.route("/api/data/inventory")
def get_data_inventory():
  try:
    data = _common_data()

    buy_list = store.read("buy_list.json", {}).get("items", [])
    active_inventory = store.read("active_inventory.json", {}).get("items", [])
    priority_notes = store.read("priority_notes.json", {}).get("text", "")
    archival_items = store.read("archivals.json", {}).get("items", [])
    if request.view_mode != "authed":
        archival_items = archivals.public_view(archival_items)

    data.update({
        "buy_list": buy_list,
        "active_inventory": active_inventory,
        "priority_notes": priority_notes,
        "archivals": archival_items,
    })
    data["dev_notes"] = _load_dev_notes().get("tabs", {}).get("inventory", [])
    data["idea_notes"] = _load_idea_notes().get("tabs", {}).get("inventory", [])
    data["tab_todos"] = todos_for_tab("inventory")
    return jsonify(filter_for_view(data, request.view_mode))
  except Exception as e:
    app.logger.error(f"/api/data/inventory failed: {e}\n{traceback.format_exc()}")
    return jsonify({"error": str(e)}), 500


@app.route("/api/data/money")
def get_data_money():
  try:
    data = _common_data()

    budget = store.read("budget.json", {"income_monthly": 0, "categories": []})
    expenses = store.read("expenses.json", {}).get("items", [])
    subscriptions = store.read("subscriptions.json", {}).get("items", [])
    receipts_map = store.read("expense_receipts.json", {})
    tax_setaside = store.read("tax_setaside.json", {}).get("items", [])

    data.update({
        "budget": budget,
        "expenses": expenses,
        "subscriptions": subscriptions,
        "receipts_map": receipts_map,
        "tax_setaside": tax_setaside,
    })
    data["dev_notes"] = _load_dev_notes().get("tabs", {}).get("money", [])
    data["idea_notes"] = _load_idea_notes().get("tabs", {}).get("money", [])
    data["tab_todos"] = todos_for_tab("money")
    return jsonify(filter_for_view(data, request.view_mode))
  except Exception as e:
    app.logger.error(f"/api/data/money failed: {e}\n{traceback.format_exc()}")
    return jsonify({"error": str(e)}), 500


@app.route("/api/data/car")
def get_data_car():
  try:
    data = _common_data()
    data.update({
        "car_maintenance": _load_car(),
        "car_notes": _load_car_notes(),
    })
    data["dev_notes"] = _load_dev_notes().get("tabs", {}).get("car", [])
    data["idea_notes"] = _load_idea_notes().get("tabs", {}).get("car", [])
    data["tab_todos"] = todos_for_tab("car")
    return jsonify(filter_for_view(data, request.view_mode))
  except Exception as e:
    app.logger.error(f"/api/data/car failed: {e}\n{traceback.format_exc()}")
    return jsonify({"error": str(e)}), 500


@app.route("/api/data/housing")
def get_data_housing():
  try:
    data = _common_data()
    data["housing"] = store.read("housing.json", {"entries": [], "notes": ""})
    data["dev_notes"] = _load_dev_notes().get("tabs", {}).get("housing", [])
    data["idea_notes"] = _load_idea_notes().get("tabs", {}).get("housing", [])
    data["tab_todos"] = todos_for_tab("housing")
    return jsonify(filter_for_view(data, request.view_mode))
  except Exception as e:
    app.logger.error(f"/api/data/housing failed: {e}\n{traceback.format_exc()}")
    return jsonify({"error": str(e)}), 500


@app.route("/api/data/people")
def get_data_people():
  try:
    # The roster itself comes from /api/people/roster (fetched by people.js);
    # this is just the shared dashboard chrome the tab renderers expect.
    data = _common_data()
    data["dev_notes"] = _load_dev_notes().get("tabs", {}).get("people", [])
    data["idea_notes"] = _load_idea_notes().get("tabs", {}).get("people", [])
    data["tab_todos"] = todos_for_tab("people")
    return jsonify(filter_for_view(data, request.view_mode))
  except Exception as e:
    app.logger.error(f"/api/data/people failed: {e}\n{traceback.format_exc()}")
    return jsonify({"error": str(e)}), 500


@app.route("/api/data/body")
def get_data_body():
  try:
    data = _common_data()
    # Body tab consolidates symptom + food + safety-tag data
    data.update({
        "health_data": load_health_data(),
        "activity_log": _load_activity_log(),
        "meal_defaults": _load_meal_defaults(),
        "food_guide": _food_guide(),
    })
    # Pull catalog (for safety tags) and the safety tags themselves
    kdata = store.read("kitchen.json", {})
    data["kitchen_known_items"] = kdata.get("category_map", {})
    data["kitchen_safety_tags"] = kdata.get("safety_tags", {})
    # Food experiments (elimination diet pacing)
    data["food_tests"] = store.read("food_tests.json", {}).get("tests", [])
    data["food_test_queue"] = store.read("test_queue.json", {}).get("queue", [])
    data["symptom_definitions"] = store.read("symptom_definitions.json", {})
    data["dev_notes"] = _load_dev_notes().get("tabs", {}).get("body", [])
    data["idea_notes"] = _load_idea_notes().get("tabs", {}).get("body", [])
    data["tab_todos"] = todos_for_tab("body")
    return jsonify(filter_for_view(data, request.view_mode))
  except Exception as e:
    app.logger.error(f"/api/data/body failed: {e}\n{traceback.format_exc()}")
    return jsonify({"error": str(e)}), 500


@app.route("/api/data/meditation")
def get_data_meditation():
  try:
    data = _common_data()
    data.update({
        "meditation_log": _load_meditation(),
        "meditation_notes": _load_meditation_notes(),
        "deity_profiles": _load_deity_profiles(),
    })
    data["dev_notes"] = _load_dev_notes().get("tabs", {}).get("meditation", [])
    data["idea_notes"] = _load_idea_notes().get("tabs", {}).get("meditation", [])
    data["tab_todos"] = todos_for_tab("meditation")
    return jsonify(filter_for_view(data, request.view_mode))
  except Exception as e:
    app.logger.error(f"/api/data/meditation failed: {e}\n{traceback.format_exc()}")
    return jsonify({"error": str(e)}), 500


@app.route("/api/data/media")
def get_data_media():
  try:
    data = _common_data()
    data.update({
        "media": _load_media(),
    })
    data["dev_notes"] = _load_dev_notes().get("tabs", {}).get("media", [])
    data["idea_notes"] = _load_idea_notes().get("tabs", {}).get("media", [])
    data["tab_todos"] = todos_for_tab("media")
    return jsonify(filter_for_view(data, request.view_mode))
  except Exception as e:
    app.logger.error(f"/api/data/media failed: {e}\n{traceback.format_exc()}")
    return jsonify({"error": str(e)}), 500


@app.route("/api/data/movement")
def get_data_movement():
  try:
    data = _common_data()
    data.update({
        "movement": _load_movement(),
    })
    data["dev_notes"] = _load_dev_notes().get("tabs", {}).get("movement", [])
    data["idea_notes"] = _load_idea_notes().get("tabs", {}).get("movement", [])
    data["tab_todos"] = todos_for_tab("movement")
    return jsonify(filter_for_view(data, request.view_mode))
  except Exception as e:
    app.logger.error(f"/api/data/movement failed: {e}\n{traceback.format_exc()}")
    return jsonify({"error": str(e)}), 500


@app.route("/api/data/research")
def get_data_research():
  try:
    data = _common_data()
    data.update({
        "research": _load_research(),
    })
    data["dev_notes"] = _load_dev_notes().get("tabs", {}).get("research", [])
    data["idea_notes"] = _load_idea_notes().get("tabs", {}).get("research", [])
    return jsonify(filter_for_view(data, request.view_mode))
  except Exception as e:
    app.logger.error(f"/api/data/research failed: {e}\n{traceback.format_exc()}")
    return jsonify({"error": str(e)}), 500


@app.route("/api/data/ecosystem")
def get_data_ecosystem():
  try:
    data = _common_data()
    data.update({
        "ecosystem": _load_ecosystem(),
    })
    # A light recipe list (no instructions) powers the map's "trace a recipe"
    # picker — ingredients are all the matcher needs. Kept under its OWN key
    # (eco_recipes), not "recipes": the public map exposes this safe subset, while
    # the full "recipes" stream (with instructions, also sent on the public kitchen
    # tab) stays hidden. See public_config.STREAMS.
    data["eco_recipes"] = [
        {"id": r.get("id"), "name": r.get("name"), "ingredients": r.get("ingredients", [])}
        for r in store.read("recipes.json", {}).get("recipes", [])
        if not r.get("is_archived")
    ]
    _eco_cfg = store.read("ecosystem_config", {})
    data["usda_key_set"] = bool((_eco_cfg.get("usda_key") or os.environ.get("EXOCORTEX_USDA_KEY") or "").strip())
    data["dev_notes"] = _load_dev_notes().get("tabs", {}).get("ecosystem", [])
    data["idea_notes"] = _load_idea_notes().get("tabs", {}).get("ecosystem", [])
    data["tab_todos"] = todos_for_tab("ecosystem")
    return jsonify(filter_for_view(data, request.view_mode))
  except Exception as e:
    app.logger.error(f"/api/data/ecosystem failed: {e}\n{traceback.format_exc()}")
    return jsonify({"error": str(e)}), 500


@app.route("/api/data/ideas")
def get_data_ideas():
  try:
    data = _common_data()
    data.update({
        # The by-page overview needs every tab's entries, not just one tab's.
        "idea_notes_all": _load_idea_notes().get("tabs", {}),
        "ideas_md": store.IDEAS_FILE.read_text() if store.IDEAS_FILE.exists() else "",
    })
    data["dev_notes"] = _load_dev_notes().get("tabs", {}).get("ideas", [])
    data["idea_notes"] = _load_idea_notes().get("tabs", {}).get("ideas", [])
    return jsonify(filter_for_view(data, request.view_mode))
  except Exception as e:
    app.logger.error(f"/api/data/ideas failed: {e}\n{traceback.format_exc()}")
    return jsonify({"error": str(e)}), 500


@app.route("/api/data/item-buy")
def get_data_item_buy():
  try:
    data = _common_data()
    name = request.args.get("name", "")
    buy_list = store.read("buy_list.json", {}).get("items", [])
    item = next((i for i in buy_list if i["name"] == name), None)
    active_inventory = store.read("active_inventory.json", {}).get("items", [])

    all_categories = set()
    for i in buy_list + active_inventory:
        c = i.get("category", "").strip()
        if c:
            all_categories.add(c)
    known_categories = sorted(all_categories)

    data.update({
        "buy_item": item,
        "known_categories": known_categories,
    })
    return jsonify(filter_for_view(data, request.view_mode))
  except Exception as e:
    app.logger.error(f"/api/data/item-buy failed: {e}\n{traceback.format_exc()}")
    return jsonify({"error": str(e)}), 500


@app.route("/api/data/kitchen")
def get_data_kitchen():
  try:
    data = _common_data()

    meal_notes = store.read("meal_notes.json", [])

    data.update(_load_kitchen_data())
    data["meal_notes"] = meal_notes
    data["meal_defaults"] = _load_meal_defaults()
    data["dev_notes"] = _load_dev_notes().get("tabs", {}).get("kitchen", [])
    data["idea_notes"] = _load_idea_notes().get("tabs", {}).get("kitchen", [])
    data["tab_todos"] = todos_for_tab("kitchen")

    data["kitchen_trips"] = store.read("kitchen_trips.json", {}).get("trips", [])
    data["recipes"] = store.read("recipes.json", {}).get("recipes", [])
    # Ecosystem sources ride along so a recipe can show where its food comes from
    # (the kitchen "where it comes from" card matches ingredients → placed sources).
    data["ecosystem"] = _load_ecosystem()

    return jsonify(filter_for_view(data, request.view_mode))
  except Exception as e:
    app.logger.error(f"/api/data/kitchen failed: {e}\n{traceback.format_exc()}")
    return jsonify({"error": str(e)}), 500


# --- Legacy endpoint (loads everything) ---

@app.route("/api/data")
def get_data():
  try:
    data = _common_data()

    habits = _load_habits()
    todo_data = load_todos()
    todo_data = roll_todos(todo_data)

    growth_notes = store.read("growth_notes.json", {}).get("items", [])
    supplements = store.read("supplements.json", {}).get("supplements", [])
    buy_list = store.read("buy_list.json", {}).get("items", [])
    runs_data = store.read("runs.json", {"target_per_week": 3, "runs": []})
    kitchen_trips = store.read("kitchen_trips.json", {}).get("trips", [])
    meal_notes = store.read("meal_notes.json", [])
    applications = store.read("shrike_applied.json", [])

    data.update({
        "habits": habits,
        "habit_settings": _load_habit_settings(),
        "habit_starts": _load_habit_starts(),
        "growth_notes": growth_notes,
        "todos": todos_to_sections(todo_data),
        "supplements": supplements,
        "health_data": load_health_data(),
        "contacts": _load_contacts(),
        "buy_list": buy_list,
        "habits_log": _load_habits_log(),
        "habit_cadence": _load_habit_cadence(),
        "cadence_config": _cadence_config(),
        "habit_meta": _load_habit_meta(),
        "runs": runs_data,
        "activity_log": _load_activity_log(),
        "meal_defaults": _load_meal_defaults(),
        "food_guide": _food_guide(),
        "applications": applications,
    })
    data.update(_load_kitchen_data())
    data["meal_notes"] = meal_notes
    data["kitchen_trips"] = kitchen_trips
    return jsonify(data)
  except Exception as e:
    app.logger.error(f"/api/data failed: {e}\n{traceback.format_exc()}")
    return jsonify({"error": str(e)}), 500


# --- VS Code (code-server) launcher ---
import subprocess

VSCODE_MEMORY_THRESHOLD_MB = 1500


def _code_server_running():
    try:
        r = subprocess.run(["systemctl", "is-active", "code-server"],
                           capture_output=True, text=True, timeout=3)
        return r.stdout.strip() == "active"
    except Exception:
        return False


def _memory_status():
    info = {}
    with open("/proc/meminfo") as f:
        for line in f:
            key, _, val = line.partition(":")
            info[key.strip()] = int(val.strip().split()[0])  # kB
    return {
        "total_mb": info["MemTotal"] // 1024,
        "available_mb": info["MemAvailable"] // 1024,
    }


def _top_processes(n=5):
    try:
        r = subprocess.run(
            ["ps", "-eo", "rss,comm", "--sort=-rss", "--no-headers"],
            capture_output=True, text=True, timeout=3,
        )
        agg = {}
        for line in r.stdout.strip().split("\n"):
            parts = line.strip().split(None, 1)
            if len(parts) != 2:
                continue
            rss, comm = parts
            agg[comm] = agg.get(comm, 0) + int(rss)
        top = sorted(agg.items(), key=lambda x: -x[1])[:n]
        return [{"name": name, "mb": kb // 1024} for name, kb in top]
    except Exception:
        return []


# /vscode is a native SPA route now (routes/spa.py); the launcher's API
# endpoints below are unchanged.


@app.route("/api/vscode/status")
def vscode_status():
    mem = _memory_status()
    running = _code_server_running()
    ok_to_start = running or mem["available_mb"] >= VSCODE_MEMORY_THRESHOLD_MB
    return jsonify({
        "running": running,
        "available_mb": mem["available_mb"],
        "total_mb": mem["total_mb"],
        "threshold_mb": VSCODE_MEMORY_THRESHOLD_MB,
        "ok_to_start": ok_to_start,
        "top_processes": _top_processes() if not ok_to_start else [],
    })


@app.route("/api/vscode/start", methods=["POST"])
def vscode_start():
    mem = _memory_status()
    if not _code_server_running() and mem["available_mb"] < VSCODE_MEMORY_THRESHOLD_MB:
        return jsonify({
            "error": "insufficient memory",
            "available_mb": mem["available_mb"],
            "threshold_mb": VSCODE_MEMORY_THRESHOLD_MB,
        }), 409
    try:
        subprocess.run(["systemctl", "start", "code-server"],
                       check=True, timeout=10)
        return jsonify({"ok": True})
    except subprocess.CalledProcessError as e:
        return jsonify({"error": "start failed", "detail": str(e)}), 500


@app.route("/api/vscode/stop", methods=["POST"])
def vscode_stop():
    try:
        subprocess.run(["systemctl", "stop", "code-server"],
                       check=True, timeout=10)
        return jsonify({"ok": True})
    except subprocess.CalledProcessError as e:
        return jsonify({"error": "stop failed", "detail": str(e)}), 500


# --- Register route modules ---
shell.register(app)
spa.register(app)
kitchen.register(app)
habits.register(app)
todos.register(app)
places.register(app)
health.register(app)
inventory.register(app)
archivals.register(app)
money.register(app)
car.register(app)
housing.register(app)
meditation.register(app)
media.register(app)
movement.register(app)
research.register(app)
fronts.register(app)
research_search.register(app)
research_sources.register(app)
research_import.register(app)
research_text.register(app)
annotations.register(app)
reminders.register(app)
food_test.register(app)
terminal.register(app)
if features.enabled("reading_room"):
    # The reading room spawns headless `claude -p` processes as the app user;
    # the flag lets a deployment keep that surface off. Stock installs: on.
    reading_room.register(app)
automations.register(app)


@app.route("/api/features")
def features_snapshot():
    """Read-only resolved feature flags — lets the frontend (and curl) see
    which surfaces this install runs. Toggling happens in the data dir's
    features.json or EXOCORTEX_FEATURE_* env, never through HTTP."""
    return jsonify(features.snapshot())
settings.register(app)
devnotes.register(app)
ideas.register(app)
streaks.register(app)
ecosystem.register(app)
keeper.register(app)
pending.register(app)
profile.register(app)
triage.register(app)
spinoff.register(app)
decisions.register(app)
entities.register(app)
threads.register(app)
person.register(app)
cards.register(app)
wiki.register(app)
travel.register(app)
usage.register(app)
push.register(app)

# --- Startup ---
# Seed the journaling engine (stream.py + friends) into a fresh CONTENT_DIR — see
# store.seed_content_scaffold's docstring. No-op (and untouched) once _system/stream.py
# already exists, so an install pointed at an existing vault/engine is never touched.
store.seed_content_scaffold()
validate_on_startup(app)
import schemas
schemas.install_error_handler(app)

if __name__ == "__main__":
    # PORT override matters on Macs, where AirPlay Receiver squats on 5000.
    app.run(debug=True, port=int(os.environ.get("PORT", "5000")))
