"""Message summaries — one plain line for every message an agent sends another,
and one for the thread it belongs to.

**What this is, in plain English.** Agents message each other through the
mailbox (peermail.py). Those messages are written agent-to-agent and run long,
so they are hard to read cold. Every time one is sent, this file makes one
short model call, in a process of its own, that reads the message with a
little context and writes two things:

  - the message's GIST: one line saying what it asked, told or settled;
  - the THREAD's summary: one line saying what these two sessions are
    coordinating on and where that stands, rewritten on every message.

A thread is the line between two sessions — every message either one has sent
the other. That is the line the owner clicks in the swarm drawing
(SwarmNetwork.tsx); the sheet it opens shows the thread's line on top and each
message's gist above its text (routes/swarms.py `line_messages`).

What the call reads: the new message, the last few messages of the thread
with the gists already written for them, the thread's current summary, and
each session's own summary (written by the helpers — swarm_helper.py,
room_helper.py). It does NOT read the sessions' transcripts, so it can say
what a message asked for and what a reply settled, but not what the receiver
went on to do; when nothing answers a message, it is told to say so.

A message is left alone when it isn't on a line she can click: one to a
helper session, or one sent by a room or Linear helper.

When it runs: straight after a message is stored (routes/observatory.py
`peer_send` calls `spawn`), and from the minute tick for any recent message
that still has no row — a call that never started (`tick`). A call that ran
and failed leaves a row with its error and is not tried again by itself;
`python3 message_summaries.py run <message id>` tries it again by hand.

Touches: swarm_helper.py (`ask_model`, the shared model call; `tidy_summary`),
swarms.py (which sessions are helpers), sqlstore.py (rung 53:
`message_summaries`, `message_thread_summaries`; reads `agent_messages`,
`swarm_members`, `session_summaries`), routes/observatory.py and
scripts/coming_up_dispatcher.py (the callers), routes/swarms.py (the reader),
tests/test_message_summaries.py. Design: docs/swarms.md.

Prompt that produced this: "I'm wanting for messages between bots to have some
kind of outside context about what they're messaging about between steps ...
I click on the message thread and I get some very short summary of what the
message accomplished and what they're coordinating on between messages" —
and, on when it is written: "i want context between every message."
"""
import os
import sqlite3
import subprocess
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path

import sqlstore
import store
import swarms

PROMPT = """You write short notes on messages that AI coding agents send each other while \
working on one person's app. She reads your notes instead of the messages, which are long and \
written agent-to-agent. You are given one thread (everything two sessions have sent each \
other), what each session is doing, and the NEW message. Write:
- gist: ONE plain sentence, under 25 words, saying what the new message did: what it asked \
for, what it told the other, or what it settled. Start with the sender's short name (a \
session titled "spin: x" is called "x", never "spin"). When it answers an earlier message, \
say what that settled.
- thread: ONE or two plain sentences, under 40 words, saying what these two sessions are \
coordinating on and where it stands now: settled, waiting on a reply (say from whom), or \
still open.
Say only what the messages show. You cannot see what either session did afterwards: never \
say something was done unless a message says so, and when the new message has had no answer, \
say it is waiting on one. No commit hashes, no file lists, no bullets, no bold. Plain words; \
the owner reads these."""

SCHEMA = {
    "type": "object",
    "properties": {"gist": {"type": "string"}, "thread": {"type": "string"}},
    "required": ["gist", "thread"],
}

# How long each may be: (how many lines, how many characters) — held by
# swarm_helper.tidy_summary, like every other summary.
GIST_SHAPE = (1, 220)
THREAD_SHAPE = (2, 340)

# How much of a thread one call reads: the last few messages before the new
# one, each cut short. Older ones are carried by the thread's summary.
_EARLIER_SHOWN = 8
_EARLIER_CHARS = 700

# The minute tick's reach: a message this recent with no row gets a call, at
# most this many a minute. The wait gives the call started at send its chance.
_TICK_HOURS = 6
_TICK_WAIT_SEC = 180
_TICK_MOST = 4

# How long a finished call keeps trying to write its answer to a busy database.
_WRITE_TRIES = 6
_WRITE_WAIT_SEC = 5


def _now():
    return datetime.now().isoformat(timespec="seconds")


def pair(a, b):
    """The key of the thread between two sessions: the two ids in order."""
    return tuple(sorted((a or "", b or "")))


def wanted(row, index):
    """Does this message get a summary? Only an agent's message that sits on
    a line she can click: not one to a helper session, and not one sent by a
    room or Linear helper (a swarm helper's messages out are its blue lines)."""
    if row["kind"] != "A" or row["status"] == "cancelled" or not row["from_conv"]:
        return False
    if swarms.is_helper_session(row["to_conv"], index):
        return False
    return swarms.helper_role(row["from_conv"], index) in (None, "swarm_helper")


