"""The exposure calculation — method dri-v1, a buy-organic verdict anyone can redo.

**What this does.** For one food, takes every USDA PDP sample of it loaded in
commons.db (commonsdb.py), and for every pesticide PDP tested for works out
how much one serving gives a standard child, as a share of EPA's chronic safe
daily dose. That share is Benbrook's Dietary Risk Index (Environmental Health
2020, PMC7557078):

    DRI = mean residue (mg/kg, over ALL samples tested, non-detect = 0)
          × serving (kg) ÷ body weight (kg) ÷ chronic safe dose (mg/kg/day)

The verdict comes from the paper's written bands (VERDICT_BANDS), applied by
code; nothing here is anyone's judgment. Every pesticide actually found is put
on the hazard map (under "Pesticide") with its EPA facts, so each one on the
page can be clicked into. The full method, and its honest limit — exposure
against a safety reference, not health outcomes — is in docs/exposure.md.

Scores are computed per food for organic samples and for conventional ones,
for the latest year PDP tested the food and, when there are several years,
for all of them combined. Each is saved with its working
(exposurestore.save_score), replacing the last.

Touches: `commonsdb.py` (samples, results, tolerances, EPA benchmarks),
`exposurestore.py` (safe doses, PDP codes, saving scores), `hazardstore.py`
(putting found pesticides on the map), `scripts/reference_data.py` (runs
it), `tests/test_exposure.py`.

Prompt that produced this file: "DRI bands as the verdict rule + the organic
5%-of-tolerance line as a second fact + the DRI child (16 kg, ⅔ FDA RACC
serving) as the standard reference person" — "this scoring is fine, but i
want any possible contaminant to be listed with potential values next to any
of them".
"""
import re

import commonsdb
import exposurestore
import hazardstore
import sqlstore

METHOD = "dri-v1"
EPA_URL = "https://www.epa.gov/sdwa/2021-human-health-benchmarks-pesticides"
PDP_URL = "https://www.ams.usda.gov/datasets/pdp/pdpdata"

# The standard reference person and serving, from the DRI paper: a 16 kg child
# eating two-thirds of FDA's Reference Amount Customarily Consumed (21 CFR
# 101.12). RACC by PDP commodity code — 85 g for vegetables, 140 g for fruit,
# the general categories of that table; add a commodity as it is pulled. A
# food with no entry here isn't scored rather than scored on a guessed serving.
BODY_KG = 16.0
SERVING_SHARE = 2 / 3
RACC_GRAMS = {
    "PO": 85,   # potatoes
    "GK": 85,   # kale greens
    "ST": 140,  # strawberries
    "SZ": 140,  # strawberries, frozen
}

# The verdict bands (Benbrook 2020), highest first: a food whose largest single
# pesticide DRI is over the line gets the verdict.
VERDICT_BANDS = ((0.1, "organic"), (0.01, "some"))

# The organic rule (7 CFR 205.671): a prohibited residue over 5% of the EPA
# tolerance means the product can't be sold as organic.
ORGANIC_TOLERANCE_SHARE = 0.05


def _norm(name):
    """How a pesticide name is matched across USDA and EPA: lowercase, no
    punctuation or spacing differences ("2,4-D" = "2, 4 - D")."""
    return re.sub(r"[^a-z0-9]", "", str(name or "").lower())


def verdict(max_dri, no_dose_count):
    """The bands, applied. A found pesticide with no safe dose makes it an open
    question unless another pesticide already puts it over the top line."""
    top_line, top_verdict = VERDICT_BANDS[0]
    if max_dri > top_line:
        return top_verdict
    if no_dose_count:
        return "open"
    for line, band in VERDICT_BANDS[1:]:
        if max_dri > line:
            return band
    return "conventional"


