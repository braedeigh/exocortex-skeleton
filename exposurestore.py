"""Verifiable exposure — contaminant facts, the pull ledger, and computed scores.

**What this is.** The exo.db half of the verifiable-organic work (the design is
in docs/exposure.md). Public residue data is parsed into commons.db
(commonsdb.py); this module keeps what belongs in the owner's database:

  contaminant facts  one sourced fact about one contaminant — its CAS number,
                     what it's used as, EPA's chronic safe daily dose, its
                     cancer rating, a health effect. Each carries its source
                     and passage (or the agency page it was read from) and her
                     review, like every number in hazardstore.py.
  PDP codes          which USDA Pesticide Data Program commodity a food is,
                     so its samples can be found.
  the pull ledger    every pull of public data: which dataset, year and food,
                     which file (by checksum), how many rows, which loader.
                     This is the memory of what has already been pulled.
  scores             a computed exposure score per food × samples × method,
                     with one line of working per pesticide. Derived: a
                     re-score replaces it, so it has no backup of its own.

**Who writes what.** 'code' = a loader parsing a published table, 'llm' = an
agent, 'owner' = her. Only hers is born confirmed; a fact whose value changes
goes back to unreviewed. Facts and PDP codes are her record and ride
hazardstore's backup (research_tables.json); the ledger and scores can be
rebuilt from the commons, so they don't.

Touches: `sqlstore.py` (rung 36), `hazardstore.py` (hazards, its write/read
transactions and backup), `foodstore.py` (foods; its merge moves PDP codes),
`exposure.py` (the calculation that produces scores), `routes/exposure.py`,
`scripts/reference_data.py`, `tests/test_exposurestore.py`.

Prompt that produced this file: "i want all of this data to persist in the
database and to have memory of what has been researched and make it easy to
reference everything" — plus a pesticide profile (name, CAS, type, EPA chronic
safe daily limit, cancer rating, health risks), every fact sourced and
starting unreviewed, and "any possible contaminant to be listed with potential
values next to any of them, and be able to click into those contaminants to
learn more about them and see how harmful they might be."
"""
import json

import hazardstore
import sqlstore

# The facts a contaminant can have, each with the words the page shows.
# Add a word here to add a kind of fact.
FACTS = {
    "cas": "CAS number",
    "use": "used as",
    "pdp_code": "USDA PDP code",
    "chronic_dose": "EPA chronic safe daily dose",
    "acute_dose": "EPA acute safe dose",
    "cancer_rating": "cancer rating",
    "cancer_slope": "cancer slope factor",
    "reference_level": "FDA reference level",
    "health_effect": "health effect",
    "status": "regulatory status",
    "summary": "in plain words",
}
AUTHORS = ("llm", "owner", "code")
CLAIMS = ("conventional", "organic", "all")

_FACT_COLUMNS = ("id", "hazard_id", "fact", "value", "amount", "unit", "basis", "source_id",
                 "annotation_id", "url", "note", "author", "review", "reviewed_at",
                 "created_at", "updated_at")
_NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')"


def _fact_dict(row):
    fact = dict(zip(_FACT_COLUMNS, row))
    fact["label"] = FACTS.get(fact["fact"], fact["fact"])
    return fact


# --- contaminant facts ---------------------------------------------------------

def _check_fact(fact, author, source_id, url):
    """Refuse an unknown kind of fact, an unknown author, or an unsourced
    fact from anyone but the owner — with a message an agent can act on."""
    if fact not in FACTS:
        raise ValueError(f"unknown fact {fact!r} — one of: {', '.join(FACTS)}")
    if author not in AUTHORS:
        raise ValueError(f"author must be one of {AUTHORS}")
    if author != "owner" and not (source_id or url):
        raise ValueError("a fact needs a source_id or a url — say where it was read")


def add_fact(hazard, fact, value, *, amount=None, unit=None, basis=None, source_id=None,
             annotation_id=None, url=None, note=None, author="llm"):
    """Record one fact about a contaminant. Returns the new fact's id."""
    _check_fact(fact, author, source_id, url)
    review = "confirmed" if author == "owner" else "unreviewed"
    with hazardstore._Write() as conn:
        hazard_id = hazardstore._hazard_id(conn, hazard)
        cursor = conn.execute(
            "INSERT INTO hazard_facts (hazard_id, fact, value, amount, unit, basis, source_id,"
            " annotation_id, url, note, author, review, reviewed_at)"
            f" VALUES (?,?,?,?,?,?,?,?,?,?,?,?, CASE WHEN ? = 'confirmed' THEN {_NOW} END)",
            (hazard_id, fact, str(value), amount, unit, basis, source_id, annotation_id, url,
             note, author, review, review))
        return cursor.lastrowid


