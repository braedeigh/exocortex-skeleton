#!/usr/bin/env python3
"""nightcrew_preview.py — what would the night crew actually be allowed to do?

Plain English: the triage gate (tools/nightcrew/triage.py) needs two things to
let a note through — her green-light tap, and the text rules. Nothing is
tapped yet, so this script answers the question that comes first: *if she
green-lit every dev note tonight, which ones would survive the rules?* That's
the size of the crew's real diet, measured instead of guessed.

Run it any time; it only reads. Writes nothing, spawns nothing.

    EXOCORTEX_DATA_DIR=<VAULT_DIR>/data \
        ./venv/bin/python3 scripts/nightcrew_preview.py

    ... --tab today     # one tab
    ... --show-rejects  # every rejection with its reason

Touches: tools/nightcrew/triage.py (the rules), dev_notes.json in the data dir
(read-only).
"""
import argparse
import os
import sys
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import store  # noqa: E402
from tools.nightcrew import triage  # noqa: E402


def preview(tabs, only_tab=None):
    """Run triage with lock 1 forced open, so only the text rules speak.

    Copies each note with `night: True` rather than mutating — this script must
    never write a flag back into her notes as a side effect of looking.
    """
    forced = {}
    for tab, notes in (tabs or {}).items():
        if only_tab and tab != only_tab:
            continue
        forced[tab] = [{**n, "night": True} for n in (notes or []) if isinstance(n, dict)]
    return triage.triage(forced)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--tab", help="only this dev-notes tab")
    ap.add_argument("--show-rejects", action="store_true",
                    help="list every rejected note with its reason")
    args = ap.parse_args()

    tabs = store.read("dev_notes.json", {"tabs": {}}).get("tabs", {})
    total = sum(len(v or []) for v in tabs.values())
    result = preview(tabs, args.tab)
    ok, no = result["eligible"], result["rejected"]

    print(f"\n  {total} dev notes total")
    print(f"  {len(ok)} would pass the gate     ({len(ok) * 100 // max(total, 1)}%)")
    print(f"  {len(no)} would be turned away\n")

    print("  ELIGIBLE — the crew's actual diet")
    print("  " + "-" * 64)
    for r in sorted(ok, key=lambda r: r["tab"]):
        print(f"  [{r['tab']:<11}] {r['id']}  {r['text'][:60]}")
    if not ok:
        print("  (nothing)")

    # The reason distribution is the useful half: it says WHICH rule is doing
    # the work, so a rule that's too greedy shows up as an outsized count.
    print("\n  WHY THE REST WERE TURNED AWAY")
    print("  " + "-" * 64)
    for reason, n in Counter(r["reason"].split(" — ")[0] for r in no).most_common():
        print(f"  {n:>4}  {reason}")

    if args.show_rejects:
        print("\n  EVERY REJECTION")
        print("  " + "-" * 64)
        for r in sorted(no, key=lambda r: r["reason"]):
            print(f"  [{r['tab']:<11}] {r['text'][:48]:<50} {r['reason']}")
    print()


if __name__ == "__main__":
    main()
