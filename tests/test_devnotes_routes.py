"""HTTP contract for the dev-notes routes, esp. /api/devnote/to_ideas."""
import pytest

import store


@pytest.fixture
def client(data_dir, tmp_path, monkeypatch):
    """Minimal app exposing only the devnotes routes, with the ideas doc
    pointed at a scratch file."""
    monkeypatch.setattr(store, "IDEAS_FILE", tmp_path / "IDEAS.md")
    from flask import Flask
    from routes import devnotes
    app = Flask(__name__)
    app.config.update(TESTING=True)
    devnotes.register(app)
    return app.test_client()


def read_notes(tab):
    return store.read("dev_notes.json", {"tabs": {}}).get("tabs", {}).get(tab, [])


def _add(client, tab, text):
    res = client.post("/api/devnote/add", json={"tab": tab, "text": text})
    assert res.status_code == 200
    return read_notes(tab)[-1]["id"]


def test_add_and_get_roundtrip(client):
    _add(client, "today", "fix the thing")
    res = client.get("/api/devnotes/today")
    assert res.get_json()["notes"][0]["text"] == "fix the thing"


def test_to_ideas_appends_and_removes_note(client):
    nid = _add(client, "today", "big product idea")
    res = client.post("/api/devnote/to_ideas", json={"tab": "today", "id": nid})
    assert res.status_code == 200
    assert read_notes("today") == []
    text = store.IDEAS_FILE.read_text()
    assert "big product idea" in text
    assert "## Inbox — sent from dev notes" in text


def test_to_ideas_creates_file_then_prepends_under_header(client):
    first = _add(client, "kitchen", "older idea")
    client.post("/api/devnote/to_ideas", json={"tab": "kitchen", "id": first})
    second = _add(client, "kitchen", "newer idea")
    client.post("/api/devnote/to_ideas", json={"tab": "kitchen", "id": second})
    text = store.IDEAS_FILE.read_text()
    assert text.index("newer idea") < text.index("older idea")
    assert text.count("## Inbox — sent from dev notes") == 1


def test_to_ideas_appends_to_existing_doc_without_clobbering(client):
    store.IDEAS_FILE.write_text("# Ideas\n\n## Core Concept\n\nthe vision\n")
    nid = _add(client, "body", "POTS tracker idea")
    client.post("/api/devnote/to_ideas", json={"tab": "body", "id": nid})
    text = store.IDEAS_FILE.read_text()
    assert "the vision" in text
    assert text.index("POTS tracker idea") > text.index("the vision")


def test_to_ideas_unknown_note_404s_and_keeps_notes(client):
    nid = _add(client, "today", "keep me")
    res = client.post("/api/devnote/to_ideas", json={"tab": "today", "id": "nope"})
    assert res.status_code == 404
    assert len(read_notes("today")) == 1
    assert nid == read_notes("today")[0]["id"]


# --- /api/devnote/restore (undo of delete / send-to-ideas) ---

def test_restore_reinserts_deleted_note_at_its_index(client):
    _add(client, "today", "first")
    nid = _add(client, "today", "second")
    _add(client, "today", "third")
    note = read_notes("today")[1]
    client.post("/api/devnote/remove", json={"tab": "today", "id": nid})
    res = client.post("/api/devnote/restore", json={"tab": "today", "note": note, "index": 1})
    assert res.status_code == 200
    restored = read_notes("today")
    assert [n["text"] for n in restored] == ["first", "second", "third"]
    assert restored[1]["id"] == nid
    assert restored[1]["created"] == note["created"]   # timestamp survives the round trip


def test_restore_undoes_send_to_ideas_completely(client):
    nid = _add(client, "today", "actually still a bug")
    note = read_notes("today")[0]
    client.post("/api/devnote/to_ideas", json={"tab": "today", "id": nid})
    assert "actually still a bug" in store.IDEAS_FILE.read_text()
    res = client.post("/api/devnote/restore",
                      json={"tab": "today", "note": note, "index": 0, "remove_from_ideas": True})
    assert res.status_code == 200
    assert read_notes("today")[0]["id"] == nid
    assert "actually still a bug" not in store.IDEAS_FILE.read_text()


def test_restore_twice_does_not_duplicate(client):
    nid = _add(client, "today", "only once")
    note = read_notes("today")[0]
    client.post("/api/devnote/remove", json={"tab": "today", "id": nid})
    client.post("/api/devnote/restore", json={"tab": "today", "note": note, "index": 0})
    client.post("/api/devnote/restore", json={"tab": "today", "note": note, "index": 0})
    assert len(read_notes("today")) == 1
