"""The swarm helper's chat — one conversation for the swarm's whole life, with a
rolling context instead of a growing one.

**What this is, in plain English.** Every swarm has a helper session
(swarm_helper.py), and the owner can talk to it in its chat. A normal session
resumes the same model conversation turn after turn, so its context only
grows; the helper reads every member's status, so it used to fill its window
within hours, hand off, and lose the conversation to a successor. This file
stops that. Each turn in the helper's chat is a FRESH model session (nothing
is resumed — routes/observatory.begin_turn skips `--resume` for it), seeded
with a document written here just before the turn starts:

  1. the helper's standing instructions (CHAT_PROMPT);
  2. the swarm as it is now — the latest swarm summary and member summaries
     the summarizer runs wrote to SQL (swarms.overview);
  3. its RUNNING NOTES — her decisions word for word, promises made, open
     threads — which a small model call rewrites after every turn
     (rewrite_notes). They replace the old notes, never pile up;
  4. the last config.HELPER_CHAT_EXCHANGES exchanges, word for word.

So the seed stays about the same size however long the swarm runs, and to
her it's one continuous chat: same card, same conversation id, the whole
transcript still on disk. Only what the model is handed rolls. The seed of
the latest turn is kept at bot_chats/helper_seed/<conv>.md, so what the
helper was working from can always be opened and read.

Touches: routes/observatory.py (begin_turn writes the seed and passes it as
the turn's system prompt file; after_turn calls rewrite_notes), swarm_helper.py
(ask_model — the same tool-less, structured model call its runs use),
swarms.py (the summaries), the session index (`helper_notes`,
`helper_notes_at` on the helper's entry), config.py (HELPER_CHAT_EXCHANGES),
continuation.py (which never continues this chat),
tests/test_helper_chat.py. Design: docs/swarms.md.

Prompt that produced this: "Make it such that the helper regenerates itself.
It might be a good idea to just have a rolling context window or something of
a certain number of messages and summaries along with its system prompt." —
and then: "I'm wondering if it could have a legit rolling context and never
start a new one while the swarm is still active until the whole thing
retires and then it does a closing check."
"""
import json
import subprocess
from datetime import datetime

import config
import store

# One message longer than this is cut, keeping its start. Verbatim is the
# point, but one pasted log shouldn't crowd out the other exchanges.
_MESSAGE_CHARS = 6000

CHAT_PROMPT = """You are the helper for a swarm of AI coding agents working on one person's \
app — the owner, who talks to you in this chat. The agents became a swarm by messaging each \
other. You keep track of what all of them are doing, notice where their work overlaps or \
collides, and answer the owner's questions about the swarm.

How your memory works: every turn of this chat starts fresh. You are NOT resuming a \
conversation. What you know is exactly what's below — the swarm as it is right now (written \
by the swarm's summarizer), your running notes (her decisions, your promises, the open \
threads), and the last few exchanges word for word. Anything older than that is gone from \
your view unless the notes carry it, so trust the notes, and never claim to remember what \
isn't here. The full transcript is on disk if you truly need to look something up.

Plain words; the owner reads everything you write."""

NOTES_PROMPT = """You keep the running notes for a swarm helper's chat with its owner. Every \
turn of that chat starts from scratch, so these notes are the helper's only memory of \
anything older than the last few exchanges.

You get the current notes and the latest exchange. Return the complete new notes; they \
REPLACE the old ones. Three sections, markdown bullets:
## Her decisions — what the owner decided, quoted word for word, with the date.
## Promises — what the helper said it would do, and for whom.
## Open threads — questions and asks not settled yet.
Carry forward everything still true. Drop what's resolved; when she changes her mind, replace \
the old decision with the new one. Never invent anything the exchange doesn't say. Keep it \
under about 600 words."""

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
    for m in card["members"]:
        status = "retired" if m.get("retired") else m["state"]
        out.append(f"- `{m['conv']}` {m['title']} — {status}, room {m['lane']}. "
                   + (m.get("summary") or "(no summary yet)"))
    return "\n".join(out)


def seed_text(conv_id, entry):
    """Everything one chat turn starts from, as one document (see the top of
    the file for the four parts)."""
    recent = exchanges(conv_id, limit=config.HELPER_CHAT_EXCHANGES)
    parts = [CHAT_PROMPT, "",
             f"# The swarm now (swarm {entry.get('swarm_id')})", "",
             _swarm_now(entry.get("swarm_id")), "",
             f"# Your running notes (last rewritten {entry.get('helper_notes_at') or 'never'})", "",
             entry.get("helper_notes") or "(none yet)", "",
             f"# The last {len(recent)} exchanges, word for word", ""]
    parts += [_render_exchange(x) for x in recent] or ["(none yet — this is the first)"]
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


# --- The running notes ------------------------------------------------------------

def _call_notes(text):
    """One small model call for the new notes. Returns (notes, cost)."""
    import swarm_helper
    answer, cost = swarm_helper.ask_model(text, NOTES_PROMPT, NOTES_SCHEMA)
    return str(answer.get("notes") or "").strip(), cost


def rewrite_notes(conv_id):
    """After a chat turn: rewrite the running notes from the old notes and the
    exchange that just happened. The new notes REPLACE the old — the same
    "replaced, not accumulated" rule the summaries follow. Returns the new
    notes, or None when there was nothing to do or the call failed (the old
    notes stay, and the failure is written on the entry)."""
    entry = store.read("bot_chats/index", {}).get(conv_id)
    if not isinstance(entry, dict) or entry.get("role") != "swarm_helper":
        return None
    latest = exchanges(conv_id, limit=1)
    if not latest or not latest[0]["out"]:
        return None
    text = "\n".join(["# Current notes", "", entry.get("helper_notes") or "(none yet)", "",
                      "# The latest exchange", "", _render_exchange(latest[0])])
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