def _put_code_fact(conn, hazard_id, fact, value, url, amount=None, unit=None, basis=None,
                   note=None):
    """put_code_fact's work, inside a write transaction the caller holds."""
    row = conn.execute(
        "SELECT id, value, amount, unit, basis FROM hazard_facts"
        " WHERE hazard_id = ? AND fact = ? AND author = 'code' AND url = ?",
        (hazard_id, fact, url)).fetchone()
    if row is None:
        cursor = conn.execute(
            "INSERT INTO hazard_facts (hazard_id, fact, value, amount, unit, basis, url,"
            " note, author) VALUES (?,?,?,?,?,?,?,?, 'code')",
            (hazard_id, fact, str(value), amount, unit, basis, url, note))
        return cursor.lastrowid, "added"
    if (row[1], row[2], row[3], row[4]) == (str(value), amount, unit, basis):
        return row[0], "same"
    conn.execute(
        "UPDATE hazard_facts SET value = ?, amount = ?, unit = ?, basis = ?, note = ?,"
        f" review = 'unreviewed', reviewed_at = NULL, updated_at = {_NOW} WHERE id = ?",
        (str(value), amount, unit, basis, note, row[0]))
    return row[0], "changed"


def put_code_fact(hazard, fact, value, *, url, amount=None, unit=None, basis=None, note=None):
    """A loader's fact, written so re-running the loader is safe.

    One 'code' fact per contaminant, kind and page: the same value again
    changes nothing (and keeps her review); a different value replaces it and
    goes back to unreviewed. Returns (fact id, 'added' | 'same' | 'changed').
    """
    _check_fact(fact, "code", None, url)
    with hazardstore._Write() as conn:
        hazard_id = hazardstore._hazard_id(conn, hazard)
        return _put_code_fact(conn, hazard_id, fact, value, url, amount, unit, basis, note)


def put_found_contaminants(found):
    """Put many found contaminants on the map with their loader facts, in ONE
    write — a score finds dozens, and a write each (with its backup) crawls.

    `found` is a list of {"name", "parent", "aliases", "facts": [{fact, value,
    url, amount?, unit?, basis?, note?}]}. A contaminant already on the map
    (by any of its names) keeps its place; a new one goes under `parent`.
    Returns {name: hazard id}.
    """
    ids = {}
    with hazardstore._Write() as conn:
        for item in found:
            names = [item["name"], *item.get("aliases", ())]
            row = None
            for name in names:
                row = conn.execute("SELECT hazard_id FROM hazard_names WHERE name = ?",
                                   (hazardstore._norm(name),)).fetchone()
                if row:
                    break
            if row:
                hazard_id = row[0]
            else:
                hazard_id = conn.execute("INSERT INTO hazards (name) VALUES (?)",
                                         (" ".join(item["name"].split()),)).lastrowid
                for name in names:
                    hazardstore._file_name(conn, hazard_id, name)
                hazardstore._set_parents(conn, hazard_id, [item["parent"]])
            for fact in item.get("facts", ()):
                _check_fact(fact["fact"], "code", None, fact["url"])
                _put_code_fact(conn, hazard_id, fact["fact"], fact["value"], fact["url"],
                               fact.get("amount"), fact.get("unit"), fact.get("basis"),
                               fact.get("note"))
            ids[item["name"]] = hazard_id
    return ids


def review_fact(fact_id, review):
    """Her mark on a fact: confirmed, disputed, or back to unreviewed."""
    if review not in hazardstore.REVIEWS:
        raise ValueError(f"review must be one of {hazardstore.REVIEWS}")
    with hazardstore._Write() as conn:
        changed = conn.execute(
            "UPDATE hazard_facts SET review = ?,"
            f" reviewed_at = CASE WHEN ? = 'unreviewed' THEN NULL ELSE {_NOW} END WHERE id = ?",
            (review, review, fact_id)).rowcount
    if not changed:
        raise ValueError(f"no such fact: {fact_id}")


