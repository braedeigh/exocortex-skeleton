"""The research pool as real rows — topics, entries, sessions, annotations,
and the first tables that only make sense once entries are rows: which sources
back which claim, and the number inside a claim.

**What this is.** Two documents used to live as two blobs in the `docs` table:
`research` ({"topics", "entries", "sessions"}) and `annotations`
({"annotations"}). This module replaces both with typed tables (schema in
sqlstore.py, rung 21) and keeps the DOCUMENT as the interface, exactly the way
notestore.py did for the notes: routes/research.py and routes/annotations.py
still call store.read / store.mutate and still get the same shape back, so
neither of them changes.

**The one idea the whole file rests on** is notestore's: ONE function turns
rows into the document (`_as_document`), and it has two consumers — reads
return it, and the JSON mirror on disk is written from it. The file and the API
cannot disagree because they are the same sentence spoken twice.

**Seeding, the first time the tables are touched.** If the tables are empty the
blob row in `docs` is adopted (or, failing that, the legacy JSON file), and the
blob row is then deleted so it cannot be re-adopted later over a pool the owner
has since emptied. THEN the JSON mirror file is read as well and any topic,
entry or session whose id is absent is imported — deliberately: the owner's
mirror holds records that were written to the file directly and never reached
the database, and she asked for them to come in. `seed()` returns what it did.

**What is deliberately not preserved.** Optional keys come back in one fixed
order per record (the blob kept whichever order the writer happened to use), a
topic without a `fronts` key comes back with `"fronts": []`, and a duplicate id
inside one list — a shape the app cannot produce — resolves to the later one.
Everything else round-trips exactly: list order (kept in a `position`/`seq`
column, because the live entries are in neither created-order nor id-order),
the difference between a flag set to false and a flag never set, and any key
with no column of its own (kept in `extra`).

**The typed helpers** at the bottom (`list_claims`, `claim_detail`,
`link_claim_source`, `add_annotation`, `set_claim_value`, `set_session_link`, …)
are the seam another phase writes the claims routes against. They read and
write rows directly; the ones that touch a document's rows re-export its mirror.

Touches: `sqlstore.py` (the tables + the connection), `store.py` (dispatches
research / annotations here), `routes/research.py` and `routes/annotations.py`
(unchanged — they still see the documents), `tests/test_researchstore.py`.

Prompt that produced this file: "a blob (`docs` row) becomes typed tables,
`_as_document()` feeds both reads and the JSON mirror, `_flatten`/`_replace`
diff against existing rows, `get/put/mutate` match sqlstore's contract …
seed from the `docs` blob row if present, else from the legacy JSON file. THEN
also read the JSON mirror file and import any topic/entry/session whose id is
absent from what was just seeded."
"""
from contextlib import contextmanager
from datetime import datetime
import json
import logging

import sqlstore
import store

log = logging.getLogger(__name__)

# The two collections this module owns, with the empty document each starts as.
EMPTY = {
    "research": {"topics": [], "entries": [], "sessions": []},
    "annotations": {"annotations": []},
}

# The keys of each record that have a column of their own (or a child table).
# Anything else rides along in `extra`.
_TOPIC_KEYS = frozenset(("id", "name", "status", "created", "fronts"))
_ENTRY_KEYS = frozenset((
    "id", "kind", "text", "topics", "url", "verdict", "status", "reply_to",
    "created", "author", "reviewed", "flagged", "processed", "session",
    "re_quote", "context_ids", "file", "origin",
))
_SESSION_KEYS = frozenset((
    "id", "entry_ids", "topics", "created", "status", "report", "mode",
    "worker", "attempts", "claude_session", "claude_cwd", "conv_id", "run_id",
))
_ANNOTATION_KEYS = frozenset(("id", "doc", "content", "needs_review", "selector", "created"))
_CONTENT_KEYS = frozenset(("kind", "note", "source"))
_SELECTOR_KEYS = frozenset(("exact", "char_start", "char_end"))

STANCES = ("supports", "contradicts", "context")
_VALUE_FIELDS = ("subject", "measure", "amount", "unit", "basis", "year", "tier")


def _extra(obj, known):
    """Anything a writer put here that has no column of its own, kept verbatim.

    A blob accepts any shape for free; a table does not, and silently dropping
    a key a future feature adds would be data loss that nothing announces. So
    unknown keys ride along as JSON and come back out on the far side.
    """
    leftovers = {k: v for k, v in obj.items() if k not in known}
    return json.dumps(leftovers, ensure_ascii=False) if leftovers else None


