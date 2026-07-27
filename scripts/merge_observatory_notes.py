#!/usr/bin/env python3
"""One-time migration: fold the 'observatory' dev-notes bucket into 'terminal'.

Why: the roster pill, the terminal's own notes, and the conversation's
above-input Dev-notes button all read the 'terminal' tab; a handful of notes
got written to a separate 'observatory' tab before the merge. This moves them
over (ids + dates preserved) so everything is one list.

Goes through store.mutate → sqlstore (the database of record, exo.db), which
also re-exports the JSON mirror, so both layers end up consistent. Idempotent:
once 'observatory' is empty, re-running is a no-op. Safe to delete afterward.

Run as the service user (bradie) with the live data dir, e.g.:
  sudo -u bradie env EXOCORTEX_DATA_DIR=/opt/exocortex/personal/data \
    /opt/exocortex/skeleton/venv/bin/python3 scripts/merge_observatory_notes.py
"""
import os
import sys

# Runnable from any cwd (e.g. a root shell's ~): put the skeleton root — this
# file's grandparent — on the path so `import store` resolves the same module
# gunicorn loads (WorkingDirectory=/opt/exocortex/skeleton).
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import store

with store.mutate("dev_notes.json", {"tabs": {}}) as d:
    tabs = d.setdefault("tabs", {})
    moved = list(tabs.get("observatory", []))
    tabs.setdefault("terminal", []).extend(moved)
    tabs["observatory"] = []
    total = len(tabs["terminal"])

print(f"Merged {len(moved)} observatory note(s) into 'terminal' ({total} total).")
