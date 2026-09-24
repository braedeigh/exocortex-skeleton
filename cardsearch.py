"""Keyword search over the journal — the engine behind the journal's search box.

**What this does.** Finds journal cards containing the words you type, ranked
best-match first (or newest/oldest), each with a short excerpt that marks
where the words hit. It searches the cards, the small one-thing-said files the
journal is built from, so a hit is one moment, with a time and a speaker.

**How.** SQLite's built-in word index (FTS5), table `cards_fts`, built in
sqlstore.py's v23 rung and kept up to date by triggers on the `cards` table.
That table is cardstore.py's mirror of the card files, so this module never
reads the files for searching, only to notice brand-new ones (see catch_up).

**What you can type** (the same rules as the Research search, via
textsearch.parse_query):
  - plain words: every one must appear, in any order. Word endings are
    folded, so "bartending" also finds "bartender" and "bartend".
  - "a quoted phrase": those words, side by side, in that order.
  - -word: leave out cards containing it.
  - word*: anything starting with that ("apart*" finds "apartment").

Plain keyword matching only. Search by meaning, where "finding work" would find
"job hunting", is a planned second phase, not built yet.

Prompt: "i want a manual search tool to be able to search through my journal
... i imagine i would have at first just a plain search word feature but later
do semantic vectoring"

Touches: `sqlstore.py` (the index + connection), `cardstore.py` (mirrors new
cards before a search), `textsearch.py` (query parsing),
`routes/journal_search.py` (the HTTP door).
"""
import sqlite3

import cardstore
import sqlstore
import textsearch

# Past this many unmirrored cards, one full pool walk beats one-at-a-time.
_CATCH_UP_ONE_BY_ONE_MAX = 50

# Markers FTS5 wraps around each hit inside an excerpt. Control characters,
# so they can't collide with anything she writes; split out again below.
_HIT_START = "\x02"
_HIT_END = "\x03"
# Excerpt length, in words, around the best-matching spot.
_SNIPPET_WORDS = 40

SORTS = ("relevance", "newest", "oldest")


def _quote(text):
    """Quote a word or phrase for FTS5, which reads anything bare as syntax.
    A double quote inside is escaped by doubling it, FTS5's own rule."""
    return '"' + text.replace('"', '""') + '"'


def to_fts_query(q):
    """Turn what she typed into an FTS5 query, or None if nothing to search.

    Every piece is quoted, so a stray `(`, `:` or `AND` in her words is read as
    text, never as FTS5 syntax, and can't make the search error out. A
    trailing `*` stays outside the quotes, where FTS5 reads it as "starts
    with". Exclusions need at least one thing to include: FTS5's NOT is
    "this but not that", so a query of only -words returns None.
    """
    parsed = textsearch.parse_query(q)
    include = [_quote(p) for p in parsed["phrases"]]
    for term in parsed["terms"]:
        prefix = term.endswith("*")
        word = term.rstrip("*")
        if word:
            include.append(_quote(word) + ("*" if prefix else ""))
    if not include:
        return None
    query = " AND ".join(include)
    for word in parsed["excluded"]:
        word = word.rstrip("*")
        if word:
            query += " NOT " + _quote(word)
    return query


def catch_up():
    """Mirror any card that's on disk but not in the database yet.

    The mirror refreshes hourly, and instantly for edits made in the journal
    page. A line captured mid-conversation lands on disk between those, and
    without this a search right after saying something wouldn't find it.
    Listing file names is cheap; only the new ones get parsed.
    """
    pool = cardstore.pool_dir()
    if not pool.exists():
        return 0
    on_disk = {p.stem for p in pool.glob("*.md")}
    conn = sqlstore.open_db()
    try:
        mirrored = {r[0] for r in conn.execute("SELECT id FROM cards")}
    finally:
        conn.close()
    new = on_disk - mirrored
    if len(new) > _CATCH_UP_ONE_BY_ONE_MAX:
        cardstore.sync()
    else:
        for cid in new:
            cardstore.sync_one(cid)
    return len(new)


