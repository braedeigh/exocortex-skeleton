"""routes/cards.py — the journal page's card API, against the real tables.

Each test seeds cards straight into a per-test exo.db (the `data_dir`
fixture points both the store and the journal engine at it) and calls a
minimal Flask app that registers only `cards`. Changes go through the real
engine, tools/stream/stream.py, run as the subprocess the route starts, so
these tests cover the whole path a tap on the journal page takes: the 24-hour
window, the friendly refusal on a locked card, notes linked to old cards, and
the reads that show them.
"""
from datetime import datetime, timedelta

import pytest
from flask import Flask

import sqlstore
import store
from routes import cards
from tools.stream import stream

journaldb = stream.journaldb

OLD_DAY = "2026-07-08"
OLD_LINE = "2026-07-08.0734b"
OLD_REF = "2026-07-08.2114k"


def _stamp(moment):
    return moment.strftime("%Y-%m-%d %H:%M:%S")


def seed(card_id, body, who="B", kind="line", saved_at=None, refs=(), tags=(), said_at=None):
    """One card row. Its time comes from its id (`2026-07-08.0734b` -> 07:34)
    unless `said_at` is given; it's saved at that same moment — so an old
    card is already locked — unless `saved_at` says otherwise."""
    said_at = said_at or f"{card_id[:10]} {card_id[11:13]}:{card_id[13:15]}:00"
    conn = sqlstore.open_db()
    try:
        journaldb.insert_card(conn, id=card_id, who=who, said_at=said_at, body=body, kind=kind,
                              refs=refs, saved_at=saved_at or said_at)
        context = journaldb.LabelContext(None, None)
        for tag in tags:
            journaldb.add_label(conn, card_id, tag, "test", context)
        conn.commit()
    finally:
        conn.close()
    return card_id


def fresh_card(body, minutes_ago=5):
    """A card said and saved a few minutes ago — still inside its 24 hours."""
    moment = datetime.now() - timedelta(minutes=minutes_ago)
    card_id = moment.strftime("%Y-%m-%d.%H%M") + "b"
    return seed(card_id, body, said_at=_stamp(moment), saved_at=_stamp(moment))


def body_of(card_id):
    conn = sqlstore.open_db()
    try:
        row = conn.execute("SELECT body, deleted_at FROM cards WHERE id = ?", (card_id,)).fetchone()
    finally:
        conn.close()
    return row


@pytest.fixture
def vault(data_dir, tmp_path, monkeypatch):
    content = tmp_path / "content"
    (content / "_system" / "data").mkdir(parents=True)
    monkeypatch.setattr(store, "CONTENT_DIR", content)
    seed(OLD_LINE, "I feel really good this morning.", tags=["khalil"])
    seed(OLD_REF, "Fern group cancellation — hit the belonging nerve.", who="K", kind="ref",
         refs=["2026-05-14", "people/fern.md"])
    return content


@pytest.fixture
def client(vault):
    app = Flask(__name__)
    app.config.update(TESTING=True)
    cards.register(app)
    return app.test_client()


def _by_id(payload, cid):
    return next(c for c in payload["cards"] if c["id"] == cid)


# --- reading a day -------------------------------------------------------------

def test_day_reads_cards_from_the_database_with_their_edit_window(client):
    new_id = fresh_card("Just now.")
    old = client.get(f"/api/cards/{OLD_DAY}").get_json()
    line, ref = _by_id(old, OLD_LINE), _by_id(old, OLD_REF)
    assert (line["tags"], line["refs"], line["who"]) == (["khalil"], [], "B")
    assert (ref["kind"], ref["refs"], ref["who"]) == ("ref", ["2026-05-14", "people/fern.md"], "K")
    assert line["editable"] is False and line["locks_at"] == "2026-07-09 07:34:00"

    today = client.get(f"/api/cards/{new_id[:10]}").get_json()
    card = _by_id(today, new_id)
    assert card["editable"] is True
    assert card["locks_at"] > _stamp(datetime.now())


def test_day_leaves_out_deleted_cards(client):
    new_id = fresh_card("Typed by mistake.")
    assert client.post("/api/cards/delete", json={"id": new_id}).status_code == 200
    day = client.get(f"/api/cards/{new_id[:10]}").get_json()
    assert new_id not in [c["id"] for c in day["cards"]]
    assert body_of(new_id)[1] is not None  # the row is kept, hidden


# --- the 24-hour window ----------------------------------------------------------

def test_editing_a_card_inside_its_window_changes_it_and_keeps_the_old_words(client):
    new_id = fresh_card("first words")
    resp = client.post("/api/cards/update", json={"id": new_id, "body": "better words"})
    assert resp.status_code == 200
    assert resp.get_json()["body"] == "better words"
    assert resp.get_json()["edited"]
    versions = client.get(f"/api/cards/{new_id}/history").get_json()["versions"]
    assert [(v["before"], v["after"]) for v in versions] == [("first words", "better words")]


