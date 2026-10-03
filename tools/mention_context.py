#!/usr/bin/env python3
"""Context on mention — the first time the owner names a person or a thread in
a session, hand the agent her recent journal cards about them.

**What this does, in plain English.** It is a Claude Code `UserPromptSubmit`
hook: it runs by itself on every message the owner sends, before the agent
reads it. It looks in the message for the name (or a filed alias) of anyone in
the vault's `people/` folder or any thread in `Threads/`. For each one it has
not already loaded in this session, it reads her own journal cards about them
out of the database (`exo.db`: `cards`, `card_tags`, `tags`, `cards_fts`) and
prints them. Whatever a hook of this kind prints lands in the agent's context,
so the agent starts its reply already holding the history, without searching.

**How much.** The last `MENTION_CONTEXT_DAYS` days (30), capped at the newest
`MENTION_CONTEXT_CARDS` cards (20). If that window is empty: the newest 20
cards ever, however old. Only her own cards (`who = 'B'`).

**"About them"** means a card tagged with their slug, or a card whose text
names them. Both, because tagging happens overnight: today's cards about
someone are not tagged yet.

**Once per session.** What was loaded is remembered in a small file per
session (`bot_chats/mention_context/<session>.json` in the data folder).

**Where the names come from.** The database has no table of people or aliases,
so the names to listen for are read from the vault files, through the same
parsers the app uses (`routes/entities.py`, `routes/threads.py`), and kept in a
cache file that is rebuilt whenever a people or thread file changes. The
history itself always comes from the database.

**The size limit.** The harness swaps a hook's output for a "saved to a file"
note once it passes about 10,000 characters (measured on Claude Code 2.1.285),
so everything printed in one run is kept under `OUTPUT_BUDGET`: long cards are
cut, and if several names arrive in one message, the ones that don't fit wait
for their next mention.

**It can never block a message.** Any failure ends in silence and exit 0.

**Who runs it.** `routes/observatory.py` `_session_settings` wires it into
Observatory sessions in the rooms named by `config.MENTION_CONTEXT_ROOMS`.
A terminal session gets it from an install's own `.claude/settings.json` with
`--terminal`, which makes it wait until the session has armed itself with
`/journalstart` or `/thread` (the same test `tools/stream/keeper_capture.py`
uses), so a build session at the same folder is left alone.

Prompt: "The first time someone is mentioned in a session, the hook runs and
pulls up the last month of data or the last 20 messages about them. This comes
from the database and is injected and the keeper will know this can happen.
Same for threads that are auto tagging."
"""
import json
import os
import re
import sqlite3
import sys
from contextlib import closing
from datetime import date, datetime, timedelta
from pathlib import Path

SKELETON = Path(__file__).resolve().parents[1]
if str(SKELETON) not in sys.path:
    sys.path.insert(0, str(SKELETON))

import config as app_config  # noqa: E402
import store  # noqa: E402

# Everything one run prints stays under this many characters — see "The size
# limit" in the block above.
OUTPUT_BUDGET = 9000
# The least room worth giving one person or thread. A name that would get less
# than this waits for its next mention instead.
SMALLEST_SHARE = 1200
# How long a single card may run, tried longest first until the pack fits.
CARD_LENGTHS = (1500, 800, 400, 240, 160)

# Text the harness puts on the prompt channel that is not the owner talking.
SYNTHETIC_PREFIXES = (
    "<task-notification>", "<system-reminder>", "<local-command-stdout>",
    "<command-message>", "<command-name>", "<command-args>",
)
# The header line of one message in a labelled batch (peermail.compose):
# `[B · name]` is the owner, `[A · …]` another agent.
_BATCH_HEADER = re.compile(r"^\[(B|A) · [^\]\n]*\]\s*$", re.MULTILINE)
# Where the app's own note starts when it is appended to her message
# (routes/observatory.py `_reopen_note`).
_APP_NOTE = "\n\n[System:"


def _state_dir():
    return store.DATA_DIR / "bot_chats" / "mention_context"


# --- The names to listen for -------------------------------------------------

def _names_signature():
    """A fingerprint of the people and thread folders: how many files, and the
    newest change time. When it differs from the cached one, a file was added,
    removed or edited, and the names are read again."""
    parts = []
    for folder in ("people", "Threads"):
        newest, count = 0, 0
        try:
            for path in (store.CONTENT_DIR / folder).glob("*.md"):
                count += 1
                newest = max(newest, path.stat().st_mtime_ns)
        except OSError:
            pass
        parts.append(f"{folder}:{count}:{newest}")
    return "|".join(parts)


