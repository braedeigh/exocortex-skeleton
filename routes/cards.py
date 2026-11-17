"""Journal cards — the journal page's read/write API over the cards in exo.db.

Every card is a row in exo.db (tables in tools/stream/journaldb.py, the design
in docs/journal-database.md). This module reads those rows directly and hands
every change to the journal engine, tools/stream/stream.py, which is the only
thing allowed to write a card:

  - GET  /api/cards/<date>   — every card for one day, with each card's edit
                                window, the card a note or reply points at,
                                and the notes added to it later
  - POST /api/cards/add      — a new card at the top or bottom of a day
  - POST /api/cards/note     — a later note on a card (usually a locked one),
                                saved today and linked to it
  - POST /api/cards/update   — change a card's words (inside its 24 hours)
  - POST /api/cards/delete   — hide a card (inside its 24 hours)
  - POST /api/cards/tag / untag — put labels on a card or take them off (labels
                                aren't locked; a card's words are)
  - POST /api/cards/meta     — edit window + later notes for a list of card ids
                                (the thread page uses it for the cards it shows)
  - GET  /api/cards/<id>/history — every earlier version of a card's text

The 24-hour rule: a card can be edited or deleted for 24 hours after it was
saved, then never. The database's triggers enforce it; this module says it
kindly first — each card carries `editable` and `locks_at`, and an edit or
delete on a locked card comes back 409 with a sentence that says when it
locked and to add a note instead.

Touches: tools/stream/stream.py + journaldb.py (the engine and the tables),
sqlstore.py (opens exo.db), routes/streaks.py (counter chips, retirements),
routes/entities.py (CARDS_CUTOVER).
"""
import os
import re
import subprocess
import sys
from datetime import datetime, timedelta
from pathlib import Path

from flask import request, jsonify

import sqlstore
import store
from routes.entities import CARDS_CUTOVER
from tools.stream import stream

journaldb = stream.journaldb

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
# date . HHMM . speaker letter (b owner, k keeper, s system) . optional counter.
CARD_ID_RE = re.compile(r"^\d{4}-\d{2}-\d{2}\.\d{4}[bks]\d*$")
# Same shape as routes/threads.py's _SESSION_SLUG — tags mint thread
# associations, so a tag must be a valid slug.
TAG_RE = re.compile(r"^[a-z0-9-]{1,40}$")

STREAM_TIMEOUT_SEC = 30
# The most card ids one /api/cards/meta call will look up — a thread page's
# worth, with room to spare.
META_MAX_IDS = 3000
SNIPPET_WORDS = 12

MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
          "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def _content_dir():
    # Resolve fresh each call so tests/env overrides of CONTENT_DIR are honored
    # (same pattern as routes/entities.py's _vault()).
    return store.CONTENT_DIR.resolve()


def _stream_py():
    """The journal engine this app ships (tools/stream/stream.py), run against
    this install's content folder — not whatever stream.py sits in that folder.
    The live vault's copy is only a shim that forwards here anyway; a freshly
    seeded install's copy can be older than the app, and the app's routes pass
    flags only the current engine knows."""
    return Path(store.BUILD_DIR) / "tools" / "stream" / "stream.py"


def _snippet(body):
    """The first dozen words of a card, with … if there's more."""
    words = (body or "").split()
    return " ".join(words[:SNIPPET_WORDS]) + ("…" if len(words) > SNIPPET_WORDS else "")


def _locked_sentence(locks_at):
    """"locked at 11:15 PM on Nov 15" — what the refusal says. String parts
    only, the same clock the server keeps."""
    try:
        moment = datetime.strptime(locks_at, "%Y-%m-%d %H:%M:%S")
    except (TypeError, ValueError):
        return "locked"
    clock = moment.strftime("%I:%M %p").lstrip("0")
    return f"locked at {clock} on {MONTHS[moment.month - 1]} {moment.day}"


# --------------------------------------------------------------------------------
# Reading cards: rows from exo.db, shaped for the journal page.
# --------------------------------------------------------------------------------

