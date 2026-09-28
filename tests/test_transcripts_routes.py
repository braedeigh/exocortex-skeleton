"""routes/transcripts.py — the HTTP contract of the transcript organizer.

Minimal Flask app with only this module registered, against an isolated
data_dir. The AI and the background sorter are both swapped out: llm.status is
faked, and _start_sorter records its call instead of launching a process.
"""
import io
from pathlib import Path

import pytest
from flask import Flask

import llm
import transcriptstore
from routes import transcripts

FIXTURES = Path(__file__).parent / "fixtures" / "transcripts"


@pytest.fixture
def client(data_dir, monkeypatch):
    monkeypatch.setattr(llm, "status", lambda: {"provider": "claude", "signed_in": True, "detail": "x"})
    app = Flask(__name__)
    transcripts.register(app)
    return app.test_client()


@pytest.fixture
def started(monkeypatch):
    calls = []
    monkeypatch.setattr(transcripts, "_start_sorter", lambda limit: calls.append(limit))
    return calls


def _upload(client, name="chatgpt_conversations.json"):
    data = {"export": (io.BytesIO((FIXTURES / name).read_bytes()), "conversations.json")}
    return client.post("/api/transcripts/import", data=data, content_type="multipart/form-data")


def test_import_reads_an_export_and_reports_what_was_added(client):
    response = _upload(client)
    assert response.status_code == 200
    assert response.get_json() == {"read": 2, "added": 2, "updated": 0, "unchanged": 0}


def test_importing_again_reports_unchanged(client):
    _upload(client)
    assert _upload(client).get_json()["unchanged"] == 2


def test_import_refuses_a_file_it_cannot_read(client):
    data = {"export": (io.BytesIO(b"not json"), "conversations.json")}
    response = client.post("/api/transcripts/import", data=data, content_type="multipart/form-data")
    assert response.status_code == 400 and "Couldn't read" in response.get_json()["error"]


def test_import_without_a_file_says_what_to_choose(client):
    response = client.post("/api/transcripts/import", data={}, content_type="multipart/form-data")
    assert response.status_code == 400


def test_overview_carries_counts_topics_sort_state_and_sign_in(client):
    _upload(client, "claude_conversations.json")
    conv_id = transcriptstore.unsorted()[0]["id"]
    transcriptstore.file_under(conv_id, ["Gardening"])
    body = client.get("/api/transcripts/overview").get_json()
    assert body["stats"] == {"conversations": 1, "messages": 3, "unsorted": 0}
    assert [t["name"] for t in body["topics"]] == ["Gardening"]
    assert body["sort"]["running"] is False and body["llm"]["signed_in"] is True


def test_pond_returns_cards_and_filters_by_search(client):
    _upload(client)
    everything = client.get("/api/transcripts/pond").get_json()
    assert len(everything["cards"]) == 4 and everything["truncated"] is False
    found = client.get("/api/transcripts/pond?q=starter").get_json()["cards"]
    assert {c["body"] for c in found} >= {"[image] Why is my starter not rising?"}
    assert all("sorted(" not in c["body"] for c in found)


def test_one_conversation_comes_back_whole(client):
    _upload(client)
    conv_id = transcriptstore.unsorted()[0]["id"]
    body = client.get(f"/api/transcripts/conversation/{conv_id}").get_json()
    assert body["title"] == "Sourdough starter help" and len(body["messages"]) == 2
    assert client.get("/api/transcripts/conversation/999").status_code == 404


def test_sort_starts_the_background_sorter(client, started):
    _upload(client)
    response = client.post("/api/transcripts/sort", json={"limit": 5})
    assert response.status_code == 200 and started == [5]


def test_sort_refuses_when_signed_out_and_says_so(client, started, monkeypatch):
    _upload(client)
    monkeypatch.setattr(llm, "status", lambda: {"provider": "claude", "signed_in": False,
                                                "detail": "login expired"})
    response = client.post("/api/transcripts/sort", json={})
    assert response.status_code == 400 and "login expired" in response.get_json()["error"]
    assert started == []


def test_sort_refuses_while_another_sort_runs(client, started):
    _upload(client)
    with transcriptstore.sort_lock():
        assert client.post("/api/transcripts/sort", json={}).status_code == 409
    assert started == []


def test_sort_with_nothing_to_sort_says_so(client, started):
    assert client.post("/api/transcripts/sort", json={}).status_code == 400
    assert started == []
