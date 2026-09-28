"""Household measures — how many grams one cup, tablespoon, egg or clove of a food weighs.

What this file does: it reads USDA's own portion weights for a food (the
fdc_portions table fdcdb.py loads from FoodData Central's food_portion.csv,
e.g. "1 cup, chopped = 136 g") and turns them into one gram weight per unit, so
the Nutrients page (frontend/src/features/nutrition/) can take "1.5 cup" or
"2 tbsp" for a meal amount and show "≈ ¾ cup" beside the grams in What to add.
The frontend does the typing-and-matching (measureMath.ts); this file only says
what each unit weighs and where that number came from.

Two kinds of measure come back:
  - usda     — straight from USDA's portion row, divided down to one unit
               ("0.5 cup = 107 g" becomes 1 cup = 214 g).
  - derived  — a cup, tablespoon, teaspoon or fluid ounce USDA didn't list for
               this food, worked out from one it did, by NIST's kitchen
               volumes (1 cup = 240 mL, 1 tbsp = 15 mL, 1 tsp = 5 mL,
               1 fl oz = 30 mL). Every food also gets ounces by weight
               (1 oz = 28.35 g, NIST). Each carries its source link.
A food with no USDA portion at all gets ounces only; the page says so.

Routes: GET /api/nutrition/measures?ids= (routes/nutrition.py). Design:
docs/nutrition.md.

Prompt that produced this file: "be able to estimate amounts by cups and
tablespoons and convert them to grams" — built as both: type meal amounts in
cups/tbsp, and see cups/tbsp beside the grams in What to add.
"""
import re

FDC_FOOD_URL = "https://fdc.nal.usda.gov/food-details/{}/nutrients"
NIST_KITCHEN_URL = "https://www.nist.gov/pml/owm/metric-kitchen-cooking-measurement-equivalencies"
NIST_MASS_URL = "https://www.nist.gov/pml/owm/approximate-conversions-us-customary-measures-metric"

# NIST's kitchen volumes, in millilitres — only their ratios are used here.
VOLUME_ML = {"cup": 240.0, "tbsp": 15.0, "tsp": 5.0, "floz": 30.0}
OUNCE_GRAMS = 28.35

# Unit words as USDA writes them, folded to one key each.
_UNIT_WORDS = {
    "cup": "cup", "cups": "cup", "c": "cup",
    "tbsp": "tbsp", "tablespoon": "tbsp", "tablespoons": "tbsp", "tbs": "tbsp",
    "tsp": "tsp", "teaspoon": "tsp", "teaspoons": "tsp",
    "fl oz": "floz", "fluid ounce": "floz", "fluid ounces": "floz",
    "oz": "oz", "ounce": "oz", "ounces": "oz",
}


def _name(key):
    """A unit key as it's written: 'floz' -> 'fl oz'."""
    return "fl oz" if key == "floz" else key


def unit_key(words):
    """The unit a portion is measured in, from its words: 'cup, chopped' -> 'cup', '3 cloves' -> 'clove'.

    Volume and weight words fold to cup/tbsp/tsp/floz/oz; anything else is a
    count word ('large', 'clove', 'slice'), singular and lower-case.
    """
    text = (words or "").strip().lower()
    if text.startswith("fl oz") or text.startswith("fluid ounce"):
        return "floz"
    first = re.split(r"[\s,(]+", text, maxsplit=1)[0] if text else ""
    if first in _UNIT_WORDS:
        return _UNIT_WORDS[first]
    if not first or not first[0].isalpha():
        return None
    return first[:-1] if first.endswith("s") and len(first) > 3 else first


def from_portions(fdc_id, portions):
    """Grams in one of each unit, from USDA's portion rows [{amount, unit, description, grams}].

    Returns [{unit, label, grams, kind: usda|derived, source, url}] with USDA's
    own rows first, in USDA's order; the first row for a unit is the one used
    when she types that unit, so its label says which cup it is.
    """
    measures, seen = [], set()
    # Divide each USDA portion down to one unit: "0.5 cup = 107 g" is 214 g a cup.
    for portion in portions:
        words = " ".join(w for w in (portion.get("unit"), portion.get("description")) if w)
        key = unit_key(words)
        amount = float(portion.get("amount") or 1) or 1.0
        grams = portion.get("grams")
        if not key or not grams or key == "oz":
            continue
        # The same unit at the same weight again ("0.25 cup = 30 g" after "1 cup = 120 g") adds nothing.
        if any(m["unit"] == key and abs(m["grams"] - float(grams) / amount) < 0.01 for m in measures):
            continue
        rest = re.sub(r"^\s*(fl oz|fluid ounces?|\S+)\s*,?\s*", "", words.lower(), count=1) if key in VOLUME_ML else ""
        label = f"1 {_name(key)}{', ' + rest if rest else ''}" if key in VOLUME_ML \
            else f"1 {words.lower()}" if amount == 1 else f"1 {key}"
        measures.append({"unit": key, "label": label, "grams": round(float(grams) / amount, 2), "kind": "usda",
                         "source": f"USDA FoodData Central: {amount:g} {words} = {grams:g} g",
                         "url": FDC_FOOD_URL.format(fdc_id)})
        seen.add(key)
    # Fill the volume units USDA left out, each from USDA's nearest-sized volume, by NIST's volumes.
    given = [m for m in measures if m["unit"] in VOLUME_ML]
    for key, ml in VOLUME_ML.items():
        if given and key not in seen:
            base = min(given, key=lambda m: abs(VOLUME_ML[m["unit"]] - ml))
            per_ml = base["grams"] / VOLUME_ML[base["unit"]]
            measures.append({"unit": key, "label": f"1 {_name(key)}", "grams": round(per_ml * ml, 2), "kind": "derived",
                             "source": f"from USDA's {base['label']} = {base['grams']:g} g, with NIST's "
                                       f"1 {_name(key)} = {ml:g} mL and 1 {_name(base['unit'])}"
                                       f" = {VOLUME_ML[base['unit']]:g} mL",
                             "url": NIST_KITCHEN_URL})
    # Ounces by weight, for every food.
    measures.append({"unit": "oz", "label": "1 oz (by weight)", "grams": OUNCE_GRAMS, "kind": "derived",
                     "source": "NIST: 1 ounce = 28.35 grams", "url": NIST_MASS_URL})
    return measures


def for_foods(conn, fdc_ids):
    """{fdc_id: measures} for each id, read from fdcdb's fdc_portions table."""
    result = {}
    for fdc_id in fdc_ids:
        rows = conn.execute("SELECT amount, unit, description, grams FROM fdc_portions"
                            " WHERE fdc_id = ? ORDER BY seq", (fdc_id,)).fetchall()
        result[fdc_id] = from_portions(fdc_id, [{"amount": r[0], "unit": r[1], "description": r[2], "grams": r[3]}
                                                for r in rows])
    return result
