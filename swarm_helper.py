"""The swarm helper — one Sonnet per swarm that keeps track of what everyone in
it is doing, names the swarm, and coordinates.

**What this is, in plain English.** When sessions start messaging each other
they form a swarm (swarms.py). Each swarm gets a helper: an Observatory
session of its own (so it has a card, a chat, and a mailbox other agents and
the owner can write to), whose work is done by short, separate calls to the
model — never one long conversation. One run makes several calls, side by
side (side_by_side):

  - ONE CALL PER MEMBER that has done something since its summary was written
    (summarise_sessions). It reads that member's current summary and what's
    new — the owner's asks, the agent's replies, its tool calls — and writes
    the member's new summary. A member with nothing new gets no call and
    keeps its summary. The room helper (room_helper.py) summarises the
    sessions working alone the same way, with the same function.
  - ONE CALL FOR THE SWARM. It reads the swarm's current summary, every
    member's current summary and what's new (members that finished over
    config.SWARM_HELPER_FORGET_HOURS ago are left out), the messages between
    members, and any questions waiting in the helper's mailbox. It hands
    back a new name (if it has a better one), a new swarm summary, where
    members' work differs or collides, and any messages to send — to
    members, or answers to whoever asked.

The new summaries REPLACE the old ones, so the next run reads only those plus
what's new: the helper's context never grows, however long the swarm runs.

Every summary is a few short LABELLED LINES, never a paragraph: a session's is
"Now:", "Done:" and "Waiting on:"; the swarm's is "Goal:", "Where it stands:",
"Next:" and "Waiting on:". The prompts ask for that, and the code holds them
to it (tidy_summary): more lines than that, or a line longer than its cap, is
cut off before it is stored, so a summary can't grow run after run.
`python3 swarm_helper.py reshape <id>` rewrites a swarm's summaries into that
shape without waiting for its sessions to do something new.

Every run is written down in full (`swarm_helper_runs`: its exact input and
output, cost, error) and into the helper's own chat, so the owner can see what
information it used and what it did with it.

Its chat is one conversation for the swarm's whole life. When the owner
talks to it there, each turn starts fresh from a rolling seed (a doc, her
last 15 messages with its replies, and each member's summary and files —
helper_chat.py), so it never fills its context and is never continued.

When the swarm closes — fewer than two of its members still working
(swarms.retired) — the helper writes a CLOSING SUMMARY: one more model call,
in a process of its own, that says in plain words what the swarm set out to
do, what each line of work completed and what is left. It is posted in the
helper's chat above the closing check — the facts read from git and the
session records: what shipped, what's uncommitted or unfinished, questions
and detached jobs still waiting. Both are kept (`swarm_closings`, one row per
time the swarm closed) and handed back to the helper on every later turn, so
it can answer her questions about what happened; the room's helper gets one
line saying the swarm closed. Then the helper marks itself done (close_out).

When it runs: when a member's turn ends (at most once every
config.SWARM_HELPER_MIN_SEC per swarm — anything sooner waits for the minute
tick), when the swarm forms, and straight away when someone messages it.
Each run is its own detached process (`python3 swarm_helper.py run <id>`),
so nothing waits on the model.

Touches: swarms.py (membership and the tables), peermail.py (its mailbox;
agent messages it sends go through routes/observatory.peer_send), the session
index (the helper's own entry — `role: "swarm_helper"`), config.py (model,
pacing, HELPER_SUMMARY_PARALLEL), scripts/coming_up_dispatcher.py (the minute
tick), sqlstore.py (swarm_helper_runs, swarm_closings), helper_chat.py (its
chat's rolling context, which carries the closing summaries), room_helper.py
(shares ask_model, side_by_side and summarise_sessions; its chat gets the
line saying a swarm closed), routes/swarms.py (the swarm's page shows the
closing summaries), tests/test_swarm_helper.py, tests/test_helper_chat.py.
Design: docs/swarms.md.

Prompt that produced this: "i want the helper to name the session and
understand what all of them are doing and synthesize it automatically as it
coordinates differences ... which may be done per turn and then drop the
other summary out of the context window ... one helper per swarm. i want to
be able to click into it and see what information is being used by it." —
and, for the summaries: "If these aren't written by parallel individual
sonnet sessions, make these parallel and individual." — and, for the closing
summary: "when a swarm retires, i want a summary of what was done to be
written by that swarm's helper, which will then be put in the chat and noted
... so i can know what was completed and ask it questions about what
happened." — and, for the labelled lines: "Make the helper summaries more
separated and succinct ... In swarms. They're too long. Labeled lines."
"""
import json
import os
import re
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

import config
import peermail
import sqlstore
import store
import swarms

ROLE = "swarm_helper"

# What a helper's chat turn may use: reading and searching, Bash for the
# lookups its seed points it at (peers.py show, exo_query.py, git, grep over
# the transcripts), WebFetch and WebSearch to read and research the web, and
# Write for one thing only — the brief of a session it starts to build
# something. This list only pre-approves; what actually holds a helper to
# lookups is tools/helper_gate.py. Shared with the room helper
# (room_helper.py); every helper's turn runs with it, whatever its stored
# list says (routes/observatory.py _conv_config).
HELPER_TOOLS = ["Read", "Grep", "Glob", "Bash", "Write", "WebFetch", "WebSearch"]

# How much of each member's new activity one run reads. The helper needs the
# shape of the work, not every line; the full transcripts are always a
# `peers.py show` away for the members themselves.
_MEMBER_CHARS = 4000
_ITEM_CHARS = 400

SYSTEM_PROMPT = """You are the helper for a swarm of AI coding agents working on one person's \
app. The agents became a swarm by messaging each other. Your job:
1. Name the swarm: 2-5 plain words for the shared project (keep the current name unless it's wrong).
2. Summarise the swarm as at most four short lines, each starting with its label and holding \
one or two plain sentences, under 40 words:
Goal: what the swarm is building together.
Where it stands: what is finished and what is in progress, at a glance.
Next: what happens next.
Waiting on: what is needed from the owner, or from outside. Leave this line out when nothing is.
No other lines, no bullets, no bold, no lists of every issue or commit. Anything longer is cut off.
3. Coordinate: notice where members' work overlaps, conflicts (two editing the same file, \
contradictory decisions) or depends on each other. Only when it changes a member's work, send \
a short message to the member who needs to know. Never more than one message per member per run. \
Check "Messages between members" first: if you (or anyone) already told a member this, don't \
send it again — a reworded repeat is still a repeat. Don't message members the news doesn't \
affect, don't chat, and never hand a member work outside its own brief.
4. Answer any questions in your mailbox, addressed back to whoever asked (an agent's session id, \
or "owner").
You only see summaries and what's new since them. Each member's own summary is written by a \
separate call, not by you. Your swarm summary replaces the old one: keep only what someone \
glancing at the swarm needs today, and drop the rest — each member's detail is in its own \
summary, and the history is in the transcripts. Plain words; the owner reads these."""

SCHEMA = {
    "type": "object",
    "properties": {
        "name": {"type": "string"},
        "summary": {"type": "string"},
        "differences": {"type": "array", "items": {"type": "string"}},
        "messages": {"type": "array", "items": {
            "type": "object",
            "properties": {"to": {"type": "string"}, "text": {"type": "string"}},
            "required": ["to", "text"]}},
    },
    "required": ["name", "summary", "messages"],
}

