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


class _FakeTmux:
    """Stand-in for routes.terminal._tmux: records the command strings and
    answers has-session with a canned liveness set."""

    def __init__(self, alive=()):
        self.alive = set(alive)
        self.calls = []

    def __call__(self, cmd):
        self.calls.append(cmd)
        ok = type("R", (), {"returncode": 0, "stderr": ""})()
        if cmd.startswith("has-session"):
            name = cmd.split("=", 1)[1]
            ok.returncode = 0 if name in self.alive else 1
        return ok


@pytest.fixture
def talk_env(monkeypatch, tmp_path):
    """Stub the terminal module's tmux + sessions.json touchpoints so
    /api/thread/talk is testable without a tmux server."""
    from routes import terminal as term

    fake = _FakeTmux()
    saved = {"sessions": ["chat"]}
    monkeypatch.setattr(term, "_tmux", fake)
    monkeypatch.setattr(term, "_load_sessions", lambda: list(saved["sessions"]))
    monkeypatch.setattr(term, "_save_sessions", lambda s: saved.update(sessions=s))
    return fake, saved


def test_talk_spawns_a_thread_session(client, talk_env):
    fake, saved = talk_env
    resp = client.post("/api/thread/talk", json={"name": "office-hours"})
    assert resp.status_code == 200
    data = resp.get_json()
    assert data["session"] == "thread-office-hours"
    # The spawned command runs claude with the /thread slash command.
    spawn = [c for c in fake.calls if c.startswith("new-session")][0]
    assert "-s thread-office-hours" in spawn and '"/thread office-hours"' in spawn
    # And the session was registered so the UI lists it.
    assert "thread-office-hours" in saved["sessions"]


def test_talk_suffixes_when_session_alive(client, talk_env):
    fake, _ = talk_env
    fake.alive.add("thread-office-hours")
    data = client.post("/api/thread/talk", json={"name": "office-hours"}).get_json()
    assert data["session"] == "thread-office-hours-2"


def test_talk_unknown_thread_is_404(client, talk_env):
    resp = client.post("/api/thread/talk", json={"name": "nope"})
    assert resp.status_code == 404