def _message(conn, message_id):
    values = conn.execute(
        "SELECT id, at, kind, from_conv, to_conv, text, status FROM agent_messages"
        " WHERE id = ?", (message_id,)).fetchone()
    return dict(zip(("id", "at", "kind", "from_conv", "to_conv", "text", "status"),
                    values)) if values else None


def _session_summary(conn, conv):
    """What the helpers last wrote about one session, or None."""
    for sql in ("SELECT summary FROM swarm_members WHERE conv = ? AND summary IS NOT NULL"
                " ORDER BY summary_at DESC LIMIT 1",
                "SELECT summary FROM session_summaries WHERE conv = ?"):
        found = conn.execute(sql, (conv,)).fetchone()
        if found and found[0]:
            return found[0]
    return None


def gather(row, index):
    """Everything one call is handed, as one document."""
    import swarm_helper
    a, b = pair(row["from_conv"], row["to_conv"])

    def name(conv):
        entry = index.get(conv) if isinstance(index.get(conv), dict) else {}
        return f"{entry.get('title') or conv} ({conv})"

    conn = sqlstore.open_db()
    try:
        current = conn.execute(
            "SELECT summary FROM message_thread_summaries WHERE conv_a = ? AND conv_b = ?",
            (a, b)).fetchone()
        earlier = conn.execute(
            "SELECT m.at, m.from_conv, m.text, s.gist FROM agent_messages m"
            " LEFT JOIN message_summaries s ON s.message_id = m.id"
            " WHERE m.kind = 'A' AND m.status != 'cancelled' AND m.id < ?"
            " AND ((m.from_conv = ? AND m.to_conv = ?) OR (m.from_conv = ? AND m.to_conv = ?))"
            " ORDER BY m.id DESC LIMIT ?", (row["id"], a, b, b, a, _EARLIER_SHOWN)).fetchall()
        out = ["# A thread between two sessions", ""]
        for conv in (a, b):
            out += [f"## {name(conv)}", "",
                    _session_summary(conn, conv) or "(no summary of this session yet)", ""]
    finally:
        conn.close()
    out += ["## The thread's current summary", "",
            (current[0] if current and current[0] else "(none yet — this is its first message)"),
            "", "## Earlier messages, oldest first", ""]
    for at, sender, text, gist in reversed(earlier):
        out.append(f"- {at} from {name(sender)}: {swarm_helper._trim(text, _EARLIER_CHARS)}")
        if gist:
            out.append(f"  (your note on it: {gist})")
    if not earlier:
        out.append("(none)")
    out += ["", f"## The NEW message — {row['at']}, from {name(row['from_conv'])}"
            f" to {name(row['to_conv'])}", "", row["text"], ""]
    return "\n".join(out)


def _call(text):
    """The model call: one message's gist and its thread's summary."""
    import swarm_helper
    return swarm_helper.ask_model(text, PROMPT, SCHEMA)


def _store(message_id, now, gist, cost, error, key, thread):
    """Write one message's row and, when there is one, its thread's summary."""
    a, b = key
    conn = sqlstore.open_db()
    try:
        sqlstore.begin_immediate(conn)
        try:
            conn.execute(
                "INSERT OR REPLACE INTO message_summaries (message_id, at, gist, cost_usd,"
                " error) VALUES (?, ?, ?, ?, ?)", (message_id, now, gist, cost, error))
            # Keep the thread's summary only when it is the newest account:
            # two calls for one thread can finish out of order, and the one
            # that read the later message wins.
            if thread:
                conn.execute(
                    "INSERT INTO message_thread_summaries (conv_a, conv_b, summary,"
                    " summary_at, through_id) VALUES (?, ?, ?, ?, ?)"
                    " ON CONFLICT (conv_a, conv_b) DO UPDATE SET summary = excluded.summary,"
                    " summary_at = excluded.summary_at, through_id = excluded.through_id"
                    " WHERE excluded.through_id > message_thread_summaries.through_id",
                    (a, b, thread, now, message_id))
            conn.execute("COMMIT")
        except BaseException:
            conn.execute("ROLLBACK")
            raise
    finally:
        conn.close()


def summarise(message_id):
    """Write one message's gist and refresh its thread's summary. Returns the
    gist, or None when the message gets none (not wanted, already written, or
    the call failed — the failure is kept on its row)."""
    import swarm_helper
    index = store.read("bot_chats/index", {})
    index = index if isinstance(index, dict) else {}
    conn = sqlstore.open_db()
    try:
        row = _message(conn, message_id)
        done = conn.execute("SELECT gist FROM message_summaries WHERE message_id = ?",
                            (message_id,)).fetchone()
    finally:
        conn.close()
    if row is None or not wanted(row, index) or (done and done[0]):
        return None
    gist = thread = error = cost = None
    try:
        answer, cost = _call(gather(row, index))
        gist = swarm_helper.tidy_summary(answer.get("gist"), GIST_SHAPE) or None
        thread = swarm_helper.tidy_summary(answer.get("thread"), THREAD_SHAPE) or None
        if not gist:
            error = "the model wrote nothing"
    except (RuntimeError, OSError, ValueError, subprocess.SubprocessError) as e:
        error = str(e)
    now = _now()
    # Write both down, waiting out a busy database. The answer is already
    # paid for: giving up on "database is locked" would throw it away and
    # have the minute tick buy it again.
    for attempt in range(_WRITE_TRIES):
        try:
            _store(message_id, now, gist, cost, error, pair(row["from_conv"], row["to_conv"]),
                   thread)
            break
        except sqlite3.OperationalError:
            if attempt == _WRITE_TRIES - 1:
                raise
            time.sleep(_WRITE_WAIT_SEC)
    return gist


