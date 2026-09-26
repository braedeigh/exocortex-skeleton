"""Research tables (hazardstore.py): the hazard map, measurements, verdicts,
and the grids built from them.

What can silently break here, worst first: a number getting in with no study
behind it; an edit to something she reviewed going unnoticed (the review must
reset and the old version must be kept); a grid dropping or doubling a number
(a hazard with two parents must show under both, once each); a verdict still
looking solid after a number under it was disputed; and the backup — this is
her record, so an emptied database must come back from research_tables.json.
"""
import pytest

import foodstore
import hazardstore
import sqlstore
import store

SOURCE = "2026-09-24.1000"
CLAIM = "2026-09-24.1000-2"


def rows(sql, params=()):
    conn = sqlstore.open_db()
    try:
        return conn.execute(sql, params).fetchall()
    finally:
        conn.close()


def _entry(eid, kind, text, **over):
    entry = {"id": eid, "kind": kind, "text": text, "topics": ["contaminants"], "url": "",
             "verdict": "", "status": "", "reply_to": None, "created": "2026-09-24 10:00"}
    entry.update(over)
    return entry


@pytest.fixture
def world(data_dir):
    """Two foods, the starter hazard map plus two pesticides (DDE with two
    parents), one source and one claim."""
    store.write("research.json", {
        "topics": [{"id": "contaminants", "name": "Contaminants", "status": "active",
                    "created": "2026-09-24 10:00", "fronts": []}],
        "entries": [
            _entry(SOURCE, "source", "USDA PDP 2023 summary", url="https://example.org/pdp"),
            _entry(CLAIM, "claim", "Potatoes: 92.7% had residues", author="llm"),
        ],
        "sessions": [],
    })
    foodstore.add_food("potatoes")
    foodstore.add_food("kale")
    hazardstore.seed_starter_map()
    hazardstore.add_hazard("Chlorpropham", parents=["Plant growth regulator"])
    hazardstore.add_hazard("DDE", parents=["Pesticide", "Persistent organic pollutant"])
    return data_dir


def record(food="potatoes", hazard="Lead", measure="concentration", amount=12, unit="ppb", **kw):
    kw.setdefault("source_id", SOURCE)
    return hazardstore.record_measure(food, hazard, measure, amount, unit, **kw)


def table(name, **kw):
    kw.setdefault("kind", "measures")
    return hazardstore.add_table(name, **kw)


def cell_ids(view, food, column):
    row = next(r for r in view["rows"] if r["food"] == food)
    return [entry["id"] for entry in row["cells"].get(column, [])]


# --- the gate: nothing without a source --------------------------------------------

def test_agent_number_without_a_source_is_refused(world):
    with pytest.raises(ValueError, match="source"):
        hazardstore.record_measure("potatoes", "Lead", "concentration", 12, "ppb", author="llm")
    assert rows("SELECT COUNT(*) FROM hazard_measures") == [(0,)]


def test_owner_number_may_stand_without_a_source(world):
    measure_id, outcome = hazardstore.record_measure(
        "potatoes", "Lead", "concentration", 12, "ppb", author="owner")
    assert outcome == "created" and measure_id


def test_source_must_be_a_source_entry(world):
    with pytest.raises(ValueError, match="no source entry"):
        record(source_id=CLAIM)


# --- units: one unit per kind of number ------------------------------------------

def test_concentration_is_stored_in_ppb_with_the_printed_figure_kept(world):
    measure_id, _ = record(amount=0.012, unit="mg/kg")
    assert rows("SELECT amount, unit, as_reported FROM hazard_measures WHERE id = ?",
                (measure_id,)) == [(12.0, "ppb", "0.012 mg/kg")]


def test_detection_rate_must_be_a_percent(world):
    with pytest.raises(ValueError, match="percent"):
        record(hazard="Pesticide", measure="detection_rate", amount=0.9, unit="ratio")


# --- edits are never silent ---------------------------------------------------------

def test_recording_the_same_figure_again_amends_instead_of_doubling(world):
    first, _ = record(amount=12, year=2019)
    again, outcome = record(amount=14, year=2019)
    assert again == first and outcome == "amended"
    assert rows("SELECT COUNT(*) FROM hazard_measures") == [(1,)]


