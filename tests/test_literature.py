"""Combing the studies about a contaminant (scripts/literature.py).

What can silently break here, worst first: an agent's finding lifting "needs
research" before she has judged it; a finding whose highlighted passage
isn't really in the study (the quote must be found, or nothing is written);
a study's text overwriting one already fetched; and the search log
forgetting a search.
"""
import pytest

import docstore
import exposurestore
import hazardstore
import paperclients
import sqlstore
import store
from scripts import literature

TOPIC = "contaminants"
ARTICLE = {"ok": True, "pmid": "31", "title": "Deltamethrin and the rat liver",
           "journal": "Toxicology Reports", "year": "2019", "authors": ["Rao K"],
           "abstract": "Liver enzymes rose at 5 mg/kg.", "types": ["Journal Article"],
           "doi": "", "pmcid": "", "funding": [], "conflicts": ""}


@pytest.fixture
def world(data_dir, monkeypatch):
    store.write("research.json", {
        "topics": [{"id": TOPIC, "name": "Contaminants", "status": "active",
                    "created": "2026-09-27 10:00", "fronts": []}],
        "entries": [], "sessions": []})
    hazardstore.seed_starter_map()
    hazardstore.add_hazard("Deltamethrin", parents=["Insecticide"])
    monkeypatch.setattr(paperclients, "pubmed_article", lambda pmid: dict(ARTICLE))
    return data_dir


def _state():
    return exposurestore.research_state(exposurestore.facts_for("Deltamethrin"))


def test_study_keeps_its_pubmed_record_as_the_source_text(world):
    source_id, created = literature.study("31", TOPIC)
    text = docstore.resolve(f"entry:{source_id}")["text"]
    assert created and "Liver enzymes rose at 5 mg/kg." in text and "Funding: not stated" in text


def test_study_never_overwrites_a_text_already_fetched(world):
    source_id, _ = literature.study("31", TOPIC)
    docstore.save_entry_text(source_id, "the full paper")
    assert literature.study("31", TOPIC) == (source_id, False) and \
        docstore.resolve(f"entry:{source_id}")["text"] == "the full paper"


def test_finding_highlights_the_passage_it_quotes(world):
    source_id, _ = literature.study("31", TOPIC)
    fact_id, annotation_id = literature.finding(
        "Deltamethrin", source_id, "Raised liver enzymes in rats", "animal", "found harm",
        "Liver enzymes  rose at 5 mg/kg.")
    fact = next(f for f in exposurestore.facts_for("Deltamethrin") if f["id"] == fact_id)
    assert (fact["passage"], fact["basis"], fact["annotation_id"]) == (
        "Liver enzymes rose at 5 mg/kg.", "animal · found harm", annotation_id)


def test_finding_with_a_quote_not_in_the_study_writes_nothing(world):
    source_id, _ = literature.study("31", TOPIC)
    with pytest.raises(ValueError, match="passage not found"):
        literature.finding("Deltamethrin", source_id, "safe", "animal", "found no harm",
                           "No effects were seen.")
    conn = sqlstore.open_db()
    try:
        highlights = conn.execute("SELECT COUNT(*) FROM research_annotations").fetchone()[0]
    finally:
        conn.close()
    assert not exposurestore.facts_for("Deltamethrin") and highlights == 0


def test_an_agents_finding_waits_for_her_before_research_is_lifted(world):
    source_id, _ = literature.study("31", TOPIC)
    fact_id, _ = literature.finding("Deltamethrin", source_id, "Raised liver enzymes", "animal",
                                    "found harm", "Liver enzymes rose")
    before = _state()
    exposurestore.review_fact(fact_id, "confirmed")
    assert before == {"independent": 0, "to_judge": 1, "needs_research": True} and \
        _state() == {"independent": 1, "to_judge": 0, "needs_research": False}


def test_the_same_search_again_updates_its_log_row(world):
    exposurestore.record_search("Deltamethrin", "pubmed", "deltamethrin toxicity", 200, 40)
    hazard_id = exposurestore.record_search("Deltamethrin", "pubmed", "deltamethrin toxicity", 212, 40)
    assert [search["matched"] for search in exposurestore.searches_for(hazard_id)] == [212]
