"""Threads API — the group/topic profiles parsed out of tulku/Threads/*.md.

Mirrors the house style (test_todos_routes.py): seed a rigid-shape markdown file
in an isolated CONTENT_DIR, hit the HTTP contract, assert the parsed result. The
parser's job is to turn `## Heading` + `- bullet` + backtick source tokens into
fact-cards with routable sources — so that's what we pin down here.

The threads-architecture (§8 steps 2-3) tests below use a second fixture: a
copy of tests/fixtures/threads/content, which is a small real DAG (root ->
mid -> leaf, long-covid -> migraines, plus a broken/retired thread) shared
with the Rust `thread` binary's own tests. They exercise the new frontmatter
fields (fronts/parents/kind/status/distilled), retired filtering, the derived
tree, backlinks, and the per-thread card inbox.
"""
import shutil
from pathlib import Path

import pytest

import store
from routes import threads

FIXTURES_ROOT = Path(__file__).parent / "fixtures" / "threads"


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


# --- threads-architecture §8 steps 2-3: fronts/parents/kind/tree/inbox -------

@pytest.fixture
def vault(tmp_path, monkeypatch):
    """Copy the shared threads fixture content tree into tmp_path and point
    store.CONTENT_DIR at it, so these tests read real DAG-shaped fixtures
    (migraines/long-covid/root-mid-leaf/broken) instead of one inline file.
    `_vault()` re-resolves store.CONTENT_DIR fresh per call, so monkeypatching
    it here is enough — no need to touch the routes module itself."""
    content = tmp_path / "content"
    shutil.copytree(FIXTURES_ROOT / "content", content)
    monkeypatch.setattr(store, "CONTENT_DIR", content)
    return content


@pytest.fixture
def vault_client(vault):
    from flask import Flask
    app = Flask(__name__)
    app.config.update(TESTING=True)
    threads.register(app)
    return app.test_client()


FIXTURE_THREADS = {
    "migraines": {"fronts": ["health", "job"], "parents": ["long-covid"],
                  "kind": "standing", "distilled": "2026-07-10"},
    "long-covid": {"fronts": ["health"], "parents": [],
                   "kind": "standing", "distilled": "2026-07-01"},
    "root-thread": {"fronts": ["health"], "parents": [],
                    "kind": "standing", "distilled": None},
    "mid-thread": {"fronts": ["health"], "parents": ["root-thread"],
                   "kind": "standing", "distilled": None},
    "leaf-thread": {"fronts": ["health"], "parents": ["mid-thread"],
                    "kind": "standing", "distilled": None},
}


def test_parse_thread_extracts_new_frontmatter_across_fixtures(vault):
    # Cross-parser guarantee: every VALID fixture thread parses to exactly
    # what its frontmatter says, matching the Rust side's own fixture reads.
    for slug, expected in FIXTURE_THREADS.items():
        t = threads.parse_thread(vault / "Threads" / f"{slug}.md")
        assert t["fronts"] == expected["fronts"]
        assert t["parents"] == expected["parents"]
        assert t["kind"] == expected["kind"]
        assert t["distilled"] == expected["distilled"]


def test_parse_thread_tolerates_broken_fixture_without_raising(vault):
    # Rust is the strict writer; parse_thread must not start rejecting files.
    t = threads.parse_thread(vault / "Threads" / "broken-thread.md")
    assert t["id"] == "broken-thread"


def test_list_excludes_retired_by_default(vault_client):
    data = vault_client.get("/api/threads").get_json()
    ids = {t["id"] for t in data["threads"]}
    assert "broken-thread" not in ids   # status: retired in the fixture
    assert "migraines" in ids


def test_list_include_retired_shows_it(vault_client):
    data = vault_client.get("/api/threads?include=retired").get_json()
    ids = {t["id"] for t in data["threads"]}
    assert "broken-thread" in ids


def test_list_filters_by_front(vault_client):
    data = vault_client.get("/api/threads?front=job").get_json()
    ids = {t["id"] for t in data["threads"]}
    assert ids == {"migraines"}   # only thread carrying the "job" front


def test_list_items_carry_fronts_parents_kind_status(vault_client):
    data = vault_client.get("/api/threads").get_json()
    migraines = next(t for t in data["threads"] if t["id"] == "migraines")
    assert migraines["fronts"] == ["health", "job"]
    assert migraines["parents"] == ["long-covid"]
    assert migraines["kind"] == "standing"
    assert migraines["status"] == "active"


def test_parse_thread_reads_people_cast(vault):
    # migraines.md's fixture frontmatter carries `people: [michael]`.
    t = threads.parse_thread(vault / "Threads" / "migraines.md")
    assert t["people"] == ["michael"]


def test_parse_thread_defaults_people_to_empty_list(vault):
    # long-covid.md predates the people: migration — no key at all.
    t = threads.parse_thread(vault / "Threads" / "long-covid.md")
    assert t["people"] == []


def test_roster_resolves_cast_to_slug_and_name(vault_client):
    data = vault_client.get("/api/threads").get_json()
    migraines = next(t for t in data["threads"] if t["id"] == "migraines")
    assert migraines["people"] == [{"slug": "michael", "name": "Michael"}]


def test_detail_resolves_cast_to_slug_and_name(vault_client):
    t = vault_client.get("/api/thread?name=migraines").get_json()
    assert t["people"] == [{"slug": "michael", "name": "Michael"}]


