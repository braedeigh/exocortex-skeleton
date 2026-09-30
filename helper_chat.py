"""A helper's chat — the swarm helper's, and the room helper's — one conversation
for its whole life, with a rolling context instead of a growing one.

**What this is, in plain English.** Every swarm has a helper session
(swarm_helper.py), and the owner can talk to it in its chat. A normal session
resumes the same model conversation turn after turn, so its context only
grows; the helper reads every member's status, so it used to fill its window
within hours, hand off, and lose the conversation to a successor. This file
stops that. Each turn in the helper's chat is a FRESH model session (nothing
is resumed — routes/observatory.begin_turn skips `--resume` for it), seeded
with a document written here just before the turn starts:

  1. the helper's standing instructions (CHAT_PROMPT), which tell it that its
     view is shaped like this and where to search for anything older, and
     that it never builds — it starts a new session to (spinoff_open.py),
     which tools/helper_gate.py enforces;
  2. the swarm as it is now — the swarm summary and one summary per member,
     all written by the Sonnet summarizer runs into SQL (swarms.overview) —
     minus members that finished over a day ago (swarms.in_helper_view),
     which are named in one line so she can still ask about them, and minus
     old helper sessions and their handoffs, which it isn't shown at all;
  3. the CHAT SUMMARY — one summary of the whole chat so far (her decisions
     word for word, what the helper last told her, promises, open threads),
     rewritten by a Sonnet call after every turn (rewrite_notes). The new one
     replaces the old; only the latest is ever handed over;
  4. her own last config.HELPER_CHAT_MESSAGES messages, word for word — hers
     only. The helper's replies, agents' mail and system notices are not
     replayed; the chat summary carries what mattered in them.

The room helper (room_helper.py) has the same chat, with its own first
paragraph (ROOM_LEAD) and, in place of part 2, the room overview — every
swarm, every session working alone, its recent moves — followed by its own
section of the files each open session has edited lately (edited_files.py).

So the seed stays about the same size however long the swarm runs, and to
her it's one continuous chat: same card, same conversation id, the whole
transcript still on disk for the helper to search. Only what the model is
handed rolls. The seed of the latest turn is kept at
bot_chats/helper_seed/<conv>.md, so what the helper was working from can
always be opened and read.

Touches: routes/observatory.py (begin_turn writes the seed and passes it as
the turn's system prompt file; after_turn calls rewrite_notes), swarm_helper.py
(ask_model — the same tool-less, structured model call its runs use),
swarms.py (the summaries), room_helper.py (the room overview), the session index (`helper_notes`,
`helper_notes_at` on the helper's entry — the chat summary), config.py
(HELPER_CHAT_MESSAGES),
continuation.py (which never continues this chat),
tests/test_helper_chat.py. Design: docs/swarms.md.

Prompt that produced this: "Make it such that the helper regenerates itself.
It might be a good idea to just have a rolling context window or something of
a certain number of messages and summaries along with its system prompt." —
and then: "I'm wondering if it could have a legit rolling context and never
start a new one while the swarm is still active until the whole thing
retires and then it does a closing check." — and then: "Can I go deeper such
that each turn just gets the last summary only, the summary of each agent as
written by a sonnet, and then whatever messages I have sent, up to maybe like
10 messages of mine? And its system prompt. It can search for past messages
across the whole system if it wants and knows it's shaped like this."
"""
import json
import subprocess
from datetime import datetime

from pathlib import Path

import config
import edited_files
import store

# The app checkout, for the search commands the helper is told about.
_REPO = Path(__file__).resolve().parent

# One message longer than this is cut, keeping its start. Verbatim is the
# point, but one pasted log shouldn't crowd out the other exchanges.
_MESSAGE_CHARS = 6000

SWARM_LEAD = """You are the helper for a swarm of AI coding agents working on one person's \
app — the owner, who talks to you in this chat. The agents became a swarm by messaging each \
other. You keep track of what all of them are doing, notice where their work overlaps or \
collides, and answer the owner's questions about the swarm."""

ROOM_LEAD = """You are the room helper for the {room} room of one person's app — the owner, \
who talks to you in this chat. AI coding agents work there in sessions; sessions that message \
each other form swarms, each with its own helper. You sit a layer above: on your own runs you \
form swarms from sessions working alone, join sessions to swarms, split swarms whose clusters \
stopped talking, and release sessions to work alone — each move posted here with its reason. \
In this chat you answer her questions about the room and make or undo moves when she asks, \
with `./venv/bin/python3 scripts/room_moves.py list | undo <id> | form <conv>... | \
join <swarm> <conv>... | split <swarm> <conv>... | release <conv>... --reason "…"` (add \
`--by-owner` when she asked for it). A session's continuations always move with it."""

