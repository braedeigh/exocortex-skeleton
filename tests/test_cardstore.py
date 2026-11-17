"""cardstore — the compatibility layer over the journal's rows, and the import
of card files into them.

Since the journal moved into exo.db (docs/journal-database.md), the rows are
the truth and cardstore only reads them, or brings in a card that exists only
as a file. What must not silently break: a file's card arrives whole (words,
speaker, tags as labels, reply as a link), the import never changes a row that
already exists, read() returns the old dict shape, and a deleted card stays
hidden. Card files are built by hand in the exact shape stream.py writes.
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




def test_a_file_only_card_arrives_whole(pool):
    _write_card(pool, "2026-08-01.0900k", "how was the walk?", who="K")
    (pool / "2026-08-01.0901b.md").write_text(
        "---\nid: 2026-08-01.0901b\nwho: B\nts: 2026-08-01 09:01:00\n"
        "reply_to: 2026-08-01.0900k\ntags: [ezra, walks]\nkind: line\nrefs: []\n"
        "session: conv-7\n---\nlong, and good\n", encoding="utf-8")
    result = cardstore.sync()
    assert (result["new"], result["cards"], result["missing"]) == (2, 2, [])

    card = cardstore.read("2026-08-01.0901b")
    assert card == {"id": "2026-08-01.0901b", "day": "2026-08-01", "ts": "2026-08-01 09:01:00",
                    "who": "B", "kind": "line", "reply_to": "2026-08-01.0900k",
                    "session": "conv-7", "refs": "[]", "tags": ["ezra", "walks"],
                    "body": "long, and good"}
    assert _rows("SELECT added_by FROM card_labels") == [("migration",), ("migration",)]
    # Saved when it was said, so an old card arrives already locked.
    assert _rows("SELECT saved_at FROM cards WHERE id = '2026-08-01.0901b'") == [("2026-08-01 09:01:00",)]


def test_the_import_never_changes_a_row_that_exists(pool):
    _write_card(pool, "2026-08-01.0900b", "the words as said", tags=["walks"])
    cardstore.sync()
    _write_card(pool, "2026-08-01.0900b", "a file edited behind the engine's back", tags=["other"])
    assert cardstore.sync()["new"] == 0
    assert cardstore.read("2026-08-01.0900b")["body"] == "the words as said"
    assert cardstore.read("2026-08-01.0900b")["tags"] == ["walks"]


def test_read_brings_in_a_card_written_a_moment_ago(pool):
    _write_card(pool, "2026-08-02.1000s", "Coming up: dentist at 3", who="S")
    assert cardstore.read("2026-08-02.1000s")["who"] == "S"
    assert cardstore.read("2026-08-02.9999b") is None


def test_non_card_files_are_skipped(pool):
    _write_card(pool, "2026-08-01.0900b")
    (pool / "notes.md").write_text("not a card")
    (pool / "2026-08-01.0901b.md").write_text("no frontmatter at all")
    assert cardstore.sync()["new"] == 1
    assert cardstore.integrity() == []


def test_a_deleted_card_stays_hidden_and_is_never_brought_back(pool, monkeypatch):
    from tools.stream import stream
    monkeypatch.setenv("TULKU_STREAM_ROOT", str(store.CONTENT_DIR))
    cid = stream.record(who="B", body="said, then taken back")
    stream.delete_card(cid, by="test")
    _write_card(pool, cid, "said, then taken back")   # a stale file left behind
    cardstore.sync()
    assert cardstore.read(cid) is None
    assert _rows("SELECT deleted_by FROM cards WHERE id = ?", cid) == [("test",)]
