#!/usr/bin/env python3
"""Rollout checker: validate the on-disk JSON for every schema'd collection.

Deliberately does NOT import store or sqlstore. store.read()/sqlstore.get()
can WRITE as a side effect (sqlstore's lazy migration stamps `user_version`,
and `_seed_from_file` INSERTs a row on first touch) -- this script must be
safe to run read-only, any time, service up or down. Instead it reads each
collection's `<name>.json` straight off disk; for SQL-backed collections
that's the exported mirror, which sqlstore guarantees is always current.

Usage:
    scripts/validate_data.py [data_dir]
        data_dir defaults to $EXOCORTEX_DATA_DIR.

Prints every violation found, one line per collection plus one indented
line per violation. A collection with no file on disk is noted and skipped
(not every collection is populated on every install -- that's not corruption).
Exits 1 if any collection has at least one violation, 0 otherwise.
"""
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import schemas  # noqa: E402  (path insert must come first)


def main(argv):
    data_dir_arg = argv[1] if len(argv) > 1 else os.environ.get("EXOCORTEX_DATA_DIR")
    if not data_dir_arg:
        print("usage: validate_data.py <data_dir>  (or set $EXOCORTEX_DATA_DIR)", file=sys.stderr)
        return 2
    data_dir = Path(data_dir_arg)

    any_violations = False
    for name in sorted(schemas.COLLECTIONS):
        path = data_dir / f"{name}.json"
        if not path.exists():
            print(f"{name}: no file at {path} -- skipping")
            continue
        try:
            data = json.loads(path.read_text())
        except (OSError, json.JSONDecodeError) as e:
            print(f"{name}: could not read/parse {path}: {e}")
            any_violations = True
            continue
        violations = schemas.iter_violations(name, data)
        if not violations:
            print(f"{name}: ok")
            continue
        any_violations = True
        print(f"{name}: {len(violations)} violation(s) in {path}")
        for v in violations:
            print(f"  {v}")

    return 1 if any_violations else 0


if __name__ == "__main__":
    # Put this run on the runtime map (runtime_sensor.py): which of our
    # files actually execute, and which call which. Inside __main__ rather
    # than at import, because some of these modules are also imported BY
    # the web app, and only the standalone run is a process of its own.
    import runtime_sensor
    runtime_sensor.attach()
    sys.exit(main(sys.argv))
