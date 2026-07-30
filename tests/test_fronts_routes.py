"""Behavioral tests for the Fronts API (routes/fronts.py).

Fronts are a shared life-domain vocabulary (health, appearance, finances,
...) that research topics get tagged with. These pin down: slug id
generation with collision suffixes, rename-keeps-id, GET returns the seeded
list, and that removing a front strips its id from every research topic's
`fronts` list without touching the topics otherwise.
"""
import json

import pytest

from conftest import data_dir  # noqa: F401  (imported for fixture visibility)


def _post(client, path, payload):
    return client.post(path, data=json.dumps(payload), content_type="application/json")


@pytest.fixture
def client(data_dir):
    """A minimal app exposing fronts.py + research.py (needed for the
    remove-cleanup test, which strips a deleted front id from topics)."""
    from flask import Flask
    from routes import fronts, research
    app = Flask(__name__)
    app.config.update(TESTING=True)
    fronts.register(app)
    research.register(app)
    return app.test_client()


def _read_fronts():
    import store
    return store.read("fronts.json", {"fronts": []})


def _read_research():
    import store
    return store.read("research.json", {"topics": [], "entries": []})


# --- GET -----------------------------------------------------------------

def test_get_returns_seeded_list(client):
    import store
    store.write("fronts.json", {"fronts": [
        {"id": "health", "name": "Health", "created": "2026-07-13 15:30"},
        {"id": "job", "name": "Job", "created": "2026-07-13 15:30"},
    ]})
    r = client.get("/api/fronts")
    assert r.status_code == 200
    ids = [f["id"] for f in r.get_json()["fronts"]]
    assert ids == ["health", "job"]


def test_get_empty_when_no_file(client):
    r = client.get("/api/fronts")
    assert r.status_code == 200
    assert r.get_json() == {"fronts": []}


# --- add -------------------------------------------------------------------

def test_add_creates_slug_id(client):
    r = _post(client, "/api/fronts/add", {"name": "Living Space"})
    assert r.status_code == 200
    fronts = r.get_json()["fronts"]
    assert len(fronts) == 1
    assert fronts[0]["id"] == "living-space"
    assert fronts[0]["name"] == "Living Space"
    assert "created" in fronts[0]


def test_add_duplicate_name_gets_distinct_slug(client):
    _post(client, "/api/fronts/add", {"name": "Health"})
    r = _post(client, "/api/fronts/add", {"name": "Health"})
    ids = [f["id"] for f in r.get_json()["fronts"]]
    assert ids == ["health", "health-2"]


def test_add_empty_name_400(client):
    r = _post(client, "/api/fronts/add", {"name": "   "})
    assert r.status_code == 400
    assert _read_fronts()["fronts"] == []


# --- edit --------------------------------------------------------------------

def test_edit_renames_keeps_id(client):
    _post(client, "/api/fronts/add", {"name": "Job"})
    fid = _read_fronts()["fronts"][0]["id"]
    r = _post(client, "/api/fronts/edit", {"id": fid, "name": "Career"})
    assert r.status_code == 200
    front = r.get_json()["fronts"][0]
    assert front["id"] == fid
    assert front["name"] == "Career"


def test_edit_not_found_404(client):
    r = _post(client, "/api/fronts/edit", {"id": "missing", "name": "x"})
    assert r.status_code == 404


def test_edit_empty_name_rejected(client):
    _post(client, "/api/fronts/add", {"name": "Job"})
    fid = _read_fronts()["fronts"][0]["id"]
    r = _post(client, "/api/fronts/edit", {"id": fid, "name": "   "})
    assert r.status_code == 400
    assert _read_fronts()["fronts"][0]["name"] == "Job"


# --- remove ------------------------------------------------------------------

def test_remove_strips_id_from_research_topics(client):
    _post(client, "/api/fronts/add", {"name": "Health"})
    fid = _read_fronts()["fronts"][0]["id"]
    _post(client, "/api/research/topic/add", {"name": "Sleep", "fronts": [fid]})
    tid = _read_research()["topics"][0]["id"]

    r = _post(client, "/api/fronts/remove", {"id": fid})
    assert r.status_code == 200
    assert r.get_json()["fronts"] == []

    topics = _read_research()["topics"]
    assert len(topics) == 1
    assert topics[0]["id"] == tid          # the topic itself survives
    assert topics[0]["fronts"] == []       # but loses the removed front id


