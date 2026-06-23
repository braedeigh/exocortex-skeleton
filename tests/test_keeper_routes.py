"""Keeper memory browser routes — tree, read, write, and the scoping guards.

The keeper tab edits live memory files in the content vault, so the load-bearing
guarantees are: (1) it only ever touches *.md files *inside* the vault, and
(2) a crafted path can't escape it. Those are what these tests pin down.
"""
import pytest
from flask import Flask

import store
from routes import keeper


@pytest.fixture
def vault(tmp_path, monkeypatch):
    """A throwaway content vault with a few keeper-shaped files."""
    monkeypatch.setattr(store, "CONTENT_DIR", tmp_path)
    (tmp_path / "WORRIES.md").write_text("# Worries\n")
    (tmp_path / "people").mkdir()
    (tmp_path / "people" / "bryan.md").write_text("# Bryan\n")
    (tmp_path / "archive").mkdir()
    (tmp_path / "archive" / "old.md").write_text("ignore me\n")
    (tmp_path / "secret.txt").write_text("not markdown\n")
    return tmp_path


@pytest.fixture
def client(vault):
    app = Flask(__name__)
    app.config.update(TESTING=True)
    keeper.register(app)
    return app.test_client()


def test_tree_lists_markdown_grouped_and_skips_archive_and_nonmd(client):
    files = client.get("/api/keeper/tree").get_json()["files"]
    paths = {f["path"] for f in files}
    assert "WORRIES.md" in paths
    assert "people/bryan.md" in paths
    assert "archive/old.md" not in paths      # archive is hidden
    assert "secret.txt" not in paths          # non-markdown never surfaces
    groups = {f["path"]: f["group"] for f in files}
    assert groups["WORRIES.md"] == "Core"     # root files -> Core
    assert groups["people/bryan.md"] == "people"


def test_read_returns_content(client):
    data = client.get("/api/keeper/file?path=people/bryan.md").get_json()
    assert data["content"] == "# Bryan\n"
    assert data["path"] == "people/bryan.md"


def test_write_persists_to_disk(client, vault):
    resp = client.post("/api/keeper/file", json={"path": "WORRIES.md", "content": "# edited\n"})
    assert resp.get_json()["ok"] is True
    assert (vault / "WORRIES.md").read_text() == "# edited\n"


def test_traversal_is_blocked_on_read_and_write(client, tmp_path):
    # A path climbing out of the vault must be rejected, not read.
    for path in ["../../etc/passwd", "../outside.md"]:
        assert client.get("/api/keeper/file?path=" + path).status_code == 400
        assert client.post("/api/keeper/file", json={"path": path, "content": "x"}).status_code == 400
    # And it must not have written anything outside the vault.
    assert not (tmp_path.parent / "outside.md").exists()


def test_non_markdown_cannot_be_read_or_written(client):
    assert client.get("/api/keeper/file?path=secret.txt").status_code == 400
    assert client.post("/api/keeper/file", json={"path": "secret.txt", "content": "x"}).status_code == 400


def test_write_to_missing_file_is_refused(client):
    # The tab fixes existing memory; it doesn't conjure new keeper files.
    resp = client.post("/api/keeper/file", json={"path": "people/nobody.md", "content": "x"})
    assert resp.status_code == 404
