"""Provenance on to-dos (todo_provenance.py + the doors that use it).

What can silently go wrong here: an agent's words landing in the owner's
`notes`; a long uncited note slipping past the cap; an owner add getting a
made-up agent origin (or vice versa); the SQL mirror inventing an author for
an item that predates the stamp. Each test pins one of those.
"""
import json

import pytest

from conftest import read_todos
import store
import todo_provenance as prov
import todostore


def _post(client, path, payload):
    return client.post(path, data=json.dumps(payload), content_type="application/json")


# --- the rules -----------------------------------------------------------------

def test_agent_note_requires_a_ref():
    with pytest.raises(prov.ProvenanceError):
        prov.make_agent_note("triage", "she said wait for the letter", [])


def test_agent_note_rejects_unknown_ref_kind():
    with pytest.raises(prov.ProvenanceError):
        prov.make_agent_note("triage", "x", ["vibes:trust me"])


def test_agent_note_is_capped():
    with pytest.raises(prov.ProvenanceError):
        prov.make_agent_note("triage", "a" * (prov.AGENT_NOTE_MAX + 1), ["card:2026-08-20.1432a"])


def test_agent_note_collapses_whitespace_and_dedupes_refs():
    n = prov.make_agent_note("triage", "  two\n  lines ", ["card:x", "card:x", "url:https://a"])
    assert n["text"] == "two lines"
    assert n["refs"] == ["card:x", "url:https://a"]
    assert n["by"] == "triage" and n["at"]


def test_owner_cannot_leave_an_agent_note():
    with pytest.raises(prov.ProvenanceError):
        prov.make_agent_note("owner", "hi", ["card:x"])


def test_agent_origin_picks_up_the_session_from_env(monkeypatch):
    monkeypatch.setenv("EXOCORTEX_CONV_ID", "conv42")
    assert prov.make_origin("triage")["conv"] == "conv42"
    assert "conv" not in prov.make_origin("owner")


# --- the add route ---------------------------------------------------------------

def test_add_from_the_form_is_stamped_owner(client, seed):
    seed()
    _post(client, "/api/todos/add", {"item": "buy milk", "section": "Now"})
    item = read_todos()["now"]["items"][0]
    assert item["origin"]["by"] == "owner" and item["origin"]["at"]
    assert "agent_notes" not in item


def test_add_via_approval_keeps_the_proposing_agent(client, seed):
    seed()
    r = _post(client, "/api/todos/add", {
        "item": "book dentist", "section": "Now",
        "origin": {"by": "cricket:todos", "conv": "c1"},
        "agent_note": {"text": "named in the morning entry", "refs": ["card:2026-08-26.0912a"]},
    })
    assert r.status_code == 200
    item = read_todos()["now"]["items"][0]
    assert item["origin"] == {"by": "cricket:todos", "at": item["origin"]["at"], "conv": "c1"}
    assert item["agent_notes"][0]["by"] == "cricket:todos"
    assert item["agent_notes"][0]["refs"] == ["card:2026-08-26.0912a"]
    assert "notes" not in item


def test_add_with_uncited_agent_note_is_refused_whole(client, seed):
    seed()
    r = _post(client, "/api/todos/add", {
        "item": "book dentist", "section": "Now",
        "origin": {"by": "cricket:todos"},
        "agent_note": {"text": "trust me"},
    })
    assert r.status_code == 400
    assert read_todos()["now"]["items"] == []


def test_owner_can_dismiss_an_agent_note(client, seed):
    seed({"now": {"items": [{"id": "t1", "text": "X", "done": False, "agent_notes": [
        {"by": "triage", "at": "2026-08-27T10:00", "text": "a", "refs": ["card:c"]},
        {"by": "triage", "at": "2026-08-27T10:01", "text": "b", "refs": ["card:c"]},
    ]}]}})
    r = _post(client, "/api/todos/agent_note/remove", {"id": "t1", "by": "triage", "at": "2026-08-27T10:00"})
    assert r.status_code == 200
    notes = read_todos()["now"]["items"][0]["agent_notes"]
    assert [n["text"] for n in notes] == ["b"]
    _post(client, "/api/todos/agent_note/remove", {"id": "t1", "by": "triage", "at": "2026-08-27T10:01"})
    assert "agent_notes" not in read_todos()["now"]["items"][0]


def test_dismissing_a_missing_agent_note_404s(client, seed):
    seed({"now": {"items": [{"id": "t1", "text": "X", "done": False}]}})
    r = _post(client, "/api/todos/agent_note/remove", {"id": "t1", "by": "triage", "at": "nope"})
    assert r.status_code == 404


# --- the CLI door --------------------------------------------------------------------

def test_cli_appends_a_cited_note_with_the_session(data_dir, monkeypatch, capsys):
    from scripts import todo_note
    store.write("todos", {"now": {"items": [{"id": "t1", "text": "X", "done": False, "notes": "hers"}]}})
    monkeypatch.setenv("EXOCORTEX_CONV_ID", "conv9")
    assert todo_note.main(["--id", "t1", "--by", "triage", "--text", "wait for the letter",
                           "--ref", "conv:conv9"]) == 0
    item = read_todos()["now"]["items"][0]
    assert item["notes"] == "hers"                       # the owner's field is untouched
    assert item["agent_notes"][0]["conv"] == "conv9"
    assert item["agent_notes"][0]["text"] == "wait for the letter"


def test_cli_refuses_an_uncited_note_and_writes_nothing(data_dir, capsys):
    from scripts import todo_note
    store.write("todos", {"now": {"items": [{"id": "t1", "text": "X", "done": False}]}})
    assert todo_note.main(["--id", "t1", "--by", "triage", "--text", "hmm"]) == 2
    assert "agent_notes" not in read_todos()["now"]["items"][0]
    assert "cite" in capsys.readouterr().err


def test_cli_unknown_id_is_an_error(data_dir):
    from scripts import todo_note
    store.write("todos", {"now": {"items": []}})
    assert todo_note.main(["--id", "zzz", "--by", "triage", "--text", "x", "--ref", "card:c"]) == 2


# --- the SQL mirror ---------------------------------------------------------------------

def test_mirror_carries_origin_and_notes_and_never_invents_an_author(data_dir):
    store.write("todos", {"now": {"items": [
        {"id": "old", "text": "Before the stamp", "done": False},
        {"id": "new", "text": "After", "done": False,
         "origin": {"by": "triage", "at": "2026-08-27T09:00", "conv": "c1"},
         "agent_notes": [{"by": "triage", "at": "2026-08-27T09:01", "text": "n",
                          "refs": ["card:a", "url:https://b"], "conv": "c1"}]},
    ]}})
    store.write("fronts", {"fronts": []})
    result = todostore.rebuild()
    assert result["agent_notes"] == 1
    conn = todostore.sqlstore.open_db()
    try:
        rows = {r[0]: r[1:] for r in conn.execute(
            "SELECT id, origin_by, origin_at, origin_conv FROM todos")}
        assert rows["old"] == (None, None, None)
        assert rows["new"] == ("triage", "2026-08-27T09:00", "c1")
        note = conn.execute("SELECT by, text, refs FROM todo_agent_notes WHERE todo_id='new'").fetchone()
        assert note[0] == "triage" and json.loads(note[2]) == ["card:a", "url:https://b"]
    finally:
        conn.close()
