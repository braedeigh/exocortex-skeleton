"""The build-queue card routes (routes/buildtodo.py).

The HTTP contract, in the house style (see tests/test_todos_routes.py): seed a
starting state, POST JSON, assert what actually persisted by reading the
collection back through `store`. Reading through store — not off disk — is the
point here, because `build_todo` is in SQL_COLLECTIONS: the database is the
record and the JSON file is only a mirror, so a test that read the file would
be asserting against derived output.
"""
import pytest
from flask import Flask

import store
from routes import buildtodo


@pytest.fixture
def client(data_dir):
    app = Flask(__name__)
    app.config.update(TESTING=True)
    buildtodo.register(app)
    return app.test_client()


def cards():
    """Whatever the routes persisted, straight out of the collection."""
    return store.read(buildtodo.FILE, {"cards": []})["cards"]


def add(client, **kw):
    kw.setdefault("title", "a thing to build")
    return client.post("/api/buildtodo/add", json=kw)


# --- minting -----------------------------------------------------------------

def test_add_mints_a_dated_card(client):
    r = add(client, title="The warden", body="one admission controller",
            author="Fable", priority="red", tags=["warden", "infra"])
    assert r.status_code == 200
    card = r.get_json()
    assert buildtodo.CARD_ID_RE.match(card["id"])
    # The id carries the day on its face, and it agrees with `created`.
    assert card["id"].split(".")[0] == card["created"]
    assert card["status"] == "open"
    assert card["priority"] == "red"
    assert card["tags"] == ["warden", "infra"]
    assert len(cards()) == 1


def test_add_requires_a_title(client):
    assert client.post("/api/buildtodo/add", json={"body": "orphan"}).status_code == 400
    assert client.post("/api/buildtodo/add", json={"title": "   "}).status_code == 400
    assert cards() == []


def test_add_rejects_bad_priority_and_tags(client):
    assert add(client, priority="chartreuse").status_code == 400
    assert add(client, tags="warden").status_code == 400        # not a list
    assert add(client, tags=["Not A Slug"]).status_code == 400
    assert cards() == []


def test_tags_are_deduplicated_in_order(client):
    card = add(client, tags=["b", "a", "b"]).get_json()
    assert card["tags"] == ["b", "a"]


def test_ids_are_unique_across_cards_minted_the_same_day(client):
    ids = {add(client, title=f"item {i}").get_json()["id"] for i in range(25)}
    assert len(ids) == 25


def test_new_id_survives_a_collided_id_set():
    """The mint retries rather than handing back an id already in use — a
    duplicate would silently merge two build items."""
    day = "2026-08-08"
    taken = [f"{day}.{h:04x}" for h in range(200)]
    fresh = buildtodo.new_id(day, taken)
    assert fresh not in taken and fresh.startswith(day + ".")


# --- editing -----------------------------------------------------------------

def test_update_changes_only_the_fields_sent(client):
    cid = add(client, title="original", body="spec", author="Keeper",
              tags=["x"]).get_json()["id"]
    r = client.post("/api/buildtodo/update", json={"id": cid, "status": "shipped"})
    assert r.status_code == 200
    card = r.get_json()
    # Absent keys mean "leave it alone", not "clear it".
    assert card["status"] == "shipped"
    assert card["title"] == "original"
    assert card["body"] == "spec"
    assert card["author"] == "Keeper"
    assert card["tags"] == ["x"]


def test_update_can_clear_the_body_but_not_the_title(client):
    cid = add(client, body="spec").get_json()["id"]
    assert client.post("/api/buildtodo/update",
                       json={"id": cid, "body": ""}).get_json()["body"] == ""
    assert client.post("/api/buildtodo/update",
                       json={"id": cid, "title": "  "}).status_code == 400
    assert cards()[0]["title"] == "a thing to build"


def test_update_rejects_an_invalid_status(client):
    cid = add(client).get_json()["id"]
    assert client.post("/api/buildtodo/update",
                       json={"id": cid, "status": "done"}).status_code == 400
    assert cards()[0]["status"] == "open"


def test_update_of_a_missing_card_is_404(client):
    assert client.post("/api/buildtodo/update",
                       json={"id": "2026-08-08.abcd", "status": "shipped"}).status_code == 404


