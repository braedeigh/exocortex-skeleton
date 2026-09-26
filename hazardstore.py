"""Research tables — what is in a food, number by number, and what to do about it.

**What this is.** The research pool holds claims as sentences ("92.7% of potato
samples had residues"). This module holds the numbers inside such sentences as
rows, so they can be laid out as a grid — foods down the side, hazards across
the top — and every cell can be traced back to the study it came from. Four
layers, kept deliberately apart:

  hazard map    — every hazard (lead, cadmium, chlorpropham, "pesticide") and
                  which kinds it is a kind of. A hazard may have several
                  parents: DDE is a pesticide residue AND a persistent
                  pollutant. The owner arranges this; nothing else depends on
                  its shape except how grids group their columns.
  measurements  — one number about one food and one hazard: a concentration
                  (ppb) or a detection rate (% of samples). Each one names its
                  source, the exact passage when there is one, what ground it
                  stands on, and — when the study tested a stand-in food
                  ("sirloin" for chuck roast) — what was really measured.
  judgments     — a verdict about one food through one lens (health,
                  sustainability): buy organic, organic helps some, conventional
                  is fine, or open question. Optionally about one hazard only.
                  Each names the measurements it rests on; if one of those is
                  disputed, the verdict shows as shaken.
  tables        — the grids the owner directs: which branch of the hazard map,
                  which kind of number, which foods.

**Review is the gate.** Agents write (author 'llm') and everything they write
arrives unreviewed; the owner marks each number and each verdict confirmed or
disputed. What she writes herself is born confirmed — writing it is the
review. A row's author is whoever wrote its current version. When an agent
changes anything, it goes back to unreviewed, and the old version (with its
author) is kept in `hazard_history`, so edits are never silent.

**Backup.** Everything here is her record, not a derivation, so it is exported
to `research_tables.json` after every write and read back from it if the
tables are ever found empty — the same arrangement as foodstore's catalog.

Touches: `sqlstore.py` (the tables, rung 25, and the hazard_findings /
food_verdicts views), `foodstore.py` (foods are the rows; its merge moves
these rows too), the research tables researchstore.py owns (sources, passages
and claims are read, never written, here), `routes/research_tables.py` (the
HTTP door), `scripts/research_tables.py` (the agents' door), and
`tests/test_hazardstore.py`.

Prompt that produced this file: "I want my research tool to be able to create
sql tables … a potential contaminant table … health risk type: contaminant and
then contaminant type: lead or pesticide … for every food I list in my
database … link to the studies and put values in the table too. Any research
topic should be able to have tables but I'll want to direct it. I want the
agents to fill the table but I want it to mark it as reviewed by me or not.
And a judgment table for buy organic or not based on health specifically.
Sustainability would be another one." Plus three amendments agreed before
building: a cell is keyed by measure as well as hazard, hazards may have
several parents, and a stand-in food is recorded rather than hidden.
"""
from collections import defaultdict
import json
import logging
import re
import sqlite3

import foodstore
import sqlstore
import store

log = logging.getLogger(__name__)

MIRROR_FILE = "research_tables.json"

# The kinds of number a measurement can be, each with the one unit it is
# stored in. A grid shows one kind at a time, so numbers in a column always
# compare.
MEASURES = {"concentration": "ppb", "detection_rate": "%"}

# The lenses a verdict can be made through. Add a word here to add a lens.
LENSES = ("health", "sustainability")

# The verdicts, in the order the page offers them, with the words it shows.
VERDICTS = {
    "organic": "buy organic",
    "some": "organic helps some",
    "conventional": "conventional is fine",
    "open": "open question",
}
REVIEWS = ("unreviewed", "confirmed", "disputed")
AUTHORS = ("llm", "owner")
TABLE_KINDS = ("measures", "judgments")
FOOD_SETS = ("all", "recipes", "rotation")

# Units a concentration may arrive in, and what to multiply by to get ppb
# (µg/kg). Litres are taken as kilograms — close enough for broth and milk,
# and the figure as printed is kept beside it.
_TO_PPB = {
    "ppb": 1, "µg/kg": 1, "ng/g": 1, "µg/l": 1,
    "ppm": 1000, "mg/kg": 1000, "µg/g": 1000, "mg/l": 1000,
    "ppt": 0.001, "ng/kg": 0.001, "ng/l": 0.001,
}

# The starter hazard map `seed_starter_map` plants on an empty install: each
# hazard with the names of its parents. General knowledge, nothing personal —
# a place to start rearranging from.
STARTER_MAP = (
    ("Contaminant", ()),
    ("Heavy metal", ("Contaminant",)),
    ("Lead", ("Heavy metal",)),
    ("Cadmium", ("Heavy metal",)),
    ("Arsenic", ("Heavy metal",)),
    ("Mercury", ("Heavy metal",)),
    ("Pesticide", ("Contaminant",)),
    ("Herbicide", ("Pesticide",)),
    ("Insecticide", ("Pesticide",)),
    ("Fungicide", ("Pesticide",)),
    ("Plant growth regulator", ("Pesticide",)),
    ("Persistent organic pollutant", ("Contaminant",)),
)
STARTER_ALIASES = {
    "Pesticide": ("pesticides", "pesticide residue"),
    "Arsenic": ("total arsenic",),
    "Persistent organic pollutant": ("pop", "pops"),
}

# Her record, parents before children — the order a restore must insert it.
_RECORD_TABLES = (
    ("hazards", ("id", "name", "note", "created_at")),
    ("hazard_names", ("name", "hazard_id")),
    ("hazard_parents", ("hazard_id", "parent_id")),
    ("hazard_measures", (
        "id", "food_id", "hazard_id", "measure", "amount", "unit", "as_reported",
        "sample_size", "basis", "year", "measured_on", "source_id", "annotation_id",
        "claim_id", "tier", "note", "author", "review", "reviewed_at", "created_at",
        "updated_at")),
    ("food_judgments", (
        "id", "food_id", "lens", "hazard_id", "verdict", "reasoning", "tier", "author",
        "review", "reviewed_at", "created_at", "updated_at")),
    ("judgment_grounds", ("judgment_id", "measure_id")),
    ("hazard_history", ("id", "kind", "row_id", "snapshot", "replaced_by", "replaced_at")),
    ("research_tables", (
        "id", "name", "kind", "topic_id", "hazard_id", "measure", "foods", "note",
        "position", "created_at")),
)