# One session's summary, written by a call of its own (summarise_sessions).
SESSION_PROMPT = """You keep the summary of ONE AI coding agent's session, working on one \
person's app. You get its current summary and what it has done since that was written: the \
owner's asks, the agent's replies, its tool calls. Write its new summary as at most three short \
lines, each starting with its label and holding ONE plain sentence, under 25 words:
Now: what it is doing right now, or where it stopped.
Done: the most important thing it has finished.
Waiting on: what it needs, and from whom (the owner, another session). Leave this line out \
when it waits on nothing.
Leave out any line with nothing to say. No other lines, no bullets, no bold. Your summary \
REPLACES the old one: keep only what someone glancing at it needs today and drop the rest — \
commit hashes, counts, the rules it follows and the story of how it got here stay in its \
transcript. Say only what the activity shows. Anything longer is cut off. Plain words; the \
owner reads these."""

SESSION_SCHEMA = {
    "type": "object",
    "properties": {"summary": {"type": "string"}},
    "required": ["summary"],
}


# The closing summary, written once when the swarm closes (close_out).
CLOSING_PROMPT = """You are the helper for a swarm of AI coding agents that worked on one \
person's app. The swarm has just closed: fewer than two of its sessions are still working. \
Write its closing summary for the owner, so she knows what was completed and can ask you about \
it later.
You are given the swarm's last summary, every member with its own summary and the end of what \
it did and said, the messages between members, and the CLOSING CHECK: facts the app read from \
git and the session records. Write:
- headline: ONE plain sentence, under 30 words, saying what the swarm got done.
- summary: what the swarm set out to do; then what each line of work completed; then what is \
left: unfinished, uncommitted, untried, or waiting on her. A few short paragraphs, or short \
lines starting with "- ". No headings and no tables.
The closing check is the truth about what shipped. Say something shipped or was committed only \
when a commit in the closing check shows it, and name that commit. When an agent says it did \
something the check doesn't show, say exactly that ("it says it did X, but no commit shows \
it"). Where what you were given doesn't tell you, say you don't know; never guess. Plain \
words; the owner reads this."""

CLOSING_SCHEMA = {
    "type": "object",
    "properties": {"headline": {"type": "string"}, "summary": {"type": "string"}},
    "required": ["headline", "summary"],
}

# How many closing summaries the helper is handed back; a swarm that has
# closed more often than this keeps the rest in the table.
_CLOSINGS_SHOWN = 5
# How many of the messages between members the closing summary's call reads.
_CLOSING_MESSAGES = 80


# How long a summary may be: (how many lines, how many characters each). A
# session's is three labelled lines, the swarm's four (the prompts above).
SESSION_SHAPE = (3, 220)
SWARM_SHAPE = (4, 340)


def _now():
    return datetime.now().isoformat(timespec="seconds")


def _trim(text, cap=_ITEM_CHARS):
    text = " ".join(str(text or "").split())
    return text if len(text) <= cap else text[:cap - 1] + "…"


def tidy_summary(text, shape):
    """Hold a summary to its shape before it is stored: short lines, a fixed
    number of them. Blank lines, bullet marks and bold marks are taken out,
    each line is cut at its cap, and lines past the last allowed one are
    dropped. This is what stops a summary growing run after run — the prompt
    asks for the shape, and this enforces it. Shared with room_helper.py
    through summarise_sessions."""
    max_lines, line_chars = shape
    lines = []
    for raw in str(text or "").splitlines():
        line = " ".join(raw.replace("**", "").split()).lstrip("-*• ").strip()
        if line:
            lines.append(_trim(line, line_chars))
    return "\n".join(lines[:max_lines])


def _as_bullets(summary):
    """A summary's labelled lines as a markdown list with the labels in bold,
    for the helper's chat."""
    out = []
    for line in str(summary or "").splitlines():
        label, colon, rest = line.partition(": ")
        out.append(f"- **{label}:** {rest}" if colon and len(label) <= 20 else f"- {line}")
    return out


# --- The helper's own session ---------------------------------------------------

def ensure_helper(swarm_id):
    """The helper's Observatory session for this swarm, made on first need."""
    from routes import observatory
    conn = sqlstore.open_db()
    try:
        row = conn.execute("SELECT helper_conv, name, lane FROM swarms WHERE id = ?",
                           (swarm_id,)).fetchone()
    finally:
        conn.close()
    if row is None:
        raise KeyError(swarm_id)
    helper, name, lane = row
    index = store.read("bot_chats/index", {})
    if helper and helper in index:
        # Give helpers made before HELPER_TOOLS the tools their seed tells
        # them to search with — they were made with Read alone.
        if isinstance(index[helper], dict) and index[helper].get("allowed_tools") != HELPER_TOOLS:
            with store.mutate("bot_chats/index", {}) as index:
                if isinstance(index.get(helper), dict):
                    index[helper]["allowed_tools"] = list(HELPER_TOOLS)
        # Undo a handoff. The helper's chat is one conversation for its
        # swarm's whole life (helper_chat.py), but before that it could be
        # continued like any Coding session — archived, with its mail and
        # reminders forwarded to a successor. Bring it back as the one chat.
        if isinstance(index[helper], dict) and index[helper].get("continued_by"):
            with store.mutate("bot_chats/index", {}) as index:
                entry = index.get(helper)
                if isinstance(entry, dict):
                    for field in ("continued_by", "continuation", "archive_after_turn",
                                  "archived"):
                        entry.pop(field, None)
        return helper
    with store.mutate("bot_chats/index", {}) as index:
        helper = observatory._new_conv_id(index)
        index[helper] = {
            "bot": "helper", "role": ROLE, "swarm_id": swarm_id,
            "title": f"Swarm helper · {name or f'swarm {swarm_id}'}",
            "started": _now(), "last_at": _now(), "claude_session_id": None,
            "cost_usd": 0.0, "journal": False, "lane": lane or "coding",
            "cwd": str(store.BUILD_DIR), "allowed_tools": list(HELPER_TOOLS),
        }
    conn = sqlstore.open_db()
    try:
        sqlstore.begin_immediate(conn)
        conn.execute("UPDATE swarms SET helper_conv = ? WHERE id = ?", (helper, swarm_id))
        conn.execute("COMMIT")
    finally:
        conn.close()
    return helper


def is_helper(entry):
    return isinstance(entry, dict) and entry.get("role") == ROLE


# --- What one run reads -----------------------------------------------------------

def _line_stamp(line):
    """When a transcript line was written, as local time to the second.
    The app's own lines carry `ts`, already local. The model's lines carry
    `timestamp` in UTC with a trailing Z, which is turned into local time —
    compared as written, every reply of the last few hours would look newer
    than a summary stamped in local time."""
    if line.get("ts"):
        return str(line["ts"])[:19]
    stamp = str(line.get("timestamp") or "")
    if not stamp.endswith("Z"):
        return stamp[:19]
    try:
        utc = datetime.fromisoformat(stamp[:-1]).replace(tzinfo=timezone.utc)
    except ValueError:
        return stamp[:19]
    return utc.astimezone().replace(tzinfo=None).isoformat(timespec="seconds")