def test_changing_a_confirmed_number_resets_review_and_keeps_the_old_one(world):
    measure_id, _ = record(amount=12, year=2019)
    hazardstore.review_measure(measure_id, "confirmed")
    record(amount=14, year=2019)
    detail = hazardstore.measure_detail(measure_id)
    assert detail["review"] == "unreviewed" and detail["amount"] == 14
    assert detail["history"][0]["snapshot"]["amount"] == 12
    assert detail["history"][0]["snapshot"]["review"] == "confirmed"


def test_recording_an_identical_figure_leaves_review_alone(world):
    measure_id, _ = record(amount=12, year=2019)
    hazardstore.review_measure(measure_id, "confirmed")
    _, outcome = record(amount=12, year=2019)
    assert outcome == "unchanged"
    assert hazardstore.measure_detail(measure_id)["review"] == "confirmed"


def test_a_different_year_is_a_second_figure(world):
    record(year=2019)
    record(year=2021)
    assert rows("SELECT COUNT(*) FROM hazard_measures") == [(2,)]


# --- the hazard map -----------------------------------------------------------------

def test_a_hazard_cannot_become_a_kind_of_its_own_descendant(world):
    with pytest.raises(ValueError, match="loop"):
        hazardstore.update_hazard("Pesticide", parents=["Chlorpropham"])


def test_duplicate_hazard_name_is_refused(world):
    with pytest.raises(ValueError, match="already on the map"):
        hazardstore.add_hazard("lead", parents=["Heavy metal"])


def test_other_names_resolve_to_the_hazard(world):
    record(hazard="total arsenic")
    assert rows("SELECT h.name FROM hazard_measures m JOIN hazards h ON h.id = m.hazard_id") == [("Arsenic",)]


def test_a_used_hazard_cannot_be_deleted(world):
    record(hazard="Lead")
    with pytest.raises(ValueError, match="use this hazard"):
        hazardstore.delete_hazard("Lead")


def test_starter_map_does_nothing_on_a_map_that_has_hazards(world):
    assert hazardstore.seed_starter_map() == 0


# --- grids ------------------------------------------------------------------------

def test_a_family_column_rolls_up_its_members(world):
    measure_id, _ = record(hazard="Chlorpropham", measure="detection_rate", amount=89.1, unit="%")
    view = hazardstore.table_view(table("Contaminants", hazard="Contaminant"))
    assert cell_ids(view, "potatoes", str(rows("SELECT id FROM hazards WHERE name='Pesticide'")[0][0])) == [measure_id]


def test_a_hazard_with_two_parents_shows_under_both(world):
    measure_id, _ = record(hazard="DDE", measure="detection_rate", amount=35.4, unit="%")
    view = hazardstore.table_view(table("Contaminants", hazard="Contaminant"))
    filled = [column for column, entries in view["rows"][0]["cells"].items() if measure_id in
              [entry["id"] for entry in entries]]
    assert len(filled) == 2
    assert view["counts"]["unreviewed"] == 1


def test_numbers_on_the_branch_itself_get_an_any_column(world):
    measure_id, _ = record(hazard="Pesticide", measure="detection_rate", amount=92.7, unit="%")
    view = hazardstore.table_view(table("Pesticides", hazard="Pesticide"))
    assert view["columns"][0]["id"] == "any"
    assert cell_ids(view, "potatoes", "any") == [measure_id]


def test_a_table_shows_only_its_kind_of_number(world):
    record(hazard="Lead", measure="concentration", amount=12, unit="ppb")
    view = hazardstore.table_view(table("Metals found", hazard="Heavy metal", measure="detection_rate"))
    assert view["rows"] == []


def test_foods_without_numbers_are_counted_not_shown(world):
    record(food="potatoes")
    view = hazardstore.table_view(table("Metals", hazard="Heavy metal"))
    assert [row["food"] for row in view["rows"]] == ["potatoes"]
    assert view["empty_foods"] == 1
    everything = hazardstore.table_view(view["table"]["id"], all_foods=True)
    assert [row["food"] for row in everything["rows"]] == ["kale", "potatoes"]


# --- verdicts ---------------------------------------------------------------------

