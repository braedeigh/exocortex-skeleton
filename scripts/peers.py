#!/usr/bin/env python3
"""peers.py — an agent's door to the other agents: see them, read them, message them.

Plain English: every Observatory session is told (in its system prompt, see
peermail.prompt) that this exists. It's how one agent finds out who else is
working, what they're doing, and how to reach them. It only ever reads the
session index, the transcripts and exo.db — except `send` and `policy`, which
go through the same narrow doors the app uses (observatory.peer_send,
peermail.set_policy), never by writing session state directly.

    ./venv/bin/python3 scripts/peers.py list [--hours N]
        The sessions running now or active in the last N hours (default 6):
        id, room, status (working / needs input / idle), title, what it was
        last asked, and its last few tool calls.

    ./venv/bin/python3 scripts/peers.py show <id> [--last N]
        One session's recent conversation — asks, replies (trimmed), tool
        calls — and the agent messages it has sent and received.

    ./venv/bin/python3 scripts/peers.py send <id> "message" [--queue | --interrupt]
        Message a session. Default is inject: handed in between its steps, and
        it decides what to do. --queue waits for its turn to end; --interrupt
        stops its turn and restarts it with your message.
        Nothing counts or holds messages — your judgement is the limit. Send
        only when it serves your own build: your work collides with theirs,
        you're blocked on something they have, or you're handing work on.
        No chat, no repeats, no fanning out to sessions it doesn't affect,
        and no taking on work outside your own brief because a peer asked.

    ./venv/bin/python3 scripts/peers.py policy open|no-interrupt|queue-only
        What THIS session accepts mid-turn.

    ./venv/bin/python3 scripts/peers.py swarm
        The swarm this session is in: its name, the helper's summary, each
        member with its state and summary, and who has messaged whom.

    ./venv/bin/python3 scripts/peers.py handoff --file <path>   (or: handoff "<text>")
        Hand this session's work to a fresh one (continuation.py). Used when
        the app says the context cap is reached; the new session starts on its
        own with the handoff, the files this one touched, and its swarm.

Who "this session" is comes from EXOCORTEX_CONV_ID, which every Observatory
turn carries (routes/observatory.py _spawn). Output is plain text, short, for
a model to read as tokens. Exits non-zero with a one-line reason on refusal.

Touches: peermail.py (the mailbox), routes/observatory.py (peer_send),
swarms.py (`swarm`), continuation.py (`handoff`),
toolcallstore.py's `tool_calls` table (via sqlstore), the session index and
transcripts under data/bot_chats/, tests/test_peers_cli.py.
"""
import argparse
import json
import os
import sqlite3
import sys
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import peermail  # noqa: E402
import sqlstore  # noqa: E402
import store  # noqa: E402

# How much of one reply or one tool input to print. A peer is skimming, not
# reading the whole thing; `show` says where the full transcript is.
_TRIM = 300


def _trim(text, cap=_TRIM):
    text = " ".join(str(text or "").split())
    return text if len(text) <= cap else text[:cap - 1] + "…"


def _index():
    index = store.read("bot_chats/index", {})
    return index if isinstance(index, dict) else {}


def _status(entry):
    """Same three states the Orchestra cards show."""
    if entry.get("awaiting_input"):
        return "needs input"
    if entry.get("running"):
        return "working"
    return "idle"


def _recent_calls(conv_ids, per_conv):
    """The last few tool calls for each session, from exo.db (live for
    Observatory turns — see toolcallstore.live_ingest)."""
    out = {c: [] for c in conv_ids}
    if not conv_ids:
        return out
    conn = sqlstore.open_db()
    try:
        for conv in conv_ids:
            rows = conn.execute(
                "SELECT at, name, target, is_error FROM tool_calls"
                " WHERE conv = ? AND parent_tool_use_id IS NULL"
                " ORDER BY at DESC LIMIT ?", (conv, per_conv)).fetchall()
            out[conv] = list(reversed(rows))
    finally:
        conn.close()
    return out