def test_remove_leaves_other_fronts_on_topic(client):
    _post(client, "/api/fronts/add", {"name": "Health"})
    _post(client, "/api/fronts/add", {"name": "Job"})
    f1, f2 = [f["id"] for f in _read_fronts()["fronts"]]
    _post(client, "/api/research/topic/add", {"name": "Sleep", "fronts": [f1, f2]})

    _post(client, "/api/fronts/remove", {"id": f1})

    topics = _read_research()["topics"]
    assert topics[0]["fronts"] == [f2]


def test_remove_unknown_id_is_a_noop(client):
    _post(client, "/api/fronts/add", {"name": "Health"})
    r = _post(client, "/api/fronts/remove", {"id": "no-such-front"})
    assert r.status_code == 200
    assert len(r.get_json()["fronts"]) == 1


def test_remove_strips_id_from_todo_fronts_lists(client):
    """To-dos carry the same `fronts` list as research topics (2026-07-14);
    deleting a front un-tags them too — items survive, an emptied list is
    dropped entirely (absent = untagged), other fronts stay."""
    import store
    _post(client, "/api/fronts/add", {"name": "Health"})
    _post(client, "/api/fronts/add", {"name": "Connection"})
    f1, f2 = [f["id"] for f in _read_fronts()["fronts"]]
    store.write("todos", {"now": {"items": [
        {"id": "a", "text": "run group", "done": False, "fronts": [f1, f2]},
        {"id": "b", "text": "nap", "done": False, "fronts": [f1]},
    ]}})

    _post(client, "/api/fronts/remove", {"id": f1})

    items = store.read("todos", {})["now"]["items"]
    assert items[0]["fronts"] == [f2]
    assert "fronts" not in items[1] and items[1]["text"] == "nap"


# --- overview ----------------------------------------------------------------

def _seed_overview(store):
    """Two fronts, and one live item on each tagged surface."""
    store.write("fronts.json", {"fronts": [
        {"id": "health", "name": "Health"},
        {"id": "job", "name": "Job"},
    ]})
    store.write("todos", {
        "now": {"items": [
            {"id": "a", "text": "run", "done": False, "fronts": ["health"]},
            {"id": "b", "text": "both", "done": False, "fronts": ["health", "job"]},
            {"id": "c", "text": "bare", "done": False},
            {"id": "d", "text": "finished", "done": True, "fronts": ["health"]},
        ]},
        "done": {"items": [{"id": "e", "text": "old", "fronts": ["job"]}]},
    })
    store.write("buy_list.json", {"items": [{"name": "shoes", "fronts": ["health"]}]})
    store.write("research.json", {
        "topics": [{"id": "t1", "name": "Sleep", "fronts": ["health"]}],
        "entries": [{"id": "e1", "topic": "t1"}],
    })


def test_overview_counts_live_items_per_front(client):
    import store
    _seed_overview(store)

    r = client.get("/api/fronts/overview")
    assert r.status_code == 200
    body = r.get_json()

    by_id = {f["id"]: f for f in body["fronts"]}
    assert by_id["health"]["sources"] == {
        "todos": 2, "threads": 0, "buy_list": 1, "research": 1,
    }
    assert by_id["health"]["total"] == 4
    # The multi-front item counts on BOTH fronts — totals can exceed the
    # number of things, and that's intended.
    assert by_id["job"]["sources"]["todos"] == 1


def test_overview_excludes_done_todos(client):
    """A done item and the whole `done` rung stay out of the counts — the
    overview is a picture of what's live, not an archive."""
    import store
    _seed_overview(store)
    by_id = {f["id"]: f for f in client.get("/api/fronts/overview").get_json()["fronts"]}
    # 'd' is done:True and 'e' sits in the done rung; neither may be counted.
    assert by_id["health"]["sources"]["todos"] == 2
    assert by_id["job"]["sources"]["todos"] == 1


def test_overview_reports_untagged_and_totals(client):
    import store
    _seed_overview(store)
    body = client.get("/api/fronts/overview").get_json()
    assert body["totals"]["todos"] == 3        # 3 live (the done one drops out)
    assert body["untagged"]["todos"] == 1      # only 'c' carries no front
    assert body["untagged"]["buy_list"] == 0


