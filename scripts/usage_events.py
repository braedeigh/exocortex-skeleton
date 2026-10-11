#!/usr/bin/env python3
"""scripts/usage_events.py — fold new agent tool calls and turn results into exo.db.

The cron entry point for toolcallstore.py. Walks the Observatory's
conversation logs (data/bot_chats/*.jsonl) and Claude Code's own transcripts
(~/.claude/projects, override with CLAUDE_PROJECTS_DIR) and inserts a row into
`tool_calls` for every tool call that isn't there yet, a row into
`turn_results` for every finished Observatory turn. Nothing is written at
call time — the logs are the source, this just reads them — so the first run
back-fills the whole history. The same run then folds every newly spoken line
into the chat search index (chatsearch.py).

    EXOCORTEX_DATA_DIR=... venv/bin/python3 scripts/usage_events.py
    ... scripts/usage_events.py --rebuild     # re-read every file from the top
    ... scripts/usage_events.py --report      # print the tool ledger, write nothing

Cheap enough to run hourly: unchanged files cost one stat() each. The
back-fill (or --rebuild) is a full pass over a few gigabytes and takes
minutes; run it once, in the background.
"""
import argparse
import os
import sys
import time

# Make the skeleton root importable regardless of where the script is invoked
# from (mirrors scripts/command_rollup.py's bootstrap).
HERE = os.path.dirname(os.path.abspath(__file__))
SKELETON = os.path.dirname(HERE)
if SKELETON not in sys.path:
    sys.path.insert(0, SKELETON)

import chatsearch  # noqa: E402
import toolcallstore  # noqa: E402


def report():
    """The tool ledger as plain text — which tools, how often, how they went."""
    rows = toolcallstore.summary()
    print(f"{'tool':<16}{'calls':>8}{'days':>6}{'errors':>8}{'avg ms':>9}{'no result':>11}")
    for r in rows:
        print(f"{r['name']:<16}{r['calls']:>8}{r['days']:>6}{r['errors']:>8}"
              f"{(r['avg_ms'] or 0):>9}{r['unanswered']:>11}")


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--rebuild", action="store_true",
                    help="drop the tables and re-read every log")
    ap.add_argument("--report", action="store_true",
                    help="print the ledger instead of ingesting")
    args = ap.parse_args()
    if args.report:
        report()
        return 0
    started = time.monotonic()
    stats = toolcallstore.rebuild() if args.rebuild else toolcallstore.ingest()
    print(f"usage_events: {stats['files']} files read, {stats['skipped']} unchanged,"
          f" {stats['calls']} calls, {stats['results']} results,"
          f" {stats['turns']} turns, {time.monotonic() - started:.1f}s")
    # Fold what was newly SAID into the chat search index (chatsearch.py),
    # from the same logs. A search also catches itself up, so this hourly
    # pass is what keeps that catch-up small.
    started = time.monotonic()
    said = chatsearch.rebuild() if args.rebuild else chatsearch.ingest()
    print(f"usage_events: chat search index, {said['files']} files read,"
          f" {said['skipped']} unchanged, {said['lines']} lines,"
          f" {time.monotonic() - started:.1f}s")
    return 0


if __name__ == "__main__":
    # Put this run on the runtime map (runtime_sensor.py), same as the other
    # cron scripts — inside __main__ because the module is also importable.
    import runtime_sensor
    runtime_sensor.attach()
    sys.exit(main())
