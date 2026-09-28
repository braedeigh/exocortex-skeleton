"""What a recipe gives, nutrient by nutrient, and what in it she's sensitive to.

**What this does.** Takes a kitchen recipe's lines ("carrots — 3 medium,
chunked") and turns each into a USDA food and a gram weight, so the recipe can
be added up like one of her meals (nutrition.py) and laid beside her daily
targets, one serving at a time. It also marks every line that hurts her (the
food guide and the catalog's `safety`), and what the SIGHI low-histamine list
says about it (histamine.py), so the Recipes list can be filtered by both.

**Two things each line needs, and how sure each one is.**

  which USDA entry — the food's own choice in `food_usda` when she's made one
      ("confirmed"); otherwise one suggested from the food's name (a single
      food, raw where there's a raw one, SR Legacy first because it has the
      portions and the fuller nutrient list). A suggestion is counted but
      marked, the same way a guessed gram weight is on the Nutrients page.
  how many grams — in order: her own weight for the line
      (`recipe_line_grams`); a weight the recipe writes ("600 g", "1 lb", the
      "3-4 lb" in "1 (3-4 lb)"); or a count or measure worked out from USDA's
      household portions for that entry ("3 medium" × USDA's medium carrot,
      61 g; "2 tbsp" from its tbsp or cup). A range ("2-3") takes its middle
      and says so. "To taste", "a drizzle", "to cover" can't be weighed: the
      line is listed as not counted, never counted as 0.

**Per serving.** The recipe's total divided by its `servings`. A recipe with no
servings is shown whole, and says so.

**Her gaps.** The nutrients her usual day (nutrition.day_items) falls short
of; each recipe says how much of each gap one serving closes.

Touches: `foodstore.py` (the recipe rows, the catalog, and the two tables this
reads — `food_usda`, `recipe_line_grams`, rung 39 in `sqlstore.py`),
`fdcdb.py` (entries and portions), `nutrition.py` (report, day_items,
is_single_food), `histamine.py`, `store.py` (the food guide),
`routes/recipe_nutrition.py` (the HTTP door),
`tests/test_recipe_nutrition.py`. Design: docs/recipe-nutrition.md.

Prompt that produced this file: "i'll want it to have shareable recipes and
popular recipes so that people can get recipes that meet their nutrient
requirements and they can filter by foods they are sensitive to" — the first
two parts: nutrients against the targets, and the sensitivity filter.
"""
import functools
import re

import fdcdb
import foodstore
import histamine
import nutrition
import sqlstore
import store

# --- reading an amount as written ---------------------------------------------

# Unicode fractions a pasted recipe carries, as plain text.
_FRACTIONS = {"½": " 1/2", "⅓": " 1/3", "⅔": " 2/3", "¼": " 1/4", "¾": " 3/4", "⅛": " 1/8"}

# A number as recipes write it: 2, 1.5, 1/2, 1 1/2; and a range of two.
_NUMBER = r"\d+(?:\.\d+)?(?:\s+\d+/\d+)?|\d+/\d+"
_RANGE = rf"({_NUMBER})(?:\s*(?:-|–|to)\s*({_NUMBER}))?"

# Weights, in grams of one unit.
_MASS = {"g": 1.0, "gram": 1.0, "grams": 1.0, "kg": 1000.0, "oz": 28.3495, "ounce": 28.3495,
         "ounces": 28.3495, "lb": 453.592, "lbs": 453.592, "pound": 453.592, "pounds": 453.592}
_MASS_WORDS = "|".join(sorted(_MASS, key=len, reverse=True))

# Volumes, in teaspoons of one unit, so any one USDA measure can stand for the rest.
_VOLUME = {"tsp": 1.0, "teaspoon": 1.0, "teaspoons": 1.0, "tbsp": 3.0, "tbs": 3.0,
           "tablespoon": 3.0, "tablespoons": 3.0, "cup": 48.0, "cups": 48.0, "c": 48.0,
           "fl oz": 6.0, "ml": 0.2029, "l": 202.9, "liter": 202.9, "quart": 192.0, "pint": 96.0}
_VOLUME_WORDS = "|".join(re.escape(w) for w in sorted(_VOLUME, key=len, reverse=True))

