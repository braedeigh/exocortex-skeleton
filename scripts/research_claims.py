#!/usr/bin/env python3
"""The research agents' write door for claims — how an agent records a claim
with the sources it actually read.

The law this script enforces: a citation is never something the agent didn't
read. A claim can be written on its own, and a source can be written on its
own, but the LINK between them — "this source backs that claim" — only ever
carries a passage the script itself found in the source's text, at offsets
the text really has. If the quote the agent gives is not in the text, the
link is refused and nothing is written. Offsets are never invented.

Everything an agent writes here lands `author: "llm"`, `reviewed: False`, so
the owner's review remains the gate on all of it; the annotation behind a
link is born `needs_review: True` for the same reason. This mirrors
scripts/research_ctl.py, which is the agents' door for replies, filing and
sessions — this script is the claims table's counterpart, and like that one
each verb is a single store.mutate or one researchstore helper.

Verbs (each prints to stdout, exit code 1 with the reason on stderr):

    EXOCORTEX_DATA_DIR=/path/to/data python3 research_claims.py add \\
        [--session <sid>] --topic <tid> [--topic <tid> ...] --text "..." [--verdict real|shaky|interesting]
        Creates a kind "claim" entry on those topics; prints the new entry id.
        The verdict is the agent's own reading of the claim at birth; the owner
        can still overrule it, since the entry arrives unreviewed.

    EXOCORTEX_DATA_DIR=/path/to/data python3 research_claims.py source \\
        [--session <sid>] --topic <tid> [--topic ...] --url <url> --text "title / citation"
        Creates a kind "source" entry — unless a source with that url already
        exists, in which case its id is printed and nothing is created. One url,
        one source row, however many sessions cite it.

    EXOCORTEX_DATA_DIR=/path/to/data python3 research_claims.py link <claim_id> <source_id> \\
        [--stance supports|contradicts|context] [--passage "exact quote"] [--note "..."]
        Links the source to the claim. With --passage, the quote is located in
        the source's text (the extracted text under doc_texts/ when fetched,
        else the entry's own text — docstore.resolve's order) and an annotation
        is created at the offsets found; the link then carries it.

    EXOCORTEX_DATA_DIR=/path/to/data python3 research_claims.py value <claim_id> \\
        --subject ... --measure ... --amount <number> --unit ... [--basis ...] [--year <n>] [--tier ...]
        Sets the number inside the claim (researchstore.set_claim_value).

    EXOCORTEX_DATA_DIR=/path/to/data python3 research_claims.py show <claim_id>
        Prints researchstore.claim_detail as JSON.

Can also be imported and driven directly: main(["show", "<claim_id>"]).

Touches: researchstore.py (the typed claim helpers and the research
document), docstore.py (a source's readable text), routes/research.py (the
entry id scheme and the claim verdict vocabulary, imported so the ids and
words match what the page makes).

Prompt that produced this file: "scripts/research_claims.py — the agents'
write door for claims: add / source / link / value / show. Everything an
agent writes lands reviewed: False, author: llm. source dedupes on url. link
with --passage finds the quote in the source's text and creates the
annotation at those offsets with source='llm', needs_review=True; if the
quote isn't found, exit 1 with a plain message (never invent offsets). The
law is never a citation it didn't read."
"""
import argparse
import json
import os
import re
import sys
from datetime import datetime

# Make the skeleton root importable regardless of where the script is invoked from.
HERE = os.path.dirname(os.path.abspath(__file__))
SKELETON = os.path.dirname(HERE)
if SKELETON not in sys.path:
    sys.path.insert(0, SKELETON)

import docstore  # noqa: E402
import researchstore  # noqa: E402
import store  # noqa: E402
from routes.research import CLAIM_VERDICTS, _new_entry_id  # noqa: E402

RESEARCH_DEFAULT = {"topics": [], "entries": [], "sessions": []}


def _now_stamp():
    return datetime.now().strftime("%Y-%m-%d %H:%M")


def _check_session_and_topics(data, session_id, topic_ids):
    """Refuse a session or topic id the pool does not have. An agent that
    types a topic id from memory would otherwise quietly fork the taxonomy —
    research_ctl's create-topic is the door for a new topic."""
    # A dispatched worker names its research session; a desk session in the
    # research room has none and leaves it off — then only the topics are checked.
    if session_id is not None and not any(s.get("id") == session_id for s in data.get("sessions", [])):
        raise ValueError(f"Session not found: {session_id!r}")
    known = {t.get("id") for t in data.get("topics", [])}
    missing = [t for t in topic_ids if t not in known]
    if missing:
        raise ValueError(f"Topic not found: {', '.join(repr(t) for t in missing)}")


