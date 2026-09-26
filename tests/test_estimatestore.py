"""Claude's buy-organic estimates (estimatestore.py) and the run that makes
them (scripts/estimate_organic.py).

What can silently break here, worst first: an estimate landing on the wrong
food (the model's answers are matched by name, not position); a malformed
answer getting half-saved; the grocery list showing stale verdicts because it
read the lagging grocery_list table instead of kitchen.json; a research
verdict not winning over an estimate; and the backup — an emptied table must
come back from food_estimates.json.
"""
import json

import pytest

import estimatestore
import foodstore
import hazardstore
import sqlstore
import store
from scripts import estimate_organic


def answer(food, verdict="organic", confidence="high", **over):
    """One well-formed model answer."""
    body = {"food": food, "verdict": verdict, "confidence": confidence,
            "summary": f"Why {food} goes {verdict}.", "qualifiers": ["well_tested"],
            "contaminants": [{"name": "Cadmium", "known": "Taken up from soil.",
                              "organic_helps": "no", "evidence": "established"}]}
    body.update(over)
    return body


@pytest.fixture
def kitchen(data_dir):
    """A list with two foods, one household item, and one name no food answers to."""
    store.write("kitchen.json", {"items": [
        {"name": "Kale", "category": "produce"},
        {"name": "Rice", "category": "pantry"},
        {"name": "Foil", "category": "household"},
        {"name": "Dragonfruit", "category": "produce", "checked": True},
    ]})
    foodstore.add_food("kale", category="produce")
    foodstore.add_food("rice", category="pantry")
    foodstore.add_food("foil", kind="household", category="household")
    return data_dir


def items_by_name():
    return {item["name"]: item for item in estimatestore.list_view()["items"]}


# --- the store ------------------------------------------------------------------

def test_saved_estimate_shows_on_its_list_item(kitchen):
    estimatestore.save("kale", answer("Kale"))
    estimate = items_by_name()["Kale"]["estimate"]
    assert (estimate["verdict"], estimate["confidence"], estimate["review"],
            estimate["contaminants"][0]["name"]) == ("organic", "high", "unreviewed", "Cadmium")


def test_list_reads_kitchen_json_not_the_lagging_table(kitchen):
    """An item added after the last rebuild still resolves to its food."""
    store.write("kitchen.json", {"items": [{"name": "RICE", "category": "pantry"}]})
    assert items_by_name()["RICE"]["food_id"] is not None


def test_pending_counts_food_items_without_an_estimate(kitchen):
    """Foil is household, so it is never asked about; Dragonfruit has no food
    yet but is still a food item."""
    estimatestore.save("kale", answer("Kale"))
    assert estimatestore.list_view()["pending"] == 2


def test_research_verdict_is_carried_beside_the_estimate(kitchen):
    hazardstore.judge("rice", "health", "some", reasoning="arsenic", author="owner")
    estimatestore.save("rice", answer("Rice", verdict="conventional"))
    item = items_by_name()["Rice"]
    assert (item["research"]["verdict"], item["estimate"]["verdict"]) == ("some", "conventional")


def test_bad_verdict_is_refused(kitchen):
    with pytest.raises(ValueError):
        estimatestore.save("kale", answer("Kale", verdict="definitely"))


def test_contaminant_without_evidence_word_is_refused(kitchen):
    bad = answer("Kale", contaminants=[{"name": "PFAS", "known": "x", "organic_helps": "no",
                                        "evidence": "vibes"}])
    with pytest.raises(ValueError):
        estimatestore.save("kale", bad)


def test_unknown_qualifier_is_dropped_not_refused(kitchen):
    estimatestore.save("kale", answer("Kale", qualifiers=["well_tested", "made_up"]))
    assert items_by_name()["Kale"]["estimate"]["qualifiers"] == ["well_tested"]


def test_new_estimate_replaces_old_and_resets_review(kitchen):
    first = estimatestore.save("kale", answer("Kale"))
    estimatestore.review(first, "confirmed")
    estimatestore.save("kale", answer("Kale", verdict="some"))
    estimate = items_by_name()["Kale"]["estimate"]
    assert (estimate["verdict"], estimate["review"]) == ("some", "unreviewed")


def test_review_marks_and_unmarks(kitchen):
    estimate_id = estimatestore.save("kale", answer("Kale"))
    estimatestore.review(estimate_id, "disputed")
    assert items_by_name()["Kale"]["estimate"]["review"] == "disputed"


def test_emptied_table_comes_back_from_backup(kitchen):
    estimatestore.save("kale", answer("Kale"))
    conn = sqlstore.open_db()
    conn.execute("DELETE FROM food_estimates")
    conn.commit()
    conn.close()
    assert items_by_name()["Kale"]["estimate"]["verdict"] == "organic"


def test_merge_moves_the_estimate_to_the_kept_food(kitchen):
    foodstore.add_food("curly kale")
    estimatestore.save("curly kale", answer("curly kale"))
    foodstore.merge("kale", "curly kale")
    assert items_by_name()["Kale"]["estimate"]["verdict"] == "organic"


# --- the run ---------------------------------------------------------------------

def test_run_matches_answers_by_name_not_position(kitchen):
    """The model answered out of order; each estimate still lands on its food."""
    def ask(_prompt):
        return json.dumps([answer("Rice", verdict="conventional"), answer("Kale")])
    estimate_organic.estimate([("Kale", "produce"), ("Rice", "pantry")], ask=ask)
    items = items_by_name()
    assert (items["Kale"]["estimate"]["verdict"], items["Rice"]["estimate"]["verdict"]) == \
        ("organic", "conventional")


def test_run_makes_a_food_for_an_unmatched_list_name(kitchen):
    estimate_organic.estimate([("Dragonfruit", "produce")],
                              ask=lambda _p: json.dumps([answer("Dragonfruit")]))
    assert items_by_name()["Dragonfruit"]["estimate"]["verdict"] == "organic"


def test_run_reports_a_malformed_answer_and_saves_the_rest(kitchen):
    def ask(_prompt):
        return "```json\n" + json.dumps([answer("Kale"), answer("Rice", confidence="certain")]) + "\n```"
    saved, failures = estimate_organic.estimate([("Kale", None), ("Rice", None)], ask=ask)
    assert (saved, [f["food"] for f in failures]) == (["Kale"], ["Rice"])


def test_run_reports_every_food_when_the_reply_is_not_json(kitchen):
    saved, failures = estimate_organic.estimate([("Kale", None)], ask=lambda _p: "sorry")
    assert (saved, len(failures)) == ([], 1)


def test_to_estimate_skips_household_and_already_estimated(kitchen):
    estimatestore.save("kale", answer("Kale"))
    assert [name for name, _ in estimatestore.to_estimate()] == ["Rice", "Dragonfruit"]


def test_prompt_names_every_qualifier(kitchen):
    prompt = estimate_organic.build_prompt(["Kale"])
    assert all(key in prompt for key in estimatestore.QUALIFIERS)
