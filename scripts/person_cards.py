#!/usr/bin/env python3
"""person_cards.py — everything a reader needs to write a fact sheet about ONE
person in the owner's vault.

**What this does, in plain English.** Give it the stem of a file in the vault's
`people/` folder (the "slug") and it prints, as plain text:

1. the person's name and the full path of their people file;
2. any OTHER people file that shares one of their names (first name, full
   name or an alias), so two people called the same thing can be told apart;
3. which of their names were searched for in card text, and which were not
   trusted (a common word, or shared with someone else) and so counted only
   when a card was tagged with the person;
4. every card of the owner's own about them, oldest first, IN FULL, each with
   its id, its time, and whether it was found by tag or by text alone.

It reads only. It writes nothing anywhere. The choice of which cards count is
not made here: it is `matching_cards` in `tools/mention_context.py`, the same
rule the mention hook uses, so the two can never disagree.

    person_cards.py <slug> [--since YYYY-MM-DD] [--json]

`--since` keeps only cards from that day on. `--json` prints the same thing as
one JSON object. An unknown slug prints a message on stderr and exits 2.

Touches: `tools/mention_context.py` (`matching_cards`), `namerisk.py` (who
shares a name, which names are weak), `exo.db` (read-only).

Prompt: "A reader for the agents: prints the person's file path and every card
of hers tagged with the slug in full, plus text-matched cards only for names
namerisk trusts."
"""
import argparse
import importlib.util
import json
import sys
from contextlib import closing
from pathlib import Path

SKELETON = Path(__file__).resolve().parents[1]
if str(SKELETON) not in sys.path:
    sys.path.insert(0, str(SKELETON))

import namerisk  # noqa: E402
import store  # noqa: E402


def _load_mention_context():
    """tools/ is not on the import path, so load the hook's file by its path."""
    spec = importlib.util.spec_from_file_location(
        "mention_context", SKELETON / "tools" / "mention_context.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def build_entry(mention_context, slug):
    """The person's entry, shaped as the hook builds it, or None if no such file."""
    people = namerisk.all_people()
    person = next((p for p in people if p["slug"] == slug), None)
    if person is None:
        return None, people
    with closing(mention_context._read_only_connection()) as conn:
        risk = namerisk.classify(conn, people).get(slug, {})
    return {
        "key": f"person:{slug}", "kind": "person", "slug": slug,
        "name": person["name"], "file": person["file"], "terms": person["terms"],
        "weak": risk.get("weak", []), "shared": risk.get("shared", []),
    }, people


def same_name(entry, people):
    """Other people files that list any of this person's names."""
    mine = {term.lower() for term in entry["terms"]}
    return [{"slug": p["slug"], "name": p["name"],
             "file": str(store.CONTENT_DIR / p["file"])}
            for p in people
            if p["slug"] != entry["slug"] and mine & {t.lower() for t in p["terms"]}]


def gather(slug, since=None):
    """The whole report as a dict, or None for an unknown slug."""
    mention_context = _load_mention_context()
    entry, people = build_entry(mention_context, slug)
    if entry is None:
        return None
    untrusted = {t.lower() for t in entry["weak"] + entry["shared"]}
    cards = []
    with closing(mention_context._read_only_connection()) as conn:
        for row, tagged in mention_context.matching_cards(conn, entry):
            if since and row["ts"][:10] < since:
                continue
            cards.append({"id": row["id"], "ts": row["ts"],
                          "matched": "tag" if tagged else "text", "body": row["body"] or ""})
    cards.reverse()     # the selection runs newest first; the reader wants oldest first
    return {
        "slug": slug, "name": entry["name"],
        "file": str(store.CONTENT_DIR / entry["file"]),
        "same_name": same_name(entry, people),
        "text_terms": [t for t in entry["terms"] if t.lower() not in untrusted],
        "untrusted_terms": [t for t in entry["terms"] if t.lower() in untrusted],
        "cards": cards,
    }


def render(report):
    lines = [f"Name: {report['name']}", f"File: {report['file']}", ""]
    if report["same_name"]:
        lines.append("Other people files sharing a name with this one:")
        lines += [f"  {o['slug']} | {o['name']} | {o['file']}" for o in report["same_name"]]
    else:
        lines.append("No other people file shares a name with this one.")
    lines += ["",
              "Names searched for in card text: " + (", ".join(report["text_terms"]) or "(none)"),
              "Names not trusted (counted by tag only): "
              + (", ".join(report["untrusted_terms"]) or "(none)"),
              "", f"Cards: {len(report['cards'])}, oldest first", ""]
    for card in report["cards"]:
        lines += [f"--- {card['id']} | {card['ts']} | by {card['matched']} ---", card["body"], ""]
    return "\n".join(lines)


def main(argv=None):
    parser = argparse.ArgumentParser(description="Print everything needed for a fact sheet about one person.")
    parser.add_argument("slug", help="the stem of a file in the vault's people/ folder")
    parser.add_argument("--since", metavar="YYYY-MM-DD", help="only cards from that day on")
    parser.add_argument("--json", action="store_true", help="print one JSON object instead of text")
    args = parser.parse_args(argv)
    report = gather(args.slug, args.since)
    if report is None:
        print(f"no people file for slug '{args.slug}'", file=sys.stderr)
        return 2
    print(json.dumps(report, indent=2, ensure_ascii=False) if args.json else render(report))
    return 0


if __name__ == "__main__":
    # Put this run on the runtime map (runtime_sensor.py), same as the other
    # standalone scripts.
    import runtime_sensor
    runtime_sensor.attach()
    sys.exit(main())
