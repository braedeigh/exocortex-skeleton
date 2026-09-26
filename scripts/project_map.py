#!/usr/bin/env python3
"""Print one project of the app — its code, its data, and what a fresh install needs.

Plain English: projects.json cuts the app into projects (journal, kitchen,
research…). This script reads that map and prints a project in words: which
files make it up, and — the useful part — its database tables sorted by what
would happen to them on someone else's machine:

    rebuilt from a source   'mirror' tables: wiped and refilled from files
                            or logs, so nothing to carry over
    their own record        'store' / 'record' / 'mixed' tables: the owner's
                            data. The schema comes with the code; a new install
                            starts these empty and fills them by living

The kinds and sources come from table_notes.json. With a data dir set, each
table also shows how many rows it has now (read-only).

    venv/bin/python3 scripts/project_map.py            # every project, one line each
    venv/bin/python3 scripts/project_map.py kitchen    # one project in full

Prompt that produced this file: "whatever tables someone else would need
rebuilt would be great" — projects for "my own understanding for now but
installable by other people".
"""
import json
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import store  # noqa: E402  (sys.path above)

REBUILT = {"mirror"}


def load():
    projects = json.loads((ROOT / "projects.json").read_text())["projects"]
    notes = json.loads((ROOT / "table_notes.json").read_text())
    return projects, notes


def row_counts(tables):
    """How many rows each table holds right now — empty if there's no database."""
    path = store.DATA_DIR / "exo.db"
    if not path.exists():
        return {}
    connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    counts = {}
    for table in tables:
        try:
            counts[table] = connection.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]
        except sqlite3.Error:
            counts[table] = None
    connection.close()
    return counts


def first_sentence(text):
    return (text or "").split(". ")[0].rstrip(".") + "."


def show_summary(projects):
    """One line per project: its name, what it is, and how big it is."""
    for project_id, project in projects.items():
        print(f"{project_id:12} {project['name']:12} {len(project['tables']):3} tables  "
              f"{len(project['collections']):3} collections  {len(project['routes']):3} routes")
    print("\nOne in full:  scripts/project_map.py <project>")


def show_project(project_id, project, notes):
    """A project in full: its files, then its tables grouped by what a new install does."""
    print(f"# {project['name']}\n\n{project['what']}\n")

    # The code, one line per kind of file.
    for kind, label in (("modules", "Modules"), ("routes", "Routes (routes/)"),
                        ("frontend", "Pages (frontend/src/features/)"), ("tools", "Tools (tools/)"),
                        ("scripts", "Scripts (scripts/)")):
        if project[kind]:
            print(f"{label}: {', '.join(project[kind])}")
    if project["dev_note_tabs"]:
        print(f"Dev-note tabs: {', '.join(project['dev_note_tabs'])}")

    # The tables, split by whether a fresh install rebuilds them or starts empty.
    counts = row_counts(project["tables"])
    rebuilt = [t for t in project["tables"] if notes.get(t, {}).get("kind") in REBUILT]
    own = [t for t in project["tables"] if t not in rebuilt]
    for heading, tables in (("Their own record — a new install starts these empty", own),
                            ("Rebuilt from a source — nothing to carry over", rebuilt)):
        if not tables:
            continue
        print(f"\n## {heading}")
        for table in tables:
            note = notes.get(table, {})
            rows = counts.get(table)
            size = f"{rows:>7} rows" if rows is not None else " " * 12
            print(f"  {table:26} {size}  [{note.get('kind', '?')}] {first_sentence(note.get('source'))}")

    if project["collections"]:
        print("\n## Collections (whole documents in the `docs` table, each with a .json copy)")
        print("  " + ", ".join(project["collections"]))
        print("  These are the owner's record too — a new install starts them empty.")


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    projects, notes = load()
    if not argv:
        show_summary(projects)
        return 0
    if argv[0] not in projects:
        print(f"no project '{argv[0]}' — one of: {', '.join(projects)}", file=sys.stderr)
        return 2
    show_project(argv[0], projects[argv[0]], notes)
    return 0


if __name__ == "__main__":
    # Put this run on the runtime map (runtime_sensor.py), from __main__ only.
    import runtime_sensor
    runtime_sensor.attach()
    sys.exit(main())
