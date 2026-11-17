"""Reading the journal's cards out of exo.db — the app side's one door.

**What this does, in plain English.** The journal's cards are rows in exo.db
(see `docs/journal-database.md`, the design of record): `cards` holds the
words, `labels` the threads/people/topics, and `card_labels` which card wears
which label, who put it there, and whether the card is mainly *about* that
label or only *touches* it. This module is the handful of reads the app's
pages and scripts share, so each of them asks the same question the same way:

  - `live_cards(conn, where, params)` — cards with their live labels (`tags`),
    the card each answers (`reply_to`) and their last edit (`edited`).
  - `read(conn, card_id)` — one live card, or None.
  - `labelled(conn, slug)` — {card_id: weight} for every card wearing a label.
  - `cards_labelled(conn, slug, ...)` — those cards themselves, `about` first,
    then `touches`, then not-yet-judged, each oldest first.
  - `tags_for(conn, ids)` — {card_id: [tags]} for a page of cards.
  - `editable(card)` / `locks_at(card)` — the 24-hour rule, from `saved_at`.

**Live only.** A label that was taken off keeps its row (it's the memory that
stops an agent putting it back), with `removed_at` set. Every read here skips
those rows; only history views look at them, and they query the table
directly. Deleted cards (`deleted_at` set) are skipped the same way.

**Writing never happens here.** Cards and labels change only through the
journal engine (`tools/stream/stream.py`), whose table code is
`tools/stream/journaldb.py` — this module reuses its `fetch_cards` and its
lock clock, so a reader and the engine can't disagree about what a card says
or when it locks.

Touches: `sqlstore.py` (the connection), `tools/stream/journaldb.py` (the
tables, `fetch_cards`, `is_locked`, `locks_at`). Read by routes/threads.py,
routes/streaks.py, routes/entities.py, routes/pending.py, routes/pond.py,
cardsearch.py and scripts/journal_cards.py.

Prompt: "Point everything that still reads card files or the old `card_tags`
mirror at the new tables, so the card files can be retired. Thread and person
pages rank weight='about' cards before touches. Ignore card_labels rows with
removed_at set everywhere except history."
"""
from tools.stream import stream

journaldb = stream.journaldb

# The order a label's cards are ranked in: mainly-about first, then the ones
# it only comes up in, then the ones nobody has judged yet (weight NULL).
WEIGHT_RANK = {"about": 0, "touches": 1, None: 2}

# The live labels of a card, joined to their slugs. Used inside larger queries.
LIVE_LABELS_SQL = ("SELECT cl.card_id, l.slug, cl.weight FROM card_labels cl"
                   " JOIN labels l ON l.id = cl.label_id WHERE cl.removed_at IS NULL")


def live_cards(conn, where="1", params=(), order="said_at, id"):
    """Live (not deleted) cards as dicts, through the engine's own reader:
    every column, plus `tags`, `reply_to` and `edited`."""
    return journaldb.fetch_cards(conn, f"deleted_at IS NULL AND ({where})", params, order)


def read(conn, card_id):
    """One live card as a dict, or None if there's no such card or it was deleted."""
    rows = live_cards(conn, "id = ?", (card_id,))
    return rows[0] if rows else None


def labelled(conn, slug):
    """Every card wearing the label `slug` right now, as {card_id: weight}
    (weight is 'about', 'touches' or None)."""
    return {card_id: weight for card_id, _slug, weight in conn.execute(
        LIVE_LABELS_SQL + " AND l.slug = ?", (slug,))}


def cards_labelled(conn, slug, who=None, since=None):
    """The live cards wearing `slug`, each with its `weight`, ranked: `about`
    first, then `touches`, then unjudged; oldest first inside each.
    `who` keeps one speaker ('B'); `since` keeps cards from that day on."""
    weights = labelled(conn, slug)
    if not weights:
        return []
    where, params = ["id IN (SELECT card_id FROM card_labels cl JOIN labels l"
                     " ON l.id = cl.label_id WHERE cl.removed_at IS NULL AND l.slug = ?)"], [slug]
    if who:
        where.append("who = ?")
        params.append(who)
    if since:
        where.append("day >= ?")
        params.append(since)
    rows = live_cards(conn, " AND ".join(where), params)
    for row in rows:
        row["weight"] = weights.get(row["id"])
    rows.sort(key=lambda row: WEIGHT_RANK.get(row["weight"], 2))   # stable: keeps time order
    return rows


def tags_for(conn, ids):
    """{card_id: [tags]} for these cards: the capture facts first (`voice`,
    `via:<device>`, as the journal's source chip expects), then live label
    slugs in the order they were put on — the same list `live_cards` gives."""
    ids = list(ids)
    out = {}
    # Fetch in chunks SQLite will accept as one IN (...) list.
    for start in range(0, len(ids), 500):
        chunk = ids[start:start + 500]
        marks = ",".join("?" * len(chunk))
        for card_id, door, device in conn.execute(
                f"SELECT id, door, device FROM cards WHERE id IN ({marks})", chunk):
            facts = (["voice"] if door == "voice" else []) + ([f"via:{device}"] if device else [])
            if facts:
                out[card_id] = facts
        for card_id, slug in conn.execute(
                "SELECT cl.card_id, l.slug FROM card_labels cl JOIN labels l ON l.id = cl.label_id"
                f" WHERE cl.removed_at IS NULL AND cl.card_id IN ({marks}) ORDER BY cl.id", chunk):
            tags = out.setdefault(card_id, [])
            if slug not in tags:
                tags.append(slug)
    return out


def editable(card):
    """True while the card is inside its 24 hours (counted from `saved_at`,
    when the row was written — the same clock the database triggers use)."""
    return not journaldb.is_locked(card.get("saved_at"))


def locks_at(card):
    """When the card stops being editable, or None if its save time is unreadable."""
    try:
        return journaldb.locks_at(card.get("saved_at"))
    except (TypeError, ValueError):
        return None