# Size and piece words a count can carry, each with the words USDA may use for it.
_PIECES = {"small": ("small",), "medium": ("medium",), "large": ("large",),
           "clove": ("clove",), "cloves": ("clove",), "rib": ("stalk", "rib"), "ribs": ("stalk", "rib"),
           "stalk": ("stalk",), "stalks": ("stalk",), "slice": ("slice",), "slices": ("slice",),
           "leaf": ("leaf",), "leaves": ("leaf",), "head": ("head",), "bunch": ("bunch",),
           "sprig": ("sprig",), "sprigs": ("sprig",), "piece": ("piece",), "whole": ()}


def _number(text):
    """'1 1/2' → 1.5, '3/4' → 0.75, '2' → 2.0."""
    total = 0.0
    for part in text.split():
        if "/" in part:
            top, bottom = part.split("/")
            total += float(top) / float(bottom) if float(bottom) else 0.0
        else:
            total += float(part)
    return total


def _quantity(match):
    """A matched number or range → (value, 'the middle of 2–3' or None)."""
    low = _number(match.group(1))
    if match.group(2):
        high = _number(match.group(2))
        return (low + high) / 2, f"the middle of {match.group(1)}–{match.group(2)}"
    return low, None


def read_amount(amount):
    """What an amount as written says: a weight, a volume, a count, or nothing weighable.

    Returns {kind: mass|volume|count|none, grams?, teaspoons?, count?, piece?,
    note?}. A weight in brackets is per piece ("1 (3-4 lb)" is one 3–4 lb
    chicken), so it's multiplied by the count ahead of the bracket.
    """
    text = str(amount or "").lower()
    for mark, plain in _FRACTIONS.items():
        text = text.replace(mark, plain)
    text = text.replace("fluid ounce", "fl oz")
    outside = re.sub(r"\([^)]*\)", " ", text)
    inside = " ".join(re.findall(r"\(([^)]*)\)", text))

    # A weight written outright wins: "600 g (1 1/4 lb)", "1 lb (2 cups)".
    mass = re.compile(rf"{_RANGE}\s*({_MASS_WORDS})\b")
    found = mass.search(outside)
    if found and "fl" not in outside[max(0, found.start(3) - 3):found.start(3)]:
        value, note = _quantity(found)
        return {"kind": "mass", "grams": value * _MASS[found.group(3)], "note": note}

    # A weight in brackets is per piece, times the count ahead of it.
    found = mass.search(inside)
    if found:
        value, note = _quantity(found)
        count = re.match(rf"\s*(?:from\s+)?{_RANGE}", outside)
        times = _quantity(count)[0] if count else 1.0
        return {"kind": "mass", "grams": times * value * _MASS[found.group(3)], "note": note}

    # A volume: "2 tbsp", "1 1/2 tsp", "3-4 cups".
    found = re.search(rf"{_RANGE}\s*({_VOLUME_WORDS})\b", outside)
    if found:
        value, note = _quantity(found)
        return {"kind": "volume", "teaspoons": value * _VOLUME[found.group(3)], "note": note}

    # A count, maybe with a size or piece word: "3 medium", "6 cloves", "6".
    found = re.search(rf"{_RANGE}\s*([a-z]+)?", outside)
    if found:
        value, note = _quantity(found)
        word = found.group(3)
        return {"kind": "count", "count": value, "piece": word if word in _PIECES else None,
                "unweighable": word if word and word not in _PIECES else None, "note": note}
    return {"kind": "none"}


# --- turning it into grams with USDA's portions --------------------------------

def _portion_words(portion):
    """A USDA portion's words, and grams for one of it.

    Three datasets write portions three ways — Foundation as unit 'cup',
    SR Legacy as description 'medium (2-1/2" dia)', FNDDS as '1 regular
    carrot 64724' — so the words are read from both fields and a leading
    count in the description divides the grams.
    """
    label = f"{portion.get('unit') or ''} {portion.get('description') or ''}".lower()
    amount = portion.get("amount")
    lead = re.match(rf"\s*({_NUMBER})\s", label)
    if amount is None and lead:
        amount = _number(lead.group(1))
    grams = portion["grams"] / (amount or 1.0)
    words = [histamine.normal(word) for word in re.findall(r"[a-z]+", re.sub(r"\([^)]*\)", " ", label))]
    return words, grams, label.strip()