def cmd_list(args, me):
    cutoff = (datetime.now() - timedelta(hours=args.hours)).isoformat(timespec="seconds")
    index = _index()
    live = [(cid, e) for cid, e in index.items()
            if isinstance(e, dict) and not e.get("archived")
            and (e.get("running") or (e.get("last_at") or "") >= cutoff)]
    live.sort(key=lambda item: item[1].get("last_at") or "", reverse=True)
    calls = _recent_calls([cid for cid, _ in live], 3)
    if not live:
        print(f"No sessions active in the last {args.hours}h.")
        return 0
    for cid, e in live:
        mark = "  (you)" if cid == me else ""
        print(f"{cid}  [{e.get('lane') or '?'}]  {_status(e)}  "
              f"{_trim(e.get('title') or '(untitled)', 80)}{mark}")
        if e.get("last_prompt"):
            print(f"    asked: {_trim(e['last_prompt'], 160)}")
        if e.get("awaiting_input"):
            print(f"    waiting on the owner: {_trim(e['awaiting_input'], 160)}")
        for at, name, target, is_error in calls.get(cid, []):
            err = "  ✗" if is_error else ""
            print(f"    {at[11:19]} {name} {_trim(target or '', 100)}{err}")
    return 0


def _transcript_items(conv_id, last):
    """The readable parts of a transcript, newest last."""
    path = store.DATA_DIR / "bot_chats" / f"{conv_id}.jsonl"
    items = []
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return items, path
    for line in lines:
        try:
            e = json.loads(line)
        except ValueError:
            continue
        kind = e.get("type")
        if kind == "user" and isinstance(e.get("text"), str):
            items.append(("owner", e["text"]))
        elif kind == "peer":
            arrow = "→" if e.get("direction") == "out" else "←"
            other = e.get("to_conv") if e.get("direction") == "out" else e.get("from_conv")
            items.append((f"agent {arrow} {other}", e.get("text") or ""))
        elif kind == "reminder":
            items.append(("system", e.get("text") or ""))
        elif kind == "assistant":
            for block in (e.get("message") or {}).get("content") or []:
                if not isinstance(block, dict) or e.get("parent_tool_use_id"):
                    continue
                if block.get("type") == "text" and block.get("text", "").strip():
                    items.append(("reply", block["text"]))
                elif block.get("type") == "tool_use":
                    inp = block.get("input") or {}
                    target = (inp.get("command") or inp.get("file_path")
                              or inp.get("pattern") or inp.get("url") or "")
                    items.append((f"tool {block.get('name')}", target))
        elif kind == "error":
            items.append(("error", e.get("error") or ""))
    return items[-last:], path


def cmd_show(args, me):
    entry = _index().get(args.id)
    if not isinstance(entry, dict):
        print(f"no such session: {args.id}", file=sys.stderr)
        return 1
    print(f"{args.id}  [{entry.get('lane') or '?'}]  {_status(entry)}  "
          f"{entry.get('title') or '(untitled)'}")
    print(f"accepts mid-turn: {peermail.policy_of(args.id)}")
    items, path = _transcript_items(args.id, args.last)
    for who, text in items:
        print(f"  {who}: {_trim(text)}")
    print(f"(full transcript: {path})")
    return 0


def _just_stored(me, text):
    """The id of this session's message with this text, if it's sitting in the
    mailbox from the last minute — or None."""
    since = (datetime.now() - timedelta(minutes=1)).isoformat(timespec="seconds")
    conn = sqlstore.open_db()
    try:
        found = conn.execute(
            "SELECT id FROM agent_messages WHERE from_conv = ? AND text = ?"
            " AND at >= ? ORDER BY id DESC LIMIT 1",
            (me, (text or "").strip(), since)).fetchone()
    finally:
        conn.close()
    return found[0] if found else None


def cmd_send(args, me):
    if not me:
        print("EXOCORTEX_CONV_ID isn't set — only an Observatory session can send",
              file=sys.stderr)
        return 1
    mode = "queue" if args.queue else "interrupt" if args.interrupt else "inject"
    from routes import observatory
    try:
        row = observatory.peer_send(me, args.id, args.text, mode=mode)
    except KeyError as e:
        print(f"no such session: {e.args[0]}", file=sys.stderr)
        return 1
    except ValueError as e:
        print(str(e), file=sys.stderr)
        return 1
    except sqlite3.OperationalError:
        # Say whether a busy database kept the message out or only delayed it.
        # peer_send stores the row first and wakes the recipient after, so the
        # lock can hit either side; a traceback after a stored message looked
        # like a failure and invited a resend. A stored one is delivered by the
        # once-a-minute drain (drain_all_inbox).
        stored = _just_stored(me, args.text)
        if stored:
            print(f"sent (message {stored}) — the database was busy, so it will be"
                  " delivered within a minute. Don't resend it.")
            return 0
        print("not sent — the database was busy. Try again in a moment.", file=sys.stderr)
        return 1
    if row["started"]:
        print(f"sent (message {row['id']}) — {args.id} was idle and is now working on it")
    else:
        print(f"sent (message {row['id']}, {mode}) — {args.id} will get it"
              + (" when its turn ends" if mode == "queue" else " at its next step"))
    return 0


