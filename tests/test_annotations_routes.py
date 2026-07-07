"""Behavioral tests for routes/annotations.py — the generic doc-scoped
annotation CRUD + docstore passthrough.

Mirrors tests/test_research_routes.py: a minimal Flask app registering only
the module under test, isolated data via the `data_dir` fixture. `entry:`-
namespaced docs are exercised via docstore.save_entry_text (writes under the
per-test DATA_DIR); `note:`-namespaced docs via a monkeypatched
store.RESEARCH_DIR, same pattern as test_research_routes.py's library tests.
"""
import json

import pytest

from conftest import data_dir  # noqa: F401  (imported for fixture visibility)


def _post(client, path, payload):
    return client.post(path, data=json.dumps(payload), content_type="application/json")


@pytest.fixture
def client(data_dir):
    """A test client for a minimal app exposing only the annotations routes."""
    from flask import Flask
    from routes import annotations
    app = Flask(__name__)
    app.config.update(TESTING=True)
    annotations.register(app)
    return app.test_client()


def _read():
    import store
    return store.read("annotations.json", {"annotations": []})


def _seed_entry_text(entry_id, text):
    import docstore
    docstore.save_entry_text(entry_id, text)
    return f"entry:{entry_id}"


# --- add ---------------------------------------------------------------------

def test_add_human_annotation_needs_no_review(client):
    doc = _seed_entry_text("e1", "the quick brown fox jumps over the lazy dog")
    r = _post(client, "/api/annotations/add",
              {"doc": doc, "char_start": 4, "char_end": 9, "content": {"note": "hi"}})
    assert r.status_code == 200
    body = r.get_json()
    assert body["ok"] is True
    ann = body["annotations"][0]
    assert ann["needs_review"] is False
    assert ann["selector"]["exact"] == "quick"
    assert ann["id"].startswith("ann-")
    assert ann["created"]


def test_add_llm_source_is_born_needing_review(client):
    doc = _seed_entry_text("e2", "the quick brown fox")
    r = _post(client, "/api/annotations/add",
              {"doc": doc, "char_start": 4, "char_end": 9,
               "content": {"kind": "highlight", "source": "llm"}})
    ann = r.get_json()["annotations"][0]
    assert ann["needs_review"] is True
    assert ann["content"]["source"] == "llm"


def test_add_explicit_needs_review_overrides_convention(client):
    doc = _seed_entry_text("e3", "the quick brown fox")
    r = _post(client, "/api/annotations/add",
              {"doc": doc, "char_start": 4, "char_end": 9,
               "content": {"source": "human"}, "needs_review": True})
    ann = r.get_json()["annotations"][0]
    assert ann["needs_review"] is True


def test_add_default_content_is_empty_map_and_human(client):
    doc = _seed_entry_text("e4", "the quick brown fox")
    r = _post(client, "/api/annotations/add", {"doc": doc, "char_start": 4, "char_end": 9})
    ann = r.get_json()["annotations"][0]
    assert ann["content"] == {}
    assert ann["needs_review"] is False


def test_add_bad_range_400_writes_nothing(client):
    doc = _seed_entry_text("e5", "short")
    r = _post(client, "/api/annotations/add", {"doc": doc, "char_start": 0, "char_end": 999})
    assert r.status_code == 400
    assert _read()["annotations"] == []


def test_add_unknown_namespace_400_writes_nothing(client):
    r = _post(client, "/api/annotations/add",
              {"doc": "journal:2026-07-06", "char_start": 0, "char_end": 3})
    assert r.status_code == 400
    assert _read()["annotations"] == []


def test_add_missing_entry_text_404(client):
    r = _post(client, "/api/annotations/add",
              {"doc": "entry:does-not-exist", "char_start": 0, "char_end": 3})
    assert r.status_code == 404


# --- doc-text passthrough ------------------------------------------------

def test_doc_text_passthrough_for_note_file(client, tmp_path, monkeypatch):
    import store
    monkeypatch.setattr(store, "RESEARCH_DIR", tmp_path)
    (tmp_path / "melatonin.md").write_text("# Melatonin\n\nsome body text")
    r = client.get("/api/annotations/doc-text", query_string={"doc": "note:melatonin.md"})
    assert r.status_code == 200
    body = r.get_json()
    assert body["ok"] is True
    assert body["title"] == "Melatonin"
    assert "some body text" in body["text"]


