#!/usr/bin/env python3
"""The single write door for the research LLM agents (runner/deep/filer/worker).

research.json used to be written by having each agent's CLAUDE.md instruct it
to read the file, mutate a Python dict in its head, then atomically mv a
freshly-written temp file over the original. That's a *prompt-enforced*
contract — the "only touch these fields" and "never set reviewed=true" rules
lived entirely in English, in each agent's CLAUDE.md, with nothing stopping a
model from writing whatever it wanted straight into the JSON on a bad day.

This script replaces that with a *code-enforced* one: five small verbs, each
one store.mutate() call, each shaped exactly like the field-level guarantees
research.json's routes already make (see routes/research.py's author-boundary
rules around entry/flag + entry/review). Agents call a verb; they never open
research.json themselves. `apply` is worker_apply_result.apply_result,
imported here rather than reimplemented — that script stays the single
source of truth for the worker-close path (it also kicks the dispatcher and
deregisters the worker's tmux tab, which is still wanted).

`create-topic`'s duplicate-refusal exists because of a real incident: a long
deep-research run created the topic `hair-scalp-care` early in its life, then
— having forgotten that decision by the time it got to a related question an
hour later — created `hair-care` too. Refusing a second topic with the same
normalized name and printing the existing id back lets the calling agent
just use what's already there instead of silently forking the taxonomy.

Usage (each subcommand does ONE store.mutate and prints OK/ERROR):

    EXOCORTEX_DATA_DIR=/path/to/data python3 research_ctl.py reply \\
        --session <id> --to <entry_id> --text "..." [--file "report.md"]

    EXOCORTEX_DATA_DIR=/path/to/data python3 research_ctl.py apply \\
        --session <id> --text "..." [--file "report.md"]

    EXOCORTEX_DATA_DIR=/path/to/data python3 research_ctl.py file \\
        --entry <entry_id> --topics id1,id2

    EXOCORTEX_DATA_DIR=/path/to/data python3 research_ctl.py create-topic \\
        --name "Some Name"

    EXOCORTEX_DATA_DIR=/path/to/data python3 research_ctl.py close \\
        --session <id> --status done --report "..."

Can also be imported and called directly:
    from scripts.research_ctl import reply, apply, file, create_topic, close

GUARDS (mirroring routes/research.py's author-boundary rules — entry/flag
refuses to touch an "author": "llm" entry, entry/review refuses to touch
anything that isn't one): no verb here ever sets `reviewed` true, touches
`verdict`, or changes a question's `status`. Those stay hers alone, same as
in the routes.
"""
import argparse
import os
import re
import sys
from datetime import datetime

# Make the skeleton root importable regardless of where the script is invoked from.
HERE = os.path.dirname(os.path.abspath(__file__))
SKELETON = os.path.dirname(HERE)
if SKELETON not in sys.path:
    sys.path.insert(0, SKELETON)

import store  # noqa: E402
from routes.research import _new_entry_id, _slugify, _unique_id  # noqa: E402
from scripts.worker_apply_result import apply_result as _apply_result  # noqa: E402

RESEARCH_DEFAULT = {"topics": [], "entries": [], "sessions": []}


def _normalize_name(name):
    """Lowercase, alphanumeric-collapsed form used for create-topic dedup —
    "Hair Care!" and "hair care" and "Hair-Care" all normalize the same."""
    return re.sub(r"[^a-z0-9]+", "", name.strip().lower())


def reply(session_id, to_entry_id, text, file=None):
    """Append an llm reply entry to `to_entry_id`, shaped exactly like
    worker_apply_result's, and mark that target entry processed/unflagged.
    Does NOT touch the session record (the caller may reply many times
    before closing it with `close`).

    Raises:
        ValueError: if the session or the target entry is not found.

    Returns:
        The newly created reply entry dict.
    """
    now = datetime.now().strftime("%Y-%m-%d %H:%M")

    with store.mutate("research.json", dict(RESEARCH_DEFAULT)) as data:
        sessions = data.setdefault("sessions", [])
        session = next((s for s in sessions if s["id"] == session_id), None)
        if session is None:
            raise ValueError(f"Session not found: {session_id!r}")

        entries = data.setdefault("entries", [])
        target = next((e for e in entries if e["id"] == to_entry_id), None)
        if target is None:
            raise ValueError(f"Target entry not found: {to_entry_id!r}")

        entry = {
            "id": _new_entry_id(entries),
            "kind": "note",
            "text": text,
            "topics": list(target.get("topics") or []),
            "url": "",
            "verdict": "",
            "status": "",
            "reply_to": to_entry_id,
            "created": now,
            "author": "llm",
            "reviewed": False,
            "session": session_id,
        }
        if file:
            entry["file"] = file
        entries.append(entry)

        # Mirrors routes/research.py: only `processed`/`flagged` are ever
        # touched on a source entry by a reply — status is hers alone.
        target["processed"] = True
        target["flagged"] = False

    return entry


def apply(session_id, text, file=None):
    """Delegate to worker_apply_result.apply_result — the worker-close path
    (reply + question processed + session done + dispatcher kick + tmux
    tab deregistration) stays owned by that script; this just re-exposes it
    as a verb so every write goes through this one CLI."""
    return _apply_result(session_id, text, file=file)


