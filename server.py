from flask import Flask, render_template, jsonify, request, session, redirect
from werkzeug.middleware.proxy_fix import ProxyFix
from pathlib import Path
import json
import hashlib
import secrets
import bcrypt
import traceback
from datetime import datetime, timedelta

from data_helpers import (
    BUILD_DIR, DATA_DIR, CONTENT_DIR,
    parse_md_sections, load_health_data,
    load_todos, roll_todos, todos_to_sections,
    validate_on_startup, sweep_uploads_throttled,
)
from public_config import filter_for_view, is_public_path
import store
import config
from routes import (
    kitchen, habits, todos, places, health, inventory, money, car,
    meditation, media, movement, reminders, food_test, terminal, settings,
    devnotes,
)

app = Flask(__name__)
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1)
app.config['TEMPLATES_AUTO_RELOAD'] = True

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
    ("%(asctime)s %(message)s", "%H:%M:%S"),
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
    ph = bcrypt.hashpw(config.DEFAULT_PASSWORD.encode(), bcrypt.gensalt()).decode()
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


@app.before_request
def gate():
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


# App version — single source of truth for the version label shown in the UI
# (dashboard footer, public header, fake-terminal banner). Bump here only.
APP_VERSION = "0.6"


@app.context_processor
def inject_app_version():
    return {"app_version": APP_VERSION, "app_name": config.APP_NAME, "owner_name": config.OWNER_NAME}


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
import time
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
    return "", 204


@app.route("/api/auth/change-password", methods=["POST"])
def api_change_password():
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


VALID_TABS = ("today", "map", "kitchen", "inventory", "money", "car", "meditation", "media", "movement", "body")

# Path to the file that backs the public homepage fake-terminal intro.
PUBLIC_INTRO_PATH = CONTENT_DIR / "public_intro.md"


def _render_inline(s):
    """Escape HTML and convert `code` spans into cc-file styling."""
    import html as _html
    import re as _re
    s = _html.escape(s)
    return _re.sub(r"`([^`]+)`", r'<span class="cc-file">\1</span>', s)


def _load_public_intro_html():
    """Read tulku/public_intro.md and render it to HTML for the fake terminal.

    Conventions:
      - Paragraphs separated by blank lines.
      - A paragraph whose lines all start with ⎿ becomes a block of `cc-tool` lines.
      - A single-line paragraph wrapped in _..._ becomes a dim italic intro (`cc-p cc-dim`).
      - Everything else is a normal `cc-p` paragraph.
    You edit the .md file directly; template auto-reload picks it up.
    """
    if not PUBLIC_INTRO_PATH.exists():
        return ""
    text = PUBLIC_INTRO_PATH.read_text().strip()
    blocks = []
    for para in text.split("\n\n"):
        para = para.strip()
        if not para:
            continue
        lines = [ln for ln in para.split("\n") if ln.strip()]
        if lines and all(ln.strip().startswith("⎿") for ln in lines):
            rendered = []
            for ln in lines:
                body = _render_inline(ln.strip()[1:].lstrip())
                rendered.append(f'<div class="cc-tool">⎿  {body}</div>')
            blocks.append("\n".join(rendered))
        elif len(lines) == 1 and lines[0].startswith("_") and lines[0].endswith("_"):
            body = _render_inline(lines[0][1:-1])
            blocks.append(f'<p class="cc-p cc-dim">{body}</p>')
        else:
            body = _render_inline(" ".join(lines))
            blocks.append(f'<p class="cc-p">{body}</p>')
    return "\n".join(blocks)


def _split_response(active_tab, item_name=""):
    public_intro_html = _load_public_intro_html() if request.view_mode == "public" else ""
    resp = app.make_response(render_template(
        "split.html",
        active_tab=active_tab,
        item_name=item_name,
        public_intro_html=public_intro_html,
    ))
    resp.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    return resp


# Page shells — each URL renders split.html with the right active tab.
# The URL path can differ from the tab key (e.g. /car-maintenance → "car"),
# and a tab can answer to several paths (today is both / and /dashboard).
_SPLIT_PAGES = [
    (("/", "/dashboard"), "today"),
    ("/map", "map"),
    ("/kitchen", "kitchen"),
    ("/inventory", "inventory"),
    ("/money", "money"),
    ("/car-maintenance", "car"),
    ("/meditation", "meditation"),
    ("/media", "media"),
    ("/movement", "movement"),
    ("/body", "body"),
]


def _make_split_page(tab):
    def view():
        return _split_response(tab)
    return view


for _rules, _tab in _SPLIT_PAGES:
    _view = _make_split_page(_tab)
    for _rule in ((_rules,) if isinstance(_rules, str) else _rules):
        app.add_url_rule(_rule, endpoint=f"split_{_tab}", view_func=_view)


@app.route("/personality")
def personality_page():
    return render_template("personality.html")


@app.route("/settings")
def settings_page():
    return render_template("settings.html")


@app.route("/item/buy/<path:name>")
def split_item_buy(name):
    return _split_response("inventory", item_name=name)


@app.route("/tab/<name>")
def tab_view(name):
    """Iframe content endpoint — renders index.html for the given tab."""
    if name not in VALID_TABS:
        return redirect("/")
    item_name = request.args.get("item", "")
    resp = app.make_response(render_template("index.html", active_tab=name, item_name=item_name))
    resp.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    return resp


@app.route("/about")
def about_page():
    return render_template("about.html")


# --- Dev Notes (per-tab friction log) — routes live in routes/devnotes.py ---

