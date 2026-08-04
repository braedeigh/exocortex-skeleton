"""Habits as real rows — the first typed-table entity in exo.db.

**The problem this solves.** Today a habit doesn't exist as data anywhere. It's a
line in `HABITS.md`, and `habits_log.json` refers to it by a string built from
that line (`data_helpers.habit_log_key` → `'morning|Kefir'`). That string is the
only identity a habit has. So when a habit's line leaves the markdown list — it
gets retired, or demoted into a prose block — every day it was ever checked
becomes unreachable: `data_helpers.load_habits_log()` can no longer resolve the
key to a section, leaves it bare, and calls it "dead history."

This module gives every habit a **row with a stable id**, and maps every log key
the app has ever written onto it:

  - `habits` — one row per habit, name and section are *attributes* of the row,
    not its identity. Includes retired ones (`active = 0`).
  - `habit_aliases` — every log key ever seen → the habit it belongs to. Both
    eras: the legacy bare text (`'Belly massage'`) and the current qualified
    form (`'evening / night|Floss'`).

So `history()` can hand back a habit's complete record across renames, section
moves, and retirement — including the days logged before the `section|text` key
format existed.

**This layer is additive and nothing reads it yet.** `rebuild()` only ever reads
`habits_log`; it never writes it. The app keeps using the blob exactly as before,
so this can be built, inspected, and rebuilt with no behavior change and no risk
to the log. Making habit *entries* typed rows is the next layer.

Touches: `sqlstore.py` (owns the schema + the connection factory),
`data_helpers.py` (`parse_md_sections`, `habit_log_key` — the key format is
defined there and mirrored here, never re-invented), `store.py` for the source
collections (`habits_log`, `habit_start_dates`, `habit_settings`), and
`CONTENT_DIR/HABITS.md` as the list of currently-active habits.

Prompt that produced this file: "Give habits a stable identity in SQL — a
`habits` table plus an alias table mapping every log key ever written (both the
legacy bare-text era and the current 'section|text' era) onto one row, so
history that was orphaned when a habit left the markdown list becomes reachable
again. Additive only: don't change what the app reads or writes."
"""
from collections import defaultdict

import data_helpers as dh
import sqlstore
import store

LOG_FILE = "habits_log.json"
START_DATES_FILE = "habit_start_dates.json"
SETTINGS_FILE = "habit_settings.json"

# A habit with no current section — retired, or logged under a text that no
# longer appears in HABITS.md. Stored as '' rather than NULL so the
# UNIQUE(section, name) index actually catches duplicates.
NO_SECTION = ""


# --- reading the sources ------------------------------------------------------

def _md_pairs():
    """Every (section, text) currently checkbox-listed in HABITS.md.

    Section is lowercased here to match habit_log_key, so a pair from the
    markdown and a pair parsed out of a log key are directly comparable.
    """
    path = store.CONTENT_DIR / "HABITS.md"
    if not path.exists():
        return []
    return [
        (sec["name"].strip().lower(), item["text"])
        for sec in dh.parse_md_sections(path)
        for item in sec["items"]
    ]


def _key_dates(log):
    """Every log key ever written → the dates it appears on.

    Reads the raw blob deliberately: load_habits_log() would rewrite bare keys
    in place and persist, and the whole point here is to record that mapping in
    the alias table instead of mutating the log.
    """
    out = defaultdict(set)
    for day, entries in log.items():
        if not isinstance(entries, dict):
            continue
        for key in entries:
            out[key].add(day)
    return out


def _split(key, text_to_section):
    """A log key → the (section, name) pair it belongs to.

    Qualified keys carry their own section. A bare key is resolved against the
    current markdown — the same rule load_habits_log uses — so a habit logged
    in both eras lands on ONE pair and the two eras join up. A bare key whose
    text is gone from the markdown is what orphaning looks like; it gets
    NO_SECTION and becomes a retired habit rather than vanishing.
    """
    if "|" in key:
        section, _, name = key.partition("|")
        return section.strip().lower(), name
    return text_to_section.get(key, NO_SECTION), key


# --- building -----------------------------------------------------------------