def test_detail_cast_falls_back_to_titlecased_slug_when_no_people_file(vault, vault_client):
    (vault / "Threads" / "no-file-cast.md").write_text(
        "---\n"
        "name: No File Cast\n"
        "aliases: []\n"
        "fronts: [health]\n"
        "parents: []\n"
        "people: [nobody-here]\n"
        "kind: standing\n"
        "status: active\n"
        "opened: 2026-07-15\n"
        "retired:\n"
        "distilled:\n"
        "---\n\n"
        "## What it is\n"
        "A thread naming a cast slug with no people file yet.\n"
        "→ `2026-07-01.0800a`\n"
    )
    t = vault_client.get("/api/thread?name=no-file-cast").get_json()
    assert t["people"] == [{"slug": "nobody-here", "name": "Nobody Here"}]


def test_tree_nodes_carry_raw_people_slugs(vault_client):
    tree = vault_client.get("/api/threads/tree").get_json()
    assert tree["nodes"]["migraines"]["people"] == ["michael"]


def test_threads_for_person_finds_cast_membership(vault):
    out = threads.threads_for_person("michael")
    assert [t["slug"] for t in out] == ["migraines"]
    assert out[0]["name"] == "Migraines"


def test_threads_for_person_empty_for_unlisted_person(vault):
    assert threads.threads_for_person("bryan") == []


def test_detail_includes_backlinks(vault_client):
    # migraines.md's body links [[long-covid]]; long-covid's backlinks
    # should therefore name migraines.
    t = vault_client.get("/api/thread?name=long-covid").get_json()
    assert {b["slug"] for b in t["backlinks"]} == {"migraines"}
    assert {b["name"] for b in t["backlinks"]} == {"Migraines"}


def test_detail_no_backlinks_for_unlinked_thread(vault_client):
    t = vault_client.get("/api/thread?name=root-thread").get_json()
    assert t["backlinks"] == []


def test_tree_children_inversion_across_the_chain(vault_client):
    tree = vault_client.get("/api/threads/tree").get_json()
    assert "root-thread" in tree["roots"]
    assert "long-covid" in tree["roots"]
    assert tree["nodes"]["root-thread"]["children"] == ["mid-thread"]
    assert tree["nodes"]["mid-thread"]["children"] == ["leaf-thread"]
    assert tree["nodes"]["long-covid"]["children"] == ["migraines"]


def test_tree_excludes_retired_nodes_and_edges_by_default(vault_client):
    tree = vault_client.get("/api/threads/tree").get_json()
    assert "broken-thread" not in tree["nodes"]
    assert "broken-thread" not in tree["roots"]


def test_tree_include_retired_drops_edge_to_missing_parent(vault_client):
    # broken-thread.md's only parent ("ghost-parent") doesn't exist on disk —
    # the edge is dropped silently and the child still appears, rooted.
    tree = vault_client.get("/api/threads/tree?include=retired").get_json()
    assert "broken-thread" in tree["nodes"]
    assert "broken-thread" in tree["roots"]
    for node in tree["nodes"].values():
        assert "broken-thread" not in node["children"]


def test_tree_multi_parent_node_appears_in_two_children_lists(vault, vault_client):
    # A node with 2+ parents appears in each parent's children list — no
    # fixture-dir edit needed, just an extra file in this test's tmp copy.
    (vault / "Threads" / "shared-child.md").write_text(
        "---\n"
        "name: Shared Child\n"
        "aliases: []\n"
        "fronts: [health]\n"
        "parents: [long-covid, root-thread]\n"
        "kind: standing\n"
        "status: active\n"
        "opened: 2026-07-15\n"
        "retired:\n"
        "distilled:\n"
        "---\n\n"
        "## What it is\n"
        "A thread under two hubs.\n"
        "→ `2026-07-01.0800a`\n"
    )
    tree = vault_client.get("/api/threads/tree").get_json()
    assert "shared-child" in tree["nodes"]["long-covid"]["children"]
    assert "shared-child" in tree["nodes"]["root-thread"]["children"]
    assert "shared-child" not in tree["roots"]


def test_inbox_filters_by_watermark_oldest_first(vault_client):
    # migraines distilled: 2026-07-10. A card tagged migraines dated
    # 2026-07-05 (before) is excluded; 07-12 and 07-14 (after) are included,
    # oldest first.
    data = vault_client.get("/api/thread/migraines/inbox").get_json()
    assert [c["id"] for c in data["cards"]] == ["2026-07-12.1200a", "2026-07-14.1655c"]
    assert data["distilled"] == "2026-07-10"


def test_inbox_card_carries_full_body_who_and_tags(vault_client):
    data = vault_client.get("/api/thread/migraines/inbox").get_json()
    card = data["cards"][0]
    assert card["who"] == "B"
    assert "migraines" in card["tags"]
    assert "aura" in card["text"].lower()


def test_inbox_no_watermark_includes_all_tagged_cards(vault, vault_client):
    # root-thread has no distilled: date yet. Add a card tagged root-thread,
    # dated well before "today", to confirm it's still returned — the
    # watermark-less branch means no date filtering at all.
    cards_dir = vault / "_system" / "data" / "cards"
    (cards_dir / "2020-01-01.0000a.md").write_text(
        "---\n"
        "id: 2020-01-01.0000a\n"
        "who: B\n"
        "ts: 2020-01-01 00:00:00\n"
        "tags: [root-thread]\n"
        "kind: line\n"
        "---\n"
        "An old card, included because root-thread has no watermark yet.\n"
    )
    data = vault_client.get("/api/thread/root-thread/inbox").get_json()
    assert [c["id"] for c in data["cards"]] == ["2020-01-01.0000a"]
    assert data["distilled"] is None


def test_inbox_unknown_slug_is_404(vault_client):
    resp = vault_client.get("/api/thread/nope-at-all/inbox")
    assert resp.status_code == 404
