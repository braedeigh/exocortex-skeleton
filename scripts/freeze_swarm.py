#!/usr/bin/env python3
"""freeze_swarm.py — keep one swarm as it stood at one moment, for the demo.

Plain English: the portfolio shows a real swarm, stopped mid-work, that a
visitor can click through (routes/swarm_demo.py serves it, the page is
frontend/src/features/observatory/SwarmDemoPage.tsx). This script makes the
file that demo reads. Given a swarm and a moment, it rebuilds what the
Observatory showed then:

  - who was in the swarm, and each one's state: working if a turn of its was
    running at that moment, needs input if it had questions open, otherwise
    silent; retired if it had already handed its work on or been archived;
  - the helper's name and summaries from its last run before that moment;
  - who had messaged whom by then (the lines of the drawing), and the
    messages themselves;
  - every member's chat, and the helper's, cut off at that moment, and only
    the parts a chat page draws: what the owner typed, what the agent said,
    messages between agents, questions and reminders. Tool calls, tool
    output, thinking and loaded journal context are all left out.

Nothing is written to the database. The result goes to the data folder (the
owner's files, never this repo) as a DRAFT, `swarm_demo_draft.json`, which no
route serves. The owner reads it first: `--review` prints every word a
visitor could read. `--publish` then copies the draft to `swarm_demo.json`,
the file the demo serves, and `--unpublish` takes that file away again.

    ./venv/bin/python3 scripts/freeze_swarm.py 23 --at 2026-10-02T22:52:20
    ./venv/bin/python3 scripts/freeze_swarm.py --review
    ./venv/bin/python3 scripts/freeze_swarm.py --publish

Touches: exo.db (swarms, swarm_members, swarm_helper_runs, agent_messages —
read only), bot_chats/index and the transcripts, store.py (the write).

Prompt that produced it: "i want to put like, a frozen demo of a swarm that
was working and make it clickable" · "i also want for example, some of the
dots to be spinning to show what they look like when they're working"
"""
import argparse
import json
import os
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import store  # noqa: E402

import lanes  # noqa: E402
import sqlstore  # noqa: E402

DEMO_COLLECTION = "swarm_demo"
DRAFT_COLLECTION = "swarm_demo_draft"


def _local(stamp):
    """A transcript timestamp as local wall-clock text, to the second. The
    app's own lines carry local time already (`ts`); the agent's lines carry
    UTC with a Z (`timestamp`), which is moved to local so both compare."""
    if not isinstance(stamp, str) or not stamp:
        return None
    if stamp.endswith("Z") or "+" in stamp[10:]:
        try:
            moment = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
        except ValueError:
            return None
        return moment.astimezone().strftime("%Y-%m-%dT%H:%M:%S")
    return stamp[:19]


def _said(message):
    """The words in an agent's message: its text blocks only."""
    content = message.get("content") if isinstance(message, dict) else None
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    return "\n\n".join(block["text"] for block in content
                       if isinstance(block, dict) and block.get("type") == "text"
                       and isinstance(block.get("text"), str) and block["text"].strip())


def frozen_chat(path, at):
    """One chat as it stood at `at`: the events a chat page draws, and whether
    a turn was running at that moment, and the questions open then (`asking`).

    The file is in the order things happened, so the walk stops at the first
    line stamped after `at`. Lines with no stamp of their own (most of the
    agent's machinery) take the time of the line before them.
    """
    events, running, asking = [], False, []
    if not path.exists():
        return {"events": events, "running": running, "asking": asking}
    for line in path.read_text().splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if not isinstance(event, dict):
            continue
        stamp = _local(event.get("ts") or event.get("timestamp"))
        if stamp and stamp > at:
            break
        kind = event.get("type")
        # Keep what the owner typed. A message said off the record stays out
        # of the demo altogether; the agent's echo of a tool result is not hers.
        if kind == "user":
            if isinstance(event.get("text"), str) and not event.get("off_record"):
                events.append({"type": "user", "text": event["text"], "ts": stamp})
                running, asking = True, []
        # Keep what the agent said, words only.
        elif kind == "assistant":
            said = _said(event.get("message"))
            if said:
                events.append({"type": "assistant", "ts": stamp,
                               "message": {"content": [{"type": "text", "text": said}]}})
        # Keep a message between two agents, as its card needs it.
        elif kind == "peer":
            events.append({key: event.get(key) for key in (
                "type", "direction", "id", "from_conv", "from_title", "to_conv",
                "to_title", "text", "mode", "status", "ts")})
            if event.get("direction") == "in":
                running = True
        elif kind == "questions":
            events.append({"type": "questions", "questions": event.get("questions"), "ts": stamp})
            asking = [q for q in event.get("questions") or [] if isinstance(q, str) and q.strip()]
        elif kind == "questions-withdrawn":
            events.append({"type": kind, "source": event.get("source"), "ts": stamp})
            asking = []
        elif kind == "reminder":
            events.append({"type": kind, "text": event.get("text"),
                           "source": event.get("source"), "ts": stamp})
            running = True
        elif kind == "error":
            events.append({"type": kind, "error": event.get("error")})
        elif kind == "result":
            events.append({"type": "result"})
            running = False
    return {"events": events, "running": running, "asking": asking}


