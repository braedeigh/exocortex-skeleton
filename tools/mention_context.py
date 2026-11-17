#!/usr/bin/env python3
"""Context on mention — the first time the owner names a person or a thread in
a session, hand the agent her recent journal cards about them.

**What this does, in plain English.** It is a Claude Code `UserPromptSubmit`
hook: it runs by itself on every message the owner sends, before the agent
reads it. It looks in the message for the name (or a filed alias) of anyone in
the vault's `people/` folder or any thread in `Threads/`. For each one it has
not already loaded in this session, it reads her own journal cards about them
out of the database (`exo.db`: `cards`, `card_labels`, `labels`, `cards_fts`)
and prints them. Whatever a hook of this kind prints lands in the agent's context,
so the agent starts its reply already holding the history, without searching.

**How much.** The newest `MENTION_CONTEXT_CARDS` cards (20) about them that
the session does not already have, however far back that reaches. Only her own
cards (`who = 'B'`).

**Nothing twice.** Every session has a record of the cards it has been handed
(`loadrecord.py`): the Keeper's boot package puts its cards there at the wake,
and every pack adds its own. A card on the record is skipped, by its id or by
its words (two cards can say the same thing; and a card made from a message
she typed in this very chat is already in front of the agent). So a pack holds
only what is new to the session, and two names in one day don't share cards.

**The fact sheet.** For a person (not a thread), the newest sheet in
`person_sheets` (`personsheets.py`) goes at the top of their section, above the
cards, labelled with the day it was written and as a summary. It is five short
lines (who they are, pronouns, what they're tied to, where things stand, last
contact) written by a night helper, so it is a map and the cards are the
evidence: where the two disagree, the card wins. The sheet is never cut to
make room; the cards are. A person with a sheet but nothing new to hand over
still gets a section holding just the sheet, once. If the table isn't there,
there is simply no sheet.

**"About them"** means a card wearing their label (a live `card_labels` row —
one taken off doesn't count), or a card whose text names them. Both, because
labelling happens overnight: today's cards about someone are not labelled yet.

**Names that can't be trusted as a bare word.** Some names are ordinary words
(a person called Will, in a journal full of "I will"), and some are shared by
two people. `namerisk.py` works out which, from the tagger's own verdicts. For
those names the text match is dropped and only tagged cards count, so their
cards from today load a day late. A common-word name also has to be written
capitalised in the middle of a sentence before it counts as a mention at all.

**Names two people share.** When one word in her message fits more than one
person (two people files that both answer to the same first name), the app
doesn't load both blindly. It asks a small model (Haiku, through `llm.py`, given
at most `JUDGE_SECONDS`, 8) which one she means. The model sees her message, the
last few turns of the conversation (read from the session's transcript file),
and for each candidate their newest fact sheet, the date of their newest card
and their two newest cards. If it names one person, only that person loads, with
a line saying who was judged and where the other one's file is; the other is not
put on the session's record, so naming them clearly later still loads them. If it
can't tell, times out, fails or answers with anything else, both load with a line
saying the app couldn't tell. A person named in full ("Sam Okafor") settles it
without asking. Threads are never judged, and `MENTION_JUDGE=0` skips the judge.

**Once per session.** Which names have loaded is on the same record
(`bot_chats/mention_context/<session>.json` in the data folder).

**The tracker.** Each load is also written to the `context_loads` table: the
name, the word in her message that set it off, the cards handed over, how many
were left out. A person the judge ruled out gets a row too, outcome "judged out",
so the decision can be read back. `scripts/context_loads.py` reads it back beside
the replies. A message she sent off the record leaves no row there and no trace on the
session's record.

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
Same for threads that are auto tagging." / "load more context that doesn't
overlap" / "a tracker to measure when a thread is loaded and to what response"
/ "a small model is called when a name fits more than one person and judges from
context who is meant, from when each was mentioned last and recent entries"
"""
import json
import os
import re
import sqlite3
import sys
from contextlib import closing
from datetime import date, datetime
from pathlib import Path

SKELETON = Path(__file__).resolve().parents[1]
if str(SKELETON) not in sys.path:
    sys.path.insert(0, str(SKELETON))

import config as app_config  # noqa: E402
import loadrecord  # noqa: E402
import store  # noqa: E402