def _window(saved_at, now=None):
    """A card's edit window: `editable` while it's inside its 24 hours, and
    `locks_at`, the moment it stops being (null if the stamp is unreadable)."""
    try:
        locks_at = journaldb.locks_at(saved_at)
    except (TypeError, ValueError):
        return {"editable": False, "locks_at": None}
    return {"editable": not journaldb.is_locked(saved_at, now), "locks_at": locks_at}


def _note_targets(conn, ids):
    """note card id -> the card it's a note on, for these ids."""
    out = {}
    for start in range(0, len(ids), 500):
        chunk = ids[start:start + 500]
        marks = ",".join("?" * len(chunk))
        for from_card, to_card in conn.execute(
                "SELECT from_card, to_card FROM card_links WHERE kind = 'note'"
                f" AND from_card IN ({marks}) ORDER BY linked_at", chunk):
            out.setdefault(from_card, to_card)
    return out


def _notes_on(conn, ids):
    """card id -> the live notes added to it later, oldest first, each as
    {id, date, ts, snippet}. Only ids that have notes appear."""
    out = {}
    for start in range(0, len(ids), 500):
        chunk = ids[start:start + 500]
        marks = ",".join("?" * len(chunk))
        for to_card, note_id, said_at, body in conn.execute(
                "SELECT l.to_card, c.id, c.said_at, c.body FROM card_links l"
                " JOIN cards c ON c.id = l.from_card"
                f" WHERE l.kind = 'note' AND c.deleted_at IS NULL AND l.to_card IN ({marks})"
                " ORDER BY c.said_at, c.id", chunk):
            out.setdefault(to_card, []).append(
                {"id": note_id, "date": said_at[:10], "ts": said_at, "snippet": _snippet(body)})
    return out


def _card_dict(row, note_on=None, now=None):
    """One journaldb row in the API's card shape. `who` keeps its case (B/K/S)."""
    card = {
        "id": row["id"],
        "who": row["who"],
        "ts": row["said_at"],
        "reply_to": row["reply_to"],
        # The card this one is a later note on, or None.
        "note_on": note_on,
        "tags": list(row["tags"] or []),
        "kind": row["kind"] or "",
        "refs": list(row["refs"] or []),
        # The observatory conversation this card was highlighted out of, when
        # it came from there. Most cards have none.
        "session": row["session"],
        # When the text was last changed, or None if it never was. The chip
        # that opens the card's edit history.
        "edited": row["edited"],
        "body": (row["body"] or "").strip("\n"),
    }
    card.update(_window(row["saved_at"], now))
    return card


def _fetch(conn, where, params=()):
    """Live cards matching `where`, shaped, with `note_on` filled in."""
    rows = journaldb.fetch_cards(conn, where, params)
    targets = _note_targets(conn, [r["id"] for r in rows])
    return [_card_dict(r, targets.get(r["id"])) for r in rows]


def _read_card(cid):
    """One live card from the database. None if there's no such card."""
    conn = sqlstore.open_db()
    try:
        found = _fetch(conn, "id = ? AND deleted_at IS NULL", (cid,))
    finally:
        conn.close()
    return found[0] if found else None


def _saved_at(cid):
    """A live card's saved_at, or None if there's no such live card."""
    conn = sqlstore.open_db()
    try:
        row = conn.execute("SELECT saved_at FROM cards WHERE id = ? AND deleted_at IS NULL",
                           (cid,)).fetchone()
    finally:
        conn.close()
    return row[0] if row else None


def _day_cards(date):
    """Every live card for one day, oldest first. Shared by GET
    /api/cards/<date> and the add handler, which needs the day's existing
    cards to compute where a new top/bottom card's ts should land."""
    conn = sqlstore.open_db()
    try:
        return _fetch(conn, "deleted_at IS NULL AND day = ?", (date,))
    finally:
        conn.close()


