"""HTTP contract for the dev-note + idea-note panel routes."""
import pytest

import store


@pytest.fixture
def client(data_dir):
    """Minimal app exposing only the devnotes/ideanotes routes."""
    from flask import Flask
    from routes import devnotes
    app = Flask(__name__)
    app.config.update(TESTING=True)
    devnotes.register(app)
    return app.test_client()


def read_dev(tab):
    return store.read("dev_notes.json", {"tabs": {}}).get("tabs", {}).get(tab, [])


def read_idea(tab):
    return store.read("idea_notes.json", {"tabs": {}}).get("tabs", {}).get(tab, [])


def _add(client, tab, text, kind="devnote"):
    res = client.post(f"/api/{kind}/add", json={"tab": tab, "text": text})
    assert res.status_code == 200
    notes = read_dev(tab) if kind == "devnote" else read_idea(tab)
    return notes[-1]["id"]


def test_add_and_get_roundtrip(client):
    _add(client, "today", "fix the thing")
    res = client.get("/api/devnotes/today")
    assert res.get_json()["notes"][0]["text"] == "fix the thing"


# --- night-crew questions ride the note until she answers ---

def _plant_questions(nid):
    with store.mutate("dev_notes.json", {"tabs": {}}) as d:
        for n in d["tabs"]["today"]:
            if n["id"] == nid:
                n["night_questions"] = "which page did you mean?"


def test_editing_the_text_clears_night_questions(client):
    """Her edit IS the answer — the amended text supersedes the worker's ask,
    and (via nightcrew's text-changed rule) is what re-queues the note."""
    nid = _add(client, "today", "fix the thing")
    _plant_questions(nid)
    res = client.post("/api/devnote/edit",
                      json={"tab": "today", "id": nid, "text": "fix the thing on the map page"})
    assert res.status_code == 200
    assert "night_questions" not in read_dev("today")[0]


def test_saving_unchanged_text_keeps_night_questions(client):
    """Opening the editor and hitting save without changing anything is not an
    answer — the questions stay until the words actually change."""
    nid = _add(client, "today", "fix the thing")
    _plant_questions(nid)
    client.post("/api/devnote/edit", json={"tab": "today", "id": nid, "text": "fix the thing"})
    assert read_dev("today")[0]["night_questions"] == "which page did you mean?"


# --- /api/devnote/to_ideas: dev note → same tab's idea notes ---

def test_to_ideas_moves_note_verbatim(client):
    nid = _add(client, "kitchen", "big product idea")
    created = read_dev("kitchen")[0]["created"]
    res = client.post("/api/devnote/to_ideas", json={"tab": "kitchen", "id": nid})
    assert res.status_code == 200
    assert read_dev("kitchen") == []
    moved = read_idea("kitchen")
    assert len(moved) == 1
    assert moved[0] == {"id": nid, "text": "big product idea", "created": created}


def test_to_ideas_unknown_note_404s_and_keeps_notes(client):
    nid = _add(client, "today", "keep me")
    res = client.post("/api/devnote/to_ideas", json={"tab": "today", "id": "nope"})
    assert res.status_code == 404
    assert len(read_dev("today")) == 1
    assert nid == read_dev("today")[0]["id"]
    assert read_idea("today") == []


def test_restore_undoes_send_to_ideas_completely(client):
    nid = _add(client, "today", "actually still a bug")
    note = read_dev("today")[0]
    client.post("/api/devnote/to_ideas", json={"tab": "today", "id": nid})
    res = client.post("/api/devnote/restore",
                      json={"tab": "today", "note": note, "index": 0, "remove_from_ideas": True})
    assert res.status_code == 200
    assert read_dev("today")[0] == note
    assert read_idea("today") == []


def test_to_ideas_redo_after_undo_does_not_duplicate(client):
    nid = _add(client, "today", "flip flop")
    note = read_dev("today")[0]
    client.post("/api/devnote/to_ideas", json={"tab": "today", "id": nid})
    client.post("/api/devnote/restore",
                json={"tab": "today", "note": note, "index": 0, "remove_from_ideas": True})
    client.post("/api/devnote/to_ideas", json={"tab": "today", "id": nid})
    assert len(read_idea("today")) == 1
    assert read_dev("today") == []


# --- /api/devnote/restore (undo of delete) ---

def test_restore_reinserts_deleted_note_at_its_index(client):
    _add(client, "today", "first")
    nid = _add(client, "today", "second")
    _add(client, "today", "third")
    note = read_dev("today")[1]
    client.post("/api/devnote/remove", json={"tab": "today", "id": nid})
    res = client.post("/api/devnote/restore", json={"tab": "today", "note": note, "index": 1})
    assert res.status_code == 200
    restored = read_dev("today")
    assert [n["text"] for n in restored] == ["first", "second", "third"]
    assert restored[1]["id"] == nid
    assert restored[1]["created"] == note["created"]   # timestamp survives the round trip


def test_restore_twice_does_not_duplicate(client):
    nid = _add(client, "today", "only once")
    note = read_dev("today")[0]
    client.post("/api/devnote/remove", json={"tab": "today", "id": nid})
    client.post("/api/devnote/restore", json={"tab": "today", "note": note, "index": 0})
    client.post("/api/devnote/restore", json={"tab": "today", "note": note, "index": 0})
    assert len(read_dev("today")) == 1


# --- Idea-note CRUD (the second panel over the same component) ---

def test_ideanote_add_defaults_to_general(client):
    res = client.post("/api/ideanote/add", json={"text": "an unscoped idea"})
    assert res.status_code == 200
    assert read_idea("general")[0]["text"] == "an unscoped idea"


def test_ideanote_add_edit_remove_roundtrip(client):
    nid = _add(client, "body", "POTS tracker", kind="ideanote")
    res = client.post("/api/ideanote/edit", json={"tab": "body", "id": nid, "text": "POTS + neck tracker"})
    assert res.status_code == 200
    assert read_idea("body")[0]["text"] == "POTS + neck tracker"
    client.post("/api/ideanote/remove", json={"tab": "body", "id": nid})
    assert read_idea("body") == []


def test_ideanote_edit_unknown_404s(client):
    _add(client, "body", "real", kind="ideanote")
    res = client.post("/api/ideanote/edit", json={"tab": "body", "id": "nope", "text": "x"})
    assert res.status_code == 404


def test_ideanote_restore_undoes_delete(client):
    nid = _add(client, "kitchen", "recipe scaler", kind="ideanote")
    note = read_idea("kitchen")[0]
    client.post("/api/ideanote/remove", json={"tab": "kitchen", "id": nid})
    res = client.post("/api/ideanote/restore", json={"tab": "kitchen", "note": note, "index": 0})
    assert res.status_code == 200
    assert read_idea("kitchen")[0] == note
