"""Behavioral tests for the tags API (routes/tags.py) and the schema v12
migration rung in sqlstore.py that backs it (see docs/tags-architecture.md).

Pin down: add/for round-trip, add is idempotent (INSERT OR IGNORE), remove
deletes regardless of source, the subject/ns/tag validation 400s, /api/tags
aggregates counts across subjects and orders namespaces front-first, and
/api/tags/tag/<ns>/<tag> splits the subject's family out of its address.
"""
import json
import sqlite3

import pytest

from conftest import data_dir  # noqa: F401  (imported for fixture visibility)


def _post(client, path, payload):
    return client.post(path, data=json.dumps(payload), content_type="application/json")


@pytest.fixture
def client(data_dir):
    """A minimal app exposing only routes.tags, same pattern as the other
    route test suites (see tests/conftest.py's own `client` fixture)."""
    from flask import Flask
    from routes import tags
    app = Flask(__name__)
    app.config.update(TESTING=True)
    tags.register(app)
    return app.test_client()


# --- migration ---------------------------------------------------------------

def test_migration_creates_tags_table(data_dir):
    import sqlstore
    sqlstore.open_db().close()
    conn = sqlite3.connect(data_dir / "exo.db")
    try:
        names = {r[0] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table'")}
        assert "tags" in names
        indexes = {r[0] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type = 'index'")}
        assert {"tags_by_tag", "tags_by_subject"} <= indexes
    finally:
        conn.close()


# --- add / for -----------------------------------------------------------------

def test_add_then_for_returns_it(client):
    r = _post(client, "/api/tags/add", {"subject": "card:2026-08-14.0930", "ns": "front", "tag": "health"})
    assert r.status_code == 200
    body = r.get_json()
    assert body["subject"] == "card:2026-08-14.0930"
    assert body["tags"] == [{"ns": "front", "tag": "health", "source": "manual"}]

    r = client.get("/api/tags/for?subject=card:2026-08-14.0930")
    assert r.status_code == 200
    assert r.get_json() == {
        "subject": "card:2026-08-14.0930",
        "tags": [{"ns": "front", "tag": "health", "source": "manual"}],
    }


def test_add_is_idempotent(client):
    payload = {"subject": "todo:abc123", "ns": "front", "tag": "money"}
    r1 = _post(client, "/api/tags/add", payload)
    r2 = _post(client, "/api/tags/add", payload)
    assert r1.status_code == 200 and r2.status_code == 200
    assert r2.get_json()["tags"] == [{"ns": "front", "tag": "money", "source": "manual"}]


def test_add_lowercases_ns_and_tag(client):
    r = _post(client, "/api/tags/add", {"subject": "todo:abc", "ns": "Front", "tag": "Money"})
    assert r.get_json()["tags"] == [{"ns": "front", "tag": "money", "source": "manual"}]


# --- remove --------------------------------------------------------------------

def test_remove_deletes(client):
    _post(client, "/api/tags/add", {"subject": "todo:x1", "ns": "front", "tag": "health"})
    _post(client, "/api/tags/add", {"subject": "todo:x1", "ns": "topic", "tag": "sleep"})
    r = _post(client, "/api/tags/remove", {"subject": "todo:x1", "ns": "front", "tag": "health"})
    assert r.status_code == 200
    assert r.get_json()["tags"] == [{"ns": "topic", "tag": "sleep", "source": "manual"}]


def test_remove_missing_row_is_a_noop_200(client):
    r = _post(client, "/api/tags/remove", {"subject": "todo:ghost", "ns": "front", "tag": "health"})
    assert r.status_code == 200
    assert r.get_json()["tags"] == []


# --- validation ------------------------------------------------------------------

def test_add_rejects_malformed_subject(client):
    r = _post(client, "/api/tags/add", {"subject": "no-colon-here", "ns": "front", "tag": "health"})
    assert r.status_code == 400
    assert "error" in r.get_json()


def test_add_rejects_bad_ns_characters(client):
    r = _post(client, "/api/tags/add", {"subject": "todo:x1", "ns": "front!", "tag": "health"})
    assert r.status_code == 400


def test_add_rejects_empty_tag(client):
    r = _post(client, "/api/tags/add", {"subject": "todo:x1", "ns": "front", "tag": ""})
    assert r.status_code == 400


def test_for_rejects_missing_subject(client):
    r = client.get("/api/tags/for")
    assert r.status_code == 400


def test_for_rejects_malformed_subject(client):
    r = client.get("/api/tags/for?subject=nocolon")
    assert r.status_code == 400


# --- /api/tags aggregation --------------------------------------------------------

def test_list_tags_aggregates_counts_across_subjects(client):
    _post(client, "/api/tags/add", {"subject": "todo:a", "ns": "front", "tag": "health"})
    _post(client, "/api/tags/add", {"subject": "todo:b", "ns": "front", "tag": "health"})
    _post(client, "/api/tags/add", {"subject": "todo:c", "ns": "front", "tag": "money"})
    _post(client, "/api/tags/add", {"subject": "todo:a", "ns": "topic", "tag": "gut"})

    r = client.get("/api/tags")
    assert r.status_code == 200
    namespaces = r.get_json()["namespaces"]
    by_ns = {n["ns"]: n["tags"] for n in namespaces}
    # count desc, then name — 'health' (2) before 'money' (1).
    assert by_ns["front"] == [{"tag": "health", "count": 2}, {"tag": "money", "count": 1}]
    assert by_ns["topic"] == [{"tag": "gut", "count": 1}]


def test_list_tags_orders_namespaces_front_thread_person_topic_then_alpha(client):
    for ns in ("topic", "zzz", "person", "front", "aaa", "thread"):
        _post(client, "/api/tags/add", {"subject": "todo:x", "ns": ns, "tag": "t"})

    r = client.get("/api/tags")
    order = [n["ns"] for n in r.get_json()["namespaces"]]
    assert order == ["front", "thread", "person", "topic", "aaa", "zzz"]


# --- /api/tags/tag/<ns>/<tag> ------------------------------------------------------

def test_tag_page_returns_subjects_with_family_split(client):
    _post(client, "/api/tags/add", {"subject": "card:2026-08-14.0930", "ns": "front", "tag": "health"})
    _post(client, "/api/tags/add", {"subject": "todo:abc123", "ns": "front", "tag": "health"})

    r = client.get("/api/tags/tag/front/health")
    assert r.status_code == 200
    body = r.get_json()
    assert body["ns"] == "front" and body["tag"] == "health"
    subjects = {(s["subject"], s["family"]) for s in body["subjects"]}
    assert subjects == {
        ("card:2026-08-14.0930", "card"),
        ("todo:abc123", "todo"),
    }
