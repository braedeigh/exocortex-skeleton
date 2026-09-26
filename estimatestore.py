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
import re
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
            "contaminants", "claims", "model", "review", "reviewed_at", "created_at")
_JSON_COLUMNS = ("qualifiers", "contaminants", "claims")


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
                tuple(record.get(column, "[]" if column in _JSON_COLUMNS else None)
                      for column in _COLUMNS))
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

def clean(fields, offered_claims=()):
    """Check an estimate's fields and return them tidied, or raise ValueError
    naming what is wrong. Unknown qualifiers are dropped rather than refused —
    a model inventing a word shouldn't lose the whole estimate — but a bad
    verdict, confidence, or contaminant field is refused. A cited claim must
    be one of `offered_claims`, the ones the model was actually shown: citing
    anything else is refused, since that is a made-up reference."""
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
    claims = [str(c) for c in dict.fromkeys(fields.get("claims") or [])]
    unknown = [c for c in claims if c not in set(offered_claims)]
    if unknown:
        raise ValueError(f"cited claims it wasn't shown: {', '.join(unknown)}")
    return {"verdict": verdict, "confidence": confidence, "summary": summary,
            "qualifiers": qualifiers, "contaminants": contaminants, "claims": claims}


# --- writing ------------------------------------------------------------------

