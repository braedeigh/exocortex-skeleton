"""Fronts routes — a shared life-domain vocabulary (health, appearance,
finances, ...) that research topics get tagged with.

    {"fronts": [{"id", "name", "created"}]}

Front ids are slugified names, same collision handling as research topic ids
(see routes/research.py). Removing a front strips its id from every research
topic's `fronts` list (routes/research.py) — the topics survive, they just
lose that tag.

`/api/fronts/overview` counts how many live things sit on each front across
every surface that tags with this vocabulary — to-dos, threads, the buy list,
research topics. It's the feed for the Fronts overview page
(frontend/src/features/fronts/), which draws each front sized by its real
weight, so the page is a picture of where a life currently is rather than a
menu. Read-only and derived per request; nothing here is stored.

Prompt that produced the overview endpoint: "a front overview — all twelve
fronts on one surface, each sized by its real weight ... not a menu, a picture
of where things currently are."
"""
import re
from datetime import datetime

from flask import request, jsonify

import store


def _slugify(name):
    slug = re.sub(r"[^a-z0-9]+", "-", name.strip().lower()).strip("-")
    return slug or "front"


def _unique_id(base, taken):
    if base not in taken:
        return base
    i = 2
    while f"{base}-{i}" in taken:
        i += 1
    return f"{base}-{i}"


def _now_stamp():
    return datetime.now().strftime("%Y-%m-%d %H:%M")


def _blob(data):
    return jsonify({"fronts": data.get("fronts", [])})


# --- overview counting -------------------------------------------------------
# Every surface below tags with the SAME `fronts` list (a thing can sit on
# several fronts at once, so these counts can sum to more than the number of
# things). Each collector yields one fronts-list per LIVE item; what counts as
# live differs per surface, which is why they aren't one loop.

def _item_fronts(obj):
    """The `fronts` list off any tagged record, normalized to a list of ids."""
    fronts = obj.get("fronts")
    return [f for f in fronts if f] if isinstance(fronts, list) else []


def _todo_front_lists():
    """Open to-dos. Skips the `done` ladder rung and any item flagged done —
    matches what the to-do page's own chip counts consider live."""
    data = store.read("todos", {}) or {}
    for section, block in data.items():
        if section == "done" or not isinstance(block, dict):
            continue
        for item in block.get("items", []):
            if isinstance(item, dict) and not item.get("done"):
                yield _item_fronts(item)


def _thread_front_lists():
    """Active threads (retired ones excluded). Threads live as markdown in the
    vault, so this leans on routes/threads.py's parser; if the vault or the
    Threads dir isn't there, it degrades to no threads rather than 500ing."""
    try:
        from routes import threads as threads_mod
        index = threads_mod._all_threads()
    except Exception:
        return
    for thread in index.values():
        yield _item_fronts(thread)


def _buy_list_front_lists():
    """Buy-list items — no bought/done flag on these, so all of them are live."""
    data = store.read("buy_list.json", {"items": []}) or {}
    for item in data.get("items", []):
        if isinstance(item, dict):
            yield _item_fronts(item)


def _research_front_lists():
    """Research TOPICS only. Entries hang off a topic and carry no fronts of
    their own, so counting them here would double-count the topic's tag."""
    data = store.read("research.json", {"topics": [], "entries": []}) or {}
    for topic in data.get("topics", []):
        if isinstance(topic, dict):
            yield _item_fronts(topic)


# --- room layouts -------------------------------------------------------------
# Panel geometry is stored in GRID CELLS, never pixels: a room is a 12-column
# grid, so one saved arrangement holds up at any window width instead of needing
# a layout per breakpoint. Narrow screens ignore the geometry entirely and stack
# the panels in reading order (see roomLayout.ts).

LAYOUT_COLLECTION = "front_layouts.json"
ROOM_COLUMNS = 12
ROOM_MAX_ROWS = 60
PANEL_MIN_W = 2
PANEL_MIN_H = 2


