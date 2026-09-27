"""Self-continuing sessions — a Coding session that fills its context hands off
to a fresh one, with nobody watching.

**What this does, in plain English.** Every model call reports how much the
model is reading — the session's context size — and the turn loop keeps the
latest number on the session (`context_tokens`, routes/observatory.py
_note_model_call). Each model has a soft cap (config.CONTEXT_CAPS: Opus 120k,
Fable 250k, …). Crossing it never interrupts anything: the turn finishes the
work it's on. When that turn ENDS, if the session is in a room that continues
itself (config.CONTINUE_LANES — Coding), this:

  1. asks the agent — a System message, `[System · context cap]` — to write a
     handoff: the goal, what's done, what's left, decisions and why, open
     questions, the files in play;
  2. when the agent runs `peers.py handoff`, writes a brief from it — the
     handoff, the files the old session read and wrote, and its swarm — and
     opens a fresh session on it (routes/spinoff.open_spinoff, `via
     "continue"`, same room, same model), which starts working at once;
  3. archives the old session once its last turn ends, and points it at its
     successor, so messages other agents send to the old one reach the new one
     (peermail.send follows `continued_by`).

Touches: config.py (the caps and rooms), routes/observatory.py (reads the
context size it keeps; queue_followup for the ask; `after_turn` calls check()),
routes/spinoff.py (open_spinoff), scripts/extract_footprints.py (the files in
play), swarms.py (who the session works with), scripts/peers.py (the agent's
`handoff` door), tests/test_continuation.py. Design: docs/swarms.md, stage 2.

Prompt that produced this: "let each session create their own unsupervised
/spinoffs once they reach a token limit and describe what work they need to
continue doing. That'll reload the session from scratch, using the stored
agent file interactions ... opus should be like 120k but let it run past the
120k until it's done ... coding keeps itself unsupervised."
"""
import re
from datetime import datetime

import config
import lanes
import store

# The model families the caps are keyed by, matched inside a model name
# ("claude-opus-5-5", "opus[1m]" → opus). First match wins.
_FAMILIES = ("fable", "opus", "sonnet", "haiku")


def _now():
    return datetime.now().isoformat(timespec="seconds")


def family(model):
    name = (model or "").lower()
    return next((f for f in _FAMILIES if f in name), None)


def cap_for(entry):
    """This session's soft cap in tokens, or None when its model has none.
    The model the calls actually ran on wins over the one it was set to."""
    fam = family(entry.get("context_model")) or family(entry.get("model"))
    return config.CONTEXT_CAPS.get(fam) if fam else None


def due(entry):
    """Should this session hand off now? Only between turns, only in a room
    that continues itself, only once, and never a journaling session."""
    if not isinstance(entry, dict) or entry.get("running") or entry.get("archived"):
        return False
    if entry.get("journal") is True or (entry.get("continuation") or {}).get("state"):
        return False
    if lanes.derive_lane(entry) not in config.CONTINUE_LANES:
        return False
    cap = cap_for(entry)
    return bool(cap) and int(entry.get("context_tokens") or 0) >= cap


def ask_text(entry):
    fam = family(entry.get("context_model")) or family(entry.get("model")) or "this model"
    return (
        f"[System · context cap] This session's context is at "
        f"{int(entry.get('context_tokens') or 0):,} tokens, past the "
        f"{cap_for(entry):,}-token cap for {fam}. Don't start anything new. "
        "Write your handoff now, so a fresh session can carry on from it: run\n"
        "  ./venv/bin/python3 scripts/peers.py handoff --file <path>\n"
        "with a markdown file covering: the goal; what's done (commit hashes); "
        "what's left, in order; decisions made and why; open questions; and "
        "anything a newcomer would get wrong. The files you read and wrote are "
        "attached for it automatically. It starts on its own once you've run "
        "that, and this session is then archived. (Sent by the app, not the "
        "owner.)"
    )


def check(conv_id):
    """At the end of a turn: ask for the handoff if it's due. Returns True if
    it asked. The ask is a System follow-up, so it starts the next turn (or
    waits for the one that's just begun)."""
    entry = store.read("bot_chats/index", {}).get(conv_id)
    if not due(entry):
        return False
    from routes import observatory
    text = ask_text(entry)
    with store.mutate("bot_chats/index", {}) as index:
        live = index.get(conv_id)
        if not due(live):
            return False            # someone else got here first
        live["continuation"] = {"state": "asked", "at": _now(),
                                "context_tokens": live.get("context_tokens")}
    observatory.queue_followup(conv_id, text, system={
        "display": text, "journal": text, "source": "continuation",
        "item_id": None})
    return True


def _slug(conv_id):
    """A spinoff slug for the continuation: `cont-` + the conversation's
    digits, which are unique per session."""
    return ("cont-" + re.sub(r"[^0-9]", "", conv_id))[:39]


