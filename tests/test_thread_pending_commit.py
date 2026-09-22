"""Pending approval gate — the three thread kinds (routes/pending.py, per
threads-architecture.md §8 step 3).

Unlike test_pending_routes.py (which mocks subprocess.run to pin the
add-todo command line), these tests shell out to the REAL `thread` binary
against a throwaway copy of tests/fixtures/threads/{content,data} — the same
fixture set the Rust CLI's own tests read. That's the point: `_commit` is a
thin wrapper, and the thing worth pinning down is that the file it produces
actually lints (i.e. parses back cleanly through parse_thread), not just that
some subprocess got called with the right-looking argv.

Skipped whole-module if the release binary isn't built yet.
"""
import shutil
from pathlib import Path

import pytest
from flask import Flask

import store
from routes import pending
from routes import threads as threads_routes

FIXTURES_ROOT = Path(__file__).parent / "fixtures" / "threads"

pytestmark = pytest.mark.skipif(
    not pending.THREAD_BIN.exists(),
    reason="thread binary not built — run `cargo build --release` in tools/thread/",
)


@pytest.fixture
def thread_vault(tmp_path, monkeypatch):
    """Fresh tmp copies of the shared fixture content + data dirs, with both
    store dirs monkeypatched — so `thread` (invoked with --content-dir/
    --data-dir pointed here) and parse_thread agree on where the files are."""
    content = tmp_path / "content"
    data = tmp_path / "data"
    shutil.copytree(FIXTURES_ROOT / "content", content)
    shutil.copytree(FIXTURES_ROOT / "data", data)
    monkeypatch.setattr(store, "CONTENT_DIR", content)
    monkeypatch.setattr(store, "DATA_DIR", data)
    return content, data


@pytest.fixture
def thread_client(thread_vault):
    app = Flask(__name__)
    app.config.update(TESTING=True)
    pending.register(app)
    return app.test_client()


def _approve(client, change):
    store.write("pending_changes", {"pending": [change]})
    return client.post("/api/pending/approve", json={"id": change["id"]})


def test_thread_open_with_cards_creates_a_file_that_lints(thread_client, thread_vault):
    content, _data = thread_vault
    change = {
        "id": "open1", "kind": "thread_open", "summary": "", "created": "",
        "payload": {
            "slug": "topic-c",
            "charter": "Waking in a panic mid-sleep. Out: ordinary insomnia.",
            "name": "Topic C",
            "fronts": ["health"],
            "parents": [],
            "kind": "standing",
            "aliases": ["terrors"],
            "cards": [
                {"section": "What it is", "text": "Waking in a panic mid-sleep.",
                 "source": "2026-07-05.0900a"},
            ],
        },
    }
    res = _approve(thread_client, change)
    assert res.status_code == 200

    path = content / "Threads" / "topic-c.md"
    assert path.exists()
    # Assert through parse_thread, not raw string matching.
    t = threads_routes.parse_thread(path)
    assert t["name"] == "Topic C"
    assert t["fronts"] == ["health"]
    assert t["kind"] == "standing"
    assert t["aliases"] == ["terrors"]
    assert len(t["cards"]) == 1
    card = t["cards"][0]
    assert card["heading"] == "What it is"
    assert card["sources"][0]["ref"] == "2026-07-05.0900a"


def test_thread_open_passes_a_repeated_source_flag_per_list_entry(thread_client, thread_vault):
    content, _data = thread_vault
    change = {
        "id": "open2", "kind": "thread_open", "summary": "", "created": "",
        "payload": {
            "slug": "multi-source-thread",
            "charter": "A fixture thread with two sources on a card. Out: anything real.",
            "name": "Multi Source Thread",
            "fronts": ["health"],
            "kind": "standing",
            "cards": [
                {"section": "What it is", "text": "Two sources on one card.",
                 "source": ["2026-07-05.0900a", "2026-07-08.1841b"]},
            ],
        },
    }
    res = _approve(thread_client, change)
    assert res.status_code == 200
    t = threads_routes.parse_thread(content / "Threads" / "multi-source-thread.md")
    refs = {s["ref"] for c in t["cards"] for s in c["sources"]}
    assert {"2026-07-05.0900a", "2026-07-08.1841b"} <= refs


def test_thread_open_failing_add_card_raises_and_leaves_item_queued(thread_client, thread_vault):
    # Known edge from the spec: a card whose source doesn't resolve (e.g.
    # deleted between staging and approval) fails add-card. The thread file
    # from `open` already exists, but the item must stay in the queue.
    content, _data = thread_vault
    change = {
        "id": "open3", "kind": "thread_open", "summary": "", "created": "",
        "payload": {
            "slug": "bad-source-thread",
            "charter": "A fixture thread citing a dead source. Out: anything real.",
            "name": "Bad Source Thread",
            "fronts": ["health"],
            "kind": "standing",
            "cards": [
                {"section": "What it is", "text": "Cites a card that doesn't exist.",
                 "source": "2099-01-01.9999z"},
            ],
        },
    }
    store.write("pending_changes", {"pending": [change]})
    with pytest.raises(RuntimeError):
        thread_client.post("/api/pending/approve", json={"id": "open3"})
    assert (content / "Threads" / "bad-source-thread.md").exists()
    assert store.read("pending_changes", {"pending": []})["pending"] != []


