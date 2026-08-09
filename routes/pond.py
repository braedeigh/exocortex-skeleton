"""The pond — the journal's own shape, read straight out of the database.

The terrain map draws the CREEK: data moving across the seam between the code
and the vault. This is the other thing entirely — the POND, where that data
comes to rest. Every card the journal has ever minted, sitting at its own day
and time, with the threads that run through them.

Nothing here is new data. `cardstore.py` already mirrors the whole card pool
(one markdown file per utterance, in the vault) into `exo.db` — table `cards`
plus `card_tags` — and `scripts/update_cards.py` keeps it current hourly. What
was missing was a way to ASK it anything: until now the only door onto that
table was the general-purpose SQL console (routes/sqlab.py). These three
endpoints are that door, shaped for one drawing.

    GET /api/pond/threads   tags ranked by SPAN — how many distinct days each
                            one touches, not how many cards it has. A thread
                            that surfaces on ten days across a month is the
                            interesting shape; one with forty cards on a single
                            afternoon is a busy day, not a thread.
    GET /api/pond/cards     the cards themselves in a window, flat and sorted,
                            with a short preview and their tags.
    GET /api/pond/card/<id> one card, in full, when she taps it.

Read-only throughout, on a connection SQLite itself refuses writes through —
same `mode=ro` + `query_only` belt-and-braces as routes/sqlab.py. The pool in
the vault is the record; this is a mirror, and a mirror has no business being
written to from a web request.

Deliberately flat, not grouped by day: the layout (day columns, cards stacked
by time within them, where a thread's line dips) belongs in the frontend's own
tested math module, not baked into a payload shape. The seam stays generic so
the drawing above it can be replaced without touching this.

Prompt that produced it: "the base files laid out by day and time with threads
stored inside of them connected by lines, and you can scroll left or right over
time and the threads bounce around in the entries" — plus the naming that made
it click: the creek is the movement of data, the pond is where the data sits.
"""
import re
import sqlite3
from contextlib import closing
from datetime import date

from flask import jsonify, request

import store

# Card ids encode their own timestamp and speaker: `2026-08-09.0855b`. Shape-
# checked before it ever reaches a query — the SQL is parameterised anyway, so
# this is about rejecting junk early with a clear 400 rather than about safety.
_CARD_ID_RE = re.compile(r"^[0-9A-Za-z._-]{1,64}$")


def _valid_day(raw):
    """A real calendar date, not merely a date-SHAPED string.

    `day` is compared lexically in SQL, so `2026-13-99` wouldn't error — it
    would quietly define a window nothing can fall inside, and the caller would
    get an empty pond back with a 200 and no idea why. fromisoformat rejects
    the impossible month itself.
    """
    try:
        date.fromisoformat(raw)
    except ValueError:
        return False
    return True

# How much of a card's body rides along in the list payload. Enough to know
# which card you're looking at from the drawing; the full text is one tap away
# on /api/pond/card/<id>. Keeps a whole month's payload small.
PREVIEW_CHARS = 160

# A ceiling so a widened date range can never ask for the entire pool at once.
# Reported honestly as `truncated` rather than silently trimming.
MAX_CARDS = 4000


def _read_only_conn():
    """A connection SQLite itself will not let anything write through.

    Always used via `contextlib.closing`, never a bare `with conn:` — that form
    is a TRANSACTION scope and leaves the connection (and its file descriptor)
    open until the garbage collector gets round to it. Under gevent workers
    serving this on every pan of the timeline, that accumulates.
    """
    conn = sqlite3.connect(
        f"file:{store.DATA_DIR / 'exo.db'}?mode=ro", uri=True, timeout=5
    )
    conn.execute("PRAGMA query_only = ON")
    conn.row_factory = sqlite3.Row
    return conn


def _preview(body):
    """First line-ish of a card, whitespace collapsed. Markdown is left as-is —
    stripping it properly is a rendering job, and half-stripping it lies."""
    flat = " ".join((body or "").split())
    return flat[:PREVIEW_CHARS] + ("…" if len(flat) > PREVIEW_CHARS else "")


def _window():
    """The requested date range, validated. Either end may be absent, which
    means "as far as the pool goes in that direction"."""
    out = {}
    for key in ("from", "to"):
        raw = (request.args.get(key) or "").strip()
        if not raw:
            out[key] = None
            continue
        if not _valid_day(raw):
            return None, f'"{key}" must be a real date, YYYY-MM-DD'
        out[key] = raw
    if out["from"] and out["to"] and out["from"] > out["to"]:
        return None, '"from" must not be after "to"'
    return out, None


