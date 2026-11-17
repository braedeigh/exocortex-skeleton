"""
journal_export.py — the journal's rows written out as text for git, and loaded back.

**What this is.** The journal lives in exo.db (see docs/journal-database.md),
and exo.db is too big to commit. So every hour, just before the vault's
backup commit, the journal is written out as text the commit does carry —
and `load` puts it all back into a database. Rule 5 of the design: every
word stays in git.

What it writes, under `<out>/journal/`:

  days/<YYYY-MM-DD>.jsonl   the cards said that day, one JSON line each (every
                            column, the fingerprint included), oldest first.
                            Cards lock 24 hours after they're saved, so a day
                            file only changes while its cards are still
                            editable: append-only in practice. A file that
                            changes after that is reported — it means a row
                            changed that the rules say can't.
  filing.sql                labels, card_labels, card_links and card_edits,
                            whole, as INSERT lines: the filing record (who put
                            which label on, who took one off and why).
  schema.sql                the CREATE statements for the journal's tables,
                            indexes, triggers and the card_tags view.

A file is only rewritten when its text changed, so an idle hour touches
nothing and git sees nothing.

`load` reads them back: schema first (skipping anything that already
exists), then every day file (a card whose id is taken is left alone), then
the filing record (a row whose key is taken is left alone). So it only ever
adds, and running it twice is safe. It reports how many cards' fingerprints
don't match their words.

Standard library only. Run by the vault's `scripts/exo_db_dumps.py`, which
imports this file from the skeleton; tested in tests/test_journal_export.py.
"""
import json
import os
import sqlite3
import sys
from datetime import date, timedelta
from pathlib import Path
from typing import Dict

sys.path.insert(0, str(Path(__file__).resolve().parent))
import journaldb  # noqa: E402

FILING_TABLES = ("labels", "card_labels", "card_links", "card_edits")


def _write_if_changed(path: Path, text: str) -> bool:
    """Write a file only if its text differs — beside it, then moved into
    place, so a dump that dies half way never leaves a short file."""
    try:
        if path.read_text(encoding="utf-8") == text:
            return False
    except OSError:
        pass
    path.parent.mkdir(parents=True, exist_ok=True)
    part = path.with_name(path.name + ".part")
    part.write_text(text, encoding="utf-8")
    os.replace(part, path)
    return True


def _insert_lines(conn, name: str):
    """One INSERT per row in primary-key order. SQLite's quote() writes each
    value, so text, numbers and NULLs come back exactly as they were."""
    info = conn.execute(f'PRAGMA table_info("{name}")').fetchall()
    columns = [row[1] for row in info]
    key = [row[1] for row in sorted(info, key=lambda row: row[5]) if row[5]]
    order = ", ".join(f'"{c}"' for c in key) or "rowid"
    values = " || ',' || ".join(f'quote("{c}")' for c in columns)
    column_list = ", ".join(f'"{c}"' for c in columns)
    for (row,) in conn.execute(f'SELECT {values} FROM "{name}" ORDER BY {order}'):
        yield f'INSERT INTO "{name}" ({column_list}) VALUES({row});\n'


def export(conn: sqlite3.Connection, out_dir) -> Dict[str, object]:
    """Write the journal out under `<out_dir>/journal/`. Returns what changed:
    {"days": [days rewritten], "locked_changed": [old days that changed],
     "filing": bool, "schema": bool}."""
    folder = Path(out_dir) / "journal"
    result = {"days": [], "locked_changed": [], "filing": False, "schema": False}

    # The schema: every journal object except the word index's triggers,
    # which belong to the app's ladder.
    names = ("cards", "card_tags") + journaldb.TABLES[1:]
    schema = [sql for (sql,) in conn.execute(
        "SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND tbl_name IN"
        f" ({','.join('?' * len(names))}) AND name NOT LIKE 'cards_fts%'"
        " ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1"
        " WHEN 'view' THEN 2 ELSE 3 END, name", names)]
    result["schema"] = _write_if_changed(folder / "schema.sql", "".join(s + ";\n" for s in schema))

    # The cards, a file per day. Days whose cards are all past their 24
    # hours should never change; if one does, say so.
    by_day: Dict[str, list] = {}
    columns = journaldb.CARD_COLUMNS
    for row in conn.execute(f"SELECT {', '.join(columns)} FROM cards ORDER BY said_at, id"):
        record = dict(zip(columns, row))
        by_day.setdefault(record["day"], []).append(
            json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n")
    settled_before = (date.today() - timedelta(days=2)).isoformat()
    for day, lines in by_day.items():
        path = folder / "days" / f"{day}.jsonl"
        existed = path.exists()
        if _write_if_changed(path, "".join(lines)):
            result["days"].append(day)
            if existed and day < settled_before:
                result["locked_changed"].append(day)

    # The filing record, whole.
    text = "".join(line for name in FILING_TABLES for line in _insert_lines(conn, name))
    result["filing"] = _write_if_changed(folder / "filing.sql", text)
    return result


def _run_statements(conn, text: str, counts: Dict[str, int]) -> None:
    """Run statements one at a time, leaving alone whatever is already there."""
    statement = ""
    for line in text.split("\n"):
        line += "\n"
        statement += line
        if not sqlite3.complete_statement(statement):
            continue
        try:
            conn.execute(statement)
            if statement.startswith("INSERT"):
                counts["rows added"] += 1
        except sqlite3.IntegrityError:
            counts["already there"] += 1
        except sqlite3.OperationalError as error:
            if "already exists" not in str(error):
                raise
        statement = ""


def load(conn: sqlite3.Connection, out_dir) -> Dict[str, int]:
    """Put an export back into a database. Only adds; safe to run twice."""
    folder = Path(out_dir) / "journal"
    counts = {"cards added": 0, "rows added": 0, "already there": 0, "fingerprint mismatches": 0}
    conn.isolation_level = None   # the transaction below is explicit
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("BEGIN IMMEDIATE")
    try:
        schema = folder / "schema.sql"
        if schema.exists():
            _run_statements(conn, schema.read_text(encoding="utf-8"), counts)
        columns = journaldb.CARD_COLUMNS
        for path in sorted((folder / "days").glob("*.jsonl")) if (folder / "days").exists() else []:
            # Split on "\n" only: splitlines() would also break at the Unicode
            # line separators a card's words can hold, which JSON leaves raw.
            for line in path.read_text(encoding="utf-8").split("\n"):
                if not line.strip():
                    continue
                record = json.loads(line)
                if record["fingerprint"] != journaldb.fingerprint(
                        record["who"], record["said_at"], record["body"]):
                    counts["fingerprint mismatches"] += 1
                cursor = conn.execute(
                    f"INSERT OR IGNORE INTO cards ({', '.join(columns)})"
                    f" VALUES ({', '.join('?' * len(columns))})",
                    [record.get(c) for c in columns])
                if cursor.rowcount > 0:
                    counts["cards added"] += 1
                else:
                    counts["already there"] += 1
        filing = folder / "filing.sql"
        if filing.exists():
            _run_statements(conn, filing.read_text(encoding="utf-8"), counts)
        conn.execute("COMMIT")
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    return counts
