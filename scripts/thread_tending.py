#!/usr/bin/env python3
"""Thread tending — the nightly check that journal cards are filed under the
right threads and the right people, one isolated session per thread.

**What this does, in plain English.** Every night this script files the
day's journal cards under the right threads and the right people. Plain code
does what plain code can; a small chain of agent sessions does the rest. The
script makes every write; the sessions only read a job file and write a
report file. The design of record is `docs/journal-database.md` ("The nightly
filing agents").

0. **People by plain name matching.** Every name a person file lists that is
   not risky is matched as a whole word on the day's cards. Risky names — a
   name two people share, or one that is also an ordinary word, or a common
   word naming someone never tagged yet (`namerisk.py` works out which) — are
   left to their own sessions (step 3). A card where plain matching finds two
   or more people goes to one name-check session, which reads each person's
   file and says which matches stand; a single name on a card is filed as is.
1. **The main session** reads the day's cards beside the list of every thread
   and person. It says which threads the day touched, and which person tags
   look wrong — tonight's name matches included, which then aren't added.
2. **One thread session per active thread.** A thread is active when a card
   was tagged with it in the last seven days, or the main session says the day
   touched it, or a card names it, or a new card is a note on an older card
   filed under it (that is how a quiet thread wakes). Each session gets only
   its own thread and that thread's candidate cards, so no other thread
   colours its judgment. It says which cards belong (each with a one-sentence
   reason), which tagged cards don't, what durable fact (if any) the thread
   file is missing, and what moved.
3. **One person session per risky name.** It says which person, if any, each
   card is about.
4. **The overlap session** sees every card that has two or more labels after
   tonight, with every label side by side, the new ones marked. It may drop a
   new claim, and it picks the one label the card is `about`; the rest are
   `touches`. A card with one label is `about` it without a session.
5. **One person-sheet session per person who got newly tagged cards.** A
   nightly refresh, capped at 10 a night. The session sees the person's
   current fact sheet (if there is one) and the new cards, and reports no
   change, or a new sheet with the cards it rests on. It runs after tonight's
   tags are written, so they count.
6. **One status session per thread whose status changed** since the last
   night: gone dormant, retired, or active again. Whatever changed it (the
   weekly housekeeper, an approval, a hand edit), the script notices by
   comparing each thread file's status with the one it remembered. The
   session reads the thread and writes its summary.

A card that is a later note on an older card (a `note` row in `card_links`)
goes to every session with the older card beside it (`note_on`), so the note
is judged in its context.

**What gets written, and through which door.**
- Nothing is tagged until every session has spoken. Then each surviving claim
  is added with the journal engine's own `tag` verb (`tools/stream/stream.py`)
  as a row in `card_labels` that says who added it (`thread-tending`, or
  `people-cricket` for a plain name match), which night (`run` = the date
  tended, so one night can be undone at once), why (the session's sentence),
  and its weight. Labels already on a card get their weight set in place.
- A label once taken off a card is never put back here, and a label the owner
  added is never questioned: the label rows are the memory.
- A fact is added to a thread file with the `thread` tool's `add-card`, which
  refuses anything without a source.
- A tag is never removed here. Each removal is put in the approval queue as a
  `card_untag` item for the owner to approve or deny (`routes/pending.py`
  applies it). Each card-and-tag pair is asked once, ever, whatever she
  answers (`untag_proposed` in `state.json`); a label she added herself is
  never put to her at all.
- Removals found some other way (a review of the people files, say) wait in
  `thread_tending/untag_backlog.json` and are put in the approval queue a few
  a night, after the night's own and under the same nightly cap, so the queue
  never floods. One whose label is gone, is the owner's, or was already asked
  is dropped.
- Each thread's label takes on its thread file's status (active, dormant,
  retired) every night.
- What has been judged is remembered in `thread_tending/state.json` in the
  data folder: a "judged through" date per thread and per risky name, so a
  card is examined once and not again every night of the week.
- Topics the main session saw recurring with no thread to hold them are
  appended to `thread_tending/hints.jsonl`. Nothing is nominated from here:
  the weekly thread scout reads the hints and decides.
- A thread gets a new summary on two occasions only: a fact was added to its
  file tonight, or its status changed since the last night (active, dormant,
  retired). Either way the summary covers the whole thread and how it has
  moved, and is one row in the `thread_summaries` table in exo.db
  (`threadsummaries.py`), added on top of the older ones, which are never
  changed. A status summary is marked with the new status. A summary is at
  most 120 words; a longer one loses whole sentences from its end.
- A person's sheet is five short labelled lines of dated facts (`personsheets.py`),
  one row in the `person_sheets` table in exo.db, added on top of the older
  ones, which are never changed. Only a card tagged with the person counts as
  new, and at most 10 people are refreshed a night; the rest come up the next
  night. A session that finds nothing to change adds no row, and the person is
  still marked judged. `PERSON_SHEETS=0` turns the whole step off.
- Each night's job files, reports, log and a readable `digest.md` are kept in
  `thread_tending/<date>/`. The newest movement notes and recording problems
  per thread are kept in `thread_tending/summaries/<slug>.json`.

**Where the prompts are.** Each session is told to read one prompt file from
the crickets folder (`thread-main.md`, `thread-helper.md`, `person-helper.md`,
`person-matches.md`, `card-overlap.md`, `thread-status.md`, `person-sheet.md`)
and its job file.
The sessions run one at a time.

Usage:
    thread_tending.py                      tend for yesterday
    thread_tending.py 2026-10-02           tend for an explicit day
    thread_tending.py --dry-run            print the plan; run and write nothing
    thread_tending.py --no-apply           run the sessions, apply nothing
    thread_tending.py --only-thread SLUG   just that thread's session
    thread_tending.py 2026-11-15 --backfill-weights
                                           weigh the labels on every card before
                                           that day, once (about / touches)

Prompt for the person sheets: "A nightly refresh: one session per person who got
newly tagged cards that day, capped at 10 a night. The session sees the current
sheet and the new cards, and reports no change or a new sheet with sources."

Prompt: "I want a cricket system similar to the helpers. There is a main
cricket that detects every night if all of the threads tagged are accurate and
which have been active in a day. Then it designates a thread helper to only
examine each thread and determine if it is being properly recorded." And: "for
every recent thread in the past week in a rolling window it'll spin off a
session to tag things for each one so the context isn't poisoned by any other
thread."
"""
import argparse
import fcntl
import importlib.util
import json
import os
import re
import secrets
import sqlite3
import subprocess
import sys
from contextlib import closing
from datetime import date, datetime, timedelta
from pathlib import Path

SKELETON = Path(__file__).resolve().parents[1]
if str(SKELETON) not in sys.path:
    sys.path.insert(0, str(SKELETON))
# The journal's table code (labels, weights) sits beside the engine.
if str(SKELETON / "tools" / "stream") not in sys.path:
    sys.path.insert(0, str(SKELETON / "tools" / "stream"))

import journaldb  # noqa: E402
import namerisk  # noqa: E402
import personsheets  # noqa: E402
import store  # noqa: E402
import threadsummaries  # noqa: E402

STREAM_PY = SKELETON / "tools" / "stream" / "stream.py"
THREAD_BIN = SKELETON / "tools" / "thread" / "target" / "release" / "thread"
CLAUDE_BIN = os.environ.get("CLAUDE_BIN", str(Path.home() / ".local" / "bin" / "claude"))

