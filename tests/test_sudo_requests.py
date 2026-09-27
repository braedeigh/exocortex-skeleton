"""Tests for sudo_requests.py + routes/sudo.py — agents' sudo requests.

No test runs sudo: every approve goes through a fake runner that records what
it was handed, and waking a session is swapped for a list.
"""
import pytest
from flask import Flask

import config
import sudo_requests
from routes import sudo


@pytest.fixture
def woken(monkeypatch):
    calls = []
    monkeypatch.setattr(sudo_requests, "_wake", lambda req: calls.append(req))
    return calls


class FakeSudo:
    def __init__(self, code=0, out="", err=""):
        self.code, self.out, self.err, self.calls = code, out, err, []

    def __call__(self, argv, password):
        self.calls.append((argv, password))
        return self.code, self.out, self.err


@pytest.fixture
def client(data_dir, monkeypatch):
    app = Flask(__name__)
    sudo.register(app)
    return app.test_client()


def test_unknown_action_is_refused_before_anything_is_written(data_dir):
    with pytest.raises(ValueError, match="unknown action"):
        sudo_requests.file_request("rm -rf /", "c1")
    assert sudo_requests.listing()["open"] == []


def test_second_asker_for_the_same_action_joins_the_open_request(data_dir):
    first = sudo_requests.file_request("reload", "c1", "edited a route")
    second = sudo_requests.file_request("reload", "c2", "me too")
    assert (second["id"], second["joined"]) == (first["id"], True)
    assert [a["conv"] for a in sudo_requests.listing()["open"][0]["askers"]] == ["c1", "c2"]


def test_approve_runs_the_configured_command_not_anything_stored(data_dir, woken):
    req = sudo_requests.file_request("reload", "c1")
    fake = FakeSudo()
    result = sudo_requests.approve(req["id"], "hunter2", runner=fake)
    assert result["status"] == "done"
    assert fake.calls == [(config.SUDO_ACTIONS["reload"]["argv"], "hunter2")]


def test_approved_request_closes_and_wakes_its_askers(data_dir, woken):
    req = sudo_requests.file_request("reload", "c1")
    sudo_requests.approve(req["id"], "pw", runner=FakeSudo())
    assert [w["id"] for w in woken] == [req["id"]] and sudo_requests.listing()["open"] == []


def test_wrong_password_leaves_the_request_open_and_wakes_nobody(data_dir, woken):
    req = sudo_requests.file_request("reload", "c1")
    fake = FakeSudo(code=1, err="sudo: 1 incorrect password attempt")
    assert sudo_requests.approve(req["id"], "nope", runner=fake)["status"] == "wrong_password"
    assert sudo_requests.listing()["open"][0]["status"] == "open" and woken == []


def test_no_password_when_sudo_needs_one_asks_for_it(data_dir, woken):
    req = sudo_requests.file_request("reload", "c1")
    fake = FakeSudo(code=1, err="sudo: a password is required")
    assert sudo_requests.approve(req["id"], "", runner=fake)["status"] == "needs_password"


def test_password_is_never_written_to_the_queue(data_dir, woken):
    req = sudo_requests.file_request("reload", "c1")
    sudo_requests.approve(req["id"], "s3cret-pw", runner=FakeSudo(out="ok"))
    assert "s3cret-pw" not in sudo_requests.store.file_path("sudo_requests").read_text()


def test_deny_closes_and_wakes(data_dir, woken):
    req = sudo_requests.file_request("reload", "c1")
    sudo_requests.deny(req["id"])
    assert sudo_requests.listing()["recent"][-1]["status"] == "denied" and len(woken) == 1


def test_route_lists_open_requests_with_the_exact_command(client, woken):
    sudo_requests.file_request("reload", "c1", "why")
    body = client.get("/api/sudo/requests").get_json()
    assert body["open"][0]["command"] == "sudo " + " ".join(config.SUDO_ACTIONS["reload"]["argv"])


def test_route_approve_twice_is_a_conflict(client, woken, monkeypatch):
    monkeypatch.setattr(sudo_requests, "_run_sudo", FakeSudo())
    req = sudo_requests.file_request("reload", "c1")
    assert client.post(f"/api/sudo/requests/{req['id']}/approve", json={"password": "p"}).status_code == 200
    assert client.post(f"/api/sudo/requests/{req['id']}/approve", json={"password": "p"}).status_code == 409


def test_route_unknown_request_is_404(client):
    assert client.post("/api/sudo/requests/nope/deny").status_code == 404