def rebuild():
    """(Re)derive habits + habit_aliases from the markdown, log, and settings.

    Idempotent, and id-stable: the UNIQUE(section, name) upsert means re-running
    updates rows in place rather than minting new ones, so ids already handed
    out stay valid. Safe to call whenever the sources change.

    Deliberately does NOT merge habits with different texts. `Neck rub` and
    `Neck-side rubbing` overlap in the log — they ran on the same days — so they
    were two list items, not one renamed one, and guessing wrong here would
    fuse two real habits forever. Same-text-different-era joins automatically;
    anything else is the owner's call via merge().
    """
    log = store.read(LOG_FILE, {})
    starts = store.read(START_DATES_FILE, {})
    hidden = set(store.read(SETTINGS_FILE, {}).get("hidden", []))

    md = _md_pairs()
    md_pairs = set(md)
    text_to_section = {}
    for section, text in md:
        text_to_section.setdefault(text, section)

    # (section, name) -> {aliases}, seeded with the current list so a habit
    # that's listed but never yet checked still gets a row.
    canon = {pair: set() for pair in md_pairs}
    dates = _key_dates(log)
    for key in dates:
        canon.setdefault(_split(key, text_to_section), set()).add(key)

    conn = sqlstore.open_db()
    try:
        conn.execute("BEGIN IMMEDIATE")
        for (section, name), aliases in sorted(canon.items()):
            # Active = on the current list and not hidden. Everything else is
            # history: still queryable, just not part of today's practice.
            active = 1 if (section, name) in md_pairs and name not in hidden else 0
            # habit_start_dates is keyed by bare name and drifts from the log's
            # text, so fall back to the earliest day actually logged.
            logged = {d for a in aliases for d in dates.get(a, ())}
            started = starts.get(name) or (min(logged) if logged else None)
            conn.execute(
                "INSERT INTO habits (name, section, active, started_on)"
                " VALUES (?, ?, ?, ?)"
                " ON CONFLICT (section, name) DO UPDATE SET"
                "   active = excluded.active,"
                "   started_on = COALESCE(habits.started_on, excluded.started_on)",
                (name, section, active, started),
            )
            habit_id = conn.execute(
                "SELECT id FROM habits WHERE section = ? AND name = ?", (section, name)
            ).fetchone()[0]
            for alias in sorted(aliases):
                conn.execute(
                    "INSERT INTO habit_aliases (alias, habit_id) VALUES (?, ?)"
                    " ON CONFLICT (alias) DO UPDATE SET habit_id = excluded.habit_id",
                    (alias, habit_id),
                )
        conn.execute("COMMIT")
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    finally:
        conn.close()
    return len(canon)


# --- reading ------------------------------------------------------------------

def _follow(conn, habit_id):
    """Walk merged_into to the surviving habit. Bounded so a bad merge that
    somehow formed a cycle returns an answer instead of hanging."""
    seen = set()
    while habit_id is not None and habit_id not in seen:
        seen.add(habit_id)
        row = conn.execute(
            "SELECT merged_into FROM habits WHERE id = ?", (habit_id,)
        ).fetchone()
        if row is None or row[0] is None:
            return habit_id
        habit_id = row[0]
    return habit_id


def resolve(log_key):
    """A log key → the id of the habit it belongs to (following merges), or None."""
    conn = sqlstore.open_db()
    try:
        row = conn.execute(
            "SELECT habit_id FROM habit_aliases WHERE alias = ?", (log_key,)
        ).fetchone()
        return None if row is None else _follow(conn, row[0])
    finally:
        conn.close()


def all_habits(include_merged=False):
    """Every habit, with its alias count — active first, then by name."""
    conn = sqlstore.open_db()
    try:
        where = "" if include_merged else " WHERE h.merged_into IS NULL"
        rows = conn.execute(
            "SELECT h.id, h.name, h.section, h.active, h.started_on, h.merged_into,"
            "       COUNT(a.alias) AS aliases"
            " FROM habits h LEFT JOIN habit_aliases a ON a.habit_id = h.id"
            + where +
            " GROUP BY h.id ORDER BY h.active DESC, h.name",
        ).fetchall()
        return [
            {"id": r[0], "name": r[1], "section": r[2], "active": bool(r[3]),
             "started_on": r[4], "merged_into": r[5], "aliases": r[6]}
            for r in rows
        ]
    finally:
        conn.close()


def aliases_of(habit_id):
    """Every log key that belongs to this habit, including any merged into it."""
    conn = sqlstore.open_db()
    try:
        target = _follow(conn, habit_id)
        rows = conn.execute(
            "SELECT a.alias FROM habit_aliases a JOIN habits h ON h.id = a.habit_id"
            " WHERE a.habit_id = ? OR h.merged_into = ?"
            " ORDER BY a.alias",
            (target, target),
        ).fetchall()
        return [r[0] for r in rows]
    finally:
        conn.close()


def history(habit_id, log=None):
    """Every date this habit was completed, across all its keys — sorted.

    This is the payoff: a habit logged under a bare text in March and a
    qualified key in June returns one continuous list, and a habit whose line
    left HABITS.md still returns everything instead of nothing.
    """
    keys = set(aliases_of(habit_id))
    if not keys:
        return []
    log = store.read(LOG_FILE, {}) if log is None else log
    return sorted(
        day for day, entries in log.items()
        if isinstance(entries, dict) and any(entries.get(k) for k in keys)
    )


# --- owner-driven corrections -------------------------------------------------

def merge(source_id, target_id):
    """Declare that `source_id` was always the same habit as `target_id`.

    Recorded as a pointer rather than by moving alias rows: rebuild() rewrites
    aliases from the sources every run and would undo a move, but it never
    touches merged_into, so this decision sticks.
    """
    if source_id == target_id:
        raise ValueError("cannot merge a habit into itself")
    conn = sqlstore.open_db()
    try:
        conn.execute("BEGIN IMMEDIATE")
        if _follow(conn, target_id) == source_id:
            raise ValueError("that merge would form a cycle")
        conn.execute("UPDATE habits SET merged_into = ? WHERE id = ?", (target_id, source_id))
        conn.execute("COMMIT")
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    finally:
        conn.close()


def unmerge(habit_id):
    """Undo a merge — the habit stands on its own again."""
    conn = sqlstore.open_db()
    try:
        conn.execute("UPDATE habits SET merged_into = NULL WHERE id = ?", (habit_id,))
    finally:
        conn.close()