def pesticide_terms(conn, codes, years, claim):
    """Per pesticide tested: samples tested and detected, mean and max residue (ppb).

    `codes` is [(commodity, commtype)] with commtype '' for any form. The mean
    is over every sample tested for that pesticide, a non-detect counting as
    zero; a sample with two results for one pesticide counts its highest once.
    Returns (sample_count, [term, ...]).
    """
    where, params = [], []
    for commodity, commtype in codes:
        if commtype:
            where.append("(s.commod = ? AND s.commtype = ?)")
            params += [commodity, commtype]
        else:
            where.append("s.commod = ?")
            params.append(commodity)
    sample_filter = (f"({' OR '.join(where)}) AND s.year IN ({','.join('?' * len(years))})")
    params += list(years)
    if claim == "organic":
        sample_filter += " AND s.claim = 'PO'"
    elif claim == "conventional":
        sample_filter += " AND IFNULL(s.claim, '') != 'PO'"
    sample_count = conn.execute(f"SELECT COUNT(*) FROM pdp_samples s WHERE {sample_filter}",
                                params).fetchone()[0]
    rows = conn.execute(
        "SELECT per_sample.pestcode, COUNT(*), SUM(per_sample.ppb IS NOT NULL),"
        "       SUM(IFNULL(per_sample.ppb, 0)) * 1.0 / COUNT(*), MAX(per_sample.ppb)"
        " FROM (SELECT r.year, r.sample_pk, r.pestcode, MAX(r.concen_ppb) AS ppb"
        "       FROM pdp_results r JOIN pdp_samples s"
        "         ON s.year = r.year AND s.sample_pk = r.sample_pk"
        f"      WHERE {sample_filter}"
        "       GROUP BY r.year, r.sample_pk, r.pestcode) AS per_sample"
        " GROUP BY per_sample.pestcode", params).fetchall()
    latest = max(years)
    names = dict(conn.execute("SELECT pestcode, name FROM pdp_pesticides WHERE year = ?", (latest,)))
    # A pesticide only named in an older year's table still gets its name.
    for code, name in conn.execute("SELECT pestcode, name FROM pdp_pesticides ORDER BY year DESC"):
        names.setdefault(code, name)
    terms = [{"pesticide_code": code, "pesticide": names.get(code, f"PDP pesticide {code}"),
              "samples_tested": tested, "samples_detected": detected or 0,
              "mean_ppb": mean or 0.0, "max_ppb": top}
             for code, tested, detected, mean, top in rows]
    return sample_count, terms


def samples_over_organic_line(conn, codes, years, claim):
    """How many samples had any residue over 5% of its EPA tolerance, and of how many.

    A pesticide with no numeric tolerance (NT, exempt) can't be measured
    against the line and is left out — and counted, so the page can say so.
    """
    commodities = sorted({commodity for commodity, _ in codes})
    marks = ",".join("?" * len(commodities))
    year_marks = ",".join("?" * len(years))
    claim_filter = {"organic": " AND s.claim = 'PO'",
                    "conventional": " AND IFNULL(s.claim, '') != 'PO'"}.get(claim, "")
    over, unmeasurable = conn.execute(
        "SELECT COUNT(DISTINCT CASE WHEN t.epatol GLOB '[0-9.]*' AND r.concen_ppb >"
        f"   CAST(t.epatol AS REAL) * (CASE t.tolunit WHEN 'B' THEN 1 ELSE 1000 END) * {ORGANIC_TOLERANCE_SHARE}"
        "   THEN r.year || '-' || r.sample_pk END),"
        " SUM(t.epatol IS NULL OR NOT t.epatol GLOB '[0-9.]*')"
        " FROM pdp_results r JOIN pdp_samples s ON s.year = r.year AND s.sample_pk = r.sample_pk"
        " LEFT JOIN pdp_tolerances t ON t.year = r.year AND t.pestcode = r.pestcode"
        "   AND t.commod = r.commod"
        f" WHERE r.concen_ppb IS NOT NULL AND s.commod IN ({marks}) AND s.year IN ({year_marks})"
        + claim_filter, (*commodities, *years)).fetchone()
    return {"samples_over": over or 0, "detections_without_tolerance": unmeasurable or 0,
            "share_of_tolerance": ORGANIC_TOLERANCE_SHARE}


