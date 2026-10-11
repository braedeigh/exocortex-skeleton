"""GET /api/wiki/pond — the wiki's own pond, one endpoint laying journal,
research, build and todo rows on a single time axis (routes/wiki.py; the
design of record is docs/tags-architecture.md's "Wiki-pond" section).

Seeded straight through sqlstore.open_db() (cards/commits/files/file_paths/
commit_files/todos/tags rows — the real, migrated schema, so a drift there
is caught here too) plus store.write("research", ...) for the research
family, which lives in the generic `docs` table rather than typed columns.
Same minimal-app pattern as the other route suites: a bare Flask app
registering only routes.wiki, against the isolated `data_dir` fixture.
"""
import sqlite3

import pytest
from flask import Flask

import sqlstore
import store
from routes import wiki


@pytest.fixture
def db(data_dir):
    """A connection to the real (migrated) exo.db, autocommitting
    (sqlstore.open_db() opens with isolation_level=None) — small insert
    helpers for each family the pond reads, respecting the same foreign
    keys codestore.py's real writers do (files before file_paths/commit_files)."""
    conn = sqlstore.open_db()

    def card(cid, day, ts="09:00", body="", deleted=None):
        conn.execute(
            "INSERT INTO cards (id, day, ts, who, kind, body, first_seen,"
            " last_seen, deleted_at) VALUES (?,?,?,?,?,?,?,?,?)",
            (cid, day, ts, "B", "note", body, day, day, deleted),
        )

    def file(fid, repo, path):
        conn.execute(
            "INSERT INTO files (id, repo, path) VALUES (?,?,?)", (fid, repo, path)
        )
        conn.execute(
            "INSERT INTO file_paths (repo, path, file_id) VALUES (?,?,?)",
            (repo, path, fid),
        )

    def commit(sha, day, ts="10:00:00", subject="", repo="skeleton"):
        conn.execute(
            "INSERT INTO commits (sha, repo, authored_ts, authored_at, author,"
            " subject) VALUES (?,?,?,?,?,?)",
            (sha, repo, 0, f"{day}T{ts}", "owner", subject),
        )

    def commit_file(sha, file_id, status="M"):
        conn.execute(
            "INSERT INTO commit_files (sha, file_id, status) VALUES (?,?,?)",
            (sha, file_id, status),
        )

    def todo(tid, text, created=None, finished_on=None, finished_time=None,
             notes=""):
        conn.execute(
            "INSERT INTO todos (id, text, bucket, position, done, created,"
            " finished_on, finished_time, notes) VALUES (?,?,?,?,?,?,?,?,?)",
            (tid, text, "now", 0, 1 if finished_on else 0, created,
             finished_on, finished_time, notes),
        )

    def tag(subject, ns, tag_):
        conn.execute(
            "INSERT INTO tags (subject, ns, tag, source) VALUES (?,?,?,?)",
            (subject, ns, tag_, "manual"),
        )

    yield type("DB", (), {
        "card": staticmethod(card),
        "file": staticmethod(file),
        "commit": staticmethod(commit),
        "commit_file": staticmethod(commit_file),
        "todo": staticmethod(todo),
        "tag": staticmethod(tag),
        "conn": conn,
    })
    conn.close()


@pytest.fixture
def client(data_dir):
    app = Flask(__name__)
    app.config.update(TESTING=True)
    wiki.register(app)
    return app.test_client()


def _research(entries):
    store.write("research", {"topics": [], "entries": entries})


def _entry(eid, text, created, topics=None):
    return {
        "id": eid, "kind": "note", "text": text, "topics": topics or [],
        "url": "", "verdict": "", "status": "", "reply_to": None,
        "created": created,
    }


def _pond(client, **params):
    resp = client.get("/api/wiki/pond", query_string=params)
    assert resp.status_code == 200
    return resp.get_json()


def _row(body, subject):
    return next(r for r in body["rows"] if r["id"] == subject)