def _rejoin(base, extra_json):
    """Put the no-column keys back on a dict, after the ones that have columns."""
    if extra_json:
        base.update(json.loads(extra_json))
    return base


def _flag(value):
    """A document's yes/no as a 0/1 column, keeping 'never set' as NULL."""
    return None if value is None else int(bool(value))


def _unflag(value):
    """A 0/1 column back as the document's bool, NULL staying absent."""
    return None if value is None else bool(value)


def _ids(value):
    """A document's list of ids as a de-duplicated list of strings.

    Duplicates collapse (first wins) because the child tables key on the id:
    an entry tagged with the same topic twice is one tag.
    """
    if not isinstance(value, list):
        return []
    seen, out = set(), []
    for item in value:
        item = str(item)
        if item not in seen:
            seen.add(item)
            out.append(item)
    return out


def _now_stamp():
    return datetime.now().strftime("%Y-%m-%d %H:%M")


# --- rows -> the research document -----------------------------------------------

def _research_document(conn):
    """The research rows, assembled into {"topics", "entries", "sessions"}.

    The single source of the document shape: reads return this, and the mirror
    file is written from this. Core keys come first in the order the routes
    write them; optional keys follow in one fixed order, present only when the
    row has them — so a flag that was never set stays absent rather than
    becoming false.
    """
    # Every child list first, grouped by parent, so each record is built in
    # one pass. Ordered by seq, which is the list order the document had.
    def grouped(sql):
        out = {}
        for parent, child in conn.execute(sql):
            out.setdefault(parent, []).append(child)
        return out

    topic_fronts = grouped(
        "SELECT topic_id, front FROM research_topic_fronts ORDER BY topic_id, seq")
    entry_topics = grouped(
        "SELECT entry_id, topic_id FROM research_entry_topics ORDER BY entry_id, seq")
    entry_context = grouped(
        "SELECT entry_id, context_id FROM research_entry_context ORDER BY entry_id, seq")
    session_entries = grouped(
        "SELECT session_id, entry_id FROM research_session_entries ORDER BY session_id, seq")
    session_topics = grouped(
        "SELECT session_id, topic_id FROM research_session_topics ORDER BY session_id, seq")

    topics = []
    for tid, name, status, created, extra_json in conn.execute(
        "SELECT id, name, status, created, extra FROM research_topics ORDER BY position, id"
    ):
        topic = {"id": tid, "name": name, "status": status, "created": created,
                 "fronts": topic_fronts.get(tid, [])}
        topics.append(_rejoin(topic, extra_json))

    entries = []
    for row in conn.execute(
        "SELECT id, kind, text, url, verdict, status, reply_to, created,"
        " author, reviewed, flagged, processed, session, re_quote, file, origin, extra"
        " FROM research_entries ORDER BY position, id"
    ):
        (eid, kind, text, url, verdict, status, reply_to, created, author,
         reviewed, flagged, processed, session, re_quote, file, origin, extra_json) = row
        entry = {"id": eid, "kind": kind, "text": text,
                 "topics": entry_topics.get(eid, []), "url": url,
                 "verdict": verdict, "status": status, "reply_to": reply_to,
                 "created": created}
        # Optional keys, in the order they are born: what the entry was
        # written against, then the owner's flag and the runner's mark, then
        # what an llm reply carries, then where an import came from.
        if re_quote is not None:
            entry["re_quote"] = re_quote
        if eid in entry_context:
            entry["context_ids"] = entry_context[eid]
        if flagged is not None:
            entry["flagged"] = bool(flagged)
        if processed is not None:
            entry["processed"] = bool(processed)
        if author is not None:
            entry["author"] = author
        if reviewed is not None:
            entry["reviewed"] = bool(reviewed)
        if session is not None:
            entry["session"] = session
        if file is not None:
            entry["file"] = file
        if origin is not None:
            entry["origin"] = origin
        entries.append(_rejoin(entry, extra_json))

    sessions = []
    for row in conn.execute(
        "SELECT id, created, status, report, mode, worker, attempts,"
        " claude_session, claude_cwd, conv_id, run_id, extra"
        " FROM research_sessions ORDER BY position, id"
    ):
        (sid, created, status, report, mode, worker, attempts,
         claude_session, claude_cwd, conv_id, run_id, extra_json) = row
        session = {"id": sid, "entry_ids": session_entries.get(sid, []),
                   "topics": session_topics.get(sid, []), "created": created,
                   "status": status, "report": report}
        for key, value in (("mode", mode), ("worker", _unflag(worker)),
                           ("attempts", attempts),
                           ("claude_session", claude_session),
                           ("claude_cwd", claude_cwd),
                           ("conv_id", conv_id), ("run_id", run_id)):
            if value is not None:
                session[key] = value
        sessions.append(_rejoin(session, extra_json))

    return {"topics": topics, "entries": entries, "sessions": sessions}