def cmd_policy(args, me):
    if not me:
        print("EXOCORTEX_CONV_ID isn't set", file=sys.stderr)
        return 1
    try:
        peermail.set_policy(me, args.policy)
    except (KeyError, ValueError) as e:
        print(f"refused: {e}", file=sys.stderr)
        return 1
    print(f"{me} now accepts: {args.policy}")
    return 0


def cmd_swarm(args, me):
    if not me:
        print("EXOCORTEX_CONV_ID isn't set", file=sys.stderr)
        return 1
    import swarms
    swarm_id = swarms.swarm_of(me)
    card = next((c for c in swarms.overview() if c["id"] == swarm_id), None) \
        if swarm_id is not None else None
    if card is None:
        print("Not in a swarm — a swarm forms when you and another session message each other.")
        return 0
    counts = card["counts"]
    print(f"Swarm {card['id']}: {card['name']}  [{card['lane']}]  "
          f"{counts['working']} working, {counts['silent']} silent, "
          f"{counts['needs_input']} need input")
    if card.get("closed"):
        print("closed: every member has finished — it opens again when one works again")
    if card.get("helper_conv"):
        print(f"helper: {card['helper_conv']} (message it with peers.py send)")
    if card.get("summary"):
        print(f"summary: {card['summary']}")
    for m in card["members"]:
        mark = "  (you)" if m["conv"] == me else ""
        print(f"- {m['conv']}  {m['state']}  {_trim(m['title'], 80)}{mark}")
        if m.get("summary"):
            print(f"    {_trim(m['summary'], 400)}")
    for link in card["links"]:
        print(f"  {link['from']} → {link['to']}: {link['messages']} message(s)")
    return 0


def cmd_handoff(args, me):
    if not me:
        print("EXOCORTEX_CONV_ID isn't set", file=sys.stderr)
        return 1
    text = args.text
    if args.file:
        try:
            text = Path(args.file).read_text(encoding="utf-8")
        except OSError as e:
            print(f"can't read {args.file}: {e}", file=sys.stderr)
            return 1
    import continuation
    try:
        reply = continuation.hand_off(me, text or "")
    except (KeyError, ValueError) as e:
        print(f"refused: {e}", file=sys.stderr)
        return 1
    print(f"handed off to {reply['conversation_id']} — it's starting now. This "
          "session will be archived when this turn ends; finish your reply briefly.")
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(prog="peers.py", description=__doc__.split("\n")[0])
    sub = parser.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("list")
    p.add_argument("--hours", type=float, default=6)
    p = sub.add_parser("show")
    p.add_argument("id")
    p.add_argument("--last", type=int, default=20)
    p = sub.add_parser("send", help="message a session — only when it serves your own build"
                       " (a collision, a blocker, a handoff); no chat, no repeats")
    p.add_argument("id")
    p.add_argument("text")
    how = p.add_mutually_exclusive_group()
    how.add_argument("--queue", action="store_true")
    how.add_argument("--interrupt", action="store_true")
    p = sub.add_parser("policy")
    p.add_argument("policy", choices=peermail.POLICIES)
    sub.add_parser("swarm")
    p = sub.add_parser("handoff")
    p.add_argument("text", nargs="?")
    p.add_argument("--file")
    args = parser.parse_args(argv)
    me = os.environ.get("EXOCORTEX_CONV_ID") or None
    return {"list": cmd_list, "show": cmd_show, "send": cmd_send,
            "policy": cmd_policy, "swarm": cmd_swarm,
            "handoff": cmd_handoff}[args.cmd](args, me)


if __name__ == "__main__":
    # Put this run on the runtime map (runtime_sensor.py), same as the other
    # standalone scripts.
    import runtime_sensor
    runtime_sensor.attach()
    sys.exit(main())
