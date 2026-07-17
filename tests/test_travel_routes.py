"""HTTP contract for routes/travel.py — trips, packing items, templates."""
import pytest

import store


@pytest.fixture
def travel_client(data_dir):
    from flask import Flask
    from routes import travel
    app = Flask(__name__)
    app.config.update(TESTING=True)
    travel.register(app)
    return app.test_client()


def read_trips():
    return store.read("trips.json", {"trips": []})


def read_templates():
    return store.read("travel_templates.json", {"templates": []})


def add_trip(client, name="Denver", **kw):
    resp = client.post("/api/travel/trip/add", json={"name": name, **kw})
    assert resp.status_code == 200
    return resp.get_json()["id"]


# --- trips ---

def test_add_trip_starts_planning_with_empty_list(travel_client):
    trip_id = add_trip(travel_client, destination="Denver, CO", start="2026-08-01")
    trips = read_trips()["trips"]
    assert len(trips) == 1
    assert trips[0]["id"] == trip_id
    assert trips[0]["status"] == "planning"
    assert trips[0]["items"] == []


def test_add_trip_requires_name(travel_client):
    resp = travel_client.post("/api/travel/trip/add", json={"name": "  "})
    assert resp.status_code == 400


def test_update_trip_rejects_unknown_status(travel_client):
    trip_id = add_trip(travel_client)
    resp = travel_client.post("/api/travel/trip/update",
                              json={"id": trip_id, "status": "vibing"})
    assert resp.status_code == 400
    resp = travel_client.post("/api/travel/trip/update",
                              json={"id": trip_id, "status": "away"})
    assert resp.status_code == 200
    assert read_trips()["trips"][0]["status"] == "away"


def test_remove_trip(travel_client):
    trip_id = add_trip(travel_client)
    travel_client.post("/api/travel/trip/remove", json={"id": trip_id})
    assert read_trips()["trips"] == []


# --- packing items ---

def test_add_item_dedupes_by_archival_ref(travel_client):
    trip_id = add_trip(travel_client)
    payload = {"trip_id": trip_id, "name": "Chacos",
               "source": "archival", "ref_id": "abc123"}
    assert travel_client.post("/api/travel/item/add", json=payload).status_code == 200
    # Same referenced thing under a different display name is still a dupe.
    dupe = dict(payload, name="Chacos sandals")
    assert travel_client.post("/api/travel/item/add", json=dupe).status_code == 400


def test_add_item_dedupes_free_text_case_insensitively(travel_client):
    trip_id = add_trip(travel_client)
    travel_client.post("/api/travel/item/add",
                       json={"trip_id": trip_id, "name": "Toothbrush"})
    resp = travel_client.post("/api/travel/item/add",
                              json={"trip_id": trip_id, "name": "toothbrush "})
    assert resp.status_code == 400


def test_packed_and_returned_marks_persist_independently(travel_client):
    trip_id = add_trip(travel_client)
    resp = travel_client.post("/api/travel/item/add",
                              json={"trip_id": trip_id, "name": "Boonie hat"})
    item_id = resp.get_json()["id"]

    travel_client.post("/api/travel/item/update",
                       json={"trip_id": trip_id, "item_id": item_id, "packed": True})
    item = read_trips()["trips"][0]["items"][0]
    assert item["packed"] is True and item["returned"] == ""

    travel_client.post("/api/travel/item/update",
                       json={"trip_id": trip_id, "item_id": item_id, "returned": "left"})
    item = read_trips()["trips"][0]["items"][0]
    assert item["packed"] is True and item["returned"] == "left"


def test_item_update_rejects_bad_returned_state(travel_client):
    trip_id = add_trip(travel_client)
    item_id = travel_client.post(
        "/api/travel/item/add",
        json={"trip_id": trip_id, "name": "Charger"}).get_json()["id"]
    resp = travel_client.post(
        "/api/travel/item/update",
        json={"trip_id": trip_id, "item_id": item_id, "returned": "gone"})
    assert resp.status_code == 400


