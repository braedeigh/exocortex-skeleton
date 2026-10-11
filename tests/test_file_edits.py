"""Tests for file_edits.py + routes/file_edit.py — editing a file in the browser,
and a session asking the owner to.

What has to hold, and would break without anyone noticing:

  - She can open and save a settings file (`.env`) in a build, the case this
    was made for, and the file keeps its permissions.
  - Nothing outside the readable folders is reachable: not by '../', not by a
    symlink, not git's own files.
  - A save never replaces a change made on disk after the editor opened.
  - A session's request is answered by a save of that file from anywhere, and
    what the session is told never carries the file's text. Neither does the
    queue.
  - A visitor reaches none of it.

Real files in tmp_path; waking a session is swapped for a list.
"""
import os
import stat

import pytest
from flask import Flask, request

import file_edits
import store
from routes import file_edit, observatory, terrain

SECRET = "re_sup3r-s3cret-value"


@pytest.fixture
def build(data_dir, tmp_path, monkeypatch):
    """The app, the vault and one build, each an empty temp folder, with a
    settings file in the build."""
    for name in ("app", "vault", "side"):
        (tmp_path / name).mkdir()
    monkeypatch.setattr(observatory, "_terrain_repos", lambda: (
        {"id": "skeleton", "name": "App code", "root": tmp_path / "app"},
        {"id": "vault", "name": "Personal vault", "root": tmp_path / "vault"},
    ))
    monkeypatch.setattr(terrain.buildlist, "repos", lambda: (
        {"id": "side", "name": "Side", "root": tmp_path / "side"},))
    env = tmp_path / "side" / ".env"
    env.write_text("AUTH_SECRET=keep-me\nRESEND_API_KEY=\n")
    os.chmod(env, 0o600)
    return tmp_path / "side"


@pytest.fixture
def woken(monkeypatch):
    calls = []
    monkeypatch.setattr(observatory, "queue_followup",
                        lambda conv, text, system=None: calls.append((conv, text, system)))
    return calls


@pytest.fixture
def client(build):
    app = Flask(__name__)
    file_edit.register(app)
    return app.test_client()


def _open(client, path=".env", repo="side"):
    return client.get("/api/file-edit", query_string={"repo": repo, "path": path})


def _save(client, content, version, path=".env", repo="side"):
    return client.post("/api/file-edit", json={
        "repo": repo, "path": path, "content": content, "version": version})


def test_she_fills_in_a_setting_and_the_file_keeps_its_permissions(client, build, woken):
    opened = _open(client).get_json()
    filled = opened["content"].replace("RESEND_API_KEY=", f"RESEND_API_KEY={SECRET}")
    assert _save(client, filled, opened["version"]).status_code == 200
    env = build / ".env"
    assert env.read_text() == f"AUTH_SECRET=keep-me\nRESEND_API_KEY={SECRET}\n"
    assert stat.S_IMODE(env.stat().st_mode) == 0o600
    assert [p.name for p in build.iterdir()] == [".env"]   # no temp file left behind


@pytest.mark.parametrize("path", ["../outside.txt", "/etc/hostname", "link.txt",
                                  ".git/config", "missing.txt", "sub"])
def test_nothing_outside_the_readable_folders_opens_or_saves(client, build, path):
    outside = build.parent / "outside.txt"
    outside.write_text("private")
    (build / "link.txt").symlink_to(outside)
    (build / ".git").mkdir()
    (build / ".git" / "config").write_text("[core]\n")
    (build / "sub").mkdir()
    assert _open(client, path).status_code in (403, 404)
    assert _save(client, "x", "any", path).status_code in (403, 404)
    assert outside.read_text() == "private"


def test_a_save_over_a_file_that_changed_on_disk_is_refused(client, build):
    opened = _open(client).get_json()
    (build / ".env").write_text("AUTH_SECRET=keep-me\nRESEND_API_KEY=\nADDED_BY_AGENT=1\n")
    assert _save(client, "mine", opened["version"]).status_code == 409
    assert "ADDED_BY_AGENT=1" in (build / ".env").read_text()


def test_a_save_answers_the_request_without_the_files_text(client, build, woken):
    first = file_edits.file_request(str(build / ".env"), "c1", "paste the key")
    second = file_edits.file_request(str(build / ".env"), "c2")
    assert (second["id"], second["joined"]) == (first["id"], True)
    assert client.get("/api/file-edit/requests").get_json()["open"][0]["path"] == ".env"

    opened = _open(client).get_json()
    saved = _save(client, f"RESEND_API_KEY={SECRET}\n", opened["version"]).get_json()

    assert saved["woken"] == 1 and [conv for conv, _, _ in woken] == ["c1", "c2"]
    assert client.get("/api/file-edit/requests").get_json()["open"] == []
    everything_recorded = repr(woken) + store.file_path("file_requests").read_text() + repr(saved)
    assert SECRET not in everything_recorded and "keep-me" not in everything_recorded


def test_a_request_for_a_file_the_editor_cant_open_is_refused_before_it_is_filed(build):
    with pytest.raises(file_edits.Refused):
        file_edits.file_request("/etc/hostname", "c1")
    with pytest.raises(file_edits.Refused):
        file_edits.file_request(str(build / "not-there.env"), "c1")
    assert file_edits.listing()["open"] == []


def test_dismissing_a_request_wakes_the_session_and_changes_nothing(client, build, woken):
    req = file_edits.file_request(str(build / ".env"), "c1")
    assert client.post(f"/api/file-edit/requests/{req['id']}/dismiss").status_code == 200
    assert "without saving" in woken[0][1] and (build / ".env").read_text().endswith("RESEND_API_KEY=\n")
    assert client.post(f"/api/file-edit/requests/{req['id']}/dismiss").status_code == 409


def test_a_visitor_reaches_none_of_it(build):
    app = Flask(__name__)

    @app.before_request
    def as_visitor():
        request.view_mode = "public"

    file_edit.register(app)
    visitor = app.test_client()
    assert _open(visitor).status_code == 401
    assert _save(visitor, "x", "any").status_code == 401
    assert visitor.get("/api/file-edit/requests").status_code == 401
    assert visitor.post("/api/file-edit/requests/x/dismiss").status_code == 401
    assert (build / ".env").read_text().startswith("AUTH_SECRET=keep-me")
