"""The swarm helper — one Sonnet per swarm that keeps track of what everyone in
it is doing, names the swarm, and coordinates.

**What this is, in plain English.** When sessions start messaging each other
they form a swarm (swarms.py). Each swarm gets a helper: an Observatory
session of its own (so it has a card, a chat, and a mailbox other agents and
the owner can write to), whose work is done by short, separate calls to the
model — never one long conversation. Each call is handed:

  - the swarm's current summary and each member's current summary,
  - what's new for each member since its summary was written — the owner's
    asks, the agent's replies, its tool calls, the messages between members,
  - any questions waiting in the helper's own mailbox,

and hands back a new name (if it has a better one), a new swarm summary, a
new summary per member, where members' work differs or collides, and any
messages to send — to members, or answers to whoever asked. The new
summaries REPLACE the old ones, so the next call reads only those plus
what's new: the helper's context never grows, however long the swarm runs.

Every run is written down in full (`swarm_helper_runs`: its exact input and
output, cost, error) and into the helper's own chat, so the owner can see what
information it used and what it did with it.

When it runs: when a member's turn ends (at most once every
config.SWARM_HELPER_MIN_SEC per swarm — anything sooner waits for the minute
tick), when the swarm forms, and straight away when someone messages it.
Each run is its own detached process (`python3 swarm_helper.py run <id>`),
so nothing waits on the model.

Touches: swarms.py (membership and the tables), peermail.py (its mailbox;
agent messages it sends go through routes/observatory.peer_send), the session
index (the helper's own entry — `role: "swarm_helper"`), config.py (model and
pacing), scripts/coming_up_dispatcher.py (the minute tick), sqlstore.py
(swarm_helper_runs), tests/test_swarm_helper.py. Design: docs/swarms.md.

Prompt that produced this: "i want the helper to name the session and
understand what all of them are doing and synthesize it automatically as it
coordinates differences ... which may be done per turn and then drop the
other summary out of the context window ... one helper per swarm. i want to
be able to click into it and see what information is being used by it."
"""
import json
import os
import subprocess
import sys
from datetime import datetime, timedelta
from pathlib import Path

import config
import peermail
import sqlstore
import store
import swarms

ROLE = "swarm_helper"

# How much of each member's new activity one run reads. The helper needs the
# shape of the work, not every line; the full transcripts are always a
# `peers.py show` away for the members themselves.
_MEMBER_CHARS = 4000
_ITEM_CHARS = 400

SYSTEM_PROMPT = """You are the helper for a swarm of AI coding agents working on one person's \
app. The agents became a swarm by messaging each other. Your job:
1. Name the swarm: 2-5 plain words for the shared project (keep the current name unless it's wrong).
2. Summarise the swarm in a few sentences: the shared goal, where it stands, what's next.
3. Summarise each member in 1-3 sentences: what it's doing now, what it has done, what it's waiting on.
4. Coordinate: notice where members' work overlaps, conflicts (two editing the same file, \
contradictory decisions) or depends on each other. Only when it changes a member's work, send \
a short message to the member who needs to know. Never more than one message per member per run. \
Check "Messages between members" first: if you (or anyone) already told a member this, don't \
send it again — a reworded repeat is still a repeat. Don't message members the news doesn't \
affect, don't chat, and never hand a member work outside its own brief.
5. Answer any questions in your mailbox, addressed back to whoever asked (an agent's session id, \
or "owner").
You only see summaries and what's new since them; your summaries replace the old ones, so carry \
forward anything still true. Plain words; the owner reads these."""

SCHEMA = {
    "type": "object",
    "properties": {
        "name": {"type": "string"},
        "summary": {"type": "string"},
        "members": {"type": "array", "items": {
            "type": "object",
            "properties": {"conv": {"type": "string"}, "summary": {"type": "string"}},
            "required": ["conv", "summary"]}},
        "differences": {"type": "array", "items": {"type": "string"}},
        "messages": {"type": "array", "items": {
            "type": "object",
            "properties": {"to": {"type": "string"}, "text": {"type": "string"}},
            "required": ["to", "text"]}},
    },
    "required": ["name", "summary", "members", "messages"],
}


def _now():
    return datetime.now().isoformat(timespec="seconds")