def _read_names():
    """Every person and thread as {key, kind, slug, name, file, terms}, read
    from the vault files through the app's own parsers. `terms` are the words
    that count as a mention: a person's first name, full name and aliases; a
    thread's name and aliases."""
    # Imported here, not at the top: these pull in Flask, which costs a third
    # of a second, and the cache below means most runs never need them.
    from routes import entities, threads

    names = []
    for person in entities.people_index().values():
        terms = [person["name"].split()[0] if person["name"].split() else "",
                 person["name"]] + list(person.get("aliases") or [])
        names.append({
            "key": f"person:{Path(person['file']).stem}", "kind": "person",
            "slug": Path(person["file"]).stem, "name": person["name"],
            "file": person["file"], "terms": _clean_terms(terms),
        })
    for thread in threads.threads_index().values():
        terms = [thread["name"]] + list(thread.get("aliases") or [])
        names.append({
            "key": f"thread:{thread['id']}", "kind": "thread",
            "slug": thread["id"], "name": thread["name"],
            "file": thread["file"], "terms": _clean_terms(terms),
        })
    return names


def _clean_terms(terms):
    """Drop blanks and repeats (case-insensitively), keeping the first spelling."""
    seen, out = set(), []
    for term in terms:
        term = (term or "").strip()
        if term and term.lower() not in seen:
            seen.add(term.lower())
            out.append(term)
    return out


def load_names():
    """The names to listen for — a cache that is rebuilt when a people or
    thread file changes. The cache file sits beside the per-session state."""
    signature = _names_signature()
    cache_path = _state_dir() / "_names.json"
    try:
        cached = json.loads(cache_path.read_text(encoding="utf-8"))
        if cached.get("signature") == signature:
            return cached["names"]
    except (OSError, ValueError, KeyError):
        pass
    names = _read_names()
    try:
        _state_dir().mkdir(parents=True, exist_ok=True)
        cache_path.write_text(json.dumps({"signature": signature, "names": names}),
                              encoding="utf-8")
    except OSError:
        pass        # the cache is a speed-up; the names are still good
    return names


def _term_pattern(terms):
    """Whole-word, any-case match for a list of names — the same rule the
    journal's highlighter and the person page use."""
    return re.compile(r"\b(?:" + "|".join(re.escape(t) for t in terms) + r")\b",
                      re.IGNORECASE)


# --- What the owner said -----------------------------------------------------

def owner_words(prompt):
    """The part of a prompt that is the owner talking. Drops the app's own
    appended note, and in a labelled batch keeps only her blocks — so a name
    in another agent's message loads nothing. Empty for a slash command or
    harness-made text."""
    text = (prompt or "").strip()
    if not text or text.startswith("/") or text.startswith(SYNTHETIC_PREFIXES):
        return ""
    cut = text.find(_APP_NOTE)
    if cut != -1:
        text = text[:cut]
    headers = list(_BATCH_HEADER.finditer(text))
    if not headers:
        return text
    kept = []
    for position, header in enumerate(headers):
        end = headers[position + 1].start() if position + 1 < len(headers) else len(text)
        if header.group(1) == "B":
            kept.append(text[header.end():end])
    return "\n".join(kept)


def find_mentions(text, names):
    """The people and threads named in `text`, in the order they first appear."""
    found = []
    for entry in names:
        if not entry["terms"]:
            continue
        match = _term_pattern(entry["terms"]).search(text)
        if match:
            found.append((match.start(), entry))
    found.sort(key=lambda pair: pair[0])
    return [entry for _, entry in found]


# --- The history, from the database ------------------------------------------

def _read_only_connection():
    """Open the database so nothing can be written through it — the same
    `mode=ro` + `query_only` pair routes/pond.py uses."""
    conn = sqlite3.connect(f"file:{store.DATA_DIR / 'exo.db'}?mode=ro", uri=True, timeout=3)
    conn.execute("PRAGMA query_only = ON")
    conn.row_factory = sqlite3.Row
    return conn


def _fts_query(terms):
    """The word-index query for "any of these names". Each is quoted, so
    nothing in a name can be read as search syntax."""
    return " OR ".join('"' + term.replace('"', '""') + '"' for term in terms)


