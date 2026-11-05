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

Two doors:
  POST /api/ear/heard   {secret, text, kind, heard_at, device} -> {ok, id, reply}
  GET  /api/ear/setup   (logged in) the url and secret to paste into the
                        listener — so setup is "open this page, copy two lines".

Every card is tagged `voice` (how it came in) and `via:<device>` (which
machine heard it) — the journal shows those two as a source chip, so a spoken
card reads differently from a typed one. A "hey exo …" command is also tagged
`exo-command`, and gets a spoken reply. Today the reply is only an
acknowledgement: commands are recorded, not acted on — the place for a real
dispatcher is _answer_command below.
"""
from __future__ import annotations

import fcntl
import hmac
import re
import secrets
from datetime import datetime

from flask import request, jsonify

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
        reply = _answer_command(text) if kind == "command" else ""
        return jsonify({"ok": True, "id": cid, "kind": kind, "reply": reply})

    @app.route("/api/ear/setup")
    def ear_setup():
        # Behind the normal gate: only the logged-in owner sees the secret.
        return jsonify({
            "url": request.host_url.rstrip("/"),
            "secret": _secret(),
            "run": "./venv/bin/python3 ear.py --url <url> --secret <secret>",
        })
