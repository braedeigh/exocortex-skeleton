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
                            afternoon is a busy day, not a thread. Each tag also
                            comes back CLASSIFIED — person / thread / topic —
                            and threads carry the fronts they belong to.
    GET /api/pond/cards     the cards themselves in a window, flat and sorted,
                            with their whole text and their tags. Whole, not a
                            preview: the drawing reads cards in place and
                            re-windows them around whichever thread is lit,
                            which changes with no refetch.
    GET /api/pond/card/<id> one card, in full, when she taps it.
    GET /api/pond/working   the OTHER half of her days: when she was talking
                            to an agent, when files were written, and how long
                            each session sat open. Three lists, one window,
                            one clock.

The working half comes from a DIFFERENT pipeline into the same database:
agent conversations write transcripts into `bot_chats/`, an hourly cron
harvests which files each one touched, and `codestore.py` folds both into
`sessions` / `session_files` / `session_turns`. Nothing new is synced for the
pond — this endpoint is a read across tables that were already there.

The classification is not invented here and it is not stored here. The vault
ALREADY sorts these: a tag with a file in `people/` is a person, a tag with a
file in `Threads/` is a thread (and that file's frontmatter names the `fronts:`
it belongs to), and `fronts.json` holds the front vocabulary. The pond was
flattening all three into one undifferentiated list. This just reads the sorting
that was already there and passes it up, so the rail can offer People / Threads
/ Fronts instead of ninety tags in a row. Anything the vault doesn't file lands
in `topic` — honestly labelled, never guessed at.

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

import codestore
import store
from routes.entities import PEOPLE_DIR, _parse_frontmatter
from routes.threads import THREADS_DIR

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

# The pond's WORDS arrangement reads cards in place, at whatever length they
# are, and re-windows them around whichever thread is lit — which changes
# without a refetch. So the list carries the WHOLE body rather than a preview:
# the entire pool is about a third of a megabyte, roughly a hundred kilobytes
# over the wire, fetched once. A per-card ceiling bounds the pathological case
# (a card far longer than anything the drawing can show) without touching the
# 99% of cards that are shorter than a screen.
BODY_CHARS = 6000

# Stop words dropped when a tag is broken into searchable words. Only the
# grammar — nothing topical, so this stays true for any vault.
_STOP = {
    "and", "the", "a", "an", "of", "to", "in", "for", "on", "at", "by", "with",
    "is", "it", "be", "or", "no", "not", "my", "me", "i", "im", "this", "that",
}
_WORD_RE = re.compile(r"[^a-z0-9]+")

# A ceiling so a widened date range can never ask for the entire pool at once.
# Reported honestly as `truncated` rather than silently trimming.
MAX_CARDS = 4000

# The same ceiling for the working half, applied to each list separately. The
# real corpus is ~1,800 turns and ~1,400 file touches, so this is headroom for
# a year or two rather than a limit anything meets today.
MAX_WORKING = 6000


def _taxonomy():
    """What KIND each tag is, read straight off the vault's own filing.

    Three shelves, and the vault already put everything on one of them:

      person  — there's a `people/<tag>.md`
      thread  — there's a `Threads/<tag>.md`, whose frontmatter names the
                `fronts:` it belongs to
      topic   — neither; a loose tag the journal minted and nobody filed

    Only the frontmatter of each thread file is parsed, not the body — this runs
    on a rail that redraws whenever she changes the window, and the bodies are
    the bulk of those files. `fronts.json` supplies the display names; a front
    id a thread references that isn't in the vocabulary still comes through,
    titled from its own id, rather than vanishing.

    Everything is best-effort: a vault with no `people/` or `Threads/` (any
    install that isn't hers) simply classifies every tag as `topic`, and the
    rail degrades to the flat list it is today rather than erroring.
    """
    people, threads = set(), {}
    root = store.CONTENT_DIR
    try:
        people = {p.stem for p in (root / PEOPLE_DIR).glob("*.md")}
    except OSError:
        pass
    try:
        for path in (root / THREADS_DIR).glob("*.md"):
            try:
                meta, _ = _parse_frontmatter(path.read_text())
            except (OSError, UnicodeDecodeError):
                continue
            def _list(key):
                v = meta.get(key, [])
                if isinstance(v, str):
                    v = [v] if v else []
                return [x for x in v if x]

            threads[path.stem] = {
                "name": meta.get("name") or path.stem,
                "fronts": _list("fronts"),
                "aliases": _list("aliases"),
                "status": meta.get("status") or None,
            }
    except OSError:
        pass

    names = {}
    for front in (store.read("fronts", {"fronts": []}).get("fronts") or []):
        if front.get("id"):
            names[front["id"]] = front.get("name") or front["id"]
    return people, threads, names


