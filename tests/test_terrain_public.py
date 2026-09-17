"""The Terrain map for a visitor (public_config.PUBLIC_PATHS + the visitor
lock in routes/terrain.py).

The owner's decision (2026-09-17): "i am ok with personal stuff showing on
the map, just make all personal files unreadable to visitors, but the code
can be interactive for visitors." So, for a logged-out visitor — on the
private site's public view AND on the public-only mirror alike:
  - the map page and its payload answer 200
  - a git-tracked app-code file opens (200, with its text)
  - a vault file answers 403 `private`, and none of its text travels
  - an untracked app-repo file is private too (logs, CLAUDE.local.md)
  - path traversal is still a 404, whoever asks
  - what writes, arms or streams stays 401: traces, flow, creek, the roster
The owner keeps reading the vault through the same endpoint.
"""
from pathlib import Path

import pytest

import store


SECRET_LINE = "what i really think about all this"


@pytest.fixture
def repos(tmp_path, monkeypatch):
    """Re-root Terrain's vault at a temp dir holding one private file; the
    app-code repo stays the real one (server.py is tracked there)."""
    from routes import observatory
    vault = tmp_path / "vault"
    (vault / "tulku").mkdir(parents=True)
    (vault / "tulku" / "journal.md").write_text(SECRET_LINE + "\n")
    monkeypatch.setattr(observatory, "_terrain_repos", lambda: (
        {"id": "skeleton", "name": "App code", "root": Path(store.BUILD_DIR)},
        {"id": "vault", "name": "Personal vault", "root": vault},
    ))
    return vault


def _client(monkeypatch, *, mirror, authed):
    if mirror:
        monkeypatch.setenv("EXOCORTEX_PUBLIC_ONLY", "1")
    else:
        monkeypatch.delenv("EXOCORTEX_PUBLIC_ONLY", raising=False)
    import server
    c = server.app.test_client()
    if authed:
        with c.session_transaction() as sess:
            sess["authed"] = True
    return c


@pytest.fixture(params=["private-site-visitor", "mirror"])
def visitor(request, data_dir, repos, monkeypatch):
    """A stranger, both ways: logged out on the private site, or on the
    mirror carrying a session cookie that must count for nothing."""
    mirror = request.param == "mirror"
    return _client(monkeypatch, mirror=mirror, authed=mirror)


@pytest.fixture
def owner(data_dir, repos, monkeypatch):
    return _client(monkeypatch, mirror=False, authed=True)


def _file(c, repo, path):
    return c.get(f"/api/observatory/terrain/file?repo={repo}&path={path}")


def test_map_page_and_payload_open_to_visitors(visitor):
    assert visitor.get("/terrain/map").status_code == 200
    resp = visitor.get("/api/observatory/terrain")
    assert resp.status_code == 200
    assert {r["id"] for r in resp.get_json()["repos"]} == {"skeleton", "vault"}


def test_visitor_reads_tracked_app_code(visitor):
    resp = _file(visitor, "skeleton", "server.py")
    assert resp.status_code == 200
    assert "def gate" in resp.get_json()["content"]


def test_visitor_cannot_read_the_vault(visitor):
    resp = _file(visitor, "vault", "tulku/journal.md")
    assert resp.status_code == 403
    body = resp.get_json()
    assert body["private"] is True and body["error"] == "private"
    assert SECRET_LINE not in resp.get_data(as_text=True)


def test_visitor_cannot_read_untracked_app_files(visitor, monkeypatch):
    from routes import terrain
    monkeypatch.setattr(terrain, "_tracked_paths", lambda root: frozenset())
    assert _file(visitor, "skeleton", "server.py").status_code == 403


def test_traversal_is_still_not_found(visitor):
    assert _file(visitor, "skeleton", "../../etc/passwd").status_code == 404
    assert _file(visitor, "skeleton", "../vault/tulku/journal.md").status_code == 404


def test_what_writes_or_streams_stays_closed(visitor):
    assert visitor.post("/api/observatory/terrain/trace/arm", json={}).status_code == 401
    assert visitor.get("/api/observatory/terrain/trace").status_code == 401
    assert visitor.get("/api/observatory/flow").status_code == 401
    assert visitor.get("/api/creek?days=14").status_code == 401
    assert visitor.get("/api/sessions").status_code == 401
    assert visitor.get("/api/observatory/terrain/growth").status_code == 401


def test_owner_still_reads_the_vault(owner):
    resp = _file(owner, "vault", "tulku/journal.md")
    assert resp.status_code == 200
    assert SECRET_LINE in resp.get_json()["content"]