# Everything one run prints stays under this many characters — see "The size
# limit" in the block above.
OUTPUT_BUDGET = 9000
# The least room worth giving one person or thread. A name that would get less
# than this waits for its next mention instead.
SMALLEST_SHARE = 1200
# The most time the name-judge may take; past it the answer is "unclear".
JUDGE_SECONDS = 8
# How long a single card may run, tried longest first until the pack fits.
CARD_LENGTHS = (1500, 800, 400, 240, 160)

# Text the harness puts on the prompt channel that is not the owner talking.
SYNTHETIC_PREFIXES = (
    "<task-notification>", "<system-reminder>", "<local-command-stdout>",
    "<command-message>", "<command-name>", "<command-args>",
    # Messages the app itself sends to wake a session. They carry ordinary
    # words ("Job:", "Result:") that can match a thread's name.
    "[Background job finished", "[Sudo request answered", "[System reminder", "[Idle check",
)
# The header line of one message in a labelled batch (peermail.compose):
# `[B · name]` is the owner, `[A · …]` another agent.
_BATCH_HEADER = re.compile(r"^\[(B|A) · [^\]\n]*\]\s*$", re.MULTILINE)
# Where the app's own note starts when it is appended to her message
# (routes/observatory.py `_reopen_note`).
_APP_NOTE = "\n\n[System:"


def _state_dir():
    return loadrecord.folder()


# --- The names to listen for -------------------------------------------------