def weigh(reading, portions, item_text=""):
    """An amount read by read_amount → (grams, how it was found) or (None, why not).

    `portions` are the USDA entry's household measures (fdcdb.food()["portions"]).
    """
    note = f", {reading['note']}" if reading.get("note") else ""
    if reading["kind"] == "mass":
        return reading["grams"], f"as written{note}"
    if reading["kind"] == "none":
        return None, "no amount to weigh"
    measures = [_portion_words(p) for p in portions or []]

    # A volume: scale from any one of USDA's spoon or cup measures for this food.
    if reading["kind"] == "volume":
        for words, grams, label in measures:
            unit = next((w for w in words[:2] if w in _VOLUME), None)
            if unit:
                per_teaspoon = grams / _VOLUME[unit]
                return reading["teaspoons"] * per_teaspoon, f"from USDA's {label} = {grams:g} g{note}"
        return None, "USDA gives no spoon or cup weight for this food"

    # A count: the piece word, then a word from the line itself ("garlic cloves"), then 'medium'.
    if reading.get("unweighable"):
        return None, f"can't weigh a '{reading['unweighable']}'"
    wanted = list(_PIECES.get(reading.get("piece") or "", ()))
    wanted += [histamine.normal(w) for w in re.findall(r"[a-z]+", item_text.lower())]
    wanted.append("medium")
    for want in wanted:
        for words, grams, label in measures:
            if want and want in words and not (set(words[:2]) & set(_VOLUME)):
                count = reading["count"]
                return count * grams, f"{count:g} × USDA's {label} ({grams:g} g){note}"
    return None, "USDA has no portion that fits this count"


# --- which USDA entry a food is ------------------------------------------------

_DATASET_ORDER = {"sr_legacy_food": 0, "foundation_food": 1, "survey_fndds_food": 2}


def _words(text):
    """A name as whole, singular words: 'Onions, raw' → ['onion', 'raw']."""
    return histamine.normal(text).split()


# Words that say nothing about which food it is, when fitting a name to USDA's.
_PLAIN_WORDS = {"spice", "raw"}


def _fit(name_words, description):
    """How far a USDA name strays from a food's name: (extra head words, extra leading words).

    USDA writes the food first and the details after ("Oil, olive, salad or
    cooking"), so words beyond the name in the first segment, and then in the
    first two, count against it. 'Spices' and 'raw' don't count.
    """
    segments = [_words(segment) for segment in description.split(",")]
    head = set(segments[0]) - _PLAIN_WORDS
    leading = set(segments[0] + (segments[1] if len(segments) > 1 else [])) - _PLAIN_WORDS
    return len(head - set(name_words)), len(leading - set(name_words))


@functools.lru_cache(maxsize=2048)
def _suggest(name):
    """A USDA single food for a name: (fdc_id, description) or None.

    Every word searched for must be a whole word of the USDA name ("butter"
    isn't "butterfish"). The whole name is tried, then its last word alone —
    the noun, since English puts the food last ("apple cider vinegar" →
    "vinegar", "yukon potatoes" → "potato"), skipping piece words ("garlic
    cloves" → "garlic"). Never an earlier word: "beef broth" suggests
    nothing rather than ground beef. A lone word counts only when USDA's
    head names nothing else, so "water" doesn't become "Water convolvulus".
    Ranked: least extra in USDA's head, the whole name over the lone word,
    least extra in USDA's first two segments, a raw form, SR Legacy (it has
    the household portions), the shortest name. A cache: USDA's tables change
    only when the commons reloads.
    """
    words = _words(name)
    tries = [(words, 0)]
    if len(words) > 1:
        noun = next((word for word in reversed(words) if word not in _PIECES), None)
        tries += [([noun], 1)] if noun else []
    found = []
    with fdcdb.session() as conn:
        for attempt, place in tries:
            if not attempt:
                continue
            for food in fdcdb.search(conn, " ".join(attempt), limit=2000):
                described = _words(food["description"])
                if not set(attempt) <= set(described) or not nutrition.is_single_food(food):
                    continue
                extra_head, extra_leading = _fit(words, food["description"])
                if len(attempt) == 1 and extra_head:
                    continue
                found.append((extra_head, place, extra_leading, "raw" not in described,
                              _DATASET_ORDER.get(food["data_type"], 3), len(food["description"]), food))
    if not found:
        return None
    best = min(found, key=lambda entry: entry[:6])[6]
    return best["fdc_id"], best["description"]


# --- one recipe, line by line --------------------------------------------------

def _guide_sets():
    """The food guide's hurts and unsure lists, as matched names."""
    guide = store.read("food_guide.json", {}) or {}
    return ({foodstore._norm(n) for n in guide.get("hurts") or []},
            {foodstore._norm(n) for n in guide.get("unsure") or []})