def _benchmark(commons_conn, name):
    """EPA's benchmark row for a PDP pesticide name, matched loosely, or None."""
    wanted = _norm(name)
    # PDP sometimes adds a qualifier EPA doesn't ("Thiabendazole 5-hydroxy"
    # stays unmatched on purpose; "Pyrethrins (total)" matches "Pyrethrins").
    bare = re.sub(r"\(.*?\)", "", name).strip()
    plain = _norm(bare)
    # PDP's own word orders: "Permethrin Total" is permethrin, and
    # "Cyhalothrin, Lambda" is EPA's "lambda-Cyhalothrin".
    untotalled = _norm(re.sub(r"\s+total$", "", bare, flags=re.IGNORECASE))
    parts = [part.strip() for part in bare.split(",")]
    swapped = _norm(parts[1] + parts[0]) if len(parts) == 2 else plain
    candidates = {wanted, plain, untotalled, swapped}
    # EPA sometimes adds the forms its figure covers ("Thiabendazole + salt",
    # "2,4-D + salts & esters"); the part before the "+" is the pesticide.
    # A metabolite ("Clethodim sulfoxide") is never matched to its parent:
    # whether the parent's dose covers it is a judgment, recorded as a fact.
    for row in commons_conn.execute(
            "SELECT name, cas, acute_dose, chronic_dose, cancer_slope, memo_url FROM epa_benchmarks"):
        epa_name = re.sub(r"\s*\+.*$", "", row[0])
        if {_norm(row[0]), _norm(epa_name)} & candidates:
            return dict(zip(("name", "cas", "acute_dose", "chronic_dose", "cancer_slope",
                             "memo_url"), row))
    return None


def _map_entry(term, benchmark):
    """What putting one found pesticide on the hazard map means: its name, any
    other name EPA gives it, and the facts the loaders read about it."""
    facts = [{"fact": "pdp_code", "value": term["pesticide_code"], "url": PDP_URL}]
    aliases = []
    if benchmark:
        if _norm(benchmark["name"]) != _norm(term["pesticide"]):
            aliases.append(benchmark["name"])
        if benchmark["cas"]:
            facts.append({"fact": "cas", "value": benchmark["cas"], "url": EPA_URL})
        if benchmark["chronic_dose"]:
            facts.append({
                "fact": "chronic_dose", "value": f"{benchmark['chronic_dose']:g} mg/kg/day",
                "url": EPA_URL, "amount": benchmark["chronic_dose"], "unit": "mg/kg/day",
                "basis": "chronic PAD or RfD",
                "note": f"EPA reference document: {benchmark['memo_url']}" if benchmark["memo_url"] else None})
        if benchmark["acute_dose"]:
            facts.append({
                "fact": "acute_dose", "value": f"{benchmark['acute_dose']:g} mg/kg/day",
                "url": EPA_URL, "amount": benchmark["acute_dose"], "unit": "mg/kg/day",
                "basis": "acute PAD or RfD"})
        if benchmark["cancer_slope"]:
            facts.append({
                "fact": "cancer_slope", "value": f"{benchmark['cancer_slope']:g} per mg/kg/day",
                "url": EPA_URL, "amount": benchmark["cancer_slope"], "unit": "(mg/kg/day)^-1",
                "basis": "Q1*"})
    return {"name": term["pesticide"], "parent": "Pesticide", "aliases": aliases, "facts": facts}


def _ensure_pesticide_branch():
    """The 'Pesticide' kind every found pesticide goes under — planted if missing."""
    conn = sqlstore.open_db()
    try:
        present = conn.execute("SELECT 1 FROM hazard_names WHERE name = 'pesticide'").fetchone()
    finally:
        conn.close()
    if not present:
        hazardstore.seed_starter_map()
        try:
            hazardstore.add_hazard("Pesticide")
        except ValueError:
            pass  # the starter map just planted it


