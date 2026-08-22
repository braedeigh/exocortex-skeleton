"""features.py — the fork's non-destructive excision layer.

Contract pinned here: code DEFAULTS stay all-on (stock upstream behavior);
a deployment tightens via features.json in the DATA dir (survives updates)
or EXOCORTEX_FEATURE_* env (wins over the file); unknown flags fail closed.
"""
import json

import pytest
from flask import Flask

import features
import store
from routes import terminal


@pytest.fixture
def data_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "DATA_DIR", tmp_path)
    return tmp_path


def test_defaults_are_all_on_stock_upstream(data_dir):
    assert features.enabled("web_terminal") is True
    assert features.enabled("observatory") is True
    assert features.enabled("mcp_server") is True


def test_features_json_in_data_dir_overrides_defaults(data_dir):
    (data_dir / "features.json").write_text(json.dumps({"web_terminal": False}))
    assert features.enabled("web_terminal") is False
    assert features.enabled("observatory") is True  # untouched flags keep defaults


def test_env_wins_over_file(data_dir, monkeypatch):
    (data_dir / "features.json").write_text(json.dumps({"web_terminal": False}))
    monkeypatch.setenv("EXOCORTEX_FEATURE_WEB_TERMINAL", "1")
    assert features.enabled("web_terminal") is True


def test_unknown_flag_fails_closed(data_dir):
    assert features.enabled("nonexistent_surface") is False


def test_malformed_features_json_falls_back_to_defaults(data_dir):
    (data_dir / "features.json").write_text("{not json")
    assert features.enabled("web_terminal") is True


def test_snapshot_covers_defaults_and_file_flags(data_dir):
    (data_dir / "features.json").write_text(json.dumps({"custom_flag": True}))
    snap = features.snapshot()
    assert snap["custom_flag"] is True
    assert set(features.DEFAULTS) <= set(snap)


@pytest.fixture
def gated_client(data_dir, monkeypatch):
    """Minimal app with terminal routes registered and web_terminal OFF —
    the posture this fork actually runs."""
    (data_dir / "features.json").write_text(json.dumps({"web_terminal": False}))
    app = Flask(__name__)
    app.config.update(TESTING=True)
    terminal.register(app)
    return app.test_client()


def test_shell_endpoints_404_when_web_terminal_off(gated_client):
    for path, method in [("/api/terminal/send", "post"),
                         ("/api/terminal/capture", "get"),
                         ("/api/terminal/scroll", "post"),
                         ("/api/terminal/refresh", "post"),
                         ("/api/terminal/session", "get")]:
        resp = getattr(gated_client, method)(path, json={})
        assert resp.status_code == 404, path


def test_non_shell_terminal_routes_survive_the_gate(gated_client, monkeypatch):
    monkeypatch.setattr(terminal, "_load_sessions", lambda: [])
    resp = gated_client.get("/api/terminal/needs-input")
    assert resp.status_code == 200
    assert resp.get_json() == {"sessions": {}}


@pytest.fixture
def research_gated_client(data_dir):
    """Minimal app with research routes registered and research_workers OFF —
    the posture the 2026-08-21 burn rotation put this install in."""
    (data_dir / "features.json").write_text(json.dumps({"research_workers": False}))
    from routes import research
    app = Flask(__name__)
    app.config.update(TESTING=True)
    research.register(app)
    return app.test_client()


def test_worker_endpoints_404_when_research_workers_off(research_gated_client):
    for path in ["/api/research/send",
                 "/api/research/topic/distill",
                 "/api/research/annotation-batch",
                 "/api/research/file-unfiled"]:
        resp = research_gated_client.post(path, json={})
        assert resp.status_code == 404, path


def test_non_worker_research_routes_survive_the_gate(research_gated_client):
    resp = research_gated_client.post("/api/research/topic/add", json={"name": "gate check"})
    assert resp.status_code == 200
    assert any(t["name"] == "gate check" for t in resp.get_json()["topics"])


def test_vector_search_503s_when_research_vector_search_off(data_dir):
    (data_dir / "features.json").write_text(json.dumps({"research_vector_search": False}))
    from routes import research_search
    app = Flask(__name__)
    app.config.update(TESTING=True)
    research_search.register(app)
    client = app.test_client()
    resp = client.get("/api/research/search?q=x&mode=vector")
    assert resp.status_code == 503
    # keyword mode is untouched by the gate
    resp = client.get("/api/research/search?q=x&mode=keyword")
    assert resp.status_code == 200
