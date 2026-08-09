"""To-dos as real rows — the fifth typed entity in exo.db.

**What this is.** `todos.json` is five buckets of loose dicts (now, up_next,
later, someday, done). It is the source of truth and **nothing here ever writes
to it** — `rebuild()` reads it and re-derives four tables (schema in
sqlstore.py, v7 rung), so `routes/todos.py`'s own read/write path is untouched
and this can be thrown away or rebuilt at any time. Same contract as
habitstore, expensestore, codestore, cardstore.

**Why it's worth a typed table.** The blob has drifted, and the drift is
measurable: of 178 finished to-dos only 50 carry a `fronts` tag and 96 carry a
`created` date, against 102-of-103 and near-all on the live ones. Completion
time is recorded three different ways. A route that wants "what got done in
July" therefore has to know all three field names and tolerate every gap —
which is exactly what routes/todos.py's day-marker branch does today. These
tables answer it once, in one shape.

Four modelling decisions, each of which changes what the data says:

  1. **One completion moment, and a column saying where it came from.** The
     blob carries `finished_on`(+`finished_time`) — her hand-assigned claim of
     when a thing *actually* happened — plus `done_at`, auto-stamped when she
     *marked* it, plus a legacy day-only `completed`. FINISHED_PRECEDENCE
     folds them in that order (matching what routes/todos.py already does when
     it picks a day), and `finished_source` records which field won. A caller
     that wants only her real claims can filter to 'claimed'; nothing here
     silently presents a marking stamp as a claim.
  2. **The bucket is an attribute, not the identity.** A to-do that moves from
     up_next to done is the same row — habitstore's identity lesson. `done` is
     kept as its own column beside it, because the two can legitimately
     disagree (an item marked done still sits in `now` until the next sweep).
  3. **Fronts are a join table, keyed the same way `card_tags` is.** So a
     cross-surface question — this domain, in the journal *and* the list —
     is one UNION away instead of impossible. **What that query does NOT do
     yet:** the two vocabularies barely meet. Card tags are thread names (89
     of them: `dshs-performance`, `housing-rent-and-the-move`, people) while
     fronts are 12 life-domains, and only `exocortex` and the retired `work`
     appear as both. The join is real; the shared words are not. Closing that
     needs a front->tags mapping, which is the owner's vocabulary call, not
     something this module should invent. Until it exists, a cross-surface
     query returns to-dos and almost no cards — say so rather than presenting
     a thin result as a whole answer.
  4. **Unregistered fronts are kept and flagged, not dropped.** Four old items
     still carry the retired junk-drawer tags ('life', 'admin', 'work') that
     routes/pending.py translates away at its gate. They get `registered = 0`
     rather than being discarded, so the drift is visible instead of quietly
     rewritten.

Touches: `sqlstore.py` (schema + connection), `store.py` (reads the `todos` and
`fronts` collections), `routes/sqlab.py` (the rebuild button + the table map),
`scripts/update_todos.py` (the cron wrapper), `tests/test_todostore.py`.

Prompt that produced this file: "i was thinking about doing more architecture
backend stuff for pre existing stuff that i use, like to-dos or my journal. i
want them to be sql backed to help with organization."
"""
import sqlstore
import store

TODOS_FILE = "todos.json"
FRONTS_FILE = "fronts.json"

# Which completion field wins, and what each one MEANS. Order is the precedence
# — first hit wins — and matches routes/todos.py, which already prefers
# finished_on over done_at when it decides what day a to-do belongs to.
#
#   claimed — `finished_on` (+ `finished_time`): she said when it actually
#             happened. The only one that is a claim about the world.
#   marked  — `done_at`: auto-stamped when she tapped the box. May carry a
#             minute ('YYYY-MM-DDTHH:MM') or be day-only, depending on vintage.
#   legacy  — `completed`: the original day-only field, no time, no minute.
FINISHED_PRECEDENCE = (
    ("claimed", "finished_on"),
    ("marked", "done_at"),
    ("legacy", "completed"),
)

# Plain text attributes copied straight across. Empty/missing -> NULL, so a
# query can use `IS NOT NULL` instead of also testing for ''.
_TEXT_FIELDS = ("created", "notes", "due_by", "due_time", "place_id",
                "after_date", "after_id", "status", "finished_note")


