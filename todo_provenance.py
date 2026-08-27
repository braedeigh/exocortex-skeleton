"""Who wrote this to-do, and where did the agent get that from.

**What this file does, in plain English.** Every to-do now carries an
`origin` — who created it (the owner, or a named agent) and when, plus the
Observatory conversation it came out of if there was one. And agents can no
longer write into a to-do's `notes` (that field is the owner's own words,
full stop). Instead an agent leaves an **agent note**: a short, capped line
of text that MUST point at where the information came from — a journal card,
a conversation, a thread, a file, a URL. The to-do keeps a list of these
under `agent_notes`, each stamped with who left it and when, so the owner
can look at any line and see at a glance *this came from Triage on the 26th,
out of that journal card* — and tap through to check.

This module is the ONE definition of those two shapes and their rules. Every
door that writes them — `routes/todos.py` (the add route and the approval
flow behind it), `scripts/todo_note.py` (the CLI an agent runs from a
session) — validates through here, so the cap and the citation rule can't be
quietly relaxed by one writer and not another.

The shapes, as they sit on a to-do in todos.json:

    "origin": {"by": "owner" | "<agent name>", "at": "YYYY-MM-DDTHH:MM",
               "conv": "<observatory conversation id>"?}

    "agent_notes": [{"by": "<agent name>", "at": "YYYY-MM-DDTHH:MM",
                     "text": "<= AGENT_NOTE_MAX chars>",
                     "refs": ["card:2026-08-20.1432a", "conv:abc123", ...],
                     "conv": "<conversation id>"?}]

A ref is `<kind>:<value>` with kind in REF_KINDS — the UI turns each kind
into a link. At least one ref is required; a note with nothing to point at
is exactly the "random shit I don't know the source of" this exists to stop.

Items written before 2026-08-27 have no `origin` at all. That is honest and
deliberate: their authorship was never recorded, and the UI says so rather
than inventing one.

Touches: `routes/todos.py`, `scripts/todo_note.py`, `todostore.py` (mirrors
these into exo.db), `frontend/src/features/todos/types.ts` (the TS twin).

Prompt that produced this: "i want the provenance first. and i want for
there to be a cap on what the agent can write ... i just want the agent to
write less and for it to link to where it got the information every time or
like reference it."
"""
from datetime import datetime
import os
import re

# The hard cap on one agent note. Long enough for a sentence and a half,
# short enough that anything rambly has to go live somewhere linkable (a
# journal card, a thread) and be cited from here instead.
AGENT_NOTE_MAX = 240

# Where an agent may point. Each kind has a place the UI can open:
#   card:<id>      a journal card (2026-08-20.1432a) -> the journal day
#   journal:<day>  a journal day (YYYY-MM-DD)
#   conv:<id>      an Observatory conversation
#   thread:<slug>  a Threads page
#   file:<path>    a file in the vault (shown as text, not linked)
#   url:<https…>   anything on the web
REF_KINDS = ("card", "journal", "conv", "thread", "file", "url")

OWNER = "owner"

_AGENT_RE = re.compile(r"^[a-z0-9][a-z0-9:_-]{0,39}$")
_REF_RE = re.compile(r"^(" + "|".join(REF_KINDS) + r"):(\S.*)$")


class ProvenanceError(ValueError):
    """A note or origin that breaks the rules — the caller turns this into a
    400 (route) or a non-zero exit (CLI). Nothing is written when it raises."""


def now_stamp():
    return datetime.now().strftime("%Y-%m-%dT%H:%M")


def current_conv():
    """The Observatory conversation this process belongs to, if any. The turn
    host (routes/observatory.py `_spawn_host`) puts EXOCORTEX_CONV_ID in every
    agent's environment, so a script an agent runs inherits it for free."""
    return (os.environ.get("EXOCORTEX_CONV_ID") or "").strip() or None


def clean_agent(by):
    """A normalised agent name ('triage', 'cricket:todos', 'session:foo'),
    or ProvenanceError. `owner` is reserved for the human."""
    by = (by or "").strip().lower()
    if not by:
        raise ProvenanceError("who is writing this? `by` is required")
    if not _AGENT_RE.match(by):
        raise ProvenanceError(
            f"bad agent name {by!r}: lowercase letters, digits, ':' '_' '-', max 40")
    return by


def clean_refs(refs):
    """A deduped list of well-formed refs, or ProvenanceError when there are
    none — every agent note must cite at least one source."""
    if isinstance(refs, str):
        refs = [refs]
    out = []
    for r in refs or []:
        r = str(r).strip()
        if not r:
            continue
        if not _REF_RE.match(r):
            raise ProvenanceError(
                f"bad ref {r!r}: must be <kind>:<value> with kind in "
                + ", ".join(REF_KINDS))
        if r not in out:
            out.append(r)
    if not out:
        raise ProvenanceError(
            "an agent note must cite where it came from: pass at least one ref "
            "(card:<id>, journal:<day>, conv:<id>, thread:<slug>, file:<path>, url:<…>)")
    return out


def make_origin(by=OWNER, conv=None, at=None):
    """The `origin` stamp for a freshly created to-do. Owner writes carry no
    conversation; agent writes carry the one from the environment unless the
    caller names it."""
    by = OWNER if (by or OWNER) == OWNER else clean_agent(by)
    origin = {"by": by, "at": at or now_stamp()}
    if by != OWNER:
        conv = conv or current_conv()
        if conv:
            origin["conv"] = str(conv)
    return origin


def make_agent_note(by, text, refs, conv=None, at=None):
    """A validated agent note, ready to append to `agent_notes`. Enforces the
    cap and the citation rule; strips and collapses whitespace so the cap is
    on real content."""
    by = clean_agent(by)
    if by == OWNER:
        raise ProvenanceError("agent notes are for agents; the owner edits `notes` directly")
    text = " ".join((text or "").split())
    if not text:
        raise ProvenanceError("note text is empty")
    if len(text) > AGENT_NOTE_MAX:
        raise ProvenanceError(
            f"note is {len(text)} chars; the cap is {AGENT_NOTE_MAX}. Say less here "
            "and put the rest somewhere linkable (a journal card or thread), then cite it")
    note = {"by": by, "at": at or now_stamp(), "text": text, "refs": clean_refs(refs)}
    conv = conv or current_conv()
    if conv:
        note["conv"] = str(conv)
    return note


def append_agent_note(item, note):
    """Attach a made note to a to-do dict in place. Kept tiny so the two
    writers can't diverge on the field name."""
    item.setdefault("agent_notes", []).append(note)
    return item
