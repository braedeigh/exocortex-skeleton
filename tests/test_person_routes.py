"""routes/person.py — the deep single-person page and its API.

Reuses the same vault-fixture style as test_entities_routes.py (people files +
journal days on disk under a tmp CONTENT_DIR), plus a minimal Flask app that
registers only `person`. All vault parsing stays in entities.py; this module
just orchestrates, so these tests are mostly about response shape + 404s and
the summarize endpoint's session-spawning contract (mirroring test_triage, if
present, for ensure_claude_session/send_prompt).
"""
import shutil
from pathlib import Path

import pytest
from flask import Flask

import store
from routes import entities, person

THREADS_FIXTURES_ROOT = Path(__file__).parent / "fixtures" / "threads"

SAGE = """---
tags: [springfield, housemate, landlord]
aliases: [landlady, my landlord]
---
# Sage

The owner's landlord in Springfield. Sweet but landlord-vibes.

## Impression
Landlord vibes, but sweet underneath.

## Referenced In
- [[2026-05-10]] (Mother's Day)
"""


@pytest.fixture
def vault(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "CONTENT_DIR", tmp_path)
    (tmp_path / "people").mkdir()
    (tmp_path / "people" / "sage.md").write_text(SAGE)
    (tmp_path / "Journal" / "Daily").mkdir(parents=True)
    (tmp_path / "Journal" / "Daily" / "2026-07-03.md").write_text(
        "B: sage texted me about the deposit today\n")
    return tmp_path


@pytest.fixture
def client(vault):
    app = Flask(__name__)
    app.config.update(TESTING=True)
    person.register(app)
    return app.test_client()


def test_person_api_happy_path(client):
    data = client.get("/api/person/sage").get_json()
    assert data["person"]["id"] == "sage"
    assert data["person"]["impression"].startswith("Landlord vibes")
    assert "Referenced In" in data["person"]["body"]
    assert data["stats"]["total"] > 0
    assert any(d["date"] == "2026-07-03" for d in data["days"])
    assert any(m["file"] == "Journal/Daily/2026-07-03.md" for m in data["mentions"])


def test_person_api_resolves_by_alias(client):
    # "landlady" is an alias, not the slug or first name.
    data = client.get("/api/person/landlady").get_json()
    assert data["person"]["id"] == "sage"


def test_person_api_unknown_slug_404(client):
    resp = client.get("/api/person/nobody")
    assert resp.status_code == 404
    assert resp.get_json()["error"]


def test_person_page_unknown_slug_404(client):
    assert client.get("/person/nobody").status_code == 404


def test_summarize_spawns_session_and_sends_prompt(client, monkeypatch):
    calls = {}

    def fake_ensure(name, cwd, dirs=()):
        calls["ensure"] = (name, cwd, dirs)
        return True

    def fake_send(session, text, delay=4.0):
        calls["send"] = (session, text)

    monkeypatch.setattr(person.shared, "ensure_claude_session", fake_ensure)
    monkeypatch.setattr(person.shared, "send_prompt", fake_send)

    resp = client.post("/api/person/sage/summarize")
    data = resp.get_json()

    assert data == {"ok": True, "session": "person", "newly_spawned": True}
    assert calls["ensure"][0] == "person"
    assert calls["ensure"][1] == store.PERSON_SKILL_DIR
    assert calls["send"][0] == "person"
    assert "Sage" in calls["send"][1]
    # The prompt must carry the file's ABSOLUTE path (via store.CONTENT_DIR) —
    # the person-summary session's cwd is the skill dir, not the vault root.
    assert str(store.CONTENT_DIR / "people/sage.md") in calls["send"][1]


def test_summarize_unknown_slug_404(client):
    assert client.post("/api/person/nobody/summarize").status_code == 404


# --- /api/person/<slug>/threads — the people -> threads reverse index -------
# Uses the shared tests/fixtures/threads vault (same one test_threads_routes.py
# and the Rust `thread` binary's own tests read): migraines.md carries
# `people: [michael]`.

@pytest.fixture
def threads_vault_client(tmp_path, monkeypatch):
    content = tmp_path / "content"
    shutil.copytree(THREADS_FIXTURES_ROOT / "content", content)
    monkeypatch.setattr(store, "CONTENT_DIR", content)
    app = Flask(__name__)
    app.config.update(TESTING=True)
    person.register(app)
    return app.test_client()


def test_person_threads_lists_cast_membership(threads_vault_client):
    data = threads_vault_client.get("/api/person/michael/threads").get_json()
    assert [t["slug"] for t in data["threads"]] == ["migraines"]
    assert data["threads"][0]["name"] == "Migraines"


def test_person_threads_empty_when_not_in_any_cast(threads_vault_client):
    data = threads_vault_client.get("/api/person/bryan/threads").get_json()
    assert data["threads"] == []


def test_person_threads_unknown_slug_404(threads_vault_client):
    resp = threads_vault_client.get("/api/person/nobody/threads")
    assert resp.status_code == 404
