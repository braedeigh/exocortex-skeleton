#!/usr/bin/env python3
"""Migration: fold the 'observatory' notes bucket into 'terminal' — dev notes AND ideas.

Why: the Observatory is one surface with two notes buttons — the 📝 panel on
every session and the floating notes pill on the roster page — and both are
meant to show one list, the 'terminal' tab. Whenever the roster pill has been
pointed at a separate 'observatory' tab, notes pile up there that the sessions
never show. This moves them over (ids, dates and every other field preserved)
so everything is one list again. The pill carries ideas as well as dev notes,
so both files are folded.

Goes through store.mutate → sqlstore (the database of record, exo.db), which
also re-exports the JSON mirror, so both layers end up consistent. Idempotent:
once 'observatory' is empty, re-running is a no-op.

Night-crew run records (night_runs.json) are left alone: the crew finds a run's
note by its id, never by tab, so a moved note keeps its history; the run's
`tab` stays as a record of where the note sat when it was picked.

Run as the service user with the live data dir, e.g.:
  sudo -u <service-user> env EXOCORTEX_DATA_DIR=/path/to/data \
    /path/to/skeleton/venv/bin/python3 scripts/merge_observatory_notes.py

Prompt: "i want the third notes list called observatory to be the same as the
terminal one. please merge it"
"""
import os
import sys

# Runnable from any cwd (e.g. a root shell's ~): put the skeleton root — this
# file's grandparent — on the path so `import store` resolves the same module
# gunicorn loads (WorkingDirectory=/opt/exocortex/skeleton).
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import store


def fold_observatory_into_terminal(filename):
    """Move every 'observatory' note in one notes file into 'terminal'.

    A note whose id is already in 'terminal' is dropped rather than doubled, so
    a half-finished earlier run can't leave duplicates. The merged list is then
    put back in date order — `created` is "YYYY-MM-DD HH:MM", which sorts as
    text, and the sort is stable so same-minute notes keep their order. Returns
    (how many moved, how many 'terminal' now holds)."""
    with store.mutate(filename, {"tabs": {}}) as data:
        tabs = data.setdefault("tabs", {})
        terminal = tabs.setdefault("terminal", [])
        already_there = {note.get("id") for note in terminal}
        moved = [note for note in tabs.get("observatory", []) if note.get("id") not in already_there]
        terminal.extend(moved)
        terminal.sort(key=lambda note: str(note.get("created") or ""))
        tabs["observatory"] = []
        return len(moved), len(terminal)


if __name__ == "__main__":
    for filename, label in (("dev_notes.json", "dev note"), ("idea_notes.json", "idea")):
        moved_count, total = fold_observatory_into_terminal(filename)
        print(f"Merged {moved_count} observatory {label}(s) into 'terminal' ({total} total).")
