"""The journal's prose pages as rows — weekly summaries and diary entries in exo.db.

**What this is, in plain English.** A weekly summary or a Keeper diary entry
is a markdown file in the vault. Whatever writes those files keeps writing
them, and the files stay the truth. This module copies a folder of them into
the `journal_pages` table (schema in sqlstore.py, rung 47), one row per file,
so they can be loaded with a query. It is the same one-way mirror
cardstore.py keeps for the journal cards.

  - `sync_folder(root, folder, glob)` — copy every matching file into the
    table, and mark the rows whose file is no longer there.
  - `newest(folder, glob, last)` — the newest `last` pages of a folder, in
    reading order (oldest first).

The Keeper's boot package (`scripts/boot_context.py`) calls both: it refreshes
the folder, then loads from the table, so a page written a minute before the
wake is in the package.

Touches: `sqlstore.py` (owns the schema and the connection),
`scripts/boot_context.py` (the caller), `tests/test_boot_context.py`.

Prompt: "move them into the database so they can just be injected, but keep
the apparatus that builds them."
"""
import fnmatch
import re
from datetime import datetime
from pathlib import Path

import sqlstore


def natural_key(name):
    """Sort names the way a person would: '99-x' before '205-y', and dates in
    date order. Digit runs compare as numbers, everything else as text."""
    return [int(part) if part.isdigit() else part for part in re.split(r"(\d+)", name)]


def _now():
    return datetime.now().isoformat(timespec="seconds")


def sync_folder(root, folder, glob="*.md"):
    """Copy one folder's pages into the table. Returns how many files it saw.

    A file that changed is overwritten in place; one that hasn't changed since
    its copy was taken is left alone. A row whose file is gone gets
    `gone_at` and is kept; if the file comes back the mark is cleared. Only
    rows this glob could have made are ever marked, so two sections reading
    the same folder with different globs don't mark each other's rows."""
    root, folder = Path(root), str(folder).strip("/")
    now = _now()
    pages = []
    for path in sorted((root / folder).glob(glob)):
        if not path.is_file():
            continue
        try:
            body = path.read_text(encoding="utf-8")
            modified = datetime.fromtimestamp(path.stat().st_mtime).isoformat(timespec="seconds")
        except OSError:
            continue
        pages.append((f"{folder}/{path.name}", folder, path.name, body, modified, now))
    conn = sqlstore.open_db()
    try:
        sqlstore.begin_immediate(conn)
        # Leave out the pages whose row is already current.
        current = {row[0]: row[1] for row in conn.execute(
            "SELECT path, modified FROM journal_pages WHERE folder = ? AND gone_at IS NULL",
            (folder,))}
        changed = [page for page in pages if current.get(page[0]) != page[4]]
        conn.executemany(
            "INSERT INTO journal_pages (path, folder, name, body, modified, synced)"
            " VALUES (?, ?, ?, ?, ?, ?)"
            " ON CONFLICT(path) DO UPDATE SET body = excluded.body,"
            "  modified = excluded.modified, synced = excluded.synced, gone_at = NULL",
            changed)
        seen = {page[2] for page in pages}
        for (name,) in conn.execute(
                "SELECT name FROM journal_pages WHERE folder = ? AND gone_at IS NULL",
                (folder,)).fetchall():
            if name not in seen and fnmatch.fnmatchcase(name, glob):
                conn.execute("UPDATE journal_pages SET gone_at = ? WHERE path = ?",
                             (now, f"{folder}/{name}"))
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise
    finally:
        conn.close()
    return len(pages)


def newest(folder, glob="*.md", last=None):
    """The newest `last` pages of a folder as [{path, name, body}], oldest
    first. "Newest" goes by the file name read the way a person would, which
    is how these folders are named (a date, or a running number)."""
    folder = str(folder).strip("/")
    conn = sqlstore.open_db()
    try:
        rows = conn.execute(
            "SELECT path, name, body FROM journal_pages"
            " WHERE folder = ? AND gone_at IS NULL", (folder,)).fetchall()
    finally:
        conn.close()
    pages = sorted(({"path": row[0], "name": row[1], "body": row[2]} for row in rows
                    if fnmatch.fnmatchcase(row[1], glob)),
                   key=lambda page: natural_key(page["name"]))
    if isinstance(last, int) and last > 0:
        pages = pages[-last:]
    return pages
