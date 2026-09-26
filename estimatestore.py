"""Claude's estimates — buy organic or not, for foods nobody has researched yet.

**What this is.** The research tables (hazardstore.py) hold verdicts that rest
on measured numbers, and refuse an agent's verdict that doesn't. That is the
right rule for research, and it leaves most of the grocery list blank. This
module holds the other thing: what a model can say about a food from general
knowledge, labelled as exactly that. Each estimate carries

  verdict       — the same four words as a research verdict (buy organic,
                  organic helps some, conventional is fine, open question)
  confidence    — high / medium / low, the model's own, which is rough
  summary       — why, in two to four plain sentences
  qualifiers    — short fixed words that shade it ("organic doesn't touch the
                  main risk", "where it's from matters more"); see QUALIFIERS
  contaminants  — what else is known to get into this food besides pesticide
                  residue (PFAS, heavy metals, mycotoxins…), each with whether
                  organic helps and how solid the evidence is

A research verdict, where one exists, always outranks an estimate. The owner
can confirm or dispute an estimate; a disputed one stays visible as disputed.

**Where the list comes from.** `list_view()` reads the grocery list straight
from kitchen.json on every call and resolves each name through the food
catalog's names — not from the grocery_list table, which is only refreshed by
foodstore.rebuild() and so lags behind what she just added.

**Backup.** Estimates cost a model run each, so they are exported to
`food_estimates.json` after every write and read back from it if the table is
ever found empty — the same arrangement as foodstore's catalog.

Touches: `sqlstore.py` (the food_estimates table, rung 26), `foodstore.py`
(food names, and creating a food for a list item that has none),
`hazardstore.py` (the verdict words, and research verdicts to show first),
`routes/food.py` (the HTTP door), `scripts/estimate_organic.py` (asks the
model and writes here), `tests/test_estimatestore.py`.

Prompt that produced this file: "Every item's organic or not should have a
popup if you click it with a summary of why. And then you can click from there
into the research … get an approximate based off of Claude's confidence …
figure out some qualifiers, and provide what is genuinely known in terms of
contaminants that actually affect that item like PFAS or whatever else, maybe
not pesticides."
"""
import fcntl
import json
import sqlite3

import foodstore
import hazardstore
import sqlstore
import store

MIRROR_FILE = "food_estimates.json"
# How the last estimate run went (scripts/estimate_organic.py writes it).
RUN_FILE = "estimate_run.json"

CONFIDENCES = ("high", "medium", "low")

# The qualifiers an estimate may carry, with the words the popup shows. Fixed
# so the list can render them as chips and a later pass can count them; add a
# word here to add a qualifier.
QUALIFIERS = {
    "well_tested": "well tested",
    "thin_evidence": "thin evidence",
    "organic_misses_main_risk": "organic doesn't touch the main risk",
    "source_matters": "where it's from matters more",
    "raising_matters": "how the animal was raised matters",
    "peel_or_wash_helps": "peeling or washing helps",
    "processing_matters": "packaging or processing matters",
}

# For each contaminant: does buying organic lower it, and how solid is what's
# known about it in this food.
ORGANIC_HELPS = ("yes", "partly", "no", "unknown")
EVIDENCE = ("established", "suggestive", "speculative")

_COLUMNS = ("id", "food_id", "lens", "verdict", "confidence", "summary", "qualifiers",
            "contaminants", "model", "review", "reviewed_at", "created_at")
_JSON_COLUMNS = ("qualifiers", "contaminants")


# --- backup: the mirror, and reading it back ---------------------------------

def _export_mirror(conn):
    """Write every estimate to food_estimates.json, as plain rows."""
    rows = conn.execute(f"SELECT {', '.join(_COLUMNS)} FROM food_estimates ORDER BY id").fetchall()
    store.write_file(MIRROR_FILE, {"food_estimates": [dict(zip(_COLUMNS, row)) for row in rows]})


def refresh_mirror():
    """Re-export the backup after another module changed these rows
    (foodstore.merge moves estimates between foods)."""
    conn = _read_conn()
    try:
        _export_mirror(conn)
    finally:
        conn.close()


def _restore_if_empty(conn):
    """Refill the table from the mirror when it has no rows at all. A row
    whose food is gone is skipped rather than sinking the rest."""
    if conn.execute("SELECT 1 FROM food_estimates LIMIT 1").fetchone():
        return False
    backup = store.read(MIRROR_FILE, {})
    records = backup.get("food_estimates") if isinstance(backup, dict) else None
    if not records:
        return False
    for record in records:
        try:
            conn.execute(
                f"INSERT OR IGNORE INTO food_estimates ({', '.join(_COLUMNS)})"
                f" VALUES ({', '.join('?' * len(_COLUMNS))})",
                tuple(record.get(column) for column in _COLUMNS))
        except sqlite3.IntegrityError:
            continue
    return True