# --- rows -> the annotations document -----------------------------------------------

def _annotations_document(conn):
    """The annotation rows, assembled into {"annotations": [...]} — each with
    its nested `content` and `selector` maps folded back from the columns.

    Same single-source rule as the research document above. A content or
    selector key that had no column comes back inside its map, from `extra`.
    """
    annotations = []
    for row in conn.execute(
        "SELECT id, doc, char_start, char_end, exact, kind, note, source,"
        " needs_review, created, extra FROM research_annotations ORDER BY position, id"
    ):
        (aid, doc, char_start, char_end, exact, kind, note, source,
         needs_review, created, extra_json) = row
        leftovers = json.loads(extra_json) if extra_json else {}
        content = {}
        for key, value in (("kind", kind), ("note", note), ("source", source)):
            if value is not None:
                content[key] = value
        content.update(leftovers.pop("content", {}))
        selector = {"exact": exact, "char_start": char_start, "char_end": char_end}
        selector.update(leftovers.pop("selector", {}))
        annotation = {"id": aid, "doc": doc, "content": content,
                      "needs_review": _unflag(needs_review), "selector": selector,
                      "created": created}
        annotation.update(leftovers)
        annotations.append(annotation)
    return {"annotations": annotations}


def _as_document(conn, collection):
    """One collection's rows as its document — the one door every read and
    every mirror export goes through."""
    if collection == "research":
        return _research_document(conn)
    if collection == "annotations":
        return _annotations_document(conn)
    raise KeyError(collection)


# --- the document -> rows -----------------------------------------------------------

def _flatten_research(doc):
    """A research document taken apart into the rows it describes.

    Each record becomes (columns..., position, child lists...). Position is the
    record's index in its list — the list order IS the data. A repeated id in
    one list resolves to the later one, the same way a dict key does.
    """
    doc = doc or {}
    topics, entries, sessions = {}, {}, {}
    for position, topic in enumerate(doc.get("topics") or []):
        if not isinstance(topic, dict) or not topic.get("id"):
            continue
        topics[str(topic["id"])] = (
            (str(topic.get("name") or ""), topic.get("status"), topic.get("created"),
             _extra(topic, _TOPIC_KEYS)),
            position,
            _ids(topic.get("fronts")),
        )
    for position, entry in enumerate(doc.get("entries") or []):
        if not isinstance(entry, dict) or not entry.get("id"):
            continue
        entries[str(entry["id"])] = (
            (entry.get("kind") or "note", str(entry.get("text") or ""),
             entry.get("url"), entry.get("verdict"), entry.get("status"),
             entry.get("reply_to"), entry.get("created"), entry.get("author"),
             _flag(entry.get("reviewed")), _flag(entry.get("flagged")),
             _flag(entry.get("processed")), entry.get("session"),
             entry.get("re_quote"), entry.get("file"), entry.get("origin"),
             _extra(entry, _ENTRY_KEYS)),
            position,
            _ids(entry.get("topics")),
            [str(x) for x in entry.get("context_ids") or []]
            if isinstance(entry.get("context_ids"), list) else None,
        )
    for position, session in enumerate(doc.get("sessions") or []):
        if not isinstance(session, dict) or not session.get("id"):
            continue
        sessions[str(session["id"])] = (
            (session.get("created"), session.get("status"), session.get("report"),
             session.get("mode"), _flag(session.get("worker")), session.get("attempts"),
             session.get("claude_session"), session.get("claude_cwd"),
             session.get("conv_id"), session.get("run_id"),
             _extra(session, _SESSION_KEYS)),
            position,
            [str(x) for x in session.get("entry_ids") or []],
            _ids(session.get("topics")),
        )
    return topics, entries, sessions