def _classify(tag, people, threads):
    """One tag -> the shelf it sits on, its display name, fronts, and the words
    to hunt for when centring a long card's excerpt on it."""
    if tag in threads:
        t = threads[tag]
        return {"kind": "thread", "name": t["name"], "fronts": t["fronts"],
                "status": t["status"],
                "terms": _terms(tag, t["name"], *t["aliases"])}
    if tag in people:
        # People files have no display name — the slug IS the name, just cased.
        name = tag.replace("-", " ").title()
        return {"kind": "person", "name": name, "fronts": [], "status": None,
                "terms": _terms(tag, name)}
    return {"kind": "topic", "name": tag, "fronts": [], "status": None,
            "terms": _terms(tag)}


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


def _body(body):
    """A card's text, whitespace collapsed, capped. Markdown is left as-is —
    stripping it properly is a rendering job, and half-stripping it lies."""
    flat = " ".join((body or "").split())
    return flat[:BODY_CHARS] + ("…" if len(flat) > BODY_CHARS else "")


def _terms(*phrases):
    """The words to look for in a card when centring an excerpt on a thread.

    A tag is metadata, not a marker in the text: `housing-rent-and-the-move`
    names a preoccupation, and she never types that string. But she does type
    *housing*, and *rent*, and *move*. So each tag's slug, display name and
    aliases are broken into their component words, and the excerpt centres on
    the first of those the card actually says.

    Measured against this vault: matching whole phrases finds the thread in 62%
    of long cards (person names land, abstract threads don't); matching the
    component words finds it in 85%. The remaining 15% have no honest anchor at
    all and the drawing falls back to the head of the card rather than inventing
    a relevance it can't show.
    """
    out = set()
    for phrase in phrases:
        for word in _WORD_RE.split((phrase or "").lower()):
            if len(word) > 2 and word not in _STOP:
                out.add(word)
    return sorted(out)


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


def _in_window(day, window):
    """Is a local day inside the requested window? The working half filters in
    Python rather than SQL because one of its three clocks only becomes local
    AFTER conversion — see `pond_working`."""
    if window["from"] and day < window["from"]:
        return False
    if window["to"] and day > window["to"]:
        return False
    return True