def _clean_panels(raw):
    """Validate a posted layout. Returns (cleaned, bad_keys).

    Geometry is clamped rather than trusted: a panel that arrives off-grid gets
    pulled back on rather than being saved somewhere the room can't render it.
    Anything structurally wrong (not a dict, non-numeric fields) is reported as
    a bad key so a broken client gets a 400 instead of silently losing panels.
    """
    if raw in (None, {}):
        return {}, set()
    if not isinstance(raw, dict):
        return {}, {"panels"}

    cleaned = {}
    bad = set()
    for key, box in raw.items():
        if not isinstance(box, dict):
            bad.add(str(key))
            continue
        try:
            x, y = int(box["x"]), int(box["y"])
            w, h = int(box["w"]), int(box["h"])
        except (KeyError, TypeError, ValueError):
            bad.add(str(key))
            continue
        w = max(PANEL_MIN_W, min(w, ROOM_COLUMNS))
        h = max(PANEL_MIN_H, min(h, ROOM_MAX_ROWS))
        x = max(0, min(x, ROOM_COLUMNS - w))
        y = max(0, min(y, ROOM_MAX_ROWS - h))
        cleaned[str(key)] = {"x": x, "y": y, "w": w, "h": h}
    return cleaned, bad


OVERVIEW_SOURCES = (
    ("todos", _todo_front_lists),
    ("threads", _thread_front_lists),
    ("buy_list", _buy_list_front_lists),
    ("research", _research_front_lists),
)


def build_overview():
    """Per-front counts across every front-tagged surface.

    Returns the fronts in `fronts.json` order, each with a per-source
    breakdown and a total. `untagged` counts live things carrying no front at
    all — the honest denominator, so the page can say how much of a surface
    the picture actually covers. An id found in the data but missing from the
    vocabulary is reported under `orphans` instead of being silently dropped:
    that state is invisible in the to-do chip bar (chips are rendered by
    mapping over the vocabulary), and it should never be invisible twice.
    """
    vocab = store.read("fronts.json", {"fronts": []}).get("fronts", [])
    known = {f["id"] for f in vocab if isinstance(f, dict) and f.get("id")}

    counts = {fid: {name: 0 for name, _ in OVERVIEW_SOURCES} for fid in known}
    untagged = {}
    totals = {}
    orphans = {}

    for source_name, collector in OVERVIEW_SOURCES:
        live = 0
        blank = 0
        for fronts in collector():
            live += 1
            if not fronts:
                blank += 1
                continue
            for fid in fronts:
                if fid in counts:
                    counts[fid][source_name] += 1
                else:
                    orphans[fid] = orphans.get(fid, 0) + 1
        untagged[source_name] = blank
        totals[source_name] = live

    out = []
    for front in vocab:
        if not isinstance(front, dict) or not front.get("id"):
            continue
        per_source = counts[front["id"]]
        out.append({
            "id": front["id"],
            "name": front.get("name") or front["id"],
            "sources": dict(per_source),
            "total": sum(per_source.values()),
        })

    return {
        "fronts": out,
        "sources": [name for name, _ in OVERVIEW_SOURCES],
        "untagged": untagged,
        "totals": totals,
        "orphans": orphans,
    }


# --- sessions on a front -------------------------------------------------------
# A session gets its front one of two ways, and the difference matters:
#
#   EXPLICIT — written onto the index entry at creation, because she started
#     the session standing in that front's room. No inference, no lag, no cost.
#   INFERRED — guessed after the fact by scripts/sort_bot_chats.py, which runs a
#     headless Claude turn over the finished transcript and files the result in
#     the bot_chats/gists sidecar.
#
# Explicit ALWAYS wins. This is the same precedence to-dos use (see
# todoHelpers.withFocusFront: the active chip only fills a blank, an item that
# declares its own fronts keeps them), and it's what stops a re-run of the
# sorter from quietly overwriting a filing she made on purpose.

BRIEF_DIRNAME = "front_briefs"


def resolve_session_front(entry, gist):
    """(front_id, source) for one session. source is 'explicit' | 'inferred' | ''."""
    if isinstance(entry, dict):
        explicit = entry.get("front")
        if isinstance(explicit, str) and explicit:
            return explicit, "explicit"
    if isinstance(gist, dict):
        inferred = gist.get("front")
        if isinstance(inferred, str) and inferred:
            return inferred, "inferred"
    return "", ""


