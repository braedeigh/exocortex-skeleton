"""The ear's door: a listener in the room POSTs what it heard, and each
utterance becomes a journal card in the owner's own voice.

The listener is tools/ear/ear.py, running on a separate machine with a
microphone; it transcribes locally and sends only text. This module touches

  tools/stream/stream.py   record() mints the card (who B = the owner's words)
  cardstore.py             the SQL mirror of the card pool, echoed right away
  public_config.py         /api/ear/heard is listed there so the session gate
                           lets a cookie-less machine in; this route then
                           checks the shared secret itself (same pattern as
                           routes/push.py's hook door)

Three doors:
  POST /api/ear/heard   {secret, text, kind, closed_by, heard_at, device}
                        -> {ok, id, reply} or {ok, id, pending: {conv, offset}}
  GET  /api/ear/setup   (logged in) the url and secret to paste into the
                        listener — so setup is "open this page, copy two lines".

Every card is tagged `voice` (how it came in) and `via:<device>` (which
machine heard it) — the journal shows those two as a source chip, so a spoken
card reads differently from a typed one. A "hey exo …" command is also tagged
`exo-command`, and gets a spoken reply. Today the reply is only an
acknowledgement: commands are recorded, not acted on — the place for a real
dispatcher is _answer_command below.

An entry (kind note) says how it closed: `closed_by` "command" means the
owner said "send it" and wants to hear something back; "silence" means a
minute went by, so the entry is saved and nothing is said.

Who answers is a routing choice (_route): a journal entry goes to the
Keeper — the pinned Keeper session in the Observatory, the same one the
Keeper chat talks to — as an off-the-record turn (the ear already minted the
B card, so the capture hook must not mint a second). The Keeper's reply
comes back through a third door the listener polls, because a Keeper turn
takes longer than a request should wait:

  POST /api/ear/reply   {secret, conv, offset, card, device}
                        -> {done: false} | {done: true, reply}

When it lands, the reply is kept as a K card answering the entry, and the
listener speaks it. A "hey exo" command goes to the ear bot instead, which
today only acknowledges; the trigger-word and model router it should become
is in the build log. Owner's words: "I want keeper to be responsible for
journaling. So keeper is who responds in a session when I'm journaling. I
will need commands for other things. Maybe an ear bot or something that
decides where to route messages both with LLM and other trigger words."
"""
from __future__ import annotations

import fcntl
import hmac
import re
import secrets
from datetime import datetime

from flask import request, jsonify

import json

import cardstore
import store
from tools.stream import stream


def _secret_path():
    return store.DATA_DIR / "ear_secret"


def _secret() -> str:
    """The shared secret the listener authenticates with, generated on first
    need. Same lock pattern as routes/push.py: the file is read far more often
    than written, so the common path never takes the lock."""
    path = _secret_path()
    if path.exists():
        return path.read_text().strip()
    path.parent.mkdir(parents=True, exist_ok=True)
    lock_path = path.with_suffix(path.suffix + ".lock")
    with open(lock_path, "w") as lock_file:
        fcntl.flock(lock_file, fcntl.LOCK_EX)
        if not path.exists():
            path.write_text(secrets.token_hex(32))
            path.chmod(0o600)
    return path.read_text().strip()


def _parse_heard_at(raw) -> datetime:
    """When it was said, by the listener's clock; now if missing or unreadable.
    A spooled transcript replayed a day late keeps its true time, so it lands
    on the day it was spoken. An aware timestamp is folded into local time,
    which is what every other card carries."""
    if isinstance(raw, str) and raw.strip():
        try:
            parsed = datetime.fromisoformat(raw.strip())
            if parsed.tzinfo is not None:
                parsed = parsed.astimezone().replace(tzinfo=None)
            return parsed
        except ValueError:
            pass
    return datetime.now()


def _device_tag(raw) -> str:
    """`via:<device>` — the listening machine's name, made safe for a tag:
    lower-case letters, digits and dashes only, so it can never carry a comma
    or bracket into the card's front matter."""
    name = re.sub(r"[^a-z0-9]+", "-", str(raw or "").lower()).strip("-")[:40]
    return f"via:{name or 'unknown'}"


def _answer_command(text: str) -> str:
    """What the ear says back after a "hey exo" command. Only an
    acknowledgement for now: the command is on the record and nothing runs.
    A dispatcher that acts on commands goes here."""
    if not text:
        return "I'm listening, but I didn't catch a command."
    return "Got it."


def _route(kind: str, closed_by) -> str:
    """Where an utterance goes. A journal entry (a note) belongs to the
    Keeper; a "hey exo" command belongs to the ear bot. Trigger words and a
    model-based classifier for commands are the ear bot's next step; today
    this is the whole table."""
    return "earbot" if kind == "command" else "keeper"


def _keeper_conversation():
    """The pinned Keeper session — the one true diary door, found the way
    scripts/keeper_rollover.py finds it: the open, pinned conversation whose
    bot is the keeper, newest first if there is somehow more than one."""
    index = store.read("bot_chats/index", {})
    candidates = [(cid, meta) for cid, meta in index.items()
                  if isinstance(meta, dict) and meta.get("bot") == "keeper"
                  and meta.get("pinned") and not meta.get("archived")]
    if not candidates:
        return None
    candidates.sort(key=lambda c: c[1].get("last_at", ""), reverse=True)
    return candidates[0][0]


