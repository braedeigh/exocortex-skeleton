"""Spinoff briefs, kept in the database instead of in folders of files.

**What this is, in plain English.** A brief says what a spun-off session is
asked to do. It used to be a file, `spinoffs/<slug>/BRIEF.md`, with the files
preloaded into the session's instructions beside it as `CONTEXT.md` and any
handoff as `HANDOFF.md`. Now each is a row in exo.db, tagged by date and by
the job's name (its slug):

  - `spinoff_briefs` — one row per brief: the slug, when it was written, the
    session that wrote it, the text, and (once a session is started on it)
    that session's id. A continuation is a row of its own that names the
    session it carries on from.
  - `spinoff_contexts` — the hidden instructions built for a brief when its
    session starts: the Protocol and the listed files, as they were then.
  - `spinoff_handoffs` — what a session wrote when it filled its context and
    handed its work on.

A brief reaches its session with no file in between: routes/spinoff.py reads
the row and sends its text as the first message. The context is the one part
that still passes through a file, because the `claude` command only takes a
large system prompt by path (one command-line argument stops at 128 KB, and a
context runs to 200 KB). `context_file` writes it out from the database at the
start of every turn, into a hidden cache folder; the file is a throwaway copy
and can be deleted at any time.

Touches: sqlstore.py (the three tables), routes/spinoff.py (opens a session
from a brief; the brief page's API), routes/observatory.py (each turn asks for
the context file), continuation.py (handoffs and continuation briefs),
scripts/spinoff_brief.py (the agents' door for saving a brief),
scripts/import_spinoff_briefs.py (brings the old folders in),
tests/test_briefstore.py. The whole arrangement, the backup and the old
folders: docs/spinoff-briefs.md.

Prompt that produced this: "I need some other organization of the /spinoffs.
I don't know why they're /brief in a folder ... I would rather have some other
backend rather than all these files" — and then: "Let's put it in the database
and have it auto inject through whatever backend machinery into the prompt
directly?"
"""
import json
import os
from datetime import datetime
from pathlib import Path

import sqlstore
import store

_BRIEF_COLUMNS = ("id", "slug", "written_at", "written_by", "body", "conv", "opened_at",
                  "continues", "preloaded", "too_big", "imported_from")
_HANDOFF_COLUMNS = ("id", "conv", "at", "body", "to_conv", "slug", "imported_from")


def _now():
    return datetime.now().isoformat(timespec="seconds")


def _brief(row):
    """One spinoff_briefs row as a dict, its two file lists read back from JSON."""
    if row is None:
        return None
    found = dict(zip(_BRIEF_COLUMNS, row))
    for key in ("preloaded", "too_big"):
        try:
            found[key] = json.loads(found[key]) if found[key] else []
        except ValueError:
            found[key] = []
    return found


def _one(sql, args=()):
    conn = sqlstore.open_db()
    try:
        return conn.execute(sql, args).fetchone()
    finally:
        conn.close()


def _all(sql, args=()):
    conn = sqlstore.open_db()
    try:
        return conn.execute(sql, args).fetchall()
    finally:
        conn.close()


_SELECT = "SELECT " + ", ".join(_BRIEF_COLUMNS) + " FROM spinoff_briefs"


# --- Briefs -----------------------------------------------------------------------

def save(slug, body, written_by=None, continues=None, fresh=False, written_at=None,
         imported_from=None):
    """Save a brief for `slug`. Returns its row id.

    A brief that no session has been started on yet is a draft, and saving the
    same slug again REPLACES the draft: an agent that re-sends an edited brief,
    or a button that rewrites its brief on every press (routes/helpers.py),
    leaves one row rather than a pile. Once a session has been started on a
    brief its row is never changed; the next save is a new row. `fresh` always
    makes a new row — a continuation's brief must not land on someone's draft."""
    at = written_at or _now()
    conn = sqlstore.open_db()
    try:
        sqlstore.begin_immediate(conn)
        draft = None if fresh else conn.execute(
            "SELECT id, conv FROM spinoff_briefs WHERE slug = ? ORDER BY id DESC LIMIT 1",
            (slug,)).fetchone()
        if draft and draft[1] is None:
            conn.execute(
                "UPDATE spinoff_briefs SET body = ?, written_at = ?, written_by = ?,"
                " continues = ? WHERE id = ?", (body, at, written_by, continues, draft[0]))
            brief_id = draft[0]
        else:
            brief_id = conn.execute(
                "INSERT INTO spinoff_briefs (slug, written_at, written_by, body, continues,"
                " imported_from) VALUES (?, ?, ?, ?, ?, ?)",
                (slug, at, written_by, body, continues, imported_from)).lastrowid
        conn.execute("COMMIT")
        return brief_id
    finally:
        conn.close()


def get(brief_id):
    """One brief by its row id, or None."""
    return _brief(_one(_SELECT + " WHERE id = ?", (brief_id,))) if brief_id else None