# --- When it runs -----------------------------------------------------------------

def _detach(message_id):
    """Start `python3 message_summaries.py run <id>` as a process of its own,
    so sending never waits on the model. What it prints goes to one log."""
    log = store.DATA_DIR / "bot_chats" / ".turns" / "message-summaries.log"
    log.parent.mkdir(parents=True, exist_ok=True)
    env = {**os.environ, "EXOCORTEX_DATA_DIR": str(store.DATA_DIR),
           "EXOCORTEX_CONTENT_DIR": str(store.CONTENT_DIR)}
    # The call is the app's, not the sending agent's: without this the model
    # process would count as that agent's session.
    env.pop("EXOCORTEX_CONV_ID", None)
    with open(log, "ab") as errf:
        subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "run", str(message_id)],
                         stdin=subprocess.DEVNULL, stdout=errf, stderr=errf,
                         start_new_session=True, env=env)


def spawn(row):
    """Start the summary of a message just stored, if it gets one. Returns
    whether a call was started."""
    index = store.read("bot_chats/index", {})
    if not wanted(row, index if isinstance(index, dict) else {}):
        return False
    _detach(row["id"])
    return True


def tick():
    """The minute safety net: start the call for any recent message that
    still has no row — its call at send never started, or died before it
    wrote anything. Returns how many were started."""
    now = datetime.now()
    since = (now - timedelta(hours=_TICK_HOURS)).isoformat(timespec="seconds")
    until = (now - timedelta(seconds=_TICK_WAIT_SEC)).isoformat(timespec="seconds")
    conn = sqlstore.open_db()
    try:
        rows = [dict(zip(("id", "at", "kind", "from_conv", "to_conv", "text", "status"), v))
                for v in conn.execute(
                    "SELECT m.id, m.at, m.kind, m.from_conv, m.to_conv, m.text, m.status"
                    " FROM agent_messages m"
                    " LEFT JOIN message_summaries s ON s.message_id = m.id"
                    " WHERE m.kind = 'A' AND m.status != 'cancelled' AND s.message_id IS NULL"
                    " AND m.at >= ? AND m.at <= ? ORDER BY m.id", (since, until))]
    finally:
        conn.close()
    index = store.read("bot_chats/index", {})
    index = index if isinstance(index, dict) else {}
    started = 0
    for row in rows:
        if started >= _TICK_MOST:
            break
        if wanted(row, index):
            _detach(row["id"])
            started += 1
    return started


# --- Reading them back ------------------------------------------------------------

def gists(message_ids):
    """The gists written for these messages, as {message id: gist}."""
    ids = list(message_ids)
    if not ids:
        return {}
    conn = sqlstore.open_db()
    try:
        return dict(conn.execute(
            f"SELECT message_id, gist FROM message_summaries WHERE gist IS NOT NULL"
            f" AND message_id IN ({','.join('?' * len(ids))})", ids))
    finally:
        conn.close()


def thread_summary(pairs):
    """The summary of the thread these pairs of sessions make up, as
    {"summary", "at"} — or None when none is written. One line of the drawing
    can stand for several pairs (a ring carrying a retired session's
    messages); the most recently written of their summaries is the one given."""
    keys = sorted({pair(a, b) for a, b in pairs})
    if not keys:
        return None
    conn = sqlstore.open_db()
    try:
        found = conn.execute(
            "SELECT summary, summary_at FROM message_thread_summaries WHERE summary IS NOT NULL"
            f" AND ({' OR '.join(['(conv_a = ? AND conv_b = ?)'] * len(keys))})"
            " ORDER BY through_id DESC LIMIT 1", [conv for key in keys for conv in key]).fetchone()
    finally:
        conn.close()
    return {"summary": found[0], "at": found[1]} if found else None


def main(argv):
    if len(argv) == 2 and argv[0] == "run" and argv[1].isdigit():
        print(f"{_now()} message {argv[1]}: {summarise(int(argv[1])) or '(nothing written)'}")
        return 0
    print("usage: message_summaries.py run <message id>", file=sys.stderr)
    return 2


if __name__ == "__main__":
    # Put this run on the runtime map (runtime_sensor.py), same as the other
    # standalone scripts.
    import runtime_sensor
    runtime_sensor.attach()
    sys.exit(main(sys.argv[1:]))