def _catalog(conn):
    """Each food's name, safety and confirmed USDA entry, by food id."""
    foods = {fid: {"name": name, "safety": safety, "fdc_id": None}
             for fid, name, safety in conn.execute("SELECT id, name, safety FROM foods")}
    for fid, fdc_id in conn.execute("SELECT food_id, fdc_id FROM food_usda"):
        if fid in foods:
            foods[fid]["fdc_id"] = fdc_id
    return foods


def _lines(conn, recipe_ids=None):
    """Recipe rows and their lines, from the derived tables foodstore.rebuild() fills."""
    where = "" if recipe_ids is None else f" AND r.id IN ({','.join('?' * len(recipe_ids))})"
    recipes = {}
    for rid, name, servings in conn.execute(
            f"SELECT r.id, r.name, r.servings FROM recipes r WHERE r.archived = 0{where}"
            " ORDER BY r.name", tuple(recipe_ids or ())):
        recipes[rid] = {"id": rid, "name": name, "servings": servings, "lines": []}
    for rid, seq, text, amount, usually, food_id in conn.execute(
            "SELECT recipe_id, seq, text, amount, usually_have, food_id FROM recipe_lines"
            " ORDER BY recipe_id, seq"):
        if rid in recipes:
            recipes[rid]["lines"].append({"seq": seq, "text": text, "amount": amount,
                                          "usually_have": bool(usually), "food_id": food_id})
    own = {(rid, line): (grams, for_amount) for rid, line, grams, for_amount in
           conn.execute("SELECT recipe_id, line, grams, for_amount FROM recipe_line_grams")}
    return recipes, own


def _resolve(recipe, own, foods, guide, sighi, fdc):
    """Each line of one recipe with its food, USDA entry, grams and flags filled in."""
    hurts, unsure = guide
    lines = []
    for line in recipe["lines"]:
        food = foods.get(line["food_id"]) or {}
        name = food.get("name") or line["text"]

        # Which USDA entry: her choice for the food, else a suggestion by name.
        usda = None
        if food.get("fdc_id"):
            entry = fdc(food["fdc_id"])
            usda = {"fdc_id": food["fdc_id"], "description": entry["description"] if entry else None,
                    "confirmed": True}
        else:
            guess = _suggest(name)
            if guess:
                usda = {"fdc_id": guess[0], "description": guess[1], "confirmed": False}
        entry = fdc(usda["fdc_id"]) if usda else None

        # How many grams: hers, else the amount as written, weighed with USDA's portions.
        grams, how, source, stale = None, None, None, None
        mine = own.get((recipe["id"], foodstore._norm(line["text"])))
        if mine and (mine[1] or "") == (line["amount"] or "").strip():
            grams, how, source = mine[0], "your weight", "yours"
        else:
            if mine:
                stale = {"grams": mine[0], "for_amount": mine[1]}
            reading = read_amount(line["amount"])
            if reading["kind"] == "mass":
                grams, how = weigh(reading, [])
                source = "written"
            elif entry:
                grams, how = weigh(reading, entry["portions"], line["text"])
                source = "usda_portion" if grams is not None else None
            else:
                how = "no USDA entry to weigh it with"

        # What she's sensitive to: the guide and the catalog, then SIGHI by the entry's name.
        keys = {foodstore._norm(line["text"]), foodstore._norm(name)}
        safety = ("hurts" if food.get("safety") == "hurts" or keys & hurts
                  else "unsure" if food.get("safety") == "unsure" or keys & unsure else None)
        rating = histamine.rate(sighi, (usda or {}).get("description") or name) if sighi else None

        lines.append(dict(line, food_name=food.get("name"), usda=usda, grams=grams, grams_how=how,
                          grams_source=source, stale_grams=stale, safety=safety,
                          histamine=rating))
    return lines


def _flags(lines):
    """What a recipe's lines add up to for the filters."""
    return {
        "hurts": [line["text"] for line in lines if line["safety"] == "hurts"],
        "unsure": [line["text"] for line in lines if line["safety"] == "unsure"],
        "histamine_high": [line["text"] for line in lines
                           if (line["histamine"] or {}).get("verdict") in ("high", "avoid")],
        "histamine_moderate": [line["text"] for line in lines
                               if (line["histamine"] or {}).get("verdict") in ("moderate", "unclear")],
        "histamine_unrated": [line["text"] for line in lines if not line["histamine"]],
    }


