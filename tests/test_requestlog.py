"""requestlog.py — one row per /api/ request, batched and fail-open."""
from flask import Flask, jsonify

import requestlog
import sqlstore


def count(sql="SELECT COUNT(*) FROM requests"):
    conn = sqlstore.open_db()
    try:
        return conn.execute(sql).fetchone()[0]
    finally:
        conn.close()


def test_feature_is_first_segment():
    assert requestlog.feature_of("/api/habits/log") == "habits"
    assert requestlog.feature_of("/api/") is None
    assert requestlog.feature_of("/login") is None


def test_hooked_app_records_api_requests_only(data_dir, monkeypatch):
    monkeypatch.delenv("EXOCORTEX_REQUEST_LOG_OFF", raising=False)
    # The buffer is process-wide: any earlier test that built the real app
    # left its requests queued here. Drain them so only this test's count.
    requestlog._pending.clear()
    app = Flask(__name__)
    requestlog.install(app)

    @app.route("/api/ping")
    def ping():
        return jsonify(ok=True)

    @app.route("/plain")
    def plain():
        return "x"

    client = app.test_client()
    client.get("/api/ping")
    client.get("/plain")
    client.get("/api/missing")
    assert requestlog.flush() == 2
    assert count() == 2
    assert count("SELECT COUNT(*) FROM requests WHERE feature='ping' AND status=200"
                 " AND duration_ms IS NOT NULL") == 1
    assert count("SELECT COUNT(*) FROM requests WHERE status=404") == 1


def test_kill_switch(data_dir, monkeypatch):
    monkeypatch.setenv("EXOCORTEX_REQUEST_LOG_OFF", "1")
    # Drain what earlier tests queued in the process-wide buffer, so the
    # count is only what this test recorded.
    requestlog._pending.clear()
    requestlog.record("GET", "/api/x", 200)
    assert requestlog.flush() == 0
