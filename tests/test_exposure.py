"""The exposure calculation (exposure.py) and the loaders (reference_loaders.py).

What can silently break here, worst first: the arithmetic (a non-detect left
out of the mean instead of counted as zero inflates every score; a ppm/ppb
slip is a factor of 1000); a verdict band applied the wrong way round; organic
and conventional samples mixed; a pesticide with no safe dose quietly scored
as zero instead of making the answer an open question; her dispute of a dose
being ignored; the loader keeping rows for the wrong food or doubling them on
a re-run; and EPA's columns being read out of the wrong places.
"""
import zipfile

import pytest

import commonsdb
import exposure
import exposurestore
import foodstore
import hazardstore
import reference_loaders
import sqlstore

EPA_PAGE = """<table><tr><th>Common Name and Reference Document</th><th>CAS Number</th>
<th>Acute or One Day PAD (RfD) (mg/kg/day)</th><th>Acute HHBPs (ppb)</th>
<th>Chronic or Lifetime PAD (rfD) (mg/kg/day)</th><th>Chronic HHBPs (ppb)</th>
<th>Cancer Quantification (Q1) Values (CSF) (mg/kg/per day) -1</th></tr>
<tr><td><a href="https://example.org/memo">Chlorpropham</a></td><td>101-21-3</td><td>--</td>
<td>--</td><td>0.005</td><td>30</td><td>-</td></tr>
<tr><td>Imidacloprid</td><td>138261-41-3</td><td>0.08</td><td>500</td><td>0.08</td><td>500</td>
<td>-</td></tr>
<tr><td>lambda-Cyhalothrin</td><td>91465-08-6</td><td>0.005</td><td>30</td><td>0.001</td><td>6</td>
<td>-</td></tr>
<tr><td>Thiabendazole + salt</td><td>148-79-8</td><td>0.5</td><td>3000</td><td>0.1</td><td>600</td>
<td>-</td></tr></table>"""


@pytest.fixture
def commons_root(tmp_path, monkeypatch):
    root = tmp_path / "commons"
    monkeypatch.setenv("EXOCORTEX_COMMONS_DIR", str(root))
    return root


def _sample(conn, pk, claim="NC", commod="PO", year=2023):
    conn.execute("INSERT INTO pdp_samples (year, sample_pk, commod, commtype, claim)"
                 " VALUES (?,?,?,'FR',?)", (year, pk, commod, claim))


def _result(conn, pk, pestcode, ppb, commod="PO", year=2023):
    conn.execute("INSERT INTO pdp_results (year, sample_pk, commod, pestcode, concen_ppb)"
                 " VALUES (?,?,?,?,?)", (year, pk, commod, pestcode, ppb))


@pytest.fixture
def potatoes(data_dir, commons_root):
    """Four conventional potato samples and one organic; chlorpropham found in
    two conventional ones (3000 and 1000 ppb), imidacloprid tested but never
    found, and a third pesticide found once with no EPA dose."""
    foodstore.add_food("potatoes")
    hazardstore.seed_starter_map()
    food_id = exposurestore.set_pdp_codes("potatoes", [("PO", "")])
    with commonsdb.session(commons_root) as conn:
        conn.executemany("INSERT INTO pdp_pesticides VALUES (2023, ?, ?, '')",
                         [("036", "Chlorpropham"), ("150", "Imidacloprid"), ("900", "Mystery")])
        conn.execute("INSERT INTO pdp_tolerances VALUES (2023, '036', 'PO', '30', 'M', '', '')")
        for pk in (1, 2, 3, 4):
            _sample(conn, pk)
            _result(conn, pk, "150", None)
            _result(conn, pk, "036", {1: 3000.0, 2: 1000.0}.get(pk))
            _result(conn, pk, "900", 5.0 if pk == 1 else None)
        _sample(conn, 5, claim="PO")
        _result(conn, 5, "036", None)
    page = commons_root / "epa.html"
    page.write_text(EPA_PAGE)
    with commonsdb.session(commons_root) as conn:
        reference_loaders.load_benchmarks(conn, page)
    return food_id


def _term(result, name):
    return next(term for term in result["terms"] if term["pesticide"] == name)


def test_mean_counts_every_non_detect_as_zero(potatoes):
    result = exposure.score(potatoes, [("PO", "")], [2023], "conventional")
    assert _term(result, "Chlorpropham")["mean_ppb"] == pytest.approx(1000.0)


def test_dri_is_serving_over_body_weight_over_safe_dose(potatoes):
    result = exposure.score(potatoes, [("PO", "")], [2023], "conventional")
    # 1 mg/kg × (85 g × 2/3) ÷ 16 kg ÷ 0.005 mg/kg/day
    expected = 1.0 * (0.085 * 2 / 3) / 16 / 0.005
    assert _term(result, "Chlorpropham")["dri"] == pytest.approx(expected)


