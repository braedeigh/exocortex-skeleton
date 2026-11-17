"""The journal's hourly text export (tools/stream/journal_export.py) — rule 5 of
docs/journal-database.md: every word stays in git.

What must hold: a journal exported and loaded into an empty database comes
back identical, table by table; loading twice adds nothing; an idle hour
rewrites no file; and a day file that changes after its cards locked is
reported.
"""
import sqlite3

import sqlstore
import store
from tools.stream import journal_export, stream

journaldb = stream.journaldb


def _populate(conn):
    """A small journal with every kind of row: a K question and her answer, a
    deleted card, an edit, a note on an old card, labels added and removed —
    and words holding the Unicode line separators JSON leaves raw."""
    context = journaldb.LabelContext(None, None)
    journaldb.insert_card(conn, id="2026-07-01.0900k", who="K", said_at="2026-07-01 09:00:00",
                          body="how did it go?", saved_at="2026-07-01 09:00:00")
    journaldb.insert_card(conn, id="2026-07-01.0901b", who="B", said_at="2026-07-01 09:01:00",
                          body="well mostly\u0085truly", door="voice", device="kitchen",
                          saved_at="2026-07-01 09:01:00")
    journaldb.insert_card(conn, id="2026-07-01.0902b", who="B", said_at="2026-07-01 09:02:00",
                          body="never mind", saved_at="2026-07-01 09:02:00",
                          deleted_at="2026-07-01 09:05:00", deleted_by="cards-route")
    journaldb.insert_card(conn, id="2026-07-09.1200b", who="B", said_at="2026-07-09 12:00:00",
                          body="looking back", saved_at="2026-07-09 12:00:00")
    journaldb.link(conn, "2026-07-01.0901b", "2026-07-01.0900k", "answers")
    journaldb.link(conn, "2026-07-09.1200b", "2026-07-01.0901b", "note")
    journaldb.record_edit(conn, "2026-07-01.0901b", "2026-07-01 09:03:00", "owner", "wel", "well")
    journaldb.add_label(conn, "2026-07-01.0901b", "ezra", "thread-tending", context,
                        run="2026-07-02", reason="names him", weight="about")
    journaldb.add_label(conn, "2026-07-01.0901b", "walks", "owner", context)
    journaldb.remove_label(conn, "2026-07-01.0901b", "ezra", "owner", why="another Ezra")


def _tables(conn):
    return {t: conn.execute(f"SELECT * FROM {t} ORDER BY 1").fetchall() for t in journaldb.TABLES}


def test_export_then_load_rebuilds_the_journal_exactly(data_dir, tmp_path, monkeypatch):
    source = sqlstore.open_db()
    _populate(source)
    out = tmp_path / "backup"
    journal_export.export(source, out)

    # An empty database the way the app makes one, then the export loaded in.
    monkeypatch.setattr(store, "DATA_DIR", tmp_path / "restored")
    (tmp_path / "restored").mkdir()
    sqlstore.open_db().close()
    target = sqlite3.connect(tmp_path / "restored" / "exo.db")
    counts = journal_export.load(target, out)

    assert counts["cards added"] == 4 and counts["fingerprint mismatches"] == 0
    assert _tables(target) == _tables(source)
    assert target.execute("SELECT COUNT(*) FROM cards_fts").fetchone() == (4,)
    # The rules came back with the rows: an old card still can't be changed.
    try:
        target.execute("UPDATE cards SET body = 'x' WHERE id = '2026-07-01.0900k'")
        raise AssertionError("the lock trigger did not come back")
    except sqlite3.DatabaseError as error:
        assert "locked" in str(error)
    assert journal_export.load(target, out)["cards added"] == 0
    assert _tables(target) == _tables(source)


def test_an_idle_hour_writes_nothing_and_a_settled_day_changing_is_reported(data_dir, tmp_path):
    conn = sqlstore.open_db()
    _populate(conn)
    out = tmp_path / "backup"
    first = journal_export.export(conn, out)
    assert first["days"] == ["2026-07-01", "2026-07-09"] and first["filing"] and first["schema"]
    assert journal_export.export(conn, out) == {"days": [], "locked_changed": [],
                                                "filing": False, "schema": False}

    # A rewrite that went around the triggers (they're dropped here to do it).
    conn.execute("DROP TRIGGER cards_locked_update")
    conn.execute("UPDATE cards SET body = 'tampered' WHERE id = '2026-07-09.1200b'")
    assert journal_export.export(conn, out)["locked_changed"] == ["2026-07-09"]
