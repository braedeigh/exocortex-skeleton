"""Shared pytest fixtures.

The whole app reads and writes JSON through ``store`` (see store.py). Every test
gets its own throwaway data directory by monkeypatching ``store.DATA_DIR`` to a
pytest ``tmp_path`` — so tests never touch real data and never collide with each
other. Route tests build a *minimal* Flask app that registers only the blueprint
under test, which keeps them fast and free of server.py's startup/auth machinery.
"""
import os
import tempfile

import pytest

# A harmless default so importing store at collection time doesn't fall back to
# the real data dir. Individual tests get isolated dirs via the `data_dir` fixture.
os.environ.setdefault("EXOCORTEX_DATA_DIR", tempfile.mkdtemp(prefix="exo-test-default-"))

import store  # noqa: E402


@pytest.fixture
def data_dir(tmp_path, monkeypatch):
    """Point the store at a fresh temp dir for this test only."""
    monkeypatch.setattr(store, "DATA_DIR", tmp_path)
    monkeypatch.setattr(store, "UPLOAD_DIR", tmp_path / "uploads")
    return tmp_path


@pytest.fixture
def seed(data_dir):
    """Write a todos.json. Call with no args for empty buckets, or pass a dict."""
    def _seed(data=None):
        store.write("todos", data if data is not None else {
            "now": {"items": []},
            "up_next": {"items": []},
            "later": {"items": []},
            "someday": {"items": []},
            "done": {"items": []},
        })
    return _seed


@pytest.fixture
def client(data_dir):
    """A test client for a minimal app exposing the todo + places routes."""
    from flask import Flask
    from routes import todos, places
    app = Flask(__name__)
    app.config.update(TESTING=True)
    todos.register(app)
    places.register(app)
    return app.test_client()


def read_todos():
    """Read the raw todos.json the routes just wrote (no id back-fill)."""
    return store.read("todos", {})
