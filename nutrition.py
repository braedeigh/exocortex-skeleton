"""What a day of her food adds up to, nutrient by nutrient, against the daily targets.

**What this does.** Takes meals written as foods with gram weights (each food
pointing at its USDA FoodData Central entry — see fdcdb.py), adds up every
tracked nutrient, and lays the day beside the Dietary Reference Intakes
(dri.py): under the target, met, or over the upper limit.

It is built to show how sure each number is, not just the number:

  - **Unknown is not zero.** When USDA has no figure for a nutrient in one of
    the foods, the total says which foods are missing it, instead of quietly
    counting them as 0.
  - **Gaps filled from a second USDA entry, and labelled.** An item may name
    `fill_from`: another FDC food (usually FNDDS, where every nutrient is
    filled in) used only for the nutrients its own entry lacks. The total
    lists those foods under `filled`, so an estimate never passes as a
    measurement.
  - **A range where USDA gives one.** Foundation foods come with the min and
    max of the samples USDA measured; the day's low / high are those added up.
    SR Legacy foods have one number and add the same to both ends.
  - **RDA vs AI.** An AI target is a softer number than an RDA, and says so.
  - **A UL that doesn't count food says so** (magnesium's counts only
    supplements), so food can't "go over" it.
  - **Sex-specific targets show both** when the setting is "both" — both
    columns side by side, for a body the tables don't describe with one row.

Where things live:
  `nutrition_meals` (data dir, JSON via store.py) — her meals as items
      {label, fdc_id, grams, grams_guessed?, fill_from?} and her usual day as
      [{meal, servings}]. `grams_guessed` marks a weight nobody has weighed.
  `nutrition_settings` (data dir, JSON) — {sex: female|male|both, age}.
  `nutrition_highlights` (data dir, JSON) — {foods: [{fdc_id, description,
      added}]}, the USDA foods she's starred as ones she's interested in eating.

Every source the page cites comes with a link (`sources()`), and every food
links to its FoodData Central page by FDC id (built in the frontend).

Touches: `fdcdb.py` and `dri.py` (both in commons.db), `commons.py` (the
manifest the DRI table's address is read from), `store.py`,
`routes/nutrition.py` (the HTTP seam), `tests/test_nutrition.py`.
Design: docs/nutrition.md.

Prompt that produced this file: "make my own kind of like, Cronometer so I can
plug in my diet and see how to optimize it for my health overall" — steps 2
and 3 of the plan: gram weights on her meals, then her day against the DRIs.
"""
import store

import commons
import dri
import fdcdb

MEALS = "nutrition_meals"
SETTINGS = "nutrition_settings"
HIGHLIGHTS = "nutrition_highlights"

# FoodData Central's own site, where every food has a page under its FDC id.
FDC_URL = "https://fdc.nal.usda.gov/"

# The nutrients tracked: (key, label, FDC nutrient ids in order of preference).
# The key matches dri.py's names, so a target lines up with its total.
# Energy has three FDC ids because Foundation foods report Atwater energy
# instead of the classic figure; folate prefers DFE, the unit the RDA is in.
TRACKED = (
    ("energy", "Energy", (1008, 2048, 2047)),
    ("protein", "Protein", (1003,)),
    ("fat", "Fat", (1004,)),
    ("carbohydrate", "Carbohydrate", (1005,)),
    ("fiber", "Fiber", (1079, 2033)),
    ("calcium", "Calcium", (1087,)),
    ("iron", "Iron", (1089,)),
    ("magnesium", "Magnesium", (1090,)),
    ("phosphorus", "Phosphorus", (1091,)),
    ("potassium", "Potassium", (1092,)),
    ("sodium", "Sodium", (1093,)),
    ("zinc", "Zinc", (1095,)),
    ("copper", "Copper", (1098,)),
    ("manganese", "Manganese", (1101,)),
    ("selenium", "Selenium", (1103,)),
    ("iodine", "Iodine", (1100,)),
    ("vitamin_a", "Vitamin A (RAE)", (1106,)),
    ("vitamin_c", "Vitamin C", (1162,)),
    ("vitamin_d", "Vitamin D", (1114,)),
    ("vitamin_e", "Vitamin E", (1109,)),
    ("vitamin_k", "Vitamin K", (1185,)),
    ("thiamin", "Thiamin (B1)", (1165,)),
    ("riboflavin", "Riboflavin (B2)", (1166,)),
    ("niacin", "Niacin (B3)", (1167,)),
    ("pantothenic_acid", "Pantothenic acid (B5)", (1170,)),
    ("vitamin_b6", "Vitamin B6", (1175,)),
    ("folate", "Folate (DFE)", (1190, 1177)),
    ("vitamin_b12", "Vitamin B12", (1178,)),
    ("choline", "Choline", (1180,)),
)

