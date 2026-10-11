"""routes/linear_room.py and the `linear` lane in routes/observatory.py:
a session created in the lane stands in the room folder and never asks
(the act gate would stop it on every Linear call), and GET /api/linear-room
lists exactly the lane's sessions — including one that only its folder
places there. The live board (read from Linear with a personal key), the
writes made from the page, quick capture and "Work on this" are tested
against a fake Linear standing in for linear_api._post.

Minimal app (linear_room + observatory registered), the data dir patched per
test, the room folder pointed at a tmp_path.
"""
import pytest
from flask import Flask

import config
import linear_api
import recap_summary
import store
from routes import linear_room, observatory


@pytest.fixture
def room_client(data_dir, tmp_path, monkeypatch):
    room = tmp_path / "linear-room"
    room.mkdir()
    monkeypatch.setattr(store, "LINEAR_ROOM_DIR", room)
    monkeypatch.setattr(store, "CONTENT_DIR", tmp_path / "content")
    monkeypatch.setattr(recap_summary, "_spawn", lambda fn: None)
    app = Flask(__name__)
    app.config.update(TESTING=True)
    linear_room.register(app)
    observatory.register(app)
    return app.test_client()


def test_a_linear_session_stands_in_the_room_and_is_never_gated(room_client):
    body = room_client.post("/api/observatory/conversations",
                            json={"title": "plan", "lane": "linear"}).get_json()
    assert body["ok"] and body["lane"] == "linear"
    entry = store.read("bot_chats/index", {})[body["id"]]
    assert entry["cwd"] == str(store.LINEAR_ROOM_DIR)
    config = observatory._conv_config(entry)
    assert config["act_gate"] is False and config["guard_docs"] is False


def test_the_room_lists_its_own_sessions_and_nothing_else(room_client):
    created = room_client.post("/api/observatory/conversations",
                               json={"title": "plan", "lane": "linear"}).get_json()["id"]
    room_client.post("/api/observatory/conversations", json={"title": "build", "lane": "coding"})
    # An entry with no lane written, rooted in the room folder, still belongs.
    with store.mutate("bot_chats/index", {}) as index:
        index["old-one"] = {"title": "older", "started": "2026-01-01T00:00:00",
                            "cwd": str(store.LINEAR_ROOM_DIR)}
    body = room_client.get("/api/linear-room").get_json()
    assert [r["id"] for r in body["sessions"]] == [created, "old-one"]
    assert body["running"] == 0 and body["model_choices"]


# --- The live board and acting on Linear (linear_api.py, mocked) -----------
# A fake Linear stands in for linear_api._post: it answers the board, issue
# and viewer queries from one small workspace and records every mutation, so
# these tests exercise the routes the way the page does, without the network.

ME, THEM = "user-me", "user-them"
STATES = [
    {"id": "s-done", "name": "Done", "type": "completed", "position": 3},
    {"id": "s-todo", "name": "Todo", "type": "unstarted", "position": 1},
    {"id": "s-back", "name": "Backlog", "type": "backlog", "position": 0},
    {"id": "s-prog", "name": "In Progress", "type": "started", "position": 2},
    {"id": "s-cxl", "name": "Canceled", "type": "canceled", "position": 4},
]


def _issue(uuid, ident, state, assignee=None, blocked_by=()):
    state_node = next(s for s in STATES if s["id"] == state)
    return {"id": uuid, "identifier": ident, "title": f"title {ident}",
            "url": f"https://linear.app/x/issue/{ident}", "updatedAt": "2026-09-30",
            "state": state_node, "assignee": assignee, "project": {"name": "Rebuild"},
            "projectMilestone": None, "relations": {"nodes": []},
            "inverseRelations": {"nodes": [
                {"type": "blocks", "issue": {"identifier": b, "title": b,
                                             "state": {"type": t}}}
                for b, t in blocked_by]}}


