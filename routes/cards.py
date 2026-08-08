"""Journal cards — read/edit/delete over the stream-cards pool.

Cards are one-markdown-file-per-utterance in the vault
(`CONTENT_DIR/_system/data/cards/<id>.md`, see routes/entities.py's module
docstring for the CARDS_CUTOVER background). This module is a thin read/write
API over that pool for the journal-day UI:

  - GET  /api/cards/<date>   — every card for one day, parsed
  - POST /api/cards/add      — insert a new note card at the top or bottom
                                of a day's timeline
  - POST /api/cards/update   — edit a card's body
  - POST /api/cards/tag      — add tags to a card (tags are the thread link)
  - POST /api/cards/untag    — remove tags from a card
  - POST /api/cards/delete   — remove a card

Reads parse the frontmatter directly (fast, no subprocess). Mutations never
touch the files themselves — they shell out to the vault's own `stream.py`,
which re-renders the derived daily file / month index / manifests after every
write. Editing/deleting a card file by hand here would silently desync those
derived views from the pool.
"""
import re
import subprocess
import sys
from datetime import datetime, timedelta

from flask import request, jsonify

import cardstore
import store
from routes.entities import _parse_frontmatter, CARDS_CUTOVER

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
# date . HHMM . b|k . optional counter — see CLAUDE.md background for this task.
CARD_ID_RE = re.compile(r"^\d{4}-\d{2}-\d{2}\.\d{4}[bk]\d*$")
# Same shape as routes/threads.py's _SESSION_SLUG — tags mint thread
# associations, so a tag must be a valid slug.
TAG_RE = re.compile(r"^[a-z0-9-]{1,40}$")

STREAM_TIMEOUT_SEC = 30


def _content_dir():
    # Resolve fresh each call so tests/env overrides of CONTENT_DIR are honored
    # (same pattern as routes/entities.py's _vault()).
    return store.CONTENT_DIR.resolve()


def _pool_dir():
    return _content_dir() / "_system" / "data" / "cards"


def _stream_py():
    return _content_dir() / "_system" / "stream.py"


def _card_path(cid):
    return _pool_dir() / f"{cid}.md"


def _card_dict(meta, body, fallback_id=None):
    """Shape the frontmatter + body into the API's card object. `who` keeps
    its on-disk case (B/K) — _parse_frontmatter only lowercases keys, not
    values."""
    reply_to = meta.get("reply_to")
    if reply_to in (None, "null", ""):
        reply_to = None
    tags = meta.get("tags", [])
    if not isinstance(tags, list):
        tags = [tags] if tags else []
    refs = meta.get("refs", [])
    if not isinstance(refs, list):
        refs = [refs] if refs else []
    session = meta.get("session")
    if session in (None, "null", ""):
        session = None
    return {
        "id": meta.get("id") or fallback_id,
        "who": meta.get("who", ""),
        "ts": meta.get("ts", ""),
        "reply_to": reply_to,
        "tags": tags,
        "kind": meta.get("kind", ""),
        "refs": refs,
        # The observatory conversation this card was highlighted out of, when
        # it came from there. Most cards have none.
        "session": session,
        "body": body.strip("\n"),
    }


def _read_card(cid):
    """Parse one card file straight off disk. None if it doesn't exist."""
    path = _card_path(cid)
    try:
        text = path.read_text()
    except OSError:
        return None
    meta, body = _parse_frontmatter(text)
    return _card_dict(meta, body, fallback_id=cid)


def _run_stream(*args, stdin=None):
    """Shell out to the vault's stream.py — the only thing allowed to mutate
    card files, since it re-renders the derived day/month/manifest views on
    every write. Returns the CompletedProcess; caller checks returncode."""
    cmd = [sys.executable, str(_stream_py()), *args]
    return subprocess.run(
        cmd, input=stdin, text=True, capture_output=True, timeout=STREAM_TIMEOUT_SEC,
    )


def _echo_mirror(cid):
    """Push one card's change into the SQL mirror immediately (cardstore).
    Best-effort on purpose: the mirror is derived — if this hiccups, the
    hourly sync catches the same change, so a mirror problem must never fail
    the save the owner just made."""
    try:
        cardstore.sync_one(cid)
    except Exception:
        pass


def _stream_error_response(result, fallback):
    err = (result.stderr or "").strip() or fallback
    status = 404 if "no such card" in err.lower() else 400
    return jsonify({"error": err}), status


def _reply_context(card):
    """A reply card's context sidecar for the day view: the parent card's
    date + a truncated (first ~12 words) snippet of its body. None if the
    parent card no longer exists on disk."""
    reply_to = card.get("reply_to")
    if not reply_to:
        return None
    parent = _read_card(reply_to)
    if parent is None:
        return None
    words = parent["body"].split()
    snippet = " ".join(words[:12])
    if len(words) > 12:
        snippet += "…"
    return {
        "id": reply_to,
        "date": reply_to.split(".")[0],
        "snippet": snippet,
    }