# How a spoken entry is handed to the Keeper. The Keeper has its own context
# and memory; this only says the channel is voice, so the reply is sized for
# the ear.
SPOKEN_FRAME = (
    "[Spoken aloud through the ear. Your reply will be read out loud: answer in "
    "one to three short plain sentences, no lists, no markdown.]\n\n{entry}"
)


def _ask_keeper(text: str):
    """Start the Keeper's turn on an entry. Returns ("pending", {conv, offset})
    when the turn is away — the listener polls /api/ear/reply for the words —
    or ("reply", sentence) when the Keeper can't take it right now, so the
    loop still closes out loud."""
    conv_id = _keeper_conversation()
    if not conv_id:
        return "reply", "Saved. The Keeper isn't awake right now."
    from routes import observatory
    result = observatory.begin_turn(conv_id, SPOKEN_FRAME.format(entry=text), record=False)
    if not result.get("ok"):
        if (result.get("body") or {}).get("busy"):
            return "reply", "Saved. The Keeper is busy right now."
        return "reply", "Saved. The Keeper couldn't be reached."
    return "pending", {"conv": conv_id, "offset": int(result.get("start_offset") or 0)}


def _result_after(log_path, offset: int):
    """The turn's final text, read from the conversation log past the byte
    where the turn began; None if no result line has been written yet."""
    try:
        with open(log_path, "r", encoding="utf-8") as fh:
            fh.seek(max(0, int(offset)))
            tail = fh.read()
    except OSError:
        return None
    text = None
    for line in tail.splitlines():
        if not line.startswith("{"):
            continue
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if event.get("type") == "result":
            text = str(event.get("result") or "")
    return text


def _keeper_reply(conv_id: str, offset: int):
    """None while the Keeper is still on it; its reply once the turn has
    ended (empty if the turn died without one)."""
    from routes import observatory
    entry = store.read("bot_chats/index", {}).get(conv_id)
    if not isinstance(entry, dict):
        return ""
    text = _result_after(observatory._chats_dir() / f"{conv_id}.jsonl", offset)
    if text is not None:
        return text.strip()
    if observatory._effective_running(conv_id, entry):
        return None
    return ""


def _record_reply(reply: str, answering: str, tags: list) -> None:
    """Keep what the Keeper said back as a K card answering the entry, so the
    exchange is on the record the way it was heard. Best-effort: a failure
    here must not lose the reply on its way to being spoken."""
    try:
        cid = stream.record(who="K", body=reply, reply_to=answering, tags=tags)
        _echo_mirror(cid)
    except Exception:
        pass


def _echo_mirror(cid: str):
    """Push the new card into the SQL mirror right away. Best-effort, like
    routes/cards.py: the mirror is derived, the hourly sync catches a miss,
    and a mirror problem must never lose what was just said."""
    try:
        cardstore.sync_one(cid)
    except Exception:
        pass


def register(app):

    @app.route("/api/ear/heard", methods=["POST"])
    def ear_heard():
        # Exempt from the session gate (see public_config), so it authenticates
        # itself: the secret in the body must match ear_secret exactly.
        data = request.get_json(silent=True) or {}
        if not hmac.compare_digest(_secret(), str(data.get("secret") or "")):
            return jsonify({"error": "forbidden"}), 403
        text = str(data.get("text") or "").strip()
        kind = "command" if data.get("kind") == "command" else "note"
        if not text and kind != "command":
            return jsonify({"error": "text required"}), 400
        tags = ["voice", _device_tag(data.get("device"))] + (["exo-command"] if kind == "command" else [])
        body = text or "(hey exo, then nothing)"
        try:
            cid = stream.record(who="B", body=body, tags=tags, ts=_parse_heard_at(data.get("heard_at")))
        except stream.StreamError as exc:
            return jsonify({"error": str(exc)}), 400
        _echo_mirror(cid)
        closed_by = data.get("closed_by") if data.get("closed_by") in ("command", "silence") else None
        answer = {"ok": True, "id": cid, "kind": kind, "closed_by": closed_by, "reply": ""}
        if _route(kind, closed_by) == "earbot":
            answer["reply"] = _answer_command(text)
        elif closed_by == "command":
            how, what = _ask_keeper(text)
            if how == "pending":
                answer["pending"] = {**what, "card": cid}
            else:
                answer["reply"] = what
        return jsonify(answer)

    @app.route("/api/ear/reply", methods=["POST"])
    def ear_reply():
        # The listener asks, every couple of seconds, whether the Keeper has
        # answered the entry it sent. Same secret as the heard door.
        data = request.get_json(silent=True) or {}
        if not hmac.compare_digest(_secret(), str(data.get("secret") or "")):
            return jsonify({"error": "forbidden"}), 403
        conv_id = str(data.get("conv") or "")
        card = str(data.get("card") or "")
        if not conv_id:
            return jsonify({"error": "conv required"}), 400
        reply = _keeper_reply(conv_id, data.get("offset") or 0)
        if reply is None:
            return jsonify({"done": False})
        if reply and card:
            _record_reply(reply, answering=card, tags=["voice", _device_tag(data.get("device"))])
        return jsonify({"done": True, "reply": reply})

    @app.route("/api/ear/setup")
    def ear_setup():
        # Behind the normal gate: only the logged-in owner sees the secret.
        return jsonify({
            "url": request.host_url.rstrip("/"),
            "secret": _secret(),
            "run": "./venv/bin/python3 ear.py --url <url> --secret <secret>",
        })