def _split_snippet(marked):
    """FTS5's marked excerpt -> [{"text", "hit"}] pieces, so the page can bold
    the hits without ever treating journal text as HTML."""
    pieces = []
    rest = marked
    while rest:
        start = rest.find(_HIT_START)
        if start == -1:
            pieces.append({"text": rest, "hit": False})
            break
        if start:
            pieces.append({"text": rest[:start], "hit": False})
        end = rest.find(_HIT_END, start)
        if end == -1:
            pieces.append({"text": rest[start + 1:], "hit": True})
            break
        pieces.append({"text": rest[start + 1:end], "hit": True})
        rest = rest[end + 1:]
    return pieces


def search(q, who=None, date_from=None, date_to=None, sort="relevance",
           limit=30, offset=0):
    """Search the journal. Returns {"total", "hits": [...]}.

    `who` is "B" or "K" (the owner or the Keeper); dates are inclusive
    YYYY-MM-DD bounds. Cards deleted or missing from disk are never returned.
    Each hit: {"id", "day", "ts", "who", "kind", "tags", "snippet",
    "marked_body"}: snippet is a short excerpt as _split_snippet pieces;
    marked_body is the card's whole text with each hit wrapped in
    _HIT_START/_HIT_END (control characters, never in her writing), for the
    journal to render as a full card. Raises ValueError for
    a query with nothing to search for (empty, or only -words).
    """
    fts_query = to_fts_query(q)
    if fts_query is None:
        raise ValueError("nothing to search for")

    # Build the filters: the word match, plus whichever optional limits apply.
    where = ["cards_fts MATCH ?", "c.deleted_at IS NULL", "c.missing_since IS NULL"]
    params = [fts_query]
    if who:
        where.append("c.who = ?")
        params.append(who)
    if date_from:
        where.append("c.day >= ?")
        params.append(date_from)
    if date_to:
        where.append("c.day <= ?")
        params.append(date_to)
    where_sql = " AND ".join(where)
    order_sql = {
        # bm25 is FTS5's relevance score: lower is better.
        "relevance": "bm25(cards_fts), c.ts DESC",
        "newest": "c.ts DESC",
        "oldest": "c.ts ASC",
    }[sort]

    conn = sqlstore.open_db()
    try:
        total = conn.execute(
            "SELECT COUNT(*) FROM cards_fts JOIN cards c ON c.id = cards_fts.card_id"
            f" WHERE {where_sql}", params,
        ).fetchone()[0]
        rows = conn.execute(
            "SELECT c.id, c.day, c.ts, c.who, c.kind,"
            f"  snippet(cards_fts, 1, ?, ?, '…', {_SNIPPET_WORDS}),"
            # The whole text too, with every hit wrapped in the same markers,
            # so the journal can show the full card with its matches lit.
            "  highlight(cards_fts, 1, ?, ?)"
            " FROM cards_fts JOIN cards c ON c.id = cards_fts.card_id"
            f" WHERE {where_sql} ORDER BY {order_sql} LIMIT ? OFFSET ?",
            [_HIT_START, _HIT_END, _HIT_START, _HIT_END, *params, limit, offset],
        ).fetchall()
        # Fetch the tags for just the cards on this page, in one query.
        tags = {}
        ids = [r[0] for r in rows]
        if ids:
            for card_id, tag in conn.execute(
                "SELECT card_id, tag FROM card_tags WHERE card_id IN"
                f" ({','.join('?' * len(ids))}) ORDER BY tag", ids,
            ):
                tags.setdefault(card_id, []).append(tag)
    except sqlite3.OperationalError as exc:
        # Quoting should make every query valid; if FTS5 still refuses one,
        # say so as a bad query rather than a crash. Anything else (a locked
        # database, say) is a real error and goes up as one.
        if "fts5" not in str(exc).lower() and "syntax" not in str(exc).lower():
            raise
        raise ValueError(f"search failed: {exc}") from exc
    finally:
        conn.close()

    return {
        "total": total,
        "hits": [
            {"id": cid, "day": day, "ts": ts, "who": who_, "kind": kind,
             "tags": tags.get(cid, []), "snippet": _split_snippet(marked or ""),
             "marked_body": marked_body or ""}
            for cid, day, ts, who_, kind, marked, marked_body in rows
        ],
    }