def _day_cards(date):
    """Every card for one day, parsed straight off the pool. Shared by
    GET /api/cards/<date> and the add handler, which needs the day's existing
    cards to compute where a new top/bottom card's ts should land."""
    pool = _pool_dir()
    cards = []
    if pool.exists():
        for p in pool.glob(f"{date}.*.md"):
            try:
                text = p.read_text()
            except OSError:
                continue
            meta, body = _parse_frontmatter(text)
            cards.append(_card_dict(meta, body, fallback_id=p.stem))
    cards.sort(key=lambda c: (c.get("ts") or "", c["id"]))
    return cards


def _insert_ts(date, position, day_cards, now=None):
    """Pick the ts for a new top/bottom card on `date`. `kind: context` cards
    (the keeper's day-summary) sit outside the line/ref timeline and are
    ignored here — "top" means right after that summary, i.e. one second
    before the earliest timeline card. Falls back to `now` (or noon, if `now`
    isn't on `date`) when the day has no timeline cards yet."""
    if now is None:
        now = datetime.now()
    day_start = datetime.strptime(f"{date} 00:00:00", "%Y-%m-%d %H:%M:%S")
    day_end = datetime.strptime(f"{date} 23:59:59", "%Y-%m-%d %H:%M:%S")

    timeline = []
    for c in day_cards:
        if c.get("kind") == "context":
            continue
        try:
            ts = datetime.strptime(c.get("ts", ""), "%Y-%m-%d %H:%M:%S")
        except ValueError:
            continue  # skip cards with an unparseable ts
        timeline.append((ts, c.get("id")))
    timeline.sort()

    def _clamp(ts):
        return max(day_start, min(day_end, ts))

    if position == "top" and timeline:
        ts = _clamp(timeline[0][0] - timedelta(seconds=1))
    elif timeline:
        ts = timeline[-1][0] + timedelta(seconds=1)
        if now.strftime("%Y-%m-%d") == date and now > ts:
            ts = now  # adding to today, past the last card: use real time
        ts = _clamp(ts)
    else:
        ts = now if now.strftime("%Y-%m-%d") == date else day_start.replace(hour=12)

    return ts.strftime("%Y-%m-%d %H:%M:%S")


def _session_titles(day_cards):
    """Conversation id -> title, for just the sessions this day's cards were
    highlighted out of. The journal wears these as a "from ⟨title⟩" chip that
    opens the room back up, so a pulled quote never loses where it was said.

    Titles come from the observatory's own index; a session that's since been
    deleted resolves to nothing and the card simply shows no chip — provenance
    is a courtesy, not something worth failing a day's render over."""
    ids = {c["session"] for c in day_cards if c.get("session")}
    if not ids:
        return {}
    index = store.read("bot_chats/index", {})
    if not isinstance(index, dict):
        return {}
    out = {}
    for cid in ids:
        meta = index.get(cid)
        if isinstance(meta, dict):
            out[cid] = meta.get("title") or cid
    return out


def _counter_tags():
    """Day-counter tag -> chip info, the counter sibling of the journal's
    thread-name map: a card tagged `counter-<slug>` (a counter's note cell,
    see routes/streaks.py) earns a meta-row chip linking back to its counter —
    Today's streak sheet while active, the Life Map's Retired card after."""
    from routes.streaks import load_streaks
    return {
        s["tag"]: {"label": s["label"], "slug": s["slug"], "status": s["status"]}
        for s in load_streaks("all")
    }