# The columns of a measurement or verdict that count as its CONTENT: changing
# any of them is an edit (history kept, review reset). Review columns are not.
_MEASURE_CONTENT = (
    "food_id", "hazard_id", "measure", "amount", "unit", "as_reported", "sample_size",
    "basis", "year", "measured_on", "source_id", "annotation_id", "claim_id", "tier", "note")
_JUDGMENT_CONTENT = ("verdict", "reasoning", "tier")

_NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')"


def _norm(name):
    """How a hazard name is matched: trimmed, lowercased, inner spaces collapsed."""
    return " ".join(str(name or "").split()).lower()


# --- backup: the mirror, and reading it back ---------------------------------

def _export_mirror(conn):
    """Write her record to research_tables.json — the backup, as plain rows.
    One-way: only _restore_if_empty ever reads it, and only on empty tables."""
    out = {}
    for table, columns in _RECORD_TABLES:
        rows = conn.execute(f"SELECT {', '.join(columns)} FROM {table} ORDER BY 1, 2").fetchall()
        out[table] = [dict(zip(columns, row)) for row in rows]
    store.write_file(MIRROR_FILE, out)


def refresh_mirror():
    """Re-export the backup after another module changed these rows
    (foodstore.merge moves measurements between foods). Goes through _Read,
    so an emptied database restores before it exports — an empty record is
    never written over a good backup."""
    with _Read() as conn:
        _export_mirror(conn)


def _restore_if_empty(conn):
    """Refill her record from the mirror when there is no hazard at all.

    The recovery path for a lost exo.db. Row by row, so one row pointing at a
    food or source that is not back yet is skipped (and counted in the log)
    rather than sinking the rest. Does nothing when a hazard exists, so it can
    never overwrite work.
    """
    if conn.execute("SELECT 1 FROM hazards LIMIT 1").fetchone():
        return False
    backup = store.read(MIRROR_FILE, {})
    if not isinstance(backup, dict) or not backup.get("hazards"):
        return False
    skipped = 0
    for table, columns in _RECORD_TABLES:
        for record in backup.get(table) or []:
            try:
                conn.execute(
                    f"INSERT OR IGNORE INTO {table} ({', '.join(columns)})"
                    f" VALUES ({', '.join('?' * len(columns))})",
                    tuple(record.get(column) for column in columns))
            except sqlite3.IntegrityError:
                skipped += 1
    if skipped:
        log.warning("research tables restore skipped %d rows whose references are missing", skipped)
    return True


# --- the two transactions every function below goes through ------------------

class _Write:
    """One write transaction on her record, followed by a fresh mirror.

    The restore check runs first, inside the lock, so a write to an emptied
    database lands on top of the restored record rather than instead of it.
    An exception inside rolls everything back and writes no mirror.
    """

    def __enter__(self):
        self.conn = sqlstore.open_db()
        try:
            sqlstore.begin_immediate(self.conn)
        except BaseException:
            self.conn.close()
            raise
        try:
            _restore_if_empty(self.conn)
        except BaseException:
            self.conn.execute("ROLLBACK")
            self.conn.close()
            raise
        return self.conn

    def __exit__(self, exc_type, exc, tb):
        try:
            if exc_type is None:
                self.conn.execute("COMMIT")
                _export_mirror(self.conn)
            else:
                self.conn.execute("ROLLBACK")
        finally:
            self.conn.close()
        return False


class _Read:
    """A connection for reading. If the record is empty but its backup is not,
    the restore happens first, under the write lock, so the first page load
    after a lost database already shows her tables."""

    def __enter__(self):
        self.conn = sqlstore.open_db()
        try:
            if not self.conn.execute("SELECT 1 FROM hazards LIMIT 1").fetchone():
                sqlstore.begin_immediate(self.conn)
                try:
                    restored = _restore_if_empty(self.conn)
                    self.conn.execute("COMMIT")
                except BaseException:
                    self.conn.execute("ROLLBACK")
                    raise
                if restored:
                    _export_mirror(self.conn)
        except BaseException:
            self.conn.close()
            raise
        return self.conn

    def __exit__(self, exc_type, exc, tb):
        self.conn.close()
        return False


# --- looking things up by name or id ------------------------------------------

def _hazard_id(conn, hazard):
    """A hazard given as an id or as any name it goes by → its id, or ValueError."""
    if isinstance(hazard, int) or (isinstance(hazard, str) and hazard.isdigit()):
        row = conn.execute("SELECT id FROM hazards WHERE id = ?", (int(hazard),)).fetchone()
    else:
        row = conn.execute("SELECT hazard_id FROM hazard_names WHERE name = ?",
                           (_norm(hazard),)).fetchone()
    if not row:
        raise ValueError(f"no such hazard: {hazard!r}")
    return row[0]


def _food_id(conn, food):
    """A food given as an id or as any name it goes by → its id, or ValueError.
    Digits in a string count as an id, since the agents' door passes text."""
    if isinstance(food, str) and food.isdigit():
        food = int(food)
    return foodstore._food_id(conn, food)


def _entry_kind(conn, entry_id):
    row = conn.execute("SELECT kind FROM research_entries WHERE id = ?", (entry_id,)).fetchone()
    return row[0] if row else None


def _check_references(conn, source_id, annotation_id, claim_id):
    """Refuse a source that is not a source, a claim that is not a claim, or a
    passage that does not exist — with a message the agent can act on."""
    if source_id is not None and _entry_kind(conn, source_id) != "source":
        raise ValueError(f"no source entry {source_id!r}")
    if claim_id is not None and _entry_kind(conn, claim_id) != "claim":
        raise ValueError(f"no claim entry {claim_id!r}")
    if annotation_id is not None and not conn.execute(
            "SELECT 1 FROM research_annotations WHERE id = ?", (annotation_id,)).fetchone():
        raise ValueError(f"no annotation {annotation_id!r}")