def test_a_locked_card_refuses_edit_and_delete_with_a_clear_message(client):
    edit = client.post("/api/cards/update", json={"id": OLD_LINE, "body": "rewritten"})
    delete = client.post("/api/cards/delete", json={"id": OLD_LINE})
    for resp in (edit, delete):
        assert resp.status_code == 409
        payload = resp.get_json()
        assert payload["locked"] is True
        assert "locked at 7:34 AM on Jul 9" in payload["error"]
        assert "Add a note" in payload["error"]
    assert body_of(OLD_LINE) == ("I feel really good this morning.", None)


def test_edit_or_delete_of_a_missing_card_is_a_404(client):
    assert client.post("/api/cards/update", json={"id": "2026-07-08.0101b", "body": "x"}).status_code == 404
    assert client.post("/api/cards/delete", json={"id": "2026-07-08.0101b"}).status_code == 404


def test_a_lock_the_engine_reports_is_still_a_409(client, monkeypatch):
    # The card locks between the route's check and the engine's.
    new_id = fresh_card("about to lock")

    class Locked:
        returncode = 1
        stdout = ""
        stderr = f"error: card {new_id} is locked — it was saved more than 24 hours ago"

    monkeypatch.setattr(cards, "_run_stream", lambda *a, **k: Locked())
    resp = client.post("/api/cards/update", json={"id": new_id, "body": "late"})
    assert resp.status_code == 409 and resp.get_json()["locked"] is True


def test_labels_still_change_on_a_locked_card(client):
    added = client.post("/api/cards/tag", json={"id": OLD_LINE, "tags": ["ezra"]})
    assert added.status_code == 200 and added.get_json()["tags"] == ["khalil", "ezra"]
    removed = client.post("/api/cards/untag", json={"id": OLD_LINE, "tags": ["khalil"]})
    assert removed.status_code == 200 and removed.get_json()["tags"] == ["ezra"]
    assert client.post("/api/cards/tag", json={"id": OLD_LINE, "tags": ["Not A Slug!"]}).status_code == 400


# --- notes on old cards ----------------------------------------------------------

def test_a_note_on_a_locked_card_lands_today_and_both_days_show_the_link(client):
    resp = client.post("/api/cards/note", json={"on": OLD_LINE, "body": "Looking back, that was the turn."})
    assert resp.status_code == 200
    note = resp.get_json()
    assert note["note_on"] == OLD_LINE
    assert note["who"] == "B" and note["editable"] is True
    assert note["ts"][:10] == datetime.now().strftime("%Y-%m-%d")

    # Today's page: the note wears a quote of the card it's about.
    today = _by_id(client.get(f"/api/cards/{note['ts'][:10]}").get_json(), note["id"])
    assert today["reply_context"] == {"id": OLD_LINE, "date": OLD_DAY,
                                      "snippet": "I feel really good this morning.", "link": "note"}

    # The old card's page: "1 note added later".
    old = _by_id(client.get(f"/api/cards/{OLD_DAY}").get_json(), OLD_LINE)
    assert [n["id"] for n in old["notes"]] == [note["id"]]
    assert old["notes"][0]["snippet"] == "Looking back, that was the turn."


def test_a_note_carries_thread_tags_and_refuses_bad_input(client):
    tagged = client.post("/api/cards/note", json={"on": OLD_LINE, "body": "for the thread", "tags": ["khalil"]})
    assert tagged.status_code == 200 and tagged.get_json()["tags"] == ["khalil"]
    assert client.post("/api/cards/note", json={"on": "2026-07-08.0101b", "body": "x"}).status_code == 404
    assert client.post("/api/cards/note", json={"on": OLD_LINE, "body": "  "}).status_code == 400
    assert client.post("/api/cards/note", json={"on": "nope", "body": "x"}).status_code == 400


def test_meta_gives_window_and_notes_for_a_list_of_cards(client):
    note = client.post("/api/cards/note", json={"on": OLD_LINE, "body": "later"}).get_json()
    meta = client.post("/api/cards/meta",
                       json={"ids": [OLD_LINE, note["id"], "2026-07-08.0101b"]}).get_json()["cards"]
    assert set(meta) == {OLD_LINE, note["id"]}  # unknown ids are left out
    assert meta[OLD_LINE]["editable"] is False
    assert [n["id"] for n in meta[OLD_LINE]["notes"]] == [note["id"]]
    assert meta[note["id"]]["editable"] is True and meta[note["id"]]["note_on"] == OLD_LINE
    assert client.post("/api/cards/meta", json={"ids": ["bad id"]}).status_code == 400


