"""Day-counter ("streak") routes — the "Day N off X" chips on the Today tab.

streaks.json: {"streaks": [{...}]}, one entry per counter:

    label        display text ("off weed") — "Day N <label>"
    since        YYYY-MM-DD the count started; N = days since
    notes        freeform description (dosage, context) — NOT the note log
    id           stable identity (back-filled for legacy label+since entries)
    slug         url/tag-safe name minted from the label; the counter's pool
                 tag is "counter-<slug>" (see notes_tag) — note cells are REAL
                 journal cards carrying that tag, so they weave into the daily
                 journal for free and inherit the thread surfaces' rolling
                 24-hour edit window (routes/threads.py _card_editable)
    status       "active" | "retired" (absent = active, back-filled)
    habit_key    optional "section|text" link to a habit (habit_log_key
                 convention); routes/habits.py's rename/move key-rewrite also
                 rewrites this so the link survives renames
    retired_on / retired_time / retired_note
                 stamped by /api/streaks/retire; the journal engine
                 (tools/stream/stream.py) weaves a "⏹ retired day count" marker
                 into that day, exactly like to-do completion markers

Active counters ride on /api/data/today (server.py _common_data); retired ones
ride on /api/data/map for the Life Map's Retired card. A retired counter's
"days" is frozen at retired_on - since.
"""
import re
import uuid
from datetime import datetime

from flask import request, jsonify

import store
from routes.entities import _parse_frontmatter
# Same fire-and-forget day re-render the to-do completion facts use — a retire/
# un-retire changes what the journal engine weaves into that day.
from routes.todos import _rerender_days

_SLUG_RE = re.compile(r"[^a-z0-9]+")
# "counter-" + slug must satisfy the card-tag grammar (^[a-z0-9-]{1,40}$).
_SLUG_MAX = 30


def notes_tag(slug):
    """The pool tag a counter's note cards carry."""
    return f"counter-{slug}"


def _mint_slug(label, taken):
    base = _SLUG_RE.sub("-", (label or "").lower()).strip("-")[:_SLUG_MAX] or "counter"
    slug, n = base, 2
    while slug in taken:
        slug = f"{base[:_SLUG_MAX - 3]}-{n}"
        n += 1
    return slug


def _ensure_shape(d):
    """Back-fill id/slug/status on legacy {label, since} entries. Returns True
    if anything changed (caller persists)."""
    changed = False
    entries = d.get("streaks", [])
    taken = {s.get("slug") for s in entries if s.get("slug")}
    for s in entries:
        if not s.get("id"):
            s["id"] = uuid.uuid4().hex[:12]
            changed = True
        if not s.get("slug"):
            s["slug"] = _mint_slug(s.get("label", ""), taken)
            taken.add(s["slug"])
            changed = True
        if s.get("status") not in ("active", "retired"):
            s["status"] = "active"
            changed = True
    return changed


def _read():
    d = store.read("streaks.json", {"streaks": []})
    d.setdefault("streaks", [])
    if _ensure_shape(d):
        store.write("streaks.json", d)
    return d


def _find(d, data):
    """Locate one entry: by id when given, else the legacy label+since
    composite (kept so pre-id clients/tests still work)."""
    sid = (data.get("id") or "").strip()
    label = (data.get("label") or "").strip()
    since = (data.get("since") or "").strip()
    for s in d.get("streaks", []):
        if sid and s.get("id") == sid:
            return s
        if not sid and str(s.get("label", "")).strip() == label \
                and str(s.get("since", "")).strip() == since:
            return s
    return None


def _view(s, today):
    """One counter as the API serves it. Active: days ticks with today.
    Retired: days frozen at retired_on - since."""
    out = {
        "id": s.get("id"), "slug": s.get("slug"),
        "label": str(s.get("label", "")).strip(),
        "since": str(s.get("since", "")).strip(),
        "notes": str(s.get("notes", "")),
        "status": s.get("status", "active"),
        "habit_key": s.get("habit_key") or None,
        "tag": notes_tag(s.get("slug", "")),
    }
    try:
        start = datetime.strptime(out["since"], "%Y-%m-%d")
    except ValueError:
        return None
    if out["status"] == "retired":
        for k in ("retired_on", "retired_time", "retired_note"):
            out[k] = s.get(k) or None
        try:
            end = datetime.strptime(s.get("retired_on", ""), "%Y-%m-%d")
        except ValueError:
            end = today
        out["days"] = (end - start).days
    else:
        out["days"] = (today - start).days
    return out


def load_streaks(status="active"):
    """Computed counter list for the data payloads. status: "active",
    "retired", or "all". Entries missing label/since or with an unparseable
    date are skipped, same as the old server.py loader."""
    today = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
    out = []
    for s in _read().get("streaks", []):
        if not (str(s.get("label", "")).strip() and str(s.get("since", "")).strip()):
            continue
        if status != "all" and s.get("status", "active") != status:
            continue
        v = _view(s, today)
        if v is not None:
            out.append(v)
    return out


def rewrite_habit_links(old_key, new_key):
    """Follow a habit rename/section-move: any counter linked to old_key now
    points at new_key. Called from routes/habits.py's _rewrite_log_keys so the
    link can never silently break."""
    with store.mutate("streaks.json", {"streaks": []}) as d:
        for s in d.get("streaks", []):
            if s.get("habit_key") == old_key:
                s["habit_key"] = new_key