def _window_sql(window, alias="c"):
    """The shared WHERE fragment: inside the window, and not deleted.

    Deleted cards are excluded everywhere. The pool keeps its tombstones on
    purpose (a turn can be late but never lost), but a drawing of where her
    data SITS shouldn't be drawing things she removed.
    """
    clauses = [f"{alias}.deleted_at IS NULL"]
    params = []
    if window["from"]:
        clauses.append(f"{alias}.day >= ?")
        params.append(window["from"])
    if window["to"]:
        clauses.append(f"{alias}.day <= ?")
        params.append(window["to"])
    return " AND ".join(clauses), params


def register(app):

    @app.route("/api/pond/threads")
    def pond_threads():
        """Tags ranked by how many distinct DAYS they touch.

        Span, not volume, because span is what the drawing is about: a thread
        that keeps resurfacing has a shape worth seeing, and one that fired
        forty times on a single afternoon doesn't — that's just a busy day
        wearing a tag. `cards` comes back too so the two can be compared.
        """
        window, err = _window()
        if err:
            return jsonify({"error": err}), 400
        where, params = _window_sql(window)
        with closing(_read_only_conn()) as conn:
            rows = conn.execute(
                f"""SELECT t.tag                    AS tag,
                           COUNT(*)                 AS cards,
                           COUNT(DISTINCT c.day)    AS days,
                           MIN(c.day)               AS first,
                           MAX(c.day)               AS last
                      FROM card_tags t
                      JOIN cards c ON c.id = t.card_id
                     WHERE {where}
                  GROUP BY t.tag
                  ORDER BY days DESC, cards DESC, t.tag ASC""",
                params,
            ).fetchall()
        return jsonify({"threads": [dict(r) for r in rows]})

    @app.route("/api/pond/cards")
    def pond_cards():
        """Every card in the window, flat and sorted, with its tags.

        Optional `tag=` narrows to one thread — the first slice of the drawing
        lights exactly one at a time, so this is the query it leans on.
        """
        window, err = _window()
        if err:
            return jsonify({"error": err}), 400
        tag = (request.args.get("tag") or "").strip()

        where, params = _window_sql(window)
        if tag:
            where += " AND c.id IN (SELECT card_id FROM card_tags WHERE tag = ?)"
            params = params + [tag]

        with closing(_read_only_conn()) as conn:
            rows = conn.execute(
                f"""SELECT c.id, c.day, c.ts, c.who, c.kind, c.body
                      FROM cards c
                     WHERE {where}
                  ORDER BY c.day ASC, c.ts ASC, c.id ASC
                     LIMIT ?""",
                params + [MAX_CARDS + 1],
            ).fetchall()
            truncated = len(rows) > MAX_CARDS
            rows = rows[:MAX_CARDS]
            # Tags for exactly the cards being returned, in one query rather
            # than one per card.
            tags = {}
            if rows:
                marks = ",".join("?" * len(rows))
                for r in conn.execute(
                    f"SELECT card_id, tag FROM card_tags WHERE card_id IN ({marks})",
                    [r["id"] for r in rows],
                ):
                    tags.setdefault(r["card_id"], []).append(r["tag"])

        cards = [
            {
                "id": r["id"],
                "day": r["day"],
                "ts": r["ts"],
                "who": r["who"],
                "kind": r["kind"],
                "tags": sorted(tags.get(r["id"], [])),
                "preview": _preview(r["body"]),
            }
            for r in rows
        ]
        return jsonify({
            "cards": cards,
            "from": window["from"],
            "to": window["to"],
            "tag": tag or None,
            "truncated": truncated,
        })

    @app.route("/api/pond/card/<card_id>")
    def pond_card(card_id):
        """One card in full — the body, and the links it carries."""
        if not _CARD_ID_RE.match(card_id or ""):
            return jsonify({"error": "invalid card id"}), 400
        with closing(_read_only_conn()) as conn:
            row = conn.execute(
                """SELECT id, day, ts, who, kind, reply_to, session, refs, body,
                          first_seen, last_seen, deleted_at
                     FROM cards WHERE id = ?""",
                (card_id,),
            ).fetchone()
            if row is None:
                return jsonify({"error": "card not found"}), 404
            tags = [
                r["tag"] for r in conn.execute(
                    "SELECT tag FROM card_tags WHERE card_id = ? ORDER BY tag", (card_id,)
                )
            ]
        card = dict(row)
        card["tags"] = tags
        return jsonify({"card": card})