def delete_fact(fact_id):
    with hazardstore._Write() as conn:
        if not conn.execute("DELETE FROM hazard_facts WHERE id = ?", (fact_id,)).rowcount:
            raise ValueError(f"no such fact: {fact_id}")


def facts_for(hazard):
    """Every fact about one contaminant, grouped in FACTS order, newest first within a kind."""
    order = {name: index for index, name in enumerate(FACTS)}
    with hazardstore._Read() as conn:
        hazard_id = hazardstore._hazard_id(conn, hazard)
        rows = conn.execute(
            f"SELECT {', '.join(_FACT_COLUMNS)} FROM hazard_facts WHERE hazard_id = ?"
            " ORDER BY created_at DESC, id DESC", (hazard_id,)).fetchall()
    facts = [_fact_dict(row) for row in rows]
    return sorted(facts, key=lambda fact: order.get(fact["fact"], len(order)))


def chronic_dose(conn, hazard_id):
    """The chronic safe dose a score should use: (mg/kg/day, fact id), or (None, None).

    A disputed fact is never used. Her own figure wins over any other, then
    a confirmed one, then the newest.
    """
    row = conn.execute(
        "SELECT amount, id FROM hazard_facts WHERE hazard_id = ? AND fact = 'chronic_dose'"
        " AND amount IS NOT NULL AND amount > 0 AND review != 'disputed'"
        " ORDER BY author = 'owner' DESC, review = 'confirmed' DESC, updated_at DESC LIMIT 1",
        (hazard_id,)).fetchone()
    return (row[0], row[1]) if row else (None, None)


def chronic_doses(hazard_ids):
    """chronic_dose for many contaminants at once: {hazard id: (dose, fact id)}."""
    conn = sqlstore.open_db()
    try:
        return {hazard_id: chronic_dose(conn, hazard_id) for hazard_id in hazard_ids}
    finally:
        conn.close()


# --- which USDA PDP commodity a food is ----------------------------------------

def set_pdp_codes(food, codes):
    """Replace a food's PDP codes with `codes`: [(commodity, commtype), ...]."""
    cleaned = sorted({(str(code).strip().upper(), str(kind or "").strip().upper())
                      for code, kind in codes})
    if any(len(code) != 2 for code, _ in cleaned):
        raise ValueError("a PDP commodity code is two letters, e.g. 'PO'")
    with hazardstore._Write() as conn:
        food_id = hazardstore._food_id(conn, food)
        conn.execute("DELETE FROM food_pdp_codes WHERE food_id = ?", (food_id,))
        conn.executemany("INSERT INTO food_pdp_codes (food_id, commodity, commtype) VALUES (?,?,?)",
                         [(food_id, code, kind) for code, kind in cleaned])
        return food_id


def pdp_codes(food=None):
    """{food_id: [(commodity, commtype), ...]} — one food's, or every food's."""
    with hazardstore._Read() as conn:
        if food is None:
            rows = conn.execute("SELECT food_id, commodity, commtype FROM food_pdp_codes"
                                " ORDER BY 1, 2, 3").fetchall()
        else:
            food_id = hazardstore._food_id(conn, food)
            rows = conn.execute("SELECT food_id, commodity, commtype FROM food_pdp_codes"
                                " WHERE food_id = ? ORDER BY 2, 3", (food_id,)).fetchall()
    out = {}
    for food_id, code, kind in rows:
        out.setdefault(food_id, []).append((code, kind))
    return out


# --- the pull ledger (the memory of what has been pulled) ----------------------

_PULL_COLUMNS = ("id", "dataset", "year", "scope", "file_path", "file_sha256", "rows",
                 "detail", "loader_version", "pulled_at")


def _pull_dict(row):
    pull = dict(zip(_PULL_COLUMNS, row))
    pull["detail"] = json.loads(pull["detail"] or "{}")
    return pull


def find_pull(dataset, year, scope, loader_version):
    """The ledger row for this exact pull, or None if it hasn't been done."""
    conn = sqlstore.open_db()
    try:
        row = conn.execute(
            f"SELECT {', '.join(_PULL_COLUMNS)} FROM data_pulls WHERE dataset = ? AND year = ?"
            " AND scope = ? AND loader_version = ?",
            (dataset, int(year or 0), scope or "", loader_version)).fetchone()
    finally:
        conn.close()
    return _pull_dict(row) if row else None