def _member_activity(conv_id, since):
    """What a member did after `since`: her asks, its replies, its tool calls,
    in order, trimmed. `since` None = everything (capped by size)."""
    path = store.DATA_DIR / "bot_chats" / f"{conv_id}.jsonl"
    items = []
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return ""
    for line in lines:
        try:
            e = json.loads(line)
        except ValueError:
            continue
        stamp = _line_stamp(e) if isinstance(e, dict) else ""
        if not isinstance(e, dict) or (since and stamp and stamp < since[:19]):
            continue
        kind = e.get("type")
        if kind == "user" and isinstance(e.get("text"), str):
            items.append(f"owner asked: {_trim(e['text'])}")
        elif kind == "assistant" and not e.get("parent_tool_use_id"):
            for block in (e.get("message") or {}).get("content") or []:
                if not isinstance(block, dict):
                    continue
                if block.get("type") == "text" and block.get("text", "").strip():
                    items.append(f"agent said: {_trim(block['text'])}")
                elif block.get("type") == "tool_use":
                    inp = block.get("input") or {}
                    target = (inp.get("command") or inp.get("file_path")
                              or inp.get("pattern") or "")
                    items.append(f"tool {block.get('name')}: {_trim(target, 160)}")
        elif kind == "error":
            items.append(f"error: {_trim(e.get('error'))}")
    text = "\n".join(items)
    # Keep the END: what it's doing now matters more than how it started.
    return text if len(text) <= _MEMBER_CHARS else "…" + text[-_MEMBER_CHARS:]


def gather(swarm_id, questions=()):
    """Everything one run is handed, as one document — also what's stored as
    the run's input, verbatim."""
    card = next((c for c in swarms.overview() if c["id"] == swarm_id), None)
    if card is None:
        raise KeyError(swarm_id)
    out = [f"# Swarm {swarm_id}: {card['name'] if card['named'] else '(not named yet)'}",
           "", "## Current swarm summary", "", card.get("summary") or "(none yet)", ""]
    # Only the members still in view: one that finished over a day ago drops out.
    index = store.read("bot_chats/index", {})
    shown, dropped = swarms.in_helper_view(card["members"], index if isinstance(index, dict) else {})
    if dropped:
        out += [f"({len(dropped)} member(s) finished over {config.SWARM_HELPER_FORGET_HOURS:g}h ago"
                " and are left out; leave them out of your summaries too.)", ""]
    for m in shown:
        out += [f"## Member {m['conv']} — {m['title']} ({m['state']}, room {m['lane']})", "",
                "Current summary: " + (m.get("summary") or "(none yet)"), "",
                f"New since {m.get('summary_at') or 'joining'}:",
                _member_activity(m["conv"], m.get("summary_at")) or "(nothing new)", ""]
    conn = sqlstore.open_db()
    try:
        # Messages between members, leaving out old helper sessions: what
        # they sent was their own retelling of the swarm, not the members' work.
        members = [m["conv"] for m in card["members"]
                   if not swarms.is_helper_session(m["conv"], index)]
        marks = ",".join("?" * len(members))
        since = card.get("summary_at") or ""
        talk = conn.execute(
            f"SELECT at, from_conv, to_conv, text FROM agent_messages"
            f" WHERE kind = 'A' AND from_conv IN ({marks}) AND to_conv IN ({marks})"
            f" AND at >= ? ORDER BY id", (*members, *members, since)).fetchall()
    finally:
        conn.close()
    out += ["## Messages between members since the last summary", ""]
    out += [f"- {at} {a} → {b}: {_trim(t)}" for at, a, b, t in talk] or ["(none)"]
    # A swarm that has closed: what it did, as written then. A question about
    # what happened is answered from this — its members may be out of view.
    kept = closings_text(swarm_id, index, mark="###")
    if kept:
        out += ["", "## What this swarm did — your closing summaries", "", kept]
    if questions:
        out += ["", "## Questions in your mailbox (answer each, addressed to its sender)", ""]
        for q in questions:
            who = "owner" if q["kind"] == "B" else q["from_conv"]
            out.append(f"- from {who}: {q['text']}")
    return "\n".join(out) + "\n"


# --- One run ------------------------------------------------------------------------

def ask_model(text, system_prompt, schema):
    """One tool-less, single-turn model call with a structured answer.
    Returns (answer dict, cost). Shared with room_helper.py."""
    from routes import observatory
    cmd = [observatory.CLAUDE_BIN, "-p", "--model", config.SWARM_HELPER_MODEL,
           "--tools", "", "--no-session-persistence", "--output-format", "json",
           "--system-prompt", system_prompt, "--json-schema", json.dumps(schema)]
    proc = subprocess.run(cmd, input=text, capture_output=True, text=True,
                          timeout=config.SWARM_HELPER_TIMEOUT_SEC)
    try:
        reply = json.loads(proc.stdout)
    except ValueError:
        raise RuntimeError(f"helper call failed: {(proc.stderr or proc.stdout)[-400:]}")
    if reply.get("is_error") or not isinstance(reply.get("structured_output"), dict):
        raise RuntimeError(f"helper call failed: {str(reply.get('result'))[-400:]}")
    return reply["structured_output"], reply.get("total_cost_usd")


def _call_model(text):
    """A run's call for the swarm as a whole: its name, its summary, where
    members' work collides, and the messages to send."""
    return ask_model(text, SYSTEM_PROMPT, SCHEMA)


def _call_session(text):
    """One session's summary call."""
    return ask_model(text, SESSION_PROMPT, SESSION_SCHEMA)


def _call_closing(text):
    """The closing summary's call: what the swarm did, once, when it closes."""
    return ask_model(text, CLOSING_PROMPT, CLOSING_SCHEMA)


def side_by_side(jobs):
    """Run these model calls at the same time, at most
    config.HELPER_SUMMARY_PARALLEL at once (each is a `claude` process of its
    own, so the cap is about memory). `jobs` is {key: a function taking
    nothing}; returns {key: (result, None)} or {key: (None, the error)} — one
    call failing never loses the others."""
    def attempt(job):
        try:
            return job(), None
        except (RuntimeError, OSError, ValueError, subprocess.SubprocessError) as e:
            return None, str(e)

    if not jobs:
        return {}
    workers = max(1, min(int(config.HELPER_SUMMARY_PARALLEL), len(jobs)))
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {key: pool.submit(attempt, job) for key, job in jobs.items()}
        return {key: future.result() for key, future in futures.items()}


def session_job(conv, title, state, summary, summary_at):
    """The summary call for one session, as a function to hand side_by_side —
    or None when it needs no call: nothing has happened since its summary was
    written, so the summary still stands."""
    new = _member_activity(conv, summary_at)
    if not new:
        return None
    text = "\n".join([f"# Session {conv} — {title} ({state})", "",
                      "Current summary: " + (summary or "(none yet)"), "",
                      f"New since {summary_at or 'it started'}:", new, ""])
    return lambda: _call_session(text)


def summarise_sessions(results, convs):
    """Read the session calls out of side_by_side's results. Returns
    ({conv: new summary}, their total cost, [what went wrong, per session]).
    A session whose call failed or came back empty keeps its old summary."""
    summaries, cost, errors = {}, 0.0, []
    for conv in convs:
        if conv not in results:
            continue
        found, error = results[conv]
        if error:
            errors.append(f"{conv}: {error}")
            continue
        answer, call_cost = found
        cost += float(call_cost or 0)
        text = tidy_summary((answer or {}).get("summary"), SESSION_SHAPE)
        if text:
            summaries[conv] = text
    return summaries, cost, errors


