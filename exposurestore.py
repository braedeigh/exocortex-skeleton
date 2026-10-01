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
                     re-score replaces it.

**Who writes what.** 'code' = a loader parsing a published table, 'llm' = an
agent, 'owner' = her. Only hers is born confirmed; a fact whose value changes
goes back to unreviewed.

**Backup.** Facts, PDP codes, the ledger, the scores, and the source files
with their passage pages all ride hazardstore's backup (research_tables.json):
each is written through hazardstore's write transaction, which exports that
file after every commit and reads it back when the hazard tables are found
empty. Facts and PDP codes are her record. The scores could be worked out
again from the commons, and so could most of the ledger, but its literature
searches are written down nowhere else. The passage pages could be worked out
again from the PDFs, but only once each source is tied to its file again.

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
    "no_chronic_limit": "EPA sets no chronic limit",
    "acute_dose": "EPA acute safe dose",
    "cancer_rating": "cancer rating",
    "cancer_slope": "cancer slope factor",
    "reference_level": "FDA reference level",
    "health_effect": "health effect",
    "status": "regulatory status",
    "summary": "in plain words",
    "independent_evidence": "independent evidence",
}
# Agency figures are not taken on trust. Studies from outside the agencies
# (in vitro, animal, human, reviews) go in as `independent_evidence` facts —
# an agent's plain summary of one study each, for her to judge. A contaminant
# counts as researched only once she has confirmed one as useful; until then
# its page says it needs more research. A `no_chronic_limit` fact shows EPA's
# own words but never counts as a dose, so a food where one is found stays an
# open question.
AUTHORS = ("llm", "owner", "code")
# What kind of study an independent finding comes from, and which way it
# leans; a finding's basis reads "<study type> · <leaning>".
STUDY_TYPES = ("in vitro", "animal", "human", "review", "other")
LEANINGS = ("found harm", "found no harm", "mixed", "background")
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
    """Every fact about one contaminant, grouped in FACTS order, newest first within a kind.

    A fact read from a research source also carries that source's citation
    and address (`source`, `source_url`), and the words of its highlighted
    passage (`passage`), so the page can show what the study said.
    """
    order = {name: index for index, name in enumerate(FACTS)}
    with hazardstore._Read() as conn:
        hazard_id = hazardstore._hazard_id(conn, hazard)
        rows = conn.execute(
            f"SELECT {', '.join('f.' + column for column in _FACT_COLUMNS)}, e.text, e.url, a.exact"
            " FROM hazard_facts f LEFT JOIN research_entries e ON e.id = f.source_id"
            " LEFT JOIN research_annotations a ON a.id = f.annotation_id"
            " WHERE f.hazard_id = ? ORDER BY f.created_at DESC, f.id DESC", (hazard_id,)).fetchall()
    facts = []
    for row in rows:
        fact = _fact_dict(row[:len(_FACT_COLUMNS)])
        fact["source"], fact["source_url"], fact["passage"] = row[len(_FACT_COLUMNS):]
        facts.append(fact)
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
    with hazardstore._Write() as conn:
        conn.execute(
            "INSERT INTO data_pulls (dataset, year, scope, file_path, file_sha256, rows, detail,"
            " loader_version) VALUES (?,?,?,?,?,?,?,?)"
            " ON CONFLICT (dataset, year, scope, loader_version) DO UPDATE SET"
            " file_path = excluded.file_path, file_sha256 = excluded.file_sha256,"
            f" rows = excluded.rows, detail = excluded.detail, pulled_at = {_NOW}",
            (dataset, int(year or 0), scope or "", file_path, file_sha256, int(rows),
             json.dumps(detail or {}, sort_keys=True), loader_version))


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
    with hazardstore._Write() as conn:
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
        return score_id


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
    # EPA's own words, beside a pesticide it sets no chronic limit for.
    # Read now rather than stored with the score, so a fact added later shows
    # without a rescore; it never changes the verdict.
    said = agency_no_limit([term["hazard_id"] for term in score["terms"]
                            if term["hazard_id"] is not None and term["dose"] is None])
    for term in score["terms"]:
        term["no_chronic_limit"] = said.get(term["hazard_id"])
    return score