def record_pull(dataset, year, scope, file_path, file_sha256, rows, detail, loader_version):
    """Write a pull into the ledger; pulling the same thing again updates its row."""
    conn = sqlstore.open_db()
    try:
        sqlstore.begin_immediate(conn)
        conn.execute(
            "INSERT INTO data_pulls (dataset, year, scope, file_path, file_sha256, rows, detail,"
            " loader_version) VALUES (?,?,?,?,?,?,?,?)"
            " ON CONFLICT (dataset, year, scope, loader_version) DO UPDATE SET"
            " file_path = excluded.file_path, file_sha256 = excluded.file_sha256,"
            f" rows = excluded.rows, detail = excluded.detail, pulled_at = {_NOW}",
            (dataset, int(year or 0), scope or "", file_path, file_sha256, int(rows),
             json.dumps(detail or {}, sort_keys=True), loader_version))
        conn.execute("COMMIT")
    except BaseException:
        # Undo only a transaction that began: a BEGIN that timed out on the
        # lock leaves none, and its own error is the one worth seeing.
        if conn.in_transaction:
            conn.execute("ROLLBACK")
        raise
    finally:
        conn.close()


def ledger(dataset=None):
    """Every pull, newest first — optionally one dataset's."""
    conn = sqlstore.open_db()
    try:
        sql = f"SELECT {', '.join(_PULL_COLUMNS)} FROM data_pulls"
        params = ()
        if dataset:
            sql += " WHERE dataset = ?"
            params = (dataset,)
        rows = conn.execute(sql + " ORDER BY pulled_at DESC, id DESC", params).fetchall()
    finally:
        conn.close()
    return [_pull_dict(row) for row in rows]


# --- computed scores ------------------------------------------------------------

_SCORE_COLUMNS = ("id", "food_id", "method", "claim", "years", "sample_count",
                  "pesticide_count", "detected_count", "no_dose_count", "total_dri", "max_dri",
                  "verdict", "reference", "computed_at")
_TERM_COLUMNS = ("pesticide_code", "pesticide", "hazard_id", "samples_tested",
                 "samples_detected", "mean_ppb", "max_ppb", "dose", "dose_fact_id", "dri")


def save_score(food_id, method, claim, years, summary, terms):
    """Store one computed score and its working, replacing any earlier one for
    the same food, method, samples and years. Returns the new score's id.

    `summary` holds sample_count, pesticide_count, detected_count,
    no_dose_count, total_dri, max_dri, verdict and reference; each term holds
    the _TERM_COLUMNS.
    """
    if claim not in CLAIMS:
        raise ValueError(f"claim must be one of {CLAIMS}")
    conn = sqlstore.open_db()
    try:
        sqlstore.begin_immediate(conn)
        # Replace, not accumulate: the old score and its terms go (cascade).
        conn.execute("DELETE FROM exposure_scores WHERE food_id = ? AND method = ? AND claim = ?"
                     " AND years = ?", (food_id, method, claim, years))
        cursor = conn.execute(
            "INSERT INTO exposure_scores (food_id, method, claim, years, sample_count,"
            " pesticide_count, detected_count, no_dose_count, total_dri, max_dri, verdict,"
            " reference) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (food_id, method, claim, years, summary["sample_count"], summary["pesticide_count"],
             summary["detected_count"], summary["no_dose_count"], summary["total_dri"],
             summary["max_dri"], summary["verdict"],
             json.dumps(summary.get("reference") or {}, sort_keys=True)))
        score_id = cursor.lastrowid
        conn.executemany(
            f"INSERT INTO exposure_terms (score_id, {', '.join(_TERM_COLUMNS)})"
            f" VALUES (?, {', '.join('?' * len(_TERM_COLUMNS))})",
            [(score_id, *(term.get(column) for column in _TERM_COLUMNS)) for term in terms])
        conn.execute("COMMIT")
        return score_id
    except BaseException:
        # Undo only a transaction that began: a BEGIN that timed out on the
        # lock leaves none, and its own error is the one worth seeing.
        if conn.in_transaction:
            conn.execute("ROLLBACK")
        raise
    finally:
        conn.close()


def _score_dict(row):
    score = dict(zip(_SCORE_COLUMNS, row))
    score["reference"] = json.loads(score["reference"] or "{}")
    return score


