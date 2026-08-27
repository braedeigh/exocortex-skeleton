#!/usr/bin/env python3
"""An agent proposes a to-do change — and it pops over the pane it came from.

**What this does, in plain English.** When an agent in an Observatory
session wants to add a to-do or change one (move it, give it a date, snooze
it), it no longer touches todos.json. It runs this, which drops a proposal
into the approval queue tagged with the conversation it came from
(EXOCORTEX_CONV_ID, set by the turn host). The Observatory pane for THAT
conversation sees the tag and pops the approval sheet right there, over the
chat, while the agent is still talking — Approve, edit, or Deny, and nothing
touches the list until Approve.

Two subcommands:

    todo_propose.py add --by triage --text "Call the surgeon's office" \\
        --bucket up_next --front health --due-by 2026-09-15 \\
        --note "Named as the next step before Oct 2" --ref card:2026-08-27.1426b

    todo_propose.py patch --by triage --id 3f9a1c2b --bucket now \\
        --due-by 2026-08-29 --why "You said this can't slip past Friday" \\
        --ref conv:$EXOCORTEX_CONV_ID

`add` stages a `life_todo` (the same kind the todos cricket uses; the sheet
is the native to-do form, prefilled). `--note` + `--ref` become the item's
first agent note — capped at 240 chars, must cite a source, same rule as
everywhere (todo_provenance.py). `patch` stages a `life_patch`: only
bucket / due_by / due_time / snoozed_until / after_date / duration_min may
change; `--why` (with a `--ref`) is kept as an agent note on the item so the
reason survives the change. Text and the owner's notes are never patchable.

Non-zero exit with the reason on stderr for anything the rules refuse;
nothing is staged in that case.

Touches: `scripts/stage_change.py` (the queue writer), `routes/pending.py`
(commits on Approve), `todo_provenance.py` (the rules),
`frontend/src/features/approvals/ConversationApprovals.tsx` (the pop-over).

Prompt that produced this: "i also want for new to-dos and modifications to
pop up over the terminal screen i'm acting in so that i can review them as
that agent is generating or modifying them" / "i want it to pop up over THIS
pane. the observatory pane where this agent is talking specifically."
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import store  # noqa: E402
import todo_provenance as prov  # noqa: E402
from scripts.stage_change import stage_change, StageError  # noqa: E402


def _item_text(ident):
    for sec in store.read("todos", {}).values():
        if isinstance(sec, dict):
            for it in sec.get("items", []):
                if it.get("id") == ident:
                    return it.get("text") or ""
    return None


def cmd_add(a):
    payload = {"text": a.text.strip(), "bucket": a.bucket, "by": a.by}
    if a.front:
        payload["fronts"] = a.front
    if a.due_by:
        payload["due_by"] = a.due_by
    if a.note:
        payload["agent_note"] = {"text": a.note, "refs": a.ref}
    try:
        if a.note:
            prov.make_agent_note(a.by, a.note, a.ref, a.conv)
        entry = stage_change("life_todo", payload,
                             summary=f"{a.by} proposes a to-do: “{payload['text']}” → {a.bucket}",
                             by=a.by, conv=a.conv)
    except (prov.ProvenanceError, StageError) as e:
        print(f"todo_propose: {e}", file=sys.stderr)
        return 2
    print(f"proposed [{entry['id'][:8]}] add “{payload['text']}” → {a.bucket}"
          f"{' (conversation ' + entry['conv'] + ')' if entry.get('conv') else ''}")
    return 0


def cmd_patch(a):
    fields = {}
    for k in ("bucket", "due_by", "due_time", "snoozed_until", "after_date", "duration_min"):
        v = getattr(a, k)
        if v is not None:
            fields[k] = v
    text = _item_text(a.id)
    if text is None:
        print(f"todo_propose: no to-do with id {a.id!r}", file=sys.stderr)
        return 2
    payload = {"id": a.id, "item_text": text, "fields": fields, "by": a.by}
    if a.why:
        payload["why"] = a.why
        payload["refs"] = a.ref
    changes = ", ".join(f"{k} → {v or 'clear'}" for k, v in fields.items())
    try:
        entry = stage_change("life_patch", payload,
                             summary=f"{a.by} proposes on “{text}”: {changes}",
                             by=a.by, conv=a.conv)
    except StageError as e:
        print(f"todo_propose: {e}", file=sys.stderr)
        return 2
    print(f"proposed [{entry['id'][:8]}] patch “{text}”: {changes}")
    return 0


def main(argv=None):
    p = argparse.ArgumentParser(prog="todo_propose.py",
                                description="Propose a to-do add or change for approval.")
    sub = p.add_subparsers(dest="cmd", required=True)
    for s in ("add", "patch"):
        sp = sub.add_parser(s)
        sp.add_argument("--by", required=True, help="agent name, e.g. triage")
        sp.add_argument("--ref", action="append", default=[],
                        help="source, repeatable: " + ", ".join(prov.REF_KINDS))
        sp.add_argument("--conv", default=None, help="override $EXOCORTEX_CONV_ID")
    add = sub.choices["add"]
    add.add_argument("--text", required=True)
    add.add_argument("--bucket", default="now", choices=prov.BUCKETS)
    add.add_argument("--front", action="append", default=[], help="front id, repeatable")
    add.add_argument("--due-by", dest="due_by", default=None)
    add.add_argument("--note", default=None, help=f"agent note (<= {prov.AGENT_NOTE_MAX} chars; needs --ref)")
    patch = sub.choices["patch"]
    patch.add_argument("--id", required=True)
    patch.add_argument("--bucket", default=None, choices=prov.BUCKETS)
    for k in ("due_by", "due_time", "snoozed_until", "after_date", "duration_min"):
        patch.add_argument("--" + k.replace("_", "-"), dest=k, default=None,
                           help="'' to clear")
    patch.add_argument("--why", default=None, help="reason, kept as an agent note (needs --ref)")
    a = p.parse_args(argv)
    return cmd_add(a) if a.cmd == "add" else cmd_patch(a)


if __name__ == "__main__":
    sys.exit(main())
