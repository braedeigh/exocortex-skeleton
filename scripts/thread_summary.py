#!/usr/bin/env python3
"""thread_summary.py — the door for adding a summary to a journal thread.

**What this does, in plain English.** A thread's summaries are a stack in the
`thread_summaries` table in exo.db (see `threadsummaries.py`): each new one is
added on top and the older ones stay underneath. This script is how a session
puts one there. It checks the thread exists, the author is a cricket
(`cricket:<name>`), and the summary is at most 120 words, and refuses loudly
otherwise. It never changes or removes a summary already written.

The Keeper does not write summaries: this door refuses the author `keeper`.
The one keeper row in the table was put there once, at the owner's request,
before that rule.

    thread_summary.py add --slug SLUG --author cricket:housekeep --body-file /tmp/summary.txt \\
        --based-on 2026-03-08 2026-03-10.0900b [--status retired]
    thread_summary.py list SLUG
    thread_summary.py import-nights

`add` takes the words from a file (`--body-file`) or inline (`--body`). A file
is the safe way for words that hold quote marks.

`import-nights` reads the summaries the nightly thread tending wrote before
this table existed. Each night's folder in `thread_tending/` in the data
folder holds an `outcome.json` with one summary per thread; each is added as a
`cricket:thread-helper` row dated that night. A night that was a trial run is
skipped, and a row already imported is not imported twice.

Touches: `threadsummaries.py` (the table's reader and writer),
`routes/threads.py` (the list of threads).

Prompt: "Summarize it and put that in there somewhere in the database as a
keeper record. Then have the crickets store information the same way."
"""
import argparse
import json
import sys
from pathlib import Path

SKELETON = Path(__file__).resolve().parents[1]
if str(SKELETON) not in sys.path:
    sys.path.insert(0, str(SKELETON))

import store  # noqa: E402
import threadsummaries  # noqa: E402

# The author recorded for a summary written by the night pass's thread session.
NIGHT_AUTHOR = "cricket:thread-helper"


def _known_thread(slug):
    from routes import threads
    return slug in threads.threads_index()


def add(args):
    if not args.author.startswith("cricket:"):
        print("refused: only a cricket adds a summary (author cricket:<name>)", file=sys.stderr)
        return 2
    if not _known_thread(args.slug):
        print(f"refused: no thread file for {args.slug!r}", file=sys.stderr)
        return 2
    body = Path(args.body_file).read_text(encoding="utf-8") if args.body_file else args.body
    try:
        row = threadsummaries.add(args.slug, args.author, body, args.based_on, args.written_at,
                                  status=args.status)
    except ValueError as error:
        print(f"refused: {error}", file=sys.stderr)
        return 2
    if row is None:
        print(json.dumps({"ok": True, "added": False,
                          "why": "the same words are already the newest summary"}))
        return 0
    print(json.dumps({"ok": True, "added": True, "id": row["id"],
                      "words": threadsummaries.word_count(row["body"])}))
    return 0


def show(args):
    for row in threadsummaries.for_thread(args.slug):
        marked = f"  [{row['status']}]" if row["status"] else ""
        print(f"--- {row['written_at']}  {row['author']}{marked}  ({len(row['based_on'])} source(s))")
        print(row["body"])
    return 0


def import_nights(args):
    """Add the summaries the night pass wrote before the table existed."""
    added = skipped = 0
    for outcome_path in sorted((store.DATA_DIR / "thread_tending").glob("*/outcome.json")):
        outcome = json.loads(outcome_path.read_text(encoding="utf-8"))
        if not outcome.get("applied"):
            continue
        # Dated late on the night it describes, so it sorts after that day's
        # cards and before anything written the next day.
        written_at = f"{outcome['target']}T23:59:00"
        for entry in outcome.get("movement") or []:
            body = threadsummaries.fit(entry.get("summary"))
            if not body or not _known_thread(entry["slug"]):
                skipped += 1
                continue
            already = any(row["written_at"] == written_at and row["author"] == NIGHT_AUTHOR
                          for row in threadsummaries.for_thread(entry["slug"]))
            if already:
                skipped += 1
                continue
            sources = sorted({source for item in entry.get("movement") or []
                              for source in item.get("sources") or []})
            row = threadsummaries.add(entry["slug"], NIGHT_AUTHOR, body, sources, written_at)
            added += 1 if row else 0
            skipped += 0 if row else 1
    print(json.dumps({"ok": True, "added": added, "skipped": skipped}))
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description="Add a summary to a journal thread, or read its stack.")
    commands = parser.add_subparsers(dest="command", required=True)
    adding = commands.add_parser("add", help="add one summary on top of a thread's stack")
    adding.add_argument("--slug", required=True)
    adding.add_argument("--author", required=True, help="cricket:<name>")
    adding.add_argument("--status", choices=threadsummaries.STATUSES,
                        help="the status the thread just moved to, when that is why this is written")
    words = adding.add_mutually_exclusive_group(required=True)
    words.add_argument("--body")
    words.add_argument("--body-file")
    adding.add_argument("--based-on", nargs="*", default=[], help="card ids and days")
    adding.add_argument("--written-at", help="YYYY-MM-DDTHH:MM:SS (default: now)")
    adding.set_defaults(run=add)
    listing = commands.add_parser("list", help="print a thread's summaries, newest first")
    listing.add_argument("slug")
    listing.set_defaults(run=show)
    importing = commands.add_parser("import-nights", help="add the summaries older night passes wrote")
    importing.set_defaults(run=import_nights)
    args = parser.parse_args(argv)
    return args.run(args)


if __name__ == "__main__":
    # Put this run on the runtime map (runtime_sensor.py), same as the other
    # standalone scripts.
    import runtime_sensor
    runtime_sensor.attach()
    sys.exit(main())