def test_a_reply_keeps_its_chip_and_loses_it_when_the_parent_is_gone(client):
    parent = fresh_card("A question worth answering, with quite a few words in it to clip.", minutes_ago=10)
    reply = client.post("/api/cards/add", json={"date": parent[:10], "position": "bottom",
                                                "body": "My answer.", "reply_to": parent}).get_json()
    assert reply["reply_to"] == parent
    day = client.get(f"/api/cards/{parent[:10]}").get_json()
    assert _by_id(day, reply["id"])["reply_context"] == {
        "id": parent, "date": parent[:10], "link": "answers",
        "snippet": "A question worth answering, with quite a few words in it to…"}
    assert "reply_context" not in _by_id(day, parent)

    client.post("/api/cards/delete", json={"id": parent})
    day = client.get(f"/api/cards/{parent[:10]}").get_json()
    assert _by_id(day, reply["id"])["reply_context"] is None


# --- adding a card ---------------------------------------------------------------
# The old day has a `line` at 07:34 and a `ref` at 21:14 — both count toward
# the top/bottom insert math.

def test_add_top_and_bottom_land_around_the_days_cards_with_their_tags(client):
    top = client.post("/api/cards/add", json={"date": OLD_DAY, "position": "top", "body": "Early."})
    bottom = client.post("/api/cards/add", json={"date": OLD_DAY, "position": "bottom",
                                                 "body": "Late.", "tags": ["moving"]})
    assert top.status_code == 200 and top.get_json()["ts"] == "2026-07-08 07:33:59"
    assert bottom.get_json()["ts"] == "2026-07-08 21:14:01"
    assert bottom.get_json()["tags"] == ["moving"]
    # Added to an old day, but saved now: it gets its own full 24 hours.
    assert bottom.get_json()["editable"] is True


@pytest.mark.parametrize("payload, error", [
    ({"date": OLD_DAY, "position": "top", "body": "   "}, "body cannot be empty"),
    ({"date": OLD_DAY, "position": "middle", "body": "x"}, "position must be 'top' or 'bottom'"),
    ({"date": "2026-07-05", "position": "top", "body": "x"}, "day predates the card pool"),
    ({"date": OLD_DAY, "position": "top", "body": "x", "tags": ["Not_Valid!"]}, "invalid tag"),
    ({"date": OLD_DAY, "position": "top", "body": "x", "reply_to": "nope"}, "invalid reply_to"),
])
def test_add_refuses_bad_input(client, payload, error):
    resp = client.post("/api/cards/add", json=payload)
    assert resp.status_code == 400 and resp.get_json()["error"] == error


def test_insert_ts_bottom_on_today_past_last_card_uses_now():
    day_cards = [{"id": "2026-07-08.0734b", "ts": "2026-07-08 07:34:00", "kind": "line"}]
    ts = cards._insert_ts("2026-07-08", "bottom", day_cards, now=datetime(2026, 7, 8, 23, 0, 0))
    assert ts == "2026-07-08 23:00:00"


def test_insert_ts_top_clamps_to_midnight_when_first_card_is_at_midnight():
    day_cards = [{"id": "2026-07-08.0000b", "ts": "2026-07-08 00:00:00", "kind": "line"}]
    ts = cards._insert_ts("2026-07-08", "top", day_cards, now=datetime(2026, 7, 8, 12, 0, 0))
    assert ts == "2026-07-08 00:00:00"


# --- edit history and the "✎ edited an entry from …" rows -------------------------

def _seed_edits(*rows):
    conn = sqlstore.open_db()
    try:
        for card_id, edited_at, before, after in rows:
            journaldb.record_edit(conn, card_id, edited_at, "test", before, after)
        conn.commit()
    finally:
        conn.close()


def test_history_and_edit_rows_read_the_edit_table(client):
    seed("2026-09-24.0900b", "fixed")
    _seed_edits(
        (OLD_LINE, "2026-09-24 16:00:00", "v1", "draft"),
        (OLD_LINE, "2026-09-24 17:00:00", "draft", "final words"),
        # Edited on its own day: shows as the card's chip, not a separate row.
        ("2026-09-24.0900b", "2026-09-24 18:00:00", "typo", "fixed"),
    )
    versions = client.get(f"/api/cards/{OLD_LINE}/history").get_json()["versions"]
    assert [(v["before"], v["after"]) for v in versions] == [("v1", "draft"), ("draft", "final words")]
    assert _by_id(client.get(f"/api/cards/{OLD_DAY}").get_json(), OLD_LINE)["edited"] == "2026-09-24 17:00:00"
    edits = client.get("/api/cards/2026-09-24").get_json()["edits"]
    assert edits == [{"card_id": OLD_LINE, "card_day": OLD_DAY,
                      "edited_at": "2026-09-24 17:00:00", "snippet": "final words"}]
    assert client.get("/api/cards/not-an-id/history").status_code == 400