def _descendants(conn, hazard_id):
    """A hazard and everything that is a kind of it, however many steps down.
    A walk over hazard_parents; the `seen` set is what makes a diamond (two
    paths to one hazard) count once."""
    children = defaultdict(list)
    for child, parent in conn.execute("SELECT hazard_id, parent_id FROM hazard_parents"):
        children[parent].append(child)
    seen, stack = {hazard_id}, [hazard_id]
    while stack:
        for child in children[stack.pop()]:
            if child not in seen:
                seen.add(child)
                stack.append(child)
    return seen


# --- the hazard map ------------------------------------------------------------

def hazard_map():
    """Every hazard with its other names, its parents, and how many
    measurements sit on it directly — the whole map, for the page to draw."""
    with _Read() as conn:
        hazards = {
            row[0]: {"id": row[0], "name": row[1], "note": row[2], "names": [],
                     "parents": [], "measure_count": row[3]}
            for row in conn.execute(
                "SELECT h.id, h.name, h.note,"
                "  (SELECT COUNT(*) FROM hazard_measures m WHERE m.hazard_id = h.id)"
                " FROM hazards h ORDER BY h.name COLLATE NOCASE")
        }
        for name, hazard_id in conn.execute("SELECT name, hazard_id FROM hazard_names ORDER BY name"):
            if name != _norm(hazards[hazard_id]["name"]):
                hazards[hazard_id]["names"].append(name)
        for hazard_id, parent_id in conn.execute(
                "SELECT hazard_id, parent_id FROM hazard_parents ORDER BY parent_id"):
            hazards[hazard_id]["parents"].append(parent_id)
        return list(hazards.values())


def _file_name(conn, hazard_id, name):
    """File one more name for a hazard, refusing a name another hazard has."""
    key = _norm(name)
    if not key:
        raise ValueError("a hazard name can't be empty")
    taken = conn.execute("SELECT hazard_id FROM hazard_names WHERE name = ?", (key,)).fetchone()
    if taken and taken[0] != hazard_id:
        raise ValueError(f"the name {name!r} already belongs to hazard {taken[0]}")
    conn.execute("INSERT OR IGNORE INTO hazard_names (name, hazard_id) VALUES (?, ?)", (key, hazard_id))


def _set_parents(conn, hazard_id, parents):
    """Replace a hazard's parents, refusing any that would make a loop — a
    hazard can't be a kind of itself, however many steps round."""
    parent_ids = [_hazard_id(conn, parent) for parent in parents]
    below = _descendants(conn, hazard_id)
    for parent_id in parent_ids:
        if parent_id in below:
            raise ValueError("that parent is already a kind of this hazard; it would make a loop")
    conn.execute("DELETE FROM hazard_parents WHERE hazard_id = ?", (hazard_id,))
    conn.executemany("INSERT OR IGNORE INTO hazard_parents (hazard_id, parent_id) VALUES (?, ?)",
                     [(hazard_id, parent_id) for parent_id in parent_ids])


def add_hazard(name, parents=(), note=None, aliases=()):
    """Put a new hazard on the map under the given parents. Returns its id.
    A name (or other name) already on the map is refused, naming the hazard
    that has it, so a second 'Lead' can't appear beside the first."""
    name = " ".join(str(name or "").split())
    with _Write() as conn:
        existing = conn.execute("SELECT hazard_id FROM hazard_names WHERE name = ?",
                                (_norm(name),)).fetchone()
        if existing:
            raise ValueError(f"hazard {name!r} is already on the map (id {existing[0]})")
        cursor = conn.execute("INSERT INTO hazards (name, note) VALUES (?, ?)", (name, note or None))
        hazard_id = cursor.lastrowid
        for each in (name, *aliases):
            _file_name(conn, hazard_id, each)
        _set_parents(conn, hazard_id, parents)
    return hazard_id


def update_hazard(hazard, *, name=None, note=None, parents=None, aliases=None):
    """Rename a hazard, change its note, move it (new parents) or give it more
    names. Only what is passed changes. The old name keeps working."""
    with _Write() as conn:
        hazard_id = _hazard_id(conn, hazard)
        if name is not None:
            name = " ".join(str(name).split())
            _file_name(conn, hazard_id, name)
            conn.execute("UPDATE hazards SET name = ? WHERE id = ?", (name, hazard_id))
        if note is not None:
            conn.execute("UPDATE hazards SET note = ? WHERE id = ?", (note or None, hazard_id))
        if parents is not None:
            _set_parents(conn, hazard_id, parents)
        for alias in aliases or ():
            _file_name(conn, hazard_id, alias)
    return hazard_id


def delete_hazard(hazard):
    """Take a hazard off the map — only when no measurement or verdict uses it,
    since deleting it would take those with it. Its children lose one parent."""
    with _Write() as conn:
        hazard_id = _hazard_id(conn, hazard)
        used = conn.execute(
            "SELECT (SELECT COUNT(*) FROM hazard_measures WHERE hazard_id = ?)"
            " + (SELECT COUNT(*) FROM food_judgments WHERE hazard_id = ?)",
            (hazard_id, hazard_id)).fetchone()[0]
        if used:
            raise ValueError(f"{used} measurements or verdicts use this hazard; move them first")
        conn.execute("DELETE FROM hazards WHERE id = ?", (hazard_id,))


def seed_starter_map():
    """Plant STARTER_MAP on an empty map. Returns how many hazards it made;
    0, touching nothing, when the map already has any hazard."""
    with _Write() as conn:
        if conn.execute("SELECT 1 FROM hazards LIMIT 1").fetchone():
            return 0
        for name, parents in STARTER_MAP:
            hazard_id = conn.execute("INSERT INTO hazards (name) VALUES (?)", (name,)).lastrowid
            for each in (name, *STARTER_ALIASES.get(name, ())):
                _file_name(conn, hazard_id, each)
            _set_parents(conn, hazard_id, parents)
        return len(STARTER_MAP)


# --- measurements ----------------------------------------------------------------

