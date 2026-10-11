"""uieventstore.py — taps and page opens as events, day files + a mirror table.

Mirrors test_attentionstore's shape: `clean` is pure and asserted on raw
client payloads; the record/rebuild path runs against the isolated data dir.
"""
from datetime import datetime, timedelta

import sqlstore
import uieventstore


def ms(dt):
    return int(dt.timestamp() * 1000)


def test_clean_keeps_good_drops_bad():
    now = datetime(2026, 9, 24, 12, 0, 0)
    events = [
        {"kind": "click", "tab": "todos", "conv": None, "control": "card-edit", "at": ms(now)},
        {"kind": "open", "tab": "journal", "conv": "2026-09-24.115556", "control": "ignored",
         "at": ms(now)},
        {"kind": "click", "tab": "todos", "control": "BAD NAME", "at": ms(now)},
        {"kind": "hover", "tab": "todos", "control": "x", "at": ms(now)},
        {"kind": "click", "tab": "todos", "control": "x", "at": ms(now - timedelta(days=8))},
        {"kind": "click", "tab": "todos", "control": "x", "at": True},
        "junk",
    ]
    records, rejected = uieventstore.clean(events, now=now)
    assert rejected == 5
    assert [r["kind"] for r in records] == ["click", "open"]
    assert records[1]["control"] is None
    assert records[0]["at"] == now.isoformat(timespec="milliseconds")


def test_record_writes_day_file_and_mirror(data_dir):
    now = datetime.now()
    out = uieventstore.record([
        {"kind": "click", "tab": "todos", "control": "card-edit", "at": ms(now)},
        {"kind": "open", "tab": "todos", "at": ms(now)},
    ])
    assert out == {"stored": 2, "rejected": 0}
    day = now.strftime("%Y-%m-%d")
    assert (data_dir / "ui_events" / f"{day}.jsonl").read_text().count("\n") == 2
    conn = sqlstore.open_db()
    try:
        assert conn.execute("SELECT COUNT(*) FROM ui_events").fetchone()[0] == 2
    finally:
        conn.close()


def test_rebuild_walks_the_files_back(data_dir):
    now = datetime.now()
    uieventstore.record([{"kind": "open", "tab": "todos", "at": ms(now)}])
    conn = sqlstore.open_db()
    try:
        conn.execute("DELETE FROM ui_events")
        conn.commit()
    finally:
        conn.close()
    assert uieventstore.rebuild() == {"events": 1, "days": 1}