# Grams of one unit, to turn FDC's units and the DRI tables' units into each other.
_GRAMS = {"g": 1.0, "mg": 1e-3, "µg": 1e-6, "ug": 1e-6, "kcal": None}


def _unit(fdc_unit):
    """FDC's unit spelling (G, MG, UG, KCAL) as the one used here."""
    return {"G": "g", "MG": "mg", "UG": "µg", "KCAL": "kcal"}.get(fdc_unit, fdc_unit.lower())


def convert(value, from_unit, to_unit):
    """A mass from one unit to another (g / mg / µg); kcal only to kcal."""
    if from_unit == to_unit:
        return value
    if _GRAMS.get(from_unit) is None or _GRAMS.get(to_unit) is None:
        raise ValueError(f"can't convert {from_unit} to {to_unit}")
    return value * _GRAMS[from_unit] / _GRAMS[to_unit]


def settings():
    """Her settings, with the defaults filled in: sex 'both', no age until she gives one."""
    data = store.read(SETTINGS, {}) or {}
    sex = data.get("sex") if data.get("sex") in ("female", "male", "both") else "both"
    return {"sex": sex, "age": data.get("age")}


def totals(conn, items):
    """Add up the tracked nutrients over [{fdc_id, grams, label?, fill_from?}].

    Returns {key: {label, unit, amount, low, high, missing: [labels],
    filled: [labels]}} — amount is the sum of USDA's figures, low / high the
    sum of the sample min / max where given (the figure itself where not),
    `missing` the foods USDA has no figure for, so the total is a floor, not
    the whole, and `filled` the foods whose figure came from their fill_from
    entry instead of their own.
    """
    foods = {}
    for item in items:
        for fdc_id in (item.get("fdc_id"), item.get("fill_from")):
            if fdc_id and fdc_id not in foods:
                foods[fdc_id] = fdcdb.food(conn, fdc_id)

    out = {}
    for key, label, ids in TRACKED:
        entry = {"label": label, "unit": None, "amount": 0.0, "low": 0.0, "high": 0.0,
                 "missing": [], "filled": []}
        for item in items:
            name = item.get("label") or str(item.get("fdc_id"))

            # Take the first FDC nutrient id this food has a figure for,
            # then the same from its fill_from entry, then call it missing.
            found = _first(foods.get(item.get("fdc_id")), ids)
            if found is None:
                found = _first(foods.get(item.get("fill_from")), ids)
                if found is not None:
                    entry["filled"].append(name)
            if found is None:
                entry["missing"].append(name)
                continue
            unit = _unit(found["unit"])
            entry["unit"] = entry["unit"] or unit
            scale = float(item.get("grams") or 0) / 100.0

            # Add this food's share, in the unit the first food set.
            def add(value):
                return convert(value, unit, entry["unit"]) * scale
            entry["amount"] += add(found["amount"])
            entry["low"] += add(found["min"] if found["min"] is not None else found["amount"])
            entry["high"] += add(found["max"] if found["max"] is not None else found["amount"])
        out[key] = entry
    return out


def _first(food, ids):
    """The food's figure for the first of these FDC nutrient ids it has, or None."""
    if not food:
        return None
    return next((food["nutrients"][i] for i in ids if i in food["nutrients"]), None)


def _judge(amount, unit, target):
    """One total against one sex's targets: which target, how far, and a status word.

    Status: 'under' (below the RDA/AI), 'met', 'over' (past a UL that counts
    food), or 'no_target'. A sodium CDRR is treated like a ceiling.
    """
    if not target:
        return {"status": "no_target"}
    result = {}
    floor = target.get("rda") or target.get("ai")
    if floor:
        value = convert(floor["value"], floor["unit"], unit)
        result["target"] = {"value": value, "kind": "rda" if "rda" in target else "ai",
                            "source": floor["source"]}
        result["percent"] = round(100 * amount / value) if value else None
    ceiling = target.get("ul") or target.get("cdrr")
    if ceiling:
        value = convert(ceiling["value"], ceiling["unit"], unit)
        kind = "ul" if "ul" in target else "cdrr"
        result["limit"] = {"value": value, "kind": kind, "source": ceiling["source"],
                           "applies_to": dri.UL_SCOPE.get(target.get("_nutrient"))}
    counts_food = ceiling and not result["limit"]["applies_to"]
    if counts_food and amount > result["limit"]["value"]:
        result["status"] = "over"
    elif floor and amount < result["target"]["value"]:
        result["status"] = "under"
    else:
        result["status"] = "met" if floor or ceiling else "no_target"
    return result