def test_agent_verdict_needs_a_measurement_under_it(world):
    with pytest.raises(ValueError, match="ground"):
        hazardstore.judge("potatoes", "health", "organic", reasoning="lots of residue")


def test_agent_may_leave_a_verdict_open_without_grounds(world):
    _, outcome = hazardstore.judge("kale", "health", "open", reasoning="no data yet")
    assert outcome == "created"


def test_a_ground_must_be_about_the_same_food(world):
    measure_id, _ = record(food="kale")
    with pytest.raises(ValueError, match="different food"):
        hazardstore.judge("potatoes", "health", "organic", reasoning="r", grounds=[measure_id])


def test_disputing_a_number_shakes_the_verdict_on_it(world):
    measure_id, _ = record(hazard="Chlorpropham", measure="detection_rate", amount=89.1, unit="%")
    judgment_id, _ = hazardstore.judge("potatoes", "health", "organic", reasoning="residues",
                                       grounds=[measure_id])
    hazardstore.review_measure(measure_id, "disputed")
    assert hazardstore.judgment_detail(judgment_id)["shaken"] is True
    view = hazardstore.table_view(table("Organic?", kind="judgments"))
    assert view["rows"][0]["cells"]["health"][0]["shaken"] is True


def test_one_verdict_per_food_lens_and_hazard(world):
    measure_id, _ = record()
    first, _ = hazardstore.judge("potatoes", "health", "organic", reasoning="a", grounds=[measure_id])
    again, outcome = hazardstore.judge("potatoes", "health", "conventional", reasoning="b",
                                       grounds=[measure_id])
    about_lead, _ = hazardstore.judge("potatoes", "health", "conventional", hazard="Lead",
                                      reasoning="organic does not change soil lead",
                                      grounds=[measure_id])
    assert again == first and outcome == "amended" and about_lead != first
    assert hazardstore.judgment_detail(first)["history"][0]["snapshot"]["verdict"] == "organic"


def test_lens_must_be_known(world):
    with pytest.raises(ValueError, match="lens"):
        hazardstore.judge("potatoes", "taste", "open", reasoning="r")


# --- food merges carry the numbers --------------------------------------------------

def test_merging_foods_moves_their_numbers(world):
    foodstore.add_food("potato")
    record(food="potato")
    foodstore.merge("potatoes", "potato")
    assert rows("SELECT f.name FROM hazard_measures m JOIN foods f ON f.id = m.food_id") == [("potatoes",)]


# --- backup --------------------------------------------------------------------------

def test_an_emptied_record_comes_back_from_the_backup(world):
    measure_id, _ = record()
    hazardstore.review_measure(measure_id, "confirmed")
    conn = sqlstore.open_db()
    for name in ("hazard_measures", "hazard_parents", "hazard_names", "hazards"):
        conn.execute(f"DELETE FROM {name}")
    conn.close()
    detail = hazardstore.measure_detail(measure_id)
    assert detail["review"] == "confirmed" and detail["hazard"] == "Lead"


# --- bringing claims' numbers in ----------------------------------------------------

def test_claim_values_become_measurements_tied_to_claim_and_source(world):
    import researchstore
    researchstore.link_claim_source(CLAIM, SOURCE)
    researchstore.set_claim_value(CLAIM, subject="Potatoes", measure="pesticide residue detected (1+)",
                                  amount=92.7, unit="% of samples (PDP 2023)", year=2023)
    report = hazardstore.import_claim_values()
    assert report["skipped"] == [] and len(report["imported"]) == 1
    detail = hazardstore.measure_detail(report["imported"][0]["measure_id"])
    assert (detail["hazard"], detail["measure"], detail["source_id"], detail["claim_id"]) == \
        ("Pesticide", "detection_rate", SOURCE, CLAIM)
    assert hazardstore.import_claim_values()["imported"] == []


def test_claim_values_that_do_not_fit_are_skipped_with_a_reason(world):
    import researchstore
    researchstore.set_claim_value(CLAIM, subject="potatoes", measure="residue frequency ratio",
                                  amount=3.1, unit="ratio")
    report = hazardstore.import_claim_values()
    assert report["imported"] == [] and "hazard" in report["skipped"][0]["reason"]