def agency_no_limit(hazard_ids):
    """{hazard id: {value, url, fact_id}} — the newest undisputed
    `no_chronic_limit` fact for each contaminant that has one."""
    if not hazard_ids:
        return {}
    conn = sqlstore.open_db()
    try:
        rows = conn.execute(
            "SELECT hazard_id, value, url, id FROM hazard_facts WHERE fact = 'no_chronic_limit'"
            f" AND review != 'disputed' AND hazard_id IN ({','.join('?' * len(hazard_ids))})"
            " ORDER BY updated_at, id", list(hazard_ids)).fetchall()
    finally:
        conn.close()
    return {hazard_id: {"value": value, "url": url, "fact_id": fact_id}
            for hazard_id, value, url, fact_id in rows}


# --- what others found (the sanity check) ------------------------------------

# A published ranking of a food's pesticides — EWG's Dirty Dozen, Consumer
# Reports' risk ratings — is kept as a research claim whose value has this
# measure, the food's name as its subject, and the ranker in its extra. The
# food page shows them beside the verdict as a sanity check, never as one:
# they don't enter the score. Written by scripts/reference_data.py `ranking`.
RANKING_MEASURE = "pesticide ranking"


def outside_rankings(food_names):
    """Every published ranking of these foods (a food's name and its other
    names), newest year first: [{claim_id, by, year, claim, label, rank,
    text, verdict, reviewed, source_id, source, url, passage}]."""
    names = [name.lower() for name in food_names if name]
    if not names:
        return []
    conn = sqlstore.open_db()
    try:
        rows = conn.execute(
            "SELECT v.claim_id, v.extra, v.year, v.basis, v.tier, v.amount, c.text, c.verdict,"
            " c.reviewed, s.id, s.text, s.url, a.exact"
            " FROM claim_values v JOIN research_entries c ON c.id = v.claim_id"
            " LEFT JOIN claim_sources cs ON cs.claim_id = v.claim_id"
            " LEFT JOIN research_entries s ON s.id = cs.source_id"
            " LEFT JOIN research_annotations a ON a.id = cs.annotation_id"
            f" WHERE v.measure = ? AND lower(v.subject) IN ({','.join('?' * len(names))})"
            " ORDER BY v.year DESC, v.claim_id, cs.created",
            [RANKING_MEASURE, *names]).fetchall()
    finally:
        conn.close()
    # One row per claim: a claim with several sources shows its first.
    rankings = {}
    for (claim_id, extra, year, claim, label, rank, text, verdict, reviewed, source_id,
         source, url, passage) in rows:
        if claim_id in rankings:
            continue
        rankings[claim_id] = {
            "claim_id": claim_id, "by": json.loads(extra or "{}").get("by"), "year": year,
            "claim": claim, "label": label, "rank": rank, "text": text, "verdict": verdict,
            "reviewed": bool(reviewed), "source_id": source_id, "source": source, "url": url,
            "passage": passage}
    return list(rankings.values())


def research_state(facts):
    """How far past the agencies' word a contaminant has been checked:
    {independent: findings she confirmed as useful, to_judge: findings still
    waiting for her, needs_research: True until she has confirmed one}.

    An agent's finding alone never lifts "needs research" — it is a summary
    for her to judge, and only her confirmation counts.
    """
    findings = [fact for fact in facts if fact["fact"] == "independent_evidence"]
    independent = sum(1 for fact in findings if fact["review"] == "confirmed")
    to_judge = sum(1 for fact in findings if fact["review"] == "unreviewed")
    return {"independent": independent, "to_judge": to_judge, "needs_research": independent == 0}


# --- the literature searches (the memory of what has been combed) --------------

# A search is kept in the pull ledger like any other pull of public data: one
# row per contaminant × database × query, so running the same search again
# updates its row instead of adding one.
LITERATURE = "literature"
_LITERATURE_VERSION = 1


def record_search(hazard, database, query, count, looked_at):
    """Remember one literature search about a contaminant: where, what was
    typed, how many papers matched, and how many were looked at."""
    with hazardstore._Read() as conn:
        hazard_id = hazardstore._hazard_id(conn, hazard)
    record_pull(LITERATURE, 0, f"{hazard_id}|{database}|{query}", "", "", count,
                {"hazard_id": hazard_id, "database": database, "query": query,
                 "matched": count, "looked_at": looked_at}, _LITERATURE_VERSION)
    return hazard_id


def searches_for(hazard_id):
    """Every literature search about one contaminant, newest first:
    [{database, query, matched, looked_at, searched_at}]."""
    return [{**{key: pull["detail"].get(key) for key in ("database", "query", "matched", "looked_at")},
             "searched_at": pull["pulled_at"]}
            for pull in ledger(LITERATURE) if pull["detail"].get("hazard_id") == hazard_id]


# --- a source's own file, and the page each passage is on ----------------------