def sessions_for_front(front_id):
    """Every session filed to a front, newest activity first.

    Reads the index and the gists sidecar defensively — a missing or malformed
    either-one degrades to "no sessions" rather than 500ing a room.
    """
    index = store.read("bot_chats/index", {})
    gists = store.read("bot_chats/gists", {})
    if not isinstance(index, dict):
        return []
    if not isinstance(gists, dict):
        gists = {}

    out = []
    for conv_id, entry in index.items():
        if not isinstance(entry, dict):
            continue
        gist = gists.get(conv_id)
        front, source = resolve_session_front(entry, gist)
        if front != front_id:
            continue
        blurb = gist.get("gist") if isinstance(gist, dict) else None
        out.append({
            "id": conv_id,
            "title": entry.get("title") or (gist or {}).get("title") or "Untitled",
            "source": source,
            "last_at": entry.get("last_at") or entry.get("started") or "",
            "started": entry.get("started") or "",
            "lane": entry.get("lane") or "",
            "running": entry.get("running") is True,
            # The one-line "where you left off" the panel shows under the title.
            "gist": (blurb or "")[:280],
        })
    out.sort(key=lambda s: s["last_at"], reverse=True)
    return out


# --- the front brief (what a seeded session opens knowing) ---------------------

def _brief_dir():
    path = store.DATA_DIR / BRIEF_DIRNAME
    path.mkdir(parents=True, exist_ok=True)
    return path


def build_front_brief(front_id):
    """The markdown a session started in this front's room opens with.

    A snapshot, deliberately: it's written when the conversation starts and
    describes the front as it stood at that moment. That's the honest framing —
    it's the room telling the session where it is, not a live feed — so the
    brief says so in its own text rather than letting a stale list read as
    current.
    """
    vocab = store.read("fronts.json", {"fronts": []}).get("fronts", [])
    front = next((f for f in vocab if isinstance(f, dict) and f.get("id") == front_id), None)
    if not front:
        return ""
    name = front.get("name") or front_id

    lines = [
        f"# Working front: {name}",
        "",
        f"This session was started from the **{name}** room, so it's filed to that "
        f"front and is about that part of her life unless she says otherwise.",
        "",
        "The lists below are a **snapshot from when this session started** — they "
        "are not live. Re-read the underlying files if precision matters.",
        "",
    ]

    todos = store.read("todos", {}) or {}
    rungs = [("now", "Now"), ("up_next", "Up next"), ("later", "Later"), ("someday", "Someday")]
    todo_lines = []
    for key, label in rungs:
        block = todos.get(key)
        if not isinstance(block, dict):
            continue
        items = [
            it for it in block.get("items", [])
            if isinstance(it, dict) and not it.get("done") and front_id in (it.get("fronts") or [])
        ]
        if not items:
            continue
        todo_lines.append(f"**{label}**")
        for it in items:
            note = f" — {it['notes']}" if it.get("notes") else ""
            todo_lines.append(f"- {it.get('text', '')}{note}")
        todo_lines.append("")
    if todo_lines:
        lines.append("## Open to-dos on this front")
        lines.append("")
        lines.extend(todo_lines)

    buy = store.read("buy_list.json", {"items": []}) or {}
    buy_items = [
        it for it in buy.get("items", [])
        if isinstance(it, dict) and front_id in (it.get("fronts") or [])
    ]
    if buy_items:
        lines.append("## On the buy list for this front")
        lines.append("")
        for it in buy_items:
            bits = [it.get("name", "")]
            if it.get("cost"):
                bits.append(f"({it['cost']})")
            if it.get("where"):
                bits.append(f"— {it['where']}")
            lines.append(f"- {' '.join(b for b in bits if b)}")
        lines.append("")

    threads = []
    try:
        from routes import threads as threads_mod
        threads = [
            t for t in threads_mod._all_threads().values()
            if front_id in (t.get("fronts") or [])
        ]
    except Exception:
        threads = []
    if threads:
        lines.append("## Threads on this front")
        lines.append("")
        for t in threads:
            lines.append(f"- {t.get('name') or t.get('id')}")
        lines.append("")

    return "\n".join(lines).rstrip() + "\n"


def write_front_brief(front_id):
    """Write the brief to disk and return its path, or None if there's no such
    front / nothing to say. The path is what goes on the session's
    `system_prompt_file`, which routes/observatory.py hands to
    `--append-system-prompt-file` at spawn time."""
    text = build_front_brief(front_id)
    if not text.strip():
        return None
    path = _brief_dir() / f"{front_id}.md"
    path.write_text(text)
    return str(path)