def test_over_the_top_band_is_buy_organic_even_with_a_missing_dose(potatoes):
    result = exposure.score(potatoes, [("PO", "")], [2023], "conventional")
    assert (result["verdict"], result["no_dose_count"]) == ("organic", 1)


def test_organic_samples_are_scored_apart(potatoes):
    result = exposure.score(potatoes, [("PO", "")], [2023], "organic")
    assert (result["sample_count"], result["detected_count"], result["verdict"]) == (1, 0, "conventional")


def test_found_pesticide_without_a_dose_makes_it_an_open_question():
    assert exposure.verdict(0.02, 1) == "open" and exposure.verdict(0.02, 0) == "some" \
        and exposure.verdict(0.005, 0) == "conventional" and exposure.verdict(0.2, 0) == "organic"


def test_only_found_pesticides_land_on_the_map_with_their_epa_dose(potatoes):
    exposure.score(potatoes, [("PO", "")], [2023], "conventional")
    doses = {fact["fact"]: fact["amount"] for fact in exposurestore.facts_for("Chlorpropham")}
    conn = sqlstore.open_db()
    try:
        never_found = conn.execute("SELECT 1 FROM hazard_names WHERE name = 'imidacloprid'").fetchone()
    finally:
        conn.close()
    assert doses["chronic_dose"] == 0.005 and never_found is None


def test_her_disputed_dose_is_not_used(potatoes):
    exposure.score(potatoes, [("PO", "")], [2023], "conventional")
    dose = next(fact for fact in exposurestore.facts_for("Chlorpropham") if fact["fact"] == "chronic_dose")
    exposurestore.review_fact(dose["id"], "disputed")
    result = exposure.score(potatoes, [("PO", "")], [2023], "conventional")
    assert _term(result, "Chlorpropham")["dri"] is None and result["verdict"] == "open"


def test_organic_line_counts_samples_over_five_percent_of_tolerance(potatoes):
    # Tolerance 30 ppm → the line is 1.5 ppm = 1500 ppb: only the 3000 ppb sample is over.
    result = exposure.score(potatoes, [("PO", "")], [2023], "conventional")
    assert result["reference"]["organic_line"]["samples_over"] == 1


def test_a_food_with_no_reference_serving_is_refused(potatoes):
    with pytest.raises(ValueError, match="reference serving"):
        exposure.score(potatoes, [("ZZ", "")], [2023], "conventional")


def test_epa_columns_are_found_by_their_headers():
    rows = {row["name"]: row for row in reference_loaders.parse_benchmarks(EPA_PAGE)}
    assert (rows["Chlorpropham"]["chronic_dose"], rows["Chlorpropham"]["acute_dose"],
            rows["Chlorpropham"]["memo_url"], rows["Imidacloprid"]["acute_dose"]) == \
        (0.005, None, "https://example.org/memo", 0.08)


def _pdp_zip(path):
    samples = "1|CA|23|10|16|0404|PO| |Russet|1||R|FR|NC|||CA|\n" \
              "2|CA|23|10|16|0405|PO| |Russet|1||R|FR|PO|||CA|\n" \
              "3|CA|23|10|16|0406|AP| |Gala|1||R|FR|NC|||CA|\n"
    results = "1|PO|FR|WA1|036|C|2.5|0.005|M|||||O|805|64\n" \
              "1|PO|FR|WA1|150|C||0.005|M|||||ND|805|64\n" \
              "2|PO|FR|WA1|036|C||0.005|M|||||ND|805|64\n" \
              "3|AP|FR|WA1|036|C|9|0.005|M|||||O|805|64\n"
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("PDP23Samples.txt", samples)
        archive.writestr("PDP23Results.txt", results)


def test_loader_keeps_only_the_asked_commodity_and_converts_to_ppb(tmp_path, monkeypatch):
    monkeypatch.setattr(reference_loaders, "_load_reference", lambda conn, archive, year: (0, 0))
    _pdp_zip(tmp_path / "pdp.zip")
    with commonsdb.session(tmp_path) as conn:
        counts = reference_loaders.load_pdp(conn, tmp_path / "pdp.zip", 2023, ["PO"])
        ppb = conn.execute("SELECT concen_ppb FROM pdp_results WHERE concen IS NOT NULL").fetchall()
    assert counts["PO"] == {"samples": 2, "organic": 1, "conventional": 1, "results": 3} and ppb == [(2500.0,)]