def _flatten_annotations(doc):
    """An annotations document taken apart into rows: the nested `content` and
    `selector` maps become columns, and whatever else they held goes to `extra`
    under a `content` / `selector` key so it can be folded back."""
    rows = {}
    for position, ann in enumerate(((doc or {}).get("annotations")) or []):
        if not isinstance(ann, dict) or not ann.get("id"):
            continue
        content = ann.get("content") if isinstance(ann.get("content"), dict) else {}
        selector = ann.get("selector") if isinstance(ann.get("selector"), dict) else {}
        leftovers = {k: v for k, v in ann.items() if k not in _ANNOTATION_KEYS}
        content_left = {k: v for k, v in content.items() if k not in _CONTENT_KEYS}
        selector_left = {k: v for k, v in selector.items() if k not in _SELECTOR_KEYS}
        if content_left:
            leftovers["content"] = content_left
        if selector_left:
            leftovers["selector"] = selector_left
        rows[str(ann["id"])] = (
            (str(ann.get("doc") or ""), selector.get("char_start"),
             selector.get("char_end"), selector.get("exact"),
             content.get("kind"), content.get("note"), content.get("source"),
             _flag(ann.get("needs_review")), ann.get("created"),
             json.dumps(leftovers, ensure_ascii=False) if leftovers else None),
            position,
        )
    return rows


def _sync_parents(conn, table, columns, want, have_sql):
    """Make one parent table's rows say exactly what the document says.

    A DIFF rather than a wipe-and-refill: `updated_at` is meant to answer "when
    did this record last change", and refilling would restamp every row on
    every write. Position is diffed separately from content, so deleting an
    entry from the middle of the list — which shifts every later position —
    does not restamp the entries that merely moved down one.

    `want` is {id: (content tuple, position, ...children)}; `have_sql` selects
    id, content columns, position in the same order.
    """
    have = {r[0]: (tuple(r[1:-1]), r[-1]) for r in conn.execute(have_sql)}
    column_list = ", ".join(columns)
    placeholders = ",".join("?" * (len(columns) + 2))
    assignments = ", ".join(f"{c} = ?" for c in columns)
    for rid, spec in want.items():
        content, position = spec[0], spec[1]
        before = have.pop(rid, None)
        if before is None:
            conn.execute(
                f"INSERT INTO {table} (id, {column_list}, position) VALUES ({placeholders})",
                (rid,) + content + (position,))
        elif before[0] != content:
            conn.execute(
                f"UPDATE {table} SET {assignments}, position = ?,"
                " updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?",
                content + (position, rid))
        elif before[1] != position:
            conn.execute(f"UPDATE {table} SET position = ? WHERE id = ?", (position, rid))
    # Whatever the document no longer mentions is gone. Its children go with
    # it by the foreign key — and so do a claim's source links, which is the
    # point of the cascade.
    for rid in have:
        conn.execute(f"DELETE FROM {table} WHERE id = ?", (rid,))


def _sync_children(conn, table, parent_column, child_column, want):
    """Make one child table's lists say exactly what the document says.

    `want` is {parent id: [child values] or None}. Compared list-for-list
    first, so a parent whose list did not change writes nothing; a changed
    list is deleted and re-inserted whole, seq being its index.
    """
    have = {}
    for parent, child in conn.execute(
        f"SELECT {parent_column}, {child_column} FROM {table} ORDER BY {parent_column}, seq"
    ):
        have.setdefault(parent, []).append(child)
    for parent, children in want.items():
        children = children or []
        if have.get(parent, []) == children:
            continue
        conn.execute(f"DELETE FROM {table} WHERE {parent_column} = ?", (parent,))
        conn.executemany(
            f"INSERT INTO {table} ({parent_column}, seq, {child_column}) VALUES (?,?,?)",
            [(parent, seq, child) for seq, child in enumerate(children)])


def _replace_research(conn, doc):
    """Make the research rows say exactly what the document says."""
    topics, entries, sessions = _flatten_research(doc)
    _sync_parents(conn, "research_topics", ("name", "status", "created", "extra"), topics,
                  "SELECT id, name, status, created, extra, position FROM research_topics")
    _sync_children(conn, "research_topic_fronts", "topic_id", "front",
                   {tid: spec[2] for tid, spec in topics.items()})
    _sync_parents(
        conn, "research_entries",
        ("kind", "text", "url", "verdict", "status", "reply_to", "created", "author",
         "reviewed", "flagged", "processed", "session", "re_quote", "file", "origin", "extra"),
        entries,
        "SELECT id, kind, text, url, verdict, status, reply_to, created, author,"
        " reviewed, flagged, processed, session, re_quote, file, origin, extra, position"
        " FROM research_entries")
    _sync_children(conn, "research_entry_topics", "entry_id", "topic_id",
                   {eid: spec[2] for eid, spec in entries.items()})
    _sync_children(conn, "research_entry_context", "entry_id", "context_id",
                   {eid: spec[3] for eid, spec in entries.items()})
    _sync_parents(
        conn, "research_sessions",
        ("created", "status", "report", "mode", "worker", "attempts",
         "claude_session", "claude_cwd", "conv_id", "run_id", "extra"),
        sessions,
        "SELECT id, created, status, report, mode, worker, attempts,"
        " claude_session, claude_cwd, conv_id, run_id, extra, position FROM research_sessions")
    _sync_children(conn, "research_session_entries", "session_id", "entry_id",
                   {sid: spec[2] for sid, spec in sessions.items()})
    _sync_children(conn, "research_session_topics", "session_id", "topic_id",
                   {sid: spec[3] for sid, spec in sessions.items()})