def test_update_rejects_a_malformed_id(client):
    assert client.post("/api/buildtodo/update",
                       json={"id": "nonsense", "status": "shipped"}).status_code == 400


# --- removal and undo --------------------------------------------------------

def test_remove_returns_the_card_for_undo_and_restore_puts_it_back(client):
    original = add(client, title="misfiled", tags=["oops"]).get_json()
    r = client.post("/api/buildtodo/remove", json={"id": original["id"]})
    assert r.status_code == 200
    assert cards() == []

    restored = r.get_json()["card"]
    client.post("/api/buildtodo/restore", json={"card": restored})
    # Id and created survive the round trip, so the undo is exact.
    assert cards()[0]["id"] == original["id"]
    assert cards()[0]["created"] == original["created"]


def test_restore_twice_cannot_duplicate(client):
    card = add(client).get_json()
    client.post("/api/buildtodo/remove", json={"id": card["id"]})
    client.post("/api/buildtodo/restore", json={"card": card})
    client.post("/api/buildtodo/restore", json={"card": card})
    assert len(cards()) == 1


def test_remove_of_a_missing_card_is_404(client):
    assert client.post("/api/buildtodo/remove",
                       json={"id": "2026-08-08.abcd"}).status_code == 404


# --- listing -----------------------------------------------------------------

def test_list_returns_cards_newest_first(client):
    store.write(buildtodo.FILE, {"cards": [
        {"id": "2026-08-01.aaaa", "title": "older", "created": "2026-08-01"},
        {"id": "2026-08-08.bbbb", "title": "newer", "created": "2026-08-08"},
    ]})
    got = client.get("/api/buildtodo").get_json()["cards"]
    assert [c["title"] for c in got] == ["newer", "older"]


def test_list_tolerates_a_malformed_blob(client):
    """A half-written or hand-edited blob renders an empty queue, not a 500."""
    store.write(buildtodo.FILE, {"cards": "not a list"})
    assert client.get("/api/buildtodo").get_json()["cards"] == []


def test_list_fills_defaults_for_a_card_written_before_a_field_existed(client):
    store.write(buildtodo.FILE, {"cards": [{"id": "2026-08-08.aaaa", "title": "bare"}]})
    card = client.get("/api/buildtodo").get_json()["cards"][0]
    assert card["status"] == "open"
    # No `created` is reported as absent, never guessed as today.
    assert card["priority"] is None and card["created"] == ""


# --- the legacy markdown half ------------------------------------------------

LEGACY = """# Build TODO

## 🟡 Prune unused sections (Sam, 2026-08-08)

Two separate jobs in one sentence.

## ✅ USAGE — SHIPPED 2026-08-03 (skeleton `e28b0e7`)

### Detail
Already built.

## A heading with no attribution

Body.
"""


def test_parse_legacy_splits_on_headings_and_lifts_the_attribution():
    got = buildtodo.parse_legacy(LEGACY)
    assert len(got) == 3
    # The `# Build TODO` preamble is dropped — it's the doc title, not an item.
    assert got[0]["author"] == "Sam" and got[0]["created"] == "2026-08-08"
    assert "Two separate jobs" in got[0]["body"]
    # `###` subsections stay inside their parent card's body.
    assert "### Detail" in got[1]["body"]
    assert got[1]["shipped"] is True
    # A bare heading still becomes a card, with the meta reported empty.
    assert got[2]["author"] == "" and got[2]["created"] == ""
    assert got[2]["shipped"] is False


def test_list_includes_the_legacy_file(client, data_dir, monkeypatch):
    path = data_dir / "dev_todo.md"
    path.write_text(LEGACY)
    monkeypatch.setattr(store, "DEV_TODO_FILE", path)
    body = client.get("/api/buildtodo").get_json()
    assert [c["title"] for c in body["legacy"]][0].startswith("🟡 Prune")


def test_a_missing_legacy_file_is_not_fatal(client, data_dir, monkeypatch):
    monkeypatch.setattr(store, "DEV_TODO_FILE", data_dir / "nope.md")
    r = client.get("/api/buildtodo")
    assert r.status_code == 200 and r.get_json()["legacy"] == []