CHAT_PROMPT = """{lead}

How your view is shaped: every turn of this chat starts fresh. You are NOT resuming a \
conversation. You are handed exactly four things, and nothing else:
1. these instructions;
2. {world_line};
3. the chat summary — one summary of this whole chat so far (her decisions, what you last \
told her, your promises, the open threads), rewritten after every turn;
4. her own last few messages, word for word. Your replies to them, agents' mail to you and \
system notices are NOT replayed — the chat summary carries what mattered in them.
Then comes whatever just arrived: her new message, an agent's mail, or a system notice.

So never claim to remember what isn't here. When the summaries aren't enough — what exactly \
you told her, what an agent actually did, something from before — look it up. Everything is \
searchable; run these from the app checkout, {repo}:
- This chat's full transcript, every line ever: {chats}/{conv}.jsonl \
(JSON lines; `grep -i` it for a word).
- Every session's transcript: {chats}/<session id>.jsonl — `grep -il <word> {chats}/*.jsonl` \
finds which sessions talked about something.
- One session's recent asks, replies and tool calls: `./venv/bin/python3 scripts/peers.py show <id>`.
- The database (read-only SQL): `EXOCORTEX_DATA_DIR={data} ./venv/bin/python3 scripts/exo_query.py \
query "<select>"`. `agent_messages` holds every message between sessions (and hers sent \
mid-turn); `tool_calls` every tool any agent ran; `swarms` the swarm summaries; `room_moves` the room helper's moves. \
`exo_query.py schema <table>` lists a table's columns.
- Git in {repo} is the truth about what shipped.
Say when an answer comes from a search rather than from what you were handed.

You never build. You don't edit files, run builds or tests, commit, or reload the site — \
and the app enforces it: only lookups get through (reading, searching, git's reading \
commands, peers.py, exo_query.py, request_input.py, spinoff_open.py, room_moves.py), and \
the one thing you may write is a new session's brief. When something needs building — she \
asks for a change, or a fix she agreed to — start a new session to build it:
1. If a session already on it can take it (a member working on that code), message it \
with `peers.py send` instead, passing her words exactly.
2. Otherwise write the brief with the Write tool to {spinoffs}/<slug>/BRIEF.md (slug: a \
few lowercase words joined by hyphens). Start it `# Spinoff: <one-line title>`, then \
`## The task` with her words quoted exactly and what you found, then `## Where to look`: \
the files it should start from, one path per line, relative to {repo} — each must exist, \
or the session isn't started.
3. Start it: `./venv/bin/python3 scripts/spinoff_open.py <slug>`. It starts working at \
once; `conversation_id` in the reply is the new session.
4. Tell her its id and what it's building, and keep tracking it (`peers.py show <id>`); \
pass her later words about that work on with `peers.py send <id> "…"`.
Build only what she asked for. An idea of your own, you put to her here first.

Plain words; the owner reads everything you write."""

NOTES_PROMPT = """You keep the chat summary for a helper's chat with its owner. Every \
turn of that chat starts from scratch, and the helper is handed only this summary, the \
status of the swarm or room it watches and the owner's last few messages — never its own \
past replies. So this summary is its only memory of what it said, and of anything older.

You get the current summary and the latest exchange. Return the complete new summary; it \
REPLACES the old one. Four sections, markdown bullets:
## Where it stands — what the helper last told her, in brief, so her next message makes \
sense against it (if she answers "yes, do that", this is what "that" is).
## Her decisions — what the owner decided, quoted word for word, with the date.
## Promises — what the helper said it would do, and for whom.
## Open threads — questions and asks not settled yet.
Carry forward everything still true. Drop what's resolved; when she changes her mind, replace \
the old decision with the new one. Never invent anything the exchange doesn't say. Keep it \
under about 700 words."""

NOTES_SCHEMA = {
    "type": "object",
    "properties": {"notes": {"type": "string"}},
    "required": ["notes"],
}


def _now():
    return datetime.now().isoformat(timespec="seconds")


def _cut(text):
    text = str(text or "").strip()
    return text if len(text) <= _MESSAGE_CHARS else text[:_MESSAGE_CHARS - 1] + "…"


# --- The exchanges ----------------------------------------------------------------

