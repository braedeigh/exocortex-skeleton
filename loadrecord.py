"""What a session has already been handed — one record per session.

**What this does, in plain English.** A Keeper is handed journal cards from
two places: the boot package it wakes with (`scripts/boot_context.py`) and the
pack that loads when the owner names a person or thread
(`tools/mention_context.py`). Without a shared record the two hand over the
same cards twice. This file keeps that record: one small JSON file per
session, at `bot_chats/mention_context/<session>.json` in the data folder,
holding three lists:

  - `names` — the people and threads whose pack has loaded (`person:<slug>`,
    `thread:<slug>`), so each loads once.
  - `cards` — the id of every card the session has been handed.
  - `texts` — a short fingerprint of each card's words, and of each message
    the owner has typed in the session. Two cards with the same words have
    different ids, and a card made from a message she just typed is already
    in the chat; the fingerprint catches both.

Anything on the record is skipped by every later load. The record is written
by replacing the whole file in one step, so a reader never sees half of it.

**The tracker.** `log()` also writes one row per load to the `context_loads`
table in exo.db: when, which conversation, which person or thread, the word
that set it off, which cards were handed over and how many were left out.
`scripts/context_loads.py` prints those rows beside the reply that followed
each one, so the loads can be judged by what they led to.

An older record is a bare list of names; it is read as `names` with the other
two empty.

Touches: `store.py` (where the data folder is), `sqlstore.py` (the tracker's
table), and its two callers above.

Prompt: "Keep one per-session record of card ids already loaded (boot plus
every mention pack). Every later load skips ids on that record." / "I want
some kind of tracker to measure when a thread is loaded and to what response
so that my LLMs can comb through them and understand better what's working
and what's not in terms of memory."
"""
import hashlib
import json
import os
import re
from datetime import datetime

import store

# A file the owner attached, as it is written into a card or a message.
UPLOAD_MARKER = re.compile(r"\[uploaded: [^\]\n]+\]")


def folder():
    return store.DATA_DIR / "bot_chats" / "mention_context"


def _path(session_key):
    safe = re.sub(r"[^A-Za-z0-9._-]", "_", session_key)[:120]
    return folder() / f"{safe}.json"


def fingerprint(text):
    """A short fingerprint of some words, or None when there are no words.

    Attached-file markers are dropped and capitals and spacing are ignored, so
    a message and the card made from it get the same fingerprint. Text under
    12 characters gets none: "ok" and "yes" are said many times and each is
    its own moment."""
    words = " ".join(UPLOAD_MARKER.sub(" ", text or "").lower().split())
    if len(words) < 12:
        return None
    return hashlib.sha1(words.encode("utf-8")).hexdigest()[:16]


def read(session_key):
    """The session's record as {"names", "cards", "texts"}, each a set. A
    session with no record, or an unreadable one, gets three empty sets."""
    record = {"names": set(), "cards": set(), "texts": set()}
    try:
        stored = json.loads(_path(session_key).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return record
    if isinstance(stored, list):
        record["names"] = set(stored)
    elif isinstance(stored, dict):
        for part in record:
            record[part] = set(stored.get(part) or [])
    return record


def add(session_key, names=(), cards=(), texts=()):
    """Put more on the session's record and return the whole record.

    `texts` are words (card bodies, or a message she typed), not fingerprints;
    each is fingerprinted here."""
    record = read(session_key)
    record["names"].update(names)
    record["cards"].update(cards)
    record["texts"].update(mark for mark in map(fingerprint, texts) if mark)
    folder().mkdir(parents=True, exist_ok=True)
    path = _path(session_key)
    # Write-then-rename: the record is replaced in one step.
    temporary = path.with_name(path.name + f".{os.getpid()}.tmp")
    temporary.write_text(json.dumps({part: sorted(record[part]) for part in record}),
                         encoding="utf-8")
    os.replace(temporary, path)
    return record


def has(record, card_id, body):
    """True when this card is already on the record, by id or by its words."""
    return card_id in record["cards"] or fingerprint(body) in record["texts"]


def log(session_key, source, outcome, entry=None, matched=None, card_ids=(), skipped=0):
    """Write one row to the tracker: this session was handed this, now.

    `source` is 'boot' or 'mention'. For a mention, `entry` is the person or
    thread ({kind, slug, name}) and `matched` the word in her message that set
    it off. Never raises: the tracker must not cost a wake or a message."""
    try:
        import sqlstore
        entry = entry or {}
        card_ids = list(card_ids)
        conn = sqlstore.open_db()
        try:
            conn.execute(
                "INSERT INTO context_loads (at, conv, source, kind, slug, name, matched,"
                " outcome, cards, card_ids, skipped) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (datetime.now().isoformat(timespec="seconds"), session_key, source,
                 entry.get("kind"), entry.get("slug"), entry.get("name"), matched,
                 outcome, len(card_ids), json.dumps(card_ids), int(skipped)))
            conn.commit()
        finally:
            conn.close()
    except Exception:
        pass
