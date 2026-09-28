"""Verifiable exposure storage (exposurestore.py, rung 36) and commons.db.

What can silently break here, worst first: an unsourced fact getting in from
an agent or a loader; a loader re-run quietly overwriting a value she already
reviewed (a changed value must go back to unreviewed, the same value must
keep her review); a disputed safe dose still being used to score; a re-score
piling up beside the old one instead of replacing it; a pull being forgotten
by the ledger; and the backup — facts and PDP codes are her record, so an
emptied database must bring them back.
"""
import pytest

import commonsdb
import exposurestore
import foodstore
import hazardstore
import sqlstore
import store

SOURCE = "2026-09-27.1000"
EPA_URL = "https://www.epa.gov/sdwa/2021-human-health-benchmarks-pesticides"


def rows(sql, params=()):
    conn = sqlstore.open_db()
    try:
        return conn.execute(sql, params).fetchall()
    finally:
        conn.close()


@pytest.fixture
def world(data_dir):
    store.write("research.json", {
        "topics": [{"id": "contaminants", "name": "Contaminants", "status": "active",
                    "created": "2026-09-27 10:00", "fronts": []}],
        "entries": [{"id": SOURCE, "kind": "source", "text": "EPA memo", "topics": ["contaminants"],
                     "url": "https://example.org/memo", "verdict": "", "status": "",
                     "reply_to": None, "created": "2026-09-27 10:00"}],
        "sessions": [],
    })
    foodstore.add_food("potatoes")
    foodstore.add_food("kale")
    hazardstore.seed_starter_map()
    hazardstore.add_hazard("Chlorpropham", parents=["Plant growth regulator"])
    return data_dir


def test_agent_fact_without_source_is_refused(world):
    with pytest.raises(ValueError, match="source_id or a url"):
        exposurestore.add_fact("Chlorpropham", "cas", "101-21-3")


def test_unknown_fact_kind_is_refused(world):
    with pytest.raises(ValueError, match="unknown fact"):
        exposurestore.add_fact("Chlorpropham", "colour", "white", url=EPA_URL)


def test_agent_fact_arrives_unreviewed_and_owner_fact_confirmed(world):
    exposurestore.add_fact("Chlorpropham", "cas", "101-21-3", source_id=SOURCE)
    exposurestore.add_fact("Chlorpropham", "use", "plant growth regulator", author="owner")
    reviews = {fact["fact"]: fact["review"] for fact in exposurestore.facts_for("Chlorpropham")}
    assert reviews == {"cas": "unreviewed", "use": "confirmed"}


def test_loader_rerun_with_same_value_keeps_her_review(world):
    fact_id, status = exposurestore.put_code_fact(
        "Chlorpropham", "chronic_dose", "0.005 mg/kg/day", url=EPA_URL,
        amount=0.005, unit="mg/kg/day", basis="cRfD")
    exposurestore.review_fact(fact_id, "confirmed")
    again = exposurestore.put_code_fact(
        "Chlorpropham", "chronic_dose", "0.005 mg/kg/day", url=EPA_URL,
        amount=0.005, unit="mg/kg/day", basis="cRfD")
    assert again == (fact_id, "same") and \
        rows("SELECT review FROM hazard_facts WHERE id = ?", (fact_id,))[0][0] == "confirmed"


def test_loader_rerun_with_new_value_goes_back_to_unreviewed(world):
    fact_id, _ = exposurestore.put_code_fact(
        "Chlorpropham", "chronic_dose", "0.005", url=EPA_URL, amount=0.005)
    exposurestore.review_fact(fact_id, "confirmed")
    _, status = exposurestore.put_code_fact(
        "Chlorpropham", "chronic_dose", "0.05", url=EPA_URL, amount=0.05)
    assert status == "changed" and \
        rows("SELECT review, amount FROM hazard_facts WHERE id = ?", (fact_id,))[0] == ("unreviewed", 0.05)


def test_disputed_dose_is_never_used_to_score(world):
    fact_id, _ = exposurestore.put_code_fact(
        "Chlorpropham", "chronic_dose", "0.005", url=EPA_URL, amount=0.005)
    exposurestore.review_fact(fact_id, "disputed")
    conn = sqlstore.open_db()
    try:
        hazard_id = hazardstore._hazard_id(conn, "Chlorpropham")
        assert exposurestore.chronic_dose(conn, hazard_id) == (None, None)
    finally:
        conn.close()