def _unit_key(unit):
    """The leading unit in a unit string, spelled one way: '% of samples (PDP
    2021)' → '%', 'µg/kg (ppb)' → 'µg/kg', 'mcg/kg' → 'µg/kg'."""
    text = str(unit or "").strip().lower().replace("μ", "µ").replace("mcg", "µg").replace("ug/", "µg/")
    match = re.match(r"(%|[^\s(,]+)", text)
    return match.group(1) if match else ""


def normalize(measure, amount, unit):
    """A number in the unit its measure is stored in: (amount, unit,
    as_reported). as_reported is the figure as given, or None when nothing
    had to change. ValueError for a measure or unit that can't be placed."""
    if measure not in MEASURES:
        raise ValueError(f"bad measure {measure!r}; one of {', '.join(MEASURES)}")
    amount = float(amount)
    key = _unit_key(unit)
    if measure == "detection_rate":
        if key != "%":
            raise ValueError(f"a detection rate is a percent of samples, not {unit!r}")
        if not 0 <= amount <= 100:
            raise ValueError(f"a detection rate is between 0 and 100, not {amount}")
        return amount, "%", None
    if key not in _TO_PPB:
        raise ValueError(f"can't convert {unit!r} to ppb; give one of {', '.join(sorted(_TO_PPB))}")
    factor = _TO_PPB[key]
    as_reported = None if key == "ppb" else f"{amount:g} {str(unit).strip()}"
    return round(amount * factor, 6), "ppb", as_reported


def _measure_row(conn, measure_id):
    columns = ("id", "author", "review", "reviewed_at", "created_at", "updated_at") + _MEASURE_CONTENT
    row = conn.execute(f"SELECT {', '.join(columns)} FROM hazard_measures WHERE id = ?",
                       (measure_id,)).fetchone()
    return dict(zip(columns, row)) if row else None


def _keep_history(conn, kind, row, replaced_by):
    """Keep the version about to be replaced — the whole row, as JSON."""
    conn.execute("INSERT INTO hazard_history (kind, row_id, snapshot, replaced_by) VALUES (?,?,?,?)",
                 (kind, row["id"], json.dumps(row, ensure_ascii=False), replaced_by))


def _review_after(author):
    """The review a row gets when it is written: the owner writing it IS the
    review, so hers are confirmed; anything an agent writes waits for her."""
    if author == "owner":
        return f"review = 'confirmed', reviewed_at = {_NOW}"
    return "review = 'unreviewed', reviewed_at = NULL"


def _amend_measure(conn, before, fields, author):
    """Change a measurement's content. Unchanged fields are a no-op; a real
    change keeps the old version and sends the number back to unreviewed
    (or, when the owner made the change, marks it confirmed)."""
    changed = {key: value for key, value in fields.items()
               if key in _MEASURE_CONTENT and before.get(key) != value}
    if not changed:
        return False
    _keep_history(conn, "measure", before, author)
    assignments = ", ".join(f"{key} = ?" for key in changed)
    conn.execute(
        f"UPDATE hazard_measures SET {assignments}, author = ?, {_review_after(author)},"
        f" updated_at = {_NOW} WHERE id = ?", (*changed.values(), author, before["id"]))
    return True


def record_measure(food, hazard, measure, amount, unit, *, source_id=None, annotation_id=None,
                   claim_id=None, sample_size=None, basis=None, year=None, measured_on=None,
                   tier=None, note=None, author="llm"):
    """Record one number about one food and one hazard. Returns (id, what
    happened): 'created', 'amended' or 'unchanged'.

    An agent's number must name its source — a figure with no study behind it
    does not get into the table. The same food, hazard, measure, source, year
    and stand-in count as the same figure: recording it again amends it
    (history kept, review reset if anything changed) instead of doubling it.
    """
    if author not in AUTHORS:
        raise ValueError(f"bad author {author!r}")
    if author == "llm" and not source_id:
        raise ValueError("an agent's number needs --source: the study it came from")
    amount, unit, as_reported = normalize(measure, amount, unit)
    with _Write() as conn:
        _check_references(conn, source_id, annotation_id, claim_id)
        fields = {
            "food_id": _food_id(conn, food), "hazard_id": _hazard_id(conn, hazard),
            "measure": measure, "amount": amount, "unit": unit, "as_reported": as_reported,
            "sample_size": int(sample_size) if sample_size is not None else None,
            "basis": basis or None, "year": int(year) if year is not None else None,
            "measured_on": measured_on or None, "source_id": source_id or None,
            "annotation_id": annotation_id, "claim_id": claim_id,
            "tier": tier or None, "note": note or None,
        }
        # The same figure recorded again is found by what it is a figure OF.
        existing = None
        if fields["source_id"]:
            existing = conn.execute(
                "SELECT id FROM hazard_measures WHERE food_id = ? AND hazard_id = ? AND measure = ?"
                " AND source_id = ? AND year IS ? AND measured_on IS ?",
                (fields["food_id"], fields["hazard_id"], measure, fields["source_id"],
                 fields["year"], fields["measured_on"])).fetchone()
        if existing:
            before = _measure_row(conn, existing[0])
            # A second recording that omits the passage or claim keeps the ones it had.
            for key in ("annotation_id", "claim_id"):
                if fields[key] is None:
                    fields[key] = before[key]
            return existing[0], "amended" if _amend_measure(conn, before, fields, author) else "unchanged"
        columns = list(fields) + ["author"]
        cursor = conn.execute(
            f"INSERT INTO hazard_measures ({', '.join(columns)}) VALUES ({', '.join('?' * len(columns))})",
            (*fields.values(), author))
        conn.execute(f"UPDATE hazard_measures SET {_review_after(author)} WHERE id = ?",
                     (cursor.lastrowid,))
        return cursor.lastrowid, "created"


def amend_measure(measure_id, *, author="owner", **fields):
    """Change one measurement by id — the owner correcting a number, say.
    Amount and unit are normalized together, so pass both or neither."""
    with _Write() as conn:
        before = _measure_row(conn, measure_id)
        if before is None:
            raise ValueError(f"no measurement {measure_id}")
        if "food" in fields:
            fields["food_id"] = _food_id(conn, fields.pop("food"))
        if "hazard" in fields:
            fields["hazard_id"] = _hazard_id(conn, fields.pop("hazard"))
        if "amount" in fields or "unit" in fields:
            amount, unit, as_reported = normalize(
                fields.get("measure", before["measure"]),
                fields.pop("amount", before["amount"]), fields.pop("unit", before["unit"]))
            fields.update(amount=amount, unit=unit, as_reported=as_reported)
        _check_references(conn, fields.get("source_id"), fields.get("annotation_id"),
                          fields.get("claim_id"))
        return _amend_measure(conn, before, fields, author)


