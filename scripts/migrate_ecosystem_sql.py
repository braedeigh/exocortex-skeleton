#!/usr/bin/env python3
"""Move the ecosystem map's sources out of ecosystem.json and into SQL.

Plain English: the map's dots used to live in their own JSON file. This copies
each one into the `food_sources` table (sourcestore.py), keeping its id — the
links from foods and products (food_links) already point at those ids, so they
keep working untouched. Each moved source gets an origin: 'usda-nass' for the
county outlines (only the USDA button ever made those), 'unknown' for the rest.

Default is a dry run that prints what it would do. `--apply` writes, then
renames the file to ecosystem.pre-sql.json so nothing reads it by mistake.
Safe to re-run: a source already in the table is skipped.

    EXOCORTEX_DATA_DIR=/path/to/data venv/bin/python3 scripts/migrate_ecosystem_sql.py
    EXOCORTEX_DATA_DIR=/path/to/data venv/bin/python3 scripts/migrate_ecosystem_sql.py --apply

Prompt that produced this file: "i want it to no longer be json and be in the
sql along with other foods."
"""
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

if not os.environ.get("EXOCORTEX_DATA_DIR"):
    sys.exit("set EXOCORTEX_DATA_DIR to the data dir this migration should touch")

import sourcestore  # noqa: E402  (sys.path above)
import store  # noqa: E402


def main():
    apply = "--apply" in sys.argv
    legacy_path = store.DATA_DIR / "ecosystem.json"
    if not legacy_path.exists():
        sys.exit(f"nothing to move: {legacy_path} doesn't exist")
    legacy = json.loads(legacy_path.read_text())
    for line in sourcestore.adopt_legacy(legacy, apply=apply):
        print(line)
    if apply:
        moved = legacy_path.with_name("ecosystem.pre-sql.json")
        legacy_path.rename(moved)
        print(f"renamed {legacy_path.name} → {moved.name}")
    else:
        print("dry run — pass --apply to write")


if __name__ == "__main__":
    # Put this run on the runtime map (runtime_sensor.py), from __main__ only.
    import runtime_sensor
    runtime_sensor.attach()
    main()