def cards_about(conn, entry, today=None):
    """Her cards about one person or thread, oldest first, plus a word on
    which window they came from.

    A card counts when it is tagged with the slug (`card_tags`, or the
    universal `tags` table under this kind's namespace) or when its text names
    them. The word index finds text candidates quickly but folds word endings,
    so each untagged candidate is checked again with the whole-word pattern.

    The window: the last MENTION_CONTEXT_DAYS days, newest MENTION_CONTEXT_CARDS;
    if that is empty, the newest MENTION_CONTEXT_CARDS of any age."""
    today = today or date.today()
    limit = app_config.MENTION_CONTEXT_CARDS
    since = (today - timedelta(days=app_config.MENTION_CONTEXT_DAYS)).isoformat()
    pattern = _term_pattern(entry["terms"])

    tagged = {row[0] for row in conn.execute(
        "SELECT card_id FROM card_tags WHERE tag = ?"
        " UNION SELECT substr(subject, 6) FROM tags"
        "  WHERE ns = ? AND tag = ? AND subject LIKE 'card:%'",
        (entry["slug"], entry["kind"], entry["slug"]))}

    def newest(day_clause, parameters):
        sql = ("SELECT c.id, c.ts, c.body FROM cards c"
               " WHERE c.who = 'B' AND c.deleted_at IS NULL" + day_clause +
               " AND (c.id IN (SELECT card_id FROM card_tags WHERE tag = ?)"
               "   OR c.id IN (SELECT substr(subject, 6) FROM tags"
               "               WHERE ns = ? AND tag = ? AND subject LIKE 'card:%')"
               "   OR c.id IN (SELECT card_id FROM cards_fts WHERE cards_fts MATCH ?))"
               " ORDER BY c.ts DESC, c.id DESC")
        rows = conn.execute(sql, parameters + [
            entry["slug"], entry["kind"], entry["slug"], _fts_query(entry["terms"])])
        kept = []
        for row in rows:
            if row["id"] in tagged or pattern.search(row["body"] or ""):
                kept.append(row)
                if len(kept) >= limit:
                    break
        return kept

    cards = newest(" AND c.day >= ?", [since])
    window = f"the last {app_config.MENTION_CONTEXT_DAYS} days"
    if not cards:
        cards = newest("", [])
        window = "nothing in the last {} days, so her newest cards of any age".format(
            app_config.MENTION_CONTEXT_DAYS)
    cards.reverse()
    return cards, window


# --- Writing the pack --------------------------------------------------------

def _one_line(body, length):
    flat = " ".join((body or "").split())
    return flat if len(flat) <= length else flat[:length].rstrip() + "…"


def render_section(entry, cards, window, room):
    """One person's or thread's cards as text that fits in `room` characters,
    or None when even the shortest form won't fit. Tries shorter and shorter
    cards first, then drops the oldest."""
    kind = "Person" if entry["kind"] == "person" else "Thread"
    cards = list(cards)
    while cards:
        for length in CARD_LENGTHS:
            lines = [f"- {(card['ts'] or card['id'])[:16]} [{card['id']}] "
                     f"{_one_line(card['body'], length)}" for card in cards]
            head = (f"## {kind}: {entry['name']} — file `{entry['file']}`\n"
                    f"{len(cards)} of her cards ({window}), oldest first:")
            text = head + "\n" + "\n".join(lines)
            if len(text) <= room:
                return text, cards
        cards = cards[1:]
    return None


PACK_HEADER = (
    "[Context on mention — loaded by the app, not typed by the owner.]\n"
    "Her message names the people or threads below for the first time in this"
    " session, so the app pulled her own recent journal cards about them from"
    " the database. Each loads once per session. A card ending in … was cut"
    " short: its full text is in the card pool under the id in brackets. This is"
    " a starting point, not a boundary — read further when the moment calls for it."
)


def build_pack(mentions, conn, today=None):
    """The text to inject for these mentions, and what happened to each.

    Returns (text, loaded, empty, waiting): `loaded` is one summary dict per
    section written, `empty` the entries with no cards at all, `waiting` the
    ones that did not fit this time."""
    sections, loaded, empty, waiting = [], [], [], []
    room = OUTPUT_BUDGET - len(PACK_HEADER) - 200
    for position, entry in enumerate(mentions):
        cards, window = cards_about(conn, entry, today)
        if not cards:
            empty.append(entry)
            continue
        # Share what's left evenly among the names still to come.
        share = room // max(1, len(mentions) - position)
        rendered = (render_section(entry, cards, window, max(share, SMALLEST_SHARE))
                    if room >= SMALLEST_SHARE else None)
        if rendered is None:
            waiting.append(entry)
            continue
        text, shown = rendered
        sections.append(text)
        room -= len(text) + 2
        loaded.append({"key": entry["key"], "kind": entry["kind"], "name": entry["name"],
                       "cards": len(shown),
                       "first": shown[0]["id"][:10], "last": shown[-1]["id"][:10]})
    if not sections:
        return "", loaded, empty, waiting
    text = PACK_HEADER + "\n\n" + "\n\n".join(sections)
    if waiting:
        text += ("\n\nAlso named, not loaded for lack of room (they load on their"
                 " next mention): " + ", ".join(e["name"] for e in waiting) + ".")
    return text, loaded, empty, waiting


