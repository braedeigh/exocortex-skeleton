"""Entities — the people index + backlinks that make the markdown a database view.

The load-bearing guarantees: (1) parse both the old bare `- 2026-01-01 (...)` and
the new `- [[2026-01-01]] (...)` reference lines into structured entries, (2) grab
the opening paragraph as the blurb across a multi-paragraph summary, (3) find loose
mentions elsewhere in the vault while excluding the person's own file.
"""
import pytest
from flask import Flask

import store
from routes import entities

SALLY = """---
tags: [austin, housemate, landlord]
aliases: [landlady, my landlord]
---
# Sally

Bradie's landlord in Austin. Sweet but landlord-vibes.

**A later arc paragraph** that should NOT be in the blurb.

## Referenced In
- 2026-02-27 (as "landlady")
- [[2026-05-10]] (Mother's Day)
- [[2026-06-28]] (the morning after)
"""

DAVID = """# David

An old friend, sometimes called david-armenian for disambiguation.

## Referenced In
- [[2026-06-01]] (coffee)
"""


@pytest.fixture
def vault(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "CONTENT_DIR", tmp_path)
    (tmp_path / "people").mkdir()
    (tmp_path / "people" / "sally.md").write_text(SALLY)
    (tmp_path / "people" / "david-armenian.md").write_text(DAVID)
    (tmp_path / "Journal" / "Daily").mkdir(parents=True)
    (tmp_path / "Journal" / "Daily" / "2026-07-03.md").write_text(
        "B: sally texted me about the deposit today\n")
    (tmp_path / "Journal" / "Daily" / "2026-07-02.md").write_text(
        "B: my landlord was being weird again\n")   # alias, not the name "Sally"
    (tmp_path / "Journal" / "Daily" / "2026-07-01.md").write_text(
        "B: nothing about anyone here\n")
    (tmp_path / "THREADS.md").write_text("Housing: moving out from Sally's place.\n")
    return tmp_path


@pytest.fixture
def client(vault):
    app = Flask(__name__)
    app.config.update(TESTING=True)
    entities.register(app)
    return app.test_client()


def test_parses_both_bare_and_wikilinked_dates(vault):
    person = entities.people_index()["sally"]
    dates = [e["date"] for e in person["entries"]]
    assert dates == ["2026-02-27", "2026-05-10", "2026-06-28"]  # bare + wikilink, sorted
    assert person["entries"][0]["note"] == 'as "landlady"'


def test_blurb_is_first_paragraph_only(vault):
    person = entities.people_index()["sally"]
    assert person["blurb"] == "Bradie's landlord in Austin. Sweet but landlord-vibes."
    assert "arc paragraph" not in person["blurb"]


def test_qualifier_filename_keys_on_first_name(vault):
    idx = entities.people_index()
    assert "david" in idx                       # david-armenian.md -> slug "david"
    assert idx["david"]["file"] == "people/david-armenian.md"


def test_mentions_exclude_own_file_and_find_journal_and_threads(vault):
    person = entities.people_index()["sally"]
    mentions = entities.find_mentions("Sally", self_file=person["file"])
    files = {m["file"] for m in mentions}
    assert "people/sally.md" not in files       # never lists her own file
    assert "Journal/Daily/2026-07-03.md" in files
    assert "THREADS.md" in files
    assert "Journal/Daily/2026-07-01.md" not in files  # no mention there
    # Newest-first: dated journal entry sorts above undated THREADS.
    assert mentions[0]["date"] == "2026-07-03"


def test_backlinks_endpoint_shape(client):
    data = client.get("/api/backlinks?name=Sally").get_json()
    assert data["name"] == "Sally"
    assert data["person"]["id"] == "sally"
    assert len(data["person"]["entries"]) == 3
    assert any(m["file"] == "THREADS.md" for m in data["mentions"])


def test_backlinks_unknown_name_still_returns_mentions(client):
    data = client.get("/api/backlinks?name=Nobody").get_json()
    assert data["person"] is None
    assert data["mentions"] == []


def test_backlinks_requires_name(client):
    assert client.get("/api/backlinks").status_code == 400


def test_frontmatter_tags_and_aliases_parsed(vault):
    person = entities.people_index()["sally"]
    assert person["tags"] == ["austin", "housemate", "landlord"]
    assert person["aliases"] == ["landlady", "my landlord"]
    # Frontmatter must not leak into the blurb.
    assert person["blurb"] == "Bradie's landlord in Austin. Sweet but landlord-vibes."


def test_resolve_person_by_alias(vault):
    assert entities.resolve_person("my landlord")["id"] == "sally"
    assert entities.resolve_person("Landlady")["id"] == "sally"   # case-insensitive
    assert entities.resolve_person("nobody") is None


def test_mentions_match_aliases_not_just_name(vault):
    # "my landlord" (2026-07-02) has no "Sally" in it — only the alias.
    data = client_get_backlinks("Sally", vault)
    files = {m["file"] for m in data["mentions"]}
    assert "Journal/Daily/2026-07-02.md" in files


def client_get_backlinks(name, vault):
    from flask import Flask
    app = Flask(__name__)
    app.config.update(TESTING=True)
    entities.register(app)
    return app.test_client().get("/api/backlinks?name=" + name).get_json()


def test_people_endpoint_carries_tags_and_filters(client):
    everyone = client.get("/api/people").get_json()["people"]
    sally = next(p for p in everyone if p["id"] == "sally")
    assert sally["tags"] == ["austin", "housemate", "landlord"]

    filtered = client.get("/api/people?tag=austin").get_json()["people"]
    assert any(p["id"] == "sally" for p in filtered)
    assert all("austin" in [t.lower() for t in p["tags"]] for p in filtered)

    none = client.get("/api/people?tag=nonexistent").get_json()["people"]
    assert none == []