def save(food, fields, *, lens="health", model=None, offered_claims=()):
    """Store an estimate for one food through one lens, replacing any earlier
    one (a fresh estimate starts unreviewed). Returns its id."""
    if lens not in hazardstore.LENSES:
        raise ValueError(f"bad lens {lens!r}; one of {', '.join(hazardstore.LENSES)}")
    tidy = clean(fields, offered_claims)
    with _Write() as conn:
        food_id = foodstore._food_id(conn, food)
        conn.execute("DELETE FROM food_estimates WHERE food_id = ? AND lens = ?", (food_id, lens))
        return conn.execute(
            "INSERT INTO food_estimates (food_id, lens, verdict, confidence, summary,"
            " qualifiers, contaminants, claims, model) VALUES (?,?,?,?,?,?,?,?,?)",
            (food_id, lens, tidy["verdict"], tidy["confidence"], tidy["summary"],
             json.dumps(tidy["qualifiers"]), json.dumps(tidy["contaminants"]),
             json.dumps(tidy["claims"]), model),
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
    verdict on the whole food if there is one, Claude's estimate if there is
    one, and how many claims and measurements her tables hold about it. `pending` counts the food items with no estimate yet — exactly
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

    listed = list(_list_items())
    counts = evidence_counts([name for name, _category, _checked in listed])
    items, pending = [], 0
    for name, category, checked in listed:
        food_id = names.get(foodstore._norm(name))
        kind = kinds.get(food_id) if food_id else foodstore.NON_FOOD_CATEGORIES.get(category, "food")
        item = {"name": name, "category": category, "checked": checked, "food_id": food_id,
                "kind": kind, "research": research.get(food_id),
                "estimate": estimates.get(food_id), "evidence": counts.get(name, 0)}
        if kind == "food" and not item["estimate"]:
            pending += 1
        items.append(item)
    return {"lens": lens, "items": items, "pending": pending}


def to_estimate(lens="health", force=False):
    """The list items the estimate run should ask about: food items with no
    estimate yet (every food item, with `force`). Returns (name, category)."""
    return [(item["name"], item["category"]) for item in list_view(lens)["items"]
            if item["kind"] == "food" and (force or not item["estimate"])]


# --- her research about one food ----------------------------------------------

def _words(text):
    """A name as a set of words for matching: lowercased, punctuation dropped,
    plurals folded ("potatoes" → "potato", "onions" → "onion")."""
    words = set()
    for word in re.findall(r"[a-z]+", str(text or "").lower()):
        if word.endswith("oes"):
            word = word[:-2]
        elif word.endswith("s") and not word.endswith("ss") and len(word) > 3:
            word = word[:-1]
        words.add(word)
    return words


def _about(subject_words, food_word_sets, catalog_word_sets=()):
    """Whether a claim's subject is about this food: every word of one of the
    food's names appears in the subject, and no food in the catalog matches it
    more specifically. So "yukon potatoes" is about "potatoes" unless the
    catalog also has "yukon potatoes"; "sweet potatoes" goes to "sweet
    potatoes" when that is a food; and "cornmeal" is never "corn" (a
    different word)."""
    mine = max((len(words) for words in food_word_sets if words and words <= subject_words),
               default=0)
    if not mine:
        return False
    best = max((len(words) for words in catalog_word_sets if words and words <= subject_words),
               default=0)
    return mine >= best


def _catalog_word_sets(conn):
    """Every food name in the catalog as a word set, for _about's specificity check."""
    return [w for w in (_words(n) for (n,) in conn.execute("SELECT name FROM food_names")) if w]


def _food_word_sets(conn, name):
    """Every way this food is written, as word sets: the list's own spelling,
    plus each name the food catalog files under the same food."""
    sets = [_words(name)]
    row = conn.execute("SELECT food_id FROM food_names WHERE name = ?",
                       (foodstore._norm(name),)).fetchone()
    if row:
        sets += [_words(n) for (n,) in conn.execute(
            "SELECT name FROM food_names WHERE food_id = ?", (row[0],))]
        sets += [_words(n) for (n,) in conn.execute(
            "SELECT name FROM foods WHERE id = ?", (row[0],))]
    return [s for s in sets if s]


def _source_rows(conn, sql, params):
    return [
        {"id": sid, "title": " ".join(str(text or "").split()), "url": url or None,
         "stance": stance}
        for sid, text, url, stance in conn.execute(sql, params)
    ]


def evidence(name):
    """What her research tables hold about one food, with every study behind it.

    Two kinds of row, both from exo.db:
      claims    — research claims whose number is about this food (claim_values
                  subject matched by _about), each with its sources and the
                  source's stance. `subject` is kept as written, so a claim
                  about "yukon potatoes" shows that it was yukon potatoes.
      measures  — numbers in the research tables (hazard_measures) for this
                  food, each with the study it came from.
    Claims about a whole category ("organic crops (all)") are not included;
    they are about no food in particular."""
    conn = _read_conn()
    try:
        word_sets = _food_word_sets(conn, name)
        catalog = _catalog_word_sets(conn)
        claims = {}
        for (claim_id, text, verdict, author, reviewed, subject, measure, amount,
             unit, basis, year, tier) in conn.execute(
                "SELECT e.id, e.text, e.verdict, e.author, e.reviewed, v.subject, v.measure,"
                " v.amount, v.unit, v.basis, v.year, v.tier"
                " FROM claim_values v JOIN research_entries e ON e.id = v.claim_id"
                " ORDER BY e.id"):
            if not _about(_words(subject), word_sets, catalog):
                continue
            claim = claims.setdefault(claim_id, {
                "id": claim_id, "text": " ".join(str(text or "").split()),
                "verdict": verdict or None, "author": author or None,
                "reviewed": reviewed, "values": []})
            claim["values"].append({"subject": subject, "measure": measure, "amount": amount,
                                    "unit": unit, "basis": basis, "year": year, "tier": tier})
        for claim in claims.values():
            claim["sources"] = _source_rows(
                conn, "SELECT s.id, s.text, s.url, c.stance FROM claim_sources c"
                " JOIN research_entries s ON s.id = c.source_id WHERE c.claim_id = ?"
                " ORDER BY c.created", (claim["id"],))

        measures = []
        row = conn.execute("SELECT food_id FROM food_names WHERE name = ?",
                           (foodstore._norm(name),)).fetchone()
        if row:
            for (measure_id, hazard, measure, amount, unit, year, measured_on, review_mark,
                 source_id) in conn.execute(
                    "SELECT m.id, h.name, m.measure, m.amount, m.unit, m.year, m.measured_on,"
                    " m.review, m.source_id FROM hazard_measures m"
                    " JOIN hazards h ON h.id = m.hazard_id WHERE m.food_id = ?"
                    " ORDER BY h.name, m.year", (row[0],)):
                measures.append({
                    "id": measure_id, "hazard": hazard, "measure": measure, "amount": amount,
                    "unit": unit, "year": year, "measured_on": measured_on,
                    "review": review_mark,
                    "sources": _source_rows(
                        conn, "SELECT id, text, url, NULL FROM research_entries WHERE id = ?",
                        (source_id,)) if source_id else []})
    finally:
        conn.close()
    return {"name": name, "claims": list(claims.values()), "measures": measures}


def evidence_counts(names):
    """How many claims and measurements her tables hold for each name — the
    list's cheap version of evidence(), one pass over the claim values."""
    conn = _read_conn()
    try:
        subjects = [(claim_id, _words(subject)) for claim_id, subject in
                    conn.execute("SELECT claim_id, subject FROM claim_values")]
        measure_counts = dict(conn.execute(
            "SELECT food_id, COUNT(*) FROM hazard_measures GROUP BY food_id"))
        catalog = _catalog_word_sets(conn)
        counts = {}
        for name in names:
            word_sets = _food_word_sets(conn, name)
            claim_ids = {cid for cid, words in subjects if _about(words, word_sets, catalog)}
            row = conn.execute("SELECT food_id FROM food_names WHERE name = ?",
                               (foodstore._norm(name),)).fetchone()
            counts[name] = len(claim_ids) + (measure_counts.get(row[0], 0) if row else 0)
    finally:
        conn.close()
    return counts


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