def _llm_entry(entries, kind, text, topic_ids, session_id, **over):
    """A new entry in the shape routes/research.py's entry/add makes, stamped
    as the agent's and unreviewed. Same id scheme as the page's entries."""
    entry = {
        "id": _new_entry_id(entries),
        "kind": kind,
        "text": text,
        "topics": list(topic_ids),
        "url": "",
        "verdict": "",
        "status": "",
        "reply_to": None,
        "created": _now_stamp(),
        "author": "llm",
        "reviewed": False,
        "session": session_id,
    }
    # Stamp the Observatory conversation this was written from, when there is
    # one (the Observatory sets EXOCORTEX_CONV_ID on every session it runs),
    # so "which conversation wrote this claim" stays a join even with no
    # research session in play.
    conv_id = os.environ.get("EXOCORTEX_CONV_ID")
    if conv_id:
        entry["conv_id"] = conv_id
    entry.update(over)
    return entry


def add(session_id, topic_ids, text, verdict=""):
    """Create an llm claim entry; returns the new entry dict.

    Raises ValueError for an empty text, a verdict outside CLAIM_VERDICTS, or
    a session/topic the pool does not have.
    """
    text = (text or "").strip()
    if not text:
        raise ValueError("A claim needs text")
    if verdict not in CLAIM_VERDICTS:
        raise ValueError(f"bad verdict {verdict!r}; one of {', '.join(v or '(blank)' for v in CLAIM_VERDICTS)}")
    with store.mutate("research.json", dict(RESEARCH_DEFAULT)) as data:
        _check_session_and_topics(data, session_id, topic_ids)
        entries = data.setdefault("entries", [])
        entry = _llm_entry(entries, "claim", text, topic_ids, session_id, verdict=verdict)
        entries.append(entry)
    return entry


def source(session_id, topic_ids, url, text):
    """Create an llm source entry, or hand back the one that already has this
    url. Returns (entry, created) so the caller can say which happened.

    Dedupe is on the url alone, stripped, exact: two sessions citing the same
    paper share one source row, so the claims table can show everything that
    leans on it.
    """
    url = (url or "").strip()
    text = (text or "").strip()
    if not url:
        raise ValueError("A source needs a url")
    if not text:
        raise ValueError("A source needs a title or citation as its text")
    with store.mutate("research.json", dict(RESEARCH_DEFAULT)) as data:
        entries = data.setdefault("entries", [])
        existing = next((e for e in entries
                         if e.get("kind") == "source" and (e.get("url") or "").strip() == url), None)
        if existing is not None:
            return existing, False
        _check_session_and_topics(data, session_id, topic_ids)
        entry = _llm_entry(entries, "source", text, topic_ids, session_id, url=url)
        entries.append(entry)
    return entry, True


def find_passage(text, quote):
    """Where the quote sits in the text, as (char_start, char_end), or None.

    An exact match first. Failing that, the same words with any run of
    whitespace between them — extracted PDF text breaks lines where the
    agent's quote has a space — which still yields offsets the text really
    has, because the match is taken from the text itself. The first
    occurrence wins when the quote appears more than once. Nothing fuzzier
    than whitespace: a quote the text does not contain is not found.
    """
    quote = (quote or "").strip()
    if not quote or not text:
        return None
    start = text.find(quote)
    if start >= 0:
        return start, start + len(quote)
    words = quote.split()
    pattern = r"\s+".join(re.escape(word) for word in words)
    match = re.search(pattern, text)
    if match is None:
        return None
    return match.start(), match.end()


def link(claim_id, source_id, stance="supports", passage=None, note=""):
    """Link a source to a claim, with the passage that backs it when given.

    The passage is located in the source's text — never trusted as given —
    and the annotation is written at the offsets found, as the agent's and
    needing review. Raises ValueError when the quote is not in the text, or
    when researchstore refuses the link (bad stance, unknown ids). Returns
    the annotation id, or None when no passage was given.
    """
    if stance not in researchstore.STANCES:
        raise ValueError(f"bad stance {stance!r}; one of {', '.join(researchstore.STANCES)}")
    annotation_id = None
    if passage is not None:
        # Every refusal happens before the annotation exists, so a failed
        # link leaves no orphan highlight behind.
        if researchstore.claim_detail(claim_id) is None:
            raise ValueError(f"no claim {claim_id!r}")
        doc = f"entry:{source_id}"
        resolved = docstore.resolve(doc)
        if not resolved.get("ok"):
            raise ValueError(f"no text to search for source {source_id!r}")
        text = resolved.get("text", "")
        found = find_passage(text, passage)
        if found is None:
            raise ValueError(
                f"passage not found in source {source_id!r}; the link was not made. "
                "Quote the text exactly as it reads — offsets are never invented.")
        char_start, char_end = found
        annotation_id = researchstore.add_annotation(
            doc, char_start, char_end, text[char_start:char_end],
            note=note or "", source="llm", needs_review=True)
    researchstore.link_claim_source(
        claim_id, source_id, stance=stance, annotation_id=annotation_id, note=note or "")
    return annotation_id