def _replace_annotations(conn, doc):
    """Make the annotation rows say exactly what the document says."""
    _sync_parents(
        conn, "research_annotations",
        ("doc", "char_start", "char_end", "exact", "kind", "note", "source",
         "needs_review", "created", "extra"),
        _flatten_annotations(doc),
        "SELECT id, doc, char_start, char_end, exact, kind, note, source,"
        " needs_review, created, extra, position FROM research_annotations")


def _replace(conn, collection, doc):
    if collection == "research":
        _replace_research(conn, doc)
    elif collection == "annotations":
        _replace_annotations(conn, doc)
    else:
        raise KeyError(collection)


# --- seeding, the first time the tables are touched ----------------------------------

def _is_empty(conn, collection):
    """True when a collection has no rows at all — the signal to seed."""
    tables = (("research_topics", "research_entries", "research_sessions")
              if collection == "research" else ("research_annotations",))
    return all(
        conn.execute(f"SELECT 1 FROM {table} LIMIT 1").fetchone() is None
        for table in tables)


def _read_mirror(collection):
    """The JSON mirror file as a document, or None when there is none or it is
    unreadable — the mirror is a photograph, and a torn one is not an error."""
    path = store.file_path(collection)
    if not path.exists():
        return None
    try:
        doc = json.loads(path.read_text())
    except (OSError, ValueError):
        return None
    return doc if isinstance(doc, dict) else None


def _seed(conn, collection):
    """Adopt the blob (or the legacy file) into empty tables, then import
    anything the mirror file has that the tables still lack. Lock held.

    Returns a report of what happened, or None when the tables were not empty.
    The blob row is deleted once adopted: left in place, it would be re-adopted
    the next time the tables were empty — resurrecting a pool the owner had
    deliberately cleared.
    """
    if not _is_empty(conn, collection):
        return None
    report = {"seeded_from": None, "mirror_added": {}}
    row = conn.execute("SELECT data FROM docs WHERE name = ?", (collection,)).fetchone()
    doc = None
    if row is not None:
        try:
            doc = json.loads(row[0])
            report["seeded_from"] = "blob"
        except ValueError:
            doc = None
    if doc is None:
        doc = _read_mirror(collection)
        if doc is not None:
            report["seeded_from"] = "file"
    if doc is not None:
        _replace(conn, collection, doc)
    if row is not None:
        conn.execute("DELETE FROM docs WHERE name = ?", (collection,))

    # The mirror's strays: any record the file has and the rows do not. The
    # file is the one place a record can be written by hand or by a script
    # that bypassed the store, and those records are hers too.
    if report["seeded_from"] != "file":
        mirror = _read_mirror(collection)
        if mirror is not None:
            current = _as_document(conn, collection)
            for key in EMPTY[collection]:
                have = {str(r.get("id")) for r in current.get(key) or [] if isinstance(r, dict)}
                strays = [r for r in mirror.get(key) or []
                          if isinstance(r, dict) and r.get("id") and str(r["id"]) not in have]
                if strays:
                    current[key].extend(strays)
                    report["mirror_added"][key] = [str(r["id"]) for r in strays]
            if report["mirror_added"]:
                _replace(conn, collection, current)
    if report["seeded_from"] or report["mirror_added"]:
        log.info("researchstore seeded %s: %s", collection, report)
    return report


def seed(collection):
    """Seed one collection now, in its own transaction, and say what came in.

    Every read and write path does this on its own the first time it finds the
    tables empty; this is the door for a script or a test that wants the
    report. Returns None when there was nothing to do.
    """
    conn = sqlstore.open_db()
    try:
        sqlstore.begin_immediate(conn)
        report = _seed(conn, collection)
        conn.execute("COMMIT")
    except BaseException:
        try:
            conn.execute("ROLLBACK")
        except Exception:
            pass
        raise
    finally:
        conn.close()
    if report and (report["seeded_from"] or report["mirror_added"]):
        _export_mirror(collection, get(collection))
    return report


