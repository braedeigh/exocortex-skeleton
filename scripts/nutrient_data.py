#!/usr/bin/env python3
"""Load and look up USDA FoodData Central from the commons.

Plain English: the FDC zips sit in `<commons>/usda-fdc/` (fetched by
scripts/commons_fetch.py). This reads them into commons.db (fdcdb.py) and lets
you search foods and see what's in one, from the command line.

    venv/bin/python3 scripts/nutrient_data.py load            # every FDC zip in the commons
    venv/bin/python3 scripts/nutrient_data.py search kale raw
    venv/bin/python3 scripts/nutrient_data.py packaged oatly     # packaged products (Branded Foods)
    venv/bin/python3 scripts/nutrient_data.py packaged 016000275287   # ... or one barcode
    venv/bin/python3 scripts/nutrient_data.py show 168421
    venv/bin/python3 scripts/nutrient_data.py matrix --sex both   # her day as A, lower, upper

`matrix` prints the linear program's pieces for her usual day's foods (see
nutrition.matrix): one row per nutrient, one column per food, per gram, with
the bounds at the right. "?" is a figure USDA doesn't have.

Loading is safe to re-run: each dataset replaces its own earlier rows. The
Branded Foods zip (packaged products, 3 GB unzipped) takes several minutes.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import commons  # noqa: E402  (sys.path above)
import fdcdb  # noqa: E402
import nutrition  # noqa: E402


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("load", help="read every FDC zip in the commons into commons.db")
    find = sub.add_parser("search", help="foods whose name holds every word")
    find.add_argument("words", nargs="+")
    packaged = sub.add_parser("packaged", help="packaged products by name / brand, or one barcode")
    packaged.add_argument("words", nargs="+")
    show = sub.add_parser("show", help="one food's nutrients per 100 g and its portions")
    show.add_argument("fdc_id", type=int)
    grid = sub.add_parser("matrix", help="her usual day's foods as A, lower, upper (per gram)")
    grid.add_argument("--sex", choices=("female", "male", "both"), default="both")
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
                tag = {"foundation_food": "F", "sr_legacy_food": "SR"}.get(row["data_type"], "FN")
                print(f"{row['fdc_id']:>7}  {tag:<2}  {row['description']}")
            return 0

        # Packaged: one line per product, barcode first; digits alone are a barcode.
        if args.command == "packaged":
            text = " ".join(args.words)
            found = (fdcdb.lookup_barcode(conn, text) if text.replace(" ", "").isdigit()
                     else fdcdb.search_packaged(conn, text))
            for row in found:
                brand = row["brand_name"] or row["brand_owner"] or ""
                print(f"{row['fdc_id']:>7}  {row['gtin_upc']:<14}  {row['description']}  ({brand})")
            return 0

        # Matrix: nutrients down, her foods across, per gram, then the bounds.
        if args.command == "matrix":
            items = nutrition.day_items()
            # The same food eaten at two meals is one column: one variable per food.
            unique = list({item["fdc_id"]: item for item in items}.values())
            built = nutrition.matrix(conn, unique, sex=args.sex)
            for index, label in enumerate(built["foods"]):
                print(f"  f{index + 1:<3} {label}")
            header = "".join(f"{'f' + str(i + 1):>9}" for i in range(len(built["foods"])))
            print(f"{'per gram':<18}{header}{'lower':>10}{'upper':>10}")
            for row, key, unit, low, high in zip(built["A"], built["nutrients"], built["units"],
                                                 built["lower"], built["upper"]):
                cells = "".join(f"{v:>9.3g}" if v is not None else f"{'?':>9}" for v in row)
                bound = lambda v: f"{v:>10.4g}" if v is not None else f"{'—':>10}"
                print(f"{key[:12]:<12} {unit or '':<5}{cells}{bound(low)}{bound(high)}")
            return 0

        # Show: every nutrient with its spread, then the portions.
        item = fdcdb.food(conn, args.fdc_id)
        if not item:
            print(f"no FDC food {args.fdc_id}")
            return 1
        print(f"{item['description']}  ({item['data_type']}, {item['category']})  per 100 g")
        if item["label"]:
            label = item["label"]
            print(f"  package label: {label['brand_name'] or label['brand_owner']}, barcode {label['gtin_upc']}"
                  " — the maker's figures, not a USDA lab's")
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
    # Put this run on the runtime map (runtime_sensor.py), same as the other
    # standalone scripts.
    import runtime_sensor
    runtime_sensor.attach()
    sys.exit(main())
