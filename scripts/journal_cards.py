#!/usr/bin/env python3
"""journal_cards.py — read the journal's cards out of exo.db, for agents and prompts.

**What this does, in plain English.** The journal's cards used to be one
markdown file each, and agents (the Keeper, the `/thread` command, the nightly
crickets) read them by grepping that folder. Since 2026-11-16 the cards are
rows in exo.db (docs/journal-database.md) and the folder is on its way out.
This is the replacement: a read-only command that prints cards as text.

    journal_cards.py show ID [ID ...]           those cards, in full
    journal_cards.py day YYYY-MM-DD [--who B]   one day's cards, in time order
    journal_cards.py tagged SLUG [--since DAY] [--who B]
                                                every card wearing a label:
                                                `about` first, then `touches`,
                                                then not yet judged
    add --json to any of them for one JSON list instead of text.

Each card prints as a header line — id, who, when, its tags (and its weight,
for `tagged`; `answers <id>` when it replies to an earlier card) — then its
words. Only live cards and live labels: a deleted card, or a label that was
taken off, isn't shown. An id that isn't found is said so on stderr, and the
exit code is 1.

It writes nothing. Changing a card goes through the journal engine
(`tools/stream/stream.py edit / tag / untag`), never through here.

Touches: `journalcards.py` (the reads), `sqlstore.py` (the connection).

Prompt: "Point everything that still reads card files ... at the new tables,
so the card files can be retired." — the agents' half: a reader for the
prompts that grepped the card folder.
"""
import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import journalcards  # noqa: E402
import sqlstore  # noqa: E402

_DAY_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
# The fields a card carries in --json output.
_FIELDS = ("id", "who", "said_at", "day", "kind", "tags", "reply_to", "edited",
           "door", "device", "saved_at", "body")


def _as_json(card):
    out = {key: card.get(key) for key in _FIELDS}
    if "weight" in card:
        out["weight"] = card["weight"]
    return out


def _as_text(card):
    """A header line, then the words."""
    head = [card["id"], card["who"], card["said_at"]]
    if card.get("tags"):
        head.append("tags: " + ", ".join(card["tags"]))
    if "weight" in card:
        head.append(f"weight: {card['weight'] or 'unjudged'}")
    if card.get("reply_to"):
        head.append(f"answers {card['reply_to']}")
    return "## " + " · ".join(head) + "\n" + (card["body"] or "").rstrip() + "\n"


def gather(args, conn):
    """The cards one command asks for, and the ids it couldn't find."""
    if args.verb == "show":
        found, missing = [], []
        for card_id in args.ids:
            card = journalcards.read(conn, card_id)
            (found.append(card) if card else missing.append(card_id))
        return found, missing
    if args.verb == "day":
        if not _DAY_RE.match(args.date):
            raise SystemExit(f"not a day: {args.date!r} (want YYYY-MM-DD)")
        where, params = "day = ?", [args.date]
        if args.who:
            where += " AND who = ?"
            params.append(args.who)
        return journalcards.live_cards(conn, where, params), []
    return journalcards.cards_labelled(conn, args.slug, who=args.who, since=args.since), []


def main(argv=None):
    parser = argparse.ArgumentParser(description="Read journal cards out of exo.db.")
    sub = parser.add_subparsers(dest="verb", required=True)
    show = sub.add_parser("show", help="those cards, in full")
    show.add_argument("ids", nargs="+")
    day = sub.add_parser("day", help="one day's cards, in time order")
    day.add_argument("date")
    day.add_argument("--who", choices=("B", "K", "S"))
    tagged = sub.add_parser("tagged", help="every card wearing a label, about-first")
    tagged.add_argument("slug")
    tagged.add_argument("--since", help="only cards from this day on (YYYY-MM-DD)")
    tagged.add_argument("--who", choices=("B", "K", "S"))
    for each in (show, day, tagged):
        each.add_argument("--json", action="store_true", help="one JSON list instead of text")
    args = parser.parse_args(argv)

    conn = sqlstore.open_db()
    try:
        cards, missing = gather(args, conn)
    finally:
        conn.close()
    if args.json:
        print(json.dumps([_as_json(card) for card in cards], ensure_ascii=False, indent=1))
    else:
        print("\n".join(_as_text(card) for card in cards), end="")
    for card_id in missing:
        print(f"not found (no such card, or it was deleted): {card_id}", file=sys.stderr)
    return 1 if missing else 0


if __name__ == "__main__":
    sys.exit(main())