def test_owner_dose_wins_over_loader_dose(world):
    exposurestore.put_code_fact("Chlorpropham", "chronic_dose", "0.005", url=EPA_URL, amount=0.005)
    mine = exposurestore.add_fact("Chlorpropham", "chronic_dose", "0.01", amount=0.01, author="owner")
    conn = sqlstore.open_db()
    try:
        hazard_id = hazardstore._hazard_id(conn, "Chlorpropham")
        assert exposurestore.chronic_dose(conn, hazard_id) == (0.01, mine)
    finally:
        conn.close()


def test_pdp_codes_are_replaced_not_added(world):
    exposurestore.set_pdp_codes("potatoes", [("PO", "FR"), ("po", "fr")])
    food_id = exposurestore.set_pdp_codes("potatoes", [("po", "")])
    assert exposurestore.pdp_codes("potatoes") == {food_id: [("PO", "")]}


def test_pdp_codes_move_when_foods_merge(world):
    exposurestore.set_pdp_codes("kale", [("KA", "")])
    keep = foodstore.merge("potatoes", "kale")
    assert exposurestore.pdp_codes() == {keep: [("KA", "")]}


def test_ledger_remembers_a_pull_and_updates_on_repull(world):
    exposurestore.record_pull("usda-pdp", 2023, "PO", "usda-pdp/2023.zip", "abc", 100, {"samples": 7}, 1)
    exposurestore.record_pull("usda-pdp", 2023, "PO", "usda-pdp/2023.zip", "abc", 120, {"samples": 9}, 1)
    ledger = exposurestore.ledger()
    assert len(ledger) == 1 and ledger[0]["rows"] == 120 and \
        exposurestore.find_pull("usda-pdp", 2023, "PO", 1)["detail"] == {"samples": 9}


def _summary(**over):
    summary = dict(sample_count=10, pesticide_count=2, detected_count=1, no_dose_count=0,
                   total_dri=0.2, max_dri=0.2, verdict="organic", reference={"body_kg": 16})
    summary.update(over)
    return summary


def test_rescore_replaces_the_old_score_and_its_terms(world):
    food_id = rows("SELECT food_id FROM food_names WHERE name = ?", ("potatoes",))[0][0]
    term = dict(pesticide_code="036", pesticide="Chlorpropham", samples_tested=10,
                samples_detected=5, mean_ppb=100.0, max_ppb=900.0, dose=0.005, dri=0.2)
    exposurestore.save_score(food_id, "dri-v1", "conventional", "2023", _summary(), [term])
    new_id = exposurestore.save_score(food_id, "dri-v1", "conventional", "2023",
                                      _summary(total_dri=0.3), [term])
    assert rows("SELECT id FROM exposure_scores") == [(new_id,)] and \
        rows("SELECT COUNT(*) FROM exposure_terms")[0][0] == 1


def test_facts_and_codes_come_back_from_the_backup(world):
    exposurestore.add_fact("Chlorpropham", "cas", "101-21-3", source_id=SOURCE)
    exposurestore.set_pdp_codes("potatoes", [("PO", "")])
    conn = sqlstore.open_db()
    try:
        for table in ("hazard_facts", "food_pdp_codes", "hazard_parents", "hazard_names", "hazards"):
            conn.execute(f"DELETE FROM {table}")
        conn.commit()
    finally:
        conn.close()
    assert [fact["value"] for fact in exposurestore.facts_for("Chlorpropham")] == ["101-21-3"] and \
        rows("SELECT commodity FROM food_pdp_codes") == [("PO",)]


def test_commons_db_lives_beside_the_files(tmp_path):
    with commonsdb.session(tmp_path) as conn:
        conn.execute("INSERT INTO pdp_samples (year, sample_pk, commod, claim) VALUES (2023, 1, 'PO', 'PO')")
    with commonsdb.session(tmp_path) as conn:
        assert (tmp_path / "commons.db").exists() and commonsdb.sample_count(conn, 2023, "PO") == 1
