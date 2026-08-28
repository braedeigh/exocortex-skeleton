#!/usr/bin/env python3
"""scripts/command_rollup.py — fold new slash-command runs into exo.db.

The cron entry point for commandstore.py. Walks the Claude Code transcripts
under ~/.claude/projects (override with CLAUDE_PROJECTS_DIR), and inserts a
row into `command_runs` for every `/command` the owner ran that isn't already
there. Nothing is written at call time — the transcripts are the source, this
just reads them — so the first run back-fills the entire history.

    EXOCORTEX_DATA_DIR=... venv/bin/python3 scripts/command_rollup.py
    ... scripts/command_rollup.py --rebuild     # re-read every file from the top
    ... scripts/command_rollup.py --report      # print the ledger, write nothing

Cheap enough to run hourly: it stats each file and skips the unchanged ones,
so a steady-state tick costs ~0.3s against ~8,000 files, versus ~5s for the
full 1.7 GB backfill. `--rebuild` is only needed if the parsing rules in
commandstore.py change; the rows are derived, so nothing is lost by it.
"""
import argparse
import os
import sys

# Make the skeleton root importable regardless of where the script is invoked
# from (mirrors scripts/usage_rollup.py's bootstrap).
HERE = os.path.dirname(os.path.abspath(__file__))
SKELETON = os.path.dirname(HERE)
if SKELETON not in sys.path:
    sys.path.insert(0, SKELETON)

import commandstore  # noqa: E402


def report():
    """The ledger as plain text — what got used, what never did."""
    rows = commandstore.summary()
    used = {r["name"] for r in rows}
    print(f"{'command':<18}{'runs':>6}{'days':>6}  {'first':<12}{'last':<12}")
    for r in rows:
        print(f"/{r['name']:<17}{r['runs']:>6}{r['days']:>6}  "
              f"{r['first_day']:<12}{r['last_day']:<12}")
    # Installed-but-silent is the whole point of the report: a skill that
    # exists and has never been called is invisible in a table of counts,
    # because it has no row to appear in.
    cold = [n for n in commandstore.installed() if n not in used]
    if cold:
        print("\nnever run: " + ", ".join("/" + n for n in cold))


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--rebuild", action="store_true",
                    help="drop the tables and re-read every transcript")
    ap.add_argument("--report", action="store_true",
                    help="print the ledger instead of ingesting")
    args = ap.parse_args()

    if args.report:
        report()
        return 0

    stats = commandstore.rebuild() if args.rebuild else commandstore.ingest()
    print(f"scanned {stats['files']} file(s), skipped {stats['skipped']} "
          f"unchanged, {stats['rows']} new run(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