def test_loader_rerun_replaces_rather_than_doubles(tmp_path, monkeypatch):
    monkeypatch.setattr(reference_loaders, "_load_reference", lambda conn, archive, year: (0, 0))
    _pdp_zip(tmp_path / "pdp.zip")
    for _ in range(2):
        with commonsdb.session(tmp_path) as conn:
            reference_loaders.load_pdp(conn, tmp_path / "pdp.zip", 2023, ["PO"])
    with commonsdb.session(tmp_path) as conn:
        assert conn.execute("SELECT COUNT(*) FROM pdp_results").fetchone()[0] == 3


def test_epa_name_with_its_salts_still_matches(commons_root):
    page = commons_root / "epa.html"
    page.parent.mkdir(parents=True)
    page.write_text(EPA_PAGE)
    with commonsdb.session(commons_root) as conn:
        reference_loaders.load_benchmarks(conn, page)
        assert exposure._benchmark(conn, "Thiabendazole")["chronic_dose"] == 0.1 and \
            exposure._benchmark(conn, "Thiabendazole 5-hydroxy") is None


def test_pdp_word_orders_still_match(commons_root):
    page = commons_root / "epa.html"
    page.parent.mkdir(parents=True)
    page.write_text(EPA_PAGE)
    with commonsdb.session(commons_root) as conn:
        reference_loaders.load_benchmarks(conn, page)
        assert exposure._benchmark(conn, "Cyhalothrin, Lambda")["chronic_dose"] == 0.001 and \
            exposure._benchmark(conn, "Chlorpropham Total")["chronic_dose"] == 0.005


IRIS_PAGE = """<table><tr><th>ROW</th><th>CHEMICAL NAME</th><th>CASRN</th>
<th>PRINCIPAL CRITICAL DESCRIPTION</th><th>RFD VALUE</th><th>OVERALL CONFIDENCE</th></tr>
<tr><td>1</td><td><a href="/ChemicalLanding/&substance_nmbr=1">Chlorpropham</a></td><td>101-21-3</td>
<td>Liver</td><td>0.2 mg/kg-day</td><td>Low</td></tr>
<tr><td>2</td><td><a href="/ChemicalLanding/&substance_nmbr=2">Mystery</a></td><td>1-1-1</td>
<td>Kidney</td><td>0.002 mg/kg-day</td><td>High</td></tr>
<tr><td>3</td><td>p,p'-Dichlorodiphenyltrichloroethane (DDT)</td><td>50-29-3</td>
<td>Liver lesions</td><td>0.0005 mg/kg-day</td><td>Medium</td></tr>
<tr><td>4</td><td>Chlordane (Technical)</td><td>12789-03-6</td>
<td>Hepatic necrosis</td><td>0.0005 mg/kg-day</td><td>Medium</td></tr>
<tr><td>5</td><td>Oddity</td><td>2-2-2</td><td>x</td><td>3 ppm</td><td>Low</td></tr></table>"""


def _load_iris(commons_root):
    page = commons_root / "iris.html"
    page.parent.mkdir(parents=True, exist_ok=True)
    page.write_text(IRIS_PAGE)
    with commonsdb.session(commons_root) as conn:
        reference_loaders.load_iris(conn, page)


def test_iris_columns_are_found_by_their_headers_and_odd_units_skipped():
    rows = {row["name"]: row for row in reference_loaders.parse_iris_rfd(IRIS_PAGE)}
    assert (rows["Mystery"]["rfd"], rows["Mystery"]["landing_url"], "Oddity" in rows) == \
        (0.002, "https://iris.epa.gov/ChemicalLanding/&substance_nmbr=2", False)


def test_iris_isomer_matches_but_a_mixture_does_not_match_one_isomer(commons_root):
    _load_iris(commons_root)
    with commonsdb.session(commons_root) as conn:
        assert exposure._iris(conn, "DDT p,p'")["rfd"] == 0.0005 and \
            exposure._iris(conn, "DDT o,p'") is None and exposure._iris(conn, "Chlordane cis") is None


def test_iris_dose_fills_in_only_where_epas_table_has_none(potatoes, commons_root):
    _load_iris(commons_root)
    result = exposure.score(potatoes, [("PO", "")], [2023], "conventional")
    mystery = next(fact for fact in exposurestore.facts_for("Mystery") if fact["fact"] == "chronic_dose")
    assert (_term(result, "Chlorpropham")["dose"], _term(result, "Mystery")["dose"],
            mystery["basis"], result["no_dose_count"]) == (0.005, 0.002, "RfD (IRIS)", 0)


def test_a_pdp_analyte_named_two_ways_matches_either_name(commons_root):
    _load_iris(commons_root)
    with commonsdb.session(commons_root) as conn:
        assert exposure._iris(conn, "Chlorpropham/Other")["rfd"] == 0.2
