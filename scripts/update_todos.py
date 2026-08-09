#!/usr/bin/env python3
"""Hourly refresh of the to-do mirror in exo.db (see todostore.py).

`todos.json` is the source of truth and this only ever reads it. The rebuild is
a full re-derive rather than an incremental sync — there are a few hundred
to-dos, so walking all of them costs milliseconds, and a rebuild cannot drift
from the blob the way an incremental update can. (cardstore syncs instead
because its pool has a presence promise to police; a to-do that disappears from
the blob is a deletion the owner made, not an integrity incident.)

Prints one line per run so the cron log says what happened, and reports
anything it had to skip — an item with no `id` has no identity to key a row on,
which is worth seeing rather than silently dropping.

Usage:
    scripts/update_todos.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import todostore                                   # noqa: E402


def main():
    result = todostore.rebuild()
    print(f"update_todos: {result['todos']} to-dos, {result['fronts']} fronts, "
          f"{result['front_links']} tags, {result['subtasks']} subtasks")
    if result["skipped"]:
        print(f"update_todos: skipped {result['skipped']} item(s) with no id",
              file=sys.stderr)


if __name__ == "__main__":
    main()