# --- what store.py calls -------------------------------------------------------------

def _export_mirror(collection, doc):
    """Write the JSON mirror at the collection's old path.

    Derived output, exactly as the blob path does it (sqlstore._export_mirror):
    store's atomic writer directly, never store.write, which would dispatch
    straight back here.
    """
    store.write_file(collection, doc)


def get(collection, default=None):
    """Read a collection as its document. `default` is accepted to match
    store's signature and ignored: a collection with no rows is its EMPTY
    document, which is what every caller passes as its default anyway."""
    if collection not in EMPTY:
        raise KeyError(collection)
    conn = sqlstore.open_db()
    try:
        # Seed on a read too, but only take the write lock when there is
        # something to seed — an ordinary read stays lock-free.
        if _is_empty(conn, collection):
            sqlstore.begin_immediate(conn)
            try:
                _seed(conn, collection)
                conn.execute("COMMIT")
            except BaseException:
                try:
                    conn.execute("ROLLBACK")
                except Exception:
                    pass
                raise
        return _as_document(conn, collection)
    finally:
        conn.close()


def put(collection, data):
    """Replace a collection's rows from a document, then re-export the mirror.

    The mirror is written from the ROWS, not from `data` — same function a read
    goes through. Seeds first so the blob row is retired even when the first
    ever touch is a write.
    """
    if collection not in EMPTY:
        raise KeyError(collection)
    conn = sqlstore.open_db()
    try:
        sqlstore.begin_immediate(conn)
        _seed(conn, collection)
        _replace(conn, collection, data)
        doc = _as_document(conn, collection)
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

    Same contract as sqlstore.mutate, which is what every caller here already
    uses: the write lock is taken up front so concurrent writers serialize, and
    an exception inside the block writes nothing.
    """
    if collection not in EMPTY:
        raise KeyError(collection)
    conn = sqlstore.open_db()
    try:
        sqlstore.begin_immediate(conn)
        _seed(conn, collection)
        doc = _as_document(conn, collection)
        yield doc
        _replace(conn, collection, doc)
        out = _as_document(conn, collection)
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


@contextmanager
def _writing(collection_to_export=None):
    """One write transaction for the typed helpers below: lock, yield the
    connection, commit — and re-export a document's mirror afterwards when the
    write touched rows that document is built from."""
    conn = sqlstore.open_db()
    try:
        sqlstore.begin_immediate(conn)
        yield conn
        conn.execute("COMMIT")
    except BaseException:
        try:
            conn.execute("ROLLBACK")
        except Exception:
            pass
        raise
    finally:
        conn.close()
    if collection_to_export:
        _export_mirror(collection_to_export, get(collection_to_export))


# --- the claims view: typed helpers another phase writes routes against --------------

def _entry_row(conn, entry_id):
    row = conn.execute(
        "SELECT id, kind, text, url, verdict, created, author, reviewed"
        " FROM research_entries WHERE id = ?", (entry_id,)).fetchone()
    if row is None:
        return None
    return dict(zip(("id", "kind", "text", "url", "verdict", "created", "author", "reviewed"), row))


def _value_row(conn, claim_id):
    """A claim's value row as a dict, or None when it has none."""
    row = conn.execute(
        "SELECT subject, measure, amount, unit, basis, year, tier, extra"
        " FROM claim_values WHERE claim_id = ?", (claim_id,)).fetchone()
    if row is None:
        return None
    return _rejoin(dict(zip(_VALUE_FIELDS, row[:-1])), row[-1])


def _claim_summary(conn, claim_id):
    """One claim as the claims list shows it: the entry's own fields plus its
    topics, the fronts those topics sit on, how many sources back it, and its
    value row. None for an id that is not a claim."""
    entry = _entry_row(conn, claim_id)
    if entry is None or entry["kind"] != "claim":
        return None
    topics = [r[0] for r in conn.execute(
        "SELECT topic_id FROM research_entry_topics WHERE entry_id = ? ORDER BY seq",
        (claim_id,))]
    fronts = []
    for (front,) in conn.execute(
        "SELECT f.front FROM research_topic_fronts f"
        " JOIN research_entry_topics t ON t.topic_id = f.topic_id"
        " WHERE t.entry_id = ? ORDER BY t.seq, f.seq", (claim_id,)):
        if front not in fronts:
            fronts.append(front)
    source_count = conn.execute(
        "SELECT COUNT(*) FROM claim_sources WHERE claim_id = ?", (claim_id,)).fetchone()[0]
    return {
        "id": entry["id"], "text": entry["text"], "verdict": entry["verdict"],
        "topics": topics, "fronts": fronts, "created": entry["created"],
        "author": entry["author"], "reviewed": _unflag(entry["reviewed"]),
        "source_count": source_count, "value": _value_row(conn, claim_id),
    }


