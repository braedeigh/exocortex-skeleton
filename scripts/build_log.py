#!/usr/bin/env python3
"""build_log.py — the door to the build log: add, read, and close build items.

**What this does, in plain English.** The build log is everything planned,
built, or decided against for the app, one row per item in exo.db (see
`buildlog.py`). This script is how a session — Spark, the Keeper, any coding
session — files a new build task or bug, reads what's open, adds a finding
under an item, or marks it shipped or dropped. It replaced appending a `## `
section to the vault's `dev_todo.md`.

    build_log.py add --title "..." --by keeper [--status idea] --body-file /tmp/item.md \\
        --card 2026-10-14.1630b
    build_log.py quote 42 --card 2026-10-15.0910b
    build_log.py list [--status shipped ...] [--all] [--search word]
    build_log.py show 42
    build_log.py note 42 --by spark --text "found the cause: ..."
    build_log.py status 42 shipped --by spark --why "skeleton abc1234"
    build_log.py import-markdown /path/to/dev_todo.md     # the one-time move

`--card` keeps the owner's own words beside the write-up, copied verbatim
from her journal cards (only cards she wrote are accepted). `quote` adds
more cards to an item already filed.

Words with quote marks in them are safest through a file (`--body-file`,
`--text-file`).

Touches: `buildlog.py` (the table's reader and writer).
"""
import argparse
import json
import sys
from pathlib import Path

SKELETON = Path(__file__).resolve().parents[1]
if str(SKELETON) not in sys.path:
    sys.path.insert(0, str(SKELETON))

import buildlog  # noqa: E402


def _words(inline, path):
    return Path(path).read_text(encoding="utf-8") if path else (inline or "")


def _line(item):
    """One item as a single line: number, status, day, title, who."""
    day = item["raised_on"] or "undated   "
    return f"#{item['id']:<4} {item['status']:<8} {day}  {item['title']}  ({item['raised_by']})"


def add(args):
    item = buildlog.add(args.title, args.by, _words(args.body, args.body_file),
                        status=args.status, raised_on=args.raised_on, cards=args.card)
    print(json.dumps({"ok": True, "id": item["id"], "status": item["status"]}))


def list_items(args):
    statuses = buildlog.STATUSES if args.all else (args.status or buildlog.LIVE)
    found = buildlog.items(statuses, search=args.search)
    for item in found:
        print(_line(item))
    print(f"-- {len(found)} item(s): {', '.join(statuses)}", file=sys.stderr)


def show(args):
    item = buildlog.get(args.id)
    if item is None:
        raise ValueError(f"no build item #{args.id}")
    print(_line(item))
    if item["closed_on"]:
        print(f"closed {item['closed_on']}")
    if item["source"]:
        print(f"from {item['source']}")
    if item["owner_words"]:
        print(f"\nHer words (cards {', '.join(item['owner_cards'])}):\n")
        print(item["owner_words"])
        print(f"\nWrite-up ({item['raised_by']}):")
    print()
    print(item["body"] or "(no write-up)")
    for entry in item["notes"]:
        print(f"\n--- {entry['written_at']}  {entry['author']}  [{entry['kind']}]")
        print(entry["text"])


def quote(args):
    item = buildlog.quote(args.id, args.card)
    print(json.dumps({"ok": True, "id": item["id"], "cards": item["owner_cards"]}))


def note(args):
    buildlog.note(args.id, args.by, _words(args.text, args.text_file))
    print(json.dumps({"ok": True, "id": args.id}))


def status(args):
    item = buildlog.set_status(args.id, args.status, args.by, args.why or "")
    print(json.dumps({"ok": True, "id": item["id"], "status": item["status"]}))


def import_markdown(args):
    count = buildlog.import_markdown(Path(args.path).read_text(encoding="utf-8"),
                                     source_name=Path(args.path).name)
    print(json.dumps({"ok": True, "imported": count}))


def main(argv=None):
    parser = argparse.ArgumentParser(description="The build log: what's planned, built, or decided against.")
    commands = parser.add_subparsers(dest="command", required=True)

    adding = commands.add_parser("add", help="file a new build item")
    adding.add_argument("--title", required=True)
    adding.add_argument("--by", required=True, help="who raised it: hers, keeper, spark, ...")
    adding.add_argument("--status", default="open", choices=buildlog.STATUSES)
    adding.add_argument("--raised-on", help="YYYY-MM-DD (default: today)")
    words = adding.add_mutually_exclusive_group()
    words.add_argument("--body")
    words.add_argument("--body-file")
    adding.add_argument("--card", nargs="+", default=[],
                        help="the owner's journal card(s) to keep her words from, verbatim")
    adding.set_defaults(run=add)

    quoting = commands.add_parser("quote", help="add the owner's words from journal cards to an item")
    quoting.add_argument("id", type=int)
    quoting.add_argument("--card", nargs="+", required=True)
    quoting.set_defaults(run=quote)

    listing = commands.add_parser("list", help="one line per item, newest first (default: idea, open, paused)")
    listing.add_argument("--status", nargs="+", choices=buildlog.STATUSES)
    listing.add_argument("--all", action="store_true", help="every status, closed ones too")
    listing.add_argument("--search", help="only items whose words contain this")
    listing.set_defaults(run=list_items)

    showing = commands.add_parser("show", help="one item in full, with its notes")
    showing.add_argument("id", type=int)
    showing.set_defaults(run=show)

    noting = commands.add_parser("note", help="add a dated finding or follow-up under an item")
    noting.add_argument("id", type=int)
    noting.add_argument("--by", required=True)
    text = noting.add_mutually_exclusive_group(required=True)
    text.add_argument("--text")
    text.add_argument("--text-file")
    noting.set_defaults(run=note)

    moving = commands.add_parser("status", help="move an item to a new status")
    moving.add_argument("id", type=int)
    moving.add_argument("status", choices=buildlog.STATUSES)
    moving.add_argument("--by", required=True)
    moving.add_argument("--why", help="one line: the commit, the reason")
    moving.set_defaults(run=status)

    importing = commands.add_parser("import-markdown", help="the one-time move of a dev_todo.md into the log")
    importing.add_argument("path")
    importing.set_defaults(run=import_markdown)

    args = parser.parse_args(argv)
    # A bad value is refused with its reason and exit 2, like the other doors.
    try:
        args.run(args)
    except ValueError as error:
        print(f"refused: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    # Put this run on the runtime map (runtime_sensor.py), same as the other
    # standalone scripts.
    import runtime_sensor
    runtime_sensor.attach()
    sys.exit(main())
