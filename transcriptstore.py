"""transcriptstore.py — imported chatbot conversations and their topics, in transcripts.db.

What it's for: everything the transcript organizer keeps. Conversations come
in from transcript_import.py (already in the common shape), topics come from
the sorter (scripts/sort_transcripts.py), and routes/transcripts.py reads both
back out for the pond page. Nothing else touches these tables.

Why its own file and not exo.db: exo.db is the owner's own record with one
shared migration ladder. The organizer is meant to ship on its own beside
Terrain, to people who have no exo.db, and its contents are the USER's
history, not the app's. So, like commonsdb.py, it keeps a separate SQLite file
— `transcripts.db` in the data directory — with its own schema below.

Tables:
  conversations        one per imported conversation; (source, source_id) is
                       its identity, so importing the same export twice
                       updates rather than duplicates. `sorted_at` is NULL
                       until the sorter has filed it (and again after an
                       import changes it).
  messages             its messages in order: role (user|assistant), text, at
                       (unix seconds, NULL when the export had no time)
  topics               the topics the sorter has made up, one row per name
                       (case-insensitive)
  conversation_topics  which topics each conversation is filed under — a
                       conversation can sit under several; a topic links back
                       to every conversation filed under it
  conversations_fts    full-text index of title + every message, for search

Times are turned into a day and a clock time in the SERVER's local zone
(`_local`). For a desktop install that is the user's own zone; for a hosted
one it's the host's.

Touches: store.py (DATA_DIR, where the file lives). Callers:
routes/transcripts.py, scripts/sort_transcripts.py. Tests:
tests/test_transcriptstore.py.

Prompt that produced it: "topic sorting — an AI reads each conversation and
files it under topics (one conversation can belong to several); each topic
links back to its source conversations."
"""
from contextlib import contextmanager
from datetime import datetime, timezone
import re
import sqlite3

import store

DB_NAME = "transcripts.db"

# The schema, all IF NOT EXISTS, so opening an older file adds whatever is missing.
_SCHEMA = (
    "CREATE TABLE IF NOT EXISTS conversations ("
    "  id INTEGER PRIMARY KEY,"
    "  source TEXT NOT NULL,"
    "  source_id TEXT NOT NULL,"
    "  title TEXT NOT NULL DEFAULT '',"
    "  created_at REAL,"
    "  updated_at REAL,"
    "  message_count INTEGER NOT NULL DEFAULT 0,"
    "  chars INTEGER NOT NULL DEFAULT 0,"
    "  summary TEXT NOT NULL DEFAULT '',"
    "  imported_at TEXT NOT NULL,"
    "  sorted_at TEXT,"
    "  UNIQUE (source, source_id))",
    "CREATE TABLE IF NOT EXISTS messages ("
    "  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,"
    "  seq INTEGER NOT NULL,"
    "  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),"
    "  text TEXT NOT NULL,"
    "  at REAL,"
    "  PRIMARY KEY (conversation_id, seq))",
    "CREATE TABLE IF NOT EXISTS topics ("
    "  id INTEGER PRIMARY KEY,"
    "  name TEXT NOT NULL UNIQUE COLLATE NOCASE,"
    "  created_at TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS conversation_topics ("
    "  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,"
    "  topic_id INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,"
    "  PRIMARY KEY (conversation_id, topic_id))",
    "CREATE VIRTUAL TABLE IF NOT EXISTS conversations_fts USING fts5(title, body)",
)


def db_path():
    return store.DATA_DIR / DB_NAME


@contextmanager
def connect():
    """Open transcripts.db (creating it and its tables on first use), commit on success."""
    path = db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, timeout=30)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA journal_mode = WAL")
        for statement in _SCHEMA:
            conn.execute(statement)
        yield conn
        conn.commit()
    except BaseException:
        conn.rollback()
        raise
    finally:
        conn.close()


def _now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# --- import ------------------------------------------------------------------

