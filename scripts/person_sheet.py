#!/usr/bin/env python3
"""person_sheet.py — the door for adding a current-facts sheet to a person.

**What this does, in plain English.** A person's sheets are a stack in the
`person_sheets` table in exo.db (see `personsheets.py`): each new one is added
on top and the older ones stay underneath. This script is how a session puts
one there. It checks the person has a file in the vault's `people/` folder,
the author is a cricket (`cricket:<name>`), and the sheet is exactly the five
labelled lines (Who, Pronouns, Tied to, Now, Last contact) in at most 100
words, and refuses loudly otherwise. It never changes or removes a sheet
already written.

The Keeper does not write sheets: this door refuses the author `keeper`.

    person_sheet.py add --slug SLUG --author cricket:housekeep --body-file /tmp/sheet.txt \\
        --based-on 2026-03-08 2026-03-10.0900b
    person_sheet.py list SLUG

`add` takes the words from a file (`--body-file`) or inline (`--body`). A file
is the safe way for words that hold quote marks.

Touches: `personsheets.py` (the table's reader and writer), `store.py` (where
the vault's people folder is).

Prompt: "Don't overwrite old summaries, just make a new summary."
"""
import argparse
import json
import sys
from pathlib import Path

SKELETON = Path(__file__).resolve().parents[1]
if str(SKELETON) not in sys.path:
    sys.path.insert(0, str(SKELETON))

import store  # noqa: E402
import personsheets  # noqa: E402


def add(args):
    if not args.author.startswith("cricket:"):
        print("refused: only a cricket adds a sheet (author cricket:<name>)", file=sys.stderr)
        return 2
    if not (store.CONTENT_DIR / "people" / f"{args.slug}.md").is_file():
        print(f"refused: no people file for {args.slug!r}", file=sys.stderr)
        return 2
    body = Path(args.body_file).read_text(encoding="utf-8") if args.body_file else args.body
    try:
        row = personsheets.add(args.slug, args.author, body, args.based_on, args.written_at)
    except ValueError as error:
        print(f"refused: {error}", file=sys.stderr)
        return 2
    if row is None:
        print(json.dumps({"ok": True, "added": False,
                          "why": "the same words are already the newest sheet"}))
        return 0
    print(json.dumps({"ok": True, "added": True, "id": row["id"],
                      "words": personsheets.word_count(row["body"])}))
    return 0


def show(args):
    for row in personsheets.for_person(args.slug):
        print(f"--- {row['written_at']}  {row['author']}  ({len(row['based_on'])} source(s))")
        print(row["body"])
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description="Add a current-facts sheet to a person, or read their stack.")
    commands = parser.add_subparsers(dest="command", required=True)
    adding = commands.add_parser("add", help="add one sheet on top of a person's stack")
    adding.add_argument("--slug", required=True)
    adding.add_argument("--author", required=True, help="cricket:<name>")
    words = adding.add_mutually_exclusive_group(required=True)
    words.add_argument("--body")
    words.add_argument("--body-file")
    adding.add_argument("--based-on", nargs="*", default=[], help="card ids and days")
    adding.add_argument("--written-at", help="YYYY-MM-DDTHH:MM:SS (default: now)")
    adding.set_defaults(run=add)
    listing = commands.add_parser("list", help="print a person's sheets, newest first")
    listing.add_argument("slug")
    listing.set_defaults(run=show)
    args = parser.parse_args(argv)
    return args.run(args)


if __name__ == "__main__":
    # Put this run on the runtime map (runtime_sensor.py), same as the other
    # standalone scripts.
    import runtime_sensor
    runtime_sensor.attach()
    sys.exit(main())