def _trim(text, cap=_ITEM_CHARS):
    text = " ".join(str(text or "").split())
    return text if len(text) <= cap else text[:cap - 1] + "…"


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
        return helper
    with store.mutate("bot_chats/index", {}) as index:
        helper = observatory._new_conv_id(index)
        index[helper] = {
            "bot": "helper", "role": ROLE, "swarm_id": swarm_id,
            "title": f"Swarm helper · {name or f'swarm {swarm_id}'}",
            "started": _now(), "last_at": _now(), "claude_session_id": None,
            "cost_usd": 0.0, "journal": False, "lane": lane or "coding",
            "cwd": str(store.BUILD_DIR), "allowed_tools": ["Read"],
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
        stamp = (e.get("ts") or e.get("timestamp") or "")[:19]
        if since and stamp and stamp < since[:19]:
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
    for m in card["members"]:
        out += [f"## Member {m['conv']} — {m['title']} ({m['state']}, room {m['lane']})", "",
                "Current summary: " + (m.get("summary") or "(none yet)"), "",
                f"New since {m.get('summary_at') or 'joining'}:",
                _member_activity(m["conv"], m.get("summary_at")) or "(nothing new)", ""]
    conn = sqlstore.open_db()
    try:
        members = [m["conv"] for m in card["members"]]
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
    if questions:
        out += ["", "## Questions in your mailbox (answer each, addressed to its sender)", ""]
        for q in questions:
            who = "owner" if q["kind"] == "B" else q["from_conv"]
            out.append(f"- from {who}: {q['text']}")
    return "\n".join(out) + "\n"


# --- One run ------------------------------------------------------------------------

def _call_model(text):
    """One tool-less, single-turn model call with a structured answer.
    Returns (answer dict, cost)."""
    from routes import observatory
    cmd = [observatory.CLAUDE_BIN, "-p", "--model", config.SWARM_HELPER_MODEL,
           "--tools", "", "--no-session-persistence", "--output-format", "json",
           "--system-prompt", SYSTEM_PROMPT, "--json-schema", json.dumps(SCHEMA)]
    proc = subprocess.run(cmd, input=text, capture_output=True, text=True,
                          timeout=config.SWARM_HELPER_TIMEOUT_SEC)
    try:
        reply = json.loads(proc.stdout)
    except ValueError:
        raise RuntimeError(f"helper call failed: {(proc.stderr or proc.stdout)[-400:]}")
    if reply.get("is_error") or not isinstance(reply.get("structured_output"), dict):
        raise RuntimeError(f"helper call failed: {str(reply.get('result'))[-400:]}")
    return reply["structured_output"], reply.get("total_cost_usd")


def _render(answer):
    """The run as the helper's chat shows it."""
    lines = [f"**{answer.get('name')}**", "", answer.get("summary") or ""]
    for m in answer.get("members") or []:
        lines.append(f"- `{m.get('conv')}` — {m.get('summary')}")
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
    text = gather(swarm_id, questions)
    log_path = store.DATA_DIR / "bot_chats" / f"{helper}.jsonl"
    answer, cost, error = None, None, None
    try:
        answer, cost = _call_model(text)
    except (RuntimeError, OSError, subprocess.SubprocessError) as e:
        error = str(e)
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
            for m in answer.get("members") or []:
                if m.get("conv") in members:
                    conn.execute("UPDATE swarm_members SET summary = ?, summary_at = ?"
                                 " WHERE swarm_id = ? AND conv = ?",
                                 (m.get("summary"), now, swarm_id, m["conv"]))
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
    if answer:
        peermail.append_line(log_path, {"type": "assistant", "timestamp": now, "message": {
            "role": "assistant", "content": [{"type": "text", "text": _render(answer)}]}})
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
    log = store.DATA_DIR / "bot_chats" / ".turns" / f"helper-{swarm_id}.log"
    log.parent.mkdir(parents=True, exist_ok=True)
    cmd = [sys.executable, str(Path(__file__).resolve()), "run", str(swarm_id), trigger]
    if question_ids:
        cmd += ["--questions", ",".join(str(i) for i in question_ids)]
    env = {**os.environ, "EXOCORTEX_DATA_DIR": str(store.DATA_DIR),
           "EXOCORTEX_CONTENT_DIR": str(store.CONTENT_DIR)}
    with open(log, "ab") as errf:
        subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=errf, stderr=errf,
                         start_new_session=True, env=env)
    return True


def poke(swarm_id, trigger="turn"):
    """Something happened in the swarm. Run now if the helper is free and
    hasn't run recently; otherwise leave a note for the minute tick. This is
    a debounce: a burst of member turns becomes one run."""
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
    """The minute tick: run every helper that has something pending and is
    past its interval. Returns how many started."""
    started = 0
    index = store.read("bot_chats/index", {})
    for conv, entry in list(index.items()):
        if is_helper(entry) and entry.get("helper_pending"):
            if poke(entry["swarm_id"], entry["helper_pending"]):
                started += 1
    return started


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
            # Never leave the helper looking busy forever.
            with store.mutate("bot_chats/index", {}) as index:
                for entry in index.values():
                    if is_helper(entry) and entry.get("swarm_id") == swarm_id:
                        entry["running"] = False
            return 1
        return 0
    print("usage: swarm_helper.py run <swarm_id> [trigger] [--questions 1,2]", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    # Settle the data dir from the environment before anything caches it.
    if os.environ.get("EXOCORTEX_DATA_DIR"):
        store.DATA_DIR = Path(os.environ["EXOCORTEX_DATA_DIR"])
    sys.exit(main(sys.argv))