class _Write:
    """One write transaction, followed by a fresh mirror. The restore check
    runs first, so a write to an emptied table lands on top of the backup."""

    def __enter__(self):
        self.conn = sqlstore.open_db()
        try:
            sqlstore.begin_immediate(self.conn)
            _restore_if_empty(self.conn)
        except BaseException:
            if self.conn.in_transaction:
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


def _read_conn():
    """A connection for reading, restoring from the backup first when the
    table is empty and the backup is not."""
    conn = sqlstore.open_db()
    if not conn.execute("SELECT 1 FROM food_estimates LIMIT 1").fetchone() \
            and store.read(MIRROR_FILE, {}).get("food_estimates"):
        conn.close()
        with _Write():
            pass
        conn = sqlstore.open_db()
    return conn


# --- checking what the model sent -------------------------------------------

def clean(fields):
    """Check an estimate's fields and return them tidied, or raise ValueError
    naming what is wrong. Unknown qualifiers are dropped rather than refused —
    a model inventing a word shouldn't lose the whole estimate — but a bad
    verdict, confidence, or contaminant field is refused."""
    verdict = fields.get("verdict")
    if verdict not in hazardstore.VERDICTS:
        raise ValueError(f"bad verdict {verdict!r}; one of {', '.join(hazardstore.VERDICTS)}")
    confidence = fields.get("confidence")
    if confidence not in CONFIDENCES:
        raise ValueError(f"bad confidence {confidence!r}; one of {', '.join(CONFIDENCES)}")
    summary = " ".join(str(fields.get("summary") or "").split())
    if not summary:
        raise ValueError("an estimate needs a summary of why")
    qualifiers = [q for q in dict.fromkeys(fields.get("qualifiers") or []) if q in QUALIFIERS]

    # Each contaminant: a name, what's known, and the two judgments on it.
    contaminants = []
    for item in fields.get("contaminants") or []:
        if not isinstance(item, dict):
            raise ValueError("each contaminant must be an object")
        name = " ".join(str(item.get("name") or "").split())
        known = " ".join(str(item.get("known") or "").split())
        if not name or not known:
            raise ValueError("each contaminant needs a name and what is known")
        if item.get("organic_helps") not in ORGANIC_HELPS:
            raise ValueError(f"{name}: organic_helps must be one of {', '.join(ORGANIC_HELPS)}")
        if item.get("evidence") not in EVIDENCE:
            raise ValueError(f"{name}: evidence must be one of {', '.join(EVIDENCE)}")
        contaminants.append({"name": name, "known": known,
                             "organic_helps": item["organic_helps"], "evidence": item["evidence"]})
    return {"verdict": verdict, "confidence": confidence, "summary": summary,
            "qualifiers": qualifiers, "contaminants": contaminants}


# --- writing ------------------------------------------------------------------

def save(food, fields, *, lens="health", model=None):
    """Store an estimate for one food through one lens, replacing any earlier
    one (a fresh estimate starts unreviewed). Returns its id."""
    if lens not in hazardstore.LENSES:
        raise ValueError(f"bad lens {lens!r}; one of {', '.join(hazardstore.LENSES)}")
    tidy = clean(fields)
    with _Write() as conn:
        food_id = foodstore._food_id(conn, food)
        conn.execute("DELETE FROM food_estimates WHERE food_id = ? AND lens = ?", (food_id, lens))
        return conn.execute(
            "INSERT INTO food_estimates (food_id, lens, verdict, confidence, summary,"
            " qualifiers, contaminants, model) VALUES (?,?,?,?,?,?,?,?)",
            (food_id, lens, tidy["verdict"], tidy["confidence"], tidy["summary"],
             json.dumps(tidy["qualifiers"]), json.dumps(tidy["contaminants"]), model),
        ).lastrowid


def review(estimate_id, verdict_review):
    """Her mark on an estimate: unreviewed, confirmed or disputed."""
    if verdict_review not in hazardstore.REVIEWS:
        raise ValueError(f"bad review {verdict_review!r}; one of {', '.join(hazardstore.REVIEWS)}")
    with _Write() as conn:
        done = conn.execute(
            "UPDATE food_estimates SET review = ?, reviewed_at = CASE WHEN ? = 'unreviewed'"
            " THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ','now') END WHERE id = ?",
            (verdict_review, verdict_review, estimate_id)).rowcount
    if not done:
        raise ValueError(f"no estimate {estimate_id}")