def report(conn, items, sex=None, age=None):
    """The day's totals, each beside its targets for the sex(es) asked for.

    `sex` is 'female', 'male' or 'both' (defaults from settings()). Without an
    age there are no targets yet — the totals still come back.
    """
    config = settings()
    sex = sex or config["sex"]
    age = age if age is not None else config["age"]
    sexes = ("female", "male") if sex == "both" else (sex,)
    targets = {s: dri.targets(conn, s, int(age)) for s in sexes} if age else {}

    rows = []
    for key, entry in totals(conn, items).items():
        row = dict(entry, key=key, amount=round(entry["amount"], 3),
                   low=round(entry["low"], 3), high=round(entry["high"], 3), by_sex={})
        for s, table in targets.items():
            target = table.get(key)
            if target:
                target = dict(target, _nutrient=key)
            row["by_sex"][s] = _judge(entry["amount"], entry["unit"], target) if entry["unit"] else {"status": "no_data"}
        rows.append(row)
    return {"sex": sex, "age": age, "sexes": list(sexes), "nutrients": rows,
            "sources": sources()}


def sources():
    """Where the page's numbers come from, each with a link to the original.

    The DRI table's URL is read from the commons manifest (the address it was
    fetched from), so it can't drift from the file actually used; the 2019
    report and FoodData Central are cited by their own stable addresses.
    """
    fetched = {entry["path"]: entry.get("url") for entry in commons.read_manifest()["files"]}
    return {"composition": "USDA FoodData Central (Foundation 2026-04, SR Legacy 2018-04, FNDDS 2021–2023)",
            "composition_url": FDC_URL,
            "targets": dri.TABLE_FILE, "targets_url": fetched.get(dri.TABLE_FILE),
            "update_2019": dri.UPDATES_2019["citation"], "update_2019_url": dri.UPDATES_2019["url"]}


def matrix(conn, items, sex="female", age=None):
    """Her foods and targets as the pieces of a linear program: A, lower, upper.

    This is the data half of step 4 (the diet optimizer); the solving half is
    left to be written together with the owner, as linear-algebra practice —
    see docs/nutrition.md "Step 4, together".

    A[n][f] is how much of nutrient n one gram of food f carries, in the unit
    the day's total uses; None where USDA has no figure even after fill_from
    (unknown is not zero — the solver has to be told what to do there).
    With x the grams of each food, A·x is the day's nutrients, and the
    program asks for lower ≤ A·x ≤ upper. `lower` is the RDA/AI and `upper`
    the UL where it counts food (None where there's no bound). For sex
    'both' each bound is the stricter of the two: the higher floor, the
    lower ceiling.
    """
    config = settings()
    age = age if age is not None else config["age"]
    sexes = ("female", "male") if sex == "both" else (sex,)

    # One column per food: its nutrients in one gram.
    foods = [dict(item, grams=1.0) for item in items]
    columns = [totals(conn, [food]) for food in foods]
    keys = [key for key, _, _ in TRACKED]
    units = {key: next((c[key]["unit"] for c in columns if c[key]["unit"]), None) for key in keys}
    A = [[(convert(c[key]["amount"], c[key]["unit"], units[key]) if not c[key]["missing"] else None)
          for c in columns] for key in keys]

    # The bounds, in each row's unit, stricter of the sexes asked for.
    tables = {s: dri.targets(conn, s, int(age)) for s in sexes} if age else {}
    lower, upper = [], []
    for key in keys:
        floors, ceilings = [], []
        for s, table in tables.items():
            target = table.get(key)
            judged = _judge(0.0, units[key], dict(target, _nutrient=key)) if target and units[key] else {}
            if judged.get("target"):
                floors.append(judged["target"]["value"])
            if judged.get("limit") and not judged["limit"]["applies_to"]:
                ceilings.append(judged["limit"]["value"])
        lower.append(max(floors) if floors else None)
        upper.append(min(ceilings) if ceilings else None)

    return {"foods": [item.get("label") or str(item.get("fdc_id")) for item in items],
            "nutrients": keys, "units": [units[k] for k in keys],
            "A": A, "lower": lower, "upper": upper}