def freeze(swarm_id, at):
    """The whole demo file for one swarm at one moment (see the top)."""
    index = store.read("bot_chats/index", {})
    index = index if isinstance(index, dict) else {}
    chats = store.DATA_DIR / "bot_chats"
    conn = sqlstore.open_db()
    try:
        row = conn.execute("SELECT name, lane, helper_conv, created_at FROM swarms WHERE id = ?",
                           (swarm_id,)).fetchone()
        if row is None:
            raise SystemExit(f"no swarm {swarm_id}")
        name, lane, helper, created = row
        joined = conn.execute("SELECT conv, joined_at FROM swarm_members WHERE swarm_id = ?"
                              " AND joined_at <= ? ORDER BY joined_at, conv", (swarm_id, at)).fetchall()
        # The helper's last run before the moment gives the name and the
        # swarm's summary; each member's summary is the newest one any run
        # up to then wrote for it.
        summary, summary_at, member_summary = None, None, {}
        for run_at, output in conn.execute(
                "SELECT at, output FROM swarm_helper_runs WHERE swarm_id = ? AND at <= ?"
                " AND output IS NOT NULL ORDER BY id", (swarm_id, at)):
            try:
                wrote = json.loads(output)
            except ValueError:
                continue
            if wrote.get("name"):
                name = wrote["name"]
            if wrote.get("summary"):
                summary, summary_at = wrote["summary"], run_at
            for member in wrote.get("members") or []:
                if member.get("conv") and member.get("summary"):
                    member_summary[member["conv"]] = (member["summary"], run_at)
        member_ids = [conv for conv, _ in joined]
        helpers = {conv for conv, entry in index.items()
                   if isinstance(entry, dict) and entry.get("role") == "swarm_helper"
                   and entry.get("swarm_id") == swarm_id} | ({helper} if helper else set())
        everyone = [*member_ids, *sorted(helpers)]
        marks = ",".join("?" * len(everyone))
        mail = conn.execute(
            f"SELECT id, at, from_conv, to_conv, text, mode, status FROM agent_messages"
            f" WHERE kind = 'A' AND status != 'cancelled' AND at <= ?"
            f" AND from_conv IN ({marks}) AND to_conv IN ({marks}) ORDER BY id",
            (at, *everyone, *everyone)).fetchall()
    finally:
        conn.close()

    def title(conv):
        if conv in helpers:
            return "Helper"
        entry = index.get(conv)
        return (entry.get("title") if isinstance(entry, dict) else None) or conv

    # Which member had handed its work on by the moment: its continuation
    # had already started.
    handed_on = {entry.get("spawned_from") for entry in index.values()
                 if isinstance(entry, dict) and entry.get("spawned_via") == "continue"
                 and str(entry.get("started") or "9") <= at}
    sessions, members = {}, []
    counts = {"working": 0, "silent": 0, "needs_input": 0}
    for conv, joined_at in joined:
        entry = index.get(conv) if isinstance(index.get(conv), dict) else {}
        chat = frozen_chat(chats / f"{conv}.jsonl", at)
        archived = entry.get("archived")
        retired = conv in handed_on or (isinstance(archived, str) and archived <= at)
        state = "silent" if retired else "needs_input" if chat["asking"] else \
            "working" if chat["running"] else "silent"
        counts[state] += 1
        told, told_at = member_summary.get(conv, (None, None))
        members.append({"conv": conv, "title": title(conv), "lane": lanes.derive_lane(entry),
                        "state": state, "retired": retired, "joined_at": joined_at,
                        "summary": told, "summary_at": told_at})
        sessions[conv] = {"title": title(conv), "state": state, "retired": retired,
                          "questions": [] if retired else chat["asking"],
                          "events": chat["events"]}
    helper_working = False
    if helper:
        chat = frozen_chat(chats / f"{helper}.jsonl", at)
        helper_working = chat["running"]
        sessions[helper] = {"title": (index.get(helper) or {}).get("title") or "Helper",
                            "state": "working" if helper_working else "silent",
                            "retired": False, "questions": [], "events": chat["events"]}

    # The lines of the drawing, counted from the same messages the demo
    # lists, so a line's number is how many open under it.
    member_set = set(member_ids)
    talked, helper_sent = {}, {}
    for _, _, sender, receiver, _, _, _ in mail:
        if sender in member_set and receiver in member_set:
            talked[(sender, receiver)] = talked.get((sender, receiver), 0) + 1
        elif sender in helpers and receiver in member_set:
            helper_sent[receiver] = helper_sent.get(receiver, 0) + 1
    continues = [{"from": index[conv]["spawned_from"], "to": conv} for conv in member_ids
                 if isinstance(index.get(conv), dict)
                 and index[conv].get("spawned_via") == "continue"
                 and index[conv].get("spawned_from") in member_set]
    return {
        "frozen_at": at,
        "helper_working": helper_working,
        "swarm": {
            "id": swarm_id, "name": name or f"Swarm {swarm_id}", "named": bool(name),
            "lane": lane, "helper_conv": helper, "summary": summary, "summary_at": summary_at,
            "created_at": created, "counts": counts, "members": members, "closed": False,
            "links": [{"from": a, "to": b, "messages": n} for (a, b), n in sorted(talked.items())],
            "continues": continues,
            "helper_links": [{"to": conv, "messages": n} for conv, n in sorted(helper_sent.items())],
        },
        "messages": [{"id": mid, "at": sent, "from": "helper" if a in helpers else a,
                      "to": "helper" if b in helpers else b,
                      "from_title": title(a), "to_title": title(b),
                      "text": text, "mode": mode, "status": status}
                     for mid, sent, a, b, text, mode, status in mail],
        "sessions": sessions,
    }