def value(claim_id, **fields):
    """Set the number inside a claim; only a claim entry qualifies."""
    if researchstore.claim_detail(claim_id) is None:
        raise ValueError(f"no claim {claim_id!r}")
    researchstore.set_claim_value(claim_id, **fields)


def show(claim_id):
    """A claim's detail, or raise ValueError when the id is not a claim."""
    detail = researchstore.claim_detail(claim_id)
    if detail is None:
        raise ValueError(f"no claim {claim_id!r}")
    return detail


# --- the command line ---------------------------------------------------------

def _cmd_add(args):
    entry = add(args.session, args.topic, args.text, verdict=args.verdict or "")
    print(entry["id"])


def _cmd_source(args):
    entry, created = source(args.session, args.topic, args.url, args.text)
    if not created:
        print(f"exists: source {entry['id']!r} already has this url", file=sys.stderr)
    print(entry["id"])


def _cmd_link(args):
    annotation_id = link(args.claim_id, args.source_id, stance=args.stance,
                         passage=args.passage, note=args.note or "")
    tail = f", passage {annotation_id!r}" if annotation_id else ""
    print(f"OK: {args.source_id!r} {args.stance} {args.claim_id!r}{tail}")


def _cmd_value(args):
    fields = {"subject": args.subject, "measure": args.measure,
              "amount": args.amount, "unit": args.unit}
    # Optional fields are only sent when given, so a later call amending one
    # of them does not blank the others.
    for key in ("basis", "year", "tier"):
        given = getattr(args, key)
        if given is not None:
            fields[key] = given
    value(args.claim_id, **fields)
    print(f"OK: value set on {args.claim_id!r}")


def _cmd_show(args):
    print(json.dumps(show(args.claim_id), indent=2, ensure_ascii=False))


def build_parser():
    parser = argparse.ArgumentParser(
        prog="research_claims.py",
        description="The research agents' write door for claims and their sources.")
    verbs = parser.add_subparsers(dest="verb", required=True)

    p_add = verbs.add_parser("add", help="Create an llm claim entry; prints its id.")
    p_add.add_argument("--session", default=None, help="research session id; optional for a desk session in the research room")
    p_add.add_argument("--topic", action="append", required=True, help="topic id; repeatable")
    p_add.add_argument("--text", required=True)
    p_add.add_argument("--verdict", default="", choices=[v for v in CLAIM_VERDICTS if v])
    p_add.set_defaults(func=_cmd_add)

    p_source = verbs.add_parser("source", help="Create an llm source entry, deduped on url; prints its id.")
    p_source.add_argument("--session", default=None, help="research session id; optional for a desk session in the research room")
    p_source.add_argument("--topic", action="append", required=True, help="topic id; repeatable")
    p_source.add_argument("--url", required=True)
    p_source.add_argument("--text", required=True, help="title or citation")
    p_source.set_defaults(func=_cmd_source)

    p_link = verbs.add_parser("link", help="Link a source to a claim, with the passage that backs it.")
    p_link.add_argument("claim_id")
    p_link.add_argument("source_id")
    p_link.add_argument("--stance", default="supports", choices=researchstore.STANCES)
    p_link.add_argument("--passage", default=None, help="exact quote from the source's text")
    p_link.add_argument("--note", default="")
    p_link.set_defaults(func=_cmd_link)

    p_value = verbs.add_parser("value", help="Set the number inside a claim.")
    p_value.add_argument("claim_id")
    p_value.add_argument("--subject", required=True)
    p_value.add_argument("--measure", required=True)
    p_value.add_argument("--amount", required=True, type=float)
    p_value.add_argument("--unit", required=True)
    p_value.add_argument("--basis", default=None)
    p_value.add_argument("--year", default=None, type=int)
    p_value.add_argument("--tier", default=None)
    p_value.set_defaults(func=_cmd_value)

    p_show = verbs.add_parser("show", help="Print a claim's detail as JSON.")
    p_show.add_argument("claim_id")
    p_show.set_defaults(func=_cmd_show)
    return parser


def main(argv=None):
    """Run one verb; 0 on success, 1 with the reason on stderr otherwise."""
    args = build_parser().parse_args(argv)
    try:
        args.func(args)
    except ValueError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    # Put this run on the runtime map (runtime_sensor.py), same as the other
    # scripts: inside __main__ because the module is also imported by tests.
    import runtime_sensor
    runtime_sensor.attach()
    sys.exit(main())