def test_doc_text_404_for_missing_note(client, tmp_path, monkeypatch):
    import store
    monkeypatch.setattr(store, "RESEARCH_DIR", tmp_path)
    r = client.get("/api/annotations/doc-text", query_string={"doc": "note:nope.md"})
    assert r.status_code == 404


def test_doc_text_400_for_unknown_namespace(client):
    r = client.get("/api/annotations/doc-text", query_string={"doc": "journal:x"})
    assert r.status_code == 400


# --- GET resolves states (verified / relocated / lost) --------------------

def test_get_resolves_verified_then_relocated_then_lost(client):
    import docstore
    doc = _seed_entry_text("e6", "the quick brown fox jumps")
    add = _post(client, "/api/annotations/add", {"doc": doc, "char_start": 4, "char_end": 9})
    aid = add.get_json()["annotations"][0]["id"]

    # Still verified against the unchanged text.
    r = client.get("/api/annotations", query_string={"doc": doc})
    ann = r.get_json()["annotations"][0]
    assert ann["state"] == "verified"
    assert ann["selector"]["exact"] == "quick"

    # Shift the text (prefix insert) — the quote still exists elsewhere.
    docstore.save_entry_text("e6", "NOTE: the quick brown fox jumps")
    r2 = client.get("/api/annotations", query_string={"doc": doc})
    ann2 = next(a for a in r2.get_json()["annotations"] if a["id"] == aid)
    assert ann2["state"] == "relocated"
    assert ann2["selector"]["char_start"] == len("NOTE: the ")

    # Delete the quoted word entirely — now it's lost.
    docstore.save_entry_text("e6", "NOTE: the slow brown fox jumps")
    r3 = client.get("/api/annotations", query_string={"doc": doc})
    ann3 = next(a for a in r3.get_json()["annotations"] if a["id"] == aid)
    assert ann3["state"] == "lost"


def test_get_unresolved_when_doc_text_unavailable(client):
    import store
    with store.mutate("annotations.json", {"annotations": []}) as data:
        data["annotations"].append({
            "id": "ann-orphan", "doc": "entry:ghost",
            "content": {}, "needs_review": False,
            "selector": {"exact": "x", "char_start": 0, "char_end": 1},
            "created": "2026-07-06 00:00",
        })
    r = client.get("/api/annotations", query_string={"doc": "entry:ghost"})
    body = r.get_json()
    assert body["ok"] is True
    assert body["annotations"][0]["state"] == "unresolved"


# --- edit ----------------------------------------------------------------

def test_edit_flips_needs_review(client):
    doc = _seed_entry_text("e7", "the quick brown fox")
    add = _post(client, "/api/annotations/add", {"doc": doc, "char_start": 4, "char_end": 9})
    aid = add.get_json()["annotations"][0]["id"]
    r = _post(client, "/api/annotations/edit", {"id": aid, "needs_review": True})
    assert r.status_code == 200
    ann = next(a for a in r.get_json()["annotations"] if a["id"] == aid)
    assert ann["needs_review"] is True


def test_edit_replaces_content_map_no_deep_merge(client):
    doc = _seed_entry_text("e8", "the quick brown fox")
    add = _post(client, "/api/annotations/add",
                {"doc": doc, "char_start": 4, "char_end": 9, "content": {"a": 1, "b": 2}})
    aid = add.get_json()["annotations"][0]["id"]
    r = _post(client, "/api/annotations/edit", {"id": aid, "content": {"c": 3}})
    ann = next(a for a in r.get_json()["annotations"] if a["id"] == aid)
    assert ann["content"] == {"c": 3}


def test_edit_unknown_id_404(client):
    r = _post(client, "/api/annotations/edit", {"id": "ann-missing", "needs_review": True})
    assert r.status_code == 404


# --- remove ----------------------------------------------------------------

def test_remove_deletes_by_id(client):
    doc = _seed_entry_text("e9", "the quick brown fox")
    add1 = _post(client, "/api/annotations/add", {"doc": doc, "char_start": 0, "char_end": 3})
    add2 = _post(client, "/api/annotations/add", {"doc": doc, "char_start": 4, "char_end": 9})
    id1 = add1.get_json()["annotations"][0]["id"]
    r = _post(client, "/api/annotations/remove", {"id": id1})
    assert r.status_code == 200
    remaining_ids = [a["id"] for a in r.get_json()["annotations"]]
    assert id1 not in remaining_ids
    assert len(_read()["annotations"]) == 1


def test_remove_unknown_id_404(client):
    r = _post(client, "/api/annotations/remove", {"id": "ann-missing"})
    assert r.status_code == 404
