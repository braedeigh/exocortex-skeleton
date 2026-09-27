"""The worktree map: which session touched which checkout, worked out from
tool calls (routes/worktree_map.py). The attribution is pure, so most of this
runs build_map() on hand-made trees and calls; one route test checks the HTTP
contract with git and the database stubbed out."""
import json

import pytest
from flask import Flask

from routes import worktree_map

MAIN = "/w/skeleton"
COPY = "/w/skeleton-copy"
VAULT = "/w/personal"


def _trees():
    base = {"repo": "skeleton", "repo_path": MAIN, "head": "abc1234",
            "main_branch": "main", "missing": False}
    return [
        {**base, "path": MAIN, "branch": "main", "main": True},
        {**base, "path": COPY, "branch": "agent/copy", "main": False},
        {**base, "path": VAULT, "repo": "personal", "repo_path": VAULT,
         "branch": "main", "main": True},
    ]


def _call(conv, name, at="2026-09-27T10:00:00.000", cwd=None, **inp):
    target = inp.get("command") or inp.get("file_path")
    return (conv, at, name, target, json.dumps(inp), cwd)


def _agents(result, path):
    return {a["conv"]: a for a in next(t for t in result if t["path"] == path)["agents"]}


def test_an_edit_lands_in_the_tree_holding_the_file():
    rows = [_call("s1", "Edit", file_path=f"{COPY}/routes/a.py")]
    result = worktree_map.build_map(_trees(), rows, {})
    agent = _agents(result, COPY)["s1"]
    assert (agent["edited"], agent["files"]) == (1, [{"path": "routes/a.py", "edits": 1}])


def test_a_sibling_path_with_the_same_prefix_is_not_confused():
    rows = [_call("s1", "Bash", command=f"cd {COPY} && git status")]
    result = worktree_map.build_map(_trees(), rows, {})
    assert (_agents(result, MAIN), list(_agents(result, COPY))) == ({}, ["s1"])


def test_a_command_naming_two_trees_counts_in_both():
    rows = [_call("s1", "Bash", command=f"diff {MAIN}/a.py {COPY}/a.py")]
    result = worktree_map.build_map(_trees(), rows, {})
    assert ("s1" in _agents(result, MAIN), "s1" in _agents(result, COPY)) == (True, True)


def test_a_bare_command_counts_where_the_session_stands():
    rows = [_call("s1", "Bash", command="npm run build")]
    meta = {"s1": {"title": "Builder", "cwd": f"{COPY}", "lane": "orchestra"}}
    agent = _agents(worktree_map.build_map(_trees(), rows, meta), COPY)["s1"]
    assert (agent["ran"], agent["title"], agent["home"]) == (1, "Builder", True)


def test_a_relative_cd_from_the_parent_folder_counts_in_that_tree():
    rows = [_call("s1", "Bash", command="cd skeleton-copy && git status")]
    meta = {"s1": {"cwd": "/w"}}
    assert list(_agents(worktree_map.build_map(_trees(), rows, meta), COPY)) == ["s1"]


def test_a_cd_out_of_the_tree_does_not_count_where_the_session_stands():
    rows = [_call("s1", "Bash", command="cd /tmp && ls")]
    meta = {"s1": {"cwd": MAIN}}
    assert _agents(worktree_map.build_map(_trees(), rows, meta), MAIN) == {}


def test_reads_count_as_looking_not_working():
    rows = [_call("s1", "Read", file_path=f"{VAULT}/notes.md")]
    agent = _agents(worktree_map.build_map(_trees(), rows, {}), VAULT)["s1"]
    assert (agent["looked"], agent["last_write_at"]) == (1, None)


def test_tools_that_touch_no_tree_are_ignored():
    rows = [_call("s1", "WebFetch", url="https://example.com")]
    meta = {"s1": {"cwd": MAIN}}
    assert _agents(worktree_map.build_map(_trees(), rows, meta), MAIN) == {}


def test_recent_calls_come_newest_first_with_tree_relative_paths():
    rows = [_call("s1", "Bash", at="2026-09-27T10:00:00.000", command=f"cd {COPY}; ls"),
            _call("s1", "Edit", at="2026-09-27T10:05:00.000", file_path=f"{COPY}/x.py")]
    agent = _agents(worktree_map.build_map(_trees(), rows, {}), COPY)["s1"]
    assert [r["what"] for r in agent["recent"]] == ["x.py", "cd .; ls"]


@pytest.fixture
def client(data_dir, monkeypatch):
    monkeypatch.setattr(worktree_map, "list_trees", _trees)
    monkeypatch.setattr(worktree_map, "git_facts",
                        lambda trees, wait=False: {COPY: {"ahead": 2, "behind": 0,
                                                          "dirty": 1, "last_commit_at": None}})
    seen = {}

    def rows_since(since):
        seen["since"] = since
        return [_call("s1", "Edit", file_path=f"{COPY}/a.py")]

    monkeypatch.setattr(worktree_map, "_rows_since", rows_since)
    app = Flask(__name__)
    worktree_map.register(app)
    test_client = app.test_client()
    test_client.seen = seen
    return test_client


def test_the_route_returns_every_tree_with_its_agents_and_git_facts(client):
    body = client.get("/api/worktree-map?window=600").get_json()
    copy = next(t for t in body["trees"] if t["path"] == COPY)
    assert (body["window"], len(body["trees"]), copy["ahead"], copy["agents"][0]["conv"]) == \
        (600, 3, 2, "s1")


def test_the_window_is_clamped(client):
    assert client.get("/api/worktree-map?window=5").get_json()["window"] == 60
