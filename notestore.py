"""Her notes as real rows — the first typed table here that is the DESTINATION.

**What this is.** Dev notes and idea notes used to live as two blobs: one row
each in the `docs` table, holding the whole `{"tabs": {page: [note, ...]}}`
document as text. This module replaces those blobs with two real tables
(`notes`, `note_judgments` — schema in sqlstore.py, rung 18) and keeps the
document as the *interface*, so nothing upstream has to change.

**The one idea the whole file rests on.** There is ONE function that turns rows
into the old document shape (`_as_document`), and it has two consumers: reads
return it, and the JSON mirror on disk is written from it. That is what stops
the file and the API drifting apart — they cannot disagree, because they are
the same sentence spoken twice.

**How it differs from every other typed store here.** `habitstore`, `todostore`,
`cardstore`, `codestore` are all REPORTS: they read a blob and rebuild their
tables from scratch, so their rows are disposable. These tables are where the
writing actually goes, and `dev_notes.json` / `idea_notes.json` become
photographs of them. There is deliberately no `rebuild()` — there would be
nothing to rebuild from.

**What is deliberately not preserved.** A page with no notes in it disappears
from the exported document, and pages come out alphabetically rather than in
the order they were first used. An empty page is punctuation, not data: adding
a note to a page that "doesn't exist" simply writes a row with that page on it.
This was the owner's call, and it is the reason the exported file will differ
from its pre-migration self by exactly those two things and nothing else.

Touches: `sqlstore.py` (the tables + the connection), `store.py` (dispatches
dev_notes / idea_notes here), `devnote_judgments.py` (the vocabulary the
`note_judgments` rows speak), `routes/devnotes.py` and every other caller
(unchanged — they still see the document), `tests/test_notestore.py`.

Prompt that produced this file: "i want there to be a column for the page it's
on and a column for the content and every row is one note with created dates
and stuff. i want it to be in an sql database. i am wondering if there is a way
to create a json mirror and whether it would make more sense to mirror it by
having the UI write it straight from the entry or have another code write it
out from the sql page."
"""
from contextlib import contextmanager
import json

import sqlstore
import store

# The two collections this module owns, and the `kind` each becomes. Both live
# in ONE table told apart by this value, so "send this to ideas" is an UPDATE
# of one column rather than a delete here and an append there.
COLLECTIONS = {"dev_notes": "dev", "idea_notes": "idea"}

# The note keys that have their own column. `night_questions` is spelled
# `questions` in the table; everything else keeps its name.
_NOTE_KEYS = frozenset(("id", "text", "created", "judgments", "night_questions"))

# The judgment keys that have their own column (devnote_judgments.make writes
# exactly these). The document's `note` is the table's `comment`.
_JUDGMENT_KEYS = frozenset(("verdict", "at", "by", "note", "reason"))


def _extra(obj, known):
    """Anything a writer put here that has no column of its own, kept verbatim.

    A blob accepts any shape for free; a table does not, and silently dropping
    a key a future feature adds would be data loss that nothing announces. So
    unknown keys ride along as JSON and come back out on the far side. Normally
    this is empty — if it ever isn't, that is the signal that something wants a
    real column.
    """
    leftovers = {k: v for k, v in obj.items() if k not in known}
    return json.dumps(leftovers, ensure_ascii=False) if leftovers else None


def _rejoin(base, extra_json):
    """Put the no-column keys back on a dict, after the ones that have columns."""
    if extra_json:
        base.update(json.loads(extra_json))
    return base


# --- rows -> the document ----------------------------------------------------

def _as_document(conn, kind):
    """One kind's rows, assembled into the legacy {"tabs": {page: [...]}} shape.

    The single source of the document shape: reads return this, and the mirror
    file is written from this. Key order is reproduced exactly as the blob
    stored it — id, text, created, judgments, night_questions — because dict
    order is what the JSON file shows, and a reordered file is a diff the owner
    has to read for no reason.
    """
    # Collect every judgment first, so each note is built in one pass. Ordered
    # by seq, which is what makes "the last entry is the current verdict" true.
    judgments = {}
    for nid, verdict, comment, reason, at, by, extra_json in conn.execute(
        "SELECT note_id, verdict, comment, reason, at, by, extra"
        " FROM note_judgments WHERE note_kind = ? ORDER BY note_id, seq",
        (kind,),
    ):
        entry = {"verdict": verdict}
        if at is not None:
            entry["at"] = at
        if by is not None:
            entry["by"] = by
        if comment is not None:
            entry["note"] = comment
        if reason is not None:
            entry["reason"] = reason
        judgments.setdefault(nid, []).append(_rejoin(entry, extra_json))

    # Pages alphabetically, notes by position within a page. Empty pages have
    # no rows and so cannot appear — see the file block above.
    tabs = {}
    for nid, page, text, created, questions, extra_json in conn.execute(
        "SELECT id, page, text, created, questions, extra"
        " FROM notes WHERE kind = ? ORDER BY page, position",
        (kind,),
    ):
        note = {"id": nid, "text": text}
        if created is not None:
            note["created"] = created
        if nid in judgments:
            note["judgments"] = judgments[nid]
        if questions is not None:
            note["night_questions"] = questions
        tabs.setdefault(page, []).append(_rejoin(note, extra_json))
    return {"tabs": tabs}


# --- the document -> rows ----------------------------------------------------