def save(conversations):
    """Store imported conversations; returns {added, updated, unchanged}.

    Same conversation again (same source and id, same last-updated time and
    message count) is left alone. A changed one gets its messages replaced and
    goes back in the queue to be sorted, since what it's about may have moved."""
    counts = {"added": 0, "updated": 0, "unchanged": 0}
    with connect() as conn:
        for conv in conversations:
            messages = conv["messages"]
            chars = sum(len(m["text"]) for m in messages)
            row = conn.execute(
                "SELECT id, updated_at, message_count FROM conversations"
                " WHERE source = ? AND source_id = ?",
                (conv["source"], conv["source_id"])).fetchone()
            if row and row["updated_at"] == conv["updated_at"] and row["message_count"] == len(messages):
                counts["unchanged"] += 1
                continue
            if row:
                conv_id = row["id"]
                conn.execute(
                    "UPDATE conversations SET title = ?, created_at = ?, updated_at = ?,"
                    " message_count = ?, chars = ?, imported_at = ?, sorted_at = NULL"
                    " WHERE id = ?",
                    (conv["title"], conv["created_at"], conv["updated_at"],
                     len(messages), chars, _now(), conv_id))
                conn.execute("DELETE FROM messages WHERE conversation_id = ?", (conv_id,))
                conn.execute("DELETE FROM conversations_fts WHERE rowid = ?", (conv_id,))
                counts["updated"] += 1
            else:
                conv_id = conn.execute(
                    "INSERT INTO conversations (source, source_id, title, created_at, updated_at,"
                    " message_count, chars, imported_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    (conv["source"], conv["source_id"], conv["title"], conv["created_at"],
                     conv["updated_at"], len(messages), chars, _now())).lastrowid
                counts["added"] += 1
            conn.executemany(
                "INSERT INTO messages (conversation_id, seq, role, text, at) VALUES (?, ?, ?, ?, ?)",
                [(conv_id, seq, m["role"], m["text"], m["at"]) for seq, m in enumerate(messages)])
            conn.execute(
                "INSERT INTO conversations_fts (rowid, title, body) VALUES (?, ?, ?)",
                (conv_id, conv["title"], "\n".join(m["text"] for m in messages)))
    return counts


# --- sorting -----------------------------------------------------------------

def unsorted(limit=None):
    """Conversations waiting to be filed, oldest first: [{id, title, messages}]."""
    with connect() as conn:
        rows = conn.execute(
            "SELECT id, title FROM conversations WHERE sorted_at IS NULL"
            " ORDER BY created_at, id" + (" LIMIT ?" if limit else ""),
            (limit,) if limit else ()).fetchall()
        return [{"id": r["id"], "title": r["title"], "messages": _messages(conn, r["id"])}
                for r in rows]


def topic_names():
    """Every topic name, busiest first — the vocabulary the sorter is shown."""
    with connect() as conn:
        return [r["name"] for r in conn.execute(
            "SELECT t.name FROM topics t LEFT JOIN conversation_topics ct ON ct.topic_id = t.id"
            " GROUP BY t.id ORDER BY COUNT(ct.conversation_id) DESC, t.name")]


def file_under(conversation_id, names, summary=""):
    """File one conversation under these topic names (replacing any it had).

    A name matching an existing topic in any letter case joins that topic; a
    new one creates it. Blank names are dropped. Topics left with no
    conversations are deleted, so a re-sort never strands an empty topic."""
    clean = []
    for name in names:
        name = re.sub(r"\s+", " ", str(name)).strip()[:60]
        if name and name.lower() not in {c.lower() for c in clean}:
            clean.append(name)
    with connect() as conn:
        conn.execute("DELETE FROM conversation_topics WHERE conversation_id = ?", (conversation_id,))
        for name in clean:
            conn.execute("INSERT OR IGNORE INTO topics (name, created_at) VALUES (?, ?)", (name, _now()))
            topic_id = conn.execute("SELECT id FROM topics WHERE name = ?", (name,)).fetchone()["id"]
            conn.execute("INSERT OR IGNORE INTO conversation_topics VALUES (?, ?)",
                         (conversation_id, topic_id))
        conn.execute("UPDATE conversations SET sorted_at = ?, summary = ? WHERE id = ?",
                     (_now(), str(summary)[:400], conversation_id))
        conn.execute("DELETE FROM topics WHERE id NOT IN (SELECT topic_id FROM conversation_topics)")


# --- reading -----------------------------------------------------------------

def _local(at):
    """Unix seconds → (day 'YYYY-MM-DD', timestamp 'YYYY-MM-DD HH:MM:SS') in local time."""
    moment = datetime.fromtimestamp(at)
    return moment.strftime("%Y-%m-%d"), moment.strftime("%Y-%m-%d %H:%M:%S")


def _messages(conn, conversation_id):
    return [dict(r) for r in conn.execute(
        "SELECT seq, role, text, at FROM messages WHERE conversation_id = ? ORDER BY seq",
        (conversation_id,))]


def _match(query):
    """A search box's words as an FTS5 query: every word must appear, as a prefix.
    Each word is quoted, so punctuation in it can't be read as FTS syntax."""
    words = re.findall(r"\w+", query or "")
    return " ".join(f'"{w}"*' for w in words)


def search(query):
    """Ids of conversations whose title or messages contain every word; None for no query."""
    match = _match(query)
    if not match:
        return None
    with connect() as conn:
        return {r[0] for r in conn.execute(
            "SELECT rowid FROM conversations_fts WHERE conversations_fts MATCH ?", (match,))}