class FakeLinear:
    def __init__(self, states=STATES, issues=None, good_key="lin_api_good"):
        self.states, self.good_key, self.calls = states, good_key, []
        self.issues = issues if issues is not None else [
            # Hers and open, blocked by an open issue and a finished one.
            _issue("u1", "BAS-1", "s-todo", {"id": ME, "name": "me@example.com",
                                            "displayName": "me"},
                   blocked_by=[("BAS-2", "started"), ("BAS-9", "completed")]),
            # Theirs, in progress.
            _issue("u2", "BAS-2", "s-prog", {"id": THEM, "name": "Them"}),
            # Hers but done: not waiting on her.
            _issue("u3", "BAS-3", "s-done", {"id": ME, "name": "me@example.com",
                                            "displayName": "me"}),
        ]

    def __call__(self, query, variables, key):
        if key != self.good_key:
            raise linear_api.LinearAuthError("Linear refused the API key.")
        if "mutation" in query:
            self.calls.append(variables)
            if "issueCreate" in query:
                return {"issueCreate": {"success": True, "issue": {
                    "id": "new", "identifier": "BAS-10", "url": "https://linear.app/x/BAS-10"}}}
            name = "commentCreate" if "commentCreate" in query else "issueUpdate"
            return {name: {"success": True}}
        if "viewer { id name displayName email }" in query:
            return {"viewer": {"id": ME, "name": "me@example.com", "displayName": "me"}}
        if "query Issue" in query:
            return {"issue": {**self.issues[0], "description": "Fix the scale screen.",
                              "comments": {"nodes": [{"body": "seen it", "createdAt": "2026-09-30",
                                                      "user": {"name": "Them"}}]}}}
        if "query BoardIssues" in query:
            assert variables["teamId"] == "team-1"
            return {"issues": {"nodes": self.issues}}
        return {"viewer": {"id": ME, "name": "me@example.com", "displayName": "me"},
                "teams": {"nodes": [{
                    "id": "team-1", "key": "BAS", "name": "Basedfoods",
                    "states": {"nodes": self.states},
                    "members": {"nodes": [{"id": ME, "name": "me@example.com", "displayName": "me"},
                                          {"id": THEM, "name": "Them"}]}}]}}


@pytest.fixture
def linear(room_client, monkeypatch):
    """The room's client, with a saved good key and a fake Linear."""
    fake = FakeLinear()
    monkeypatch.setattr(linear_api, "_post", fake)
    monkeypatch.delenv("EXOCORTEX_LINEAR_API_KEY", raising=False)
    monkeypatch.setattr(config, "LINEAR_TEAM_KEY", "")
    linear_api.forget_board()
    config.linear_api_key_path().write_text(fake.good_key)
    return room_client, fake



def test_without_a_key_the_board_says_how_to_make_one(room_client, monkeypatch):
    monkeypatch.delenv("EXOCORTEX_LINEAR_API_KEY", raising=False)
    body = room_client.get("/api/linear-room/board").get_json()
    assert body["configured"] is False and "Personal API keys" in body["key_help"]


def test_a_pasted_key_is_checked_with_linear_saved_privately_and_never_echoed(room_client, monkeypatch):
    fake = FakeLinear()
    monkeypatch.setattr(linear_api, "_post", fake)
    monkeypatch.delenv("EXOCORTEX_LINEAR_API_KEY", raising=False)
    bad = room_client.post("/api/linear-room/key", json={"key": "lin_api_wrong"})
    assert bad.status_code == 400 and not config.linear_api_key_path().exists()
    good = room_client.post("/api/linear-room/key", json={"key": fake.good_key})
    path = config.linear_api_key_path()
    assert good.get_json() == {"ok": True, "name": "me"}
    assert fake.good_key not in good.get_data(as_text=True)
    assert path.read_text() == fake.good_key and (path.stat().st_mode & 0o077) == 0
    room_client.delete("/api/linear-room/key")
    assert not path.exists()