def review(demo):
    """Every word of the demo a visitor could read, as one plain text."""
    swarm = demo["swarm"]
    out = [f"# {swarm['name']} — frozen at {demo['frozen_at']}", "", swarm.get("summary") or "", ""]
    for member in swarm["members"]:
        out += [f"- {member['title']} [{member['state']}{', retired' if member['retired'] else ''}]",
                f"  {member.get('summary') or ''}"]
    out += ["", "## Messages between agents", ""]
    for message in demo["messages"]:
        out += [f"{message['at']} {message['from_title']} -> {message['to_title']}", message["text"], ""]
    for conv, session in demo["sessions"].items():
        out += ["", f"## Chat: {session['title']} ({conv})", ""]
        for event in session["events"]:
            kind = event["type"]
            if kind == "user":
                out += [f"[OWNER {event.get('ts')}]", event["text"], ""]
            elif kind == "assistant":
                out += [f"[AGENT {event.get('ts')}]", event["message"]["content"][0]["text"], ""]
            elif kind == "peer":
                out += [f"[AGENT MAIL {event.get('direction')} {event.get('ts')}]", str(event.get("text")), ""]
            elif kind == "questions":
                out += ["[QUESTIONS]", *[f"  ? {q}" for q in event.get("questions") or []], ""]
            elif kind == "reminder":
                out += [f"[SYSTEM {event.get('source')}]", str(event.get("text")), ""]
    return "\n".join(out)


def main(argv=None):
    parser = argparse.ArgumentParser(description="Freeze one swarm at one moment, for the demo.")
    parser.add_argument("swarm", nargs="?", type=int)
    parser.add_argument("--at", help="the moment, local time: 2026-10-02T22:52:20")
    parser.add_argument("--review", action="store_true",
                        help="print every word of the draft instead of making one")
    parser.add_argument("--publish", action="store_true",
                        help="make the draft the demo visitors are served")
    parser.add_argument("--unpublish", action="store_true",
                        help="stop serving the demo (the draft is kept)")
    args = parser.parse_args(argv)
    if os.environ.get("EXOCORTEX_DATA_DIR"):
        store.DATA_DIR = Path(os.environ["EXOCORTEX_DATA_DIR"])
    if args.unpublish:
        served = store.DATA_DIR / f"{DEMO_COLLECTION}.json"
        served.unlink(missing_ok=True)
        print(f"Removed {served}; the demo answers 'not found' once this reaches the server.")
        return
    if args.review or args.publish:
        draft = store.read(DRAFT_COLLECTION, {})
        if not draft:
            raise SystemExit("no draft has been frozen yet")
        if args.review:
            print(review(draft))
            return
        store.write(DEMO_COLLECTION, draft)
        print(f"Published the draft frozen at {draft['frozen_at']} as"
              f" {store.DATA_DIR / (DEMO_COLLECTION + '.json')}.")
        return
    if args.swarm is None or not args.at:
        parser.error("name a swarm and --at a moment")
    demo = freeze(args.swarm, args.at)
    store.write(DRAFT_COLLECTION, demo)
    swarm = demo["swarm"]
    print(f"Froze swarm {swarm['id']} ({swarm['name']}) at {args.at}: {len(swarm['members'])} members,"
          f" {swarm['counts']}, {len(demo['messages'])} messages, {len(demo['sessions'])} chats.")
    print(f"Draft written to {store.DATA_DIR / (DRAFT_COLLECTION + '.json')}."
          " Read it with --review, then --publish.")


if __name__ == "__main__":
    main()