def set_source_file(source_id, commons_path, sha256, pages=None):
    """Tie a research source to its file in the commons (one file per source)."""
    with hazardstore._Write() as conn:
        conn.execute(
            "INSERT INTO source_files (source_id, commons_path, sha256, pages) VALUES (?,?,?,?)"
            " ON CONFLICT (source_id) DO UPDATE SET commons_path = excluded.commons_path,"
            " sha256 = excluded.sha256, pages = excluded.pages",
            (source_id, commons_path, sha256, pages))


def source_file(source_id):
    """{'commons_path', 'sha256', 'pages'} for a source with a file, else None."""
    # Through hazardstore's read, so a lost database is restored first.
    with hazardstore._Read() as conn:
        row = conn.execute("SELECT commons_path, sha256, pages FROM source_files"
                           " WHERE source_id = ?", (source_id,)).fetchone()
    return dict(zip(("commons_path", "sha256", "pages"), row)) if row else None


def set_passage_pages(pages):
    """Record which page each passage falls on: {annotation_id: page}."""
    with hazardstore._Write() as conn:
        conn.executemany(
            "INSERT INTO passage_pages (annotation_id, page) VALUES (?, ?)"
            " ON CONFLICT (annotation_id) DO UPDATE SET page = excluded.page",
            list(pages.items()))


def passage_page(annotation_id):
    """The page a passage falls on, or None when it was never placed."""
    # Through hazardstore's read, so a lost database is restored first.
    with hazardstore._Read() as conn:
        row = conn.execute("SELECT page FROM passage_pages WHERE annotation_id = ?",
                           (annotation_id,)).fetchone()
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
    hazard_measures), rankings (what EWG, Consumer Reports and the like
    published about it — a sanity check)}. None when the food isn't in the catalog.
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
        names = [name] + [row[0] for row in conn.execute(
            "SELECT name FROM food_names WHERE food_id = ?", (food_id,))]
    scores = scores_for(food_id)
    single_years = sorted({score["years"] for score in scores if "," not in score["years"]},
                          reverse=True)
    headline = {}
    if single_years:
        for score in scores:
            if score["years"] == single_years[0]:
                headline[score["claim"]] = score_detail(score["id"])
    return {"food_id": food_id, "name": name, "codes": codes, "scores": scores,
            "headline": headline, "years": single_years, "measures": measures,
            "rankings": outside_rankings(names)}


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
    facts = facts_for(hazard_id)
    return {"id": row[0], "name": row[1], "note": row[2], "parents": parents,
            "names": names, "facts": facts, "research": research_state(facts),
            "searches": searches_for(row[0]),
            "found_in": [dict(zip(keys, each)) for each in found], "measures": measures}


def contaminant_index():
    """Every contaminant with a fact or a computed finding, for the list page:
    [{id, name, parents, foods (how many foods it was found in), facts, max_dri,
    independent (findings she confirmed — 0 means it needs research),
    to_judge (findings waiting for her)}]."""
    with hazardstore._Read() as conn:
        rows = conn.execute(
            "SELECT h.id, h.name,"
            " (SELECT GROUP_CONCAT(p.name, ', ') FROM hazard_parents hp"
            "   JOIN hazards p ON p.id = hp.parent_id WHERE hp.hazard_id = h.id),"
            " (SELECT COUNT(DISTINCT s.food_id) FROM exposure_terms t"
            "   JOIN exposure_scores s ON s.id = t.score_id"
            "   WHERE t.hazard_id = h.id AND t.samples_detected > 0),"
            " (SELECT COUNT(*) FROM hazard_facts WHERE hazard_id = h.id),"
            " (SELECT MAX(t.dri) FROM exposure_terms t WHERE t.hazard_id = h.id),"
            " (SELECT COUNT(*) FROM hazard_facts WHERE hazard_id = h.id"
            "   AND fact = 'independent_evidence' AND review = 'confirmed'),"
            " (SELECT COUNT(*) FROM hazard_facts WHERE hazard_id = h.id"
            "   AND fact = 'independent_evidence' AND review = 'unreviewed')"
            " FROM hazards h WHERE EXISTS (SELECT 1 FROM hazard_facts WHERE hazard_id = h.id)"
            "   OR EXISTS (SELECT 1 FROM exposure_terms WHERE hazard_id = h.id)"
            "   OR EXISTS (SELECT 1 FROM hazard_measures WHERE hazard_id = h.id)"
            " ORDER BY h.name").fetchall()
    return [dict(zip(("id", "name", "parents", "foods", "facts", "max_dri", "independent",
                      "to_judge"), row))
            for row in rows]
