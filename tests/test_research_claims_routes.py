"""The claims table's HTTP contract (routes/research_claims.py).

Each test seeds research.json (and sometimes annotations.json or a source's
extracted text) under the isolated data_dir, hits the route through a minimal
Flask app, and asserts the response shape the page codes against
(frontend/src/features/research/types.ts) plus what was persisted.
"""
import pytest
from flask import Flask

import docstore
import researchstore
import store
from routes import research_claims

OWNER_CLAIM = "2026-07-01.0900"
LLM_CLAIM = "2026-07-01.0900-2"
SOURCE = "2026-07-01.0900-3"
NOTE = "2026-07-01.0900-4"
SOURCE_TEXT = "Alpha. The quick brown fox sleeps. Omega."


def _entry(eid, kind="note", **over):
    entry = {"id": eid, "kind": kind, "text": f"text of {eid}", "topics": [],
             "url": "", "verdict": "", "status": "", "reply_to": None,
             "created": "2026-07-01 09:00"}
    entry.update(over)
    return entry


@pytest.fixture
def seeded(data_dir):
    """Two topics (one on the health front), an owner claim, an llm claim,
    a source and a plain note."""
    store.write("research.json", {
        "topics": [
            {"id": "sleep", "name": "Sleep", "status": "active",
             "created": "2026-07-01 09:00", "fronts": ["health"]},
            {"id": "money", "name": "Money", "status": "active",
             "created": "2026-07-01 09:00", "fronts": []},
        ],
        "entries": [
            _entry(OWNER_CLAIM, kind="claim", text="Magnesium helps sleep", topics=["sleep"]),
            _entry(LLM_CLAIM, kind="claim", text="Rent is a third of income", topics=["money"],
                   author="llm", reviewed=False, session="2026-07-01.0930"),
            _entry(SOURCE, kind="source", text="Sleep paper", url="https://example.org/sleep"),
            _entry(NOTE),
        ],
        "sessions": [],
    })
    return data_dir


@pytest.fixture
def client(seeded):
    app = Flask(__name__)
    app.config.update(TESTING=True)
    research_claims.register(app)
    return app.test_client()


def _annotations():
    return store.read("annotations.json", {"annotations": []})["annotations"]


# --- reads --------------------------------------------------------------------------

def test_list_includes_owner_claims_not_only_agent_ones(client):
    body = client.get("/api/research/claims").get_json()
    by_id = {c["id"]: c for c in body["claims"]}
    assert set(by_id) == {OWNER_CLAIM, LLM_CLAIM}
    assert by_id[OWNER_CLAIM]["author"] == "owner"
    assert by_id[LLM_CLAIM]["author"] == "llm"
    assert by_id[LLM_CLAIM]["reviewed"] is False


def test_list_filters_by_topic_and_by_front(client):
    by_topic = client.get("/api/research/claims?topic=money").get_json()["claims"]
    assert [c["id"] for c in by_topic] == [LLM_CLAIM]
    by_front = client.get("/api/research/claims?front=health").get_json()["claims"]
    assert [c["id"] for c in by_front] == [OWNER_CLAIM]
    blank = client.get("/api/research/claims?topic=&front=").get_json()["claims"]
    assert len(blank) == 2


def test_detail_hangs_sources_with_annotation_and_has_text(client):
    docstore.save_entry_text(SOURCE, SOURCE_TEXT)
    annotation_id = researchstore.add_annotation(
        f"entry:{SOURCE}", 11, 26, "quick brown fox", note="the bit", source="human",
        needs_review=False)
    researchstore.link_claim_source(OWNER_CLAIM, SOURCE, stance="supports",
                                    annotation_id=annotation_id, note="key paper")
    body = client.get(f"/api/research/claims/{OWNER_CLAIM}").get_json()
    assert body["claim"]["id"] == OWNER_CLAIM
    assert body["claim"]["source_count"] == 1
    assert body["value"] is None
    (source,) = body["sources"]
    assert source["id"] == SOURCE
    assert source["url"] == "https://example.org/sleep"
    assert source["stance"] == "supports"
    assert source["note"] == "key paper"
    assert source["doc"] == f"entry:{SOURCE}"
    assert source["has_text"] is True
    assert source["annotation"] == {
        "id": annotation_id, "doc": f"entry:{SOURCE}", "char_start": 11, "char_end": 26,
        "exact": "quick brown fox", "note": "the bit"}


def test_detail_has_text_false_when_no_text_was_fetched(client):
    researchstore.link_claim_source(OWNER_CLAIM, SOURCE)
    body = client.get(f"/api/research/claims/{OWNER_CLAIM}").get_json()
    assert body["sources"][0]["has_text"] is False
    assert body["sources"][0]["annotation"] is None


def test_detail_is_404_for_a_non_claim_or_unknown_id(client):
    assert client.get(f"/api/research/claims/{SOURCE}").status_code == 404
    assert client.get("/api/research/claims/nope").status_code == 404


def test_source_claims_lists_every_claim_citing_it(client):
    researchstore.link_claim_source(OWNER_CLAIM, SOURCE, stance="supports")
    researchstore.link_claim_source(LLM_CLAIM, SOURCE, stance="context", note="background")
    body = client.get(f"/api/research/sources/{SOURCE}/claims").get_json()
    assert body["source"] == {"id": SOURCE, "text": "Sleep paper",
                              "url": "https://example.org/sleep"}
    by_id = {c["id"]: c for c in body["claims"]}
    assert set(by_id) == {OWNER_CLAIM, LLM_CLAIM}
    assert by_id[LLM_CLAIM]["stance"] == "context"
    assert by_id[LLM_CLAIM]["note"] == "background"