def score(food_id, codes, years, claim, commons_root=None):
    """Compute and save one score. Returns the saved score (exposurestore.score_detail),
    or None when there are no samples."""
    serving_grams = [RACC_GRAMS.get(commodity) for commodity, _ in codes]
    if None in serving_grams:
        raise ValueError(f"no FDA reference serving on file for {codes}; add it to RACC_GRAMS")
    serving_kg = max(serving_grams) * SERVING_SHARE / 1000
    with commonsdb.session(commons_root) as commons_conn:
        sample_count, terms = pesticide_terms(commons_conn, codes, years, claim)
        if not sample_count:
            return None
        line = samples_over_organic_line(commons_conn, codes, years, claim)
        benchmarks = {term["pesticide_code"]: _benchmark(commons_conn, term["pesticide"])
                      for term in terms if term["samples_detected"]}
    # Every found pesticide goes on the map (one write for all of them); its
    # dose is then read back from the facts, so her own figure or a dispute
    # is what the score uses.
    for term in terms:
        term.update(hazard_id=None, dose=None, dose_fact_id=None, dri=None)
    found = [term for term in terms if term["samples_detected"]]
    if found:
        _ensure_pesticide_branch()
        ids = exposurestore.put_found_contaminants(
            [_map_entry(term, benchmarks[term["pesticide_code"]]) for term in found])
        for term in found:
            term["hazard_id"] = ids[term["pesticide"]]
        doses = exposurestore.chronic_doses([term["hazard_id"] for term in found])
        for term in found:
            term["dose"], term["dose_fact_id"] = doses[term["hazard_id"]]
            if term["dose"]:
                term["dri"] = term["mean_ppb"] / 1000 * serving_kg / BODY_KG / term["dose"]
    scored = [term["dri"] for term in found if term["dri"] is not None]
    no_dose = sum(1 for term in found if term["dri"] is None)
    max_dri = max(scored, default=0.0)
    summary = {
        "sample_count": sample_count, "pesticide_count": len(terms), "detected_count": len(found),
        "no_dose_count": no_dose, "total_dri": sum(scored), "max_dri": max_dri,
        "verdict": verdict(max_dri, no_dose),
        "reference": {"body_kg": BODY_KG, "serving_g": round(serving_kg * 1000, 1),
                      "racc_g": max(serving_grams), "serving_share": round(SERVING_SHARE, 4),
                      "codes": [list(code) for code in codes], "organic_line": line,
                      "bands": [list(band) for band in VERDICT_BANDS]},
    }
    years_text = ",".join(str(year) for year in sorted(years))
    score_id = exposurestore.save_score(food_id, METHOD, claim, years_text, summary, terms)
    return exposurestore.score_detail(score_id)


def years_loaded(codes, commons_root=None):
    """Every year commons.db has samples for these commodities, oldest first."""
    commodities = sorted({commodity for commodity, _ in codes})
    with commonsdb.session(commons_root) as conn:
        rows = conn.execute(
            f"SELECT DISTINCT year FROM pdp_samples WHERE commod IN ({','.join('?' * len(commodities))})"
            " ORDER BY year", commodities).fetchall()
    return [row[0] for row in rows]


def score_food(food, years_text=None, commons_root=None):
    """Score one food: organic and conventional, for the latest year and for
    all years combined. Yields one line of report per score."""
    codes_by_food = exposurestore.pdp_codes(food)
    if not codes_by_food:
        raise ValueError(f"{food!r} has no PDP code yet — set one with pdp-code")
    (food_id, codes), = codes_by_food.items()
    if years_text:
        sets = [sorted(int(year) for year in years_text.split(","))]
    else:
        loaded = years_loaded(codes, commons_root)
        if not loaded:
            raise ValueError(f"no PDP samples loaded for {codes}; run pull-pdp first")
        sets = [[loaded[-1]]] + ([loaded] if len(loaded) > 1 else [])
    for years in sets:
        for claim in ("conventional", "organic"):
            result = score(food_id, codes, years, claim, commons_root)
            if result is None:
                yield f"{years} {claim}: no samples"
                continue
            top = next((term for term in result["terms"] if term["dri"] is not None), None)
            yield (f"{result['years']} {claim}: n={result['sample_count']} "
                   f"found {result['detected_count']}/{result['pesticide_count']} "
                   f"max DRI {result['max_dri']:.4f}"
                   + (f" ({top['pesticide']})" if top else "")
                   + f", no dose for {result['no_dose_count']} → {result['verdict']}")