def register(app):

    @app.route("/api/cards/<date>")
    def get_cards(date):
        if not DATE_RE.match(date):
            return jsonify({"error": "invalid date"}), 400
        day_cards = _day_cards(date)
        # Reply context is a day-view-only enrichment (the journal margin-note
        # chip) — add/update/delete responses return the bare card so a save
        # round-trip isn't burdened with a parent lookup + thread scan it
        # doesn't need.
        for c in day_cards:
            if c.get("reply_to"):
                c["reply_context"] = _reply_context(c)
        from routes.streaks import retirements_for
        return jsonify({
            "date": date,
            "editable": date >= CARDS_CUTOVER,
            "cards": day_cards,
            "counters": _counter_tags(),
            # Titles for the sessions this day's cards were pulled out of —
            # what the "from ⟨…⟩" chip says.
            "sessions": _session_titles(day_cards),
            # Day counters retired on this day — the web view weaves these ⏹
            # rows between entries, same as the rendered markdown does.
            "retirements": retirements_for(date),
        })

    @app.route("/api/cards/add", methods=["POST"])
    def add_card():
        data = request.json or {}
        date = (data.get("date") or "").strip()
        position = data.get("position")
        body = data.get("body")
        tags = data.get("tags") or []
        reply_to = (data.get("reply_to") or "").strip()
        if not DATE_RE.match(date):
            return jsonify({"error": "invalid date"}), 400
        if date < CARDS_CUTOVER:
            return jsonify({"error": "day predates the card pool"}), 400
        if not (body or "").strip():
            return jsonify({"error": "body cannot be empty"}), 400
        if position not in ("top", "bottom"):
            return jsonify({"error": "position must be 'top' or 'bottom'"}), 400
        if not isinstance(tags, list) or not all(isinstance(t, str) and TAG_RE.match(t) for t in tags):
            return jsonify({"error": "invalid tag"}), 400
        if reply_to and not CARD_ID_RE.match(reply_to):
            return jsonify({"error": "invalid reply_to"}), 400
        ts = _insert_ts(date, position, _day_cards(date))
        args = ["record", "--who", "B", "--ts", ts]
        if tags:
            args += ["--tags", ",".join(tags)]
        if reply_to:
            args += ["--reply-to", reply_to]
        try:
            result = _run_stream(*args, stdin=body)
        except subprocess.TimeoutExpired:
            return jsonify({"error": "timed out adding card"}), 400
        if result.returncode != 0:
            return _stream_error_response(result, "add failed")
        lines = [line.strip() for line in (result.stdout or "").splitlines() if line.strip()]
        cid = lines[-1] if lines else ""
        if not CARD_ID_RE.match(cid):
            return jsonify({"error": "unexpected stream output"}), 400
        card = _read_card(cid)
        if card is None:
            return jsonify({"error": "card not found after add"}), 404
        _echo_mirror(cid)
        return jsonify(card)

    @app.route("/api/cards/update", methods=["POST"])
    def update_card():
        data = request.json or {}
        cid = (data.get("id") or "").strip()
        body = data.get("body")
        if not CARD_ID_RE.match(cid):
            return jsonify({"error": "invalid card id"}), 400
        if not (body or "").strip():
            return jsonify({"error": "body cannot be empty"}), 400
        try:
            result = _run_stream("edit", cid, stdin=body)
        except subprocess.TimeoutExpired:
            return jsonify({"error": "timed out editing card"}), 400
        if result.returncode != 0:
            return _stream_error_response(result, "edit failed")
        card = _read_card(cid)
        if card is None:
            return jsonify({"error": "card not found after edit"}), 404
        _echo_mirror(cid)
        return jsonify(card)

    # Tag management — the journal UI's door to stream.py's `tag`/`untag`
    # verbs, which already existed for the CLI but had no route. Tags are how
    # a card joins a thread (see TAG_RE above), so "add this card to the ezra
    # thread" and "take it out" are exactly these two calls. Both return the
    # updated card so the UI can redraw chips without refetching the day.
    # Prompt: "some way for threads to be tagged on cards and easily added or
    # editable."
    def _retag(verb):
        data = request.json or {}
        cid = (data.get("id") or "").strip()
        tags = data.get("tags") or []
        if not CARD_ID_RE.match(cid):
            return jsonify({"error": "invalid card id"}), 400
        if (not isinstance(tags, list) or not tags
                or not all(isinstance(t, str) and TAG_RE.match(t) for t in tags)):
            return jsonify({"error": "tags must be a non-empty list of slugs"}), 400
        try:
            result = _run_stream(verb, cid, *tags)
        except subprocess.TimeoutExpired:
            return jsonify({"error": f"timed out running {verb}"}), 400
        if result.returncode != 0:
            return _stream_error_response(result, f"{verb} failed")
        card = _read_card(cid)
        if card is None:
            return jsonify({"error": f"card not found after {verb}"}), 404
        _echo_mirror(cid)
        return jsonify(card)

    @app.route("/api/cards/tag", methods=["POST"])
    def tag_card():
        return _retag("tag")

    @app.route("/api/cards/untag", methods=["POST"])
    def untag_card():
        return _retag("untag")

    @app.route("/api/cards/delete", methods=["POST"])
    def delete_card():
        data = request.json or {}
        cid = (data.get("id") or "").strip()
        if not CARD_ID_RE.match(cid):
            return jsonify({"error": "invalid card id"}), 400
        # Name the door in the deletion log. Without this every removal made through
        # the app records itself as "cli", which is the one thing the log exists to
        # disambiguate — a card the owner deleted here should not look like a card
        # some script removed.
        try:
            result = _run_stream("delete", cid, "--by", "cards-route")
        except subprocess.TimeoutExpired:
            return jsonify({"error": "timed out deleting card"}), 400
        if result.returncode != 0:
            return _stream_error_response(result, "delete failed")
        _echo_mirror(cid)
        return jsonify({"ok": True})