def _names_signature():
    """A fingerprint of the people and thread folders: how many files, and the
    newest change time. When it differs from the cached one, a file was added,
    removed or edited, and the names are read again. Today's date is part of
    it too: which names are risky is judged from the cards, so it is re-judged
    once a day."""
    parts = [date.today().isoformat()]
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
    thread's name and aliases. A person also carries `weak` and `shared`: the
    terms that can't be trusted as a bare word match (see namerisk.py)."""
    # Imported here, not at the top: these pull in Flask, which costs a third
    # of a second, and the cache below means most runs never need them.
    import namerisk
    from routes import threads

    people = namerisk.all_people()
    try:
        with closing(_read_only_connection()) as conn:
            risky = namerisk.classify(conn, people)
    except sqlite3.Error:
        # No database to judge by: only the shared names can be known.
        shared = namerisk.shared_terms(people)
        risky = {person["slug"]: {"weak": [], "shared": [
            term for term in person["terms"] if term.lower() in shared]} for person in people}
    names = []
    for person in people:
        risk = risky.get(person["slug"], {})
        names.append({
            "key": f"person:{person['slug']}", "kind": "person",
            "slug": person["slug"], "name": person["name"],
            "file": person["file"], "terms": person["terms"],
            "weak": risk.get("weak", []), "shared": risk.get("shared", []),
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

def owner_messages(prompt):
    """The parts of a prompt that are the owner talking, one per message.
    Drops the app's own appended note, and in a labelled batch keeps only her
    blocks — so a name in another agent's message loads nothing. Empty for a
    slash command or harness-made text."""
    text = (prompt or "").strip()
    if not text or text.startswith("/") or text.startswith(SYNTHETIC_PREFIXES):
        return []
    cut = text.find(_APP_NOTE)
    if cut != -1:
        text = text[:cut]
    headers = list(_BATCH_HEADER.finditer(text))
    if not headers:
        return [text]
    kept = []
    for position, header in enumerate(headers):
        end = headers[position + 1].start() if position + 1 < len(headers) else len(text)
        if header.group(1) == "B":
            kept.append(text[header.end():end])
    return kept


def owner_words(prompt):
    """The part of a prompt that is the owner talking, as one text."""
    return "\n".join(owner_messages(prompt))


def _untrusted(entry):
    """The lowercased terms of this entry that a bare text match can't be
    trusted for: weak ones and shared ones."""
    return {term.lower() for term in (entry.get("weak") or []) + (entry.get("shared") or [])}


def find_mentions(text, names):
    """The people and threads named in `text`, in the order they first appear,
    each with the word that named them: [(entry, matched_word)].

    A weak term (a name that is also an ordinary word) only counts when it is
    written capitalised in the middle of a sentence. Every other term counts as
    a whole word in any case."""
    import namerisk

    found = []
    for entry in names:
        weak = {term.lower() for term in entry.get("weak") or []}
        plain = [term for term in entry["terms"] if term.lower() not in weak]
        match = _term_pattern(plain).search(text) if plain else None
        if match:
            found.append((match.start(), entry, match.group(0)))
            continue
        for term in entry.get("weak") or []:
            if namerisk.named_midsentence(text, term):
                capitalised = term[:1].upper() + term[1:]
                found.append((text.find(capitalised), entry, capitalised))
                break
    found.sort(key=lambda item: item[0])
    return [(entry, matched) for _, entry, matched in found]


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


def matching_cards(conn, entry):
    """Every one of her cards about one person or thread, newest first, as
    (row, tagged): the row has id, ts and body; `tagged` is True when the card
    carries the slug, False when only its text names them.

    A card counts when it wears the slug's label (a live row in
    `card_labels`) or when its text names them. The word index finds text candidates quickly but folds word endings,
    so each untagged candidate is checked again with the whole-word pattern.
    Only trusted terms are matched in text: a weak or shared name counts by
    tag alone. This is the one place that decides "about them"; the hook and
    scripts/person_cards.py both read it."""
    untrusted = _untrusted(entry)
    text_terms = [term for term in entry["terms"] if term.lower() not in untrusted]
    pattern = _term_pattern(text_terms) if text_terms else None

    labelled = ("SELECT cl.card_id FROM card_labels cl JOIN labels l ON l.id = cl.label_id"
                " WHERE l.slug = ? AND cl.removed_at IS NULL")
    tagged = {row[0] for row in conn.execute(labelled, (entry["slug"],))}

    sql = ("SELECT c.id, c.said_at AS ts, c.body FROM cards c"
           " WHERE c.who = 'B' AND c.deleted_at IS NULL"
           f" AND (c.id IN ({labelled})"
           + ("   OR c.id IN (SELECT card_id FROM cards_fts WHERE cards_fts MATCH ?)"
              if text_terms else "") +
           ") ORDER BY c.said_at DESC, c.id DESC")
    rows = conn.execute(sql, [entry["slug"]]
                        + ([_fts_query(text_terms)] if text_terms else []))
    for row in rows:
        if row["id"] in tagged:
            yield row, True
        elif pattern and pattern.search(row["body"] or ""):
            yield row, False


def cards_about(conn, entry, record=None):
    """Her newest cards about one person or thread that the session does not
    already have, oldest first, plus how many were left out as already had.

    A card counts when it wears the slug's label (a live row in
    `card_labels`) or when its text names them. The word index finds text candidates quickly but folds word endings,
    so each untagged candidate is checked again with the whole-word pattern.
    Only trusted terms are matched in text: a weak or shared name counts by
    tag alone.

    `record` is the session's record (loadrecord.py). A card on it is left
    out, by id or by its words, and each card kept is put on it, so the next
    name in the same message can't take the same card. The walk goes from the
    newest card back and stops at MENTION_CONTEXT_CARDS kept, so the pack
    reaches as far into the past as it needs to fill up."""
    limit = app_config.MENTION_CONTEXT_CARDS
    record = record if record is not None else {"names": set(), "cards": set(), "texts": set()}
    kept, skipped = [], 0
    for row, _ in matching_cards(conn, entry):
        if loadrecord.has(record, row["id"], row["body"]):
            skipped += 1
            continue
        kept.append(row)
        record["cards"].add(row["id"])
        mark = loadrecord.fingerprint(row["body"])
        if mark:
            record["texts"].add(mark)
        if len(kept) >= limit:
            break
    kept.reverse()
    return kept, skipped


# --- Writing the pack --------------------------------------------------------

def _attached_name(match):
    """`[uploaded: /long/path/IMG_1.png]` as `[file IMG_1.png]`."""
    return "[file " + match.group(0)[len("[uploaded: "):-1].rsplit("/", 1)[-1] + "]"


def _one_line(body, length):
    """A card's text on one line, cut at `length`. Attached files are shown by
    name alone: a card that opens with ten full upload paths would otherwise
    be cut before its words begin."""
    flat = " ".join(loadrecord.UPLOAD_MARKER.sub(_attached_name, body or "").split())
    return flat if len(flat) <= length else flat[:length].rstrip() + "…"


def _span(cards):
    """The days a run of cards covers: `2026-09-03 to 2026-10-02`."""
    first, last = cards[0]["id"][:10], cards[-1]["id"][:10]
    return first if first == last else f"{first} to {last}"


def newest_sheet(conn, entry):
    """A person's newest fact sheet as (written_at, body), or None. One read on
    the hook's own read-only connection; a threads entry has none, and a
    database without the table (sqlite3.Error) simply has no sheet."""
    if entry["kind"] != "person":
        return None
    try:
        row = conn.execute(
            "SELECT written_at, body FROM person_sheets WHERE slug = ?"
            " ORDER BY written_at DESC, id DESC LIMIT 1", (entry["slug"],)).fetchone()
    except sqlite3.Error:
        return None
    return (row[0], row[1]) if row and (row[1] or "").strip() else None


def render_section(entry, cards, room, sheet=None):
    """One person's or thread's section as text that fits in `room`
    characters, or None when even the shortest form won't fit. Returns
    (text, cards shown). The fact sheet, when there is one, sits under the
    header and above the cards and is never cut: it counts inside `room`, and
    the cards are what gives way. Tries shorter and shorter cards first, then
    drops the oldest. A section whose cards all had to go is None (they wait
    for the next mention), unless there were no cards to begin with."""
    kind = "Person" if entry["kind"] == "person" else "Thread"
    cards = list(cards)
    top = f"## {kind}: {entry['name']} — file `{entry['file']}`"
    if sheet:
        top += (f"\nFact sheet, written {(sheet[0] or '')[:10]} (a summary; her cards"
                f" below are the evidence):\n{sheet[1].strip()}")
    if not cards:
        return (top, []) if sheet and len(top) <= room else None
    while cards:
        for length in CARD_LENGTHS:
            lines = [f"- {(card['ts'] or card['id'])[:16]} [{card['id']}] "
                     f"{_one_line(card['body'], length)}" for card in cards]
            head = f"{len(cards)} of her cards, {_span(cards)}, oldest first:"
            text = top + "\n" + head + "\n" + "\n".join(lines)
            if len(text) <= room:
                return text, cards
        cards = cards[1:]
    return None


PACK_HEADER = (
    "[Context on mention — loaded by the app, not typed by the owner.]\n"
    "Her message names the people or threads below for the first time in this"
    " session, so the app pulled her own journal cards about them from the"
    " database: the newest ones you have not already been given. Cards in your"
    " boot package, in an earlier pack, or made from what she typed in this chat"
    " are left out, so a pack can reach well into the past. Each name loads once"
    " per session. A card ending in … was cut"
    " short: its full text is in the card pool under the id in brackets. A"
    " person's section may open with their fact sheet, a short dated summary"
    " written by a night helper; where it and a card disagree, trust the card."
    " This is a starting point, not a boundary — read further when the moment"
    " calls for it."
)


def build_pack(mentions, conn, record=None, notes=()):
    """The text to inject for these mentions, and what happened to each.

    `mentions` is [(entry, matched_word)]; `record` is the session's record,
    which the cards handed over are added to as the pack is built. `notes` is
    [(keys, line)]: a line about a shared name, printed above the first section
    whose key is in `keys`; it counts toward the budget.

    Returns (text, loaded, results). `loaded` is one summary dict per section
    written. `results` is one dict per mention for the tracker and the record:
    {entry, matched, outcome, card_ids, bodies, skipped}, where outcome is
    'loaded', 'nothing new', 'no cards' or 'no room'. A person with a fact
    sheet and no new cards is 'loaded' with no card ids."""
    record = record if record is not None else {"names": set(), "cards": set(), "texts": set()}
    sections, loaded, results, used_notes = [], [], [], set()
    room = OUTPUT_BUDGET - len(PACK_HEADER) - 200
    for position, (entry, matched) in enumerate(mentions):
        result = {"entry": entry, "matched": matched, "card_ids": [], "bodies": []}
        results.append(result)
        # Work on a copy of the record: only cards that are really printed
        # may stay on it.
        trial = {part: set(record[part]) for part in record}
        cards, result["skipped"] = cards_about(conn, entry, trial)
        sheet = newest_sheet(conn, entry)
        if not cards and not sheet:
            result["outcome"] = "nothing new" if result["skipped"] else "no cards"
            continue
        # Share what's left evenly among the names still to come. A shared-name
        # line for this section comes out of its share.
        pending = [index for index, (keys, _) in enumerate(notes)
                   if entry["key"] in keys and index not in used_notes]
        lead = "".join(notes[index][1] + "\n" for index in pending)
        share = room // max(1, len(mentions) - position)
        rendered = (render_section(entry, cards, max(share, SMALLEST_SHARE) - len(lead), sheet)
                    if room >= SMALLEST_SHARE else None)
        if rendered is None:
            result["outcome"] = "no room"
            continue
        text, shown = rendered
        text = lead + text
        used_notes.update(pending)
        sections.append(text)
        room -= len(text) + 2
        result.update(outcome="loaded", card_ids=[card["id"] for card in shown],
                      bodies=[card["body"] for card in shown])
        record["cards"].update(result["card_ids"])
        record["texts"].update(mark for mark in map(loadrecord.fingerprint, result["bodies"])
                               if mark)
        loaded.append({"key": entry["key"], "kind": entry["kind"], "name": entry["name"],
                       "cards": len(shown), "sheet": bool(sheet),
                       "first": shown[0]["id"][:10] if shown else None,
                       "last": shown[-1]["id"][:10] if shown else None})
    if not sections:
        return "", loaded, results
    text = PACK_HEADER + "\n\n" + "\n\n".join(sections)
    waiting = [result["entry"]["name"] for result in results if result["outcome"] == "no room"]
    if waiting:
        text += ("\n\nAlso named, not loaded for lack of room (they load on their"
                 " next mention): " + ", ".join(waiting) + ".")
    return text, loaded, results


# --- Remembering what a session already has ----------------------------------

def summary_line(loaded):
    """What the owner is shown: `loaded: Name — 14 cards, 2026-09-03 to 2026-10-02`,
    with "fact sheet, " in front of the count when a sheet came too, and
    nothing after the dash but "fact sheet" when it came alone."""
    parts = []
    for item in loaded:
        pieces = ["fact sheet"] if item.get("sheet") else []
        if item["cards"]:
            pieces.append(f"{item['cards']} card" + ("" if item["cards"] == 1 else "s"))
            pieces.append(item["first"] if item["first"] == item["last"]
                          else f"{item['first']} to {item['last']}")
        parts.append(f"{item['name']} — " + ", ".join(pieces))
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


# --- Names two people share --------------------------------------------------

def shared_name_groups(mentions):
    """The people in `mentions` that a single word in her message fits more
    than once, as groups of [(entry, matched_word)], each with two or more.
    Two people are in one group when they were matched by the same word
    (any case) or when one's matched word is among the other's terms. Threads
    are never grouped. This is a union-find: each person starts alone and
    groups merge as shared words are found."""
    people = [(entry, matched) for entry, matched in mentions if entry["kind"] == "person"]
    parent = list(range(len(people)))

    def root(index):
        while parent[index] != index:
            parent[index] = parent[parent[index]]
            index = parent[index]
        return index

    for first in range(len(people)):
        for second in range(first + 1, len(people)):
            entry_a, word_a = people[first]
            entry_b, word_b = people[second]
            terms_a = {term.lower() for term in entry_a["terms"]}
            terms_b = {term.lower() for term in entry_b["terms"]}
            if (word_a.lower() == word_b.lower() or word_a.lower() in terms_b
                    or word_b.lower() in terms_a):
                parent[root(second)] = root(first)
    groups = {}
    for index, pair in enumerate(people):
        groups.setdefault(root(index), []).append(pair)
    return [group for group in groups.values() if len(group) > 1]


def named_in_full(text, group):
    """The one person in a group whose longer name appears in her message
    ("Sam Okafor" where the group's shared word is "Sam"), or None. The longest
    term of each person found in the text is compared; a person wins only by
    being strictly longer than every other member's."""
    best = []
    for entry, _ in group:
        found = [match.group(0) for term in entry["terms"]
                 for match in [_term_pattern([term]).search(text)] if match]
        best.append(max(found, key=len) if found else "")
    lengths = [len(word) for word in best]
    if lengths.count(max(lengths)) == 1:
        return group[lengths.index(max(lengths))][0]
    return None


def _conversation_tail(transcript_path, turns=6, length=400):
    """The last few things said in the session, as `Her: …` / `Agent: …` lines,
    read from the tail of Claude Code's transcript file. Tool calls are
    skipped; a missing or unreadable file gives nothing."""
    try:
        with open(transcript_path, "rb") as handle:
            handle.seek(0, os.SEEK_END)
            size = handle.tell()
            handle.seek(max(0, size - 200_000))
            lines = handle.read().decode("utf-8", "replace").splitlines()
    except (OSError, TypeError, ValueError):
        return []
    said = []
    for line in lines:
        try:
            record = json.loads(line)
            role = record.get("type")
            content = record["message"]["content"]
        except (ValueError, KeyError, TypeError, AttributeError):
            continue
        if role not in ("user", "assistant"):
            continue
        if isinstance(content, list):
            content = " ".join(block.get("text", "") for block in content
                               if isinstance(block, dict) and block.get("type") == "text")
        content = " ".join(str(content or "").split())
        if content and not content.startswith(SYNTHETIC_PREFIXES):
            said.append(("Her: " if role == "user" else "Agent: ")
                        + (content if len(content) <= length else content[:length] + "…"))
    return said[-turns:]


def _judge_prompt(text, tail, group, conn):
    """The whole question for the judge, kept to a few thousand characters."""
    parts = ["One word in the owner's message fits more than one person in her journal. "
             "Decide from the context below which one she means.", "",
             "Her message:", text[:1000], ""]
    if tail:
        parts += ["The last turns of the conversation:"] + tail + [""]
    for entry, _ in group:
        parts.append(f"Candidate `{entry['slug']}` — {entry['name']} (file {entry['file']})")
        sheet = newest_sheet(conn, entry)
        if sheet:
            parts.append(f"  Fact sheet, written {(sheet[0] or '')[:10]}: {sheet[1].strip()[:600]}")
        newest = []
        for row, _tagged in matching_cards(conn, entry):
            newest.append(row)
            if len(newest) == 2:
                break
        if newest:
            parts.append(f"  Newest card: {(newest[0]['ts'] or newest[0]['id'])[:10]}")
            parts += [f"  - {(row['ts'] or row['id'])[:10]}: {_one_line(row['body'], 200)}"
                      for row in newest]
        else:
            parts.append("  No cards about them.")
        parts.append("")
    # Cards can sit under the wrong person (the nightly tagger mixes up people
    # who share a name), so the judge is told to weigh the sheets and the
    # conversation above them.
    parts.append("A card listed under a person may have been tagged to the wrong one; weigh"
                 " the fact sheets and the conversation above the cards.")
    slugs = ", ".join(f"`{entry['slug']}`" for entry, _ in group)
    parts.append(f"Answer with exactly one of these words and nothing else: {slugs}, or "
                 "`unclear` if the context doesn't settle it.")
    return "\n".join(parts)


def judge_name(hook_input, text, group, conn):
    """Which person in a group she means: their slug, or None for unclear.

    This is the name-judge: one call to a small model through the app's model
    seam (`llm.ask`, tier "fast", at most JUDGE_SECONDS). Any failure and any
    reply that isn't exactly one candidate's slug counts as unclear."""
    try:
        import llm
        tail = _conversation_tail((hook_input.get("transcript_path") or "").strip())
        reply = llm.ask(_judge_prompt(text, tail, group, conn), tier="fast",
                        timeout=JUDGE_SECONDS)
        answer = reply.strip().strip("`'\".").strip().lower()
        for entry, _ in group:
            if answer == entry["slug"].lower():
                return entry["slug"]
    except Exception:
        pass
    return None


def _joined(names):
    return names[0] if len(names) == 1 else ", ".join(names[:-1]) + " and " + names[-1]


def decide_shared_names(hook_input, text, groups, have, conn):
    """Settle each shared-name group. Returns (dropped, notes): `dropped` is
    [(entry, matched)] for people ruled out (not loaded, not put on the record);
    `notes` is [(keys, line)] for build_pack. A group with nobody left to load
    is skipped without asking."""
    dropped, notes = [], []
    for group in groups:
        survivors = [(entry, matched) for entry, matched in group if entry["key"] not in have]
        if not survivors:
            continue
        shared_word = group[0][1]
        # Name each person by their file too: two people files can carry the
        # very same name ("Jess" and "Jess"), and only the file tells them apart.
        def label(entry):
            return f"{entry['name']} ({entry['file']})"
        names = ", ".join(label(entry) for entry, _ in sorted(group, key=lambda pair: pair[0]["slug"]))
        head = f'"{shared_word}" fits more than one person ({names}); '
        picked = named_in_full(text, group)
        how = f"she named {label(picked)} in full." if picked else None
        if picked is None:
            slug = judge_name(hook_input, text, group, conn)
            picked = next((entry for entry, _ in group if entry["slug"] == slug), None)
            how = f"judged from the conversation as {label(picked)}." if picked else None
        if picked is None:
            notes.append(({entry["key"] for entry, _ in survivors},
                          head + "the app couldn't tell which from the conversation, so each one is"
                                 " below — work out which from context or ask."))
            continue
        others = [entry for entry, _ in group if entry is not picked]
        files = " or ".join(label(other) for other in others)
        notes.append(({picked["key"]}, head + how + f" If that's wrong, it's {files}."))
        dropped += [(entry, matched) for entry, matched in survivors if entry is not picked]
    return dropped, notes


# --- The hook itself ---------------------------------------------------------

def _off_the_record(prompt):
    """True when she sent this message off the record — by the capture hook's
    own test (tools/stream/keeper_capture.py). When that can't be asked, the
    answer is no: with no journal state there are no off-the-record turns."""
    try:
        sys.path.insert(0, str(SKELETON / "tools" / "stream"))
        import keeper_capture
        return keeper_capture._off_record_suppressed((prompt or "").strip())
    except Exception:
        return False


def _terminal_arming(session_id, transcript_path):
    """A terminal session's arming mode, by the capture hook's own test:
    None until `/journalstart` or `/thread` has run in it."""
    sys.path.insert(0, str(SKELETON / "tools" / "stream"))
    import keeper_capture
    return keeper_capture._session_mode(session_id, transcript_path)


def run(hook_input, terminal=False):
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

    messages = owner_messages(hook_input.get("prompt"))
    text = "\n".join(messages)
    if not text:
        return None
    # An off-the-record message leaves nothing behind: no fingerprint on the
    # record and no row in the tracker. Its pack still loads.
    private = _off_the_record(hook_input.get("prompt"))
    # Put what she just typed on the record first, so the card made from this
    # very message is not handed back to the agent as history.
    record = (loadrecord.read(session_key) if private
              else loadrecord.add(session_key, texts=messages))
    have = record["names"] | preloaded
    everyone = find_mentions(text, load_names())
    mentions = [(entry, matched) for entry, matched in everyone if entry["key"] not in have]
    if not mentions:
        return None

    with closing(_read_only_connection()) as conn:
        # Names two people share: grouped before the already-loaded names are
        # removed, so the judge sees every candidate.
        dropped, notes = [], []
        if app_config.MENTION_JUDGE:
            dropped, notes = decide_shared_names(
                hook_input, text, shared_name_groups(everyone), have, conn)
        ruled_out = {entry["key"] for entry, _ in dropped}
        mentions = [pair for pair in mentions if pair[0]["key"] not in ruled_out]
        pack, loaded, results = build_pack(mentions, conn, record, notes)
    # Names with nothing to hand over are remembered too, so they aren't
    # looked up again on every later mention. Names that didn't fit are not.
    settled = [result for result in results if result["outcome"] != "no room"]
    loadrecord.add(session_key,
                   names=[result["entry"]["key"] for result in settled],
                   cards=[card_id for result in settled for card_id in result["card_ids"]],
                   texts=[body for result in settled for body in result["bodies"]])
    if not private:
        for entry, matched in dropped:
            loadrecord.log(session_key, "mention", "judged out", entry=entry, matched=matched)
        for result in results:
            loadrecord.log(session_key, "mention", result["outcome"], entry=result["entry"],
                           matched=result["matched"], card_ids=result["card_ids"],
                           skipped=result["skipped"])
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