def delete_measure(measure_id):
    """Remove a measurement. Its last version stays in the history."""
    with _Write() as conn:
        before = _measure_row(conn, measure_id)
        if before is None:
            raise ValueError(f"no measurement {measure_id}")
        _keep_history(conn, "measure", before, "deleted")
        conn.execute("DELETE FROM hazard_measures WHERE id = ?", (measure_id,))


def _set_review(table, row_id, review):
    """Mark one row confirmed, disputed or unreviewed — the owner's call."""
    if review not in REVIEWS:
        raise ValueError(f"bad review {review!r}; one of {', '.join(REVIEWS)}")
    with _Write() as conn:
        cursor = conn.execute(
            f"UPDATE {table} SET review = ?,"
            f" reviewed_at = CASE WHEN ? = 'unreviewed' THEN NULL ELSE {_NOW} END WHERE id = ?",
            (review, review, row_id))
        if cursor.rowcount == 0:
            raise ValueError(f"no row {row_id} to review")


def review_measure(measure_id, review):
    _set_review("hazard_measures", measure_id, review)


def _history(conn, kind, row_id):
    return [
        {"snapshot": json.loads(snapshot), "replaced_by": replaced_by, "replaced_at": replaced_at}
        for snapshot, replaced_by, replaced_at in conn.execute(
            "SELECT snapshot, replaced_by, replaced_at FROM hazard_history"
            " WHERE kind = ? AND row_id = ? ORDER BY id DESC", (kind, row_id))
    ]


def _entry_brief(conn, entry_id):
    if entry_id is None:
        return None
    row = conn.execute("SELECT id, text, url FROM research_entries WHERE id = ?", (entry_id,)).fetchone()
    return dict(zip(("id", "text", "url"), row)) if row else None


def measure_detail(measure_id):
    """One measurement with everything hung off it: food and hazard names, the
    source, the passage, the claim it came from, the verdicts resting on it,
    and every earlier version. None for an unknown id."""
    with _Read() as conn:
        measure = _measure_row(conn, measure_id)
        if measure is None:
            return None
        measure["food"] = conn.execute("SELECT name FROM foods WHERE id = ?",
                                       (measure["food_id"],)).fetchone()[0]
        measure["hazard"] = conn.execute("SELECT name FROM hazards WHERE id = ?",
                                         (measure["hazard_id"],)).fetchone()[0]
        measure["source"] = _entry_brief(conn, measure["source_id"])
        measure["claim"] = _entry_brief(conn, measure["claim_id"])
        passage = None
        if measure["annotation_id"]:
            row = conn.execute("SELECT id, doc, char_start, char_end, exact, note"
                               " FROM research_annotations WHERE id = ?",
                               (measure["annotation_id"],)).fetchone()
            if row:
                passage = dict(zip(("id", "doc", "char_start", "char_end", "exact", "note"), row))
        measure["passage"] = passage
        measure["judgments"] = [
            {"id": row[0], "lens": row[1], "verdict": row[2], "review": row[3]}
            for row in conn.execute(
                "SELECT j.id, j.lens, j.verdict, j.review FROM judgment_grounds g"
                " JOIN food_judgments j ON j.id = g.judgment_id WHERE g.measure_id = ?",
                (measure_id,))
        ]
        measure["history"] = _history(conn, "measure", measure_id)
        return measure


# --- judgments -------------------------------------------------------------------

_JUDGMENT_COLUMNS = ("id", "food_id", "lens", "hazard_id", "verdict", "reasoning", "tier",
                     "author", "review", "reviewed_at", "created_at", "updated_at")


def _judgment_row(conn, judgment_id):
    row = conn.execute(f"SELECT {', '.join(_JUDGMENT_COLUMNS)} FROM food_judgments WHERE id = ?",
                       (judgment_id,)).fetchone()
    return dict(zip(_JUDGMENT_COLUMNS, row)) if row else None


