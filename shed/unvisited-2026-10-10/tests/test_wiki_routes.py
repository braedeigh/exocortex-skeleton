"""Wiki home page API (routes/wiki.py) — mirrors test_threads_routes.py:
seed an isolated CONTENT_DIR with a home.md + a couple of threads/people
files, hit the HTTP contract, assert the parsed/derived result.
"""
from pathlib import Path

import pytest

import store
from routes import wiki

HOME_MD = """\
---
title: Rowan
pronouns: they/them
age: 34
birthday: June 12
place: Springfield, IL
people: [bryan, mom]
---

Rowan is a botanist living in Springfield. Right now they're
building a garden.

## How this is organized

Rowan's life is sorted into fronts. Pick a front to see what's alive there.

## How to read this

This is a wiki about Rowan, meant to be walked. "Right now" below is derived
from their active threads.
"""

ACTIVE_THREAD = """\
---
name: The Cliff (job search)
aliases: []
fronts: [job]
parents: []
people: []
kind: standing
status: active
opened: 2026-07-16
retired:
distilled:
---

## What it is
Job hunting after the cliff.
→ `2026-07-15.0800a`
"""

DORMANT_THREAD = """\
---
name: Old Apartment Hunt
aliases: []
fronts: [living-space]
parents: []
people: []
kind: standing
status: dormant
opened: 2026-01-01
retired:
distilled:
---

## What it is
An old, sleeping thread.
→ `2026-01-01.0800a`
"""

RETIRED_THREAD = """\
---
name: Ancient Grudge
aliases: []
fronts: []
parents: []
people: []
kind: standing
status: retired
opened: 2020-01-01
retired: 2020-02-01
distilled:
---

## What it is
Long gone.
→ `2020-01-01.0800a`
"""

BRYAN_MD = """\
---
tags: [friend]
aliases: []
---
# Bryan

A friend.
"""


@pytest.fixture
def client(tmp_path, monkeypatch):
    """Minimal app with only the wiki route, reading an isolated content vault
    (home.md + Threads/*.md + people/*.md, same shape as the real vault)."""
    from flask import Flask

    monkeypatch.setattr(store, "CONTENT_DIR", tmp_path)
    monkeypatch.setattr(store, "DATA_DIR", tmp_path)

    (tmp_path / "context").mkdir()
    (tmp_path / "context" / "home.md").write_text(HOME_MD)

    tdir = tmp_path / "Threads"
    tdir.mkdir()
    (tdir / "the-cliff.md").write_text(ACTIVE_THREAD)
    (tdir / "old-apartment-hunt.md").write_text(DORMANT_THREAD)
    (tdir / "ancient-grudge.md").write_text(RETIRED_THREAD)

    pdir = tmp_path / "people"
    pdir.mkdir()
    (pdir / "bryan.md").write_text(BRYAN_MD)
    # no mom.md — "mom" should come back unresolved (a redlink)

    store.write("fronts.json", {"fronts": [
        {"id": "job", "name": "Job", "created": "2026-01-01 00:00"},
        {"id": "living-space", "name": "Living space", "created": "2026-01-01 00:00"},
    ]})

    app = Flask(__name__)
    app.config.update(TESTING=True)
    wiki.register(app)
    return app.test_client()


def test_home_returns_200_with_title_and_threads(client):
    resp = client.get("/api/wiki/home")
    assert resp.status_code == 200
    data = resp.get_json()
    assert data["title"] == "Rowan"
    assert isinstance(data["threads"], list)


def test_home_splits_lead_organized_and_how_to_read(client):
    data = client.get("/api/wiki/home").get_json()
    assert "building a garden" in data["lead"]
    assert "How this is organized" not in data["lead"]
    assert "How to read this" not in data["lead"]
    assert "sorted into fronts" in data["organizedBlurb"]
    assert "How to read this" not in data["organizedBlurb"]
    assert "meant to be walked" in data["howToRead"]


def test_home_frontmatter_fields_pass_through(client):
    data = client.get("/api/wiki/home").get_json()
    assert data["pronouns"] == "they/them"
    assert str(data["age"]) == "34"
    assert data["birthday"] == "June 12"
    assert data["place"] == "Springfield, IL"
    assert "hrt_since" not in data
    assert "building" not in data


def test_home_resolves_people_and_flags_redlinks(client):
    data = client.get("/api/wiki/home").get_json()
    by_slug = {p["slug"]: p for p in data["people"]}
    assert by_slug["bryan"]["name"] == "Bryan"
    assert by_slug["bryan"]["resolved"] is True
    assert by_slug["mom"]["resolved"] is False   # no people/mom.md


def test_threads_include_active_and_dormant_exclude_retired(client):
    data = client.get("/api/wiki/home").get_json()
    slugs = {t["slug"] for t in data["threads"]}
    assert "the-cliff" in slugs
    assert "old-apartment-hunt" in slugs   # dormant IS included now
    assert "ancient-grudge" not in slugs   # retired stays excluded


def test_threads_carry_fronts_and_status(client):
    data = client.get("/api/wiki/home").get_json()
    by_slug = {t["slug"]: t for t in data["threads"]}
    assert by_slug["the-cliff"]["fronts"] == ["job"]
    assert by_slug["the-cliff"]["status"] == "active"
    assert by_slug["old-apartment-hunt"]["fronts"] == ["living-space"]
    assert by_slug["old-apartment-hunt"]["status"] == "dormant"


def test_fronts_list_comes_from_fronts_json(client):
    data = client.get("/api/wiki/home").get_json()
    ids = {f["id"] for f in data["fronts"]}
    assert ids == {"job", "living-space"}


def test_missing_home_md_is_404(tmp_path, monkeypatch):
    from flask import Flask

    monkeypatch.setattr(store, "CONTENT_DIR", tmp_path)
    monkeypatch.setattr(store, "DATA_DIR", tmp_path)
    app = Flask(__name__)
    app.config.update(TESTING=True)
    wiki.register(app)
    resp = app.test_client().get("/api/wiki/home")
    assert resp.status_code == 404