def _incoming(line):
    """(who, text) when a transcript line is a message TO the helper, else None."""
    kind = line.get("type")
    if kind == "user" and isinstance(line.get("text"), str):
        return "owner", line["text"]
    if kind == "reminder":
        return "the app (system message)", line.get("text") or ""
    if kind == "peer" and line.get("direction") == "in":
        who = line.get("from_title") or line.get("from_conv") or "an agent"
        return f"agent {who} ({line.get('from_conv')})", line.get("text") or ""
    return None


def _outgoing(line):
    """The helper's own words in a transcript line, or None.

    Its chat replies are the text of its top-level assistant messages (tool
    calls are left out — the replies say what they found). A summarizer run's
    unprompted update is left out too: the swarm summary in the seed already
    carries it. Those lines are marked `helper_update` (swarm_helper.run);
    older ones carry no model message id, which a real reply always has."""
    kind = line.get("type")
    if kind == "peer" and line.get("direction") == "out":
        who = line.get("to_title") or line.get("to_conv")
        return f"(message sent to {who}) {line.get('text') or ''}"
    if kind != "assistant" or line.get("parent_tool_use_id"):
        return None
    message = line.get("message") or {}
    if line.get("helper_update") or ("id" not in message and not line.get("helper_run")):
        return None
    texts = [b.get("text", "") for b in message.get("content") or []
             if isinstance(b, dict) and b.get("type") == "text" and b.get("text", "").strip()]
    return "\n\n".join(texts) or None


def exchanges(conv_id, limit=None):
    """The chat as exchanges, oldest first: each is what reached the helper
    (`in`: a list of (who, text)) and what it said back (`out`: a list of
    texts). A new exchange starts when a message arrives after the helper
    has spoken. `limit` keeps only the last so many."""
    path = store.DATA_DIR / "bot_chats" / f"{conv_id}.jsonl"
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return []
    found = []
    for raw in lines:
        try:
            line = json.loads(raw)
        except ValueError:
            continue
        if not isinstance(line, dict):
            continue
        arrived = _incoming(line)
        if arrived:
            if not found or found[-1]["out"]:
                found.append({"in": [], "out": [], "at": (line.get("ts") or "")[:19]})
            found[-1]["in"].append(arrived)
            continue
        said = _outgoing(line)
        if said:
            if not found:
                found.append({"in": [], "out": [], "at": ""})
            found[-1]["out"].append(said)
    return found[-limit:] if limit else found


def her_messages(conv_id, limit=None):
    """Her own messages in the chat, oldest first, as (timestamp, text) —
    only what the owner typed; nothing the helper, an agent or the app said.
    `limit` keeps only the last so many."""
    found = [(x["at"], text) for x in exchanges(conv_id)
             for who, text in x["in"] if who == "owner"]
    return found[-limit:] if limit else found


def _render_exchange(exchange):
    lines = [f"### {exchange['at'] or 'earlier'}"]
    for who, text in exchange["in"]:
        lines += [f"**From {who}:**", _cut(text), ""]
    for text in exchange["out"]:
        lines += ["**You said:**", _cut(text), ""]
    return "\n".join(lines)


# --- The seed ---------------------------------------------------------------------

def _swarm_now(swarm_id):
    """The swarm as the summarizer last wrote it, read fresh from SQL."""
    import swarms
    card = next((c for c in swarms.overview() if c["id"] == swarm_id), None)
    if card is None:
        return "(This swarm no longer exists — it was merged into another or dissolved.)"
    out = [f"Name: {card['name']}", f"Summary (as of {card.get('summary_at') or 'never'}):",
           card.get("summary") or "(none yet)", "", "Members:"]
    # Only the members still in view: one that finished over a day ago drops out.
    index = store.read("bot_chats/index", {})
    shown, dropped = swarms.in_helper_view(card["members"], index if isinstance(index, dict) else {})
    for m in shown:
        status = "retired" if m.get("retired") else m["state"]
        out.append(f"- `{m['conv']}` {m['title']} — {status}, room {m['lane']}. "
                   + (m.get("summary") or "(no summary yet)"))
    if dropped:
        out.append(f"({len(dropped)} more finished over {config.SWARM_HELPER_FORGET_HOURS:g}h ago"
                   " and aren't listed: " + ", ".join(f"`{m['conv']}`" for m in dropped)
                   + ". Search their transcripts if she asks about them.)")
    return "\n".join(out)


