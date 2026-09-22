"""Threads API — the group/topic profiles parsed out of tulku/Threads/*.md.

Mirrors the house style (test_todos_routes.py): seed a rigid-shape markdown file
in an isolated CONTENT_DIR, hit the HTTP contract, assert the parsed result. The
parser's job is to turn `## Heading` + `- bullet` + backtick source tokens into
fact-cards with routable sources — so that's what we pin down here.

The threads-architecture (§8 steps 2-3) tests below use a second fixture: a
copy of tests/fixtures/threads/content, which is a small real DAG (root ->
mid -> leaf, topic-a -> topic-b, plus a broken/retired thread) shared
with the Rust `thread` binary's own tests. They exercise the new frontmatter
fields (fronts/parents/kind/status/distilled), retired filtering, the derived
tree, backlinks, and the per-thread card inbox.
"""
import shutil
from datetime import datetime as _RealDatetime
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
    (topic-b/topic-a/root-mid-leaf/broken) instead of one inline file.
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
    "topic-b": {"fronts": ["health", "job"], "parents": ["topic-a"],
                  "kind": "standing", "distilled": "2026-07-10"},
    "topic-a": {"fronts": ["health"], "parents": [],
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
    assert "topic-b" in ids


def test_list_include_retired_shows_it(vault_client):
    data = vault_client.get("/api/threads?include=retired").get_json()
    ids = {t["id"] for t in data["threads"]}
    assert "broken-thread" in ids


def test_list_filters_by_front(vault_client):
    data = vault_client.get("/api/threads?front=job").get_json()
    ids = {t["id"] for t in data["threads"]}
    assert ids == {"topic-b"}   # only thread carrying the "job" front


def test_list_items_carry_fronts_parents_kind_status(vault_client):
    data = vault_client.get("/api/threads").get_json()
    topic_b = next(t for t in data["threads"] if t["id"] == "topic-b")
    assert topic_b["fronts"] == ["health", "job"]
    assert topic_b["parents"] == ["topic-a"]
    assert topic_b["kind"] == "standing"
    assert topic_b["status"] == "active"


def test_parse_thread_reads_people_cast(vault):
    # topic-b.md's fixture frontmatter carries `people: [alex]`.
    t = threads.parse_thread(vault / "Threads" / "topic-b.md")
    assert t["people"] == ["alex"]


def test_parse_thread_defaults_people_to_empty_list(vault):
    # topic-a.md predates the people: migration — no key at all.
    t = threads.parse_thread(vault / "Threads" / "topic-a.md")
    assert t["people"] == []


def test_roster_resolves_cast_to_slug_and_name(vault_client):
    data = vault_client.get("/api/threads").get_json()
    topic_b = next(t for t in data["threads"] if t["id"] == "topic-b")
    assert topic_b["people"] == [{"slug": "alex", "name": "Alex"}]


def test_detail_resolves_cast_to_slug_and_name(vault_client):
    t = vault_client.get("/api/thread?name=topic-b").get_json()
    assert t["people"] == [{"slug": "alex", "name": "Alex"}]


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
    assert tree["nodes"]["topic-b"]["people"] == ["alex"]


def test_threads_for_person_finds_cast_membership(vault):
    out = threads.threads_for_person("alex")
    assert [t["slug"] for t in out] == ["topic-b"]
    assert out[0]["name"] == "Topic B"


def test_threads_for_person_empty_for_unlisted_person(vault):
    assert threads.threads_for_person("jordan") == []


def test_detail_includes_backlinks(vault_client):
    # topic-b.md's body links [[topic-a]]; topic-a's backlinks
    # should therefore name topic-b.
    t = vault_client.get("/api/thread?name=topic-a").get_json()
    assert {b["slug"] for b in t["backlinks"]} == {"topic-b"}
    assert {b["name"] for b in t["backlinks"]} == {"Topic B"}


def test_detail_no_backlinks_for_unlinked_thread(vault_client):
    t = vault_client.get("/api/thread?name=root-thread").get_json()
    assert t["backlinks"] == []


def test_tree_children_inversion_across_the_chain(vault_client):
    tree = vault_client.get("/api/threads/tree").get_json()
    assert "root-thread" in tree["roots"]
    assert "topic-a" in tree["roots"]
    assert tree["nodes"]["root-thread"]["children"] == ["mid-thread"]
    assert tree["nodes"]["mid-thread"]["children"] == ["leaf-thread"]
    assert tree["nodes"]["topic-a"]["children"] == ["topic-b"]


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
        "parents: [topic-a, root-thread]\n"
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
    assert "shared-child" in tree["nodes"]["topic-a"]["children"]
    assert "shared-child" in tree["nodes"]["root-thread"]["children"]
    assert "shared-child" not in tree["roots"]


def test_inbox_filters_by_watermark_oldest_first(vault_client):
    # topic-b distilled: 2026-07-10. A card tagged topic-b dated
    # 2026-07-05 (before) is excluded; 07-12 and 07-14 (after) are included,
    # oldest first.
    data = vault_client.get("/api/thread/topic-b/inbox").get_json()
    assert [c["id"] for c in data["cards"]] == ["2026-07-12.1200a", "2026-07-14.1655c"]
    assert data["distilled"] == "2026-07-10"


def test_inbox_card_carries_full_body_who_and_tags(vault_client):
    data = vault_client.get("/api/thread/topic-b/inbox").get_json()
    card = data["cards"][0]
    assert card["who"] == "B"
    assert "topic-b" in card["tags"]
    assert "beta" in card["text"].lower()


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


# --- GET /api/thread/<slug>/journal ------------------------------------------
# topic-b.md (see fixture above) exercises tagged/cited union + dedupe +
# bare-day in one shot:
#   - tagged pool cards: 2026-07-05.0900a, 2026-07-12.1200a, 2026-07-14.1655c
#   - cited by id, found in pool, NOT tagged topic-b: 2026-07-08.1841b
#     (cited twice — under "What it is" and again under the "Pattern —
#     timing" bullet — so this also proves the dedupe)
#   - bare-day `2026-07-13` cited under "Pattern — timing" -> a day row
#     with that heading as its label

def test_journal_unions_tagged_and_cited_cards_deduped(vault_client):
    data = vault_client.get("/api/thread/topic-b/journal").get_json()
    card_ids = [e["id"] for e in data["entries"] if e["kind"] == "card"]
    assert card_ids == [
        "2026-07-05.0900a", "2026-07-08.1841b", "2026-07-12.1200a", "2026-07-14.1655c",
    ]
    # cited-by-id card not tagged topic-b still carries its pool body/who/ts.
    cited = next(e for e in data["entries"] if e.get("id") == "2026-07-08.1841b")
    assert cited["who"] == "B"
    assert cited["ts"] == "2026-07-08 18:41:00"
    assert "meeting" in cited["text"].lower()


def test_journal_bare_day_citation_becomes_day_row_with_heading_label(vault_client):
    data = vault_client.get("/api/thread/topic-b/journal").get_json()
    day = next(e for e in data["entries"] if e["kind"] == "day")
    assert day == {"kind": "day", "date": "2026-07-13", "label": "Pattern — timing", "excerpts": []}


def test_journal_sorts_ascending_day_row_interleaved_by_date(vault_client):
    data = vault_client.get("/api/thread/topic-b/journal").get_json()
    ordering = [(e["kind"], e.get("id") or e["date"]) for e in data["entries"]]
    assert ordering == [
        ("card", "2026-07-05.0900a"),
        ("card", "2026-07-08.1841b"),
        ("card", "2026-07-12.1200a"),
        ("day", "2026-07-13"),
        ("card", "2026-07-14.1655c"),
    ]


def test_journal_includes_thread_summary_with_resolved_cast(vault_client):
    data = vault_client.get("/api/thread/topic-b/journal").get_json()
    assert data["thread"]["id"] == "topic-b"
    assert data["thread"]["name"] == "Topic B"
    assert data["thread"]["status"] == "active"
    assert data["thread"]["kind"] == "standing"
    assert data["thread"]["fronts"] == ["health", "job"]
    assert data["thread"]["people"] == [{"slug": "alex", "name": "Alex"}]


def test_journal_cited_id_missing_from_pool_falls_back_to_day_row(vault):
    # A thread whose only source is a card id that predates the pool.
    (vault / "Threads" / "old-thread.md").write_text(
        "---\n"
        "name: Old Thread\n"
        "aliases: []\n"
        "fronts: [health]\n"
        "parents: []\n"
        "kind: standing\n"
        "status: active\n"
        "opened: 2025-01-01\n"
        "retired:\n"
        "distilled:\n"
        "---\n\n"
        "## Predates the card pool\n"
        "A statement from before cards were tracked.\n"
        "→ `2025-01-01.0000a`\n"
    )
    from flask import Flask
    app = Flask(__name__)
    app.config.update(TESTING=True)
    threads.register(app)
    data = app.test_client().get("/api/thread/old-thread/journal").get_json()
    assert data["entries"] == [
        {"kind": "day", "date": "2025-01-01", "label": "Predates the card pool", "excerpts": []},
    ]


def test_journal_day_row_sorts_before_same_day_card(vault):
    # Same as above, but this time a real pool card also lands on 2025-01-01,
    # tagged old-thread — the day row (missing-id fallback) must sort first.
    (vault / "Threads" / "old-thread.md").write_text(
        "---\n"
        "name: Old Thread\n"
        "aliases: []\n"
        "fronts: [health]\n"
        "parents: []\n"
        "kind: standing\n"
        "status: active\n"
        "opened: 2025-01-01\n"
        "retired:\n"
        "distilled:\n"
        "---\n\n"
        "## Predates the card pool\n"
        "A statement from before cards were tracked.\n"
        "→ `2025-01-01.0000a`\n"
    )
    cards_dir = vault / "_system" / "data" / "cards"
    (cards_dir / "2025-01-01.0900a.md").write_text(
        "---\n"
        "id: 2025-01-01.0900a\n"
        "who: B\n"
        "ts: 2025-01-01 09:00:00\n"
        "tags: [old-thread]\n"
        "kind: line\n"
        "---\n"
        "A same-day card, tagged directly.\n"
    )
    from flask import Flask
    app = Flask(__name__)
    app.config.update(TESTING=True)
    threads.register(app)
    data = app.test_client().get("/api/thread/old-thread/journal").get_json()
    ordering = [(e["kind"], e.get("id") or e["date"]) for e in data["entries"]]
    assert ordering == [("day", "2025-01-01"), ("card", "2025-01-01.0900a")]


def test_journal_unknown_slug_is_404(vault_client):
    resp = vault_client.get("/api/thread/nope-at-all/journal")
    assert resp.status_code == 404


# --- mention matches join the union -----------------------------------------
# topic-a.md's aliases: [topic a, TA] (see fixture above) make it a good
# subject for the substring-vs-word-boundary distinction.

def test_journal_includes_card_that_only_mentions_an_alias(vault):
    # Neither tagged `topic-a` nor cited by any fact-card — found purely
    # because its text mentions the "TA" alias as a standalone word.
    cards_dir = vault / "_system" / "data" / "cards"
    (cards_dir / "2026-07-20.0900a.md").write_text(
        "---\n"
        "id: 2026-07-20.0900a\n"
        "who: B\n"
        "ts: 2026-07-20 09:00:00\n"
        "tags: []\n"
        "kind: line\n"
        "---\n"
        "Thinking about it again, definitely TA came up today.\n"
    )
    from flask import Flask
    app = Flask(__name__)
    app.config.update(TESTING=True)
    threads.register(app)
    data = app.test_client().get("/api/thread/topic-a/journal").get_json()
    card_ids = [e["id"] for e in data["entries"] if e["kind"] == "card"]
    assert "2026-07-20.0900a" in card_ids


def test_journal_excludes_alias_matching_only_as_a_substring(vault):
    # "TA" appears inside "STAT" — not a word-boundary match, so this card
    # must NOT join topic-a's journal.
    cards_dir = vault / "_system" / "data" / "cards"
    (cards_dir / "2026-07-20.0900a.md").write_text(
        "---\n"
        "id: 2026-07-20.0900a\n"
        "who: B\n"
        "ts: 2026-07-20 09:00:00\n"
        "tags: []\n"
        "kind: line\n"
        "---\n"
        "Ran the STAT check after lunch.\n"
    )
    from flask import Flask
    app = Flask(__name__)
    app.config.update(TESTING=True)
    threads.register(app)
    data = app.test_client().get("/api/thread/topic-a/journal").get_json()
    card_ids = [e["id"] for e in data["entries"] if e["kind"] == "card"]
    assert "2026-07-20.0900a" not in card_ids


def test_journal_thread_payload_echoes_aliases(vault_client):
    data = vault_client.get("/api/thread/topic-a/journal").get_json()
    assert data["thread"]["aliases"] == ["topic a", "TA"]


# --- keeper-authored cards are excluded --------------------------------------

def test_journal_excludes_keeper_authored_cards(vault):
    # Her call (2026-07-20): a thread's journal is her record — a `who: K`
    # card never appears, whether it arrived tagged, by mention, or cited.
    cards_dir = vault / "_system" / "data" / "cards"
    (cards_dir / "2026-07-20.0900k.md").write_text(
        "---\n"
        "id: 2026-07-20.0900k\n"
        "who: K\n"
        "ts: 2026-07-20 09:00:00\n"
        "tags: [topic-a]\n"
        "kind: line\n"
        "---\n"
        "Keeper commentary about her TA day.\n"
    )
    (cards_dir / "2026-07-20.0905b.md").write_text(
        "---\n"
        "id: 2026-07-20.0905b\n"
        "who: B\n"
        "ts: 2026-07-20 09:05:00\n"
        "tags: [topic-a]\n"
        "kind: line\n"
        "---\n"
        "My own words about the TA day.\n"
    )
    from flask import Flask
    app = Flask(__name__)
    app.config.update(TESTING=True)
    threads.register(app)
    data = app.test_client().get("/api/thread/topic-a/journal").get_json()
    card_ids = [e["id"] for e in data["entries"] if e["kind"] == "card"]
    assert "2026-07-20.0905b" in card_ids
    assert "2026-07-20.0900k" not in card_ids


def test_journal_cited_keeper_card_yields_no_entry_and_no_day_row(vault):
    # A fact-card citing a K card by id: the card exists in the pool, so it
    # must not masquerade as a pre-pool id (no day-row fallback) — it simply
    # produces nothing.
    (vault / "Threads" / "k-cited.md").write_text(
        "---\n"
        "name: K Cited\n"
        "aliases: []\n"
        "fronts: [health]\n"
        "parents: []\n"
        "kind: standing\n"
        "status: active\n"
        "opened: 2026-07-20\n"
        "retired:\n"
        "distilled:\n"
        "---\n\n"
        "## Something the keeper noted\n"
        "A cited keeper observation.\n"
        "→ `2026-07-19.2100k`\n"
    )
    cards_dir = vault / "_system" / "data" / "cards"
    (cards_dir / "2026-07-19.2100k.md").write_text(
        "---\n"
        "id: 2026-07-19.2100k\n"
        "who: K\n"
        "ts: 2026-07-19 21:00:00\n"
        "tags: []\n"
        "kind: line\n"
        "---\n"
        "A keeper note that got cited.\n"
    )
    from flask import Flask
    app = Flask(__name__)
    app.config.update(TESTING=True)
    threads.register(app)
    data = app.test_client().get("/api/thread/k-cited/journal").get_json()
    assert data["entries"] == []


# --- day-row excerpts: pre-card-pool blob days, mention-windowed ------------
# A day row for a date with NO pool card at all gets `excerpts` pulled from
# that day's markdown blob (Journal/Daily/<date>.md) around every mention of
# the thread — bounded to ~40 words each side (EXCERPT_WINDOW_WORDS), merging
# overlapping windows, capped at MAX_EXCERPTS_PER_DAY. Each fixture file below
# uses the real blob shape: `# <date>` title, `` `B = you | K = keeper` ``
# legend, then `---`, mirroring what _strip_day_blob_header expects to strip.

def _thread_with_bare_day(name, date):
    slug = name.lower()
    return (
        "---\n"
        f"name: {name}\n"
        "aliases: []\n"
        "fronts: [health]\n"
        "parents: []\n"
        "kind: standing\n"
        "status: active\n"
        "opened: 2026-08-01\n"
        "retired:\n"
        "distilled:\n"
        "---\n\n"
        "## Bare day\n"
        "Referenced without a specific card.\n"
        f"→ `{date}`\n"
    ), slug


def _day_blob(date, body):
    return f"# {date}\n\n`B = you | K = keeper`\n\n---\n\n{body}\n"


def test_journal_day_excerpt_single_mention_gets_bounded_window(vault, vault_client):
    thread_md, slug = _thread_with_bare_day("Zendoria", "2026-08-01")
    (vault / "Threads" / f"{slug}.md").write_text(thread_md)
    before = " ".join(f"pre{i}" for i in range(60))
    after = " ".join(f"post{i}" for i in range(60))
    (vault / "Journal" / "Daily" / "2026-08-01.md").write_text(
        _day_blob("2026-08-01", f"{before} Zendoria {after}")
    )
    data = vault_client.get(f"/api/thread/{slug}/journal").get_json()
    day = next(e for e in data["entries"] if e["kind"] == "day")
    assert len(day["excerpts"]) == 1
    excerpt = day["excerpts"][0]
    assert excerpt.startswith("…") and excerpt.endswith("…")
    assert "Zendoria" in excerpt
    # window is 40 words each side of the match: pre20..pre59 kept, pre0..19 clipped.
    assert "pre59" in excerpt and "pre0" not in excerpt
    assert "post39" in excerpt and "post40" not in excerpt


def test_journal_day_excerpt_merges_overlapping_windows(vault, vault_client):
    thread_md, slug = _thread_with_bare_day("Windmere", "2026-08-02")
    (vault / "Threads" / f"{slug}.md").write_text(thread_md)
    before = " ".join(f"pre{i}" for i in range(60))
    mid = " ".join(f"mid{i}" for i in range(20))
    after = " ".join(f"post{i}" for i in range(60))
    (vault / "Journal" / "Daily" / "2026-08-02.md").write_text(
        _day_blob("2026-08-02", f"{before} Windmere {mid} Windmere {after}")
    )
    data = vault_client.get(f"/api/thread/{slug}/journal").get_json()
    day = next(e for e in data["entries"] if e["kind"] == "day")
    # The two mentions are only ~21 words apart — well inside 2*40 — so their
    # windows overlap and merge into a single excerpt carrying both.
    assert len(day["excerpts"]) == 1
    assert day["excerpts"][0].count("Windmere") == 2


def test_journal_day_excerpt_empty_when_day_has_pool_cards(vault, vault_client):
    thread_md, slug = _thread_with_bare_day("Halcyon", "2026-08-03")
    (vault / "Threads" / f"{slug}.md").write_text(thread_md)
    (vault / "Journal" / "Daily" / "2026-08-03.md").write_text(
        _day_blob("2026-08-03", "Halcyon showed up today, more Halcyon talk than usual.")
    )
    # An unrelated (untagged, unmentioning) pool card dated the same day is
    # enough to disqualify the day from excerpting — "regardless of tags".
    cards_dir = vault / "_system" / "data" / "cards"
    (cards_dir / "2026-08-03.0900a.md").write_text(
        "---\n"
        "id: 2026-08-03.0900a\n"
        "who: B\n"
        "ts: 2026-08-03 09:00:00\n"
        "tags: []\n"
        "kind: line\n"
        "---\n"
        "Something entirely unrelated.\n"
    )
    data = vault_client.get(f"/api/thread/{slug}/journal").get_json()
    day = next(e for e in data["entries"] if e["kind"] == "day" and e["date"] == "2026-08-03")
    assert day["excerpts"] == []


def test_journal_day_excerpt_empty_when_blob_file_missing(vault, vault_client):
    thread_md, slug = _thread_with_bare_day("Cinderfield", "2026-08-04")
    (vault / "Threads" / f"{slug}.md").write_text(thread_md)
    # No Journal/Daily/2026-08-04.md written at all.
    data = vault_client.get(f"/api/thread/{slug}/journal").get_json()
    day = next(e for e in data["entries"] if e["kind"] == "day")
    assert day["excerpts"] == []


def test_journal_day_excerpt_short_blob_has_no_ellipses(vault, vault_client):
    thread_md, slug = _thread_with_bare_day("Petrichor", "2026-08-05")
    (vault / "Threads" / f"{slug}.md").write_text(thread_md)
    (vault / "Journal" / "Daily" / "2026-08-05.md").write_text(
        _day_blob("2026-08-05", "Petrichor after the storm, a good smell.")
    )
    data = vault_client.get(f"/api/thread/{slug}/journal").get_json()
    day = next(e for e in data["entries"] if e["kind"] == "day")
    assert len(day["excerpts"]) == 1
    excerpt = day["excerpts"][0]
    assert not excerpt.startswith("…") and not excerpt.endswith("…")
    assert "Petrichor" in excerpt


# --- card entries carry `reply_to` and rolling-24h `editable` ---------------
# The thread page lets her edit/delete a card minted in the last 24 hours in
# place, and append a reply note to an older one instead — both server-
# computed (never trust the client's Date), so these pin the cutoff math
# down against a frozen clock.

class _FrozenDatetime(_RealDatetime):
    """A datetime subclass whose .now() is pinned — patched onto
    routes.threads.datetime itself so strptime etc. still behave normally,
    only "now" is fixed for a deterministic 24h-window test."""

    _frozen = _RealDatetime(2026, 7, 20, 12, 0, 0)

    @classmethod
    def now(cls, tz=None):
        return cls._frozen


def test_journal_card_within_rolling_24h_is_editable(vault, vault_client, monkeypatch):
    monkeypatch.setattr(threads, "datetime", _FrozenDatetime)
    cards_dir = vault / "_system" / "data" / "cards"
    (cards_dir / "2026-07-20.1100b.md").write_text(
        "---\n"
        "id: 2026-07-20.1100b\n"
        "who: B\n"
        "ts: 2026-07-20 12:00:00\n"
        "tags: [topic-b]\n"
        "kind: line\n"
        "---\n"
        "Fresh note, minted right now.\n"
    )
    data = vault_client.get("/api/thread/topic-b/journal").get_json()
    card = next(e for e in data["entries"] if e.get("id") == "2026-07-20.1100b")
    assert card["editable"] is True


def test_journal_card_25h_old_is_not_editable(vault, vault_client, monkeypatch):
    monkeypatch.setattr(threads, "datetime", _FrozenDatetime)
    cards_dir = vault / "_system" / "data" / "cards"
    (cards_dir / "2026-07-19.1100b.md").write_text(
        "---\n"
        "id: 2026-07-19.1100b\n"
        "who: B\n"
        "ts: 2026-07-19 11:00:00\n"
        "tags: [topic-b]\n"
        "kind: line\n"
        "---\n"
        "A day-old note, just past the rolling 24h window.\n"
    )
    data = vault_client.get("/api/thread/topic-b/journal").get_json()
    card = next(e for e in data["entries"] if e.get("id") == "2026-07-19.1100b")
    assert card["editable"] is False


def test_journal_card_with_unparseable_ts_is_not_editable(vault, vault_client, monkeypatch):
    monkeypatch.setattr(threads, "datetime", _FrozenDatetime)
    cards_dir = vault / "_system" / "data" / "cards"
    (cards_dir / "2026-07-20.1200c.md").write_text(
        "---\n"
        "id: 2026-07-20.1200c\n"
        "who: B\n"
        "ts: \n"
        "tags: [topic-b]\n"
        "kind: line\n"
        "---\n"
        "A card with no usable timestamp.\n"
    )
    data = vault_client.get("/api/thread/topic-b/journal").get_json()
    card = next(e for e in data["entries"] if e.get("id") == "2026-07-20.1200c")
    assert card["editable"] is False


def test_journal_card_reply_to_round_trips(vault, vault_client):
    cards_dir = vault / "_system" / "data" / "cards"
    (cards_dir / "2026-07-20.0900b.md").write_text(
        "---\n"
        "id: 2026-07-20.0900b\n"
        "who: B\n"
        "ts: 2026-07-20 09:00:00\n"
        "reply_to: 2026-07-14.1655c\n"
        "tags: [topic-b]\n"
        "kind: line\n"
        "---\n"
        "Following up on the earlier note.\n"
    )
    data = vault_client.get("/api/thread/topic-b/journal").get_json()
    reply = next(e for e in data["entries"] if e.get("id") == "2026-07-20.0900b")
    assert reply["reply_to"] == "2026-07-14.1655c"
    # A card without reply_to frontmatter at all still round-trips to null.
    parent = next(e for e in data["entries"] if e.get("id") == "2026-07-14.1655c")
    assert parent["reply_to"] is None
