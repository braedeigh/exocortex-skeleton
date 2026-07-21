"""Person facts — parsing, round-trips, API validation."""
import json
import pytest
from flask import Flask

import store
from routes import entities, person

# --- fixtures ---

SAGE_WITH_FACTS = """---
tags: [springfield, landlord]
aliases: [landlady]
relationship: landlord
age: ~50
lives: Springfield
---
# Sage

The owner's landlord.

## Impression
Sweet but landlord vibes.

## Referenced In
- [[2026-05-10]] (Mother's Day)
"""

SAGE_NO_FRONTMATTER = """# Sage

The owner's landlord.

## Referenced In
- [[2026-05-10]] (Mother's Day)
"""

SAGE_TAGS_ONLY = """---
tags: [springfield, landlord]
aliases: [landlady]
---
# Sage

The owner's landlord.
"""


@pytest.fixture
def vault(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "CONTENT_DIR", tmp_path)
    (tmp_path / "people").mkdir()
    (tmp_path / "people" / "sage.md").write_text(SAGE_WITH_FACTS)
    (tmp_path / "Journal" / "Daily").mkdir(parents=True)
    return tmp_path


@pytest.fixture
def client(vault):
    app = Flask(__name__)
    app.config.update(TESTING=True)
    person.register(app)
    return app.test_client()


def _post(client, path, payload):
    return client.post(path, data=json.dumps(payload),
                       content_type="application/json")


# --- parsing tests ---

def test_scalar_facts_land_in_facts_dict(vault):
    p = entities.people_index()["sage"]
    assert p["facts"]["relationship"] == "landlord"
    assert p["facts"]["age"] == "~50"
    assert p["facts"]["lives"] == "Springfield"


def test_tags_and_aliases_excluded_from_facts(vault):
    p = entities.people_index()["sage"]
    assert "tags" not in p["facts"]
    assert "aliases" not in p["facts"]


def test_tags_and_aliases_still_parsed(vault):
    p = entities.people_index()["sage"]
    assert p["tags"] == ["springfield", "landlord"]
    assert p["aliases"] == ["landlady"]


def test_no_facts_gives_empty_dict(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "CONTENT_DIR", tmp_path)
    (tmp_path / "people").mkdir()
    (tmp_path / "people" / "sage.md").write_text(SAGE_TAGS_ONLY)
    p = entities.people_index()["sage"]
    assert p["facts"] == {}


# --- round-trip tests ---

def test_post_facts_body_byte_identical(client, vault):
    """Writing facts must not alter the body below the frontmatter."""
    original = (vault / "people" / "sage.md").read_text()
    # Find the body part after closing ---
    lines = original.splitlines()
    end_fm = next(i for i in range(1, len(lines)) if lines[i].strip() == "---")
    original_body = "\n".join(lines[end_fm + 1:])

    r = _post(client, "/api/person/sage/facts", {"facts": {"relationship": "landlord", "age": "~50", "lives": "Springfield"}})
    assert r.status_code == 200

    written = (vault / "people" / "sage.md").read_text()
    lines2 = written.splitlines()
    end_fm2 = next(i for i in range(1, len(lines2)) if lines2[i].strip() == "---")
    written_body = "\n".join(lines2[end_fm2 + 1:])

    assert written_body == original_body


def test_post_facts_tags_aliases_preserved(client, vault):
    r = _post(client, "/api/person/sage/facts", {"facts": {"relationship": "friend"}})
    assert r.status_code == 200
    raw = (vault / "people" / "sage.md").read_text()
    assert "tags: [springfield, landlord]" in raw
    assert "aliases: [landlady]" in raw


def test_file_without_frontmatter_gets_block(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "CONTENT_DIR", tmp_path)
    (tmp_path / "people").mkdir()
    (tmp_path / "people" / "sage.md").write_text(SAGE_NO_FRONTMATTER)
    app = Flask(__name__)
    app.config.update(TESTING=True)
    person.register(app)
    c = app.test_client()

    r = _post(c, "/api/person/sage/facts", {"facts": {"age": "~50"}})
    assert r.status_code == 200

    raw = (tmp_path / "people" / "sage.md").read_text()
    assert raw.startswith("---\n")
    assert "age: ~50" in raw
    # Body intact
    assert "# Sage" in raw
    assert "The owner's landlord." in raw


def test_remove_on_empty_value(client, vault):
    # Confirm fact exists first
    p = entities.people_index()["sage"]
    assert "age" in p["facts"]

    # Remove it by setting empty
    r = _post(client, "/api/person/sage/facts", {"facts": {"age": ""}})
    assert r.status_code == 200
    data = r.get_json()
    assert "age" not in data["facts"]

    # Verify it's gone from the file
    raw = (vault / "people" / "sage.md").read_text()
    assert "age:" not in raw


def test_reserved_key_rejected(client):
    r = _post(client, "/api/person/sage/facts", {"facts": {"tags": "foo"}})
    assert r.status_code == 400
    assert "reserved" in r.get_json()["error"].lower()


def test_reserved_key_aliases_rejected(client):
    r = _post(client, "/api/person/sage/facts", {"facts": {"aliases": "foo"}})
    assert r.status_code == 400


def test_bad_key_chars_rejected(client):
    r = _post(client, "/api/person/sage/facts", {"facts": {"bad key!": "value"}})
    assert r.status_code == 400
    assert "invalid" in r.get_json()["error"].lower()


def test_unknown_slug_404(client):
    r = _post(client, "/api/person/nobody/facts", {"facts": {}})
    assert r.status_code == 404


def test_facts_in_api_response(client):
    data = client.get("/api/person/sage").get_json()
    assert "facts" in data["person"]
    assert data["person"]["facts"]["relationship"] == "landlord"