def test_overview_surfaces_orphan_front_ids(client):
    """An id in the data but NOT in fronts.json gets its own bucket instead of
    vanishing. This is the failure the to-do chip bar hides: chips render by
    mapping over the vocabulary, so an unknown id draws no chip and — having a
    front — doesn't fall into 'Other' either."""
    import store
    _seed_overview(store)
    store.write("todos", {"now": {"items": [
        {"id": "x", "text": "orphaned", "done": False, "fronts": ["ghost"]},
    ]}})

    body = client.get("/api/fronts/overview").get_json()
    assert body["orphans"] == {"ghost": 1}
    assert all(f["total"] == 0 for f in body["fronts"] if f["id"] == "job")


def test_overview_empty_vocabulary_is_not_an_error(client):
    r = client.get("/api/fronts/overview")
    assert r.status_code == 200
    body = r.get_json()
    assert body["fronts"] == []
    assert body["orphans"] == {}


# --- sessions on a front -------------------------------------------------------

def _seed_sessions(store):
    # bot_chats/ is a nested collection dir; the app mints it in _chats_dir()
    # on first use, so a bare tmp data dir needs it created here.
    (store.DATA_DIR / "bot_chats").mkdir(parents=True, exist_ok=True)
    store.write("fronts.json", {"fronts": [
        {"id": "living-space", "name": "Living space"},
        {"id": "exocortex", "name": "Exocortex"},
    ]})
    store.write("bot_chats/index", {
        "a": {"title": "Shelving", "front": "living-space", "last_at": "2026-07-30 10:00"},
        "b": {"title": "Terrain work", "last_at": "2026-07-30 12:00"},
        "c": {"title": "Untagged", "last_at": "2026-07-29 09:00"},
    })
    store.write("bot_chats/gists", {
        # The sorter's guess for 'b' — inferred, and the only front it has.
        "b": {"title": "Terrain work", "front": "exocortex", "gist": "Talked about the map."},
        # A guess that DISAGREES with 'a's explicit filing. Explicit must win.
        "a": {"title": "Shelving", "front": "exocortex", "gist": "Mentioned some code."},
    })


def test_sessions_use_explicit_front_over_inferred(client):
    import store
    _seed_sessions(store)

    ls = client.get("/api/fronts/living-space/sessions").get_json()["sessions"]
    assert [s["id"] for s in ls] == ["a"]
    assert ls[0]["source"] == "explicit"

    exo = client.get("/api/fronts/exocortex/sessions").get_json()["sessions"]
    # 'a' is filed to living-space explicitly, so the gist's exocortex guess
    # must NOT pull it in here.
    assert [s["id"] for s in exo] == ["b"]
    assert exo[0]["source"] == "inferred"


def test_sessions_sorted_by_recent_activity(client):
    import store
    _seed_sessions(store)
    store.write("bot_chats/index", {
        "old": {"title": "Old", "front": "living-space", "last_at": "2026-07-01 09:00"},
        "new": {"title": "New", "front": "living-space", "last_at": "2026-07-30 18:00"},
    })
    ids = [s["id"] for s in client.get("/api/fronts/living-space/sessions").get_json()["sessions"]]
    assert ids == ["new", "old"]


def test_sessions_empty_for_untagged_front(client):
    import store
    _seed_sessions(store)
    assert client.get("/api/fronts/health/sessions").get_json()["sessions"] == []


def test_sessions_survive_a_malformed_index(client):
    import store
    _seed_sessions(store)
    store.write("bot_chats/index", {"junk": "not a dict"})
    assert client.get("/api/fronts/living-space/sessions").get_json()["sessions"] == []


# --- the front brief -----------------------------------------------------------

def test_brief_carries_the_fronts_open_work(client):
    import store
    _seed_sessions(store)
    store.write("todos", {
        "now": {"items": [
            {"id": "t1", "text": "Get shelving", "done": False, "fronts": ["living-space"]},
            {"id": "t2", "text": "Elsewhere", "done": False, "fronts": ["exocortex"]},
            {"id": "t3", "text": "Finished", "done": True, "fronts": ["living-space"]},
        ]},
    })
    store.write("buy_list.json", {"items": [
        {"name": "Blender", "cost": "$60", "fronts": ["living-space"]},
        {"name": "Not mine", "fronts": ["exocortex"]},
    ]})

    brief = client.get("/api/fronts/living-space/brief").get_json()["brief"]
    assert "Living space" in brief
    assert "Get shelving" in brief
    assert "Blender" in brief
    # Other fronts' work and completed items stay out.
    assert "Elsewhere" not in brief
    assert "Not mine" not in brief
    assert "Finished" not in brief


