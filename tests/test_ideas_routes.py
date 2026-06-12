"""HTTP contract for the ideas doc routes (/api/ideas)."""
import pytest

import store


@pytest.fixture
def client(data_dir, tmp_path, monkeypatch):
    monkeypatch.setattr(store, "IDEAS_FILE", tmp_path / "docs" / "IDEAS.md")
    from flask import Flask
    from routes import ideas
    app = Flask(__name__)
    app.config.update(TESTING=True)
    ideas.register(app)
    return app.test_client()


def test_get_missing_file_returns_empty(client):
    res = client.get("/api/ideas")
    assert res.status_code == 200
    assert res.get_json()["content"] == ""


def test_save_then_get_roundtrip(client):
    res = client.post("/api/ideas", json={"content": "# Ideas\n\n## One\n\n- a thing\n"})
    assert res.status_code == 200
    assert client.get("/api/ideas").get_json()["content"].startswith("# Ideas")
    assert store.IDEAS_FILE.read_text().endswith("- a thing\n")


def test_save_creates_parent_dirs(client):
    assert not store.IDEAS_FILE.parent.exists()
    client.post("/api/ideas", json={"content": "hello"})
    assert store.IDEAS_FILE.read_text() == "hello"


def test_empty_save_refused_when_doc_has_content(client):
    client.post("/api/ideas", json={"content": "# the whole vision"})
    res = client.post("/api/ideas", json={"content": "   "})
    assert res.status_code == 400
    assert store.IDEAS_FILE.read_text() == "# the whole vision"


def test_missing_content_field_is_400(client):
    assert client.post("/api/ideas", json={}).status_code == 400
