"""Day-counter (streak) lifecycle routes — routes/streaks.py.

Covers the HTTP contract: add mints id/slug/status, legacy entries back-fill,
retire freezes the count + stamps the retirement facts, unretire reverses it,
update handles notes + habit_key, and the habit-rename rewrite keeps links
attached. The journal re-render side effect is a fire-and-forget subprocess
(silent no-op without a content dir) — not asserted here; the weave itself is
covered in tools/stream/test_stream.py.
"""
from datetime import datetime, timedelta

import pytest
from flask import Flask

import store
from routes import streaks


@pytest.fixture
def client(data_dir):
    app = Flask(__name__)
    app.config.update(TESTING=True)
    streaks.register(app)
    return app.test_client()


def read_streaks():
    return store.read("streaks", {}).get("streaks", [])


def seed_raw(entries):
    store.write("streaks", {"streaks": entries})


def days_ago(n):
    return (datetime.now() - timedelta(days=n)).strftime("%Y-%m-%d")


def test_add_mints_id_slug_and_active_status(client):
    r = client.post("/api/streaks/add", json={"label": "off Weed!", "since": days_ago(3)})
    assert r.status_code == 200
    (s,) = read_streaks()
    assert s["id"] and s["slug"] == "off-weed" and s["status"] == "active"


def test_add_rejects_bad_date(client):
    r = client.post("/api/streaks/add", json={"label": "x", "since": "07/20/2026"})
    assert r.status_code == 400


def test_legacy_entries_backfill_on_load(client, data_dir):
    seed_raw([{"label": "off weed", "since": days_ago(10)}])
    out = streaks.load_streaks("active")
    assert out[0]["days"] == 10
    (s,) = read_streaks()  # back-fill persisted
    assert s["id"] and s["slug"] == "off-weed" and s["status"] == "active"


def test_slug_collision_gets_suffix(client):
    client.post("/api/streaks/add", json={"label": "off weed", "since": days_ago(1)})
    client.post("/api/streaks/add", json={"label": "off weed", "since": days_ago(2)})
    slugs = {s["slug"] for s in read_streaks()}
    assert slugs == {"off-weed", "off-weed-2"}


def test_retire_freezes_count_and_stamps_facts(client):
    client.post("/api/streaks/add", json={"label": "on peptides", "since": days_ago(148)})
    sid = read_streaks()[0]["id"]
    r = client.post("/api/streaks/retire", json={"id": sid, "note": "done for now"})
    assert r.status_code == 200
    (s,) = read_streaks()
    today = datetime.now().strftime("%Y-%m-%d")
    assert s["status"] == "retired"
    assert s["retired_on"] == today and s["retired_note"] == "done for now"
    assert len(s["retired_time"]) == 5
    # active view no longer serves it; retired view freezes days at 148
    assert streaks.load_streaks("active") == []
    (v,) = streaks.load_streaks("retired")
    assert v["days"] == 148 and v["retired_note"] == "done for now"


def test_retire_twice_is_rejected(client):
    client.post("/api/streaks/add", json={"label": "x", "since": days_ago(1)})
    sid = read_streaks()[0]["id"]
    client.post("/api/streaks/retire", json={"id": sid})
    assert client.post("/api/streaks/retire", json={"id": sid}).status_code == 400


def test_unretire_restores_and_clears_retirement_facts(client):
    client.post("/api/streaks/add", json={"label": "x", "since": days_ago(5)})
    sid = read_streaks()[0]["id"]
    client.post("/api/streaks/retire", json={"id": sid, "note": "pause"})
    r = client.post("/api/streaks/unretire", json={"id": sid})
    assert r.status_code == 200
    (s,) = read_streaks()
    assert s["status"] == "active"
    assert "retired_on" not in s and "retired_time" not in s and "retired_note" not in s
    (v,) = streaks.load_streaks("active")
    assert v["days"] == 5


def test_update_by_id_sets_notes_and_habit_link(client):
    client.post("/api/streaks/add", json={"label": "patches", "since": days_ago(2)})
    sid = read_streaks()[0]["id"]
    r = client.post("/api/streaks/update",
                    json={"id": sid, "notes": "21mg", "habit_key": "morning|Nicotine patch"})
    assert r.status_code == 200
    (s,) = read_streaks()
    assert s["notes"] == "21mg" and s["habit_key"] == "morning|Nicotine patch"
    # clearing the link removes the field
    client.post("/api/streaks/update", json={"id": sid, "habit_key": ""})
    assert "habit_key" not in read_streaks()[0]


def test_update_falls_back_to_legacy_label_since_identity(client):
    since = days_ago(4)
    seed_raw([{"label": "off weed", "since": since}])
    r = client.post("/api/streaks/update",
                    json={"label": "off weed", "since": since, "notes": "legacy client"})
    assert r.status_code == 200
    assert read_streaks()[0]["notes"] == "legacy client"


def test_remove_deletes_by_id(client):
    client.post("/api/streaks/add", json={"label": "a", "since": days_ago(1)})
    client.post("/api/streaks/add", json={"label": "b", "since": days_ago(1)})
    sid = next(s["id"] for s in read_streaks() if s["label"] == "a")
    client.post("/api/streaks/remove", json={"id": sid})
    assert [s["label"] for s in read_streaks()] == ["b"]


def test_habit_rename_rewrites_streak_links(client, data_dir):
    seed_raw([{"label": "patches", "since": days_ago(1),
               "habit_key": "morning|Nicotine patch"}])
    streaks.rewrite_habit_links("morning|Nicotine patch", "evening|Nicotine patch")
    assert read_streaks()[0]["habit_key"] == "evening|Nicotine patch"


def test_notes_endpoint_serves_tagged_pool_cards(client, data_dir, tmp_path, monkeypatch):
    monkeypatch.setattr(store, "CONTENT_DIR", tmp_path)
    pool = tmp_path / "_system" / "data" / "cards"
    pool.mkdir(parents=True)
    fresh_ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    pool.joinpath("2026-07-20.1901b.md").write_text(
        f"---\nid: 2026-07-20.1901b\nwho: B\nts: {fresh_ts}\nreply_to: null\n"
        "tags: [counter-on-peptides]\nkind: line\nrefs: []\n---\nlast dose today\n")
    pool.joinpath("2026-07-01.0900b.md").write_text(
        "---\nid: 2026-07-01.0900b\nwho: B\nts: 2026-07-01 09:00:00\nreply_to: null\n"
        "tags: [counter-on-peptides]\nkind: line\nrefs: []\n---\nolder note\n")
    pool.joinpath("2026-07-20.1902k.md").write_text(
        f"---\nid: 2026-07-20.1902k\nwho: K\nts: {fresh_ts}\nreply_to: null\n"
        "tags: [counter-on-peptides]\nkind: line\nrefs: []\n---\nkeeper commentary\n")
    seed_raw([{"label": "on peptides", "since": days_ago(9)}])
    slug = read_streaks() and streaks.load_streaks("all")[0]["slug"]

    r = client.get(f"/api/streaks/{slug}/notes")
    assert r.status_code == 200
    notes = r.get_json()["notes"]
    # keeper card excluded; ascending by ts; 24h edit window honored
    assert [n["body"] for n in notes] == ["older note", "last dose today"]
    assert notes[0]["editable"] is False and notes[1]["editable"] is True


def test_notes_endpoint_404s_on_unknown_slug(client):
    assert client.get("/api/streaks/nope/notes").status_code == 404
