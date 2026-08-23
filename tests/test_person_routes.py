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


def test_summarize_mints_a_personal_helper_session(client, monkeypatch, data_dir):
    """No tmux any more: the button writes a brief naming the person's file
    (absolute, via store.CONTENT_DIR) and mints a Personal-room helper
    session through routes/helpers.py. The runner launch is recorded, not run."""
    from routes import spinoff
    monkeypatch.setattr(store, "SPINOFF_DIR", data_dir / "spinoffs")
    launches = []
    monkeypatch.setattr(spinoff.subprocess, "Popen",
                        lambda argv, **kw: launches.append(argv) or object())
    monkeypatch.delenv("EXOCORTEX_CONV_ID", raising=False)

    resp = client.post("/api/person/sage/summarize")
    data = resp.get_json()

    assert resp.status_code == 200
    assert data["ok"] is True and data["newly_spawned"] is True
    assert data["kind"] == "person" and data["lane"] == "personal"
    brief = (data_dir / "spinoffs" / "person-sage" / "BRIEF.md").read_text()
    assert "Sage" in brief
    assert str(store.CONTENT_DIR / "people/sage.md") in brief
    entry = store.read("bot_chats/index", {})[data["conversation_id"]]
    assert entry["origin"] == "helper" and entry["helper"] == "person"
    assert len(launches) == 1


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