_load_dev_notes = devnotes.load_dev_notes


# --- Journal ---

@app.route("/journal-view")
def journal_view():
    return render_template("journal.html")


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
    path.write_text(content)
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
    PERSONALITY_PATH.parent.mkdir(parents=True, exist_ok=True)
    PERSONALITY_PATH.write_text(content)
    return jsonify({"ok": True})


# --- Data loading helpers ---

FOOD_GUIDE = {
    "safe": ["chicken", "white rice", "kale", "sweet potato", "carrots", "parsnips",
              "zucchini", "cucumber", "tahini", "rice cakes", "salad"],
    "hurts": ["chocolate covered coconut", "soy sauce", "olives", "pickled okra"],
    "unsure": ["sunflower seeds", "pumpkin seeds", "sweet potato chips"],
    "inflammatory": []
}


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
        "streaks": _load_streaks(),
    }


def _load_streaks():
    """User-defined milestone counters shown in the header.

    streaks.json: {"streaks": [{"label": "off weed", "since": "2026-02-22"}, ...]}
    Each becomes "Day N <label>" where N is days since `since`. Empty by default.
    """
    out = []
    today = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
    for s in store.read("streaks.json", {}).get("streaks", []):
        label = str(s.get("label", "")).strip()
        since = str(s.get("since", "")).strip()
        if not (label and since):
            continue
        try:
            start = datetime.strptime(since, "%Y-%m-%d")
        except ValueError:
            continue
        out.append({"label": label, "days": (today - start).days, "since": since})
    return out


@app.route("/api/streaks/add", methods=["POST"])
def add_streak():
    data = request.json or {}
    label = (data.get("label") or "").strip()
    since = (data.get("since") or "").strip()
    if not label or not since:
        return jsonify({"error": "label and date required"}), 400
    try:
        datetime.strptime(since, "%Y-%m-%d")
    except ValueError:
        return jsonify({"error": "date must be YYYY-MM-DD"}), 400
    d = store.read("streaks.json", {"streaks": []})
    d.setdefault("streaks", []).append({"label": label, "since": since})
    store.write("streaks.json", d)
    return jsonify({"ok": True})


@app.route("/api/streaks/remove", methods=["POST"])
def remove_streak():
    data = request.json or {}
    label = (data.get("label") or "").strip()
    since = (data.get("since") or "").strip()
    d = store.read("streaks.json", {"streaks": []})
    d["streaks"] = [s for s in d.get("streaks", [])
                    if not (str(s.get("label", "")).strip() == label and str(s.get("since", "")).strip() == since)]
    store.write("streaks.json", d)
    return jsonify({"ok": True})


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
    return store.read("habits_log.json", {})


def _load_habits():
    habits_path = CONTENT_DIR / "HABITS.md"
    return parse_md_sections(habits_path) if habits_path.exists() else []


def _load_habit_settings():
    return store.read("habit_settings.json", {"hidden": []})


def _load_habit_starts():
    return store.read("habit_start_dates.json", {})


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
        "health_data": load_health_data(),
        "contacts": _load_contacts(),
        "applications": applications,
        "meal_defaults": _load_meal_defaults(),
        "food_guide": FOOD_GUIDE,
        "activity_log": _load_activity_log(),
        "reminders": _load_reminders(),
        "private_act_types": _private_act_types(),
    })
    data["dev_notes"] = _load_dev_notes().get("tabs", {}).get("today", [])
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
        "habits": _load_habits(),
        "habit_starts": _load_habit_starts(),
        "habit_settings": _load_habit_settings(),
        "supplements": supplements,
        "runs": runs_data,
        "kitchen_trips": kitchen_trips,
        "activity_log": _load_activity_log(),
        "meal_defaults": _load_meal_defaults(),
        "food_guide": FOOD_GUIDE,
        "contacts": _load_contacts(),
        "reminders": _load_reminders(),
        "private_act_types": _private_act_types(),
    })
    data["dev_notes"] = _load_dev_notes().get("tabs", {}).get("map", [])
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

    data.update({
        "buy_list": buy_list,
        "active_inventory": active_inventory,
        "priority_notes": priority_notes,
    })
    data["dev_notes"] = _load_dev_notes().get("tabs", {}).get("inventory", [])
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
    return jsonify(filter_for_view(data, request.view_mode))
  except Exception as e:
    app.logger.error(f"/api/data/car failed: {e}\n{traceback.format_exc()}")
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
        "food_guide": FOOD_GUIDE,
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
    return jsonify(filter_for_view(data, request.view_mode))
  except Exception as e:
    app.logger.error(f"/api/data/movement failed: {e}\n{traceback.format_exc()}")
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

    data["kitchen_trips"] = store.read("kitchen_trips.json", {}).get("trips", [])
    data["recipes"] = store.read("recipes.json", {}).get("recipes", [])

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
        "runs": runs_data,
        "activity_log": _load_activity_log(),
        "meal_defaults": _load_meal_defaults(),
        "food_guide": FOOD_GUIDE,
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


@app.route("/vscode")
def vscode_launcher():
    return render_template("vscode_launcher.html")


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
kitchen.register(app)
habits.register(app)
todos.register(app)
places.register(app)
health.register(app)
inventory.register(app)
money.register(app)
car.register(app)
meditation.register(app)
media.register(app)
movement.register(app)
reminders.register(app)
food_test.register(app)
terminal.register(app)
settings.register(app)
devnotes.register(app)

# --- Startup ---
validate_on_startup(app)

if __name__ == "__main__":
    app.run(debug=True, port=5000)
