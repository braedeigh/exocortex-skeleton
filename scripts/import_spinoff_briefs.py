#!/usr/bin/env python3
"""import_spinoff_briefs.py — bring the old brief folders into the database.

Plain English: before briefs were rows in exo.db (briefstore.py), every
spun-off job had a folder, `spinoffs/<slug>/` while its session was open and
`spinoff_archive/<slug>/` once it closed, holding BRIEF.md, sometimes
CONTEXT.md (the files preloaded into the session's instructions) and sometimes
handoff files (HANDOFF*.md). This reads every such folder and writes:

  - each BRIEF.md as a `spinoff_briefs` row — dated by the file's own date,
    and tied to its session where the index has one with that slug (which
    also gives who spun it off and what it continued);
  - each CONTEXT.md as that brief's `spinoff_contexts` row;
  - each HANDOFF*.md as a `spinoff_handoffs` row, with the session that wrote
    it where the tool-call log shows which one ran `peers.py handoff` on it.

It then writes `spinoff_brief` (the row's id) onto each matched session's
entry, so a session whose folder is later removed still gets its instructions
from the database. And it CHECKS itself: every file is read again and compared
with the row that holds it, byte for byte.

It never deletes or moves a file, and it is safe to run again: a folder
already imported is skipped.

    import_spinoff_briefs.py            import, then check
    import_spinoff_briefs.py --check    check only; exit 1 if anything differs

Touches: briefstore.py and sqlstore.py (the tables), store.SPINOFF_DIR and
store.SPINOFF_ARCHIVE_DIR (the folders), bot_chats/index (the sessions),
the tool_calls table (who wrote a handoff). docs/spinoff-briefs.md has the
whole story. Tests: tests/test_import_spinoff_briefs.py.
"""
import json
import re
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import sqlstore  # noqa: E402
import store  # noqa: E402

# A file named in a context's "Preloaded files" part: a `### <path>` heading
# with a code fence on the next line.
_PRELOADED_RE = re.compile(r"^### (.+?)(?: \(lines \d+-\d+\))?\n`{3,}", re.M)


def _when(path):
    return datetime.fromtimestamp(path.stat().st_mtime).isoformat(timespec="seconds")


def _folders():
    """Every job folder, live ones first: (folder, slug)."""
    for root in (store.SPINOFF_DIR, store.SPINOFF_ARCHIVE_DIR):
        if not root.is_dir():
            continue
        for folder in sorted(root.iterdir()):
            if folder.is_dir() and not folder.name.startswith("."):
                yield folder, folder.name


def _handoff_writers(conn):
    """{"<job folder>/<file name>": the session that ran `peers.py handoff` on
    that file}, read from the tool-call log. A file nobody is recorded handing
    off is simply absent. Keyed by the last two parts of the path, so a folder
    that was filed in the archive since is still found."""
    found = {}
    try:
        rows = conn.execute(
            "SELECT conv, target FROM tool_calls WHERE name = 'Bash' AND conv IS NOT NULL"
            " AND target LIKE '%peers.py handoff%' ORDER BY at").fetchall()
    except Exception:
        return found
    for conv, command in rows:
        for path in re.findall(r"--file[ =]+['\"]?(\S+?\.md)", command or ""):
            found.setdefault("/".join(Path(path).parts[-2:]), conv)
    return found