def _link_context(conn, cards):
    """The day view's chip for cards that point at another card: a note's
    "↪ Jul 14: '…'" and a reply's "↳ Jul 14 '…'" are the same chip — `link`
    says which. Sets `reply_context` on each pointing card: {id, date,
    snippet, link}, or None when the card it points at is gone. A note wins
    over a reply if a card somehow has both."""
    wanted = {c["note_on"] or c["reply_to"] for c in cards if c["note_on"] or c["reply_to"]}
    if not wanted:
        return
    ids = sorted(wanted)
    targets = {}
    for start in range(0, len(ids), 500):
        chunk = ids[start:start + 500]
        marks = ",".join("?" * len(chunk))
        for cid, day, body in conn.execute(
                f"SELECT id, day, body FROM cards WHERE deleted_at IS NULL AND id IN ({marks})", chunk):
            targets[cid] = {"id": cid, "date": day, "snippet": _snippet(body)}
    for card in cards:
        target_id = card["note_on"] or card["reply_to"]
        if not target_id:
            continue
        found = targets.get(target_id)
        card["reply_context"] = (
            dict(found, link="note" if card["note_on"] else "answers") if found else None)


def _edits_made_on(conn, date):
    """The edits made on `date` to entries from OTHER days — the "✎ edited an
    entry from …" rows the day view weaves in. Same rule as stream.py's
    edit_markers (which puts them in the rendered day file): a same-day edit
    shows only as the card's own "edited" chip, and several edits to one card
    that day show once, at the last."""
    latest = {}
    for card_id, edited_at, after, day in conn.execute(
            "SELECT e.card_id, e.edited_at, e.after, c.day FROM card_edits e"
            " JOIN cards c ON c.id = e.card_id"
            " WHERE substr(e.edited_at, 1, 10) = ? AND c.day != ? AND c.deleted_at IS NULL"
            " ORDER BY e.edited_at, e.id", (date, date)):
        latest.pop(card_id, None)  # re-insert, so order follows the last edit
        latest[card_id] = {"card_id": card_id, "card_day": day, "edited_at": edited_at,
                           "snippet": _snippet(after)}
    return list(latest.values())


# --------------------------------------------------------------------------------
# Writing: every change goes through the engine.
# --------------------------------------------------------------------------------

def _run_stream(*args, stdin=None):
    """Hand a change to the journal engine (tools/stream/stream.py) — the only
    thing allowed to write a card. Returns the CompletedProcess; caller checks
    returncode."""
    cmd = [sys.executable, str(_stream_py()), *args]
    # The engine finds the vault by TULKU_STREAM_ROOT; point it at this
    # install's content folder (the vault shim used to pin it).
    env = dict(os.environ, TULKU_STREAM_ROOT=str(_content_dir()))
    return subprocess.run(
        cmd, input=stdin, text=True, capture_output=True, timeout=STREAM_TIMEOUT_SEC, env=env,
    )


def _stream_error_response(result, fallback):
    err = (result.stderr or "").strip() or fallback
    if err.startswith("error: "):
        err = err[len("error: "):]
    lowered = err.lower()
    if "no such card" in lowered:
        return jsonify({"error": err}), 404
    # The card locked between our check and the engine's (or the trigger
    # caught it): the same friendly refusal as the up-front one.
    if "is locked" in lowered or "locked:" in lowered:
        return jsonify({"error": "This entry is locked — it was saved more than 24 hours ago."
                        " Add a note to it instead.", "locked": True}), 409
    return jsonify({"error": err}), 400


def _refuse_if_locked(cid, verb):
    """The 24-hour rule, said kindly before the engine is even asked: a 404
    for a card that isn't there, a 409 for one past its window. None when the
    change may go ahead."""
    saved_at = _saved_at(cid)
    if saved_at is None:
        return jsonify({"error": f"no such card: {cid}"}), 404
    window = _window(saved_at)
    if window["editable"]:
        return None
    return jsonify({
        "error": f"This entry {_locked_sentence(window['locks_at'])}, so it can't be {verb}"
                 " any more. Add a note to it instead.",
        "locked": True,
        "locks_at": window["locks_at"],
    }), 409