def latest(slug):
    """The newest brief saved under `slug`, or None.

    A brief file written the old way is taken in here: an agent that was
    already mid-conversation when briefs moved to the database still writes
    `spinoffs/<slug>/BRIEF.md`, and its session must start all the same. The
    file is adopted when no row exists for the slug, or when the file is newer
    than the newest row."""
    row = _brief(_one(_SELECT + " WHERE slug = ? ORDER BY id DESC LIMIT 1", (slug,)))
    path = store.SPINOFF_DIR / slug / "BRIEF.md"
    try:
        written = datetime.fromtimestamp(path.stat().st_mtime).isoformat(timespec="seconds")
        if row is None or written > row["written_at"]:
            body = path.read_text(encoding="utf-8")
            if row is None or body != row["body"]:
                return get(save(slug, body, written_at=written,
                                written_by=os.environ.get("EXOCORTEX_CONV_ID"),
                                imported_from=str(path.parent)))
    except (OSError, UnicodeDecodeError):
        pass
    return row


def for_session(conv_id):
    """The brief a session was started on, or None."""
    return _brief(_one(_SELECT + " WHERE conv = ? ORDER BY id DESC LIMIT 1", (conv_id,)))


def to_open(slug):
    """The brief a new session for `slug` should be started on, or None.

    The newest one. When a session was already started on it — the slug is
    being opened again after that session closed — the same text is saved as a
    new row, so every session has a brief row of its own."""
    row = latest(slug)
    if row is None or row["conv"] is None:
        return row
    return get(save(slug, row["body"], written_by=row["written_by"],
                    continues=row["continues"], fresh=True))


def opened(brief_id, conv_id, preloaded=(), too_big=(), context=None, opened_at=None):
    """Record that a session was started on this brief: which session, which
    files were pasted into its instructions, and those instructions whole."""
    at = opened_at or _now()
    conn = sqlstore.open_db()
    try:
        sqlstore.begin_immediate(conn)
        conn.execute(
            "UPDATE spinoff_briefs SET conv = ?, opened_at = ?, preloaded = ?, too_big = ?"
            " WHERE id = ?",
            (conv_id, at, json.dumps(list(preloaded)), json.dumps(list(too_big)), brief_id))
        if context:
            conn.execute(
                "INSERT OR REPLACE INTO spinoff_contexts (brief_id, at, body) VALUES (?, ?, ?)",
                (brief_id, at, context))
        conn.execute("COMMIT")
    finally:
        conn.close()


def listing(limit=500):
    """Every brief, newest first, without its text: for a list of what was
    spun off and when."""
    rows = _all("SELECT id, slug, written_at, written_by, conv, opened_at, continues,"
                " length(body) FROM spinoff_briefs ORDER BY written_at DESC, id DESC LIMIT ?",
                (limit,))
    keys = ("id", "slug", "written_at", "written_by", "conv", "opened_at", "continues", "chars")
    return [dict(zip(keys, row)) for row in rows]


# --- The context: a session's hidden instructions ---------------------------------

def context(brief_id):
    """The hidden instructions built for this brief, or None when it has none
    (a brief with its own Protocol and no files listed)."""
    row = _one("SELECT body FROM spinoff_contexts WHERE brief_id = ?", (brief_id,)) \
        if brief_id else None
    return row[0] if row else None


def _cache_dir():
    """Where the throwaway copies of contexts go. A hidden folder in the data
    dir by default (the vault's .gitignore keeps it out of the hourly backup);
    EXOCORTEX_SPINOFF_CONTEXT_DIR points it anywhere else. Read at each call,
    so a test that moves the data dir moves this with it."""
    override = os.environ.get("EXOCORTEX_SPINOFF_CONTEXT_DIR")
    return Path(override) if override else store.DATA_DIR / ".spinoff_context"


def context_file(brief_id):
    """Write this brief's context out and return the file's path, for a turn's
    `--append-system-prompt-file`. None when the brief has no context.

    This is a cache that is rebuilt on demand: the database is the record, and
    the file is written again at the start of every turn, so deleting the
    folder loses nothing."""
    body = context(brief_id)
    if not body:
        return None
    path = _cache_dir() / f"{int(brief_id)}.md"
    try:
        if not path.exists() or path.read_text(encoding="utf-8") != body:
            store.write_text_file(path, body)
    except OSError:
        return None
    return str(path)


# --- Handoffs ---------------------------------------------------------------------

def save_handoff(conv_id, body, at=None, slug=None, imported_from=None):
    """Keep a session's handoff. Returns its row id."""
    conn = sqlstore.open_db()
    try:
        sqlstore.begin_immediate(conn)
        handoff_id = conn.execute(
            "INSERT INTO spinoff_handoffs (conv, at, body, slug, imported_from)"
            " VALUES (?, ?, ?, ?, ?)", (conv_id, at or _now(), body, slug, imported_from)).lastrowid
        conn.execute("COMMIT")
        return handoff_id
    finally:
        conn.close()


def handoff_taken(handoff_id, to_conv):
    """Record which session took a handoff over."""
    conn = sqlstore.open_db()
    try:
        sqlstore.begin_immediate(conn)
        conn.execute("UPDATE spinoff_handoffs SET to_conv = ? WHERE id = ?", (to_conv, handoff_id))
        conn.execute("COMMIT")
    finally:
        conn.close()


def handoffs(conv_id):
    """The handoffs a session wrote and the ones it was started from, oldest
    first, each a dict."""
    rows = _all("SELECT " + ", ".join(_HANDOFF_COLUMNS) + " FROM spinoff_handoffs"
                " WHERE conv = ? OR to_conv = ? ORDER BY at, id", (conv_id, conv_id))
    return [dict(zip(_HANDOFF_COLUMNS, row)) for row in rows]
