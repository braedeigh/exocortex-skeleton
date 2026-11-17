"""scripts/backfill_tags.py — the hourly mirror into the universal `tags` table.

What must hold since the journal moved into the database: journal cards are no
longer mirrored (their labels live in `card_labels`), the `card:` rows the
script once derived are removed, and nothing else in the table — rows another
writer made, rows for other subjects — is touched.
"""
import importlib.util
from pathlib import Path

import sqlstore
from tests.journal_seed import seed_card

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "backfill_tags.py"


def _load():
    spec = importlib.util.spec_from_file_location("backfill_tags", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _rows(conn):
    return sorted(tuple(r) for r in conn.execute("SELECT subject, ns, tag, source FROM tags"))


def test_card_rows_it_once_derived_are_removed_and_nothing_else(data_dir, tmp_path, monkeypatch):
    import store
    monkeypatch.setattr(store, "CONTENT_DIR", tmp_path / "content")
    conn = sqlstore.open_db()
    seed_card(conn, "2026-08-12.2142b", "a labelled card", tags=["health"])
    conn.executemany("INSERT INTO tags (subject, ns, tag, source) VALUES (?, ?, ?, ?)", [
        ("card:2026-08-12.2142b", "topic", "health", "derived"),   # the retired copy
        ("card:2026-08-12.2142b", "front", "work", "manual"),      # someone else's
        ("thread:the-move", "front", "home", "derived"),           # another subject
    ])
    conn.commit()
    conn.close()

    _load().run(dry_run=False)

    conn = sqlstore.open_db()
    try:
        rows = _rows(conn)
    finally:
        conn.close()
    assert ("card:2026-08-12.2142b", "topic", "health", "derived") not in rows
    assert ("card:2026-08-12.2142b", "front", "work", "manual") in rows
    assert ("thread:the-move", "front", "home", "derived") in rows