def judge(food, lens, verdict, *, hazard=None, reasoning=None, tier=None, grounds=None,
          author="llm"):
    """Set the verdict on one food through one lens (and, optionally, about
    one hazard only). Returns (id, 'created' | 'amended' | 'unchanged').

    An agent's verdict must say why, and — unless it is 'open' — name at least
    one measurement it rests on: a verdict with no numbers under it is exactly
    the fake certainty this table exists to avoid. Judging the same food, lens
    and hazard again amends the one verdict (history kept, review reset).
    `grounds`, when given, replaces the list of measurements it rests on.
    """
    if lens not in LENSES:
        raise ValueError(f"bad lens {lens!r}; one of {', '.join(LENSES)}")
    if verdict not in VERDICTS:
        raise ValueError(f"bad verdict {verdict!r}; one of {', '.join(VERDICTS)}")
    if author not in AUTHORS:
        raise ValueError(f"bad author {author!r}")
    grounds = None if grounds is None else [int(measure_id) for measure_id in grounds]
    if author == "llm":
        if not (reasoning or "").strip():
            raise ValueError("an agent's verdict needs --reasoning")
        if verdict != "open" and not grounds:
            raise ValueError("an agent's verdict needs at least one --ground measurement "
                             "(or the verdict 'open')")
    with _Write() as conn:
        food_id = _food_id(conn, food)
        hazard_id = _hazard_id(conn, hazard) if hazard is not None else None
        for measure_id in grounds or ():
            row = conn.execute("SELECT food_id FROM hazard_measures WHERE id = ?", (measure_id,)).fetchone()
            if row is None:
                raise ValueError(f"no measurement {measure_id} to rest on")
            if row[0] != food_id:
                raise ValueError(f"measurement {measure_id} is about a different food")
        existing = conn.execute(
            "SELECT id FROM food_judgments WHERE food_id = ? AND lens = ? AND hazard_id IS ?",
            (food_id, lens, hazard_id)).fetchone()
        content = {"verdict": verdict, "reasoning": reasoning or None, "tier": tier or None}
        if existing:
            judgment_id = existing[0]
            before = _judgment_row(conn, judgment_id)
            before["grounds"] = sorted(r[0] for r in conn.execute(
                "SELECT measure_id FROM judgment_grounds WHERE judgment_id = ?", (judgment_id,)))
            changed = {k: v for k, v in content.items() if before[k] != v}
            grounds_changed = grounds is not None and sorted(grounds) != before["grounds"]
            if not changed and not grounds_changed:
                return judgment_id, "unchanged"
            _keep_history(conn, "judgment", before, author)
            assignments = "".join(f"{key} = ?, " for key in changed)
            conn.execute(
                f"UPDATE food_judgments SET {assignments}author = ?, {_review_after(author)},"
                f" updated_at = {_NOW} WHERE id = ?", (*changed.values(), author, judgment_id))
            outcome = "amended"
        else:
            judgment_id = conn.execute(
                "INSERT INTO food_judgments (food_id, lens, hazard_id, verdict, reasoning, tier, author)"
                " VALUES (?,?,?,?,?,?,?)",
                (food_id, lens, hazard_id, verdict, content["reasoning"], content["tier"], author),
            ).lastrowid
            conn.execute(f"UPDATE food_judgments SET {_review_after(author)} WHERE id = ?",
                         (judgment_id,))
            outcome = "created"
        if grounds is not None:
            conn.execute("DELETE FROM judgment_grounds WHERE judgment_id = ?", (judgment_id,))
            conn.executemany("INSERT OR IGNORE INTO judgment_grounds (judgment_id, measure_id) VALUES (?,?)",
                             [(judgment_id, measure_id) for measure_id in grounds])
        return judgment_id, outcome


def review_judgment(judgment_id, review):
    _set_review("food_judgments", judgment_id, review)


def delete_judgment(judgment_id):
    """Remove a verdict. Its last version stays in the history."""
    with _Write() as conn:
        before = _judgment_row(conn, judgment_id)
        if before is None:
            raise ValueError(f"no verdict {judgment_id}")
        _keep_history(conn, "judgment", before, "deleted")
        conn.execute("DELETE FROM food_judgments WHERE id = ?", (judgment_id,))


def _measure_summary(row):
    """The part of a measurement a grid cell shows."""
    keys = ("id", "hazard_id", "hazard", "measure", "amount", "unit", "year", "measured_on",
            "review", "author", "source_id")
    summary = dict(zip(keys, row))
    summary["sourced"] = summary.pop("source_id") is not None
    return summary


_SUMMARY_SQL = (
    "SELECT m.id, m.hazard_id, h.name, m.measure, m.amount, m.unit, m.year, m.measured_on,"
    " m.review, m.author, m.source_id, m.food_id"
    " FROM hazard_measures m JOIN hazards h ON h.id = m.hazard_id")


def judgment_detail(judgment_id):
    """One verdict with its food and hazard names, the measurements it rests
    on, whether any of them is disputed ('shaken'), and earlier versions."""
    with _Read() as conn:
        judgment = _judgment_row(conn, judgment_id)
        if judgment is None:
            return None
        judgment["food"] = conn.execute("SELECT name FROM foods WHERE id = ?",
                                        (judgment["food_id"],)).fetchone()[0]
        judgment["hazard"] = None
        if judgment["hazard_id"] is not None:
            judgment["hazard"] = conn.execute("SELECT name FROM hazards WHERE id = ?",
                                              (judgment["hazard_id"],)).fetchone()[0]
        judgment["grounds"] = [
            _measure_summary(row[:-1]) for row in conn.execute(
                _SUMMARY_SQL + " JOIN judgment_grounds g ON g.measure_id = m.id"
                " WHERE g.judgment_id = ? ORDER BY h.name", (judgment_id,))
        ]
        judgment["shaken"] = any(g["review"] == "disputed" for g in judgment["grounds"])
        judgment["history"] = _history(conn, "judgment", judgment_id)
        return judgment


# --- the tables she directs ------------------------------------------------------

_TABLE_COLUMNS = ("id", "name", "kind", "topic_id", "hazard_id", "measure", "foods", "note",
                  "position", "created_at")


def _check_table_fields(conn, kind, hazard, measure, foods):
    """The hazard id a table's fields resolve to, refusing a combination the
    grid can't draw."""
    if kind not in TABLE_KINDS:
        raise ValueError(f"bad table kind {kind!r}; one of {', '.join(TABLE_KINDS)}")
    if foods not in FOOD_SETS:
        raise ValueError(f"bad food set {foods!r}; one of {', '.join(FOOD_SETS)}")
    if measure is not None and measure not in MEASURES:
        raise ValueError(f"bad measure {measure!r}; one of {', '.join(MEASURES)}")
    return _hazard_id(conn, hazard) if hazard is not None else None


def list_tables(topic_id=None):
    """Every table, in her order, optionally only one research topic's."""
    with _Read() as conn:
        sql = f"SELECT {', '.join(_TABLE_COLUMNS)} FROM research_tables"
        params = ()
        if topic_id is not None:
            sql += " WHERE topic_id = ?"
            params = (topic_id,)
        return [dict(zip(_TABLE_COLUMNS, row))
                for row in conn.execute(sql + " ORDER BY position, id", params)]


def add_table(name, kind, *, topic_id=None, hazard=None, measure=None, foods="all", note=None):
    """Make a new table. A measures table with no measure shows every kind of
    number; with no hazard, its columns are the map's top-level hazards."""
    name = " ".join(str(name or "").split())
    if not name:
        raise ValueError("a table needs a name")
    with _Write() as conn:
        hazard_id = _check_table_fields(conn, kind, hazard, measure, foods)
        if conn.execute("SELECT 1 FROM research_tables WHERE name = ?", (name,)).fetchone():
            raise ValueError(f"there is already a table called {name!r}")
        position = conn.execute("SELECT COALESCE(MAX(position), -1) + 1 FROM research_tables").fetchone()[0]
        return conn.execute(
            "INSERT INTO research_tables (name, kind, topic_id, hazard_id, measure, foods, note, position)"
            " VALUES (?,?,?,?,?,?,?,?)",
            (name, kind, topic_id or None, hazard_id, measure, foods, note or None, position),
        ).lastrowid