def run_import():
    """Import every folder not yet imported. Returns counts by kind."""
    index = store.read("bot_chats/index", {})
    by_slug = {}
    for conv, entry in index.items():
        if isinstance(entry, dict) and entry.get("spinoff_slug"):
            by_slug.setdefault(entry["spinoff_slug"], conv)
    counts = {"briefs": 0, "contexts": 0, "handoffs": 0, "skipped": 0, "stamped": 0}
    stamps = {}
    conn = sqlstore.open_db()
    try:
        writers = _handoff_writers(conn)
        sqlstore.begin_immediate(conn)
        for folder, slug in _folders():
            conv = by_slug.get(slug)
            entry = index.get(conv) or {}
            brief_file, brief_id = folder / "BRIEF.md", None
            if brief_file.is_file():
                body = brief_file.read_text(encoding="utf-8", errors="replace")
                # Already here: imported before (from this folder, or from the
                # live folder before it was filed), or adopted when its
                # session started.
                had = conn.execute(
                    "SELECT id FROM spinoff_briefs WHERE slug = ? AND body = ?"
                    " ORDER BY id LIMIT 1", (slug, body)).fetchone()
                if had:
                    brief_id = had[0]
                    counts["skipped"] += 1
                else:
                    parent = entry.get("spawned_from")
                    # Dated by the file, unless the file was touched after its
                    # session started; then by the session's start.
                    written = min(_when(brief_file), entry.get("started") or "9")
                    brief_id = conn.execute(
                        "INSERT INTO spinoff_briefs (slug, written_at, written_by, body, conv,"
                        " opened_at, continues, imported_from) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                        (slug, written, parent, body, conv, entry.get("started"),
                         parent if entry.get("spawned_via") == "continue" else None,
                         str(folder))).lastrowid
                    counts["briefs"] += 1
                if conv and not entry.get("spinoff_brief"):
                    stamps[conv] = brief_id
            context_file = folder / "CONTEXT.md"
            if brief_id and context_file.is_file() and not conn.execute(
                    "SELECT 1 FROM spinoff_contexts WHERE brief_id = ?", (brief_id,)).fetchone():
                text = context_file.read_text(encoding="utf-8", errors="replace")
                conn.execute("INSERT INTO spinoff_contexts (brief_id, at, body) VALUES (?, ?, ?)",
                             (brief_id, _when(context_file), text))
                conn.execute("UPDATE spinoff_briefs SET preloaded = ?, too_big = '[]'"
                             " WHERE id = ? AND preloaded IS NULL",
                             (json.dumps(_PRELOADED_RE.findall(text)), brief_id))
                counts["contexts"] += 1
            for handoff in sorted(folder.glob("HANDOFF*.md")):
                if conn.execute("SELECT 1 FROM spinoff_handoffs WHERE imported_from = ?",
                                (str(handoff),)).fetchone():
                    continue
                writer = writers.get(f"{slug}/{handoff.name}")
                conn.execute(
                    "INSERT INTO spinoff_handoffs (conv, at, body, to_conv, slug, imported_from)"
                    " VALUES (?, ?, ?, ?, ?, ?)",
                    (writer, _when(handoff),
                     handoff.read_text(encoding="utf-8", errors="replace"),
                     (index.get(writer) or {}).get("continued_by") if writer else None,
                     slug, str(handoff)))
                counts["handoffs"] += 1
        conn.execute("COMMIT")
    finally:
        conn.close()
    # Tell each matched session which row is its brief, so its instructions
    # can come from the database once its folder is gone.
    if stamps:
        with store.mutate("bot_chats/index", {}) as live:
            for conv, brief_id in stamps.items():
                if isinstance(live.get(conv), dict) and not live[conv].get("spinoff_brief"):
                    live[conv]["spinoff_brief"] = brief_id
                    counts["stamped"] += 1
    return counts


def check():
    """Read every file again and compare it with the database. Returns
    (files matched, [what differs or is missing], [files that aren't briefs])."""
    matched, wrong, other = 0, [], []
    conn = sqlstore.open_db()
    try:
        for folder, slug in _folders():
            for path in sorted(p for p in folder.rglob("*") if p.is_file()):
                if path.parent != folder or not (
                        path.name in ("BRIEF.md", "CONTEXT.md")
                        or (path.name.startswith("HANDOFF") and path.suffix == ".md")):
                    other.append(str(path))
                    continue
                text = path.read_text(encoding="utf-8", errors="replace")
                if path.name == "BRIEF.md":
                    row = conn.execute("SELECT 1 FROM spinoff_briefs WHERE slug = ? AND body = ?",
                                       (slug, text)).fetchone()
                elif path.name == "CONTEXT.md":
                    row = conn.execute(
                        "SELECT 1 FROM spinoff_contexts c JOIN spinoff_briefs b"
                        " ON b.id = c.brief_id WHERE b.slug = ? AND c.body = ?",
                        (slug, text)).fetchone()
                else:
                    row = conn.execute(
                        "SELECT 1 FROM spinoff_handoffs WHERE imported_from = ? AND body = ?",
                        (str(path), text)).fetchone()
                if row:
                    matched += 1
                else:
                    wrong.append(str(path))
    finally:
        conn.close()
    return matched, wrong, other


def main(argv=None):
    args = sys.argv[1:] if argv is None else argv
    if "--check" not in args:
        counts = run_import()
        print("imported: " + ", ".join(f"{n} {kind}" for kind, n in counts.items()))
    matched, wrong, other = check()
    print(f"checked: {matched} files are in the database word for word")
    for path in wrong:
        print(f"  NOT in the database, or different: {path}")
    if other:
        print(f"left alone ({len(other)} files that aren't briefs, contexts or handoffs):")
        for path in other:
            print(f"  {path}")
    return 1 if wrong else 0


if __name__ == "__main__":
    # Put this run on the runtime map (runtime_sensor.py): which of our
    # files actually execute, and which call which.
    import runtime_sensor
    runtime_sensor.attach()
    sys.exit(main())