def _flatten(kind, doc):
    """A document taken apart into the rows it describes.

    Position is the note's index in its page's list — the list order IS the
    data, and `created` cannot stand in for it (six pairs of notes share a
    minute). Two notes with the same id in one document is not a shape the app
    can produce; if one ever arrives, the later one wins, the same way a dict
    key does.
    """
    notes, judgments = {}, {}
    for page, items in ((doc or {}).get("tabs") or {}).items():
        for position, note in enumerate(items or []):
            if not isinstance(note, dict):
                continue
            nid = str(note.get("id") or "")
            if not nid:
                continue
            notes[nid] = (
                str(page),
                str(note.get("text") or ""),
                note.get("created"),
                position,
                note.get("night_questions"),
                _extra(note, _NOTE_KEYS),
            )
            rulings = note.get("judgments")
            rows = []
            if isinstance(rulings, list):
                for seq, j in enumerate(rulings, 1):
                    if not isinstance(j, dict):
                        continue
                    rows.append((
                        seq, j.get("verdict"), j.get("note"), j.get("reason"),
                        j.get("at"), j.get("by"), _extra(j, _JUDGMENT_KEYS),
                    ))
            judgments[nid] = rows
    return notes, judgments


def _replace(conn, kind, doc):
    """Make this kind's rows say exactly what the document says.

    A DIFF rather than a wipe-and-refill, for one reason: `updated_at` is meant
    to answer "when did this note last change", and refilling the table on every
    write would stamp all 172 rows every time anyone touched one — a column that
    says "just now" about everything says nothing.
    """
    want_notes, want_judgments = _flatten(kind, doc)

    have = {
        r[0]: tuple(r[1:])
        for r in conn.execute(
            "SELECT id, page, text, created, position, questions, extra"
            " FROM notes WHERE kind = ?", (kind,))
    }
    # Notes first, judgments after: a judgment's foreign key needs its note to
    # already be there.
    for nid, row in want_notes.items():
        before = have.pop(nid, None)
        if before is None:
            conn.execute(
                "INSERT INTO notes (kind, id, page, text, created, position,"
                " questions, extra) VALUES (?,?,?,?,?,?,?,?)", (kind, nid) + row)
        elif before != row:
            conn.execute(
                "UPDATE notes SET page = ?, text = ?, created = ?, position = ?,"
                " questions = ?, extra = ?,"
                " updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')"
                " WHERE kind = ? AND id = ?", row + (kind, nid))
    # Whatever the document no longer mentions is gone. Its judgments go with
    # it, by the foreign key rather than by anyone remembering.
    for nid in have:
        conn.execute("DELETE FROM notes WHERE kind = ? AND id = ?", (kind, nid))

    have_judgments = {}
    for row in conn.execute(
        "SELECT note_id, seq, verdict, comment, reason, at, by, extra"
        " FROM note_judgments WHERE note_kind = ? ORDER BY note_id, seq", (kind,)
    ):
        have_judgments.setdefault(row[0], []).append(tuple(row[1:]))
    # Judgments are append-only in practice, but they are replaced as a whole
    # list here: comparing first means an unchanged note writes nothing at all.
    for nid, rows in want_judgments.items():
        if have_judgments.get(nid, []) == rows:
            continue
        conn.execute(
            "DELETE FROM note_judgments WHERE note_kind = ? AND note_id = ?",
            (kind, nid))
        conn.executemany(
            "INSERT INTO note_judgments (note_kind, note_id, seq, verdict,"
            " comment, reason, at, by, extra) VALUES (?,?,?,?,?,?,?,?,?)",
            [(kind, nid) + r for r in rows])


# --- what store.py calls -----------------------------------------------------

def _export_mirror(collection, doc):
    """Write the JSON mirror at the collection's old path.

    Derived output, exactly as the blob path does it (sqlstore._export_mirror):
    store's atomic writer directly, never store.write, which would dispatch
    straight back here.
    """
    store.write_file(collection, doc)


def get(collection, default=None):
    """Read a collection as the document shape. `default` is accepted to match
    store's signature and ignored: a kind with no rows is {"tabs": {}}, which is
    what every caller passes as its default anyway."""
    conn = sqlstore.open_db()
    try:
        return _as_document(conn, COLLECTIONS[collection])
    finally:
        conn.close()


def put(collection, data):
    """Replace a collection's rows from a document, then re-export the mirror.

    The mirror is written from the ROWS, not from `data` — same function a read
    goes through. If the two could differ, that difference is a bug, and writing
    the file from the input would be exactly the way to hide it.
    """
    kind = COLLECTIONS[collection]
    conn = sqlstore.open_db()
    try:
        sqlstore.begin_immediate(conn)
        _replace(conn, kind, data)
        doc = _as_document(conn, kind)
        conn.execute("COMMIT")
    except BaseException:
        try:
            conn.execute("ROLLBACK")
        except Exception:
            pass
        raise
    finally:
        conn.close()
    _export_mirror(collection, doc)


@contextmanager
def mutate(collection, default=None):
    """Read-modify-write one collection inside a single write transaction.

    Same contract as sqlstore.mutate, which is what every caller here is already
    using: the write lock is taken up front so concurrent writers serialize, and
    an exception inside the block writes nothing.
    """
    kind = COLLECTIONS[collection]
    conn = sqlstore.open_db()
    try:
        sqlstore.begin_immediate(conn)
        doc = _as_document(conn, kind)
        yield doc
        _replace(conn, kind, doc)
        out = _as_document(conn, kind)
        conn.execute("COMMIT")
    except BaseException:
        try:
            conn.execute("ROLLBACK")
        except Exception:
            pass
        raise
    finally:
        conn.close()
    _export_mirror(collection, out)