def update_table(table_id, **fields):
    """Change a table's name, topic, branch, measure, food set or note. Only
    what is passed changes; passing hazard or measure as None clears it."""
    with _Write() as conn:
        row = conn.execute(f"SELECT {', '.join(_TABLE_COLUMNS)} FROM research_tables WHERE id = ?",
                           (table_id,)).fetchone()
        if row is None:
            raise ValueError(f"no table {table_id}")
        table = dict(zip(_TABLE_COLUMNS, row))
        hazard = fields["hazard"] if "hazard" in fields else table["hazard_id"]
        merged = {
            "name": " ".join(str(fields.get("name", table["name"])).split()),
            "topic_id": fields.get("topic_id", table["topic_id"]) or None,
            "measure": fields["measure"] if "measure" in fields else table["measure"],
            "foods": fields.get("foods", table["foods"]),
            "note": fields.get("note", table["note"]) or None,
        }
        if not merged["name"]:
            raise ValueError("a table needs a name")
        merged["hazard_id"] = _check_table_fields(conn, table["kind"], hazard, merged["measure"],
                                                  merged["foods"])
        conn.execute(
            "UPDATE research_tables SET name = ?, topic_id = ?, measure = ?, foods = ?, note = ?,"
            " hazard_id = ? WHERE id = ?", (*merged.values(), table_id))


def delete_table(table_id):
    """Remove a table. Only the view goes; its measurements and verdicts stay."""
    with _Write() as conn:
        if conn.execute("DELETE FROM research_tables WHERE id = ?", (table_id,)).rowcount == 0:
            raise ValueError(f"no table {table_id}")


def _food_rows(conn, food_set):
    """The foods a table runs down the side, as (id, name), by name. Only
    things eaten (kind 'food'); 'recipes' and 'rotation' narrow it to foods a
    recipe uses, or a recipe on the meal rotation uses."""
    sql = "SELECT f.id, f.name FROM foods f WHERE f.kind = 'food'"
    if food_set == "recipes":
        sql += " AND EXISTS (SELECT 1 FROM recipe_lines l WHERE l.food_id = f.id)"
    elif food_set == "rotation":
        sql += (" AND EXISTS (SELECT 1 FROM recipe_lines l JOIN meal_rotation r"
                " ON r.recipe_id = l.recipe_id WHERE l.food_id = f.id)")
    return conn.execute(sql + " ORDER BY f.name COLLATE NOCASE").fetchall()


def table_view(table_id, all_foods=False):
    """One table, filled in: its columns and one row per food with each cell's
    measurements (or verdicts). None for an unknown table.

    Measures tables: the columns are the chosen hazard's direct children — or
    the map's top-level hazards when none is chosen — and a cell holds every
    measurement on that column's hazard or anything below it, so a column can
    stand for a whole family ('Pesticide') and roll its members up. Numbers
    sitting on the chosen hazard itself get a first column of their own,
    'any <hazard>'. A hazard with two parents appears under both.

    Judgments tables: the columns are the lenses; a cell holds the verdict on
    the whole food first, then any about one hazard.

    Without all_foods, a food with no cell at all is left out, and its count
    comes back as `empty_foods` so the page can say how many gaps are hidden.
    """
    with _Read() as conn:
        row = conn.execute(f"SELECT {', '.join(_TABLE_COLUMNS)} FROM research_tables WHERE id = ?",
                           (table_id,)).fetchone()
        if row is None:
            return None
        table = dict(zip(_TABLE_COLUMNS, row))
        foods = _food_rows(conn, table["foods"])
        cells = defaultdict(lambda: defaultdict(list))

        if table["kind"] == "measures":
            # Which column each hazard falls in: a walk down from every column.
            root = table["hazard_id"]
            if root is None:
                heads = conn.execute(
                    "SELECT id, name FROM hazards h WHERE NOT EXISTS"
                    " (SELECT 1 FROM hazard_parents p WHERE p.hazard_id = h.id)"
                    " ORDER BY name COLLATE NOCASE").fetchall()
            else:
                heads = conn.execute(
                    "SELECT h.id, h.name FROM hazard_parents p JOIN hazards h ON h.id = p.hazard_id"
                    " WHERE p.parent_id = ? ORDER BY h.name COLLATE NOCASE", (root,)).fetchall()
            columns = [{"id": str(head_id), "name": name, "hazard_id": head_id} for head_id, name in heads]
            column_of = defaultdict(list)
            for column in columns:
                for hazard_id in _descendants(conn, column["hazard_id"]):
                    column_of[hazard_id].append(column["id"])
            if root is not None:
                column_of[root].append("any")
            sql, params = _SUMMARY_SQL, []
            if table["measure"]:
                sql += " WHERE m.measure = ?"
                params.append(table["measure"])
            for measure_row in conn.execute(sql + " ORDER BY m.amount DESC", params):
                summary = _measure_summary(measure_row[:-1])
                for column_id in column_of.get(summary["hazard_id"], ()):
                    cells[measure_row[-1]][column_id].append(summary)
            if root is not None and any("any" in by_column for by_column in cells.values()):
                root_name = conn.execute("SELECT name FROM hazards WHERE id = ?", (root,)).fetchone()[0]
                columns.insert(0, {"id": "any", "name": f"any {root_name.lower()}", "hazard_id": root})
        else:
            columns = [{"id": lens, "name": lens, "hazard_id": None} for lens in LENSES]
            shaken = {judgment_id for (judgment_id,) in conn.execute(
                "SELECT DISTINCT g.judgment_id FROM judgment_grounds g"
                " JOIN hazard_measures m ON m.id = g.measure_id WHERE m.review = 'disputed'")}
            for judgment_id, food_id, lens, hazard_name, verdict, review, author in conn.execute(
                    "SELECT j.id, j.food_id, j.lens, h.name, j.verdict, j.review, j.author"
                    " FROM food_judgments j LEFT JOIN hazards h ON h.id = j.hazard_id"
                    " ORDER BY j.hazard_id IS NOT NULL, h.name"):
                cells[food_id][lens].append({
                    "id": judgment_id, "hazard": hazard_name, "verdict": verdict,
                    "review": review, "author": author, "shaken": judgment_id in shaken,
                })

        rows = [{"food_id": food_id, "food": name, "cells": dict(cells.get(food_id, {}))}
                for food_id, name in foods]
        filled = [row for row in rows if row["cells"]]
        return {
            "table": table,
            "columns": columns,
            "rows": rows if all_foods else filled,
            "empty_foods": len(rows) - len(filled),
            "counts": _review_counts(filled),
        }


