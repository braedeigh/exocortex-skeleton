"""Published pesticide rankings of a food — the sanity check beside the verdict
(scripts/reference_data.py `ranking`, exposurestore.outside_rankings).

What can silently break here, worst first: a ranking recorded with a quote the
article doesn't contain (the passage must be found, or no claim is written);
the food page not finding a ranking filed under another of the food's names;
and a ranking arriving as if she had already reviewed it.
"""
import pytest

import exposurestore
import foodstore
import sqlstore
import store
from scripts import reference_data

TOPIC = "contaminants"
URL = "https://example.org/six-foods"
ARTICLE = ("6 Fruits and Vegetables Loaded With Pesticides\n"
           "Kale and Mustard Greens\n"
           "Better choice: Organic kale and mustard greens.")


@pytest.fixture
def world(data_dir, monkeypatch):
    store.write("research.json", {
        "topics": [{"id": TOPIC, "name": "Contaminants", "status": "active",
                    "created": "2026-09-27 10:00", "fronts": []}],
        "entries": [], "sessions": []})
    foodstore.add_food("kale")
    monkeypatch.setattr(reference_data, "page_text", lambda url: ARTICLE)
    return data_dir


def _record(passage="Better choice: Organic kale and mustard greens.", food="kale"):
    return reference_data.ranking(food, "Consumer Reports", "organic", "better choice", 2025,
                                  URL, "CR, 6 Fruits and Vegetables", passage, TOPIC)


def _claims():
    conn = sqlstore.open_db()
    try:
        return conn.execute("SELECT count(*) FROM research_entries WHERE kind = 'claim'").fetchone()[0]
    finally:
        conn.close()


def test_ranking_shows_on_the_food_with_its_quoted_passage(world):
    _record()
    ranking, = exposurestore.food_exposure("kale")["rankings"]
    assert (ranking["by"], ranking["claim"], ranking["label"], ranking["passage"], ranking["url"]) == (
        "Consumer Reports", "organic", "better choice",
        "Better choice: Organic kale and mustard greens.", URL)


def test_ranking_with_a_quote_not_in_the_article_writes_no_claim(world):
    with pytest.raises(ValueError, match="passage not found"):
        _record(passage="Kale is perfectly safe.")
    assert _claims() == 0


def test_ranking_arrives_unreviewed(world):
    _record()
    assert exposurestore.food_exposure("kale")["rankings"][0]["reviewed"] is False


def test_ranking_recorded_before_a_merge_reaches_the_kept_food(world):
    foodstore.add_food("lacinato kale")
    _record(food="lacinato kale")
    foodstore.merge("kale", "lacinato kale")
    assert len(exposurestore.food_exposure("kale")["rankings"]) == 1
