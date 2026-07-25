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
    assert features.enabled("reading_room") is True
    assert features.enabled("mcp_server") is True


def test_features_json_in_data_dir_overrides_defaults(data_dir):
    (data_dir / "features.json").write_text(json.dumps({"web_terminal": False}))
    assert features.enabled("web_terminal") is False
    assert features.enabled("reading_room") is True  # untouched flags keep defaults


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
