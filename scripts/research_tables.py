#!/usr/bin/env python3
"""The research agents' write door for research tables — how an agent puts a
number about a food into the grid, and a verdict drawn from those numbers.

The law this script enforces, on top of hazardstore's: a number goes in only
with the study it came from (`--source`, a source entry in the pool), and a
quoted passage is only ever one the script itself found in that source's text
— the same rule as research_claims.py's `link`, using its finder. Everything
an agent writes lands author 'llm' and unreviewed; there is no verb for review,
because review is the owner's alone. A verdict must say why, and — unless it
is 'open' — name the measurements it rests on.

Verbs (each prints to stdout; exit code 1 with the reason on stderr):

    hazards
        The hazard map as an indented tree: id, name, other names. A hazard
        with two parents appears under both.
    hazard-add --name "Chlorpropham" --parent "Plant growth regulator" [--parent ...] [--alias ...]
        Put a hazard on the map under existing parents; prints its id. The
        owner arranges the map — add what a finding needs, don't reorganize.
    foods [--set all|recipes|rotation]
        The foods, as "id  name" — the names a measurement may use.
    measure --food <name|id> --hazard <name|id> --measure concentration|detection_rate \\
            --amount <n> --unit <u> --source <source entry id> [--passage "exact quote"] \\
            [--claim <claim id>] [--sample-size <n>] [--basis "..."] [--year YYYY] \\
            [--measured-on "what was really tested"] [--tier "..."] [--note "..."]
        Records one number; prints "created|amended|unchanged <id>". A
        concentration is converted to ppb (the printed figure is kept); a
        detection rate is a percent. The same food, hazard, measure, source,
        year and stand-in again amends that number rather than adding a second.
    judge --food <name|id> --lens health|sustainability \\
          --verdict organic|some|conventional|open --reasoning "..." \\
          [--ground <measure id> ...] [--hazard <name|id>] [--tier "..."]
        Sets the verdict on a food through a lens (about one hazard only,
        with --hazard); prints "created|amended|unchanged <id>".
    tables
        The owner's tables: id, kind, name, and what each shows.
    show-table <id> [--gaps]
        A table's grid as JSON, every food included; with --gaps, only the
        food × column cells that are still empty — the list of what to find.
    show <measure id> | show-judgment <judgment id>
        One number or one verdict in full, as JSON.
    import-claims [--topic <topic id>]
        Turns the numbers claims already carry (the claims door's `value`)
        into measurements, reporting what was skipped and why.

Run from the app checkout with the data dir named:
    cd <SKELETON_DIR> && EXOCORTEX_DATA_DIR=<VAULT_DIR>/data venv/bin/python3 scripts/research_tables.py <verb> ...

Touches: hazardstore.py (every read and write), docstore.py and
researchstore.py (a passage is found in the source's text and saved as an
annotation), scripts/research_claims.py (its passage finder).

Prompt that produced this file: "I want the agents to fill the table but I
want it to mark it as reviewed by me or not."
"""
import argparse
import json
import os
import sys

# Make the skeleton root and this folder importable from anywhere.
HERE = os.path.dirname(os.path.abspath(__file__))
SKELETON = os.path.dirname(HERE)
for path in (SKELETON, HERE):
    if path not in sys.path:
        sys.path.insert(0, path)

import docstore  # noqa: E402
import hazardstore  # noqa: E402
import researchstore  # noqa: E402
import sqlstore  # noqa: E402
from research_claims import find_passage  # noqa: E402


def _passage_annotation(source_id, passage, note):
    """Find the quote in the source's text and save it as a highlight needing
    review; returns its id. Raises ValueError, writing nothing, when the text
    can't be read or doesn't contain the quote — offsets are never invented."""
    doc = f"entry:{source_id}"
    resolved = docstore.resolve(doc)
    if not resolved.get("ok"):
        raise ValueError(f"no text to search for source {source_id!r}")
    text = resolved.get("text", "")
    found = find_passage(text, passage)
    if found is None:
        raise ValueError(f"passage not found in source {source_id!r}; nothing was recorded. "
                         "Quote the text exactly as it reads.")
    start, end = found
    return researchstore.add_annotation(doc, start, end, text[start:end], note=note or "",
                                        source="llm", needs_review=True)


# --- the verbs ---------------------------------------------------------------------

def _cmd_hazards(args):
    hazards = {h["id"]: h for h in hazardstore.hazard_map()}
    children = {}
    for hazard in hazards.values():
        for parent in hazard["parents"]:
            children.setdefault(parent, []).append(hazard["id"])

    # Print the map as a tree, walking down from the top-level hazards.
    def walk(hazard_id, depth):
        hazard = hazards[hazard_id]
        names = f"  (also: {', '.join(hazard['names'])})" if hazard["names"] else ""
        print(f"{'  ' * depth}{hazard_id:>4}  {hazard['name']}{names}")
        for child in sorted(children.get(hazard_id, ()), key=lambda i: hazards[i]["name"].lower()):
            walk(child, depth + 1)

    for top in sorted((h for h in hazards.values() if not h["parents"]), key=lambda h: h["name"].lower()):
        walk(top["id"], 0)


def _cmd_hazard_add(args):
    print(hazardstore.add_hazard(args.name, parents=args.parent, aliases=args.alias or ()))


def _cmd_foods(args):
    conn = sqlstore.open_db()
    try:
        for food_id, name in hazardstore._food_rows(conn, args.set):
            print(f"{food_id:>4}  {name}")
    finally:
        conn.close()