def _review_counts(rows):
    """How many cells' entries are unreviewed, confirmed and disputed — each
    measurement or verdict counted once even when it sits in two columns."""
    seen = {}
    for row in rows:
        for entries in row["cells"].values():
            for entry in entries:
                seen[entry["id"]] = entry["review"]
    counts = {review: 0 for review in REVIEWS}
    for review in seen.values():
        counts[review] += 1
    return counts


# --- bringing in the numbers claims already carry --------------------------------

def _hazard_in(conn, text):
    """The hazard a claim's measure text is about: the name on the map that
    appears earliest in it as whole words, the longest winning a tie. None
    when no name on the map appears at all."""
    text = _norm(text)
    best = None
    for name, hazard_id in conn.execute("SELECT name, hazard_id FROM hazard_names"):
        match = re.search(r"(?<![\w])" + re.escape(name) + r"(?![\w])", text)
        if match and (best is None or (match.start(), -len(name)) < best[0]):
            best = ((match.start(), -len(name)), hazard_id)
    return best[1] if best else None


def _measure_kind(measure_text, unit):
    """Which kind of number a claim's value is: a percent that is about
    something being detected is a detection rate; a mass-per-mass unit is a
    concentration. None for anything else (ratios, differences)."""
    key = _unit_key(unit)
    if key == "%":
        return "detection_rate" if "detect" in _norm(measure_text) else None
    return "concentration" if key in _TO_PPB else None


def import_claim_values(topic_id=None):
    """Turn the numbers claims already carry (claim_values) into measurements.

    For each claim with a value: the subject must be a name of a food, the
    measure text must name a hazard on the map, and the unit must be a
    percent-detected or a concentration. What fits is recorded, tied to the
    claim, its first supporting source and that link's passage, as the claim's
    author wrote it and unreviewed. What doesn't is skipped with the reason —
    nothing is guessed. A claim already imported is left alone, so running this
    twice does nothing the second time. Returns {"imported": [...], "skipped": [...]}.
    """
    with _Read() as conn:
        sql = ("SELECT v.claim_id, v.subject, v.measure, v.amount, v.unit, v.basis, v.year, v.tier,"
               " e.author FROM claim_values v JOIN research_entries e ON e.id = v.claim_id")
        params = ()
        if topic_id is not None:
            sql += (" WHERE EXISTS (SELECT 1 FROM research_entry_topics t"
                    " WHERE t.entry_id = v.claim_id AND t.topic_id = ?)")
            params = (topic_id,)
        values = conn.execute(sql + " ORDER BY v.claim_id", params).fetchall()
        done = {row[0] for row in conn.execute(
            "SELECT claim_id FROM hazard_measures WHERE claim_id IS NOT NULL")}
        plans, skipped = [], []
        for claim_id, subject, measure_text, amount, unit, basis, year, tier, author in values:
            if claim_id in done:
                continue
            food = conn.execute("SELECT food_id FROM food_names WHERE name = ?",
                                (foodstore._norm(subject),)).fetchone()
            hazard_id = _hazard_in(conn, measure_text)
            kind = _measure_kind(measure_text, unit)
            reason = (None if food else f"no food named {subject!r}") \
                or (None if hazard_id else f"no hazard on the map in {measure_text!r}") \
                or (None if kind else f"unit {unit!r} is not a detection rate or a concentration") \
                or (None if amount is not None else "no amount")
            if reason:
                skipped.append({"claim_id": claim_id, "reason": reason})
                continue
            link = conn.execute(
                "SELECT source_id, annotation_id FROM claim_sources WHERE claim_id = ?"
                " ORDER BY stance != 'supports', created LIMIT 1", (claim_id,)).fetchone()
            # Whatever the unit string said beyond the unit itself ('mean (TDS
            # FY2018-20)') is kept as the basis, beside the value's own.
            unit_rest = re.sub(r"^\s*(%|[^\s(,]+)\s*", "", str(unit or "")).strip()
            # A stand-in food, when the unit string names one ('(TDS beef
            # steak proxy)'), becomes measured_on rather than staying hidden.
            proxy = re.search(r"\(([^()]*proxy[^()]*)\)", str(unit or ""), re.IGNORECASE)
            plans.append(dict(
                food=food[0], hazard=hazard_id, measure=kind, amount=amount, unit=unit,
                source_id=link[0] if link else None, annotation_id=link[1] if link else None,
                claim_id=claim_id, year=year, tier=tier,
                basis="; ".join(part for part in (basis, unit_rest) if part) or None,
                measured_on=proxy.group(1).strip() if proxy else None,
                author="llm" if author == "llm" else "owner"))
    imported = []
    for plan in plans:
        # An agent's claim with no source linked can't become an agent's
        # number (record_measure refuses it); say so rather than relabel it.
        if plan["author"] == "llm" and not plan["source_id"]:
            skipped.append({"claim_id": plan["claim_id"], "reason": "the claim has no source linked"})
            continue
        try:
            measure_id, _ = record_measure(
                plan.pop("food"), plan.pop("hazard"), plan.pop("measure"),
                plan.pop("amount"), plan.pop("unit"), **plan)
        except ValueError as exc:
            skipped.append({"claim_id": plan["claim_id"], "reason": str(exc)})
            continue
        imported.append({"claim_id": plan["claim_id"], "measure_id": measure_id})
    return {"imported": imported, "skipped": skipped}
