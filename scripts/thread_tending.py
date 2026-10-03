#!/usr/bin/env python3
"""Thread tending — the nightly check that journal cards are filed under the
right threads and the right people, one isolated session per thread.

**What this does, in plain English.** Every night, after the day's cards have
been tagged, this script runs a small chain of agent sessions and then applies
what they found. The script itself makes every write; the sessions only read a
job file and write a report file.

1. **The main session** reads the day's cards beside the list of every thread
   and person. It says which threads the day touched, and which person tags
   look wrong.
2. **One thread session per active thread.** A thread is active when a card
   was tagged with it in the last seven days, or the main session says the day
   touched it, or a card names it. Each session gets only its own thread and
   that thread's candidate cards, so no other thread colours its judgment. It
   says which cards belong, which tagged cards don't, what durable fact (if
   any) the thread file is missing, and what moved.
3. **One person session per risky name** — a name shared by two people, or a
   name that is also an ordinary word (`namerisk.py` works out which). It says
   which person, if any, each card is about.
4. **The reconcile session** runs only when two or more thread sessions
   claimed the same card. It sees those cards beside the claiming threads and
   says which claims stand.

**What gets written, and through which door.**
- A tag is added with the journal engine's own `tag` verb (`tools/stream/stream.py`).
- A fact is added to a thread file with the `thread` tool's `add-card`, which
  refuses anything without a source.
- A tag is never removed here. Each removal is put in the approval queue as a
  `card_untag` item for the owner to approve or deny (`routes/pending.py`
  applies it). Each card-and-tag pair is proposed once, ever.
- What has been judged is remembered in `thread_tending/state.json` in the
  data folder: a "judged through" date per thread and per risky name, so a
  card is examined once and not again every night of the week.
- Topics the main session saw recurring with no thread to hold them are
  appended to `thread_tending/hints.jsonl`. Nothing is nominated from here:
  the weekly thread scout reads the hints and decides.
- Each night's job files, reports, log and a readable `digest.md` are kept in
  `thread_tending/<date>/`. The newest summary and movement notes per thread
  are kept in `thread_tending/summaries/<slug>.json`.

**Where the prompts are.** Each session is told to read one prompt file from
the crickets folder (`thread-main.md`, `thread-helper.md`, `person-helper.md`,
`thread-reconcile.md`) and its job file. The sessions run one at a time.

Usage:
    thread_tending.py                      tend for yesterday
    thread_tending.py 2026-10-02           tend for an explicit day
    thread_tending.py --dry-run            print the plan; run and write nothing
    thread_tending.py --no-apply           run the sessions, apply nothing
    thread_tending.py --only-thread SLUG   just that thread's session

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

import namerisk  # noqa: E402
import store  # noqa: E402

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
# A thread alias shorter than this is not searched for in card text: two
# letters match too many things.
SHORTEST_ALIAS = 3


# --- Reading the vault -------------------------------------------------------

def _stream():
    """The journal engine, loaded from its file and pointed at this vault."""
    os.environ.setdefault("TULKU_STREAM_ROOT", str(store.CONTENT_DIR))
    spec = importlib.util.spec_from_file_location("stream_engine", STREAM_PY)
    module = importlib.util.module_from_spec(spec)
    sys.modules["stream_engine"] = module
    spec.loader.exec_module(module)
    return module


def load_cards():
    """The owner's own lines from the card pool, oldest first, as plain dicts."""
    cards = []
    for card in _stream().load_all_cards():
        if card.who == "B" and card.kind == "line":
            cards.append({"id": card.id, "day": card.id[:10], "ts": card.ts,
                          "tags": list(card.tags), "body": card.body.strip()})
    cards.sort(key=lambda card: (card["ts"], card["id"]))
    return cards


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