def test_brief_says_it_is_a_snapshot(client):
    """The brief is written once, at session start. It has to admit that in its
    own text — a stale list presented as current is the failure mode."""
    import store
    _seed_sessions(store)
    brief = client.get("/api/fronts/living-space/brief").get_json()["brief"]
    assert "snapshot" in brief.lower()


def test_brief_404s_for_unknown_front(client):
    import store
    _seed_sessions(store)
    assert client.get("/api/fronts/nope/brief").status_code == 404


# --- room layouts ------------------------------------------------------------

def test_layout_defaults_to_empty(client):
    r = client.get("/api/fronts/layout/living-space")
    assert r.status_code == 200
    assert r.get_json() == {"front": "living-space", "panels": {}}


def test_layout_round_trips(client):
    panels = {"todos": {"x": 0, "y": 0, "w": 4, "h": 8}, "buy": {"x": 4, "y": 0, "w": 8, "h": 5}}
    r = _post(client, "/api/fronts/layout/living-space", {"panels": panels})
    assert r.status_code == 200
    assert client.get("/api/fronts/layout/living-space").get_json()["panels"] == panels


def test_layouts_are_per_front(client):
    _post(client, "/api/fronts/layout/living-space", {"panels": {"todos": {"x": 0, "y": 0, "w": 4, "h": 4}}})
    _post(client, "/api/fronts/layout/health", {"panels": {"todos": {"x": 6, "y": 2, "w": 3, "h": 3}}})
    assert client.get("/api/fronts/layout/health").get_json()["panels"]["todos"]["x"] == 6
    assert client.get("/api/fronts/layout/living-space").get_json()["panels"]["todos"]["x"] == 0


def test_layout_clamps_off_grid_geometry(client):
    """Geometry is clamped, not trusted — a panel dragged past the edge comes
    back on-grid rather than being saved where the room can't draw it."""
    r = _post(client, "/api/fronts/layout/living-space", {"panels": {
        "wide": {"x": 11, "y": 0, "w": 99, "h": 4},     # w over-wide, x then pinned to 0
        "tiny": {"x": -5, "y": -3, "w": 0, "h": 0},     # under the minimums
    }})
    panels = r.get_json()["panels"]
    assert panels["wide"] == {"x": 0, "y": 0, "w": 12, "h": 4}
    assert panels["tiny"] == {"x": 0, "y": 0, "w": 2, "h": 2}


def test_layout_rejects_malformed_panel(client):
    r = _post(client, "/api/fronts/layout/living-space", {"panels": {"todos": {"x": "left"}}})
    assert r.status_code == 400
    # Nothing persisted from a rejected save.
    assert client.get("/api/fronts/layout/living-space").get_json()["panels"] == {}


def test_empty_save_forgets_the_arrangement(client):
    """Posting no panels is 'reset me' — the entry is dropped so the room falls
    back to its auto-tiled default instead of rendering an empty arrangement."""
    _post(client, "/api/fronts/layout/living-space", {"panels": {"todos": {"x": 1, "y": 1, "w": 4, "h": 4}}})
    _post(client, "/api/fronts/layout/living-space", {"panels": {}})
    assert client.get("/api/fronts/layout/living-space").get_json()["panels"] == {}


def test_remove_strips_id_from_buy_list_fronts(client):
    """Buy-list items carry `fronts` too (2026-07-14, routes/inventory.py);
    deleting a front un-tags them — items survive, other fronts stay, an
    emptied list stays as [] (the buy list renders [] as untagged)."""
    import store
    _post(client, "/api/fronts/add", {"name": "Health"})
    _post(client, "/api/fronts/add", {"name": "Appearance"})
    f1, f2 = [f["id"] for f in _read_fronts()["fronts"]]
    store.write("buy_list.json", {"items": [
        {"name": "Barefoot shoes", "fronts": [f1, f2]},
        {"name": "MCT oil", "fronts": [f1]},
    ]})

    _post(client, "/api/fronts/remove", {"id": f1})

    items = store.read("buy_list.json", {"items": []})["items"]
    assert items[0]["fronts"] == [f2]
    assert items[1]["fronts"] == [] and items[1]["name"] == "MCT oil"