def _buckets(blob):
    """(name, items) per bucket, tolerating a malformed or half-written blob.

    Sorted by name so `position` and row order are stable across runs — dict
    order in the file is not something this module should depend on.
    """
    if not isinstance(blob, dict):
        return []
    out = []
    for name in sorted(blob):
        section = blob.get(name)
        if not isinstance(section, dict):
            continue
        items = section.get("items")
        if isinstance(items, list):
            out.append((name, [it for it in items if isinstance(it, dict)]))
    return out


def _text(item, field):
    """A blob field as a stripped string, or None when it's absent or blank."""
    val = item.get(field)
    if val is None:
        return None
    val = str(val).strip()
    return val or None


def finished(item):
    """(day, time, source) for a to-do, or (None, None, None) if unfinished.

    The fold described in decision 1. A `done_at` of 'YYYY-MM-DDTHH:MM' yields
    both parts; a day-only one yields no time rather than a guessed midnight —
    inventing a minute the data doesn't have would be exactly the kind of
    confident wrong answer these tables exist to stop producing.
    """
    for source, field in FINISHED_PRECEDENCE:
        raw = _text(item, field)
        if not raw:
            continue
        day = raw[:10]
        if source == "claimed":
            return day, _text(item, "finished_time"), source
        # 'YYYY-MM-DDTHH:MM' -> minute; anything shorter carries no time.
        time = raw[11:16].strip() if len(raw) > 10 else ""
        return day, (time or None), source
    return None, None, None


def _front_rows(blob, used):
    """Every front to insert: the registry first, then any id that only ever
    appears on a to-do (flagged unregistered — decision 4)."""
    rows = {}
    entries = blob.get("fronts") if isinstance(blob, dict) else None
    for entry in entries or []:
        if not isinstance(entry, dict):
            continue
        fid = (entry.get("id") or "").strip()
        if fid:
            rows[fid] = (fid, (entry.get("name") or fid).strip() or fid, 1,
                         entry.get("created"))
    for fid in sorted(used):
        if fid not in rows:
            # Name falls back to the id — there is nothing better to show, and
            # a blank name would render as an empty chip.
            rows[fid] = (fid, fid, 0, None)
    return [rows[k] for k in sorted(rows)]


def rebuild():
    """Re-derive all four tables from todos.json + fronts.json. Idempotent.

    Wholly derived: every table is cleared and rewritten, so nothing
    hand-inserted survives. Runs in one transaction — a half-written mirror is
    worse than a stale one, because it looks complete.
    """
    todos_blob = store.read(TODOS_FILE, {})
    fronts_blob = store.read(FRONTS_FILE, {})
    buckets = _buckets(todos_blob)

    used_fronts = {
        f for _, items in buckets for it in items
        for f in (it.get("fronts") or []) if isinstance(f, str) and f.strip()
    }

    conn = sqlstore.open_db()
    try:
        conn.execute("BEGIN IMMEDIATE")
        # Children first — the FKs point this way, and clearing a parent out
        # from under live rows is what ON DELETE CASCADE would otherwise
        # silently paper over.
        conn.execute("DELETE FROM todo_subtasks")
        conn.execute("DELETE FROM todo_fronts")
        conn.execute("DELETE FROM todos")
        conn.execute("DELETE FROM fronts")

        conn.executemany(
            "INSERT INTO fronts (id, name, registered, created)"
            " VALUES (?, ?, ?, ?)",
            _front_rows(fronts_blob, used_fronts),
        )

        seen, skipped, subtasks, links = set(), [], 0, 0
        for bucket, items in buckets:
            for position, item in enumerate(items):
                todo_id = (item.get("id") or "").strip()
                if not todo_id or todo_id in seen:
                    # No id means no identity — there is nothing to key a row
                    # on, and a generated one would differ every rebuild.
                    # Collecting these is more use than a failed transaction.
                    skipped.append(item)
                    continue
                seen.add(todo_id)
                day, time, source = finished(item)
                fields = {f: _text(item, f) for f in _TEXT_FIELDS}
                try:
                    duration = int(item.get("duration_min") or 0) or None
                except (TypeError, ValueError):
                    duration = None
                conn.execute(
                    "INSERT INTO todos (id, text, bucket, position, done,"
                    "  created, finished_on, finished_time, finished_source,"
                    "  finished_note, notes, due_by, due_time, duration_min,"
                    "  place_id, after_date, after_id, status)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        todo_id,
                        (item.get("text") or "").strip(),
                        bucket,
                        position,
                        1 if item.get("done") else 0,
                        fields["created"], day, time, source,
                        fields["finished_note"], fields["notes"],
                        fields["due_by"], fields["due_time"], duration,
                        fields["place_id"], fields["after_date"],
                        fields["after_id"], fields["status"],
                    ),
                )
                for front in dict.fromkeys(item.get("fronts") or []):
                    if isinstance(front, str) and front.strip():
                        conn.execute(
                            "INSERT INTO todo_fronts (todo_id, front)"
                            " VALUES (?, ?) ON CONFLICT DO NOTHING",
                            (todo_id, front.strip()),
                        )
                        links += 1
                for sub_pos, sub in enumerate(item.get("subtasks") or []):
                    if not isinstance(sub, dict):
                        continue
                    conn.execute(
                        "INSERT INTO todo_subtasks (todo_id, position,"
                        "  subtask_id, text, done) VALUES (?, ?, ?, ?, ?)",
                        (todo_id, sub_pos, _text(sub, "id"),
                         (sub.get("text") or "").strip(),
                         1 if sub.get("done") else 0),
                    )
                    subtasks += 1
        conn.execute("COMMIT")
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    finally:
        conn.close()
    return {"todos": len(seen), "fronts": len(_front_rows(fronts_blob, used_fronts)),
            "front_links": links, "subtasks": subtasks, "skipped": len(skipped)}