def test_the_board_groups_by_status_and_says_what_waits_on_her_and_what_is_blocked(linear):
    client, _ = linear
    body = client.get("/api/linear-room/board").get_json()
    assert [c["name"] for c in body["columns"]] == ["Backlog", "Todo", "In Progress", "Done", "Canceled"]
    by_ident = {i["identifier"]: i for c in body["columns"] for i in c["issues"]}
    # Only her open issue waits on her; only the open blocker counts.
    assert [i["identifier"] for i in body["waiting_on_you"]] == ["BAS-1"]
    assert by_ident["BAS-1"]["blocked"] and [b["identifier"] for b in by_ident["BAS-1"]["blocked_by"]] == ["BAS-2"]
    assert not by_ident["BAS-2"]["blocked"]
    assert by_ident["BAS-1"]["assignee"]["name"] == "me"  # an email name reads as the display name
    assert body["capture_into"]["name"] == "Backlog"      # no Triage on this team


def test_writes_go_to_linear_only_for_real_statuses_and_team_members(linear):
    client, fake = linear
    assert client.post("/api/linear-room/issue/u2/state", json={"state_id": "nope"}).status_code == 400
    assert client.post("/api/linear-room/issue/u2/assign", json={"assignee_id": "stranger"}).status_code == 400
    assert client.post("/api/linear-room/issue/u2/comment", json={"body": "  "}).status_code == 400
    assert fake.calls == []
    client.post("/api/linear-room/issue/u2/state", json={"state_id": "s-done"})
    client.post("/api/linear-room/issue/u2/assign", json={"assignee_id": ME})
    client.post("/api/linear-room/issue/u2/assign", json={"assignee_id": None})
    client.post("/api/linear-room/issue/u2/comment", json={"body": "on it"})
    assert fake.calls == [
        {"id": "u2", "input": {"stateId": "s-done"}},
        {"id": "u2", "input": {"assigneeId": ME}},
        {"id": "u2", "input": {"assigneeId": None}},
        {"input": {"issueId": "u2", "body": "on it"}},
    ]


def test_capture_files_a_new_issue_in_triage_when_the_team_has_one(room_client, monkeypatch):
    fake = FakeLinear(states=STATES + [{"id": "s-tri", "name": "Triage", "type": "triage", "position": 0}])
    monkeypatch.setattr(linear_api, "_post", fake)
    monkeypatch.delenv("EXOCORTEX_LINEAR_API_KEY", raising=False)
    linear_api.forget_board()
    config.linear_api_key_path().write_text(fake.good_key)
    body = room_client.post("/api/linear-room/capture",
                            json={"text": "that's a bug in the scale screen\nit rounds twice"}).get_json()
    assert body["identifier"] == "BAS-10" and body["status"] == "Triage"
    assert fake.calls[-1]["input"] == {"teamId": "team-1", "title": "that's a bug in the scale screen",
                                       "stateId": "s-tri", "description": "it rounds twice"}


def test_work_on_this_starts_one_briefed_linear_session_per_issue(linear):
    client, _ = linear
    first = client.post("/api/linear-room/issue/u1/work", json={}).get_json()
    entry = store.read("bot_chats/index", {})[first["id"]]
    assert entry["lane"] == "linear" and entry["cwd"] == str(store.LINEAR_ROOM_DIR)
    assert entry["autostart"] is True and entry["linear_issue"] == "BAS-1"
    assert "Fix the scale screen." in entry["draft"] and "https://linear.app/x/issue/BAS-1" in entry["draft"]
    again = client.post("/api/linear-room/issue/u1/work", json={}).get_json()
    assert again == {"ok": True, "id": first["id"], "existing": True}


def test_work_brief_names_the_owner_from_the_profile(linear):
    client, _ = linear
    store.write("profile", {"owner_name": "Rowan"})
    started = client.post("/api/linear-room/issue/u1/work", json={}).get_json()
    draft = store.read("bot_chats/index", {})[started["id"]]["draft"]
    assert "Nothing about Rowan's private life goes in." in draft and "ask Rowan here first" in draft


def test_a_revoked_key_sends_the_page_back_to_the_key_box(linear):
    client, _ = linear
    config.linear_api_key_path().write_text("lin_api_revoked")
    linear_api.forget_board()
    assert client.get("/api/linear-room/board").get_json()["refused"] is True
    assert client.post("/api/linear-room/issue/u2/comment", json={"body": "x"}).status_code == 409
