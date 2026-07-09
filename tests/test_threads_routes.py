"""Threads API — the group/topic profiles parsed out of tulku/Threads/*.md.

Mirrors the house style (test_todos_routes.py): seed a rigid-shape markdown file
in an isolated CONTENT_DIR, hit the HTTP contract, assert the parsed result. The
parser's job is to turn `## Heading` + `- bullet` + backtick source tokens into
fact-cards with routable sources — so that's what we pin down here.
"""
import pytest

import store
from routes import threads


OFFICE_HOURS = """\
---
name: Office Hours
aliases: [office hours, TPOT]
status: active
---

# Office Hours

## What it is
A TPOT office-hours group. Recurring.
→ `2026-07-08.1828b`

## Who goes
- The guy who runs it — sweet to her. *(NEED: name)*
  → `2026-07-08.1841b`
- Fish — status-competitive.
  → `people/ian.md`
"""


@pytest.fixture
def client(tmp_path, monkeypatch):
    """Minimal app with only the threads routes, reading an isolated content vault."""
    from flask import Flask
    monkeypatch.setattr(store, "CONTENT_DIR", tmp_path)
    tdir = tmp_path / "Threads"
    tdir.mkdir()
    (tdir / "office-hours.md").write_text(OFFICE_HOURS)
    app = Flask(__name__)
    app.config.update(TESTING=True)
    threads.register(app)
    return app.test_client()


def test_roster_lists_threads_with_aliases(client):
    data = client.get("/api/threads").get_json()
    names = {t["id"]: t for t in data["threads"]}
    assert "office-hours" in names
    oh = names["office-hours"]
    assert oh["name"] == "Office Hours"
    assert "TPOT" in oh["aliases"]


def test_detail_parses_cards_and_classifies_sources(client):
    t = client.get("/api/thread?name=office-hours").get_json()
    assert t["name"] == "Office Hours"
    assert t["status"] == "active"

    by_heading = {}
    for c in t["cards"]:
        by_heading.setdefault(c["heading"], []).append(c)

    # "What it is" is one card with a card-id source -> journal:<date>.
    what = by_heading["What it is"][0]
    assert "TPOT office-hours group" in what["text"]
    src = what["sources"][0]
    assert src["kind"] == "journal" and src["val"] == "2026-07-08"

    # "Who goes" bullets each become their own card...
    who = by_heading["Who goes"]
    assert len(who) == 2
    # ...and a people-file source classifies as a keeper (Files-tab) path.
    fish = [c for c in who if "Fish" in c["text"]][0]
    assert fish["sources"][0] == {
        "ref": "people/ian.md", "kind": "keeper", "val": "people/ian.md", "label": "ian",
    }


def test_alias_resolves_to_the_thread(client):
    t = client.get("/api/thread?name=TPOT").get_json()
    assert t["id"] == "office-hours"


def test_unknown_thread_is_404(client):
    resp = client.get("/api/thread?name=nope")
    assert resp.status_code == 404