def scores_for(food_id):
    """Every stored score for one food, newest data years first."""
    conn = sqlstore.open_db()
    try:
        rows = conn.execute(
            f"SELECT {', '.join(_SCORE_COLUMNS)} FROM exposure_scores WHERE food_id = ?"
            " ORDER BY years DESC, claim", (food_id,)).fetchall()
    finally:
        conn.close()
    return [_score_dict(row) for row in rows]


def score_detail(score_id):
    """One score with its working, biggest share of the safe dose first."""
    conn = sqlstore.open_db()
    try:
        row = conn.execute(f"SELECT {', '.join(_SCORE_COLUMNS)} FROM exposure_scores"
                           " WHERE id = ?", (score_id,)).fetchone()
        if not row:
            return None
        terms = conn.execute(
            f"SELECT {', '.join(_TERM_COLUMNS)} FROM exposure_terms WHERE score_id = ?"
            " ORDER BY dri IS NULL, dri DESC, samples_detected DESC, pesticide", (score_id,)).fetchall()
    finally:
        conn.close()
    score = _score_dict(row)
    score["terms"] = [dict(zip(_TERM_COLUMNS, term)) for term in terms]
    return score


# --- a source's own file, and the page each passage is on ----------------------

def set_source_file(source_id, commons_path, sha256, pages=None):
    """Tie a research source to its file in the commons (one file per source)."""
    conn = sqlstore.open_db()
    try:
        sqlstore.begin_immediate(conn)
        conn.execute(
            "INSERT INTO source_files (source_id, commons_path, sha256, pages) VALUES (?,?,?,?)"
            " ON CONFLICT (source_id) DO UPDATE SET commons_path = excluded.commons_path,"
            " sha256 = excluded.sha256, pages = excluded.pages",
            (source_id, commons_path, sha256, pages))
        conn.execute("COMMIT")
    except BaseException:
        # Undo only a transaction that began: a BEGIN that timed out on the
        # lock leaves none, and its own error is the one worth seeing.
        if conn.in_transaction:
            conn.execute("ROLLBACK")
        raise
    finally:
        conn.close()


def source_file(source_id):
    """{'commons_path', 'sha256', 'pages'} for a source with a file, else None."""
    conn = sqlstore.open_db()
    try:
        row = conn.execute("SELECT commons_path, sha256, pages FROM source_files"
                           " WHERE source_id = ?", (source_id,)).fetchone()
    finally:
        conn.close()
    return dict(zip(("commons_path", "sha256", "pages"), row)) if row else None


def set_passage_pages(pages):
    """Record which page each passage falls on: {annotation_id: page}."""
    conn = sqlstore.open_db()
    try:
        sqlstore.begin_immediate(conn)
        conn.executemany(
            "INSERT INTO passage_pages (annotation_id, page) VALUES (?, ?)"
            " ON CONFLICT (annotation_id) DO UPDATE SET page = excluded.page",
            list(pages.items()))
        conn.execute("COMMIT")
    except BaseException:
        # Undo only a transaction that began: a BEGIN that timed out on the
        # lock leaves none, and its own error is the one worth seeing.
        if conn.in_transaction:
            conn.execute("ROLLBACK")
        raise
    finally:
        conn.close()


def passage_page(annotation_id):
    conn = sqlstore.open_db()
    try:
        row = conn.execute("SELECT page FROM passage_pages WHERE annotation_id = ?",
                           (annotation_id,)).fetchone()
    finally:
        conn.close()
    return row[0] if row else None


# --- the two pages: a food's contaminants, and one contaminant ---------------

_MEASURE_SQL = (
    "SELECT m.id, m.food_id, f.name, m.hazard_id, h.name, m.measure, m.amount, m.unit,"
    " m.sample_size, m.basis, m.year, m.source_id, e.text, e.url, m.review"
    " FROM hazard_measures m JOIN hazards h ON h.id = m.hazard_id JOIN foods f ON f.id = m.food_id"
    " LEFT JOIN research_entries e ON e.id = m.source_id")
_MEASURE_KEYS = ("id", "food_id", "food", "hazard_id", "hazard", "measure", "amount", "unit",
                 "sample_size", "basis", "year", "source_id", "source", "source_url", "review")