def test_thread_link_adds_a_front(thread_client, thread_vault):
    content, _data = thread_vault
    change = {
        "id": "link1", "kind": "thread_link", "summary": "", "created": "",
        "payload": {"slug": "topic-a", "add_fronts": ["practice"]},
    }
    res = _approve(thread_client, change)
    assert res.status_code == 200
    t = threads_routes.parse_thread(content / "Threads" / "topic-a.md")
    assert "practice" in t["fronts"]


def test_thread_link_edited_payload_from_the_approval_modal_flows_through(thread_client, thread_vault):
    # The existing approve flow merges the user's edited payload over the
    # staged one before _commit — pin that this still works for thread kinds.
    content, _data = thread_vault
    store.write("pending_changes", {"pending": [{
        "id": "link2", "kind": "thread_link", "summary": "", "created": "",
        "payload": {"slug": "topic-a", "add_fronts": ["job"]},
    }]})
    res = thread_client.post("/api/pending/approve", json={
        "id": "link2", "payload": {"add_fronts": ["practice"]},
    })
    assert res.status_code == 200
    t = threads_routes.parse_thread(content / "Threads" / "topic-a.md")
    assert "practice" in t["fronts"]
    assert "job" not in t["fronts"]   # the staged value was overridden, not merged in


def test_thread_retire_sets_status_and_stamps_a_date(thread_client, thread_vault):
    content, _data = thread_vault
    change = {
        "id": "retire1", "kind": "thread_retire", "summary": "", "created": "",
        "payload": {"slug": "mid-thread", "reason": "dormant 4+ weeks",
                    "last_card_date": "2026-06-01"},
    }
    res = _approve(thread_client, change)
    assert res.status_code == 200
    t = threads_routes.parse_thread(content / "Threads" / "mid-thread.md")
    assert t["status"] == "retired"
    assert t["retired"]   # a date got stamped, not left blank


def test_approved_thread_item_leaves_the_queue(thread_client, thread_vault):
    change = {
        "id": "retire2", "kind": "thread_retire", "summary": "", "created": "",
        "payload": {"slug": "leaf-thread", "reason": "dormant", "last_card_date": "2026-06-01"},
    }
    _approve(thread_client, change)
    assert store.read("pending_changes", {"pending": []})["pending"] == []


# ── charter: the one line of scope, carried from nomination to file ──────────
# A charter is prose in a YAML-ish header, so the interesting failure isn't
# "did it save" — it's whether a comma in it survives the round-trip through
# two hand-rolled frontmatter parsers (the Rust writer and _parse_frontmatter).

TRICKY_CHARTER = 'Sleep itself: onset, waking, dreams. Out: the "tired all day" thread, and meds.'


def test_thread_open_carries_the_charter_through_commas_colons_and_quotes(thread_client, thread_vault):
    content, _data = thread_vault
    change = {
        "id": "open4", "kind": "thread_open", "summary": "", "created": "",
        "payload": {
            "slug": "sleep",
            "name": "Sleep",
            "charter": TRICKY_CHARTER,
            "fronts": ["health"],
            "kind": "standing",
        },
    }
    res = _approve(thread_client, change)
    assert res.status_code == 200

    t = threads_routes.parse_thread(content / "Threads" / "sleep.md")
    # Byte-for-byte, and a STRING — not a list chopped at the commas.
    assert t["charter"] == TRICKY_CHARTER
    assert isinstance(t["charter"], str)


def test_thread_open_without_a_charter_is_refused_and_stays_queued(thread_client, thread_vault):
    content, _data = thread_vault
    store.write("pending_changes", {"pending": [{
        "id": "open5", "kind": "thread_open", "summary": "", "created": "",
        "payload": {
            "slug": "uncharted", "name": "Uncharted",
            "fronts": ["health"], "kind": "standing",
        },
    }]})
    with pytest.raises(RuntimeError):
        thread_client.post("/api/pending/approve", json={"id": "open5"})
    assert not (content / "Threads" / "uncharted.md").exists()
    assert store.read("pending_changes", {"pending": []})["pending"] != []


def test_threads_without_a_charter_read_as_empty_string_not_missing(thread_vault):
    # leaf-thread.md is the fixture deliberately left uncharted: files that
    # predate the field must still parse, with "" rather than a KeyError.
    content, _data = thread_vault
    t = threads_routes.parse_thread(content / "Threads" / "leaf-thread.md")
    assert t["charter"] == ""


def test_thread_link_recuts_a_charter_on_its_own(thread_client, thread_vault):
    content, _data = thread_vault
    before = threads_routes.parse_thread(content / "Threads" / "topic-a.md")
    change = {
        "id": "link3", "kind": "thread_link", "summary": "", "created": "",
        "payload": {"slug": "topic-a", "charter": TRICKY_CHARTER},
    }
    res = _approve(thread_client, change)
    assert res.status_code == 200

    after = threads_routes.parse_thread(content / "Threads" / "topic-a.md")
    assert after["charter"] == TRICKY_CHARTER
    # Charter-only: `link` isn't called at all, so membership is untouched.
    assert after["fronts"] == before["fronts"]
    assert after["parents"] == before["parents"]


def test_thread_link_applies_a_charter_and_a_membership_edit_together(thread_client, thread_vault):
    content, _data = thread_vault
    change = {
        "id": "link4", "kind": "thread_link", "summary": "", "created": "",
        "payload": {"slug": "topic-a", "charter": TRICKY_CHARTER,
                    "add_fronts": ["practice"]},
    }
    res = _approve(thread_client, change)
    assert res.status_code == 200
    t = threads_routes.parse_thread(content / "Threads" / "topic-a.md")
    assert t["charter"] == TRICKY_CHARTER
    assert "practice" in t["fronts"]