def is_known_front(front_id):
    vocab = store.read("fronts.json", {"fronts": []}).get("fronts", [])
    return any(isinstance(f, dict) and f.get("id") == front_id for f in vocab)


def register(app):

    @app.route("/api/fronts")
    def get_fronts():
        data = store.read("fronts.json", {"fronts": []})
        return _blob(data)

    @app.route("/api/fronts/overview")
    def fronts_overview():
        return jsonify(build_overview())

    @app.route("/api/fronts/<front_id>/sessions")
    def front_sessions(front_id):
        return jsonify({"front": front_id, "sessions": sessions_for_front(front_id)})

    @app.route("/api/fronts/<front_id>/brief")
    def front_brief(front_id):
        """The brief a session started here would open with — exposed so she
        can see exactly what a room hands a new conversation, rather than it
        being invisible context."""
        if not is_known_front(front_id):
            return jsonify({"error": "unknown front"}), 404
        return jsonify({"front": front_id, "brief": build_front_brief(front_id)})

    @app.route("/api/fronts/layout/<front_id>")
    def get_front_layout(front_id):
        data = store.read(LAYOUT_COLLECTION, {"layouts": {}})
        return jsonify({"front": front_id, "panels": data.get("layouts", {}).get(front_id, {})})

    @app.route("/api/fronts/layout/<front_id>", methods=["POST"])
    def save_front_layout(front_id):
        body = request.json or {}
        panels, bad = _clean_panels(body.get("panels"))
        if bad:
            return jsonify({"error": f"bad geometry for: {', '.join(sorted(bad))}"}), 400
        with store.mutate(LAYOUT_COLLECTION, {"layouts": {}}) as data:
            layouts = data.setdefault("layouts", {})
            if panels:
                layouts[front_id] = panels
            else:
                # An empty save means "forget my arrangement" — drop the entry
                # so the room falls back to the auto-tiled default rather than
                # persisting an empty object that reads as "no panels".
                layouts.pop(front_id, None)
        return jsonify({"front": front_id, "panels": panels})

    @app.route("/api/fronts/add", methods=["POST"])
    def add_front():
        body = request.json or {}
        name = (body.get("name") or "").strip()
        if not name:
            return jsonify({"error": "missing name"}), 400
        with store.mutate("fronts.json", {"fronts": []}) as data:
            fronts = data.setdefault("fronts", [])
            fid = _unique_id(_slugify(name), {f["id"] for f in fronts})
            fronts.append({"id": fid, "name": name, "created": _now_stamp()})
        return _blob(data)

    @app.route("/api/fronts/edit", methods=["POST"])
    def edit_front():
        body = request.json or {}
        fid = body.get("id")
        with store.mutate("fronts.json", {"fronts": []}) as data:
            front = next((f for f in data.get("fronts", []) if f["id"] == fid), None)
            if not front:
                return jsonify({"error": "not found"}), 404
            if "name" in body:
                name = (body.get("name") or "").strip()
                if not name:
                    return jsonify({"error": "name cannot be empty"}), 400
                front["name"] = name
        return _blob(data)

    @app.route("/api/fronts/remove", methods=["POST"])
    def remove_front():
        body = request.json or {}
        fid = body.get("id")
        with store.mutate("fronts.json", {"fronts": []}) as data:
            data["fronts"] = [f for f in data.get("fronts", []) if f["id"] != fid]
        # Cleanup lives in separate mutates — fronts.json, research.json and
        # todos.json are different collections (research.json is SQL-backed).
        with store.mutate("research.json", {"topics": [], "entries": []}) as rdata:
            for t in rdata.get("topics", []):
                if fid in (t.get("fronts") or []):
                    t["fronts"] = [x for x in t["fronts"] if x != fid]
        with store.mutate("todos", {}) as tdata:
            for sec in tdata.values():
                if not isinstance(sec, dict):
                    continue
                for item in sec.get("items", []):
                    if fid in (item.get("fronts") or []):
                        item["fronts"] = [x for x in item["fronts"] if x != fid]
                        if not item["fronts"]:
                            item.pop("fronts")
        with store.mutate("buy_list.json", {"items": []}) as bdata:
            for item in bdata.get("items", []):
                if fid in (item.get("fronts") or []):
                    item["fronts"] = [x for x in item["fronts"] if x != fid]
        return _blob(data)
