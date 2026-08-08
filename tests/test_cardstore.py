"""cardstore — the card-pool mirror and its integrity alarm.

The behaviors that must not silently break: pool files become queryable rows
(tags included), edits flow through on resync, a deletion WITH a cast is
recorded as deliberate, a disappearance WITHOUT one is flagged missing (the
alarm), and a card that reappears is alive again. Pool files are built by
hand in the exact rigid shape stream.py writes.
"""
import json

import pytest

import cardstore
import sqlstore
import store


def _write_card(pool, cid, body="hello", who="B", tags=(), ts=None):
    ts = ts or f"{cid.split('.')[0]} 08:00:00"
    tag_line = f"tags: [{', '.join(tags)}]" if tags else "tags: []"
    (pool / f"{cid}.md").write_text(
        "---\n"
        f"id: {cid}\n"
        f"who: {who}\n"
        f"ts: {ts}\n"
        "reply_to: null\n"
        f"{tag_line}\n"
        "kind: line\n"
        "refs: []\n"
        "session: null\n"
        "---\n"
        f"{body}\n",
        encoding="utf-8",
    )


@pytest.fixture
def pool(data_dir, monkeypatch):
    """An isolated vault pool + an isolated exo.db (via data_dir)."""
    monkeypatch.setattr(store, "CONTENT_DIR", data_dir / "content")
    p = cardstore.pool_dir()
    p.mkdir(parents=True)
    return p


def _rows(sql, *args):
    conn = sqlstore.open_db()
    try:
        return conn.execute(sql, args).fetchall()
    finally:
        conn.close()


def test_sync_mirrors_cards_with_tags_and_day(pool):
    _write_card(pool, "2026-08-02.0808b", body="morning", tags=("ezra", "plans"))
    _write_card(pool, "2026-08-03.1200k", body="a question", who="K")

    result = cardstore.sync()

    assert result["cards"] == 2 and result["new"] == 2 and result["missing"] == []
    rows = _rows("SELECT id, day, who, body FROM cards ORDER BY id")
    assert rows[0] == ("2026-08-02.0808b", "2026-08-02", "B", "morning")
    assert rows[1] == ("2026-08-03.1200k", "2026-08-03", "K", "a question")
    tagged = _rows("SELECT card_id FROM card_tags WHERE tag = ?", "ezra")
    assert tagged == [("2026-08-02.0808b",)]


def test_edit_flows_through_on_resync(pool):
    _write_card(pool, "2026-08-02.0808b", body="before")
    cardstore.sync()
    _write_card(pool, "2026-08-02.0808b", body="after", tags=("late-tag",))

    cardstore.sync()

    rows = _rows("SELECT body FROM cards WHERE id = ?", "2026-08-02.0808b")
    assert rows == [("after",)]
    assert _rows("SELECT tag FROM card_tags") == [("late-tag",)]


def test_deletion_with_cast_is_deliberate_not_missing(pool):
    _write_card(pool, "2026-08-02.0808b", body="kept words")
    cardstore.sync()
    (pool / "2026-08-02.0808b.md").unlink()
    cardstore.deleted_log_path().write_text(json.dumps({
        "deleted_at": "2026-08-02 21:00:00", "by": "K",
        "id": "2026-08-02.0808b", "who": "B", "ts": "2026-08-02 08:08:00",
        "kind": "line", "reply_to": None, "tags": [], "refs": [],
        "session": None, "body": "kept words",
    }) + "\n", encoding="utf-8")

    result = cardstore.sync()

    assert result["missing"] == [] and result["deleted"] == 1
    rows = _rows("SELECT deleted_at, missing_since, body FROM cards WHERE id = ?",
                 "2026-08-02.0808b")
    assert rows == [("2026-08-02 21:00:00", None, "kept words")]


def test_vanished_without_cast_raises_the_alarm(pool):
    _write_card(pool, "2026-08-02.2007b", body="the lost turn")
    cardstore.sync()
    (pool / "2026-08-02.2007b.md").unlink()

    result = cardstore.sync()

    assert result["missing"] == ["2026-08-02.2007b"]
    rows = _rows("SELECT missing_since, body FROM cards WHERE id = ?",
                 "2026-08-02.2007b")
    assert rows[0][0] is not None          # flagged, and the row keeps the body
    assert rows[0][1] == "the lost turn"


def test_reappeared_card_is_alive_again(pool):
    _write_card(pool, "2026-08-02.2007b", body="back")
    cardstore.sync()
    (pool / "2026-08-02.2007b.md").unlink()
    cardstore.sync()
    _write_card(pool, "2026-08-02.2007b", body="back")

    result = cardstore.sync()

    assert result["missing"] == []
    rows = _rows("SELECT deleted_at, missing_since FROM cards WHERE id = ?",
                 "2026-08-02.2007b")
    assert rows == [(None, None)]


def test_rebuild_keeps_deleted_cards_via_the_cast(pool):
    _write_card(pool, "2026-08-02.0808b", body="alive")
    cardstore.deleted_log_path().write_text(json.dumps({
        "deleted_at": "2026-08-01 12:00:00", "by": "K",
        "id": "2026-08-01.0900b", "body": "was deleted", "tags": [],
    }) + "\n", encoding="utf-8")

    result = cardstore.rebuild()

    assert result["cards"] == 1
    rows = _rows("SELECT id, deleted_at, body FROM cards WHERE id = ?",
                 "2026-08-01.0900b")
    assert rows == [("2026-08-01.0900b", "2026-08-01 12:00:00", "was deleted")]


def test_non_card_files_are_skipped(pool):
    _write_card(pool, "2026-08-02.0808b")
    (pool / "README.md").write_text("not a card", encoding="utf-8")
    (pool / "2026-08-02.0808b.md.bak").write_text("also not", encoding="utf-8")

    result = cardstore.sync()

    assert result["cards"] == 1