def register(app):

    @app.route("/api/pond/threads")
    def pond_threads():
        """Tags ranked by how many distinct DAYS they touch, each on its shelf.

        Span, not volume, because span is what the drawing is about: a thread
        that keeps resurfacing has a shape worth seeing, and one that fired
        forty times on a single afternoon doesn't — that's just a busy day
        wearing a tag. `cards` comes back too so the two can be compared.

        Every tag carries the `kind` the vault filed it under, so the rail can
        split People from Threads instead of interleaving them. `fronts` rolls
        the threads up one more level — a front is a set of threads, so its
        span is the union of their days, counted here rather than in the
        browser because only the database knows which days those are.
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
            # Which days each tag touched — needed for a front's span, because
            # two threads under one front often fire on the SAME day and adding
            # their day-counts would double-count it.
            day_rows = conn.execute(
                f"""SELECT DISTINCT t.tag AS tag, c.day AS day
                      FROM card_tags t
                      JOIN cards c ON c.id = t.card_id
                     WHERE {where}""",
                params,
            ).fetchall()

        people, thread_meta, front_names = _taxonomy()
        threads = []
        for row in rows:
            entry = dict(row)
            entry.update(_classify(entry["tag"], people, thread_meta))
            threads.append(entry)

        days_by_tag = {}
        for r in day_rows:
            days_by_tag.setdefault(r["tag"], set()).add(r["day"])
        cards_by_tag = {t["tag"]: t["cards"] for t in threads}

        # A front is only as real as the threads under it that actually fired
        # in this window — a front whose threads are all silent isn't listed,
        # rather than sitting in the rail as a row that lights nothing.
        rolled = {}
        for t in threads:
            for front in t["fronts"]:
                slot = rolled.setdefault(
                    front, {"id": front, "name": front_names.get(front, front),
                            "tags": [], "days": set(), "cards": 0})
                slot["tags"].append(t["tag"])
                slot["days"] |= days_by_tag.get(t["tag"], set())
                slot["cards"] += cards_by_tag.get(t["tag"], 0)

        fronts = sorted(
            ({"id": f["id"], "name": f["name"], "tags": sorted(f["tags"]),
              "days": len(f["days"]), "cards": f["cards"]} for f in rolled.values()),
            key=lambda f: (-f["days"], -f["cards"], f["name"]),
        )
        return jsonify({"threads": threads, "fronts": fronts})

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
                "body": _body(r["body"]),
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

    @app.route("/api/pond/working")
    def pond_working():
        """The building half of her days, on the same clock as the journal.

        Three lists, because they are three different KINDS of event and
        flattening them would be the lie the drawing has to avoid:

          turns    — a POINT. One row per message she sent to an agent. This
                     is "when I was interacting with agents", at the grain she
                     actually asked for: 1,765 moments, not 154 containers.
          writes   — a POINT. One row per (session, file) from the footprints
                     harvest, so it is the LAST time that session touched that
                     file, not every time. A file edited at 10:00 and again at
                     16:00 appears once, at 16:00. The drawing says so on its
                     face rather than implying a complete edit history.
          sessions — a SPAN. `started` → `last_at` is how long a conversation
                     sat OPEN, which is a different question from when work
                     happened in it; a third of them stay open past twelve
                     hours. `worked_from`/`worked_to` bound the part that
                     actually wrote files, so the drawing can show both.

        THE CLOCK, which is the trap in this endpoint. `session_turns.ts` and
        `sessions.started/last_at` are local; `session_files.last` is UTC,
        because it comes from the transcripts' own `timestamp` fields through
        the footprints sidecar. Everything leaves here LOCAL and naive, in the
        same shape the journal's own `cards.ts` uses, so the frontend has one
        clock and no chance to guess. Skip the conversion and the code layer
        draws five hours off — at 3am on a page whose whole point is that her
        sleep schedule is visible in the shape. Wrong in the way that looks
        entirely plausible, which is why it is done once, here, at the seam.
        """
        window, err = _window()
        if err:
            return jsonify({"error": err}), 400

        with closing(_read_only_conn()) as conn:
            turn_rows = conn.execute(
                """SELECT session_id, ts FROM session_turns
                    ORDER BY ts ASC LIMIT ?""",
                (MAX_WORKING + 1,),
            ).fetchall()
            write_rows = conn.execute(
                """SELECT sf.session_id, sf.last, sf.writes, sf.creates,
                          f.repo, f.path
                     FROM session_files sf
                     JOIN files f ON f.id = sf.file_id
                    WHERE sf.last IS NOT NULL
                    ORDER BY sf.last ASC""",
            ).fetchall()
            session_rows = conn.execute(
                """SELECT id, title, lane, started, last_at FROM sessions
                    ORDER BY started ASC""",
            ).fetchall()

        truncated = len(turn_rows) > MAX_WORKING
        turns = [
            {"ts": r["ts"], "session": r["session_id"]}
            for r in turn_rows[:MAX_WORKING]
            if r["ts"] and _in_window(r["ts"][:10], window)
        ]

        # Converted first, filtered second: a UTC touch at 02:30Z belongs to
        # the PREVIOUS local day, so windowing on the raw string would put it
        # in the wrong column and then hide it from the right one.
        writes = []
        worked = {}
        for r in write_rows:
            ts = codestore.local_iso(r["last"])
            if not ts:
                continue
            span = worked.setdefault(r["session_id"], [ts, ts])
            if ts < span[0]:
                span[0] = ts
            if ts > span[1]:
                span[1] = ts
            if not _in_window(ts[:10], window):
                continue
            writes.append({
                "ts": ts,
                "session": r["session_id"],
                "repo": r["repo"],
                "path": r["path"],
                "writes": r["writes"],
                "creates": r["creates"],
            })
        if len(writes) > MAX_WORKING:
            truncated = True
            writes = writes[:MAX_WORKING]

        # A session is kept when its open interval OVERLAPS the window, not
        # when one of its ends happens to land inside it. The difference is
        # the whole point of this layer: a session opened on Saturday and
        # still open on Wednesday has neither end inside a Monday window, and
        # it is precisely the long-open session she wants to see.
        sessions = []
        for r in session_rows:
            span = worked.get(r["id"])
            started, last_at = r["started"], r["last_at"]
            if not started:
                continue
            open_from, open_to = started[:10], (last_at or started)[:10]
            if window["to"] and open_from > window["to"]:
                continue
            if window["from"] and open_to < window["from"]:
                continue
            sessions.append({
                "id": r["id"],
                "title": r["title"] or r["id"],
                "lane": r["lane"],
                "started": started,
                "last_at": last_at or started,
                "worked_from": span[0] if span else None,
                "worked_to": span[1] if span else None,
            })

        return jsonify({
            "turns": turns,
            "writes": writes,
            "sessions": sessions,
            "from": window["from"],
            "to": window["to"],
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