def _render(answer):
    """The run as the helper's chat shows it."""
    lines = [f"**{answer.get('name')}**", ""] + _as_bullets(answer.get("summary"))
    # Each member under its own id, so the sessions read apart from each other.
    for m in answer.get("members") or []:
        lines += ["", f"`{m.get('conv')}`"] + _as_bullets(m.get("summary"))
    if answer.get("differences"):
        lines += ["", "**Where work differs or collides**"]
        lines += [f"- {d}" for d in answer["differences"]]
    for msg in answer.get("messages") or []:
        lines += ["", f"→ **{msg.get('to')}**: {msg.get('text')}"]
    return "\n".join(lines)


def run(swarm_id, trigger="turn", question_ids=()):
    """Do one helper run and write everything down. Returns the answer, or
    raises after recording the error."""
    from routes import observatory
    helper = ensure_helper(swarm_id)
    questions = [q for q in (peermail.get(i) for i in question_ids) if q]
    # Stamp the members' new summaries with when their activity was READ, not
    # when the calls came back: what a member does while the model is thinking
    # is still new to the next run.
    read_at = _now()
    text = gather(swarm_id, questions)
    log_path = store.DATA_DIR / "bot_chats" / f"{helper}.jsonl"
    # Make every call at once: the swarm's own, and one per member in view
    # that has done something since its summary was written.
    index = store.read("bot_chats/index", {})
    card = next((c for c in swarms.overview() if c["id"] == swarm_id), None)
    shown, _ = swarms.in_helper_view(card["members"] if card else [],
                                     index if isinstance(index, dict) else {})
    jobs = {"swarm": lambda: _call_model(text)}
    for m in shown:
        job = session_job(m["conv"], m["title"], m["state"], m.get("summary"), m.get("summary_at"))
        if job:
            jobs[m["conv"]] = job
    results = side_by_side(jobs)
    found, error = results["swarm"]
    answer, cost = found if found else (None, None)
    summaries, sessions_cost, session_errors = summarise_sessions(
        results, [m["conv"] for m in shown])
    for problem in session_errors:
        print(f"{_now()} member summary failed — {problem}", file=sys.stderr)
    cost = (float(cost or 0) + sessions_cost) if (cost is not None or sessions_cost) else None
    # The members' new summaries ride in the run's record and its chat post.
    if answer:
        answer["summary"] = tidy_summary(answer.get("summary"), SWARM_SHAPE)
        answer["members"] = [{"conv": conv, "summary": summary}
                             for conv, summary in summaries.items()]
    now = _now()
    members = set(swarms.overview_members(swarm_id))
    conn = sqlstore.open_db()
    try:
        sqlstore.begin_immediate(conn)
        conn.execute(
            "INSERT INTO swarm_helper_runs (swarm_id, at, trigger, input, output,"
            " cost_usd, error) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (swarm_id, now, trigger, text,
             json.dumps(answer, ensure_ascii=False) if answer else None, cost, error))
        if answer:
            # The new summaries REPLACE the old ones — the whole point.
            conn.execute("UPDATE swarms SET name = ?, summary = ?, summary_at = ?,"
                         " updated_at = ? WHERE id = ?",
                         ((answer.get("name") or "").strip()[:80] or None,
                          answer.get("summary"), now, now, swarm_id))
        # A member's summary is stored even when the swarm's own call failed.
        for conv, summary in summaries.items():
            if conv in members:
                conn.execute("UPDATE swarm_members SET summary = ?, summary_at = ?"
                             " WHERE swarm_id = ? AND conv = ?",
                             (summary, read_at, swarm_id, conv))
        conn.execute("COMMIT")
    finally:
        conn.close()
    # The helper's chat: what it was asked (if anything), then what it said.
    for q in questions:
        if q["kind"] == "B":
            peermail.append_line(log_path, {"type": "user", "text": q["text"], "ts": now,
                                            "journaled": False})
        else:
            peermail.append_line(log_path, peermail.peer_line(q, "in"))
    # Marked as a run's post, so the chat's rolling context (helper_chat.py)
    # can tell it from a chat reply: an answer to her question is kept as part
    # of its exchange, an unprompted update isn't replayed.
    if answer:
        peermail.append_line(log_path, {
            "type": "assistant", "timestamp": now, "helper_run": True,
            "helper_update": not questions,
            "message": {"role": "assistant",
                        "content": [{"type": "text", "text": _render(answer)}]}})
    else:
        peermail.append_line(log_path, {"type": "error", "error": error, "ts": now})
    peermail.append_line(log_path, {"type": "result", "subtype": "success" if answer else "error",
                                    "total_cost_usd": cost, "ts": now})
    with store.mutate("bot_chats/index", {}) as index:
        entry = index.get(helper)
        if isinstance(entry, dict):
            entry["running"] = False
            entry["last_at"] = now
            entry["helper_last_run"] = now
            if answer and answer.get("name"):
                entry["title"] = f"Swarm helper · {answer['name'].strip()[:60]}"
            entry["cost_usd"] = round(float(entry.get("cost_usd") or 0) + float(cost or 0), 6)
            if error:
                entry["last_error"] = error
            else:
                entry.pop("last_error", None)
    # Its messages go out through the normal mailbox, from the helper's session.
    for msg in (answer or {}).get("messages") or []:
        to, body = msg.get("to"), (msg.get("text") or "").strip()
        if to in members and body:
            try:
                observatory.peer_send(helper, to, body, mode="inject")
            except (KeyError, ValueError):
                pass
    if error:
        raise RuntimeError(error)
    return answer


# --- Rewriting summaries into the current shape ---------------------------------

_RESHAPE_NOTE = ("(nothing new — rewrite the current summary in the required shape, keeping"
                 " only what still matters)")


def reshape(swarm_id):
    """Rewrite a swarm's stored summaries into the current shape, without
    waiting for new activity: the swarm's own, and each member's that is
    still working. A normal run only rewrites a member that has done
    something since its summary, so an idle one would keep an old long
    paragraph for good. Nothing is posted, no message is sent, and every
    `summary_at` is left alone — what is new since each summary is still new
    to the next run. Returns (how many were rewritten, cost, [what failed])."""
    card = next((c for c in swarms.overview() if c["id"] == swarm_id), None)
    if card is None:
        raise KeyError(swarm_id)
    index = store.read("bot_chats/index", {})
    index = index if isinstance(index, dict) else {}
    working = [m for m in card["members"] if m.get("summary") and not m.get("retired")
               and not swarms.is_helper_session(m["conv"], index)]
    jobs = {}
    if card.get("summary"):
        text = gather(swarm_id) + ("\n(This is a rewrite only: put the current swarm summary into"
                                   " the required shape. Send no messages.)\n")
        jobs["swarm"] = lambda: _call_model(text)
    for m in working:
        member_text = "\n".join([f"# Session {m['conv']} — {m['title']} ({m['state']})", "",
                                 "Current summary: " + m["summary"], "",
                                 "New since then:", _RESHAPE_NOTE, ""])
        jobs[m["conv"]] = lambda member_text=member_text: _call_session(member_text)
    results = side_by_side(jobs)
    summaries, cost, errors = summarise_sessions(results, [m["conv"] for m in working])
    swarm_summary = ""
    if "swarm" in results:
        found, error = results["swarm"]
        if error:
            errors.append(f"swarm {swarm_id}: {error}")
        else:
            swarm_summary = tidy_summary(found[0].get("summary"), SWARM_SHAPE)
            cost += float(found[1] or 0)
    conn = sqlstore.open_db()
    try:
        sqlstore.begin_immediate(conn)
        if swarm_summary:
            conn.execute("UPDATE swarms SET summary = ? WHERE id = ?", (swarm_summary, swarm_id))
        for conv, summary in summaries.items():
            conn.execute("UPDATE swarm_members SET summary = ? WHERE swarm_id = ? AND conv = ?",
                         (summary, swarm_id, conv))
        conn.execute("COMMIT")
    finally:
        conn.close()
    return len(summaries) + bool(swarm_summary), cost, errors


