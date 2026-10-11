#!/usr/bin/env python3
"""Read the context tracker back: each load, beside what was said and what was answered.

**What this does, in plain English.** Every time a session is handed journal
context — the package a Keeper wakes with, or the cards that load when the
owner names a person or thread — one row goes into the `context_loads` table
in exo.db (written by loadrecord.py). This script prints those rows, and for
each one looks in that conversation's chat log (`bot_chats/<conv>.jsonl`) for
the message that set the load off and the reply that came after it. That is
the material for judging the memory: was the thread worth loading, did the
word that fired it mean the thread, did the reply use what it was given.

    scripts/context_loads.py                 # the last 7 days, as text
    scripts/context_loads.py --days 30 --slug the-move
    scripts/context_loads.py --conv 2026-10-04.030108 --json
    scripts/context_loads.py --until 2026-10-03 --json   # the 7 days ending that day

It only reads. A message sent off the record has no row in the table, and an
off-the-record line in a chat log is never printed here. A terminal session
has no chat log, so its rows come without a message or a reply.

Touches: `sqlstore.py` (the table), `store.py` (where the chat logs are),
`loadrecord.py` (the writer).

Prompt: "I want some kind of tracker to measure when a thread is loaded and to
what response so that my LLMs can comb through them and understand better
what's working and what's not in terms of memory."
"""
import argparse
import json
import sys
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import sqlstore  # noqa: E402
import store  # noqa: E402

# How long after her message's own timestamp a load can still belong to it.
# The hook runs as the message is sent, so the two are within a second or two.
SLACK = timedelta(seconds=5)


def _chat_lines(conv):
    """A conversation's chat log as a list of dicts, in file order. Empty when
    there is no log (a terminal session) or it can't be read."""
    lines = []
    try:
        with open(store.DATA_DIR / "bot_chats" / f"{conv}.jsonl", encoding="utf-8") as handle:
            for raw in handle:
                try:
                    lines.append(json.loads(raw))
                except ValueError:
                    continue
    except OSError:
        pass
    return lines


def said_and_answered(lines, at):
    """The owner's message a load at time `at` belongs to, and the reply that
    followed it: (message, reply). Either is None when it can't be found.

    The message is the last one she sent at or just before the load. The reply
    is the first finished turn after that message in the log."""
    try:
        moment = datetime.fromisoformat(at) + SLACK
    except ValueError:
        return None, None
    position = None
    for index, line in enumerate(lines):
        if line.get("type") != "user" or not line.get("ts"):
            continue
        try:
            if datetime.fromisoformat(line["ts"]) <= moment:
                position = index
        except ValueError:
            continue
    if position is None or lines[position].get("off_record"):
        return None, None
    reply = next((line.get("result") for line in lines[position + 1:]
                  if line.get("type") == "result"), None)
    return lines[position].get("text"), reply


def loads(days=7, conv=None, slug=None, source=None, until=None):
    """The tracker's rows as dicts, oldest first, each with `said` and
    `answered` filled in from the chat log. The window is the `days` up to
    now, or, with `until` (YYYY-MM-DD), the `days` ending on that day."""
    if until:
        end = datetime.strptime(until, "%Y-%m-%d") + timedelta(days=1)
        clauses, parameters = (["at >= ?", "at < ?"],
                               [(end - timedelta(days=days)).isoformat(), end.isoformat()])
    else:
        clauses, parameters = ["at >= ?"], [(datetime.now() - timedelta(days=days)).isoformat()]
    for column, value in (("conv", conv), ("slug", slug), ("source", source)):
        if value:
            clauses.append(f"{column} = ?")
            parameters.append(value)
    conn = sqlstore.open_db()
    try:
        cursor = conn.execute(
            "SELECT id, at, conv, source, kind, slug, name, matched, outcome, cards,"
            " card_ids, skipped FROM context_loads WHERE " + " AND ".join(clauses)
            + " ORDER BY at, id", parameters)
        columns = [item[0] for item in cursor.description]
        rows = [dict(zip(columns, row)) for row in cursor.fetchall()]
    finally:
        conn.close()
    logs = {}
    for row in rows:
        row["card_ids"] = json.loads(row["card_ids"] or "[]")
        row["said"] = row["answered"] = None
        if row["source"] == "mention":
            lines = logs.setdefault(row["conv"], _chat_lines(row["conv"]))
            row["said"], row["answered"] = said_and_answered(lines, row["at"])
    return rows


def _short(text, length):
    flat = " ".join((text or "").split())
    return flat if len(flat) <= length else flat[:length].rstrip() + "…"


def as_text(rows, length):
    out = []
    for row in rows:
        if row["source"] == "boot":
            out.append(f"{row['at']}  {row['conv']}  BOOT — {row['cards']} cards")
            continue
        out.append(f"{row['at']}  {row['conv']}  {row['kind']} {row['name']} ({row['slug']})"
                   f" — set off by \"{row['matched']}\" — {row['outcome']}:"
                   f" {row['cards']} cards, {row['skipped']} left out as already loaded")
        if row["card_ids"]:
            out.append(f"    cards: {row['card_ids'][0]} to {row['card_ids'][-1]}")
        if row["said"]:
            out.append(f"    she said: {_short(row['said'], length)}")
        if row["answered"]:
            out.append(f"    the reply: {_short(row['answered'], length)}")
    return "\n".join(out) if out else "No loads in that window."


def main(argv=None):
    parser = argparse.ArgumentParser(description="Print the context tracker beside the replies.")
    parser.add_argument("--days", type=int, default=7, help="how far back to look (default 7)")
    parser.add_argument("--until", help="end the window on this day (YYYY-MM-DD) instead of now")
    parser.add_argument("--conv", help="only this conversation")
    parser.add_argument("--slug", help="only this person or thread")
    parser.add_argument("--source", choices=("boot", "mention"), help="only this kind of load")
    parser.add_argument("--length", type=int, default=400,
                        help="how much of each message and reply to show as text (default 400)")
    parser.add_argument("--json", action="store_true",
                        help="print everything, uncut, as JSON (for another program to read)")
    args = parser.parse_args(argv)
    rows = loads(args.days, args.conv, args.slug, args.source, args.until)
    print(json.dumps(rows, indent=1) if args.json else as_text(rows, args.length))
    return 0


if __name__ == "__main__":
    # Put this run on the runtime map (runtime_sensor.py), same as the other
    # standalone scripts.
    import runtime_sensor
    runtime_sensor.attach()
    sys.exit(main())
