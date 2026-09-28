#!/usr/bin/env python3
"""Load and look up USDA FoodData Central from the commons.

Plain English: the FDC zips sit in `<commons>/usda-fdc/` (fetched by
scripts/commons_fetch.py). This reads them into commons.db (fdcdb.py) and lets
you search foods and see what's in one, from the command line.

    venv/bin/python3 scripts/nutrient_data.py load            # every FDC zip in the commons
    venv/bin/python3 scripts/nutrient_data.py search kale raw
    venv/bin/python3 scripts/nutrient_data.py show 168421

Loading is safe to re-run: each dataset replaces its own earlier rows.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import commons  # noqa: E402  (sys.path above)
import fdcdb  # noqa: E402


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("load", help="read every FDC zip in the commons into commons.db")
    find = sub.add_parser("search", help="foods whose name holds every word")
    find.add_argument("words", nargs="+")
    show = sub.add_parser("show", help="one food's nutrients per 100 g and its portions")
    show.add_argument("fdc_id", type=int)
    args = parser.parse_args(argv)

    # Load: one zip at a time, one transaction each.
    if args.command == "load":
        zips = sorted((commons.commons_dir() / "usda-fdc").glob("*.zip"))
        if not zips:
            print("no FDC zips in the commons — fetch them with scripts/commons_fetch.py")
            return 1
        for path in zips:
            with fdcdb.session() as conn:
                counts = fdcdb.load_fdc(conn, path)
            print(f"{path.name}: {counts['dataset']} — {counts['foods']} foods, "
                  f"{counts['amounts']} amounts, {counts['portions']} portions")
        return 0

    with fdcdb.session() as conn:
        # Search: one line per match.
        if args.command == "search":
            for row in fdcdb.search(conn, " ".join(args.words)):
                tag = "F" if row["data_type"] == "foundation_food" else "SR"
                print(f"{row['fdc_id']:>7}  {tag:<2}  {row['description']}")
            return 0

        # Show: every nutrient with its spread, then the portions.
        item = fdcdb.food(conn, args.fdc_id)
        if not item:
            print(f"no FDC food {args.fdc_id}")
            return 1
        print(f"{item['description']}  ({item['data_type']}, {item['category']})  per 100 g")
        for nutrient in item["nutrients"].values():
            spread = ""
            if nutrient["min"] is not None and nutrient["max"] is not None:
                spread = f"   range {nutrient['min']:g}–{nutrient['max']:g}, n={nutrient['data_points']}"
            print(f"  {nutrient['name'][:44]:<44} {nutrient['amount']:>10g} {nutrient['unit']:<5}{spread}")
        for portion in item["portions"]:
            words = " ".join(str(p) for p in (portion["amount"], portion["unit"], portion["description"]) if p)
            print(f"  portion: {words} = {portion['grams']:g} g")
    return 0


if __name__ == "__main__":
    sys.exit(main())
