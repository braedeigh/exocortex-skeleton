"""GET /api/people/roster — the data source for the /people browsable roster.

Deliberately built only from `people_index()` (no `find_mentions` — see the
docstring on `entities.people_roster()`), so these tests focus on: dates come
through as the sorted `entries` dates, `last_note` skips a newer entry with an
empty note to find the newest non-empty one, and a person with no entries at
all gets an empty list + null note. Mirrors the vault-fixture style of
test_entities_routes.py.
"""
import pytest
from flask import Flask

import store
from routes import entities

SAGE = """---
tags: [springfield, housemate, landlord]
---
# Sage

The owner's landlord in Springfield. Sweet but landlord-vibes.

## Referenced In
- [[2026-05-10]] (Mother's Day)
- [[2026-06-28]] (the morning after)
- [[2026-07-01]]
"""

DAVID = """# David

An old friend, no structured references yet.
"""


@pytest.fixture
def vault(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "CONTENT_DIR", tmp_path)
    (tmp_path / "people").mkdir()
    (tmp_path / "people" / "sage.md").write_text(SAGE)
    (tmp_path / "people" / "david.md").write_text(DAVID)
    return tmp_path


@pytest.fixture
def client(vault):
    app = Flask(__name__)
    app.config.update(TESTING=True)
    entities.register(app)
    return app.test_client()


def test_roster_dates_and_last_note_skip_empty_newest_entry(client):
    people = {p["id"]: p for p in client.get("/api/people/roster").get_json()["people"]}
    sage = people["sage"]
    # entries() sorts ascending; the roster hands the same order straight through.
    assert sage["dates"] == ["2026-05-10", "2026-06-28", "2026-07-01"]
    # The newest entry (2026-07-01) has an empty note, so last_note falls back
    # to the newest entry that actually has one.
    assert sage["last_note"] == {"date": "2026-06-28", "note": "the morning after"}


def test_roster_person_with_no_entries_has_empty_dates_and_null_note(client):
    people = {p["id"]: p for p in client.get("/api/people/roster").get_json()["people"]}
    david = people["david"]
    assert david["dates"] == []
    assert david["last_note"] is None


def test_roster_carries_blurb_and_tags(client):
    people = {p["id"]: p for p in client.get("/api/people/roster").get_json()["people"]}
    sage = people["sage"]
    assert sage["blurb"] == "The owner's landlord in Springfield. Sweet but landlord-vibes."
    assert sage["tags"] == ["springfield", "housemate", "landlord"]
    assert people["david"]["tags"] == []


def test_roster_does_not_call_find_mentions(client, monkeypatch):
    """The roster must stay cheap: it's built only from people_index(), never
    find_mentions (which globs the whole vault per person)."""
    def boom(*a, **k):
        raise AssertionError("people_roster() must not call find_mentions")
    monkeypatch.setattr(entities, "find_mentions", boom)
    resp = client.get("/api/people/roster")
    assert resp.status_code == 200
    assert len(resp.get_json()["people"]) == 2