# How far back a thread or name is looked at when it has never been judged.
WINDOW_DAYS = 7
# How long one session may run before it is given up on.
SESSION_TIMEOUT_SECONDS = 900
# The most tag removals put in front of the owner in one night. The rest are
# listed in the digest and proposed on a later night.
MAX_UNTAG_PROPOSALS = 8
# The most facts one thread session may add to its thread file in one night.
MAX_FACTS_PER_THREAD = 1
# The most of a thread's older cards handed to a session so it can summarise
# the whole thread, and how much of each card's text. Newest cards are kept.
MAX_HISTORY_CARDS = 120
HISTORY_TEXT_LENGTH = 300
# The most status sessions run in one night. The housekeeper can turn many
# threads dormant at once; the rest are done on later nights.
MAX_STATUS_SESSIONS = 12
# The author recorded on a summary a thread session wrote.
SUMMARY_AUTHOR = "cricket:thread-helper"
# The most person-sheet sessions run in one night. The busiest people go first;
# the rest are not marked judged, so they come up on later nights.
MAX_SHEET_SESSIONS = 10
# The author recorded on a sheet a person-sheet session wrote.
SHEET_AUTHOR = "cricket:person-sheet"
# A thread alias shorter than this is not searched for in card text: two
# letters match too many things. The same floor holds for a person's names
# in the plain-code name matching.
SHORTEST_ALIAS = 3
# Who a label says added it (card_labels.added_by). The sessions' verdicts
# are filed as the thread tending; a person found by plain name matching is
# filed as the people cricket, whose job that used to be.
TENDING_BY = "thread-tending"
PEOPLE_BY = "people-cricket"
# A web address or file path in a card, left out of name matching.
LINK = re.compile(r"(?:https?://|/opt/|/home/)\S+")
# Label kinds that say what a card is about, and so get a weight. A `source`
# label (how a card came in) is never weighed.
WEIGHED_KINDS = ("thread", "person", "topic", "front")


# --- Reading the vault -------------------------------------------------------

def _stream():
    """The journal engine, loaded from its file and pointed at this vault."""
    os.environ.setdefault("TULKU_STREAM_ROOT", str(store.CONTENT_DIR))
    spec = importlib.util.spec_from_file_location("stream_engine", STREAM_PY)
    module = importlib.util.module_from_spec(spec)
    sys.modules["stream_engine"] = module
    spec.loader.exec_module(module)
    return module


def _connect():
    """The journal tables in exo.db, opened the way the engine opens them."""
    return closing(journaldb.connect(journaldb.db_path(store.CONTENT_DIR), create=False))


def load_cards():
    """The owner's own lines from the card pool, oldest first, as plain dicts.

    Besides its words and tags each card carries what the filing needs from
    the label rows: `labels` ({slug: {kind, by, weight}} for its live labels),
    `taken_off` (slugs once on this card and taken off — never put back by an
    agent), and `note_on` (the older card it is a later note on, with that
    card's text and tags, or None)."""
    every = _stream().load_all_cards()
    by_id = {card.id: card for card in every}
    with _connect() as conn:
        notes = dict(conn.execute(
            "SELECT from_card, to_card FROM card_links WHERE kind = 'note' ORDER BY linked_at DESC"))
        live, taken_off = {}, {}
        for card_id, slug, kind, added_by, weight, removed_at in conn.execute(
                "SELECT cl.card_id, l.slug, l.kind, cl.added_by, cl.weight, cl.removed_at"
                " FROM card_labels cl JOIN labels l ON l.id = cl.label_id ORDER BY cl.id"):
            if removed_at is None:
                live.setdefault(card_id, {})[slug] = {"kind": kind, "by": added_by, "weight": weight}
            else:
                taken_off.setdefault(card_id, set()).add(slug)
    cards = []
    for card in every:
        if card.who != "B" or card.kind != "line":
            continue
        older = by_id.get(notes.get(card.id))
        cards.append({
            "id": card.id, "day": card.id[:10], "ts": card.ts,
            "tags": list(card.tags), "body": card.body.strip(),
            "labels": live.get(card.id, {}),
            # A label taken off and then kept by the owner has a live row too:
            # only what is off now counts as taken off.
            "taken_off": taken_off.get(card.id, set()) - set(live.get(card.id, {})),
            "note_on": ({"id": older.id, "ts": older.ts, "text": older.body.strip(),
                         "tags": list(older.tags)} if older else None),
        })
    cards.sort(key=lambda card: (card["ts"], card["id"]))
    return cards


def label_names():
    """Every label's kind and name: {slug: {kind, name}}."""
    with _connect() as conn:
        return {slug: {"kind": kind, "name": name}
                for slug, kind, name in conn.execute("SELECT slug, kind, name FROM labels")}


def load_threads():
    """Every thread that isn't retired: slug, name, charter, aliases, file."""
    from routes import threads

    out = []
    for slug, thread in sorted(threads.threads_index().items()):
        if thread.get("status") == "retired":
            continue
        out.append({"slug": slug, "name": thread["name"],
                    "charter": thread.get("charter") or "",
                    "aliases": list(thread.get("aliases") or []),
                    "file": str(store.CONTENT_DIR / thread["file"])})
    return out


def thread_statuses():
    """Every thread, retired ones too: {slug: {status, name, file}}."""
    from routes import threads

    return {slug: {"status": thread.get("status") or "", "name": thread["name"],
                   "file": str(store.CONTENT_DIR / thread["file"])}
            for slug, thread in threads.threads_index().items()}


def risky_names(people, today):
    """Each person's risky names, judged from the cards in the database. A
    common word that names someone never tagged counts as risky too, since
    every name that isn't risky is tagged by plain matching. With no word
    index only the shared names can be known."""
    try:
        with closing(sqlite3.connect(f"file:{store.DATA_DIR / 'exo.db'}?mode=ro", uri=True)) as conn:
            return namerisk.classify(conn, people, today, untagged_counts=True)
    except sqlite3.Error:
        shared = namerisk.shared_terms(people)
        return {person["slug"]: {"weak": [], "shared": [
            term for term in person["terms"] if term.lower() in shared]}
            for person in people
            if any(term.lower() in shared for term in person["terms"])}


# --- What has already been judged --------------------------------------------

def _work_dir():
    return store.DATA_DIR / "thread_tending"