# --- When it runs -----------------------------------------------------------------

def _spawn(swarm_id, trigger, question_ids=()):
    """Start a run in its own detached process, marking the helper busy."""
    helper = ensure_helper(swarm_id)
    with store.mutate("bot_chats/index", {}) as index:
        entry = index.get(helper)
        if not isinstance(entry, dict):
            return False
        entry["running"] = True
        entry["last_at"] = _now()
        entry.pop("helper_pending", None)
    args = ["run", str(swarm_id), trigger]
    if question_ids:
        args += ["--questions", ",".join(str(i) for i in question_ids)]
    _detach(swarm_id, args)
    return True


def _detach(swarm_id, args):
    """Start `python3 swarm_helper.py <args>` as a process of its own, so
    nothing waits on the model. What it prints goes to the swarm's helper log."""
    log = store.DATA_DIR / "bot_chats" / ".turns" / f"helper-{swarm_id}.log"
    log.parent.mkdir(parents=True, exist_ok=True)
    cmd = [sys.executable, str(Path(__file__).resolve()), *args]
    env = {**os.environ, "EXOCORTEX_DATA_DIR": str(store.DATA_DIR),
           "EXOCORTEX_CONTENT_DIR": str(store.CONTENT_DIR)}
    with open(log, "ab") as errf:
        subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=errf, stderr=errf,
                         start_new_session=True, env=env)


def _spawn_close(swarm_id, helper):
    """Start the closing of a retired swarm in its own detached process,
    marking the helper busy. `helper_closing_at` says a closing was started:
    the minute tick never starts a second one for the same retirement
    (watch_retirement), so the closing summary costs one model call."""
    with store.mutate("bot_chats/index", {}) as index:
        entry = index.get(helper)
        if not isinstance(entry, dict):
            return False
        entry["running"] = True
        entry["last_at"] = entry["helper_closing_at"] = _now()
        entry.pop("helper_pending", None)
    _detach(swarm_id, ["close", str(swarm_id)])
    return True


def poke(swarm_id, trigger="turn"):
    """Something happened in the swarm. Run now if the helper is free and
    hasn't run recently; otherwise leave a note for the minute tick. This is
    a debounce: a burst of member turns becomes one run.

    A closed swarm (swarms.retired: fewer than two lines of work still going)
    isn't run at all — its one working session is working alone, and a
    swarm that closes before it ever opened gets no helper. The minute tick's
    closing check (watch_retirement) looks after it instead."""
    if swarms.retired(swarm_id):
        return False
    helper = ensure_helper(swarm_id)
    entry = store.read("bot_chats/index", {}).get(helper) or {}
    last = entry.get("helper_last_run")
    recent = last and (datetime.now() - datetime.fromisoformat(last)
                       < timedelta(seconds=config.SWARM_HELPER_MIN_SEC))
    from routes import observatory
    if recent or observatory._effective_running(helper, entry):
        with store.mutate("bot_chats/index", {}) as index:
            if isinstance(index.get(helper), dict):
                index[helper]["helper_pending"] = trigger
        return False
    return _spawn(swarm_id, trigger)


def answer_mail(helper_conv):
    """Messages to the helper — from her or an agent — get a run of their own
    right away, not debounced: someone is waiting on the answer."""
    from routes import observatory
    entry = store.read("bot_chats/index", {}).get(helper_conv)
    if not is_helper(entry) or observatory._effective_running(helper_conv, entry):
        return False
    rows = peermail.waiting(helper_conv)
    won = peermail.claim(rows, "batched")
    if not won:
        return False
    return _spawn(entry["swarm_id"], "message", [r["id"] for r in won])


def tick():
    """The minute tick: close out every swarm that has retired, then run every
    helper that has something pending and is past its interval. Returns how
    many runs started."""
    started = 0
    index = store.read("bot_chats/index", {})
    for conv, entry in list(index.items()):
        if not is_helper(entry):
            continue
        try:
            if watch_retirement(conv, entry, index):
                continue
        except Exception as e:
            print(f"{_now()} closing check for {conv} failed: {e}", file=sys.stderr)
        if entry.get("helper_pending"):
            if poke(entry["swarm_id"], entry["helper_pending"]):
                started += 1
    return started


# --- When the swarm retires: the closing summary and the closing check --------
# A swarm's helper stays for as long as the swarm does. When the swarm closes
# — fewer than two of its lines of work still going (swarms.retired: the
# others done, closed, archived or released) — the helper posts one last
# message and marks itself done, so its card closes two hours later like any
# finished session's. The message has two halves:
#   - the CLOSING SUMMARY, written by the model: what the swarm set out to
#     do, what each line of work completed, what is left;
#   - the CLOSING CHECK, plain code: the facts from git, the session index and
#     the job folders, never from what the agents said about themselves. The
#     model is handed it and told it is the truth about what shipped.
# Both are kept in `swarm_closings` and handed back to the helper every turn.
#
# Prompts: "when the swarm retires ... the helper runs a closing check: what
# shipped (commit hashes from git, not agents' word), anything left uncommitted
# or unfinished, open questions still waiting on her, and stray detached jobs.
# It posts that as its final message, then closes itself." — and: "when a
# swarm retires, i want a summary of what was done to be written by that
# swarm's helper, which will then be put in the chat and noted".

# A commit as git reports it when it's made: "[main a15f1a7] subject".
_COMMIT_RE = re.compile(r"\[([\w./-]+)(?: \(root-commit\))? ([0-9a-f]{7,40})\] ")


def _git(cwd, *args):
    """Run one git command in `cwd`. Its output, or None if it failed."""
    try:
        proc = subprocess.run(["git", "-C", str(cwd), *args], capture_output=True,
                              text=True, timeout=30)
    except (OSError, subprocess.SubprocessError):
        return None
    return proc.stdout if proc.returncode == 0 else None


# A shell command that makes a commit, and the folders a command names
# (`git -C <folder>`, `cd <folder>`): the other repos a session worked in.
_COMMIT_CMD_RE = re.compile(r"\bgit\b(?:\s+-[cC]\s+\S+)*\s+commit\b")
_FOLDER_RE = re.compile(r"(?:\bgit\s+-C|\bcd)\s+[\"']?([^\s\"';&|]+)")