def test_remove_item(travel_client):
    trip_id = add_trip(travel_client)
    item_id = travel_client.post(
        "/api/travel/item/add",
        json={"trip_id": trip_id, "name": "Charger"}).get_json()["id"]
    travel_client.post("/api/travel/item/remove",
                       json={"trip_id": trip_id, "item_id": item_id})
    assert read_trips()["trips"][0]["items"] == []


# --- templates ---

def test_template_apply_skips_items_already_on_trip(travel_client):
    tpl_id = travel_client.post("/api/travel/template/save", json={
        "name": "Always pack",
        "items": [{"name": "Charger"}, {"name": "Meds", "source": "active", "ref_id": "Vitamin D"}],
    }).get_json()["id"]
    trip_id = add_trip(travel_client)
    travel_client.post("/api/travel/item/add",
                       json={"trip_id": trip_id, "name": "charger"})

    resp = travel_client.post("/api/travel/template/apply",
                              json={"trip_id": trip_id, "template_id": tpl_id})
    assert resp.get_json()["added"] == 1
    names = [i["name"] for i in read_trips()["trips"][0]["items"]]
    assert names == ["charger", "Meds"]


def test_new_trip_seeded_from_templates_dedupes_across_them(travel_client):
    for name in ("A", "B"):
        travel_client.post("/api/travel/template/save", json={
            "name": name, "items": [{"name": "Charger"}, {"name": f"Only {name}"}],
        })
    tpl_ids = [t["id"] for t in read_templates()["templates"]]
    trip_id = add_trip(travel_client, template_ids=tpl_ids)
    items = read_trips()["trips"][0]["items"]
    assert [i["name"] for i in items] == ["Charger", "Only A", "Only B"]
    assert all(i["packed"] is False and i["returned"] == "" for i in items)
    assert trip_id == read_trips()["trips"][0]["id"]


def test_template_from_trip_snapshots_names_not_state(travel_client):
    trip_id = add_trip(travel_client)
    item_id = travel_client.post(
        "/api/travel/item/add",
        json={"trip_id": trip_id, "name": "Chacos",
              "source": "archival", "ref_id": "abc123"}).get_json()["id"]
    travel_client.post("/api/travel/item/update",
                       json={"trip_id": trip_id, "item_id": item_id, "packed": True})

    travel_client.post("/api/travel/template/from-trip",
                       json={"trip_id": trip_id, "name": "Camping base"})
    tpl = read_templates()["templates"][0]
    assert tpl["name"] == "Camping base"
    assert tpl["items"] == [{"name": "Chacos", "source": "archival",
                             "ref_id": "abc123", "category": ""}]


def test_template_save_with_id_replaces(travel_client):
    tpl_id = travel_client.post("/api/travel/template/save", json={
        "name": "Base", "items": [{"name": "Charger"}]}).get_json()["id"]
    travel_client.post("/api/travel/template/save", json={
        "id": tpl_id, "name": "Base v2", "items": [{"name": "Cable"}]})
    templates = read_templates()["templates"]
    assert len(templates) == 1
    assert templates[0]["name"] == "Base v2"
    assert [i["name"] for i in templates[0]["items"]] == ["Cable"]


# --- sources ---

def test_data_endpoint_offers_archivals_and_unfinished_consumables(travel_client, data_dir):
    store.write("archivals.json", {"items": [
        {"id": "a1", "name": "Chacos", "category": "clothing",
         "photos": [{"id": "p1", "filename": "chacos.png"}]},
        {"name": "no-id legacy row — skipped"},
    ]})
    store.write("active_inventory.json", {"items": [
        {"name": "Vitamin D", "category": "supplements", "status": "in_use"},
        {"name": "Quercetin", "category": "supplements", "status": "finished"},
    ]})
    data = travel_client.get("/api/travel/data").get_json()
    assert data["sources"]["archivals"] == [
        {"id": "a1", "name": "Chacos", "category": "clothing", "photo": "chacos.png"}]
    assert [s["name"] for s in data["sources"]["active"]] == ["Vitamin D"]