def risky_names(people, today):
    """Each person's risky names, judged from the database's copy of the
    cards. With no database only the shared names can be known."""
    try:
        with closing(sqlite3.connect(f"file:{store.DATA_DIR / 'exo.db'}?mode=ro", uri=True)) as conn:
            return namerisk.classify(conn, people, today)
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
    card-and-tag removal already put to the owner."""
    try:
        state = json.loads((_work_dir() / "state.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        state = {}
    state.setdefault("threads", {})
    state.setdefault("names", {})
    state.setdefault("untag_proposed", [])
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


def _card_for_job(card, tagged):
    return {"id": card["id"], "ts": card["ts"], "text": card["body"], "tagged": tagged}


def main_job(target, cards, threads, people, risky):
    """The main session's job: the day's cards beside every thread and person.
    None when the day has no cards."""
    todays = _in_days(cards, target, target)
    if not todays:
        return None
    return {
        "target": target.isoformat(),
        "cards": [{"id": card["id"], "ts": card["ts"], "text": card["body"],
                   "tags": card["tags"]} for card in todays],
        "threads": [{"slug": t["slug"], "name": t["name"], "charter": t["charter"],
                     "aliases": t["aliases"]} for t in threads],
        "people": [{"slug": p["slug"], "name": p["name"], "names": p["terms"],
                    "has_own_check": p["slug"] in risky} for p in people],
    }


def thread_jobs(target, cards, threads, state, main_report):
    """One job per active thread that has cards still to be judged.

    Active means: a card tagged with the slug in the last WINDOW_DAYS days,
    or the main session says the day touched it, or a card in the unjudged
    window names it. The job's cards are those three kinds together, from the
    unjudged window only."""
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
                  or (pattern and pattern.search(card["body"]))]
        active = chosen or any(slug in card["tags"] for card in week)
        if not active:
            continue
        jobs.append({
            "slug": slug, "name": thread["name"], "charter": thread["charter"],
            "thread_file": thread["file"], "target": target.isoformat(),
            "window_start": start.isoformat(), "max_facts": MAX_FACTS_PER_THREAD,
            "cards": [_card_for_job(card, slug in card["tags"]) for card in chosen],
        })
    return jobs


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
                chosen.append({"id": card["id"], "ts": card["ts"], "text": card["body"],
                               "tagged_as": tagged})
        jobs.append({
            "state_key": state_key, "name": group["term"], "kind": kind,
            "target": target.isoformat(), "window_start": start.isoformat(),
            "people": [{"slug": slug, "name": by_slug[slug]["name"],
                        "file": str(store.CONTENT_DIR / by_slug[slug]["file"])} for slug in slugs],
            "cards": chosen,
        })
    return jobs


def contested(thread_reports, jobs):
    """Cards that two or more thread sessions newly claimed, with the claiming
    threads: [{id, text, claims: [{slug, name, charter}]}]."""
    claims, text = {}, {}
    for job in jobs:
        report = thread_reports.get(job["slug"])
        if not report:
            continue
        untagged = {card["id"]: card for card in job["cards"] if not card["tagged"]}
        for card_id in report.get("belongs") or []:
            if card_id in untagged:
                claims.setdefault(card_id, []).append(
                    {"slug": job["slug"], "name": job["name"], "charter": job["charter"]})
                text[card_id] = untagged[card_id]["text"]
    return [{"id": card_id, "text": text[card_id], "claims": claimed}
            for card_id, claimed in sorted(claims.items()) if len(claimed) > 1]


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

def add_tag(card_id, tag):
    """Add one tag to one card through the journal engine's own `tag` verb."""
    result = subprocess.run(
        [sys.executable, str(STREAM_PY), "tag", card_id, tag],
        env={**os.environ, "TULKU_STREAM_ROOT": str(store.CONTENT_DIR)},
        capture_output=True, text=True, timeout=60)
    return result.returncode == 0, (result.stderr or "").strip()


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


def propose_untags(removals, state):
    """Put tag removals in the approval queue, at most MAX_UNTAG_PROPOSALS a
    night and each card-and-tag pair once ever. Returns (staged, held): held
    ones were over tonight's cap and will be proposed on a later night."""
    already = set(state["untag_proposed"])
    fresh, seen = [], set()
    for removal in removals:
        key = f"{removal['card_id']}|{removal['tag']}"
        if key not in already and key not in seen:
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
        state["untag_proposed"] = sorted(already | {f"{r['card_id']}|{r['tag']}" for r in staged})
    return staged, held


def apply_thread_reports(jobs, reports, kept_claims, state, target, apply):
    """Turn the thread sessions' reports into writes: tags added, at most one
    fact per thread, and a list of removals to propose. A session can only act
    on the cards in its own job, and only for its own thread. Returns
    (tagged, facts, removals, movement) for the digest."""
    tagged, facts, removals, movement = [], [], [], []
    for job in jobs:
        slug, report = job["slug"], reports.get(job["slug"])
        if report is None:
            continue    # not judged: the same cards are looked at again tomorrow
        by_id = {card["id"]: card for card in job["cards"]}
        for card_id in report.get("belongs") or []:
            card = by_id.get(card_id)
            if not card or card["tagged"]:
                continue
            if card_id in kept_claims and slug not in kept_claims[card_id]:
                continue    # the reconcile session gave this card to another thread
            ok, error = add_tag(card_id, slug) if apply else (True, "")
            tagged.append({"card": card_id, "tag": slug, "ok": ok, "error": error})
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
    return tagged, facts, removals, movement


def apply_person_reports(jobs, reports, state, target, apply):
    """Turn the person sessions' verdicts into writes: the right person's tag
    added, and any wrong tag from the group listed for removal."""
    tagged, removals = [], []
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
            if person in group and person not in card["tagged_as"]:
                ok, error = add_tag(card["id"], person) if apply else (True, "")
                tagged.append({"card": card["id"], "tag": person, "ok": ok, "error": error})
            for wrong in card["tagged_as"]:
                if wrong != person:
                    removals.append({"card_id": card["id"], "tag": wrong, "reason": reason,
                                     "card_text": card["text"][:400]})
        if apply:
            state["names"][job["state_key"]] = target.isoformat()
    return tagged, removals


