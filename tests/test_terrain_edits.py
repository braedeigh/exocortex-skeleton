"""GET /api/observatory/terrain/file/edits — when each line of a file was
last edited, from `git blame`, for the file pane's red-edits toggle
(routes/terrain.py `_terrain_line_edits`).

The vault is re-rooted at a temp git repo with one committed file, so the
test controls the commit time. The contract:
  - a tracked file answers one unix-second stamp per line, in file order,
    each the time of the commit that last touched it
  - a line edited on disk but not committed is stamped NOW-ish (git says
    "Not Committed Yet"), so the newest edit reads hottest
  - an untracked file answers `edits: null` — nothing to say, no guess
  - the same door as /terrain/file: traversal is a 404, a visitor's vault
    read is a 403 `private`
"""
import subprocess
import time
from pathlib import Path

import pytest

import store


COMMIT_EPOCH = 1_700_000_000


def _git(root, *args, env=None):
    subprocess.run(["git", "-C", str(root), *args], check=True,
                   capture_output=True, env=env)


@pytest.fixture
def vault(tmp_path, monkeypatch):
    """A temp vault that is a real git repo: `notes.md` committed at a
    known time, `scratch.md` never added."""
    from routes import observatory
    root = tmp_path / "vault"
    root.mkdir()
    _git(root, "init", "-q")
    _git(root, "config", "user.email", "t@example.com")
    _git(root, "config", "user.name", "Test")
    (root / "notes.md").write_text("one\ntwo\nthree\n")
    (root / "scratch.md").write_text("never added\n")
    _git(root, "add", "notes.md")
    import os
    env = dict(os.environ, GIT_AUTHOR_DATE=f"{COMMIT_EPOCH} +0000",
               GIT_COMMITTER_DATE=f"{COMMIT_EPOCH} +0000")
    _git(root, "commit", "-q", "-m", "first", env=env)
    monkeypatch.setattr(observatory, "_terrain_repos", lambda: (
        {"id": "skeleton", "name": "App code", "root": Path(store.BUILD_DIR)},
        {"id": "vault", "name": "Personal vault", "root": root},
    ))
    return root


def _client(monkeypatch, authed):
    monkeypatch.delenv("EXOCORTEX_PUBLIC_ONLY", raising=False)
    import server
    c = server.app.test_client()
    if authed:
        with c.session_transaction() as sess:
            sess["authed"] = True
    return c


@pytest.fixture
def owner(data_dir, vault, monkeypatch):
    return _client(monkeypatch, authed=True)


@pytest.fixture
def visitor(data_dir, vault, monkeypatch):
    return _client(monkeypatch, authed=False)


def _edits(c, repo, path):
    return c.get(f"/api/observatory/terrain/file/edits?repo={repo}&path={path}")


def test_tracked_file_stamps_every_line_with_its_commit_time(owner):
    r = _edits(owner, "vault", "notes.md")
    assert r.status_code == 200
    assert r.get_json()["edits"] == [COMMIT_EPOCH] * 3


def test_uncommitted_line_reads_as_just_now(owner, vault):
    (vault / "notes.md").write_text("one\ntwo (changed)\nthree\n")
    before = int(time.time()) - 5
    edits = _edits(owner, "vault", "notes.md").get_json()["edits"]
    assert edits[0] == COMMIT_EPOCH and edits[2] == COMMIT_EPOCH
    assert edits[1] >= before


def test_untracked_file_has_no_history(owner):
    r = _edits(owner, "vault", "scratch.md")
    assert r.status_code == 200
    assert r.get_json()["edits"] is None


def test_traversal_is_not_found(owner):
    assert _edits(owner, "vault", "../../etc/passwd").status_code == 404


def test_visitor_cannot_read_vault_edits(visitor):
    r = _edits(visitor, "vault", "notes.md")
    assert r.status_code == 403
    assert "edits" not in (r.get_json() or {})