def _epoch(stamp):
    """A transcript line's UTC timestamp ("…Z") as seconds, or None."""
    try:
        return datetime.fromisoformat(str(stamp).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def _commit_calls(raw):
    """When a session ran `git commit`, read from its transcript: ([(started,
    ended)] in seconds, one pair per commit command — from the moment the
    agent asked for the command to the moment its result came back — and
    every folder any of its shell commands named)."""
    asked, windows, folders = {}, [], []
    for line in raw.splitlines():
        if "tool_use" not in line and "tool_result" not in line:
            continue
        try:
            e = json.loads(line)
        except ValueError:
            continue
        content = (e.get("message") or {}).get("content") if isinstance(e, dict) else None
        for block in content if isinstance(content, list) else []:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "tool_use" and block.get("name") == "Bash":
                command = str((block.get("input") or {}).get("command") or "")
                folders += [f for f in _FOLDER_RE.findall(command) if f not in folders]
                if _COMMIT_CMD_RE.search(command) and _epoch(e.get("timestamp")):
                    asked[block.get("id")] = _epoch(e["timestamp"])
            elif block.get("type") == "tool_result" and block.get("tool_use_id") in asked:
                began = asked.pop(block["tool_use_id"])
                windows.append((began, _epoch(e.get("timestamp")) or began + 600))
    # A commit command whose result was never written still gets ten minutes.
    windows += [(began, began + 600) for began in asked.values()]
    return windows, folders


def _commits_of(conv_id, entry):
    """The commits a session made, as git tells it. Returns a list of
    (hash, subject, found) — found False when git announced a commit that
    the repo no longer knows.

    Two ways a commit is found, because agents mostly commit quietly:
      - git announced it in a tool result ("[main a15f1a7] subject"); each
        is checked against the repo the session ran in;
      - the session ran a `git commit` command, and a repo it worked in — its
        own folder, or one a shell command of its named — holds a commit made
        while that command ran. A quiet commit (`-q`) prints nothing, so
        this asks git what was committed in those seconds.
    The second can credit a session with another's commit only if both
    committed to the same repo within the same few seconds."""
    path = store.DATA_DIR / "bot_chats" / f"{conv_id}.jsonl"
    try:
        raw = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return []
    hashes = []
    for line in raw.splitlines():
        if "tool_result" in line:
            for _, commit in _COMMIT_RE.findall(line):
                if commit not in hashes:
                    hashes.append(commit)
    cwd = entry.get("worktree") or entry.get("cwd") or str(store.BUILD_DIR)
    out = []
    for commit in hashes:
        shown = _git(cwd, "log", "-1", "--format=%h\t%s", commit)
        if shown and "\t" in shown:
            short, subject = shown.strip().split("\t", 1)
            out.append((short, subject, True))
        else:
            out.append((commit, "", False))
    # The commits made while its commit commands ran, in every repo it worked in.
    windows, folders = _commit_calls(raw)
    if not windows:
        return out
    repos = []
    for folder in [cwd] + folders:
        if Path(folder).is_dir():
            top = (_git(folder, "rev-parse", "--show-toplevel") or "").strip()
            if top and top not in repos:
                repos.append(top)
    first = datetime.fromtimestamp(min(began for began, _ in windows) - 60)
    known = {short for short, _, _ in out}
    for top in repos:
        log = _git(top, "log", "--all", "--reverse", "--format=%h\t%ct\t%s",
                   f"--since={first.isoformat(timespec='seconds')}") or ""
        for row in log.splitlines():
            short, made, subject = (row.split("\t", 2) + ["", ""])[:3]
            if short in known or not made.isdigit():
                continue
            if any(began - 2 <= int(made) <= ended + 2 for began, ended in windows):
                known.add(short)
                out.append((short, subject, True))
    return out


def _uncommitted_of(conv_id, entry):
    """The files a session wrote that git still shows as changed or untracked."""
    from scripts.extract_footprints import harvest_conversation
    path = store.DATA_DIR / "bot_chats" / f"{conv_id}.jsonl"
    try:
        touched = harvest_conversation(path, entry.get("cwd"))
    except Exception:
        return []
    written = [p for p, t in touched.items() if t.get("writes", 0) + t.get("creates", 0)]
    by_repo = {}
    for file_path in written:
        folder = Path(file_path).parent
        while not folder.is_dir() and folder != folder.parent:
            folder = folder.parent
        top = _git(folder, "rev-parse", "--show-toplevel")
        if top:
            by_repo.setdefault(top.strip(), []).append(file_path)
    dirty = []
    for top, files in by_repo.items():
        status = _git(top, "status", "--porcelain", "--", *files) or ""
        dirty += [f"{top}/{line[3:]}" for line in status.splitlines() if line.strip()]
    return dirty


def closing_report(swarm_id):
    """The helper's last message for a retired swarm, as markdown."""
    from routes import observatory
    card = next((c for c in swarms.overview() if c["id"] == swarm_id), None)
    name = card["name"] if card else f"Swarm {swarm_id}"
    index = store.read("bot_chats/index", {})
    members = swarms.overview_members(swarm_id)
    shipped, dirty, unfinished, questions, jobs = [], [], [], [], []
    seen = set()
    for conv in members:
        entry = index.get(conv) if isinstance(index.get(conv), dict) else {}
        title = entry.get("title") or conv
        for commit, subject, found in _commits_of(conv, entry):
            if commit in seen:
                continue
            seen.add(commit)
            shipped.append(f"- `{commit}` {subject} — {title}" if found else
                           f"- `{commit}` — {title} (git reported it, but its repo no"
                           " longer knows it: rewritten, or made elsewhere)")
        dirty += [f"- `{p}` — {title}" for p in _uncommitted_of(conv, entry)]
        if not entry:
            unfinished.append(f"- `{conv}` — gone from the index")
        elif not swarms.member_retired(entry):
            unfinished.append(f"- {title} (`{conv}`) — still working, on its own now")
        elif not entry.get("done_at") and not entry.get("continued_by"):
            unfinished.append(f"- {title} (`{conv}`) — closed without saying it was done")
        questions += [f"- {title}: {q}" for q in observatory._open_questions(entry)]
        jobs += [f"- {title}: {j}" for j in observatory._unfinished_jobs(conv)]
    lines = [f"**Closing check — {name}**", "",
             "Fewer than two members of this swarm are still working, so it has closed"
             " and this is my last message unless you ask me something. If a second one"
             " starts working in it again, it opens again and I come back. Checked against"
             " git and the session records, not the agents' own accounts.", ""]
    sections = [("What shipped", shipped, "No commits."),
                ("Written but not committed", dirty, "Nothing — every file they wrote is committed."),
                ("Not finished", unfinished, "Every member said it was done."),
                ("Questions still waiting on you", questions, "None."),
                ("Detached jobs still running", jobs, "None.")]
    for heading, items, empty in sections:
        lines += [f"**{heading}**"] + (items or [empty]) + [""]
    return "\n".join(lines).rstrip() + "\n"


def closings(swarm_id):
    """Every closing kept for this swarm, oldest first: each {"id", "at",
    "name", "headline", "summary", "facts", "cost_usd", "error"}. A swarm
    that absorbed another carries the absorbed one's closings too — its work
    is this swarm's history now."""
    conn = sqlstore.open_db()
    try:
        rows = conn.execute(
            "WITH RECURSIVE family(id) AS (SELECT ? UNION SELECT s.id FROM swarms s"
            " JOIN family f ON s.merged_into = f.id)"
            " SELECT id, at, name, headline, summary, facts, cost_usd, error"
            " FROM swarm_closings WHERE swarm_id IN (SELECT id FROM family)"
            " ORDER BY at, id", (swarm_id,)).fetchall()
    finally:
        conn.close()
    keys = ("id", "at", "name", "headline", "summary", "facts", "cost_usd", "error")
    return [dict(zip(keys, row)) for row in rows]


def _standing(entry):
    """Where a member stands when its swarm closes, in a few plain words."""
    if not entry:
        return "gone from the index"
    if not swarms.member_retired(entry):
        return "still working, on its own now"
    if entry.get("done_at"):
        return "said it was done"
    if entry.get("continued_by"):
        return "handed its work on to a continuation"
    return "closed without saying it was done"


def closings_text(swarm_id, index=None, mark="##"):
    """The kept closing summaries as the helper is handed them back — in its
    chat's seed (helper_chat.py) and in a run that answers mail (gather).
    Empty when the swarm has never closed. `mark` is the heading each closing
    is put under, to fit the document it goes into.

    The latest closing comes with its closing check; earlier ones with their
    summary alone. Every member the swarm had is named at the end with its
    session id, whenever it finished: the helper stops reading members a day
    after they finish (swarms.in_helper_view), and this is how it still
    finds their transcripts."""
    kept = closings(swarm_id)
    if not kept:
        return ""
    if index is None:
        index = store.read("bot_chats/index", {})
    index = index if isinstance(index, dict) else {}
    out = [f"This swarm has closed {len(kept)} time{'s' if len(kept) != 1 else ''}. Each time,"
           " you wrote what it had done and the app checked what shipped against git. These"
           " are kept (the `swarm_closings` table) and handed to you on every turn, so you can"
           " answer her questions about what happened. For more than they say, read a member's"
           " transcript: every member is named at the end with its session id.", ""]
    shown = kept[-_CLOSINGS_SHOWN:]
    if len(kept) > len(shown):
        out += [f"(The {len(kept) - len(shown)} before these are in the table.)", ""]
    for closing in shown:
        out += [f"{mark} Closed {closing['at']}", ""]
        out += [closing["summary"] or
                f"(No summary was written: {closing['error'] or 'the model call failed'}.)", ""]
        if closing is shown[-1]:
            out += [(closing["facts"] or "").strip(), ""]
    out += [f"{mark} Every member this swarm had", ""]
    for conv in sorted(swarms.overview_members(swarm_id)):
        if swarms.is_helper_session(conv, index):
            continue
        entry = index.get(conv) if isinstance(index.get(conv), dict) else {}
        said = f": {_trim(entry['done_note'], 200)}" if entry.get("done_note") else ""
        out.append(f"- `{conv}` {entry.get('title') or conv} — {_standing(entry)}{said}")
    return "\n".join(out) + "\n"


def closing_input(swarm_id, report):
    """Everything the closing summary's call is handed, as one document —
    also what's stored as the closing's input, verbatim: the swarm's last
    summary, every member (whenever it finished) with its summary and the end
    of what it did, the messages between members, and the closing check.

    A swarm that closed before is summarised from its last closing on: the
    earlier summaries are handed over and kept, not written again."""
    card = next((c for c in swarms.overview() if c["id"] == swarm_id), None)
    if card is None:
        raise KeyError(swarm_id)
    index = store.read("bot_chats/index", {})
    index = index if isinstance(index, dict) else {}
    out = [f"# Swarm {swarm_id}: {card['name']}", "", "## Its last summary", "",
           card.get("summary") or "(none written)", ""]
    earlier = closings(swarm_id)
    since = earlier[-1]["at"] if earlier else None
    if earlier:
        out += ["## It closed before", "",
                "This swarm opened again after closing. Your earlier closing summaries are"
                " below and are kept. Write about what happened SINCE the last one; don't"
                " retell them.", ""]
        for closing in earlier[-_CLOSINGS_SHOWN:]:
            out += [f"### Closed {closing['at']}", "",
                    closing["summary"] or "(no summary was written)", ""]
    members = [m for m in card["members"] if not swarms.is_helper_session(m["conv"], index)]
    for m in members:
        entry = index.get(m["conv"]) if isinstance(index.get(m["conv"]), dict) else {}
        out += [f"## Member {m['conv']} — {m['title']} ({_standing(entry)})", "",
                "Its summary: " + (m.get("summary") or "(none written)")]
        if entry.get("done_note"):
            out.append("What it said when it finished: " + _trim(entry["done_note"]))
        out += ["", f"The end of what it did{' since ' + since if since else ''}:",
                _member_activity(m["conv"], since) or "(nothing)", ""]
    conn = sqlstore.open_db()
    try:
        convs = [m["conv"] for m in members]
        marks = ",".join("?" * len(convs))
        talk = conn.execute(
            f"SELECT at, from_conv, to_conv, text FROM agent_messages"
            f" WHERE kind = 'A' AND status != 'cancelled' AND from_conv IN ({marks})"
            f" AND to_conv IN ({marks}) AND at >= ? ORDER BY id DESC LIMIT ?",
            (*convs, *convs, since or "", _CLOSING_MESSAGES)).fetchall()
    finally:
        conn.close()
    out += [f"## Messages between members (the last {_CLOSING_MESSAGES} at most)", ""]
    out += [f"- {at} {a} → {b}: {_trim(t)}" for at, a, b, t in reversed(talk)] or ["(none)"]
    out += ["", "## The closing check — what git and the session records say", "", report]
    return "\n".join(out) + "\n"


def _render_closing(name, summary, error, report):
    """The helper's last message as its chat shows it: the closing summary,
    then the closing check."""
    lines = [f"**What this swarm did — {name}**", ""]
    lines.append(summary or f"I couldn't write the summary ({error}). The closing check below"
                            " is what git and the session records say.")
    lines += ["", "This is kept. Ask me here about what happened: I'm handed it on every turn.",
              "", report.strip()]
    return "\n".join(lines) + "\n"


def _tell_room(swarm_id, name, lane, helper, headline, now):
    """Say in the room helper's chat that this swarm closed: one line with
    what it did, so she sees a swarm closed without opening each helper. The
    line is marked `swarm_closed`, and the chat page opens a line with that
    mark into the whole summary (SwarmClosingFold.tsx). A room with no helper
    is told nothing.
    Prompt: "one line is fine as long as it is clickable to expand"."""
    import room_helper
    index = store.read("bot_chats/index", {})
    room = room_helper.find_helper(lane, index if isinstance(index, dict) else {})
    if not room or room == helper:
        return False
    did = headline or "No summary was written; its closing check says what git shows."
    room_helper._post(
        room, f"**Swarm {swarm_id} closed — {name}.** {did}", now, swarm_closed=swarm_id)
    with store.mutate("bot_chats/index", {}) as live:
        if isinstance(live.get(room), dict):
            live[room]["last_at"] = now
    return True


def close_out(swarm_id, helper, summarise=True):
    """Close a retired swarm: write its closing summary (one model call), keep
    it with the closing check, post both in the helper's chat, tell the room's
    helper in a line, and mark the helper done. Returns what was posted.

    A summary that can't be written never stops the closing: the closing
    check is posted alone and the reason is kept. `summarise=False` skips the
    model — the fallback when the closing process died before it posted."""
    from routes import observatory
    card = next((c for c in swarms.overview() if c["id"] == swarm_id), None)
    name = card["name"] if card else f"Swarm {swarm_id}"
    report = closing_report(swarm_id)
    text = headline = summary = cost = error = None
    if summarise:
        try:
            text = closing_input(swarm_id, report)
            answer, cost = _call_closing(text)
            headline = " ".join(str(answer.get("headline") or "").split()) or None
            summary = str(answer.get("summary") or "").strip() or None
            if not summary:
                headline, error = None, "the model wrote nothing"
        except (KeyError, RuntimeError, OSError, ValueError, subprocess.SubprocessError) as e:
            error = str(e) or type(e).__name__
    else:
        error = "the closing run ended before it wrote one"
    now = _now()
    conn = sqlstore.open_db()
    try:
        sqlstore.begin_immediate(conn)
        conn.execute(
            "INSERT INTO swarm_closings (swarm_id, at, name, headline, summary, facts, input,"
            " cost_usd, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (swarm_id, now, name, headline, summary, report, text, cost, error))
        conn.execute("COMMIT")
    finally:
        conn.close()
    # Marked as a run's own post, not a reply: the chat's rolling context
    # doesn't replay it as part of an exchange — it is handed to the helper
    # whole, from the table, on every turn (helper_chat.seed_parts).
    posted = _render_closing(name, summary, error, report)
    log_path = store.DATA_DIR / "bot_chats" / f"{helper}.jsonl"
    peermail.append_line(log_path, {
        "type": "assistant", "timestamp": now, "helper_run": True, "helper_update": True,
        "closing_check": True,
        "message": {"role": "assistant", "content": [{"type": "text", "text": posted}]}})
    if summarise:
        peermail.append_line(log_path, {"type": "result", "total_cost_usd": cost, "ts": now,
                                        "subtype": "success" if summary else "error"})
    with store.mutate("bot_chats/index", {}) as index:
        entry = index.get(helper)
        archived = True
        if isinstance(entry, dict):
            archived = bool(entry.get("archived"))
            entry["helper_closed_at"] = now
            entry["last_at"] = now
            entry["running"] = False
            entry["cost_usd"] = round(float(entry.get("cost_usd") or 0) + float(cost or 0), 6)
            entry.pop("helper_pending", None)
            entry.pop("helper_closing_at", None)
    # A helper already put away (a closing written again by hand) stays away.
    if not archived:
        observatory.mark_done(helper, "Closing summary posted: fewer than two members of"
                                      " the swarm are still working.")
    try:
        _tell_room(swarm_id, name, card["lane"] if card else "coding", helper, headline, now)
    except Exception as e:
        print(f"{_now()} telling the room swarm {swarm_id} closed failed: {e}", file=sys.stderr)
    return posted


def watch_retirement(helper, entry, index):
    """At the minute tick: close out this helper's swarm the first time it's
    found retired, and bring the helper back if the swarm comes back to life
    (two of its lines of work are going again). Returns True when the
    helper is closed out, or closing, and has nothing else to do."""
    swarm_id = entry.get("swarm_id")
    if swarm_id is None:
        return False
    # A closing is under way (its process writes the summary and posts). Leave
    # it be while it runs. If it ended without posting — it crashed, or the
    # machine restarted under it — post the closing check alone: one
    # retirement gets one model call, never a retry every minute.
    started = entry.get("helper_closing_at")
    if started and not entry.get("helper_closed_at"):
        waited = datetime.now() - datetime.fromisoformat(started)
        if entry.get("running") and waited < timedelta(
                seconds=config.SWARM_HELPER_TIMEOUT_SEC + 120):
            return True
        if swarms.retired(swarm_id, index):
            close_out(swarm_id, helper, summarise=False)
            return True
        # It opened again meanwhile: there is nothing to close.
        with store.mutate("bot_chats/index", {}) as live_index:
            if isinstance(live_index.get(helper), dict):
                live_index[helper].pop("helper_closing_at", None)
                live_index[helper]["running"] = False
        return False
    if entry.get("running"):
        return False
    is_retired = swarms.retired(swarm_id, index)
    if entry.get("helper_closed_at"):
        # Still retired, or merged away / dissolved: nothing to come back to.
        if is_retired or not swarms.is_live(swarm_id):
            return True
        with store.mutate("bot_chats/index", {}) as live_index:
            live = live_index.get(helper)
            if isinstance(live, dict):
                for field in ("helper_closed_at", "archived", "done_at", "done_note",
                              "closes_at", "final_at", "final_pending"):
                    live.pop(field, None)
        return False
    if is_retired and not entry.get("archived"):
        _spawn_close(swarm_id, helper)
        return True
    return False


def rest_again(helper):
    """When a closed swarm's helper finishes a chat turn — she asked it about
    what happened — start its countdown again. Her message took its done mark
    off (talking to a session keeps it open), and a helper can't mark itself
    done, so without this its card would stay open for good. Returns True
    when it was marked."""
    from routes import observatory
    entry = store.read("bot_chats/index", {}).get(helper)
    if (not is_helper(entry) or not entry.get("helper_closed_at") or entry.get("done_at")
            or entry.get("archived") or not swarms.retired(entry.get("swarm_id"))):
        return False
    _, status = observatory.mark_done(helper, "Answered about its closed swarm.")
    return status == 200


def _not_busy(swarm_id):
    """Never leave the helper looking busy forever after a failed process."""
    with store.mutate("bot_chats/index", {}) as index:
        for entry in index.values():
            if is_helper(entry) and entry.get("swarm_id") == swarm_id:
                entry["running"] = False


def main(argv):
    if len(argv) >= 3 and argv[1] == "run":
        swarm_id, trigger = int(argv[2]), (argv[3] if len(argv) > 3 else "turn")
        ids = []
        if "--questions" in argv:
            ids = [int(i) for i in argv[argv.index("--questions") + 1].split(",") if i]
        try:
            run(swarm_id, trigger, ids)
        except Exception as e:
            print(f"{_now()} helper run for swarm {swarm_id} failed: {e}", file=sys.stderr)
            _not_busy(swarm_id)
            return 1
        return 0
    # The closing of a retired swarm (started by the minute tick; by hand it
    # writes a closing for a swarm that closed without one).
    if len(argv) >= 3 and argv[1] == "close":
        swarm_id = int(argv[2])
        try:
            if not swarms.retired(swarm_id):
                # Left for the tick to sort out (watch_retirement).
                raise RuntimeError("it has not closed: two of its sessions are still working")
            close_out(swarm_id, ensure_helper(swarm_id))
        except Exception as e:
            print(f"{_now()} closing swarm {swarm_id} failed: {e}", file=sys.stderr)
            _not_busy(swarm_id)
            return 1
        return 0
    # Rewrite a swarm's summaries into the current shape, by hand.
    if len(argv) >= 3 and argv[1] == "reshape":
        rewritten, cost, errors = reshape(int(argv[2]))
        print(f"swarm {argv[2]}: {rewritten} summaries rewritten, ${cost:.3f}")
        for problem in errors:
            print(f"  failed — {problem}", file=sys.stderr)
        return 1 if errors else 0
    print("usage: swarm_helper.py run <swarm_id> [trigger] [--questions 1,2]\n"
          "       swarm_helper.py close <swarm_id>\n"
          "       swarm_helper.py reshape <swarm_id>", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    # Settle the data dir from the environment before anything caches it.
    if os.environ.get("EXOCORTEX_DATA_DIR"):
        store.DATA_DIR = Path(os.environ["EXOCORTEX_DATA_DIR"])
    sys.exit(main(sys.argv))
