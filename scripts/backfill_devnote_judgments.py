#!/usr/bin/env python3
"""One-time: move her five months of verdicts onto the notes they were about.

Plain English: until now a dev note carried one boolean (`night`) and her actual
rulings lived on night-crew RUN records — so 23 notes had a verdict recorded
somewhere and nothing on the note itself. This walks both files and writes each
ruling onto its note as a `judgments` entry (see devnote_judgments.py).

Dry run by default. Nothing is written without --apply.

THE ONE JUDGMENT CALL IN HERE — old rejects become `unsure`, not `denied`.
The old surface had two buttons, so "not this" had to carry both "I don't want
it" and "I can't tell what this is". Reading the recorded reasons, five of the
six explained rejects are the second one. The new vocabulary can tell them
apart; the old records can't be sorted by anything but guessing, and guessing
from her prose is exactly how a fake number gets made.

So: land them all on `unsure`, which is the recoverable error. She re-rules them
in one tap each under the real vocabulary. The alternative — calling them all
`denied` — would need an invented reason (`outdated` or `completed`) on every
one, and would bury notes she said out loud she might still want. Her original
words ride along as the judgment's note either way, so nothing she wrote is lost.

Approvals are unambiguous and land as `approved`.

Idempotent: a note that already has judgments is skipped, so re-running is safe.

Usage:
    ./venv/bin/python3 scripts/backfill_devnote_judgments.py           # show
    ./venv/bin/python3 scripts/backfill_devnote_judgments.py --apply   # write
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import devnote_judgments as dj  # noqa: E402
import store  # noqa: E402

# The old two-button vocabulary, mapped onto the new four.
VERDICT_MAP = {
    "approve": "approved",
    "reject": "unsure",   # see the module docstring — the recoverable error
}


def load():
    return (store.read("dev_notes.json", {"tabs": {}}),
            store.read("night_runs.json", {"runs": []}))


def rulings_by_note(runs):
    """note_id -> [ruling, ...] oldest first. A note judged more than once keeps
    every ruling; the list is the record."""
    out = {}
    for r in runs or []:
        if not isinstance(r, dict) or not r.get("verdict"):
            continue
        nid = r.get("note_id")
        if not nid:
            continue
        out.setdefault(nid, []).append({
            "verdict": VERDICT_MAP.get(r["verdict"], "unsure"),
            "note": (r.get("her_note") or "").strip(),
            "at": (r.get("judged_at") or r.get("finished") or "")[:16],
        })
    for rulings in out.values():
        rulings.sort(key=lambda x: x["at"] or "")
    return out


def plan():
    """Every write this would make, as (tab, note, [entries], why) — computed
    without touching anything so the dry run and the apply can't diverge."""
    notes_doc, runs_doc = load()
    rulings = rulings_by_note(runs_doc.get("runs", []))
    actions, skipped = [], []

    for tab, notes in (notes_doc.get("tabs") or {}).items():
        for n in notes or []:
            if not isinstance(n, dict):
                continue
            if dj.history(n):
                skipped.append((tab, n, "already has judgments"))
                continue

            found = rulings.get(n.get("id"))
            if found:
                entries = [dj.make(r["verdict"], text=r["note"], at=r["at"] or None)
                           for r in found]
                actions.append((tab, n, entries, f"{len(found)} ruling(s) from run records"))
                continue

            # No run ruling — fall back to the old flag, which is all some notes
            # ever carried. `night: true` was her moon tap; `night: false` was
            # written by a reject whose run record is gone.
            if n.get("night") is True:
                actions.append((tab, n, [dj.make("approved", text="", at=n.get("created"))],
                                "night: true (her green light)"))
            elif n.get("night") is False:
                actions.append((tab, n, [dj.make("unsure", text="", at=n.get("created"))],
                                "night: false (an old reject, no run record)"))
    return notes_doc, actions, skipped


def main():
    apply = "--apply" in sys.argv
    notes_doc, actions, skipped = plan()

    counts = {}
    for _tab, _n, entries, _why in actions:
        counts[entries[-1]["verdict"]] = counts.get(entries[-1]["verdict"], 0) + 1

    print(f"{'APPLYING' if apply else 'DRY RUN — nothing written'}\n")
    for tab, n, entries, why in actions:
        verdicts = " → ".join(e["verdict"] for e in entries)
        print(f"  [{tab}] {n.get('text','')[:64]!r}")
        print(f"        {verdicts}   ({why})")
        for e in entries:
            if e.get("note"):
                print(f"        your words: {e['note'][:80]!r}")
    print(f"\n{len(actions)} note(s) would be written; {len(skipped)} skipped.")
    print("landing verdicts:", counts or "none")

    if not apply:
        print("\nRe-run with --apply to write.")
        return

    for _tab, n, entries, _why in actions:
        n["judgments"] = entries
        n.pop("night", None)   # the field these judgments replace
    store.write("dev_notes.json", notes_doc)
    print("\nwritten.")


if __name__ == "__main__":
    main()
