"""HTTP contract for the archivals catalog (routes/archivals.py).

Identity is by stable ``id``. Photos are files in store.ARCHIVALS_DIR, patched
to a temp dir here so tests never touch real photos.
"""
import io
import json

import pytest
from flask import Flask

import store
from routes import archivals


@pytest.fixture
def arch_client(data_dir, monkeypatch):
    monkeypatch.setattr(store, "ARCHIVALS_DIR", data_dir / "archivals")
    app = Flask(__name__)
    app.config.update(TESTING=True)
    archivals.register(app)
    return app.test_client()


def read_archivals():
    return store.read("archivals.json", {"items": []})


def _add(client, name="Blue quilt", **fields):
    data = {"name": name, **fields}
    res = client.post("/api/archivals/add", data=data)
    assert res.status_code == 200
    return res.get_json()["item"]


def test_add_persists_item_with_id(arch_client):
    item = _add(arch_client, category="bedding", origin="gift from mom")
    saved = read_archivals()["items"]
    assert len(saved) == 1
    assert saved[0]["id"] == item["id"]
    assert saved[0]["origin"] == "gift from mom"


def test_add_rejects_empty_name(arch_client):
    res = arch_client.post("/api/archivals/add", data={"name": "  "})
    assert res.status_code == 400
    assert read_archivals()["items"] == []


def test_same_name_items_stay_independent(arch_client):
    a = _add(arch_client, name="Ring")
    b = _add(arch_client, name="Ring")
    arch_client.post("/api/archivals/update", json={"id": b["id"], "origin": "thrifted"})
    saved = {i["id"]: i for i in read_archivals()["items"]}
    assert saved[a["id"]].get("origin", "") == ""
    assert saved[b["id"]]["origin"] == "thrifted"


def test_update_only_touches_sent_fields(arch_client):
    item = _add(arch_client, description="the story", private_origin="secret detail")
    arch_client.post("/api/archivals/update", json={"id": item["id"], "category": "jewelry"})
    saved = read_archivals()["items"][0]
    assert saved["category"] == "jewelry"
    assert saved["description"] == "the story"
    assert saved["private_origin"] == "secret detail"


def test_update_unknown_id_404s(arch_client):
    res = arch_client.post("/api/archivals/update", json={"id": "nope", "category": "x"})
    assert res.status_code == 404


def test_materials_parse_from_free_text(arch_client):
    item = _add(arch_client, materials="Cotton 80, Polyester 20%, Wool")
    saved = read_archivals()["items"][0]
    assert saved["materials"] == [
        {"material": "Cotton", "percentage": 80},
        {"material": "Polyester", "percentage": 20},
        {"material": "Wool", "percentage": None},
    ]
    assert item["materials"] == saved["materials"]


def test_add_with_photo_writes_file_and_record(arch_client):
    res = arch_client.post("/api/archivals/add", data={
        "name": "Camo cami",
        "photos": (io.BytesIO(b"fake-jpg-bytes"), "pic.jpg"),
    })
    assert res.status_code == 200
    saved = read_archivals()["items"][0]
    assert len(saved["photos"]) == 1
    fname = saved["photos"][0]["filename"]
    assert (store.ARCHIVALS_DIR / fname).read_bytes() == b"fake-jpg-bytes"


def test_photo_bad_extension_rejected(arch_client):
    res = arch_client.post("/api/archivals/add", data={
        "name": "Sketchy",
        "photos": (io.BytesIO(b"x"), "evil.exe"),
    })
    assert res.status_code == 400


def test_remove_deletes_item_and_photo_files(arch_client):
    arch_client.post("/api/archivals/add", data={
        "name": "Old shirt",
        "photos": (io.BytesIO(b"bytes"), "pic.png"),
    })
    item = read_archivals()["items"][0]
    fname = item["photos"][0]["filename"]
    assert (store.ARCHIVALS_DIR / fname).exists()

    res = arch_client.post("/api/archivals/remove", json={"id": item["id"]})
    assert res.status_code == 200
    assert read_archivals()["items"] == []
    assert not (store.ARCHIVALS_DIR / fname).exists()


def test_set_main_photo_moves_to_front(arch_client):
    arch_client.post("/api/archivals/add", data={
        "name": "Jacket",
        "photos": [(io.BytesIO(b"a"), "a.jpg"), (io.BytesIO(b"b"), "b.jpg")],
    })
    item = read_archivals()["items"][0]
    second = item["photos"][1]["id"]
    res = arch_client.post(f"/api/archivals/{item['id']}/photos/main",
                           json={"photo_id": second})
    assert res.status_code == 200
    assert read_archivals()["items"][0]["photos"][0]["id"] == second


def test_remove_photo_deletes_file_and_record(arch_client):
    arch_client.post("/api/archivals/add", data={
        "name": "Dress",
        "photos": (io.BytesIO(b"d"), "d.webp"),
    })
    item = read_archivals()["items"][0]
    photo = item["photos"][0]
    res = arch_client.post(f"/api/archivals/{item['id']}/photos/remove",
                           json={"photo_id": photo["id"]})
    assert res.status_code == 200
    assert read_archivals()["items"][0]["photos"] == []
    assert not (store.ARCHIVALS_DIR / photo["filename"]).exists()


def test_public_view_strips_private_items_and_fields():
    items = [
        {"id": "1", "name": "Public thing", "private": "no",
         "private_origin": "secret", "photos": [{"id": "p", "filename": "f.jpg"}]},
        {"id": "2", "name": "Hidden thing", "private": "yes"},
        {"id": "3", "name": "Shy photos", "private": "",
         "private_photos": "yes", "photos": [{"id": "q", "filename": "g.jpg"}]},
    ]
    out = archivals.public_view(items)
    assert [i["id"] for i in out] == ["1", "3"]
    assert "private_origin" not in out[0]
    assert out[0]["photos"]          # public item keeps photos
    assert out[1]["photos"] == []    # private_photos flag empties them