def _minted_card(result):
    """The card `record` just made, read back from the database. A card that
    went to the holding file (the database was busy) isn't a row yet; it comes
    back as {id, held: true} and lands within the minute."""
    lines = [line.strip() for line in (result.stdout or "").splitlines() if line.strip()]
    cid = lines[-1] if lines else ""
    if not CARD_ID_RE.match(cid):
        return jsonify({"error": "unexpected stream output"}), 400
    card = _read_card(cid)
    if card is None:
        return jsonify({"id": cid, "held": True})
    return jsonify(card)


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


def _valid_tags(tags):
    return isinstance(tags, list) and all(isinstance(t, str) and TAG_RE.match(t) for t in tags)


def register(app):

    @app.route("/api/cards/<date>")
    def get_cards(date):
        if not DATE_RE.match(date):
            return jsonify({"error": "invalid date"}), 400
        conn = sqlstore.open_db()
        try:
            day_cards = _fetch(conn, "deleted_at IS NULL AND day = ?", (date,))
            # Day-view-only enrichments — the chip on a note or reply, and the
            # "N notes added later" under an old card. Add/update/delete
            # responses return the bare card.
            _link_context(conn, day_cards)
            notes = _notes_on(conn, [c["id"] for c in day_cards])
            for c in day_cards:
                c["notes"] = notes.get(c["id"], [])
            edits = _edits_made_on(conn, date)
        finally:
            conn.close()
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
            # Edits made on this day to entries from other days — woven in
            # as "✎ edited an entry from …" rows.
            "edits": edits,
        })

    @app.route("/api/cards/<cid>/history")
    def card_history(cid):
        """Every change to one card's text, oldest first, each with the text
        before and after. Empty for a card never edited."""
        if not CARD_ID_RE.match(cid):
            return jsonify({"error": "invalid card id"}), 400
        conn = sqlstore.open_db()
        try:
            versions = [
                {"edited_at": edited_at, "by": by, "before": before or "", "after": after or ""}
                for edited_at, by, before, after in conn.execute(
                    "SELECT edited_at, by, before, after FROM card_edits WHERE card_id = ?"
                    " ORDER BY edited_at, id", (cid,))
            ]
        finally:
            conn.close()
        return jsonify({"id": cid, "versions": versions})

    @app.route("/api/cards/meta", methods=["POST"])
    def cards_meta():
        """Edit window and later notes for a list of card ids — for pages that
        show cards they got from elsewhere (the thread page). Ids that aren't
        live cards are left out."""
        ids = (request.json or {}).get("ids")
        if (not isinstance(ids, list) or len(ids) > META_MAX_IDS
                or not all(isinstance(i, str) and CARD_ID_RE.match(i) for i in ids)):
            return jsonify({"error": f"ids must be a list of up to {META_MAX_IDS} card ids"}), 400
        ids = sorted(set(ids))
        conn = sqlstore.open_db()
        try:
            saved = {}
            for start in range(0, len(ids), 500):
                chunk = ids[start:start + 500]
                marks = ",".join("?" * len(chunk))
                for cid, saved_at in conn.execute(
                        f"SELECT id, saved_at FROM cards WHERE deleted_at IS NULL AND id IN ({marks})",
                        chunk):
                    saved[cid] = saved_at
            notes = _notes_on(conn, list(saved))
            note_on = _note_targets(conn, list(saved))
        finally:
            conn.close()
        return jsonify({"cards": {
            cid: dict(_window(saved_at), notes=notes.get(cid, []), note_on=note_on.get(cid))
            for cid, saved_at in saved.items()
        }})

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
        if not _valid_tags(tags):
            return jsonify({"error": "invalid tag"}), 400
        if reply_to and not CARD_ID_RE.match(reply_to):
            return jsonify({"error": "invalid reply_to"}), 400
        ts = _insert_ts(date, position, _day_cards(date))
        # Added by her hand on the journal page: the web door, and any tags
        # credited to the owner (her labels outrank every agent's).
        args = ["record", "--who", "B", "--ts", ts, "--door", "web", "--by", "owner"]
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
        return _minted_card(result)

    @app.route("/api/cards/note", methods=["POST"])
    def add_note():
        """A later thought on a card, usually one past its 24 hours: a new
        card said now, on today's page, linked to the old one as a `note`.
        It comes in through the same door as any card she types here."""
        data = request.json or {}
        on = (data.get("on") or "").strip()
        body = data.get("body")
        tags = data.get("tags") or []
        if not CARD_ID_RE.match(on):
            return jsonify({"error": "invalid card id"}), 400
        if not (body or "").strip():
            return jsonify({"error": "body cannot be empty"}), 400
        if not _valid_tags(tags):
            return jsonify({"error": "invalid tag"}), 400
        if _saved_at(on) is None:
            return jsonify({"error": f"no such card: {on}"}), 404
        args = ["record", "--who", "B", "--door", "web", "--by", "owner", "--note-on", on]
        if tags:
            args += ["--tags", ",".join(tags)]
        try:
            result = _run_stream(*args, stdin=body)
        except subprocess.TimeoutExpired:
            return jsonify({"error": "timed out adding note"}), 400
        if result.returncode != 0:
            return _stream_error_response(result, "note failed")
        return _minted_card(result)

    @app.route("/api/cards/update", methods=["POST"])
    def update_card():
        data = request.json or {}
        cid = (data.get("id") or "").strip()
        body = data.get("body")
        if not CARD_ID_RE.match(cid):
            return jsonify({"error": "invalid card id"}), 400
        if not (body or "").strip():
            return jsonify({"error": "body cannot be empty"}), 400
        refused = _refuse_if_locked(cid, "edited")
        if refused:
            return refused
        try:
            result = _run_stream("edit", cid, "--by", "cards-route", stdin=body)
        except subprocess.TimeoutExpired:
            return jsonify({"error": "timed out editing card"}), 400
        if result.returncode != 0:
            return _stream_error_response(result, "edit failed")
        card = _read_card(cid)
        if card is None:
            return jsonify({"error": "card not found after edit"}), 404
        return jsonify(card)

    # Tag management — the journal UI's door to stream.py's `tag`/`untag`
    # verbs. Tags are how a card joins a thread (see TAG_RE above), so "add
    # this card to the ezra thread" and "take it out" are exactly these two
    # calls. Labels aren't under the 24-hour rule, so these work on any card.
    # Both return the updated card so the UI can redraw chips without
    # refetching the day.
    # Prompt: "some way for threads to be tagged on cards and easily added or
    # editable."
    def _retag(verb):
        data = request.json or {}
        cid = (data.get("id") or "").strip()
        tags = data.get("tags") or []
        if not CARD_ID_RE.match(cid):
            return jsonify({"error": "invalid card id"}), 400
        if not tags or not _valid_tags(tags):
            return jsonify({"error": "tags must be a non-empty list of slugs"}), 400
        try:
            # --by owner: a tag changed here is her hand, which no agent may undo
            # (stream.py refuses an agent removing her label or re-adding one she
            # took off).
            result = _run_stream(verb, cid, *tags, "--by", "owner")
        except subprocess.TimeoutExpired:
            return jsonify({"error": f"timed out running {verb}"}), 400
        if result.returncode != 0:
            return _stream_error_response(result, f"{verb} failed")
        card = _read_card(cid)
        if card is None:
            return jsonify({"error": f"card not found after {verb}"}), 404
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
        refused = _refuse_if_locked(cid, "deleted")
        if refused:
            return refused
        # Name the door on the row (deleted_by), so a card the owner deleted
        # here doesn't look like one some script removed.
        try:
            result = _run_stream("delete", cid, "--by", "cards-route")
        except subprocess.TimeoutExpired:
            return jsonify({"error": "timed out deleting card"}), 400
        if result.returncode != 0:
            return _stream_error_response(result, "delete failed")
        return jsonify({"ok": True})