def test_source_claims_is_404_for_an_unknown_source(client):
    assert client.get("/api/research/sources/nope/claims").status_code == 404


# --- link / unlink ------------------------------------------------------------------

def test_link_with_passage_creates_an_owner_annotation_and_returns_it(client):
    docstore.save_entry_text(SOURCE, SOURCE_TEXT)
    response = client.post("/api/research/claims/link", json={
        "claim_id": OWNER_CLAIM, "source_id": SOURCE, "stance": "contradicts",
        "note": "see figure 2",
        "passage": {"char_start": 11, "char_end": 26, "exact": "quick brown fox"},
    })
    assert response.status_code == 200
    (source,) = response.get_json()["sources"]
    assert source["stance"] == "contradicts"
    assert source["note"] == "see figure 2"
    assert source["annotation"]["exact"] == "quick brown fox"
    assert (source["annotation"]["char_start"], source["annotation"]["char_end"]) == (11, 26)
    (annotation,) = _annotations()
    assert annotation["id"] == source["annotation"]["id"]
    assert annotation["doc"] == f"entry:{SOURCE}"
    assert annotation["content"]["source"] == "human"
    assert annotation["needs_review"] is False
    assert annotation["selector"] == {"exact": "quick brown fox", "char_start": 11, "char_end": 26}


def test_link_with_a_bad_range_writes_nothing(client):
    docstore.save_entry_text(SOURCE, SOURCE_TEXT)
    response = client.post("/api/research/claims/link", json={
        "claim_id": OWNER_CLAIM, "source_id": SOURCE,
        "passage": {"char_start": 30, "char_end": 999},
    })
    assert response.status_code == 400
    assert _annotations() == []
    assert researchstore.claim_detail(OWNER_CLAIM)["sources"] == []


def test_link_without_passage_links_bare(client):
    response = client.post("/api/research/claims/link",
                           json={"claim_id": LLM_CLAIM, "source_id": SOURCE})
    assert response.status_code == 200
    (source,) = response.get_json()["sources"]
    assert source["stance"] == "supports"
    assert source["annotation"] is None
    assert _annotations() == []


def test_link_rejects_a_bad_stance(client):
    response = client.post("/api/research/claims/link", json={
        "claim_id": OWNER_CLAIM, "source_id": SOURCE, "stance": "maybe"})
    assert response.status_code == 400
    assert "stance" in response.get_json()["error"]


def test_link_rejects_an_unknown_claim_or_source(client):
    assert client.post("/api/research/claims/link", json={
        "claim_id": "nope", "source_id": SOURCE}).status_code == 400
    assert client.post("/api/research/claims/link", json={
        "claim_id": NOTE, "source_id": SOURCE}).status_code == 400
    assert client.post("/api/research/claims/link", json={
        "claim_id": OWNER_CLAIM, "source_id": "nope"}).status_code == 400
    assert researchstore.claim_detail(OWNER_CLAIM)["sources"] == []


def test_unlink_removes_the_link(client):
    researchstore.link_claim_source(OWNER_CLAIM, SOURCE)
    response = client.post("/api/research/claims/unlink",
                           json={"claim_id": OWNER_CLAIM, "source_id": SOURCE})
    assert response.status_code == 200
    assert response.get_json()["sources"] == []
    assert client.post("/api/research/claims/unlink", json={
        "claim_id": OWNER_CLAIM, "source_id": SOURCE}).status_code == 404


# --- value ----------------------------------------------------------------------------

def test_value_round_trips_through_detail(client):
    response = client.post("/api/research/claims/value", json={
        "claim_id": OWNER_CLAIM, "subject": "magnesium", "measure": "dose",
        "amount": "350", "unit": "mg", "basis": "per day", "year": 2024, "tier": "B"})
    assert response.status_code == 200
    expected = {"subject": "magnesium", "measure": "dose", "amount": 350.0, "unit": "mg",
                "basis": "per day", "year": 2024, "tier": "B"}
    assert response.get_json()["value"] == expected
    again = client.get(f"/api/research/claims/{OWNER_CLAIM}").get_json()
    assert again["value"] == expected
    assert again["claim"]["value"] == expected


def test_value_amends_only_the_fields_sent(client):
    client.post("/api/research/claims/value", json={
        "claim_id": OWNER_CLAIM, "subject": "magnesium", "amount": 350, "unit": "mg"})
    body = client.post("/api/research/claims/value",
                       json={"claim_id": OWNER_CLAIM, "amount": 400}).get_json()
    assert body["value"]["amount"] == 400.0
    assert body["value"]["subject"] == "magnesium"
    assert body["value"]["unit"] == "mg"


def test_value_refuses_a_non_number_and_a_non_claim(client):
    assert client.post("/api/research/claims/value", json={
        "claim_id": OWNER_CLAIM, "amount": "lots"}).status_code == 400
    assert client.post("/api/research/claims/value", json={
        "claim_id": SOURCE, "amount": 1}).status_code == 404
    assert researchstore.claim_detail(OWNER_CLAIM)["value"] is None