def _serving_items(recipe, lines):
    """The counted lines as nutrition.py items, each at one serving's grams."""
    servings = float(recipe["servings"] or 0) or 1.0
    return [{"label": line["text"], "fdc_id": line["usda"]["fdc_id"], "grams": line["grams"] / servings}
            for line in lines if line["grams"] is not None and line["usda"]]


def _day_gaps(conn):
    """The nutrients her usual day falls short of, for any sex shown: [key]."""
    report = nutrition.report(conn, nutrition.day_items())
    return [row["key"] for row in report["nutrients"]
            if any(judged.get("status") == "under" for judged in row["by_sex"].values())]


def _percent(row):
    """One serving's share of the target, the stricter sex's when both are shown."""
    shares = [judged.get("percent") for judged in row["by_sex"].values() if judged.get("percent") is not None]
    return min(shares) if shares else None


def _context():
    """What every recipe view reads once: rebuilt rows, the catalog, the guide, SIGHI."""
    foodstore.rebuild()
    return _guide_sets(), histamine.names(), histamine.SOURCE


def recipe(recipe_id):
    """One recipe, line by line, and one serving against her targets.

    Returns {id, name, servings, per: serving|recipe, lines: [...], report
    (nutrition.report of one serving), not_counted: [text], guesses: {usda,
    grams}, flags, gaps, histamine_source}, or None for an unknown recipe.
    """
    guide, sighi, source = _context()
    conn = sqlstore.open_db()
    try:
        recipes, own = _lines(conn, [recipe_id])
        foods = _catalog(conn)
    finally:
        conn.close()
    if recipe_id not in recipes:
        return None
    one = recipes[recipe_id]
    with fdcdb.session() as commons:
        fdc = functools.lru_cache(maxsize=None)(lambda fdc_id: fdcdb.food(commons, fdc_id))
        lines = _resolve(one, own, foods, guide, sighi, fdc)
        report = nutrition.report(commons, _serving_items(one, lines))
        gaps = _day_gaps(commons)
    return {"id": one["id"], "name": one["name"], "servings": one["servings"],
            "per": "serving" if one["servings"] else "recipe", "lines": lines, "report": report,
            "not_counted": [line["text"] for line in lines if line["grams"] is None or not line["usda"]],
            "guesses": {"usda": sum(1 for line in lines if line["usda"] and not line["usda"]["confirmed"]),
                        "grams": sum(1 for line in lines if line["grams_source"] == "usda_portion")},
            "flags": _flags(lines), "gaps": gaps,
            "histamine_source": dict(source, loaded=bool(sighi))}


def overview():
    """Every recipe in short: one serving's share of each target, and its flags.

    Returns {recipes: [{id, name, servings, per, lines, counted, guesses,
    nutrients: {key: {amount, unit, percent}}, flags}], gaps: [{key, label}],
    histamine_source}. What the Recipes list sorts and filters by.
    """
    guide, sighi, source = _context()
    conn = sqlstore.open_db()
    try:
        recipes, own = _lines(conn)
        foods = _catalog(conn)
    finally:
        conn.close()
    out = []
    with fdcdb.session() as commons:
        fdc = functools.lru_cache(maxsize=None)(lambda fdc_id: fdcdb.food(commons, fdc_id))
        for one in recipes.values():
            lines = _resolve(one, own, foods, guide, sighi, fdc)
            report = nutrition.report(commons, _serving_items(one, lines))
            out.append({
                "id": one["id"], "name": one["name"], "servings": one["servings"],
                "per": "serving" if one["servings"] else "recipe",
                "lines": len(lines),
                "counted": sum(1 for line in lines if line["grams"] is not None and line["usda"]),
                "guesses": sum(1 for line in lines if (line["usda"] and not line["usda"]["confirmed"])
                               or line["grams_source"] == "usda_portion"),
                "nutrients": {row["key"]: {"amount": row["amount"], "unit": row["unit"],
                                           "percent": _percent(row)}
                              for row in report["nutrients"]},
                "flags": _flags(lines)})
        gaps = _day_gaps(commons)
    labels = {key: label for key, label, _ in nutrition.TRACKED}
    return {"recipes": out, "gaps": [{"key": key, "label": labels[key]} for key in gaps],
            "histamine_source": dict(source, loaded=bool(sighi))}