def list_claims(topic=None, front=None):
    """Every claim, in list order, optionally only those on one topic or on
    one front (a front reaches a claim through its topics)."""
    conn = sqlstore.open_db()
    try:
        sql = "SELECT id FROM research_entries e WHERE kind = 'claim'"
        params = []
        if topic is not None:
            sql += (" AND EXISTS (SELECT 1 FROM research_entry_topics t"
                    " WHERE t.entry_id = e.id AND t.topic_id = ?)")
            params.append(topic)
        if front is not None:
            sql += (" AND EXISTS (SELECT 1 FROM research_entry_topics t"
                    " JOIN research_topic_fronts f ON f.topic_id = t.topic_id"
                    " WHERE t.entry_id = e.id AND f.front = ?)")
            params.append(front)
        sql += " ORDER BY position, id"
        ids = [r[0] for r in conn.execute(sql, params)]
        return [_claim_summary(conn, cid) for cid in ids]
    finally:
        conn.close()


def _annotation_brief(conn, annotation_id):
    """The part of an annotation the claims view shows, or None."""
    if annotation_id is None:
        return None
    row = conn.execute(
        "SELECT id, doc, char_start, char_end, exact, note FROM research_annotations"
        " WHERE id = ?", (annotation_id,)).fetchone()
    if row is None:
        return None
    return dict(zip(("id", "doc", "char_start", "char_end", "exact", "note"), row))


def claim_detail(claim_id):
    """One claim with everything hung off it: the claim, each linked source
    with its stance and highlighted passage, and the claim's value."""
    conn = sqlstore.open_db()
    try:
        claim = _claim_summary(conn, claim_id)
        if claim is None:
            return None
        sources = []
        for source_id, stance, annotation_id, note in conn.execute(
            "SELECT source_id, stance, annotation_id, note FROM claim_sources"
            " WHERE claim_id = ? ORDER BY created, source_id", (claim_id,)):
            entry = _entry_row(conn, source_id) or {}
            sources.append({
                "id": source_id, "text": entry.get("text"), "url": entry.get("url"),
                "verdict": entry.get("verdict"), "stance": stance, "note": note,
                "annotation": _annotation_brief(conn, annotation_id),
                # The doc id routes/annotations.py uses for the source's
                # extracted text, so the view can open it for highlighting.
                "doc": f"entry:{source_id}",
            })
        return {"claim": claim, "sources": sources, "value": claim["value"]}
    finally:
        conn.close()


def claims_for_source(source_id):
    """Every claim a source is linked to, each with the link's stance and note
    added to the claim summary."""
    conn = sqlstore.open_db()
    try:
        out = []
        for claim_id, stance, note in conn.execute(
            "SELECT claim_id, stance, note FROM claim_sources WHERE source_id = ?"
            " ORDER BY created, claim_id", (source_id,)):
            claim = _claim_summary(conn, claim_id)
            if claim is not None:
                claim["stance"] = stance
                claim["note"] = note
                out.append(claim)
        return out
    finally:
        conn.close()


def link_claim_source(claim_id, source_id, *, stance="supports", annotation_id=None, note=""):
    """Say that a source backs (or contradicts, or contextualises) a claim.

    An upsert: linking the same pair again replaces the stance, annotation and
    note. Raises ValueError, with a plain message, when the claim is not a
    claim, either entry is missing, the stance is not one of STANCES, or the
    annotation does not exist — the foreign keys would refuse too, but with a
    message no route could show.
    """
    if stance not in STANCES:
        raise ValueError(f"bad stance {stance!r}; one of {', '.join(STANCES)}")
    with _writing() as conn:
        claim = _entry_row(conn, claim_id)
        if claim is None:
            raise ValueError(f"no entry {claim_id!r}")
        if claim["kind"] != "claim":
            raise ValueError(f"entry {claim_id!r} is a {claim['kind']}, not a claim")
        if _entry_row(conn, source_id) is None:
            raise ValueError(f"no entry {source_id!r}")
        if annotation_id is not None and _annotation_brief(conn, annotation_id) is None:
            raise ValueError(f"no annotation {annotation_id!r}")
        conn.execute(
            "INSERT INTO claim_sources (claim_id, source_id, stance, annotation_id, note, created)"
            " VALUES (?,?,?,?,?,?) ON CONFLICT(claim_id, source_id) DO UPDATE SET"
            " stance = excluded.stance, annotation_id = excluded.annotation_id,"
            " note = excluded.note",
            (claim_id, source_id, stance, annotation_id, note or "", _now_stamp()))