def stats():
    """How much is in, and how much is still waiting to be sorted."""
    with connect() as conn:
        row = conn.execute(
            "SELECT COUNT(*) AS conversations, COALESCE(SUM(message_count), 0) AS messages,"
            " COALESCE(SUM(sorted_at IS NULL), 0) AS unsorted FROM conversations").fetchone()
        return dict(row)


def topics():
    """Every topic with its reach — how many conversations and distinct days, and its first/last day.

    Days are counted from the conversations' start times, the one time every
    conversation has."""
    with connect() as conn:
        rows = conn.execute(
            "SELECT t.id, t.name, c.id AS conv, c.created_at FROM topics t"
            " JOIN conversation_topics ct ON ct.topic_id = t.id"
            " JOIN conversations c ON c.id = ct.conversation_id").fetchall()
        titles = {r["id"]: r["title"] for r in conn.execute("SELECT id, title FROM conversations")}
    by_topic = {}
    for r in rows:
        entry = by_topic.setdefault(r["id"], {"id": r["id"], "name": r["name"], "tag": f"t{r['id']}",
                                              "conversations": [], "days": set()})
        entry["conversations"].append(r["conv"])
        if r["created_at"] is not None:
            entry["days"].add(_local(r["created_at"])[0])
    out = []
    for entry in by_topic.values():
        days = sorted(entry.pop("days"))
        entry["conversations"] = [{"id": c, "title": titles.get(c, "")} for c in sorted(entry["conversations"])]
        entry.update(days=len(days), first=days[0] if days else None, last=days[-1] if days else None)
        out.append(entry)
    return sorted(out, key=lambda e: (-e["days"], -len(e["conversations"]), e["name"].lower()))


def pond_cards(from_day=None, query=None, limit=8000, body_chars=600):
    """Every message as a pond card, oldest first: {id, day, ts, who, kind, tags, body, conv}.

    The shape is the journal pond's PondCard (frontend/src/features/pond/
    pondMath.ts), so the pond's own layout code places them: `who` is 'B' for
    the user and 'K' for the chatbot, `tags` are the conversation's topic tags
    ("t<id>"; empty = unsorted), `kind` is the source. A message with no time
    of its own takes its conversation's start day with no clock time, and sinks
    to the bottom of that day; one with no time anywhere can't be placed and
    is left out. Bodies are cut to `body_chars` — the full text is fetched one
    conversation at a time. Returns (cards, truncated) — past `limit` the
    NEWEST are kept."""
    ids = search(query)
    with connect() as conn:
        tags = {}
        for r in conn.execute("SELECT conversation_id, topic_id FROM conversation_topics"):
            tags.setdefault(r[0], []).append(f"t{r[1]}")
        rows = conn.execute(
            "SELECT m.conversation_id, m.seq, m.role, substr(m.text, 1, ?) AS body, m.at,"
            " c.created_at, c.source FROM messages m JOIN conversations c ON c.id = m.conversation_id",
            (body_chars,)).fetchall()
    cards = []
    for r in rows:
        if ids is not None and r["conversation_id"] not in ids:
            continue
        if r["at"] is not None:
            day, ts = _local(r["at"])
        elif r["created_at"] is not None:
            day, ts = _local(r["created_at"])[0], None
        else:
            continue
        if from_day and day < from_day:
            continue
        cards.append({
            "id": f"{r['conversation_id']}:{r['seq']}", "day": day, "ts": ts,
            "who": "B" if r["role"] == "user" else "K", "kind": r["source"],
            "tags": tags.get(r["conversation_id"], []),
            "body": " ".join(r["body"].split()), "conv": r["conversation_id"],
        })
    cards.sort(key=lambda c: (c["day"], c["ts"] or "~", c["id"]))
    truncated = len(cards) > limit
    return (cards[-limit:] if truncated else cards), truncated


def conversation(conversation_id):
    """One conversation in full — its messages, topics and summary — or None."""
    with connect() as conn:
        row = conn.execute("SELECT * FROM conversations WHERE id = ?", (conversation_id,)).fetchone()
        if not row:
            return None
        topics_of = [dict(r) for r in conn.execute(
            "SELECT t.id, t.name FROM topics t JOIN conversation_topics ct ON ct.topic_id = t.id"
            " WHERE ct.conversation_id = ? ORDER BY t.name", (conversation_id,))]
        messages = _messages(conn, conversation_id)
    out = {k: row[k] for k in ("id", "source", "title", "created_at", "updated_at", "summary", "sorted_at")}
    for m in messages:
        m["ts"] = _local(m["at"])[1] if m["at"] is not None else None
    out.update(topics=[dict(t, tag=f"t{t['id']}") for t in topics_of], messages=messages)
    return out