def food_exposure(food):
    """Everything the food page shows about contaminants in one food.

    {food_id, name, codes, scores (every stored score, no working),
    headline {conventional, organic} (the latest year's scores WITH working),
    years (every data year scored), measures (study numbers from
    hazard_measures)}. None when the food isn't in the catalog.
    """
    with hazardstore._Read() as conn:
        try:
            food_id = hazardstore._food_id(conn, food)
        except ValueError:
            return None
        name = conn.execute("SELECT name FROM foods WHERE id = ?", (food_id,)).fetchone()[0]
        codes = [list(row) for row in conn.execute(
            "SELECT commodity, commtype FROM food_pdp_codes WHERE food_id = ? ORDER BY 1, 2",
            (food_id,))]
        measures = [dict(zip(_MEASURE_KEYS, row)) for row in conn.execute(
            _MEASURE_SQL + " WHERE m.food_id = ? ORDER BY h.name, m.year DESC", (food_id,))]
    scores = scores_for(food_id)
    single_years = sorted({score["years"] for score in scores if "," not in score["years"]},
                          reverse=True)
    headline = {}
    if single_years:
        for score in scores:
            if score["years"] == single_years[0]:
                headline[score["claim"]] = score_detail(score["id"])
    return {"food_id": food_id, "name": name, "codes": codes, "scores": scores,
            "headline": headline, "years": single_years, "measures": measures}


def contaminant(hazard_id):
    """Everything the contaminant page shows: what it is, its facts, and every
    food it was found in (stored scores' working) or measured in (studies).
    None for an unknown id."""
    with hazardstore._Read() as conn:
        row = conn.execute("SELECT id, name, note FROM hazards WHERE id = ?", (hazard_id,)).fetchone()
        if not row:
            return None
        parents = [name for (name,) in conn.execute(
            "SELECT h.name FROM hazard_parents p JOIN hazards h ON h.id = p.parent_id"
            " WHERE p.hazard_id = ? ORDER BY h.name", (hazard_id,))]
        names = [name for (name,) in conn.execute(
            "SELECT name FROM hazard_names WHERE hazard_id = ? ORDER BY name", (hazard_id,))]
        found = conn.execute(
            "SELECT s.id, s.food_id, f.name, s.claim, s.years, s.sample_count, t.samples_tested,"
            " t.samples_detected, t.mean_ppb, t.max_ppb, t.dose, t.dri, s.method"
            " FROM exposure_terms t JOIN exposure_scores s ON s.id = t.score_id"
            " JOIN foods f ON f.id = s.food_id WHERE t.hazard_id = ?"
            " ORDER BY f.name, s.years DESC, s.claim", (hazard_id,)).fetchall()
        measures = [dict(zip(_MEASURE_KEYS, row)) for row in conn.execute(
            _MEASURE_SQL + " WHERE m.hazard_id = ? ORDER BY f.name, m.year DESC", (hazard_id,))]
    keys = ("score_id", "food_id", "food", "claim", "years", "sample_count", "samples_tested",
            "samples_detected", "mean_ppb", "max_ppb", "dose", "dri", "method")
    return {"id": row[0], "name": row[1], "note": row[2], "parents": parents,
            "names": names, "facts": facts_for(hazard_id),
            "found_in": [dict(zip(keys, each)) for each in found], "measures": measures}


def contaminant_index():
    """Every contaminant with a fact or a computed finding, for the list page:
    [{id, name, parents, foods (how many foods it was found in), facts}]."""
    with hazardstore._Read() as conn:
        rows = conn.execute(
            "SELECT h.id, h.name,"
            " (SELECT GROUP_CONCAT(p.name, ', ') FROM hazard_parents hp"
            "   JOIN hazards p ON p.id = hp.parent_id WHERE hp.hazard_id = h.id),"
            " (SELECT COUNT(DISTINCT s.food_id) FROM exposure_terms t"
            "   JOIN exposure_scores s ON s.id = t.score_id"
            "   WHERE t.hazard_id = h.id AND t.samples_detected > 0),"
            " (SELECT COUNT(*) FROM hazard_facts WHERE hazard_id = h.id),"
            " (SELECT MAX(t.dri) FROM exposure_terms t WHERE t.hazard_id = h.id)"
            " FROM hazards h WHERE EXISTS (SELECT 1 FROM hazard_facts WHERE hazard_id = h.id)"
            "   OR EXISTS (SELECT 1 FROM exposure_terms WHERE hazard_id = h.id)"
            "   OR EXISTS (SELECT 1 FROM hazard_measures WHERE hazard_id = h.id)"
            " ORDER BY h.name").fetchall()
    return [dict(zip(("id", "name", "parents", "foods", "facts", "max_dri"), row)) for row in rows]