def unlink_claim_source(claim_id, source_id):
    """Remove one claim-source link. Returns whether there was one."""
    with _writing() as conn:
        cursor = conn.execute(
            "DELETE FROM claim_sources WHERE claim_id = ? AND source_id = ?",
            (claim_id, source_id))
        return cursor.rowcount > 0


def _new_annotation_id(conn):
    """An id in routes/annotations.py's scheme: 'ann-YYYY-MM-DD.HHMM', with
    '-2', '-3' ... on a same-minute collision."""
    base = "ann-" + datetime.now().strftime("%Y-%m-%d.%H%M")
    taken = {r[0] for r in conn.execute(
        "SELECT id FROM research_annotations WHERE id = ? OR id LIKE ?", (base, base + "-%"))}
    if base not in taken:
        return base
    i = 2
    while f"{base}-{i}" in taken:
        i += 1
    return f"{base}-{i}"


def add_annotation(doc, char_start, char_end, exact, *, note="", source="llm",
                   needs_review=True, kind="highlight"):
    """Add one annotation row directly, in the shape routes/annotations.py
    makes, and return its id. Goes on the end of the list, and re-exports
    annotations.json, since that document is built from these rows."""
    with _writing("annotations") as conn:
        annotation_id = _new_annotation_id(conn)
        position = conn.execute(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM research_annotations").fetchone()[0]
        conn.execute(
            "INSERT INTO research_annotations (id, doc, char_start, char_end, exact,"
            " kind, note, source, needs_review, created, position)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (annotation_id, doc, int(char_start), int(char_end), exact, kind, note or "",
             source, int(bool(needs_review)), _now_stamp(), position))
    return annotation_id


def set_claim_value(claim_id, **fields):
    """Set (or amend) the number inside a claim.

    Only the fields passed change; the rest keep what they had. A field passed
    as None is cleared. Any field that is not one of the columns (subject,
    measure, amount, unit, basis, year, tier) is kept in `extra`. Raises
    ValueError when the claim does not exist.
    """
    with _writing() as conn:
        if _entry_row(conn, claim_id) is None:
            raise ValueError(f"no entry {claim_id!r}")
        current = _value_row(conn, claim_id) or {}
        merged = {k: current.get(k) for k in _VALUE_FIELDS}
        extra = {k: v for k, v in current.items() if k not in _VALUE_FIELDS}
        for key, value in fields.items():
            if key in _VALUE_FIELDS:
                merged[key] = value
            elif value is None:
                extra.pop(key, None)
            else:
                extra[key] = value
        conn.execute(
            "INSERT INTO claim_values (claim_id, subject, measure, amount, unit, basis,"
            " year, tier, extra) VALUES (?,?,?,?,?,?,?,?,?)"
            " ON CONFLICT(claim_id) DO UPDATE SET subject = excluded.subject,"
            " measure = excluded.measure, amount = excluded.amount, unit = excluded.unit,"
            " basis = excluded.basis, year = excluded.year, tier = excluded.tier,"
            " extra = excluded.extra",
            (claim_id, merged["subject"], merged["measure"], merged["amount"], merged["unit"],
             merged["basis"], merged["year"], merged["tier"],
             json.dumps(extra, ensure_ascii=False) if extra else None))


def set_session_link(session_id, *, conv_id=None, run_id=None):
    """Record which Observatory conversation and run-queue item ran a session.

    Only the ids given (not None) are written; the other keeps its value. Both
    appear in the research document once set, so its mirror is re-exported.
    Raises ValueError when the session does not exist.
    """
    with _writing("research") as conn:
        if conn.execute("SELECT 1 FROM research_sessions WHERE id = ?", (session_id,)).fetchone() is None:
            raise ValueError(f"no session {session_id!r}")
        if conv_id is not None:
            conn.execute(
                "UPDATE research_sessions SET conv_id = ?,"
                " updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?",
                (conv_id, session_id))
        if run_id is not None:
            conn.execute(
                "UPDATE research_sessions SET run_id = ?,"
                " updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?",
                (run_id, session_id))
