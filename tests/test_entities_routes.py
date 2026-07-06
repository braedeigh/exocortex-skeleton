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

## Impression
Landlord vibes, but sweet underneath — the chore texts land bigger than
intended some weeks.

*(updated 2026-07-01)*

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
    (tmp_path / "Journal" / "Daily" / "2026-07-06.md").write_text(
        "B: quiet day, nothing much happened\n")   # card-cutover day, no named hit
    (tmp_path / "THREADS.md").write_text("Housing: moving out from Sally's place.\n")

    # Card files (the cricket's per-message log): from CARDS_CUTOVER on, a card
    # tagged with a person's slug counts even when its body doesn't name them —
    # unless the body DOES name them, in which case the journal-day scan above
    # already caught it and the card must not double-count.
    cards = tmp_path / "_system" / "data" / "cards"
    cards.mkdir(parents=True)
    (cards / "2026-07-06.aaa.md").write_text(
        "---\ntags: [sally]\n---\nTalked about dinner plans.\n")      # unnamed -> +1
    (cards / "2026-07-06.bbb.md").write_text(
        "---\ntags: [sally]\n---\nSally stopped by after work.\n")    # named -> skip
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
    # New: every old field is still there (journal.html/keeper consumers depend
    # on them), plus a stats block.
    assert data["stats"]["days"] > 0
    assert data["stats"]["total"] >= data["stats"]["days"]


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


# --- Impression + body (person-page narrative fields) -----------------------

def test_impression_section_parsed(vault):
    person = entities.people_index()["sally"]
    assert person["impression"].startswith("Landlord vibes, but sweet underneath")
    assert "*(updated 2026-07-01)*" in person["impression"]
    assert "Referenced In" not in person["impression"]


def test_impression_absent_is_empty_string(vault):
    person = entities.people_index()["david"]
    assert person["impression"] == ""


def test_body_is_full_markdown_after_frontmatter(vault):
    person = entities.people_index()["sally"]
    assert person["body"].startswith("# Sally")
    assert "## Referenced In" in person["body"]
    assert "landlord-vibes" in person["body"]
    # Frontmatter itself must not leak into body.
    assert "aliases:" not in person["body"]


# --- Mention counts -----------------------------------------------------------

def test_mentions_carry_hit_count(vault):
    person = entities.people_index()["sally"]
    mentions = entities.find_mentions("Sally", self_file=person["file"])
    m = next(m for m in mentions if m["file"] == "Journal/Daily/2026-07-03.md")
    assert m["count"] == 1


# --- mention_days: journal counts + tagged cards + entries union -------------

def test_mention_days_counts_journal_and_unions_entries(vault):
    person = entities.people_index()["sally"]
    days = entities.mention_days(person)
    by_date = {d["date"]: d["count"] for d in days}

    assert by_date["2026-07-03"] == 1   # "sally texted me..." — named
    assert by_date["2026-07-02"] == 1   # "my landlord" — alias
    assert "2026-07-01" not in by_date  # no mention there at all

    # Structured entries with no journal/card hit are unioned in at count 1.
    assert by_date["2026-02-27"] == 1
    assert by_date["2026-05-10"] == 1
    assert by_date["2026-06-28"] == 1


def test_mention_days_counts_unnamed_tagged_card_once_and_skips_named_card(vault):
    person = entities.people_index()["sally"]
    days = entities.mention_days(person)
    by_date = {d["date"]: d["count"] for d in days}
    # The journal file for this day has no hit; the unnamed card adds exactly 1
    # (the named card, which contains "Sally", is skipped so it isn't double-counted).
    assert by_date["2026-07-06"] == 1


def test_mention_days_ignores_tagged_cards_before_cutover(vault, monkeypatch):
    # Move the cutover forward so today's tagged card would no longer count —
    # proves the CARDS_CUTOVER gate, not just that the card exists.
    monkeypatch.setattr(entities, "CARDS_CUTOVER", "2099-01-01")
    person = entities.people_index()["sally"]
    days = entities.mention_days(person)
    by_date = {d["date"]: d["count"] for d in days}
    assert "2026-07-06" not in by_date


# --- person_stats -------------------------------------------------------------

def test_person_stats_prefers_newest_mention_for_last(vault):
    person = entities.people_index()["sally"]
    terms = [person["name"].split()[0]] + person["aliases"]
    mentions = entities.find_mentions(terms, self_file=person["file"])
    days = entities.mention_days(person)
    stats = entities.person_stats(person, days, mentions)

    assert stats["days"] == len(days)
    assert stats["total"] == sum(d["count"] for d in days)
    assert stats["first_date"] == days[0]["date"]
    assert stats["last_date"] == days[-1]["date"]
    # The newest *mention* (2026-07-03, has a snippet) wins over the newest *day*
    # (2026-07-06 is a card-only day with no mention snippet).
    assert stats["last_date"] == "2026-07-06"
    assert stats["last"]["date"] == mentions[0]["date"] == "2026-07-03"
    assert stats["last"]["snippet"] == mentions[0]["snippet"]


def test_person_stats_falls_back_to_day_when_no_mentions(vault):
    person = entities.people_index()["david"]
    mentions = entities.find_mentions(person["name"], self_file=person["file"])
    days = entities.mention_days(person)
    stats = entities.person_stats(person, days, mentions)

    assert mentions == []
    assert stats["last"] == {
        "date": "2026-06-01", "file": "Journal/Daily/2026-06-01.md",
        "label": "2026-06-01", "snippet": "",
    }