def load_state():
    """The memory between nights: `threads` and `names` map a slug or a name
    to the last day it was judged through; `untag_proposed` lists every
    card-and-tag removal already put to the owner ("card|tag"), so none is
    asked twice, whatever she answered; `statuses` maps a thread's slug to the
    status its file had when last looked at; `sheets` maps a person's slug to
    the last day their fact sheet was judged through."""
    try:
        state = json.loads((_work_dir() / "state.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        state = {}
    state.setdefault("threads", {})
    state.setdefault("names", {})
    state.setdefault("untag_proposed", [])
    state.setdefault("statuses", {})
    state.setdefault("sheets", {})
    return state


def save_state(state):
    _work_dir().mkdir(parents=True, exist_ok=True)
    path = _work_dir() / "state.json"
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(state, indent=1, sort_keys=True), encoding="utf-8")
    temporary.replace(path)


def window_start(target, judged_through):
    """The first day still to be looked at: the day after the last one judged,
    and never more than WINDOW_DAYS back. Later than `target` means there is
    nothing left to look at."""
    earliest = target - timedelta(days=WINDOW_DAYS - 1)
    if judged_through:
        try:
            earliest = max(earliest, date.fromisoformat(judged_through) + timedelta(days=1))
        except ValueError:
            pass
    return earliest


# --- Planning: which sessions to run, and with which cards --------------------

def _in_days(cards, first, last):
    first, last = first.isoformat(), last.isoformat()
    return [card for card in cards if first <= card["day"] <= last]


def _with_note_context(entry, card):
    """A card as a session sees it, with the older card it is a note on.

    A note is judged with the card it points at: "still true" means nothing
    without the thing it is still true of. Only the older card's id, time,
    text and tags go along."""
    if card.get("note_on"):
        entry["note_on"] = card["note_on"]
    return entry


def _card_for_job(card, tagged):
    return _with_note_context(
        {"id": card["id"], "ts": card["ts"], "text": card["body"], "tagged": tagged}, card)


def thread_history(cards, slug, before=None):
    """A thread's own older cards, for a session that has to summarise the
    whole thread: every card tagged with the slug (dated before `before`, when
    given), oldest first, each cut to HISTORY_TEXT_LENGTH characters. Only the
    newest MAX_HISTORY_CARDS are kept. Returns (cards, how many were left out)."""
    tagged = [card for card in cards if slug in card["tags"]
              and (before is None or card["day"] < before.isoformat())]
    kept = tagged[-MAX_HISTORY_CARDS:]
    return ([{"id": card["id"], "ts": card["ts"], "text": card["body"][:HISTORY_TEXT_LENGTH]}
             for card in kept], len(tagged) - len(kept))


def main_job(target, cards, threads, people, risky, claims=None):
    """The main session's job: the day's cards beside every thread and person.
    A card's `tags` include the people tonight's name matching would add
    (`claims`), so the main session can call those wrong too. None when the
    day has no cards."""
    todays = _in_days(cards, target, target)
    if not todays:
        return None
    claims = claims or {}
    return {
        "target": target.isoformat(),
        "cards": [_with_note_context({"id": card["id"], "ts": card["ts"], "text": card["body"],
                                      "tags": card["tags"] + [slug for slug in claims.get(card["id"]) or {}
                                                              if slug not in card["tags"]]}, card)
                  for card in todays],
        "threads": [{"slug": t["slug"], "name": t["name"], "charter": t["charter"],
                     "aliases": t["aliases"]} for t in threads],
        "people": [{"slug": p["slug"], "name": p["name"], "names": p["terms"],
                    "has_own_check": p["slug"] in risky} for p in people],
    }


def thread_jobs(target, cards, threads, state, main_report):
    """One job per active thread that has cards still to be judged.

    Active means: a card tagged with the slug in the last WINDOW_DAYS days,
    or the main session says the day touched it, or a card in the unjudged
    window names it, or is a note on an older card filed under it. The job's
    cards are those kinds together, from the unjudged window only. A note on
    an old card is how a dormant thread wakes: the note is new, so the thread
    gets a session even if nothing else touched it for months."""
    week = _in_days(cards, target - timedelta(days=WINDOW_DAYS - 1), target)
    found_by_main = (main_report or {}).get("threads") or {}
    todays_ids = {card["id"] for card in _in_days(cards, target, target)}
    jobs = []
    for thread in threads:
        slug = thread["slug"]
        start = window_start(target, state["threads"].get(slug))
        if start > target:
            continue
        unjudged = _in_days(cards, start, target)
        from_main = set(found_by_main.get(slug) or []) & todays_ids
        names = [term for term in [thread["name"]] + thread["aliases"]
                 if len(term) >= SHORTEST_ALIAS]
        pattern = namerisk.whole_word(names) if names else None
        chosen = [card for card in unjudged
                  if slug in card["tags"] or card["id"] in from_main
                  or slug in (card.get("note_on") or {}).get("tags", [])
                  or (pattern and pattern.search(card["body"]))]
        active = chosen or any(slug in card["tags"] for card in week)
        if not active:
            continue
        history, left_out = thread_history(cards, slug, before=start)
        jobs.append({
            "slug": slug, "name": thread["name"], "charter": thread["charter"],
            "thread_file": thread["file"], "target": target.isoformat(),
            "window_start": start.isoformat(), "max_facts": MAX_FACTS_PER_THREAD,
            "cards": [_card_for_job(card, slug in card["tags"]) for card in chosen],
            "history": history, "history_left_out": left_out,
        })
    return jobs


def status_jobs(target, cards, statuses, state):
    """One job per thread whose status is not the one remembered for it.

    A thread seen for the first time has nothing remembered, so it gets no
    job: its status is only written down. At most MAX_STATUS_SESSIONS a
    night; the rest keep their old remembered status and come up again."""
    jobs = []
    for slug, thread in sorted(statuses.items()):
        before = state["statuses"].get(slug)
        if before is None or before == thread["status"] or thread["status"] not in threadsummaries.STATUSES:
            continue
        history, left_out = thread_history(cards, slug)
        jobs.append({"slug": slug, "name": thread["name"], "thread_file": thread["file"],
                     "target": target.isoformat(), "status_before": before,
                     "status_now": thread["status"], "cards": history,
                     "history_left_out": left_out})
    return jobs[:MAX_STATUS_SESSIONS]


def person_jobs(target, cards, people, risky, state):
    """One job per risky name that has cards still to be judged.

    A shared name gets every unjudged card that uses the name or carries one
    of the sharers' tags, and the session picks between the sharers. A weak
    name (an ordinary word) gets only the cards where it is written as a name,
    capitalised mid-sentence, or already tagged — otherwise every "I will"
    would be a candidate."""
    by_slug = {person["slug"]: person for person in people}
    groups = {}
    for slug, risk in risky.items():
        for term in risk.get("shared") or []:
            groups.setdefault(("shared", term.lower()), {"term": term, "slugs": []})["slugs"].append(slug)
        for term in risk.get("weak") or []:
            if term.lower() not in {t.lower() for t in risk.get("shared") or []}:
                groups.setdefault(("weak", f"{slug}:{term.lower()}"), {"term": term, "slugs": [slug]})
    jobs = []
    for (kind, key), group in sorted(groups.items()):
        state_key = f"{kind}:{key}"
        start = window_start(target, state["names"].get(state_key))
        if start > target:
            continue
        slugs = sorted(group["slugs"])
        pattern = namerisk.whole_word([group["term"]])
        chosen = []
        for card in _in_days(cards, start, target):
            tagged = [slug for slug in slugs if slug in card["tags"]]
            if kind == "shared":
                named = bool(pattern.search(card["body"]))
            else:
                named = namerisk.named_midsentence(card["body"], group["term"])
            if tagged or named:
                chosen.append(_with_note_context({"id": card["id"], "ts": card["ts"],
                                                  "text": card["body"], "tagged_as": tagged}, card))
        jobs.append({
            "state_key": state_key, "name": group["term"], "kind": kind,
            "target": target.isoformat(), "window_start": start.isoformat(),
            "people": [{"slug": slug, "name": by_slug[slug]["name"],
                        "file": str(store.CONTENT_DIR / by_slug[slug]["file"])} for slug in slugs],
            "cards": chosen,
        })
    return jobs


def sheet_jobs(target, cards, people, state, newest=personsheets.newest):
    """One job per person who has cards tagged with their slug in their
    unjudged window, the busiest first (ties by slug), at most
    MAX_SHEET_SESSIONS. The window is the same rolling one threads use. A
    person over the cap is not marked judged, so they come up the next night.

    Each job carries the person's current sheet (None if they have none) and
    `same_name`: other people files that share one of this person's names."""
    found = []
    for person in people:
        slug = person["slug"]
        start = window_start(target, state["sheets"].get(slug))
        if start > target:
            continue
        fresh = [card for card in _in_days(cards, start, target) if slug in card["tags"]]
        if fresh:
            found.append((person, start, fresh))
    found.sort(key=lambda item: (-len(item[2]), item[0]["slug"]))
    jobs = []
    for person, start, fresh in found[:MAX_SHEET_SESSIONS]:
        terms = {term.lower() for term in person["terms"]}
        current = newest(person["slug"])
        jobs.append({
            "slug": person["slug"], "name": person["name"],
            "person_file": str(store.CONTENT_DIR / person["file"]),
            "target": target.isoformat(), "window_start": start.isoformat(),
            "max_words": personsheets.MAX_WORDS, "labels": list(personsheets.LABELS),
            "current_sheet": ({"written_at": current["written_at"], "body": current["body"],
                               "based_on": current["based_on"]} if current else None),
            "cards": [{"id": card["id"], "ts": card["ts"], "text": card["body"]} for card in fresh],
            "same_name": [{"slug": other["slug"], "name": other["name"],
                           "file": str(store.CONTENT_DIR / other["file"])}
                          for other in people if other["slug"] != person["slug"]
                          and terms & {term.lower() for term in other["terms"]}],
        })
    return jobs


def name_matches(target, cards, people, risky):
    """The people found by plain code: every card from `target` that names a
    person by one of their trusted names, as claims {card_id: {slug: claim}}.

    A trusted name is any of a person's names that `namerisk` did not call
    weak (also an ordinary word) or shared (two people use it), at least
    SHORTEST_ALIAS letters long, matched as a whole word in any case. Risky
    names are left to their own person sessions. Links are not read (a name
    inside a web address is not a mention). A card that already carries the
    person, or had them taken off, gets no claim. Plain code can't tell
    "Peter" from "Peter Thiel": the main session sees every match as a tag
    and can stop it."""
    claims = {}
    for person in people:
        slug = person["slug"]
        risk = risky.get(slug) or {}
        untrusted = {term.lower() for term in (risk.get("weak") or []) + (risk.get("shared") or [])}
        terms = [term for term in person["terms"]
                 if term.lower() not in untrusted and len(term) >= SHORTEST_ALIAS]
        if not terms:
            continue
        pattern = namerisk.whole_word(terms)
        for card in _in_days(cards, target, target):
            if slug in card["tags"] or slug in card["taken_off"]:
                continue
            match = pattern.search(LINK.sub(" ", card["body"]))
            if match:
                claims.setdefault(card["id"], {})[slug] = {
                    "kind": "person", "by": PEOPLE_BY, "reason": f'names "{match.group(0)}"'}
    return claims


def name_check_job(target, claims, cards_by_id, people):
    """The name-check session's job: every card where plain matching found
    two or more people. One name on a card is filed by code; several on one
    card are judged by a session, which reads each person's file. None when
    no card has more than one."""
    by_slug = {person["slug"]: person for person in people}
    cards = []
    for card_id, found in sorted(claims.items()):
        if len(found) < 2 or card_id not in cards_by_id:
            continue
        card = cards_by_id[card_id]
        cards.append(_with_note_context({
            "id": card_id, "ts": card["ts"], "text": card["body"],
            "candidates": [{"slug": slug, "name": by_slug[slug]["name"],
                            "file": str(store.CONTENT_DIR / by_slug[slug]["file"]),
                            "matched": claim["reason"]}
                           for slug, claim in found.items() if slug in by_slug]}, card))
    return {"target": target.isoformat(), "cards": cards} if cards else None


def apply_name_check(job, report, claims):
    """Drop the matches the name-check session said are not about that
    person; the rest stand. With no report (the session failed) every match
    stands, and the main session is still there to stop a wrong one.
    Returns the dropped ones [{card, tag, reason}]."""
    dropped = []
    if not job or report is None:
        return dropped
    asked = {card["id"]: {c["slug"] for c in card["candidates"]} for card in job["cards"]}
    for verdict in report.get("verdicts") or []:
        card_id, slug = (verdict or {}).get("card"), (verdict or {}).get("person")
        if slug not in asked.get(card_id, set()) or verdict.get("keep") is not False:
            continue
        if (claims.get(card_id) or {}).pop(slug, None):
            dropped.append({"card": card_id, "tag": slug,
                            "reason": str(verdict.get("reason") or "").strip()})
    return dropped


def add_claim(claims, card, slug, kind, by, reason):
    """Record one session's "this card belongs under this label", unless the
    label is on already or was once taken off this card (never put back)."""
    if slug in card["labels"] or slug in card["taken_off"]:
        return False
    claims.setdefault(card["id"], {}).setdefault(slug, {"kind": kind, "by": by, "reason": reason})
    return True


def overlap_plan(target, cards, claims, names, threads, unweighed_scope=None):
    """Which cards need their labels weighed, and the job for those that
    need a session.

    A card needs weighing when it gets a new label tonight, or it is one of
    the target day's cards (or of `unweighed_scope`, a set of card ids, when
    given) and one of its labels has no weight yet. With one
    label the label is `about` and no session is needed. With two or more,
    the overlap session sees every label side by side, keeps or drops the new
    ones, and picks the one the card is `about`. Returns (automatic weights
    {card_id: {slug: weight}}, the session's cards)."""
    charters = {thread["slug"]: thread["charter"] for thread in threads}
    todays = (unweighed_scope if unweighed_scope is not None
              else {card["id"] for card in _in_days(cards, target, target)})
    automatic, session_cards = {}, []
    for card in cards:
        new = claims.get(card["id"]) or {}
        old = {slug: label for slug, label in card["labels"].items() if label["kind"] in WEIGHED_KINDS}
        unweighed = any(label["weight"] is None for label in old.values())
        if not new and not (card["id"] in todays and unweighed):
            continue
        slugs = list(old) + [slug for slug in new if slug not in old]
        if len(slugs) == 1:
            automatic[card["id"]] = {slugs[0]: "about"}
            continue
        labels = []
        for slug in slugs:
            claim, label = new.get(slug), old.get(slug)
            kind = (claim or label)["kind"]
            entry = {"slug": slug, "kind": kind,
                     "name": (names.get(slug) or {}).get("name") or slug, "new": bool(claim)}
            if kind == "thread":
                entry["charter"] = charters.get(slug, "")
            if claim:
                entry["reason"] = claim["reason"]
            else:
                entry["weight"] = label["weight"]
                entry["owner"] = label["by"] == journaldb.OWNER
            labels.append(entry)
        session_cards.append(_with_note_context(
            {"id": card["id"], "ts": card["ts"], "text": card["body"], "labels": labels}, card))
    return automatic, session_cards


def apply_overlap(session_cards, verdict, claims, automatic):
    """Turn the overlap session's verdict into weights, and drop the new
    claims it turned down. Only a new claim can be dropped; a label already
    on stays (taking one off is the owner's call, through the queue). With
    no verdict (the session failed) every claim stands and a card with two or
    more labels stays unweighed. Returns (weights {card_id: {slug: weight}},
    dropped [{card, tag}])."""
    weights, dropped = {card_id: dict(found) for card_id, found in automatic.items()}, []
    for card in session_cards:
        ruling = ((verdict or {}).get("cards") or {}).get(card["id"]) or {}
        new = {label["slug"] for label in card["labels"] if label["new"]}
        for slug in set(ruling.get("drop") or []) & new:
            (claims.get(card["id"]) or {}).pop(slug, None)
            dropped.append({"card": card["id"], "tag": slug})
        still_claimed = claims.get(card["id"]) or {}
        kept = [label["slug"] for label in card["labels"]
                if not label["new"] or label["slug"] in still_claimed]
        about = ruling.get("about")
        if about not in kept:
            about = kept[0] if len(kept) == 1 else None
        if about:
            weights[card["id"]] = {slug: "about" if slug == about else "touches" for slug in kept}
    return weights, dropped


# --- Running one session -----------------------------------------------------

def run_session(role, job, night_dir, name, crickets_dir, model, log):
    """Write the job file, run one agent session on it, and read back its
    report. None when the session failed or wrote no readable report."""
    job_path = night_dir / f"{name}.job.json"
    report_path = night_dir / f"{name}.report.json"
    job = {**job, "report_path": str(report_path)}
    job_path.write_text(json.dumps(job, indent=1), encoding="utf-8")
    report_path.unlink(missing_ok=True)
    prompt = (f"You are one helper in the nightly thread tending. Read {crickets_dir / (role + '.md')}"
              f" and then your job file {job_path}. Do only what they say, read nothing else unless"
              f" they name it, and write your report as JSON to {report_path}.")
    log(f"--- {name} ({role}, {model}) start: {len(job.get('cards') or [])} card(s) ---")
    try:
        result = subprocess.run(
            [CLAUDE_BIN, "-p", prompt, "--model", model, "--dangerously-skip-permissions"],
            cwd=str(store.DATA_DIR.parent), capture_output=True, text=True,
            timeout=SESSION_TIMEOUT_SECONDS)
        log((result.stdout or "").strip()[-2000:])
        log(f"--- {name} done (exit={result.returncode}) ---")
    except (OSError, subprocess.TimeoutExpired) as error:
        log(f"--- {name} FAILED: {error} ---")
        return None
    try:
        report = json.loads(report_path.read_text(encoding="utf-8"))
        return report if isinstance(report, dict) else None
    except (OSError, ValueError):
        log(f"--- {name}: no readable report ---")
        return None


# --- Applying what the sessions found -----------------------------------------

def add_tag(card_id, tag, by, run, reason, weight=None):
    """Put one label on one card through the journal engine's own `tag`
    verb, signed with who added it, which night, why, and its weight. The
    engine refuses (and says so) a label the owner took off this card."""
    command = [sys.executable, str(STREAM_PY), "tag", card_id, tag, "--by", by, "--run", run,
               "--reason", reason or "no reason given"]
    if weight:
        command += ["--weight", weight]
    result = subprocess.run(command, env={**os.environ, "TULKU_STREAM_ROOT": str(store.CONTENT_DIR)},
                            capture_output=True, text=True, timeout=60)
    error = (result.stderr or "").strip()
    return result.returncode == 0 and "refused:" not in error, error


def write_weights(weights, claims):
    """Set the weight of every label already on a card that the overlap
    pass weighed (new labels get theirs as they are added). An owner's label
    that already has a weight keeps it. Returns how many changed."""
    changed = 0
    with _connect() as conn:
        journaldb.begin_immediate(conn)
        try:
            for card_id, found in weights.items():
                for slug, weight in found.items():
                    if slug in (claims.get(card_id) or {}):
                        continue
                    if journaldb.set_weight(conn, card_id, slug, weight, TENDING_BY) == "set":
                        changed += 1
            conn.execute("COMMIT")
        except BaseException:
            conn.execute("ROLLBACK")
            raise
    return changed


def write_claims(claims, weights, run, apply):
    """Add every claim that survived the night, each with its weight.
    Returns [{card, tag, by, weight, ok, error}] for the digest."""
    tagged = []
    for card_id, found in sorted(claims.items()):
        for slug, claim in found.items():
            weight = (weights.get(card_id) or {}).get(slug)
            ok, error = (add_tag(card_id, slug, claim["by"], run, claim["reason"], weight)
                         if apply else (True, ""))
            tagged.append({"card": card_id, "tag": slug, "by": claim["by"], "weight": weight,
                           "ok": ok, "error": error})
    return tagged


def sync_label_statuses(statuses, apply):
    """Bring each thread label's status (active, dormant, retired) in step
    with its thread file. Returns the slugs that changed."""
    if not apply:
        return []
    changed = []
    with _connect() as conn:
        journaldb.begin_immediate(conn)
        try:
            for slug, thread in sorted(statuses.items()):
                if thread["status"] in threadsummaries.STATUSES and journaldb.set_label_status(
                        conn, slug, thread["status"]):
                    changed.append(slug)
            conn.execute("COMMIT")
        except BaseException:
            conn.execute("ROLLBACK")
            raise
    return changed


def add_fact(slug, fact):
    """Add one cited fact to a thread file through the `thread` tool, which
    refuses a fact with no source or more than three lines."""
    command = [str(THREAD_BIN), "add-card", "--slug", slug,
               "--section", str(fact.get("section") or ""), "--text", str(fact.get("text") or "")]
    for source in fact.get("sources") or []:
        command += ["--source", str(source)]
    command += ["--content-dir", str(store.CONTENT_DIR), "--data-dir", str(store.DATA_DIR)]
    result = subprocess.run(command, capture_output=True, text=True, timeout=30)
    return result.returncode == 0, (result.stderr or "").strip()


def _queued_untags():
    """Every card-and-tag removal waiting in the approval queue now."""
    queue = store.read("pending_changes", {"pending": []}).get("pending") or []
    return {f"{item['payload'].get('card_id')}|{item['payload'].get('tag')}"
            for item in queue if item.get("kind") == "card_untag" and item.get("payload")}


def removable(removal, cards_by_id):
    """True when a removal may be put to the owner: the label is on the card
    now, and an agent put it there (hers are never questioned). The callers
    also skip one already asked (`untag_proposed`) or waiting in the queue."""
    label = ((cards_by_id.get(removal["card_id"]) or {}).get("labels") or {}).get(removal["tag"])
    return bool(label) and label["by"] != journaldb.OWNER


def propose_untags(removals, cards_by_id, state):
    """Put tag removals in the approval queue, at most MAX_UNTAG_PROPOSALS a
    night, each card-and-tag pair once ever. Returns (staged, held): held
    ones were over tonight's cap and will be proposed on a later night."""
    queued, fresh, seen = _queued_untags() | set(state["untag_proposed"]), [], set()
    for removal in removals:
        key = f"{removal['card_id']}|{removal['tag']}"
        if key not in queued and key not in seen and removable(removal, cards_by_id):
            seen.add(key)
            fresh.append(removal)
    staged, held = fresh[:MAX_UNTAG_PROPOSALS], fresh[MAX_UNTAG_PROPOSALS:]
    if staged:
        with store.mutate("pending_changes", {"pending": []}) as queue:
            for removal in staged:
                queue.setdefault("pending", []).append({
                    "id": secrets.token_hex(4), "kind": "card_untag",
                    "summary": f"Remove the tag \"{removal['tag']}\" from this card? {removal['reason']}",
                    "created": datetime.now().strftime("%Y-%m-%d %H:%M"),
                    "payload": removal,
                })
        state["untag_proposed"] = sorted(set(state["untag_proposed"])
                                         | {f"{r['card_id']}|{r['tag']}" for r in staged})
    return staged, held


def read_untag_backlog():
    """The removals waiting their turn, oldest first: [{card_id, tag, reason, card_text}]."""
    try:
        backlog = json.loads((_work_dir() / "untag_backlog.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    return backlog if isinstance(backlog, list) else []


def write_untag_backlog(backlog):
    _work_dir().mkdir(parents=True, exist_ok=True)
    path = _work_dir() / "untag_backlog.json"
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(backlog, indent=1), encoding="utf-8")
    temporary.replace(path)


def queue_untags(removals):
    """Add removals to the backlog, each card-and-tag pair once. Returns how
    many were new."""
    backlog = read_untag_backlog()
    have = {f"{item['card_id']}|{item['tag']}" for item in backlog}
    fresh = [item for item in removals if f"{item['card_id']}|{item['tag']}" not in have]
    write_untag_backlog(backlog + fresh)
    return len(fresh)


def drain_untag_backlog(removals, cards_by_id, state):
    """Tonight's removals with the waiting backlog after them, and the backlog
    as it should be saved once tonight's proposals are made.

    The backlog is only a waiting line; what may still be asked is read from
    the label rows. A waiting removal whose label is off the card, or is the
    owner's, or was already asked, or is waiting in the queue, is dropped. The rest go after the
    night's own removals, so propose_untags's nightly cap decides how many
    go out tonight; whatever is not staged stays waiting."""
    queued = _queued_untags() | set(state["untag_proposed"])
    waiting = [item for item in read_untag_backlog()
               if removable(item, cards_by_id) and f"{item['card_id']}|{item['tag']}" not in queued]
    return removals + waiting, waiting


def read_thread_reports(jobs, reports, cards_by_id, claims, state, target, apply):
    """Read the thread sessions' reports: claims for the cards that belong,
    at most one fact per thread (written now), and removals to propose. A
    session can only act on the cards in its own job, and only for its own
    thread. Returns (facts, removals, movement) for the digest."""
    facts, removals, movement = [], [], []
    for job in jobs:
        slug, report = job["slug"], reports.get(job["slug"])
        if report is None:
            continue    # not judged: the same cards are looked at again tomorrow
        by_id = {card["id"]: card for card in job["cards"]}
        # A belonging card is an id, or {card, reason} with the session's one sentence.
        for item in report.get("belongs") or []:
            card_id = item.get("card") if isinstance(item, dict) else item
            reason = str(item.get("reason") or "").strip() if isinstance(item, dict) else ""
            card = by_id.get(card_id)
            if card and not card["tagged"] and card_id in cards_by_id:
                add_claim(claims, cards_by_id[card_id], slug, "thread", TENDING_BY,
                          reason or f"the {job['name']} session judged it belongs")
        for item in report.get("does_not_belong") or []:
            card = by_id.get((item or {}).get("card"))
            if card and card["tagged"]:
                removals.append({"card_id": card["id"], "tag": slug,
                                 "reason": str(item.get("reason") or "").strip(),
                                 "card_text": card["text"][:400]})
        for fact in (report.get("facts") or [])[:MAX_FACTS_PER_THREAD]:
            if not set(fact.get("sources") or []) <= set(by_id):
                facts.append({"slug": slug, "fact": fact, "ok": False,
                              "error": "a source is not one of this job's cards"})
                continue
            ok, error = add_fact(slug, fact) if apply else (True, "")
            facts.append({"slug": slug, "fact": fact, "ok": ok, "error": error})
        movement.append({"slug": slug, "name": job["name"],
                         "summary": str(report.get("summary") or "").strip(),
                         "movement": [m for m in report.get("movement") or [] if (m or {}).get("sources")],
                         "recording": report.get("recording") or {}})
        if apply:
            state["threads"][slug] = target.isoformat()
    return facts, removals, movement


def read_person_reports(jobs, reports, cards_by_id, claims, state, target, apply):
    """Read the person sessions' verdicts: a claim for the right person, and
    any wrong tag from the group listed for removal. Returns removals."""
    removals = []
    for job in jobs:
        report = reports.get(job["state_key"])
        if report is None:
            if not job["cards"] and apply:
                state["names"][job["state_key"]] = target.isoformat()
            continue
        group = {person["slug"] for person in job["people"]}
        by_id = {card["id"]: card for card in job["cards"]}
        for verdict in report.get("verdicts") or []:
            card = by_id.get((verdict or {}).get("card"))
            if not card:
                continue
            person = verdict.get("person")
            reason = str(verdict.get("reason") or "").strip()
            if person in group and person not in card["tagged_as"] and card["id"] in cards_by_id:
                add_claim(claims, cards_by_id[card["id"]], person, "person", TENDING_BY,
                          reason or f'the "{job["name"]}" session judged it is this person')
            for wrong in card["tagged_as"]:
                if wrong != person:
                    removals.append({"card_id": card["id"], "tag": wrong, "reason": reason,
                                     "card_text": card["text"][:400]})
        if apply:
            state["names"][job["state_key"]] = target.isoformat()
    return removals


def apply_sheet_reports(jobs, reports, state, target, apply):
    """Turn the person-sheet sessions' reports into new sheets.

    A report is {"change": false, ...} or {"change": true, "sheet": the five
    lines, "based_on": [card ids], ...}. Every source must be one of this
    job's cards or one of the current sheet's own sources, and there must be
    at least one. A report that came back, stored or refused or no change,
    marks the person judged through `target`; a session that failed
    (report None) is listed in `failed` by the caller and tried again.
    Returns [{slug, changed, words, ok, error}] for the digest."""
    results = []
    for job in jobs:
        slug, report = job["slug"], reports.get(job["slug"])
        if report is None:
            continue
        if apply:
            state["sheets"][slug] = target.isoformat()
        if not report.get("change"):
            results.append({"slug": slug, "changed": False, "words": 0, "ok": True, "error": ""})
            continue
        sheet = str(report.get("sheet") or "").strip()
        based_on = [str(source) for source in report.get("based_on") or []]
        allowed = {card["id"] for card in job["cards"]} | set((job["current_sheet"] or {}).get("based_on") or [])
        refused = {"slug": slug, "changed": True, "words": 0, "ok": False}
        if not based_on:
            results.append({**refused, "error": "no source given"})
        elif not set(based_on) <= allowed:
            results.append({**refused, "error": "a source is not one of this job's cards or the current sheet's"})
        else:
            done = {"slug": slug, "changed": True, "words": personsheets.word_count(sheet),
                    "ok": True, "error": ""}
            if apply:
                try:
                    row = personsheets.add(slug, SHEET_AUTHOR, sheet, based_on)
                except (ValueError, sqlite3.Error) as error:
                    results.append({**refused, "error": str(error)})
                    continue
                if row is None:     # word for word the newest sheet: nothing was added
                    done["changed"] = False
            results.append(done)
    return results


def save_summaries(jobs, reports, facts, apply):
    """Add a new summary on top of each thread that got a fact tonight.

    Only a fact added to the thread file counts. New cards alone do not: the
    stack grows when the thread's own record does. The summary is based on
    the cards the fact came from. Returns [{slug, words, ok, error}] for the
    digest."""
    sources = {item["slug"]: list(item["fact"].get("sources") or []) for item in facts if item["ok"]}
    saved = []
    for job in jobs:
        slug, report = job["slug"], reports.get(job["slug"])
        if not report or slug not in sources:
            continue
        saved.append(_store_summary(slug, report.get("summary"), sources[slug], None, apply))
    return [item for item in saved if item]


def save_status_summaries(jobs, reports, statuses, state, apply):
    """Add a summary, marked with the new status, to each thread whose status
    changed, and remember every thread's status for the next night.

    A thread whose status session failed keeps its old remembered status, so
    it is tried again. Returns [{slug, status, words, ok, error}]."""
    saved, waiting = [], set()
    for job in jobs:
        report = reports.get(job["slug"])
        if report is None:
            waiting.add(job["slug"])
            continue
        in_job = {card["id"] for card in job["cards"]}
        based_on = [source for source in report.get("based_on") or [] if source in in_job]
        item = _store_summary(job["slug"], report.get("summary"), based_on, job["status_now"], apply)
        if item:
            saved.append({**item, "status": job["status_now"]})
    if apply:
        asked = {job["slug"] for job in jobs}
        for slug, thread in statuses.items():
            changed = slug in state["statuses"] and state["statuses"][slug] != thread["status"]
            # Over tonight's cap and not asked: leave the old status so it comes up again.
            if slug in waiting or (changed and slug not in asked
                                   and thread["status"] in threadsummaries.STATUSES):
                continue
            state["statuses"][slug] = thread["status"]
    return saved


def _store_summary(slug, summary, based_on, status, apply):
    """Fit one summary to the word limit and add it to the thread's stack.
    Returns {slug, words, ok, error} for the digest, or None when there was
    nothing to add."""
    summary = str(summary or "").strip()
    body = threadsummaries.fit(summary)
    if not body:
        if not summary:
            return None
        return {"slug": slug, "words": 0, "ok": False,
                "error": f"over {threadsummaries.MAX_WORDS} words with no sentence short enough to keep"}
    done = {"slug": slug, "words": threadsummaries.word_count(body), "ok": True, "error": ""}
    if not apply:
        return done
    try:
        row = threadsummaries.add(slug, SUMMARY_AUTHOR, body, based_on, status=status)
    except (ValueError, sqlite3.Error) as error:
        return {"slug": slug, "words": 0, "ok": False, "error": str(error)}
    return done if row else None


def main_people_verdicts(main_report, cards, target, people, risky, claims):
    """The person tags the main session called wrong. A tag tonight's name
    matching only proposed is simply not added; a real tag becomes a removal
    to propose. Only person tags on the day's own cards count, and risky
    names are left to their own session. Returns (removals, vetoed)."""
    todays = {card["id"]: card for card in _in_days(cards, target, target)}
    slugs = {person["slug"] for person in people} - set(risky)
    removals, vetoed = [], []
    for item in (main_report or {}).get("people_wrong") or []:
        card = todays.get((item or {}).get("card"))
        tag = (item or {}).get("tag")
        if not card or tag not in slugs:
            continue
        reason = str(item.get("reason") or "").strip()
        if tag in (claims.get(card["id"]) or {}):
            claims[card["id"]].pop(tag)
            vetoed.append({"card": card["id"], "tag": tag, "reason": reason})
        elif tag in card["tags"]:
            removals.append({"card_id": card["id"], "tag": tag, "reason": reason,
                             "card_text": card["body"][:400]})
    return removals, vetoed


def save_hints(main_report, cards, target, apply):
    """Keep the main session's "this keeps coming up and has no thread" notes
    for the weekly scout: one line each in hints.jsonl. A hint must point at
    real cards from the day."""
    todays = {card["id"] for card in _in_days(cards, target, target)}
    hints = []
    for item in (main_report or {}).get("no_thread_yet") or []:
        topic = str((item or {}).get("topic") or "").strip()
        ids = [card_id for card_id in (item or {}).get("cards") or [] if card_id in todays]
        if topic and ids:
            hints.append({"date": target.isoformat(), "topic": topic, "cards": ids})
    if hints and apply:
        with open(_work_dir() / "hints.jsonl", "a", encoding="utf-8") as handle:
            for hint in hints:
                handle.write(json.dumps(hint) + "\n")
    return hints


# --- The night's digest ------------------------------------------------------

def write_digest(night_dir, target, outcome):
    """A readable account of the night, and the newest summary per thread."""
    lines = [f"# Thread tending — {target.isoformat()}", ""]
    if not outcome["applied"]:
        lines += ["**A trial run: nothing below was written.** The tags, facts and"
                  " removals listed are what a real run would have done.", ""]
    for entry in outcome["movement"]:
        lines.append(f"## {entry['name']} (`{entry['slug']}`)")
        if entry["summary"]:
            lines += [entry["summary"], ""]
        for item in entry["movement"]:
            sources = " ".join(f"`{source}`" for source in item["sources"])
            lines.append(f"- {str(item.get('text') or '').strip()} → {sources}")
        problems = (entry["recording"] or {}).get("problems") or []
        for problem in problems:
            lines.append(f"- Recording problem: {problem}")
        lines.append("")
        summaries = _work_dir() / "summaries"
        summaries.mkdir(parents=True, exist_ok=True)
        (summaries / f"{entry['slug']}.json").write_text(json.dumps(
            {"date": target.isoformat(), **entry}, indent=1), encoding="utf-8")
    lines.append("## What was written")
    for item in outcome["tagged"]:
        weight = f", {item['weight']}" if item.get("weight") else ""
        lines.append(f"- tagged `{item['card']}` with `{item['tag']}` ({item['by']}{weight})"
                     + ("" if item["ok"] else f" — FAILED: {item['error']}"))
    for item in outcome["dropped"]:
        lines.append(f"- not tagged, the overlap pass turned it down: `{item['tag']}` on `{item['card']}`")
    for item in outcome["name_dropped"]:
        lines.append(f"- not tagged, the name check said it isn't them: `{item['tag']}` on"
                     f" `{item['card']}` — {item['reason']}")
    for item in outcome["vetoed"]:
        lines.append(f"- not tagged, the main session said it isn't them: `{item['tag']}` on"
                     f" `{item['card']}` — {item['reason']}")
    if outcome["reweighed"]:
        lines.append(f"- weighed {outcome['reweighed']} label(s) already on cards (about / touches)")
    for slug in outcome["relabeled"]:
        lines.append(f"- the `{slug}` label now has its thread file's status")
    for item in outcome["facts"]:
        lines.append(f"- fact added to `{item['slug']}`: {item['fact'].get('section')}"
                     + ("" if item["ok"] else f" — REFUSED: {item['error']}"))
    for item in outcome["summaries"]:
        why = f", now {item['status']}" if item.get("status") else ""
        lines.append(f"- new summary on `{item['slug']}` ({item['words']} words{why})" if item["ok"]
                     else f"- summary for `{item['slug']}` NOT kept: {item['error']}")
    for item in outcome["sheets"]:
        if item["ok"] and item["changed"]:
            lines.append(f"- new fact sheet for `{item['slug']}` ({item['words']} words)")
        elif not item["ok"]:
            lines.append(f"- fact sheet for `{item['slug']}` NOT kept: {item['error']}")
    for item in outcome["staged"]:
        lines.append(f"- asked you: remove `{item['tag']}` from `{item['card_id']}` — {item['reason']}")
    for item in outcome["held"]:
        lines.append(f"- held for a later night: remove `{item['tag']}` from `{item['card_id']}`")
    for hint in outcome["hints"]:
        lines.append(f"- no thread for this yet (left for the weekly scout): {hint['topic']}")
    for name in outcome["failed"]:
        lines.append(f"- session failed, will be tried again tomorrow: {name}")
    if lines[-1] == "## What was written":
        lines.append("- nothing")
    (night_dir / "digest.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


# --- The night ---------------------------------------------------------------

# How many cards one backfill overlap session weighs.
BACKFILL_BATCH = 50


def backfill_weights(crickets_dir, before, model="sonnet", session=run_session, out=print):
    """Weigh the labels already on older cards, once: every card from before
    `before` with a label that has no weight. One label is `about`, by code.
    Two or more go to overlap sessions, BACKFILL_BATCH cards at a time, each
    batch written as soon as it comes back. Safe to run again: a card whose
    session failed is still unweighed, and only those come up.

    Prompt: "Backfill with another session or agent" — weights for the labels
    that were on cards before the nightly filing started weighing them."""
    cards, threads, names = load_cards(), load_threads(), label_names()
    scope = {card["id"] for card in cards if card["day"] < before.isoformat()}
    automatic, waiting = overlap_plan(before, cards, {}, names, threads, unweighed_scope=scope)
    work = _work_dir() / "backfill-weights"
    work.mkdir(parents=True, exist_ok=True)

    def log(message):
        if message:
            with open(work / "log.txt", "a", encoding="utf-8") as handle:
                handle.write(f"{datetime.now():%H:%M:%S} {message}\n")

    total = write_weights(automatic, {})
    out(f"backfill: {total} single label(s) set about; {len(waiting)} card(s) for overlap sessions")
    failed = 0
    for start in range(0, len(waiting), BACKFILL_BATCH):
        batch = waiting[start:start + BACKFILL_BATCH]
        verdict = session("card-overlap", {"target": f"before {before.isoformat()}", "cards": batch},
                          work, f"overlap.{start // BACKFILL_BATCH:03d}", crickets_dir, model, log)
        if verdict is None:
            failed += 1
            continue
        weights, _ = apply_overlap(batch, verdict, {}, {})
        changed = write_weights(weights, {})
        total += changed
        out(f"backfill: batch {start // BACKFILL_BATCH + 1}: {changed} label(s) weighed")
    out(f"backfill done: {total} label(s) weighed, {failed} batch(es) failed (run again to retry)")
    return {"weighed": total, "failed": failed}


def sheets_enabled():
    """False when the environment says PERSON_SHEETS=0."""
    return os.environ.get("PERSON_SHEETS") != "0"


def tend(target, crickets_dir, model="sonnet", main_model="sonnet", dry_run=False,
         apply=True, only_thread=None, session=run_session, out=print):
    """Run one night's tending for `target` and return what happened.

    Nothing is written to a card until every session has spoken: the
    sessions' verdicts are gathered as claims, the overlap pass weighs each
    card's labels, and only then are the claims added, each with who, which
    night, why and its weight."""
    cards, threads, people = load_cards(), load_threads(), namerisk.all_people()
    cards_by_id = {card["id"]: card for card in cards}
    risky = risky_names(people, target + timedelta(days=1))
    state = load_state()
    run = target.isoformat()
    night_dir = _work_dir() / target.isoformat()

    def log(message):
        if message:
            with open(night_dir / "log.txt", "a", encoding="utf-8") as handle:
                handle.write(f"{datetime.now():%H:%M:%S} {message}\n")

    # The people found by plain code: every trusted name on the day's cards.
    claims = {} if only_thread else name_matches(target, cards, people, risky)
    if dry_run:
        job = None if only_thread else main_job(target, cards, threads, people, risky, claims)
        plan_threads = thread_jobs(target, cards, threads, state, None)
        plan_people = person_jobs(target, cards, people, risky, state)
        out(f"target {target}: {len(job['cards']) if job else 0} card(s) for the main session")
        out("people by plain name matching:")
        for card_id, found in sorted(claims.items()):
            for slug, claim in found.items():
                out(f"  {card_id}  {slug:24s} {claim['reason']}")
        out("thread sessions (before the main session adds what it finds):")
        for item in plan_threads:
            out(f"  {item['slug']:32s} from {item['window_start']}  {len(item['cards'])} card(s)")
        out("person sessions:")
        for item in plan_people:
            out(f"  {item['name']:20s} {[p['slug'] for p in item['people']]}  {len(item['cards'])} card(s)")
        plan_sheets = sheet_jobs(target, cards, people, state) if sheets_enabled() and not only_thread else []
        out("person-sheet sessions:")
        for item in plan_sheets:
            out(f"  {item['slug']:32s} from {item['window_start']}  {len(item['cards'])} card(s)")
        return {"threads": plan_threads, "people": plan_people, "sheets": plan_sheets, "names": claims}

    night_dir.mkdir(parents=True, exist_ok=True)
    failed = []
    # A card naming two or more people: one session judges those matches.
    check = name_check_job(target, claims, cards_by_id, people)
    check_report = None
    if check:
        check_report = session("person-matches", check, night_dir, "names", crickets_dir, model, log)
        if check_report is None:
            failed.append("names")
    name_dropped = apply_name_check(check, check_report, claims)
    job = None if only_thread else main_job(target, cards, threads, people, risky, claims)
    main_report = session("thread-main", job, night_dir, "main", crickets_dir, main_model, log) if job else None
    if job and main_report is None:
        failed.append("main")
    main_removals, vetoed = main_people_verdicts(main_report, cards, target, people, risky, claims)

    jobs = thread_jobs(target, cards, threads, state, main_report)
    if only_thread:
        jobs = [item for item in jobs if item["slug"] == only_thread]
    reports = {}
    for item in jobs:
        if not item["cards"]:
            reports[item["slug"]] = {}      # active, nothing new: judged, nothing to do
            continue
        report = session("thread-helper", item, night_dir, f"thread.{item['slug']}",
                         crickets_dir, model, log)
        if report is None:
            failed.append(f"thread {item['slug']}")
        reports[item["slug"]] = report

    people_jobs = [] if only_thread else person_jobs(target, cards, people, risky, state)
    people_reports = {}
    for item in people_jobs:
        if not item["cards"]:
            continue
        report = session("person-helper", item, night_dir,
                         "person." + item["state_key"].replace(":", "_").replace(" ", "_"),
                         crickets_dir, model, log)
        if report is None:
            failed.append(f"person {item['name']}")
        else:
            people_reports[item["state_key"]] = report

    facts, removals, movement = read_thread_reports(
        jobs, reports, cards_by_id, claims, state, target, apply)
    removals += read_person_reports(people_jobs, people_reports, cards_by_id, claims, state, target, apply)
    summaries = save_summaries(jobs, reports, facts, apply)

    # The overlap pass: one session sees every label on each card that has
    # two or more, keeps or drops the new ones, and picks the one it is about.
    automatic, overlap_cards = overlap_plan(target, cards, claims, label_names(), threads)
    verdict = None
    if overlap_cards:
        verdict = session("card-overlap", {"target": target.isoformat(), "cards": overlap_cards},
                          night_dir, "overlap", crickets_dir, main_model, log)
        if verdict is None:
            failed.append("overlap")        # every claim stands, unweighed
    weights, dropped = apply_overlap(overlap_cards, verdict, claims, automatic)

    # The writes: every surviving claim with its weight, then the weights of
    # labels already on.
    tagged = write_claims(claims, weights, run, apply)
    reweighed = write_weights(weights, claims) if apply else 0

    # The person-sheet sessions: one per person with newly tagged cards. Tags
    # added tonight are folded into the in-memory cards first (only when they
    # were really written), so they count without re-reading the pool.
    if apply:
        for item in tagged:
            card = cards_by_id.get(item["card"])
            if item["ok"] and card and item["tag"] not in card["tags"]:
                card["tags"].append(item["tag"])
    sheet_plan = [] if only_thread or not sheets_enabled() else sheet_jobs(target, cards, people, state)
    sheet_reports = {}
    for item in sheet_plan:
        report = session("person-sheet", item, night_dir, f"sheet.{item['slug']}",
                         crickets_dir, model, log)
        if report is None:
            failed.append(f"sheet {item['slug']}")
        sheet_reports[item["slug"]] = report
    sheets = apply_sheet_reports(sheet_plan, sheet_reports, state, target, apply)

    # The status sessions: one per thread whose status changed since last
    # night. Each thread's label takes on its file's status too.
    statuses = thread_statuses()
    changed = [] if only_thread else status_jobs(target, cards, statuses, state)
    status_reports = {}
    for item in changed:
        report = session("thread-status", item, night_dir, f"status.{item['slug']}",
                         crickets_dir, model, log)
        if report is None:
            failed.append(f"status {item['slug']}")
        status_reports[item["slug"]] = report
    if not only_thread:
        summaries += save_status_summaries(changed, status_reports, statuses, state, apply)
    relabeled = sync_label_statuses(statuses, apply and not only_thread)

    # The removals: the night's own first, then the backlog, under one cap.
    removals, waiting = drain_untag_backlog(removals + main_removals, cards_by_id, state)
    staged, held = propose_untags(removals, cards_by_id, state) if apply else ([], removals)
    if apply:
        asked = {f"{item['card_id']}|{item['tag']}" for item in staged}
        write_untag_backlog([item for item in waiting
                             if f"{item['card_id']}|{item['tag']}" not in asked])
    hints = save_hints(main_report, cards, target, apply)
    if apply:
        save_state(state)
    outcome = {"target": target.isoformat(), "run": run, "tagged": tagged, "facts": facts,
               "staged": staged, "held": held, "movement": movement, "failed": failed,
               "hints": hints, "summaries": summaries, "sheets": sheets, "applied": apply,
               "dropped": dropped, "vetoed": vetoed, "reweighed": reweighed,
               "relabeled": relabeled, "name_dropped": name_dropped}
    write_digest(night_dir, target, outcome)
    (night_dir / "outcome.json").write_text(json.dumps(outcome, indent=1), encoding="utf-8")
    out(f"thread tending {target}: {len(jobs)} thread(s), {len(people_reports)} name(s),"
        f" {len(tagged)} tag(s), {reweighed} reweighed, {len(facts)} fact(s),"
        f" {len(staged)} removal(s) asked,"
        f" {sum(1 for item in sheets if item['ok'] and item['changed'])} sheet(s),"
        f" {len(failed)} failed — {night_dir / 'digest.md'}")
    return outcome


def main(argv=None):
    parser = argparse.ArgumentParser(description="Nightly thread tending (see the top of this file).")
    parser.add_argument("target", nargs="?", help="the day to tend, YYYY-MM-DD (default: yesterday)")
    parser.add_argument("--crickets-dir", default=os.environ.get(
        "EXOCORTEX_CRICKETS_DIR", str(SKELETON / "agents" / "crickets")))
    parser.add_argument("--model", default="sonnet", help="model for the thread and person sessions")
    parser.add_argument("--main-model", default="sonnet", help="model for the main and overlap sessions")
    parser.add_argument("--dry-run", action="store_true", help="print the plan; run and write nothing")
    parser.add_argument("--no-apply", action="store_true", help="run the sessions but apply nothing")
    parser.add_argument("--only-thread", help="run only this thread's session")
    parser.add_argument("--backfill-weights", action="store_true",
                        help="weigh the labels on every card before the target day, once, and stop")
    args = parser.parse_args(argv)
    target = date.fromisoformat(args.target) if args.target else date.today() - timedelta(days=1)

    if args.backfill_weights:
        backfill_weights(Path(args.crickets_dir), target, model=args.model)
        return 0

    if args.dry_run:
        tend(target, Path(args.crickets_dir), dry_run=True)
        return 0
    # One tending at a time: a second run started while one is going would
    # judge the same cards twice. This is a lock file held for the whole run.
    _work_dir().mkdir(parents=True, exist_ok=True)
    with open(_work_dir() / "run.lock", "w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            print("thread tending is already running", file=sys.stderr)
            return 1
        tend(target, Path(args.crickets_dir), model=args.model, main_model=args.main_model,
             apply=not args.no_apply, only_thread=args.only_thread)
    return 0


if __name__ == "__main__":
    # Put this run on the runtime map (runtime_sensor.py), same as the other
    # standalone scripts.
    import runtime_sensor
    runtime_sensor.attach()
    sys.exit(main())