def file(entry_id, topic_ids):
    """Replace an entry's `topics` list wholesale. Every id in `topic_ids`
    must already exist in data["topics"]; an empty list unfiles the entry.

    Raises:
        ValueError: if the entry, or any given topic id, doesn't exist.
    """
    with store.mutate("research.json", dict(RESEARCH_DEFAULT)) as data:
        entries = data.setdefault("entries", [])
        entry = next((e for e in entries if e["id"] == entry_id), None)
        if entry is None:
            raise ValueError(f"Entry not found: {entry_id!r}")

        topics = data.setdefault("topics", [])
        known = {t["id"] for t in topics}
        unknown = [tid for tid in topic_ids if tid not in known]
        if unknown:
            raise ValueError(f"Unknown topic id(s): {', '.join(unknown)}")

        entry["topics"] = list(topic_ids)

    return entry


class TopicExists(ValueError):
    """Raised by create_topic when a topic with the same normalized name
    already exists. `existing_id` / `existing_name` let the caller recover."""

    def __init__(self, existing_id, existing_name):
        self.existing_id = existing_id
        self.existing_name = existing_name
        super().__init__(
            f"topic already exists: {existing_id} ({existing_name!r})"
        )


def create_topic(name):
    """Create a topic with the same slugify + collision-suffix id scheme as
    routes/research.py's topic/add route. Refuses (TopicExists) if a topic
    with the same normalized name already exists, rather than silently
    forking the taxonomy — see module docstring for why this matters.

    Returns:
        The newly created topic dict.
    """
    now = datetime.now().strftime("%Y-%m-%d %H:%M")
    normalized = _normalize_name(name)

    with store.mutate("research.json", dict(RESEARCH_DEFAULT)) as data:
        topics = data.setdefault("topics", [])
        existing = next(
            (t for t in topics if _normalize_name(t["name"]) == normalized), None
        )
        if existing is not None:
            raise TopicExists(existing["id"], existing["name"])

        tid = _unique_id(_slugify(name), {t["id"] for t in topics})
        topic = {"id": tid, "name": name, "status": "active", "created": now}
        topics.append(topic)

    return topic


def close(session_id, status, report):
    """Set a session's status + report. No other field is touched.

    Raises:
        ValueError: if the session is missing, or status isn't done/failed.
    """
    if status not in ("done", "failed"):
        raise ValueError(f"Bad status: {status!r} (must be 'done' or 'failed')")

    with store.mutate("research.json", dict(RESEARCH_DEFAULT)) as data:
        sessions = data.setdefault("sessions", [])
        session = next((s for s in sessions if s["id"] == session_id), None)
        if session is None:
            raise ValueError(f"Session not found: {session_id!r}")

        session["status"] = status
        session["report"] = report

    return session


def _cmd_reply(args):
    entry = reply(args.session, args.to, args.text, file=args.file)
    print(f"OK: reply entry {entry['id']!r} added, target {args.to!r} marked processed")


def _cmd_apply(args):
    entry = apply(args.session, args.text, file=args.file)
    print(f"OK: reply entry {entry['id']!r} added for session {args.session!r}")


def _cmd_file(args):
    raw = (args.topics or "").strip()
    topic_ids = [t.strip() for t in raw.split(",") if t.strip()] if raw else []
    entry = file(args.entry, topic_ids)
    print(f"OK: entry {entry['id']!r} filed under {entry['topics']!r}")


def _cmd_create_topic(args):
    try:
        topic = create_topic(args.name)
    except TopicExists as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)
    print(f"OK: topic {topic['id']!r} created")


def _cmd_close(args):
    session = close(args.session, args.status, args.report)
    print(f"OK: session {session['id']!r} closed as {session['status']!r}")


def main():
    parser = argparse.ArgumentParser(
        description="Single write door for the research LLM agents.",
    )
    sub = parser.add_subparsers(dest="verb", required=True)

    p_reply = sub.add_parser("reply", help="Append an llm reply to an entry.")
    p_reply.add_argument("--session", required=True)
    p_reply.add_argument("--to", required=True, help="Entry id to reply to")
    p_reply.add_argument("--text", required=True)
    p_reply.add_argument("--file", default=None)
    p_reply.set_defaults(func=_cmd_reply)

    p_apply = sub.add_parser("apply", help="worker_apply_result.apply_result.")
    p_apply.add_argument("--session", required=True)
    p_apply.add_argument("--text", required=True)
    p_apply.add_argument("--file", default=None)
    p_apply.set_defaults(func=_cmd_apply)

    p_file = sub.add_parser("file", help="Replace an entry's topics list.")
    p_file.add_argument("--entry", required=True)
    p_file.add_argument(
        "--topics", required=True,
        help="Comma-separated topic ids, or '' to unfile",
    )
    p_file.set_defaults(func=_cmd_file)

    p_create_topic = sub.add_parser("create-topic", help="Create a new topic.")
    p_create_topic.add_argument("--name", required=True)
    p_create_topic.set_defaults(func=_cmd_create_topic)

    p_close = sub.add_parser("close", help="Set a session's status + report.")
    p_close.add_argument("--session", required=True)
    p_close.add_argument("--status", required=True, choices=("done", "failed"))
    p_close.add_argument("--report", required=True)
    p_close.set_defaults(func=_cmd_close)

    args = parser.parse_args()

    try:
        args.func(args)
        sys.exit(0)
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