# --- note cells: pool cards tagged counter-<slug> ---------------------------

_CARD_TS_FMT = "%Y-%m-%d %H:%M:%S"


def _card_editable(ts):
    """Rolling last-24-hours edit window, SERVER clock — same rule as
    routes/threads.py's _card_editable (thread journal cells)."""
    from datetime import timedelta
    if not ts:
        return False
    try:
        datetime.strptime(ts, _CARD_TS_FMT)
    except ValueError:
        return False
    cutoff = (datetime.now() - timedelta(hours=24)).strftime(_CARD_TS_FMT)
    return ts >= cutoff


def _pool_dir():
    return store.CONTENT_DIR.resolve() / "_system" / "data" / "cards"


def _note_cards(tag):
    """Every B-authored pool card carrying `tag`, ascending by ts. Keeper
    cards are excluded — same call as the thread journal (her record, not the
    keeper's commentary)."""
    pool = _pool_dir()
    out = []
    if not pool.exists():
        return out
    for p in pool.glob("*.md"):
        try:
            text = p.read_text()
        except OSError:
            continue
        meta, body = _parse_frontmatter(text)
        tags = meta.get("tags", [])
        if not isinstance(tags, list):
            tags = [tags] if tags else []
        if tag not in [str(t).lower() for t in tags]:
            continue
        if meta.get("who") == "K":
            continue
        ts = meta.get("ts", "")
        out.append({
            "id": meta.get("id") or p.stem,
            "ts": ts,
            "body": body.strip("\n"),
            "editable": _card_editable(ts),
        })
    out.sort(key=lambda c: (c["ts"], c["id"]))
    return out


def register(app):

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
        d = _read()
        taken = {s.get("slug") for s in d["streaks"] if s.get("slug")}
        d["streaks"].append({
            "id": uuid.uuid4().hex[:12], "slug": _mint_slug(label, taken),
            "label": label, "since": since, "status": "active",
        })
        store.write("streaks.json", d)
        return jsonify({"ok": True})

    @app.route("/api/streaks/update", methods=["POST"])
    def update_streak():
        """Update a counter's description notes and/or habit link. Identified
        by id (preferred) or the legacy label+since composite."""
        data = request.json or {}
        d = _read()
        s = _find(d, data)
        if s is None:
            return jsonify({"error": "streak not found"}), 404
        if "notes" in data:
            s["notes"] = data.get("notes", "")
        if "habit_key" in data:
            key = (data.get("habit_key") or "").strip()
            if key:
                s["habit_key"] = key
            else:
                s.pop("habit_key", None)
        store.write("streaks.json", d)
        return jsonify({"ok": True})

    @app.route("/api/streaks/remove", methods=["POST"])
    def remove_streak():
        data = request.json or {}
        d = _read()
        s = _find(d, data)
        if s is None:
            return jsonify({"error": "streak not found"}), 404
        d["streaks"] = [x for x in d["streaks"] if x is not s]
        store.write("streaks.json", d)
        _rerender_days(s.get("retired_on"))
        return jsonify({"ok": True})

    @app.route("/api/streaks/retire", methods=["POST"])
    def retire_streak():
        """End a counter: freeze the count, stamp when, carry her note. The
        journal engine weaves the "⏹ retired day count" marker into that day
        (fire-and-forget re-render, same as to-do completion facts)."""
        data = request.json or {}
        d = _read()
        s = _find(d, data)
        if s is None:
            return jsonify({"error": "streak not found"}), 404
        if s.get("status") == "retired":
            return jsonify({"error": "already retired"}), 400
        now = datetime.now()
        s["status"] = "retired"
        s["retired_on"] = now.strftime("%Y-%m-%d")
        s["retired_time"] = now.strftime("%H:%M")
        note = (data.get("note") or "").strip()
        if note:
            s["retired_note"] = note
        store.write("streaks.json", d)
        _rerender_days(s["retired_on"])
        return jsonify({"ok": True, "retired_on": s["retired_on"]})

    @app.route("/api/streaks/unretire", methods=["POST"])
    def unretire_streak():
        """Bring a retired counter back to the Today tab. The old marker day
        re-renders so the weave disappears with the fact."""
        data = request.json or {}
        d = _read()
        s = _find(d, data)
        if s is None:
            return jsonify({"error": "streak not found"}), 404
        if s.get("status") != "retired":
            return jsonify({"error": "not retired"}), 400
        old_day = s.get("retired_on")
        s["status"] = "active"
        for k in ("retired_on", "retired_time", "retired_note"):
            s.pop(k, None)
        store.write("streaks.json", d)
        _rerender_days(old_day)
        return jsonify({"ok": True})

    @app.route("/api/streaks/<slug>/notes")
    def streak_notes(slug):
        """The counter's note cells — pool cards tagged counter-<slug>, with
        the 24h `editable` flag. Appending goes through /api/cards/add with
        that tag; the cells are ordinary journal cards."""
        slug = (slug or "").strip().lower()
        d = _read()
        s = next((x for x in d["streaks"] if x.get("slug") == slug), None)
        if s is None:
            return jsonify({"error": "streak not found"}), 404
        return jsonify({"slug": slug, "tag": notes_tag(slug),
                        "notes": _note_cards(notes_tag(slug))})