# --- window filtering ---------------------------------------------------------

def test_window_includes_a_card_inside_and_excludes_one_outside(db, client):
    db.card("in1", "2026-08-10", body="inside the window")
    db.card("out1", "2026-01-01", body="way before the window")

    body = _pond(client, end="2026-08-15", days=10)
    ids = {r["id"] for r in body["rows"]}
    assert "card:in1" in ids
    assert "card:out1" not in ids
    assert body["start"] == "2026-08-06"
    assert body["end"] == "2026-08-15"


# --- all four families ---------------------------------------------------------

def test_all_four_families_appear_with_correct_subjects_and_days(db, client):
    db.card("c1", "2026-08-10", ts="09:15", body="a journal card")
    db.file(1, "skeleton", "routes/health.py")
    db.commit("deadbeef", "2026-08-11", ts="14:30:00", subject="fix the thing")
    db.commit_file("deadbeef", 1)
    db.todo("t1", "buy milk", created="2026-08-12 08:00:00")
    _research([_entry("2026-08-13.0900", "a research note", "2026-08-13 09:00")])

    body = _pond(client, end="2026-08-20", days=30)
    by_id = {r["id"]: r for r in body["rows"]}

    j = by_id["card:c1"]
    assert j["family"] == "journal" and j["day"] == "2026-08-10" and j["ts"] == "09:15"
    assert j["title"] == "" and j["body"] == "a journal card"

    b = by_id["commit:deadbeef"]
    assert b["family"] == "build" and b["day"] == "2026-08-11" and b["ts"] == "14:30:00"
    assert b["title"] == "fix the thing" and b["body"] == ""

    t = by_id["todo:t1"]
    assert t["family"] == "todo" and t["day"] == "2026-08-12"
    assert t["title"] == "buy milk"

    r = by_id["entry:2026-08-13.0900"]
    assert r["family"] == "research" and r["day"] == "2026-08-13" and r["ts"] == "09:00"
    assert r["body"] == "a research note"


# --- commit tag inheritance ----------------------------------------------------

def test_commit_inherits_the_union_of_its_files_tags(db, client):
    db.file(1, "skeleton", "routes/health.py")
    db.file(2, "skeleton", "routes/wiki.py")
    db.tag("file:skeleton/routes/health.py", "front", "health")
    db.tag("file:skeleton/routes/wiki.py", "front", "money")
    db.tag("file:skeleton/routes/wiki.py", "topic", "refactor")
    db.commit("sha1", "2026-08-10", subject="touch two files")
    db.commit_file("sha1", 1)
    db.commit_file("sha1", 2)

    body = _pond(client, end="2026-08-20", days=30)
    row = _row(body, "commit:sha1")
    got = {(t["ns"], t["tag"]) for t in row["tags"]}
    assert got == {("front", "health"), ("front", "money"), ("topic", "refactor")}


def test_a_commit_with_untagged_files_has_no_tags(db, client):
    db.file(1, "skeleton", "routes/plain.py")
    db.commit("sha2", "2026-08-10", subject="nothing tagged")
    db.commit_file("sha2", 1)

    body = _pond(client, end="2026-08-20", days=30)
    assert _row(body, "commit:sha2")["tags"] == []


# --- todo placement -------------------------------------------------------------

def test_todo_placed_on_finished_on_when_set(db, client):
    db.todo("done1", "finished thing", created="2026-08-01 08:00:00",
            finished_on="2026-08-15", finished_time="16:45")
    body = _pond(client, end="2026-08-20", days=30)
    row = _row(body, "todo:done1")
    assert row["day"] == "2026-08-15" and row["ts"] == "16:45"


def test_todo_placed_on_created_date_when_unfinished(db, client):
    db.todo("open1", "still open", created="2026-08-09 12:30:00")
    body = _pond(client, end="2026-08-20", days=30)
    row = _row(body, "todo:open1")
    assert row["day"] == "2026-08-09"