def seed_text(conv_id, entry):
    """Everything one chat turn starts from, as one document (see the top of
    the file for the four parts)."""
    chats = store.DATA_DIR / "bot_chats"
    # The world it watches: a room helper's room, or a swarm helper's swarm.
    if entry.get("role") == "room_helper":
        import room_helper
        room = entry.get("room") or "coding"
        lead = ROOM_LEAD.format(room=room)
        world_line = ("the room now — every swarm with its summaries and clusters, every "
                      "session working alone, and your recent moves — and, as its own section, "
                      "the files every open session has edited lately, with any file two of "
                      "them share flagged")
        # The files section stands apart from the summaries (edited_files.py).
        world = [f"# The {room} room now", "", room_helper.room_overview(room), "",
                 edited_files.section(room)]
    else:
        lead = SWARM_LEAD
        world_line = ("the swarm now — its summary and one summary per agent, written by a "
                      "summarizer model")
        world = [f"# The swarm now (swarm {entry.get('swarm_id')})", "",
                 _swarm_now(entry.get("swarm_id"))]
    prompt = CHAT_PROMPT.format(lead=lead, world_line=world_line, repo=_REPO, chats=chats,
                                conv=conv_id, data=store.DATA_DIR, spinoffs=store.SPINOFF_DIR)
    mine = her_messages(conv_id, limit=config.HELPER_CHAT_MESSAGES)
    parts = [prompt, "", *world, "",
             f"# The chat summary (last rewritten {entry.get('helper_notes_at') or 'never'})", "",
             entry.get("helper_notes") or "(none yet)", "",
             f"# Her last {len(mine)} messages, word for word", ""]
    parts += [f"### {at or 'earlier'}\n{_cut(text)}\n" for at, text in mine] \
        or ["(none yet — this is the first)"]
    return "\n".join(parts) + "\n"


def write_seed(conv_id, entry):
    """Write this turn's seed to disk and return its path, for the turn's
    `system_prompt_file`. The file is overwritten each turn: it's what the
    helper is working from NOW, kept so it can be opened and read."""
    folder = store.DATA_DIR / "bot_chats" / "helper_seed"
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"{conv_id}.md"
    path.write_text(seed_text(conv_id, entry), encoding="utf-8")
    return str(path)


# --- The chat summary (stored as `helper_notes`) ------------------------------------------------------------

def _call_notes(text):
    """One Sonnet call for the new chat summary. Returns (summary, cost)."""
    import swarm_helper
    answer, cost = swarm_helper.ask_model(text, NOTES_PROMPT, NOTES_SCHEMA)
    return str(answer.get("notes") or "").strip(), cost


def rewrite_notes(conv_id):
    """After a chat turn: rewrite the chat summary from the old one and the
    exchange that just happened (her message AND the helper's reply — the
    reply is kept only here). The new summary REPLACES the old — the same
    "replaced, not accumulated" rule the summaries follow. Returns the new
    summary, or None when there was nothing to do or the call failed (the old
    one stays, and the failure is written on the entry)."""
    entry = store.read("bot_chats/index", {}).get(conv_id)
    if not isinstance(entry, dict) or entry.get("role") not in ("swarm_helper", "room_helper"):
        return None
    # The first summary reads further back. With no summary yet (a new chat,
    # or one that ran before summaries existed), it's written from the last
    # HELPER_CHAT_MESSAGES exchanges, so the helper's earlier replies aren't
    # lost; after that, each rewrite needs only the latest exchange.
    first = not entry.get("helper_notes")
    latest = exchanges(conv_id, limit=config.HELPER_CHAT_MESSAGES if first else 1)
    if not latest or not latest[-1]["out"]:
        return None
    text = "\n".join(["# Current summary", "", entry.get("helper_notes") or "(none yet)", "",
                      "# The earlier exchanges" if first and len(latest) > 1
                      else "# The latest exchange", ""]
                     + [_render_exchange(x) for x in latest])
    try:
        notes, cost = _call_notes(text)
    except (RuntimeError, OSError, ValueError, subprocess.SubprocessError) as e:
        with store.mutate("bot_chats/index", {}) as index:
            if isinstance(index.get(conv_id), dict):
                index[conv_id]["helper_notes_error"] = str(e)[:400]
        return None
    if not notes:
        return None
    with store.mutate("bot_chats/index", {}) as index:
        live = index.get(conv_id)
        if isinstance(live, dict):
            live["helper_notes"] = notes
            live["helper_notes_at"] = _now()
            live.pop("helper_notes_error", None)
            live["cost_usd"] = round(float(live.get("cost_usd") or 0) + float(cost or 0), 6)
    return notes