def _cmd_measure(args):
    # Every check that can refuse runs before the passage is saved, so a
    # refused number leaves no orphan highlight behind.
    hazardstore.normalize(args.measure, args.amount, args.unit)
    conn = sqlstore.open_db()
    try:
        hazardstore._food_id(conn, args.food)
        hazardstore._hazard_id(conn, args.hazard)
        hazardstore._check_references(conn, args.source, None, args.claim)
    finally:
        conn.close()
    annotation_id = None
    if args.passage:
        annotation_id = _passage_annotation(args.source, args.passage, args.note)
    measure_id, outcome = hazardstore.record_measure(
        args.food, args.hazard, args.measure, args.amount, args.unit,
        source_id=args.source, annotation_id=annotation_id, claim_id=args.claim,
        sample_size=args.sample_size, basis=args.basis, year=args.year,
        measured_on=args.measured_on, tier=args.tier, note=args.note, author="llm")
    print(f"{outcome} {measure_id}")


def _cmd_judge(args):
    judgment_id, outcome = hazardstore.judge(
        args.food, args.lens, args.verdict, hazard=args.hazard, reasoning=args.reasoning,
        tier=args.tier, grounds=args.ground, author="llm")
    print(f"{outcome} {judgment_id}")


def _cmd_tables(args):
    for table in hazardstore.list_tables():
        if table["kind"] == "measures":
            shows = table["measure"] or "every kind of number"
        else:
            shows = "verdicts"
        print(f"{table['id']:>4}  [{table['kind']}] {table['name']} — {shows}, foods: {table['foods']}")


def _cmd_show_table(args):
    view = hazardstore.table_view(args.table_id, all_foods=True)
    if view is None:
        raise ValueError(f"no table {args.table_id}")
    if not args.gaps:
        print(json.dumps(view, indent=2, ensure_ascii=False))
        return
    for row in view["rows"]:
        empty = [column["name"] for column in view["columns"] if not row["cells"].get(column["id"])]
        if empty:
            print(f"{row['food']}: {', '.join(empty)}")


def _cmd_show(args):
    detail = hazardstore.measure_detail(args.measure_id)
    if detail is None:
        raise ValueError(f"no measurement {args.measure_id}")
    print(json.dumps(detail, indent=2, ensure_ascii=False))


def _cmd_show_judgment(args):
    detail = hazardstore.judgment_detail(args.judgment_id)
    if detail is None:
        raise ValueError(f"no verdict {args.judgment_id}")
    print(json.dumps(detail, indent=2, ensure_ascii=False))


def _cmd_import_claims(args):
    print(json.dumps(hazardstore.import_claim_values(args.topic), indent=2, ensure_ascii=False))


def build_parser():
    parser = argparse.ArgumentParser(
        prog="research_tables.py",
        description="The research agents' write door for research tables.")
    verbs = parser.add_subparsers(dest="verb", required=True)

    verbs.add_parser("hazards", help="Print the hazard map.").set_defaults(func=_cmd_hazards)

    p = verbs.add_parser("hazard-add", help="Put a hazard on the map; prints its id.")
    p.add_argument("--name", required=True)
    p.add_argument("--parent", action="append", required=True, help="an existing hazard; repeatable")
    p.add_argument("--alias", action="append", help="another name it goes by; repeatable")
    p.set_defaults(func=_cmd_hazard_add)

    p = verbs.add_parser("foods", help="List the foods a measurement may name.")
    p.add_argument("--set", default="all", choices=hazardstore.FOOD_SETS)
    p.set_defaults(func=_cmd_foods)

    p = verbs.add_parser("measure", help="Record one number about a food.")
    p.add_argument("--food", required=True)
    p.add_argument("--hazard", required=True)
    p.add_argument("--measure", required=True, choices=list(hazardstore.MEASURES))
    p.add_argument("--amount", required=True, type=float)
    p.add_argument("--unit", required=True)
    p.add_argument("--source", required=True, help="the source entry id the number came from")
    p.add_argument("--passage", default=None, help="exact quote from the source's text")
    p.add_argument("--claim", default=None, help="the claim entry this number belongs to")
    p.add_argument("--sample-size", dest="sample_size", type=int, default=None)
    p.add_argument("--basis", default=None)
    p.add_argument("--year", type=int, default=None)
    p.add_argument("--measured-on", dest="measured_on", default=None,
                   help="what the study really tested, when it was a stand-in for this food")
    p.add_argument("--tier", default=None)
    p.add_argument("--note", default=None)
    p.set_defaults(func=_cmd_measure)

    p = verbs.add_parser("judge", help="Set the verdict on a food through a lens.")
    p.add_argument("--food", required=True)
    p.add_argument("--lens", required=True, choices=hazardstore.LENSES)
    p.add_argument("--verdict", required=True, choices=list(hazardstore.VERDICTS))
    p.add_argument("--reasoning", required=True)
    p.add_argument("--ground", action="append", type=int, help="a measurement id it rests on; repeatable")
    p.add_argument("--hazard", default=None, help="make the verdict about this hazard only")
    p.add_argument("--tier", default=None)
    p.set_defaults(func=_cmd_judge)

    verbs.add_parser("tables", help="List the owner's tables.").set_defaults(func=_cmd_tables)

    p = verbs.add_parser("show-table", help="Print a table's grid, or its empty cells.")
    p.add_argument("table_id", type=int)
    p.add_argument("--gaps", action="store_true")
    p.set_defaults(func=_cmd_show_table)

    p = verbs.add_parser("show", help="Print one measurement in full.")
    p.add_argument("measure_id", type=int)
    p.set_defaults(func=_cmd_show)

    p = verbs.add_parser("show-judgment", help="Print one verdict in full.")
    p.add_argument("judgment_id", type=int)
    p.set_defaults(func=_cmd_show_judgment)

    p = verbs.add_parser("import-claims", help="Turn claims' numbers into measurements.")
    p.add_argument("--topic", default=None)
    p.set_defaults(func=_cmd_import_claims)
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