def test_todo_with_neither_finished_nor_created_is_skipped(db, client):
    db.todo("ghost", "no dates at all")
    body = _pond(client, end="2026-08-20", days=30)
    assert "todo:ghost" not in {r["id"] for r in body["rows"]}


# --- rail: counts + span --------------------------------------------------------

def test_rail_counts_distinct_subjects_and_spans_distinct_days(db, client):
    db.card("c1", "2026-08-10", body="one")
    db.card("c2", "2026-08-10", body="two")   # same day as c1
    db.card("c3", "2026-08-12", body="three")
    for cid in ("c1", "c2", "c3"):
        db.tag(f"card:{cid}", "front", "health")

    body = _pond(client, end="2026-08-20", days=30)
    front = next(n for n in body["rail"] if n["ns"] == "front")
    health = next(t for t in front["tags"] if t["tag"] == "health")
    assert health["count"] == 3   # three distinct subjects
    assert health["span"] == 2    # two distinct days (10th and 12th)


def test_rail_orders_namespaces_front_thread_person_topic_then_alpha(db, client):
    db.card("c1", "2026-08-10", body="x")
    for ns in ("topic", "zzz", "person", "front", "aaa", "thread"):
        db.tag("card:c1", ns, "t")

    body = _pond(client, end="2026-08-20", days=30)
    order = [n["ns"] for n in body["rail"]]
    assert order == ["front", "thread", "person", "topic", "aaa", "zzz"]


def test_rail_only_reflects_rows_actually_in_the_window(db, client):
    """A tag on a subject the window excludes must not show up in the rail."""
    db.card("in", "2026-08-10", body="in window")
    db.card("out", "2026-01-01", body="way outside")
    db.tag("card:in", "front", "health")
    db.tag("card:out", "front", "money")

    body = _pond(client, end="2026-08-20", days=30)
    front = next(n for n in body["rail"] if n["ns"] == "front")
    tags = {t["tag"] for t in front["tags"]}
    assert tags == {"health"}


# --- days clamping ---------------------------------------------------------------

def test_days_clamps_to_the_floor(db, client):
    body = _pond(client, end="2026-08-20", days=0)
    assert body["start"] == body["end"] == "2026-08-20"


def test_days_clamps_to_the_ceiling(db, client):
    body = _pond(client, end="2026-08-20", days=999999)
    assert body["start"] == "2025-08-20"   # 366 days back from 2026-08-20


def test_days_default_is_45(db, client):
    body = client.get("/api/wiki/pond?end=2026-08-20").get_json()
    assert body["start"] == "2026-07-07"   # 45 days back from 2026-08-20


def test_a_non_numeric_days_falls_back_to_default(db, client):
    body = client.get("/api/wiki/pond?end=2026-08-20&days=banana").get_json()
    assert body["start"] == "2026-07-07"


def test_a_malformed_end_is_rejected(db, client):
    resp = client.get("/api/wiki/pond?end=not-a-date")
    assert resp.status_code == 400
    assert "error" in resp.get_json()


# --- never writes ------------------------------------------------------------

def test_the_endpoint_never_writes(db, client):
    db.card("c1", "2026-08-10", body="x")
    db.file(1, "skeleton", "routes/health.py")
    db.commit("sha1", "2026-08-10", subject="s")
    db.commit_file("sha1", 1)
    db.todo("t1", "todo text", created="2026-08-10 08:00:00")
    db.tag("card:c1", "front", "health")
    _research([_entry("2026-08-10.0900", "note", "2026-08-10 09:00")])

    def counts():
        conn = sqlite3.connect(store.DATA_DIR / "exo.db")
        try:
            tables = ("cards", "commits", "commit_files", "files", "file_paths",
                      "todos", "tags")
            return {t: conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
                    for t in tables}
        finally:
            conn.close()

    before = counts()
    resp = client.get("/api/wiki/pond?end=2026-08-20&days=30")
    assert resp.status_code == 200
    assert counts() == before
