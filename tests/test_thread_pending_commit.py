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
            "slug": "night-terrors",
            "name": "Night Terrors",
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

    path = content / "Threads" / "night-terrors.md"
    assert path.exists()
    # Assert through parse_thread, not raw string matching.
    t = threads_routes.parse_thread(path)
    assert t["name"] == "Night Terrors"
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
        "payload": {"slug": "long-covid", "add_fronts": ["practice"]},
    }
    res = _approve(thread_client, change)
    assert res.status_code == 200
    t = threads_routes.parse_thread(content / "Threads" / "long-covid.md")
    assert "practice" in t["fronts"]


def test_thread_link_edited_payload_from_the_approval_modal_flows_through(thread_client, thread_vault):
    # The existing approve flow merges the user's edited payload over the
    # staged one before _commit — pin that this still works for thread kinds.
    content, _data = thread_vault
    store.write("pending_changes", {"pending": [{
        "id": "link2", "kind": "thread_link", "summary": "", "created": "",
        "payload": {"slug": "long-covid", "add_fronts": ["job"]},
    }]})
    res = thread_client.post("/api/pending/approve", json={
        "id": "link2", "payload": {"add_fronts": ["practice"]},
    })
    assert res.status_code == 200
    t = threads_routes.parse_thread(content / "Threads" / "long-covid.md")
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
