"""Coming up's two doors: her own (routes/coming_up.py — no approval, marked
manual) and a Keeper's (scripts/coming_up_propose.py → the approval queue →
routes/pending.py — marked keeper once she approves).
"""
import pytest
from flask import Flask

import comingup
import store
from routes import coming_up


@pytest.fixture
def api(data_dir):
    app = Flask(__name__)
    app.config.update(TESTING=True)
    coming_up.register(app)
    return app.test_client()


def test_her_items_land_as_manual_with_no_approval(api):
    resp = api.post("/api/coming_up", json={"title": "Permafest", "date": "2026-10-17"})
    assert resp.status_code == 200
    assert comingup.load_items()[0]["created_by"] == "manual"
    assert store.read("pending_changes", {"pending": []})["pending"] == []


def test_a_bad_item_is_refused_with_the_reason(api):
    resp = api.post("/api/coming_up", json={"title": "x", "date": "next friday"})
    assert resp.status_code == 400 and "YYYY-MM-DD" in resp.get_json()["error"]
    assert comingup.load_items() == []


def test_list_shows_near_items_and_everything_not_dismissed(api):
    near = comingup.add_item({"title": "Soon", "date": "2099-01-02", "lead_days": 365}, "manual")
    far = comingup.add_item({"title": "Later", "date": "2099-12-31", "lead_days": 0}, "manual")
    gone = comingup.add_item({"title": "Gone", "date": "2099-01-02"}, "manual")
    comingup.set_status(gone["id"], "dismissed")
    got = api.get("/api/coming_up").get_json()
    ids = [it["id"] for it in got["items"]]
    assert near["id"] in ids and far["id"] in ids and gone["id"] not in ids


def test_editing_the_reminder_time_rearms_it(api):
    item = comingup.add_item({"title": "Ask", "kind": "topic", "date": "2026-10-10",
                              "time": "18:00"}, "keeper")
    comingup.set_status(item["id"], "fired", fired_at="2026-10-10 18:00")
    resp = api.post(f"/api/coming_up/{item['id']}", json={"time": "19:00"})
    edited = resp.get_json()["item"]
    assert edited["remind_at"] == "2026-10-10 19:00" and edited["status"] == "pending"
    assert edited["created_by"] == "keeper"          # who made it never changes


def test_dismiss_clears_it_for_good(api):
    item = comingup.add_item({"title": "x", "date": "2026-10-10"}, "manual")
    assert api.post(f"/api/coming_up/{item['id']}/dismiss").status_code == 200
    assert comingup.load_items()[0]["status"] == "dismissed"
    assert api.post("/api/coming_up/nope/dismiss").status_code == 404


def test_a_keeper_proposal_waits_for_approval_then_lands_as_keeper(data_dir, monkeypatch):
    from scripts import coming_up_propose
    from routes import pending
    monkeypatch.setenv("EXOCORTEX_CONV_ID", "2026-10-01.030000")
    assert coming_up_propose.main(["--kind", "topic", "--title", "How the search feels",
                                   "--date", "2026-10-10", "--time", "18:00"]) == 0
    assert comingup.load_items() == []                         # nothing until she approves
    change = store.read("pending_changes", {})["pending"][0]
    assert change["kind"] == "coming_up" and change["conv"] == "2026-10-01.030000"
    pending._commit(change)
    item = comingup.load_items()[0]
    assert item["created_by"] == "keeper" and item["remind_at"] == "2026-10-10 18:00"


def test_a_malformed_keeper_proposal_is_refused_before_it_queues(data_dir):
    from scripts import coming_up_propose
    assert coming_up_propose.main(["--title", "x", "--date", "someday"]) == 1
    assert store.read("pending_changes", {"pending": []})["pending"] == []
