"""Behavioral tests for the Media API (routes/media.py).

Media is a backlog of books/movies/shows recommended to her. These pin the
add/update/remove contract, the type coercion, and the optional `author`
field (added for books) — old items just lack the key, so update must not
choke when it's absent, and add must default it to an empty string rather
than requiring it.

Same shape as the other route tests: minimal app, only this blueprint.
"""
import json

import pytest

import store


@pytest.fixture
def client(data_dir):
    """A test client for a minimal app exposing only the media routes."""
    from flask import Flask
    from routes import media
    app = Flask(__name__)
    app.config.update(TESTING=True)
    media.register(app)
    return app.test_client()


def _post(client, path, payload=None):
    return client.post(path, data=json.dumps(payload or {}), content_type="application/json")


def read_media():
    return store.read("media.json", {"items": []})


def test_add_defaults_author_to_empty_string(client):
    res = _post(client, "/api/media/add", {"title": "Project Hail Mary", "type": "book"})
    assert res.status_code == 200
    item = read_media()["items"][0]
    assert item["author"] == ""


def test_add_stores_author(client):
    _post(client, "/api/media/add", {
        "title": "The Tibetan Yogas Of Dream And Sleep",
        "type": "book",
        "author": "Tenzin Wangyal Rinpoche",
    })
    item = read_media()["items"][0]
    assert item["author"] == "Tenzin Wangyal Rinpoche"


def test_update_sets_author(client):
    add_res = _post(client, "/api/media/add", {"title": "Replacing Guilt", "type": "book"})
    item_id = add_res.get_json()["id"]
    res = _post(client, "/api/media/update", {"id": item_id, "author": "Nate Soares"})
    assert res.status_code == 200
    item = read_media()["items"][0]
    assert item["author"] == "Nate Soares"
    # untouched fields survive a partial update
    assert item["title"] == "Replacing Guilt"


def test_update_leaves_author_untouched_when_absent_from_body(client):
    _post(client, "/api/media/add", {"title": "Dune", "type": "book", "author": "Frank Herbert"})
    item_id = read_media()["items"][0]["id"]
    _post(client, "/api/media/update", {"id": item_id, "done": True})
    item = read_media()["items"][0]
    assert item["author"] == "Frank Herbert"
    assert item["done"] is True


def test_update_tolerates_legacy_item_with_no_author_key(client, data_dir):
    # Simulate an item written before the `author` field existed.
    store.write("media.json", {"items": [{
        "id": "legacy1",
        "title": "Old Recommendation",
        "type": "article",
        "recommended_by": "",
        "notes": "",
        "date": "2026-06-12",
        "done": False,
    }]})
    res = _post(client, "/api/media/update", {"id": "legacy1", "done": True})
    assert res.status_code == 200
    item = read_media()["items"][0]
    assert item["done"] is True
    assert "author" not in item  # untouched — update never invents fields not sent


def test_add_missing_title_is_400(client):
    res = _post(client, "/api/media/add", {"author": "Someone"})
    assert res.status_code == 400
    assert read_media()["items"] == []


def test_remove_deletes_by_id(client):
    add_res = _post(client, "/api/media/add", {"title": "Arrival", "type": "movie"})
    item_id = add_res.get_json()["id"]
    _post(client, "/api/media/remove", {"id": item_id})
    assert read_media()["items"] == []