def _rows(sql, params=()):
    conn = sqlstore.open_db()
    try:
        return conn.execute(sql, params).fetchall()
    finally:
        conn.close()


def by_front():
    """Every front with what's filed under it, live and finished.

    LEFT JOIN from `fronts`, so a registered front nobody has tagged yet still
    shows up as a zero — the dropdown's source needs the empty ones too.
    """
    rows = _rows(
        "SELECT f.id, f.name, f.registered,"
        "       COUNT(t.id) AS total,"
        "       SUM(CASE WHEN t.done = 1 THEN 1 ELSE 0 END) AS finished"
        " FROM fronts f"
        " LEFT JOIN todo_fronts tf ON tf.front = f.id"
        " LEFT JOIN todos t ON t.id = tf.todo_id"
        " GROUP BY f.id ORDER BY total DESC, f.name"
    )
    return [{"id": r[0], "name": r[1], "registered": bool(r[2]),
             "total": r[3], "finished": r[4] or 0,
             "live": r[3] - (r[4] or 0)} for r in rows]


def finished_between(start, end, source=None):
    """What actually got finished in a window, newest first — the question the
    blob cannot answer without knowing all three completion field names.

    Dates are 'YYYY-MM-DD' and the range is inclusive both ends. Pass
    `source='claimed'` to count only the days she assigned by hand, rather than
    the day a box happened to get tapped.
    """
    sql = ("SELECT t.id, t.finished_on, t.finished_time, t.finished_source,"
           "       t.text, GROUP_CONCAT(tf.front)"
           " FROM todos t LEFT JOIN todo_fronts tf ON tf.todo_id = t.id"
           " WHERE t.finished_on BETWEEN ? AND ?")
    params = [start, end]
    if source:
        sql += " AND t.finished_source = ?"
        params.append(source)
    sql += (" GROUP BY t.id"
            " ORDER BY t.finished_on DESC, t.finished_time DESC")
    return [{"id": r[0], "finished_on": r[1], "finished_time": r[2],
             "source": r[3], "text": r[4],
             "fronts": r[5].split(",") if r[5] else []}
            for r in _rows(sql, params)]


def aging(bucket=None):
    """Unfinished to-dos by how long they have been sitting, oldest first.

    `age_days` is NULL for the ones with no `created` date (54% of the older
    items carry none) — reported as None rather than zero, because "arrived
    today" and "we don't know when this arrived" are different answers.
    """
    sql = ("SELECT id, bucket, position, text, created,"
           "       CAST(julianday('now') - julianday(created) AS INTEGER)"
           " FROM todos WHERE done = 0")
    params = []
    if bucket:
        sql += " AND bucket = ?"
        params.append(bucket)
    sql += " ORDER BY created IS NULL, created ASC"
    return [{"id": r[0], "bucket": r[1], "position": r[2], "text": r[3],
             "created": r[4], "age_days": r[5]} for r in _rows(sql, params)]