def _files_in_play(conv_id, entry, limit=40):
    """The files the old session read and wrote, most-written first."""
    from scripts.extract_footprints import harvest_conversation
    path = store.DATA_DIR / "bot_chats" / f"{conv_id}.jsonl"
    try:
        touched = harvest_conversation(path, entry.get("cwd"))
    except Exception:
        return []
    ranked = sorted(touched.items(), key=lambda kv: (
        -(kv[1].get("writes", 0) + kv[1].get("creates", 0)), -kv[1].get("reads", 0)))
    return [(p, t) for p, t in ranked[:limit]]


def brief_text(conv_id, entry, handoff):
    """The new session's brief: how to start, the handoff, the files, the
    swarm. open_spinoff sends this text itself as the first message, and since
    it carries its own Protocol section, no default one is added.

    The files go under "Files in play", not "Where to look", on purpose: Where
    to look would preload every one into the new session (up to ~200 KB of a
    context that is meant to start fresh), and one deleted file would refuse
    the spawn. Here they are pointers the session reads as the work needs."""
    title = entry.get("title") or conv_id
    lines = [
        f"# Continuing “{title}”",
        "",
        f"You are taking over from Observatory session `{conv_id}`, which filled "
        "its context window and handed off to you. Nothing of its conversation "
        "is loaded into yours — only what's below.",
        "",
        "## Protocol",
        "",
        "1. Read the handoff below; it's the previous session's own account.",
        "2. Read the files under “Files in play” that the remaining work touches "
        "before you edit them — don't assume their contents.",
        "3. Run `./venv/bin/python3 scripts/peers.py list` (and `peers.py swarm` "
        "if you're in one) to see who else is working. If the previous session "
        "was talking to other agents, tell them you've taken over.",
        "4. Carry on with what's left. Commit as things ship.",
        "",
        "## Handoff (written by the previous session)",
        "",
        handoff.strip(),
        "",
        "## Files in play (from the previous session's tool calls)",
        "",
    ]
    files = _files_in_play(conv_id, entry)
    if files:
        for path, t in files:
            lines.append(f"- `{path}` — writes {t.get('writes', 0) + t.get('creates', 0)},"
                         f" reads {t.get('reads', 0)}")
    else:
        lines.append("- (none recorded)")
    try:
        import swarms
        swarm_id = swarms.swarm_of(conv_id)
        if swarm_id is not None:
            card = next((s for s in swarms.overview() if s["id"] == swarm_id), None)
            if card:
                lines += ["", f"## Swarm: {card['name']}", ""]
                if card.get("summary"):
                    lines += [card["summary"], ""]
                for m in card["members"]:
                    if m["conv"] != conv_id:
                        lines.append(f"- `{m['conv']}` {m['title']} ({m['state']})"
                                     + (f" — {m['summary']}" if m.get("summary") else ""))
    except Exception:
        pass
    return "\n".join(lines) + "\n"


def hand_off(conv_id, handoff):
    """The agent's handoff arrives: open the fresh session on it. Returns the
    reply dict; raises ValueError / KeyError on refusal."""
    handoff = (handoff or "").strip()
    if len(handoff) < 40:
        raise ValueError("the handoff is too short to carry on from — write it out")
    entry = store.read("bot_chats/index", {}).get(conv_id)
    if not isinstance(entry, dict):
        raise KeyError(conv_id)
    already = (entry.get("continuation") or {}).get("to")
    if already:
        return {"ok": True, "conversation_id": already, "newly_spawned": False}
    slug = _slug(conv_id)
    folder = store.SPINOFF_DIR / slug
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "BRIEF.md").write_text(brief_text(conv_id, entry, handoff), encoding="utf-8")
    from routes.spinoff import open_spinoff
    model = entry.get("model") or family(entry.get("context_model"))
    payload, status = open_spinoff(slug, start=True, lane=lanes.derive_lane(entry),
                                   model=model, parent=conv_id, via="continue")
    if status != 200:
        raise ValueError(payload.get("error") or f"spinoff refused ({status})")
    new_id = payload["conversation_id"]
    with store.mutate("bot_chats/index", {}) as index:
        live = index.get(conv_id)
        if isinstance(live, dict):
            live["continuation"] = {**(live.get("continuation") or {}),
                                    "state": "handed_off", "to": new_id, "at": _now()}
            live["continued_by"] = new_id
            # Archived once its last turn ends (after_turn), not now — it's
            # still mid-reply, and hiding a card that's talking is confusing.
            live["archive_after_turn"] = True
        child = index.get(new_id)
        if isinstance(child, dict):
            child["title"] = f"{entry.get('title') or conv_id} (cont.)"
    return payload


def successor(conv_id, index=None):
    """Follow `continued_by` to the live session now doing this one's work."""
    index = index if index is not None else store.read("bot_chats/index", {})
    seen = set()
    while conv_id not in seen:
        seen.add(conv_id)
        nxt = (index.get(conv_id) or {}).get("continued_by")
        if not nxt or nxt not in index:
            return conv_id
        conv_id = nxt
    return conv_id
