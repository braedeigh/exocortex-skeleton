"""Pending approval gate — the todo_done kind (routes/pending.py).

The todos-closer cricket stages "this journal card closes to-do X" with a
verbatim quote; Approve verifies the quote against the card ON DISK, then
closes the item backdated to the card's moment with the card id as receipt.
These tests pin the whole contract: the verification tripwire (a fabricated
quote must never reach the record), the backdating, the receipt fields, and
the same id-first identity rule every other todos route follows.

No Rust binary and no journal engine needed: _commit_todo_done writes through
store directly, and _rerender_days is a silent no-op in the test env.
"""
from pathlib import Path

import pytest
from flask import Flask

import store
from routes import pending


CARD_ID = "2026-08-12.2142b"
CARD_BODY = "Desk is DONE. built the whole thing tonight, arms mounted and everything"


def _mint_card(content_dir: Path, cid: str, body: str) -> None:
    """Write one pool card in the real on-disk format (five-field header)."""
    pool = content_dir / "_system" / "data" / "cards"
    pool.mkdir(parents=True, exist_ok=True)
    ts = f"{cid[:10]} {cid[11:13]}:{cid[13:15]}:07"
    (pool / f"{cid}.md").write_text(
        f"---\nid: {cid}\nwho: B\nts: {ts}\nreply_to: null\ntags: []\nkind: line\n---\n{body}\n",
        encoding="utf-8",
    )


@pytest.fixture
def vault(tmp_path, monkeypatch):
    """Throwaway data + content dirs, one card on disk, one open to-do."""
    data = tmp_path / "data"
    content = tmp_path / "content"
    data.mkdir()
    monkeypatch.setattr(store, "DATA_DIR", data)
    monkeypatch.setattr(store, "CONTENT_DIR", content)
    _mint_card(content, CARD_ID, CARD_BODY)
    store.write("todos", {
        "now": {"items": [{
            "id": "desk_assembly",
            "text": "assemble the desk",
            "done": False,
            "subtasks": [{"text": "mount the arms", "done": False}],
        }]},
        "done": {"items": []},
    })
    return data, content


@pytest.fixture
def client(vault):
    app = Flask(__name__)
    app.config.update(TESTING=True)
    pending.register(app)
    return app.test_client()


def _stage(change):
    store.write("pending_changes", {"pending": [change]})


def _change(**payload_overrides):
    payload = {
        "id": "desk_assembly",
        "text": "assemble the desk",
        "card_id": CARD_ID,
        "quote": "built the whole thing tonight, arms mounted",
    }
    payload.update(payload_overrides)
    return {"id": "abc12345", "kind": "todo_done", "payload": payload}


def _find_todo(tid):
    todos = store.read("todos", {})
    for sec in todos.values():
        for item in sec.get("items", []):
            if item.get("id") == tid:
                return item
    return None


def test_approve_closes_backdated_to_the_cards_moment(client):
    change = _change()
    _stage(change)
    res = client.post("/api/pending/approve", json={"id": change["id"]})
    assert res.status_code == 200
    item = _find_todo("desk_assembly")
    assert item["done"] is True
    # Backdated placement: the card's day + minute, not the approval moment.
    assert item["finished_on"] == "2026-08-12"
    assert item["finished_time"] == "21:42"
    # The receipt: card id + her verbatim words.
    assert item["receipt"] == CARD_ID
    assert item["receipt_quote"] == change["payload"]["quote"]
    # done_at stays honest — the marking moment, minute precision.
    assert len(item["done_at"]) == 16
    # Subtasks cascade, mirroring the toggle route.
    assert all(s["done"] for s in item["subtasks"])
    # The queue entry is gone.
    assert store.read("pending_changes", {"pending": []})["pending"] == []


def test_fabricated_quote_is_refused_and_nothing_changes(client):
    change = _change(quote="I definitely finished this thing for sure")
    _stage(change)
    with pytest.raises(RuntimeError, match="quote not found"):
        client.post("/api/pending/approve", json={"id": change["id"]})
    # The tripwire held: item untouched, change still queued for a Deny.
    assert _find_todo("desk_assembly")["done"] is False
    assert len(store.read("pending_changes", {"pending": []})["pending"]) == 1


def test_quote_check_survives_rewrapped_whitespace(client):
    change = _change(quote="built the whole\n  thing tonight,   arms mounted")
    _stage(change)
    res = client.post("/api/pending/approve", json={"id": change["id"]})
    assert res.status_code == 200
    assert _find_todo("desk_assembly")["done"] is True


def test_identity_is_by_id_so_same_text_items_stay_independent(client):
    with store.mutate("todos", {}) as todos:
        todos["now"]["items"].append(
            {"id": "desk_assembly_2", "text": "assemble the desk", "done": False})
    change = _change(id="desk_assembly_2")
    _stage(change)
    client.post("/api/pending/approve", json={"id": change["id"]})
    assert _find_todo("desk_assembly_2")["done"] is True
    assert _find_todo("desk_assembly")["done"] is False


def test_already_done_item_is_refused_not_overwritten(client):
    with store.mutate("todos", {}) as todos:
        item = todos["now"]["items"][0]
        item["done"] = True
        item["done_at"] = "2026-08-11T09:00"
    change = _change()
    _stage(change)
    with pytest.raises(RuntimeError, match="already done"):
        client.post("/api/pending/approve", json={"id": change["id"]})
    # Her own stamp survives untouched.
    assert _find_todo("desk_assembly")["done_at"] == "2026-08-11T09:00"


def test_missing_card_is_refused(client):
    change = _change(card_id="2026-08-12.0999b")
    _stage(change)
    with pytest.raises(RuntimeError, match="card not found"):
        client.post("/api/pending/approve", json={"id": change["id"]})
    assert _find_todo("desk_assembly")["done"] is False
