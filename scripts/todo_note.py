#!/usr/bin/env python3
"""The one door an agent uses to leave a note on a to-do.

**What this does, in plain English.** An agent working in an Observatory
session (Triage, a helper, the Keeper) sometimes learns something worth
pinning to a to-do — a date, a phone number, "she said to wait for the
letter". It used to write that straight into the item's `notes`, at any
length, with no record of who wrote it or where it came from. Now it runs
this instead:

    scripts/todo_note.py --id 3f9a1c2b --by triage \\
        --text "Surgeon must be in-network before Oct 2 — she named the deadline" \\
        --ref card:2026-08-20.1432a

and the rule set in `todo_provenance.py` is enforced at the door: the text
is capped (240 chars), at least one `--ref` is required, and the note is
stamped with the agent's name, the minute, and the Observatory conversation
it came out of (read from EXOCORTEX_CONV_ID, which the turn host sets — the
agent doesn't have to know it). The owner's own `notes` field is never
touched by this script; agent notes live beside it under `agent_notes` and
the app shows them as the agent's words, with the citation, and a way to
dismiss them.

**By default the note is PROPOSED, not written.** It goes into the approval
queue tagged with the conversation, and the approval sheet pops over that
Observatory pane while the agent is still talking; the note lands only on
Approve. `--direct` writes immediately — for unattended callers (cron), not
for a session the owner is sitting in.

`--show` prints an item's current notes and agent notes, for an agent that
wants to check before it writes twice.

Exit status is non-zero, with the reason on stderr, for any rule violation
or an unknown id — nothing is written in that case. Writes go through
store.mutate, so they're atomic and locked the same as the app's own.

Touches: `todo_provenance.py` (the rules), `store.py` (the write),
`routes/todos.py` (the sibling door the app's approval sheet uses).

Prompt that produced this: "i just want the agent to write less and for it
to link to where it got the information every time or like reference it."
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import store  # noqa: E402
import todo_provenance as prov  # noqa: E402


def _find(todos, ident):
    for sec in todos.values():
        if not isinstance(sec, dict):
            continue
        for it in sec.get("items", []):
            if it.get("id") == ident:
                return it
    return None


def show(ident):
    item = _find(store.read("todos", {}), ident)
    if item is None:
        print(f"todo_note: no to-do with id {ident!r}", file=sys.stderr)
        return 2
    out = {"id": item.get("id"), "text": item.get("text"),
           "origin": item.get("origin"), "notes": item.get("notes"),
           "agent_notes": item.get("agent_notes", [])}
    print(json.dumps(out, indent=2, ensure_ascii=False))
    return 0


def add(ident, by, text, refs, conv=None, direct=False):
    try:
        note = prov.make_agent_note(by, text, refs, conv)
    except prov.ProvenanceError as e:
        print(f"todo_note: {e}", file=sys.stderr)
        return 2
    if not direct:
        # The normal path: stage it. The proposal is tagged with this
        # conversation, so the approval sheet pops over the pane the agent
        # is talking in; the note lands only when the owner taps Approve.
        from scripts.stage_change import stage_change, StageError
        item = _find(store.read("todos", {}), ident)
        if item is None:
            print(f"todo_note: no to-do with id {ident!r}", file=sys.stderr)
            return 2
        payload = {"id": ident, "item_text": item.get("text") or "", "by": note["by"],
                   "text": note["text"], "refs": note["refs"]}
        if note.get("conv"):
            payload["conv"] = note["conv"]
        try:
            entry = stage_change("agent_note", payload,
                                 summary=f"{note['by']} wants to note on “{payload['item_text']}”",
                                 by=note["by"], conv=note.get("conv"))
        except StageError as e:
            print(f"todo_note: {e}", file=sys.stderr)
            return 2
        print(f"proposed note on [{ident}] by {note['by']} — awaiting approval"
              f"{' in conversation ' + entry['conv'] if entry.get('conv') else ''}")
        return 0
    found = False
    with store.mutate("todos", {}) as todos:
        item = _find(todos, ident)
        if item is not None:
            found = True
            prov.append_agent_note(item, note)
    if not found:
        print(f"todo_note: no to-do with id {ident!r}", file=sys.stderr)
        return 2
    print(f"noted on [{ident}] by {note['by']} ({len(note['text'])}/{prov.AGENT_NOTE_MAX} chars, "
          f"{len(note['refs'])} ref{'s' if len(note['refs']) != 1 else ''})")
    return 0


def main(argv=None):
    p = argparse.ArgumentParser(
        prog="todo_note.py",
        description=f"Leave a short, cited agent note on a to-do (cap {prov.AGENT_NOTE_MAX} chars).")
    p.add_argument("--id", required=True, help="the to-do's 8-hex id")
    p.add_argument("--show", action="store_true", help="print the item's notes and exit")
    p.add_argument("--by", help="agent name, e.g. triage, keeper, cricket:todos")
    p.add_argument("--text", help="the note (<= %d chars)" % prov.AGENT_NOTE_MAX)
    p.add_argument("--ref", action="append", default=[],
                   help="where it came from; repeatable. kinds: " + ", ".join(prov.REF_KINDS))
    p.add_argument("--conv", help="override the conversation id (default: EXOCORTEX_CONV_ID)")
    p.add_argument("--direct", action="store_true",
                   help="write immediately instead of staging for approval (cron/crickets only)")
    a = p.parse_args(argv)
    if a.show:
        return show(a.id)
    if not a.by or not a.text:
        p.error("--by and --text are required (or use --show)")
    return add(a.id, a.by, a.text, a.ref, a.conv, direct=a.direct)


if __name__ == "__main__":
    # Put this run on the runtime map (runtime_sensor.py): which of our
    # files actually execute, and which call which. Inside __main__ rather
    # than at import, because some of these modules are also imported BY
    # the web app, and only the standalone run is a process of its own.
    import runtime_sensor
    runtime_sensor.attach()
    sys.exit(main())