# --- Remembering what a session already has ----------------------------------

def _state_path(session_key):
    safe = re.sub(r"[^A-Za-z0-9._-]", "_", session_key)[:120]
    return _state_dir() / f"{safe}.json"


def already_loaded(session_key):
    try:
        return set(json.loads(_state_path(session_key).read_text(encoding="utf-8")))
    except (OSError, ValueError):
        return set()


def remember(session_key, keys):
    _state_dir().mkdir(parents=True, exist_ok=True)
    _state_path(session_key).write_text(json.dumps(sorted(keys)), encoding="utf-8")


def summary_line(loaded):
    """What the owner is shown: `loaded: Name — 14 cards, 2026-09-03 to 2026-10-02`."""
    parts = []
    for item in loaded:
        count = f"{item['cards']} card" + ("" if item["cards"] == 1 else "s")
        span = item["first"] if item["first"] == item["last"] else f"{item['first']} to {item['last']}"
        parts.append(f"{item['name']} — {count}, {span}")
    return "loaded: " + "; ".join(parts)


def _note_in_chat(conversation_id, loaded):
    """Add the grey "loaded: …" line to an Observatory chat. One O_APPEND
    write, so it can't land inside a line the running turn is writing."""
    line = {"type": "context-loaded", "text": summary_line(loaded), "items": loaded,
            "ts": datetime.now().isoformat(timespec="seconds")}
    path = store.DATA_DIR / "bot_chats" / f"{conversation_id}.jsonl"
    data = (json.dumps(line) + "\n").encode("utf-8")
    descriptor = os.open(str(path), os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o644)
    try:
        os.write(descriptor, data)
    finally:
        os.close(descriptor)


# --- The hook itself ---------------------------------------------------------

def _terminal_arming(session_id, transcript_path):
    """A terminal session's arming mode, by the capture hook's own test:
    None until `/journalstart` or `/thread` has run in it."""
    sys.path.insert(0, str(SKELETON / "tools" / "stream"))
    import keeper_capture
    return keeper_capture._session_mode(session_id, transcript_path)


def run(hook_input, terminal=False, today=None):
    """One prompt in, the hook's JSON reply out (or None to stay silent)."""
    if not app_config.MENTION_CONTEXT:
        return None
    conversation_id = os.environ.get("EXOCORTEX_CONV_ID", "").strip()
    session_id = (hook_input.get("session_id") or "").strip()
    preloaded = set()
    if terminal:
        # An Observatory turn that also picks up the folder's settings file is
        # already served by the hook the app wired; don't answer twice.
        if conversation_id:
            return None
        mode = _terminal_arming(session_id, (hook_input.get("transcript_path") or "").strip())
        if mode is None:
            return None
        # A /thread session has just read its own thread — no need to load it.
        if mode[0] == "thread" and mode[1]:
            preloaded.add(f"thread:{mode[1]}")
    session_key = conversation_id or session_id
    if not session_key:
        return None

    text = owner_words(hook_input.get("prompt"))
    if not text:
        return None
    have = already_loaded(session_key) | preloaded
    mentions = [entry for entry in find_mentions(text, load_names())
                if entry["key"] not in have]
    if not mentions:
        return None

    with closing(_read_only_connection()) as conn:
        pack, loaded, empty, _waiting = build_pack(mentions, conn, today)
    # Names with nothing in the journal are remembered too, so they aren't
    # looked up again on every later mention. Names that didn't fit are not.
    remember(session_key, have | {item["key"] for item in loaded}
             | {entry["key"] for entry in empty})
    if not pack:
        return None

    reply = {"hookSpecificOutput": {"hookEventName": "UserPromptSubmit",
                                    "additionalContext": pack}}
    if conversation_id:
        try:
            _note_in_chat(conversation_id, loaded)
        except OSError:
            pass        # the agent still gets its pack; only the grey line is lost
    else:
        reply["systemMessage"] = summary_line(loaded)
    return reply


def main():
    try:
        reply = run(json.load(sys.stdin), terminal="--terminal" in sys.argv[1:])
        if reply:
            print(json.dumps(reply))
    except Exception:
        pass        # never block or break a message
    return 0


if __name__ == "__main__":
    sys.exit(main())