# Foods under this many kcal per 100 g are left out of a per-100-kcal ranking:
# dividing by next to nothing (water, plain tea, salt) puts them on top by accident.
MIN_KCAL_PER_100G = 5.0


def ranking(conn, key, per="100g", words="", limit=50, keep=None):
    """Every USDA food ranked by one tracked nutrient, richest first.

    `per` is "100g" (the amount in 100 g of the food, as USDA gives it) or
    "100kcal" (that amount divided by the food's energy — nutrient density,
    the nutrient you get for the calories). `words` narrows to foods whose
    name holds every word. A food with no figure for the nutrient isn't
    ranked at all, rather than counted as 0; a per-100-kcal ranking also
    leaves out foods with no energy figure or under MIN_KCAL_PER_100G.
    `keep`, when given, is asked of each food dict before the limit is
    applied (the low-histamine filter uses it), so a filter never shortens
    the page it's shown on.

    Returns {key, label, unit, per, foods: [{fdc_id, description, data_type,
    category, amount, per_100g, kcal_per_100g}]}; `amount` is the ranked
    number (per 100 g or per 100 kcal).
    """
    tracked = {k: (label, ids) for k, label, ids in TRACKED}
    if key not in tracked:
        raise ValueError(f"unknown nutrient {key}")
    if per not in ("100g", "100kcal"):
        raise ValueError("per must be 100g or 100kcal")
    if per == "100kcal" and key == "energy":
        raise ValueError("energy per 100 kcal is always 100")
    label, ids = tracked[key]
    energy_ids = tracked["energy"][1]

    # Read the nutrient's amounts, and energy's, for every food the words allow.
    word_list = [w for w in (words or "").lower().split() if w]
    where = "".join(" AND lower(f.description) LIKE ?" for _ in word_list)
    wanted = tuple(ids) + (tuple(energy_ids) if per == "100kcal" else ())
    rows = conn.execute(
        "SELECT f.fdc_id, f.description, f.data_type, f.category, a.nutrient_id, a.amount, n.unit"
        " FROM fdc_amounts a JOIN fdc_foods f ON f.fdc_id = a.fdc_id"
        " JOIN fdc_nutrients n ON n.id = a.nutrient_id"
        f" WHERE a.nutrient_id IN ({','.join('?' * len(wanted))}){where}",
        list(wanted) + [f"%{w}%" for w in word_list]).fetchall()
    foods = {}
    for fdc_id, description, data_type, category, nutrient_id, amount, unit in rows:
        food = foods.setdefault(fdc_id, {"fdc_id": fdc_id, "description": description,
                                         "data_type": data_type, "category": category, "found": {}})
        food["found"][nutrient_id] = (amount, _unit(unit))

    # Take each food's first-preference id, the same choice the day's totals make.
    unit = None
    ranked = []
    for food in foods.values():
        found = food.pop("found")
        hit = next((found[i] for i in ids if i in found), None)
        if hit is None:
            continue
        per_100g, its_unit = hit
        unit = unit or its_unit
        per_100g = convert(per_100g, its_unit, unit)
        energy = next((found[i][0] for i in energy_ids if i in found), None)
        food.update(per_100g=per_100g, kcal_per_100g=energy)
        if per == "100kcal":
            if energy is None or energy < MIN_KCAL_PER_100G:
                continue
            food["amount"] = per_100g * 100.0 / energy
        else:
            food["amount"] = per_100g
        if keep is None or keep(food):
            ranked.append(food)
    ranked.sort(key=lambda food: (-food["amount"], food["description"]))
    return {"key": key, "label": label, "unit": unit, "per": per, "foods": ranked[:limit]}


def highlights():
    """The foods she's marked as ones she's interested in eating: [{fdc_id, description, added}]."""
    data = store.read(HIGHLIGHTS, {}) or {}
    return data.get("foods") or []


def meals():
    """Her meals and her usual day: {meals: {name: {items: [...]}}, day: [{meal, servings}]}."""
    data = store.read(MEALS, {}) or {}
    return {"meals": data.get("meals") or {}, "day": data.get("day") or []}


def day_items(data=None):
    """Her usual day flattened into items, each meal's grams times its servings."""
    data = data or meals()
    items = []
    for slot in data["day"]:
        meal = data["meals"].get(slot.get("meal")) or {}
        servings = float(slot.get("servings") or 1)
        for item in meal.get("items") or []:
            items.append(dict(item, grams=float(item.get("grams") or 0) * servings,
                              meal=slot.get("meal")))
    return items