def main_removals(main_report, cards, target, people, risky):
    """The person tags the main session called wrong, as removals to propose.
    Only real person tags on the day's own cards count, and risky names are
    left to their own session."""
    todays = {card["id"]: card for card in _in_days(cards, target, target)}
    slugs = {person["slug"] for person in people} - set(risky)
    removals = []
    for item in (main_report or {}).get("people_wrong") or []:
        card = todays.get((item or {}).get("card"))
        tag = (item or {}).get("tag")
        if card and tag in slugs and tag in card["tags"]:
            removals.append({"card_id": card["id"], "tag": tag,
                             "reason": str(item.get("reason") or "").strip(),
                             "card_text": card["body"][:400]})
    return removals


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
        lines.append(f"- tagged `{item['card']}` with `{item['tag']}`"
                     + ("" if item["ok"] else f" — FAILED: {item['error']}"))
    for item in outcome["facts"]:
        lines.append(f"- fact added to `{item['slug']}`: {item['fact'].get('section')}"
                     + ("" if item["ok"] else f" — REFUSED: {item['error']}"))
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

def tend(target, crickets_dir, model="sonnet", main_model="sonnet", dry_run=False,
         apply=True, only_thread=None, session=run_session, out=print):
    """Run one night's tending for `target` and return what happened."""
    cards, threads, people = load_cards(), load_threads(), namerisk.all_people()
    risky = risky_names(people, target + timedelta(days=1))
    state = load_state()
    night_dir = _work_dir() / target.isoformat()

    def log(message):
        if message:
            with open(night_dir / "log.txt", "a", encoding="utf-8") as handle:
                handle.write(f"{datetime.now():%H:%M:%S} {message}\n")

    job = None if only_thread else main_job(target, cards, threads, people, risky)
    if dry_run:
        plan_threads = thread_jobs(target, cards, threads, state, None)
        plan_people = person_jobs(target, cards, people, risky, state)
        out(f"target {target}: {len(job['cards']) if job else 0} card(s) for the main session")
        out("thread sessions (before the main session adds what it finds):")
        for item in plan_threads:
            out(f"  {item['slug']:32s} from {item['window_start']}  {len(item['cards'])} card(s)")
        out("person sessions:")
        for item in plan_people:
            out(f"  {item['name']:20s} {[p['slug'] for p in item['people']]}  {len(item['cards'])} card(s)")
        return {"threads": plan_threads, "people": plan_people}

    night_dir.mkdir(parents=True, exist_ok=True)
    failed = []
    main_report = session("thread-main", job, night_dir, "main", crickets_dir, main_model, log) if job else None
    if job and main_report is None:
        failed.append("main")

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

    # The reconcile session: only for cards two or more thread sessions claimed.
    kept_claims = {}
    disputes = contested(reports, jobs)
    if disputes:
        verdict = session("thread-reconcile", {"target": target.isoformat(), "cards": disputes},
                          night_dir, "reconcile", crickets_dir, main_model, log)
        if verdict is None:
            failed.append("reconcile")      # every claim stands: a card may carry several tags
        else:
            for card in disputes:
                keep = (verdict.get("keep") or {}).get(card["id"])
                if isinstance(keep, list):
                    kept_claims[card["id"]] = set(keep) & {claim["slug"] for claim in card["claims"]}

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

    tagged, facts, removals, movement = apply_thread_reports(
        jobs, reports, kept_claims, state, target, apply)
    people_tagged, people_removals = apply_person_reports(
        people_jobs, people_reports, state, target, apply)
    removals = removals + people_removals + main_removals(main_report, cards, target, people, risky)
    staged, held = propose_untags(removals, state) if apply else ([], removals)
    hints = save_hints(main_report, cards, target, apply)
    if apply:
        save_state(state)
    outcome = {"target": target.isoformat(), "tagged": tagged + people_tagged, "facts": facts,
               "staged": staged, "held": held, "movement": movement, "failed": failed,
               "hints": hints, "applied": apply}
    write_digest(night_dir, target, outcome)
    (night_dir / "outcome.json").write_text(json.dumps(outcome, indent=1), encoding="utf-8")
    out(f"thread tending {target}: {len(jobs)} thread(s), {len(people_reports)} name(s),"
        f" {len(outcome['tagged'])} tag(s), {len(facts)} fact(s), {len(staged)} removal(s) asked,"
        f" {len(failed)} failed — {night_dir / 'digest.md'}")
    return outcome


def main(argv=None):
    parser = argparse.ArgumentParser(description="Nightly thread tending (see the top of this file).")
    parser.add_argument("target", nargs="?", help="the day to tend, YYYY-MM-DD (default: yesterday)")
    parser.add_argument("--crickets-dir", default=os.environ.get(
        "EXOCORTEX_CRICKETS_DIR", str(SKELETON / "agents" / "crickets")))
    parser.add_argument("--model", default="sonnet", help="model for the thread and person sessions")
    parser.add_argument("--main-model", default="sonnet", help="model for the main and reconcile sessions")
    parser.add_argument("--dry-run", action="store_true", help="print the plan; run and write nothing")
    parser.add_argument("--no-apply", action="store_true", help="run the sessions but apply nothing")
    parser.add_argument("--only-thread", help="run only this thread's session")
    args = parser.parse_args(argv)
    target = date.fromisoformat(args.target) if args.target else date.today() - timedelta(days=1)

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
    sys.exit(main())