def food_for_item(name, category=None):
    """The food a grocery-list name resolves to, creating one when no food
    answers to it yet. Only this one name is filed, unlike foodstore.adopt(),
    which sweeps every unmatched name at once."""
    conn = sqlstore.open_db()
    try:
        return foodstore._food_id(conn, name)
    except ValueError:
        pass
    finally:
        conn.close()
    return foodstore.add_food(name, kind=foodstore.NON_FOOD_CATEGORIES.get(category, "food"),
                              category=category)


# --- reading --------------------------------------------------------------------

def _estimate_dict(row):
    estimate = dict(zip(_COLUMNS, row))
    for column in _JSON_COLUMNS:
        estimate[column] = json.loads(estimate[column] or "[]")
    return estimate


def _list_items():
    """The grocery list as it stands in kitchen.json: (name, category, checked)."""
    for item in store.read("kitchen.json", {}).get("items") or []:
        name = (item.get("name") or "").strip()
        if name:
            yield name, item.get("category"), bool(item.get("checked"))


def list_view(lens="health"):
    """Every grocery-list item with what is known about buying it organic.

    Per item: the food it resolves to (or None), the food's kind, the research
    verdict on the whole food if there is one, and Claude's estimate if there
    is one. `pending` counts the food items with no estimate yet — exactly
    what the estimate run fills. (A researched item is still estimated: the
    estimate's contaminant notes are worth having beside the research.)"""
    conn = _read_conn()
    try:
        names = dict(conn.execute("SELECT name, food_id FROM food_names"))
        kinds = dict(conn.execute("SELECT id, kind FROM foods"))
        # Research verdicts on the whole food (not about one hazard only),
        # with how many measurements each rests on.
        research = {}
        for row in conn.execute(
                "SELECT j.food_id, j.id, j.verdict, j.review, j.author,"
                " (SELECT COUNT(*) FROM judgment_grounds g WHERE g.judgment_id = j.id)"
                " FROM food_judgments j WHERE j.lens = ? AND j.hazard_id IS NULL", (lens,)):
            research[row[0]] = dict(zip(("id", "verdict", "review", "author", "grounds"), row[1:]))
        estimates = {
            row[1]: _estimate_dict(row) for row in conn.execute(
                f"SELECT {', '.join(_COLUMNS)} FROM food_estimates WHERE lens = ?", (lens,))
        }
    finally:
        conn.close()

    items, pending = [], 0
    for name, category, checked in _list_items():
        food_id = names.get(foodstore._norm(name))
        kind = kinds.get(food_id) if food_id else foodstore.NON_FOOD_CATEGORIES.get(category, "food")
        item = {"name": name, "category": category, "checked": checked, "food_id": food_id,
                "kind": kind, "research": research.get(food_id),
                "estimate": estimates.get(food_id)}
        if kind == "food" and not item["estimate"]:
            pending += 1
        items.append(item)
    return {"lens": lens, "items": items, "pending": pending}


def to_estimate(lens="health", force=False):
    """The list items the estimate run should ask about: food items with no
    estimate yet (every food item, with `force`). Returns (name, category)."""
    return [(item["name"], item["category"]) for item in list_view(lens)["items"]
            if item["kind"] == "food" and (force or not item["estimate"])]


# --- the estimate run ---------------------------------------------------------

def lock_path():
    """The file a running estimate holds a lock on, so there is only one."""
    return store.DATA_DIR / "estimate_organic.lock"


def running():
    """Whether an estimate run holds the lock right now. Tried, not guessed:
    a run that crashed let go of its lock with its process."""
    path = lock_path()
    if not path.exists():
        return False
    with open(path, "a") as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return True
        fcntl.flock(handle, fcntl.LOCK_UN)
    return False


def last_run():
    """How the last estimate run went, or None if there hasn't been one."""
    return store.read(RUN_FILE, None)


def vocab():
    """The words the popup shows, so the page never hardcodes them."""
    return {"verdicts": dict(hazardstore.VERDICTS), "qualifiers": dict(QUALIFIERS),
            "confidences": list(CONFIDENCES), "organic_helps": list(ORGANIC_HELPS),
            "evidence": list(EVIDENCE)}
