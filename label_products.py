"""label_products.py — packaged foods read off a photo of their Nutrition Facts label.

What this does, in plain English. When USDA's packaged-foods list (fdcdb.py,
Branded Foods) hasn't got a product, she can photograph its label. The photo
is saved here, a helper Claude session reads it (the same way the Kitchen's
receipt scan works: routes/helpers.py mint_helper) and writes what it read
beside the photo as `<photo>.parsed.json`. The page shows that draft next to
the photo so she checks every figure; only what she saves becomes a product.

A saved product is a food like any USDA one: it has an id (negative, so it
can never collide with a USDA FDC id), its figures per 100 g (or per 100 ml,
the way USDA stores drinks), and its barcode, so the next scan finds it. It
goes into meals and totals through `fdcdb.food`, which hands negative ids to
`food()` here. Its figures are named for what they are — the maker's label,
read by AI from a photo and checked by her — never passed off as a lab's.

A barcode found on Open Food Facts instead (openfoodfacts.py) is kept here
too, as a copy with its own data type and a link back to its page there, so
one lookup serves every later scan.

A product record holds only what's printed on the package (name, brand,
barcode, serving, ingredients, figures) and never anything about her, so the
collection can later be shared as a product database without editing it.

Where things live:
  `label_products` (data dir, JSON via store.py) — {products: [...], next_id}.
  `nutrition_labels/` (data dir) — the photos, and each job's `.parsed.json`.

Touches: store.py, openfoodfacts.py (calls save_copy), fdcdb.py (barcode_keys, and it calls food() here),
routes/helpers.py (mint_helper, the helper session), routes/nutrition.py
(the HTTP seam), nutrition.py (totals names these as labelled).
Tests: tests/test_label_products.py. Design: docs/nutrition.md.

Prompt that produced it: "a feature that is AI based that reads the nutrient
label on there and ports that information into that item and creates that
item in the database so i can collect data from items" — "it would also save
the barcode data ... so it collects information for the app passively" —
"i already have something similar to this in the receipt section".
"""
import json
import re
import time
from datetime import datetime

import fdcdb
import store

PRODUCTS = "label_products"
LABELS_DIRNAME = "nutrition_labels"

# The data type a label-photo product carries, beside USDA's own (fdcdb.BRANDED etc.).
LABEL_PHOTO = "label_photo"

# Photo types a phone camera or a screenshot gives.
PHOTO_EXTENSIONS = {".jpg", ".jpeg", ".png", ".heic", ".heif", ".webp"}

# The figures a US Nutrition Facts panel can print: (key, words on the label, FDC nutrient id, unit).
# The unit is the one the label prints and the one stored; the FDC id is how
# nutrition.totals finds it, the same ids USDA's own foods use.
LABEL_NUTRIENTS = (
    ("calories", "Calories", 1008, "kcal"),
    ("total_fat", "Total Fat", 1004, "g"),
    ("saturated_fat", "Saturated Fat", 1258, "g"),
    ("trans_fat", "Trans Fat", 1257, "g"),
    ("polyunsaturated_fat", "Polyunsaturated Fat", 1293, "g"),
    ("monounsaturated_fat", "Monounsaturated Fat", 1292, "g"),
    ("cholesterol", "Cholesterol", 1253, "mg"),
    ("sodium", "Sodium", 1093, "mg"),
    ("total_carbohydrate", "Total Carbohydrate", 1005, "g"),
    ("dietary_fiber", "Dietary Fiber", 1079, "g"),
    ("total_sugars", "Total Sugars", 2000, "g"),
    ("added_sugars", "Added Sugars", 1235, "g"),
    ("protein", "Protein", 1003, "g"),
    ("vitamin_d", "Vitamin D", 1114, "mcg"),
    ("calcium", "Calcium", 1087, "mg"),
    ("iron", "Iron", 1089, "mg"),
    ("potassium", "Potassium", 1092, "mg"),
    ("vitamin_a", "Vitamin A", 1106, "mcg"),
    ("vitamin_c", "Vitamin C", 1162, "mg"),
    ("vitamin_e", "Vitamin E", 1109, "mg"),
    ("vitamin_k", "Vitamin K", 1185, "mcg"),
    ("thiamin", "Thiamin", 1165, "mg"),
    ("riboflavin", "Riboflavin", 1166, "mg"),
    ("niacin", "Niacin", 1167, "mg"),
    ("vitamin_b6", "Vitamin B6", 1175, "mg"),
    ("folate", "Folate", 1190, "mcg"),
    ("vitamin_b12", "Vitamin B12", 1178, "mcg"),
    ("pantothenic_acid", "Pantothenic Acid", 1170, "mg"),
    ("choline", "Choline", 1180, "mg"),
    ("magnesium", "Magnesium", 1090, "mg"),
    ("phosphorus", "Phosphorus", 1091, "mg"),
    ("zinc", "Zinc", 1095, "mg"),
    ("copper", "Copper", 1098, "mg"),
    ("manganese", "Manganese", 1101, "mg"),
    ("selenium", "Selenium", 1103, "mcg"),
    ("iodine", "Iodine", 1100, "mcg"),
)
_BY_KEY = {key: (words, nutrient_id, unit) for key, words, nutrient_id, unit in LABEL_NUTRIENTS}
# FDC's own spelling of each unit, so a product's nutrients read like a USDA food's.
_FDC_UNITS = {"kcal": "KCAL", "g": "G", "mg": "MG", "mcg": "UG"}


def labels_dir():
    """Where the label photos and their drafts are kept (made on first use)."""
    path = store.DATA_DIR / LABELS_DIRNAME
    path.mkdir(parents=True, exist_ok=True)
    return path


# --- reading a photo -------------------------------------------------------------------

def reading_brief(photos, barcode=""):
    """The helper session's whole job, in its own words: read these photos, write one JSON file.

    Every figure is copied per serving exactly as printed; converting to per
    100 g happens in save_product, in code, where it can be tested."""
    keys = ", ".join(key for key, *_ in LABEL_NUTRIENTS)
    photo_lines = "\n".join(f"- `{path}`" for path in photos)
    out = f"{photos[0]}.parsed.json"
    barcode_line = (f"The barcode was already scanned as `{barcode}`; use it unless a photo clearly shows another.\n"
                    if barcode else "")
    return (
        "# Nutrition label read\n\n## Protocol\n\n"
        "1. Read these photos of one packaged food (open each with the Read tool; "
        "convert HEIC to JPEG first if it won't open):\n"
        f"{photo_lines}\n"
        f"2. Write exactly one file, `{out}`, then stop — nobody is waiting to chat. "
        "Don't touch any other file.\n\n"
        "## What to write\n\n"
        f"{barcode_line}"
        "A JSON object:\n\n"
        "```json\n"
        "{\n"
        '  "name": "product name as on the front, e.g. Whole Milk",\n'
        '  "brand": "brand, e.g. H-E-B",\n'
        '  "barcode": "digits under the barcode, or empty",\n'
        '  "serving_text": "serving size as printed, e.g. 1 cup (240mL)",\n'
        '  "serving_amount": 240,\n'
        '  "serving_unit": "g or ml — the metric amount in the serving line",\n'
        '  "servings_per_container": 16,\n'
        '  "ingredients": "ingredient list as printed, or empty",\n'
        '  "nutrients": {"calories": {"amount": 150, "unit": "kcal", "dv_percent": null}},\n'
        '  "unreadable": ["keys you could see but not read"],\n'
        '  "notes": "anything odd: two columns, a figure that looked like <1, glare"\n'
        "}\n"
        "```\n\n"
        "Rules:\n"
        "- Copy each figure **per serving, as printed** (the first column when there are two, "
        "and say so in notes). Don't convert anything.\n"
        f"- Use only these nutrient keys: {keys}.\n"
        "- `unit` is kcal, g, mg or mcg — what the label prints. A vitamin given only as a % "
        "Daily Value gets `\"amount\": null` and its `dv_percent`.\n"
        "- A figure printed as \"less than 1 g\" or \"<1g\" is `\"amount\": 0.5` with a note; "
        "a printed 0 is 0.\n"
        "- A nutrient the label doesn't print is simply left out. Never guess one.\n"
    )


def draft_path(photo_name):
    return labels_dir() / f"{photo_name}.parsed.json"


def job_status(photo_name, started=None, give_up_after=900):
    """Where one label read is: reading, ready (with the draft), or failed.

    `failed` means the draft file isn't valid JSON, or nothing came after
    `give_up_after` seconds — the helper session's card says why."""
    photo = labels_dir() / photo_name
    if not _safe_name(photo_name) or not photo.exists():
        return {"status": "missing"}
    path = draft_path(photo_name)
    if not path.exists():
        age = time.time() - (started or photo.stat().st_mtime)
        return {"status": "failed" if age > give_up_after else "reading",
                "error": "No reading came back — the helper's card in the Observatory says why."
                if age > give_up_after else None}
    try:
        raw = json.loads(path.read_text())
    except (OSError, ValueError) as exc:
        return {"status": "failed", "error": f"The reading isn't valid JSON: {exc}"}
    return {"status": "ready", "draft": clean_draft(raw), "fields": label_fields()}


def label_fields():
    """The label's rows in panel order, for the check-it form: [{key, words, unit, core}].

    `core` marks the ones every US label must print (21 CFR 101.9), shown even when the read missed them."""
    return [{"key": key, "words": words, "unit": unit, "core": key in _CORE}
            for key, words, _, unit in LABEL_NUTRIENTS]


# The figures every current US Nutrition Facts panel prints.
_CORE = {"calories", "total_fat", "saturated_fat", "trans_fat", "cholesterol", "sodium", "total_carbohydrate",
         "dietary_fiber", "total_sugars", "added_sugars", "protein", "vitamin_d", "calcium", "iron", "potassium"}


def clean_draft(raw):
    """What the reader wrote, kept to the known shape: unknown keys dropped, numbers made numbers."""
    raw = raw if isinstance(raw, dict) else {}
    nutrients = {}
    for key, value in (raw.get("nutrients") or {}).items():
        if key not in _BY_KEY or not isinstance(value, dict):
            continue
        nutrients[key] = {"amount": _number(value.get("amount")),
                          "unit": _BY_KEY[key][2],
                          "printed_unit": str(value.get("unit") or ""),
                          "dv_percent": _number(value.get("dv_percent"))}
    unit = str(raw.get("serving_unit") or "").strip().lower()
    return {
        "name": str(raw.get("name") or "").strip(),
        "brand": str(raw.get("brand") or "").strip(),
        "barcode": re.sub(r"\D", "", str(raw.get("barcode") or "")),
        "serving_text": str(raw.get("serving_text") or "").strip(),
        "serving_amount": _number(raw.get("serving_amount")),
        "serving_unit": "ml" if unit in ("ml", "mlt", "milliliter", "millilitre") else "g",
        "ingredients": str(raw.get("ingredients") or "").strip(),
        "nutrients": nutrients,
        "unreadable": [str(key) for key in (raw.get("unreadable") or []) if isinstance(key, str)],
        "notes": str(raw.get("notes") or "").strip(),
    }


# --- saving a product ------------------------------------------------------------------

def save_product(fields, photo=None):
    """Save a checked label as a product; returns it. Raises ValueError on a bad draft.

    Figures come in per serving, as printed, and are stored per 100 g (or
    100 ml): each multiplied by 100 / the serving's metric amount. A nutrient
    with no amount (only a % Daily Value, or left blank) isn't stored, so it
    counts as unknown rather than zero."""
    draft = clean_draft(fields)
    if not draft["name"]:
        raise ValueError("the product needs a name")
    serving = draft["serving_amount"]
    if not serving or serving <= 0:
        raise ValueError("the serving size needs its grams (or ml), to turn figures into per 100 g")
    per_100 = {}
    for key, value in draft["nutrients"].items():
        if value["amount"] is None or value["amount"] < 0:
            continue
        per_100[key] = round(value["amount"] * 100.0 / serving, 4)
    if not per_100:
        raise ValueError("no figures to save")

    return _store({
        "data_type": LABEL_PHOTO,
        "name": draft["name"], "brand": draft["brand"], "barcode": draft["barcode"],
        "serving_text": draft["serving_text"], "serving_amount": serving,
        "serving_unit": draft["serving_unit"], "ingredients": draft["ingredients"],
        "per_100": per_100,
        "photo": photo if photo and _safe_name(photo) else None,
        "source": "label photo, read by AI and checked before saving",
    })


def save_copy(fields, per_100, data_type, source, url):
    """Keep a product found in another database (openfoodfacts.py) as a local copy; returns it.

    `fields` are the package facts in save_product's shape, `per_100` its
    figures already per 100 g in a label's units. The copy is named for where
    it came from (`data_type`, `source`, `url`), never as her own label."""
    unit = "ml" if fields.get("serving_unit") == "ml" else "g"
    return _store({
        "data_type": data_type,
        "name": str(fields.get("name") or "").strip(), "brand": str(fields.get("brand") or "").strip(),
        "barcode": re.sub(r"\D", "", str(fields.get("barcode") or "")),
        "serving_text": str(fields.get("serving_text") or "").strip(),
        "serving_amount": fields.get("serving_amount"), "serving_unit": unit,
        "ingredients": str(fields.get("ingredients") or "").strip(),
        "per_100": {key: amount for key, amount in per_100.items() if key in _BY_KEY},
        "photo": None, "url": url, "source": source,
    })


def _store(product):
    """Give a product the next negative id and today's date, and save it; returns it."""
    with store.mutate(PRODUCTS, {}) as data:
        products = data.setdefault("products", [])
        next_id = int(data.get("next_id") or 1)
        product = {"id": -next_id, **product, "added": datetime.now().strftime("%Y-%m-%d")}
        products.append(product)
        data["next_id"] = next_id + 1
    return product


def products():
    return (store.read(PRODUCTS, {}) or {}).get("products", [])


def product(product_id):
    return next((p for p in products() if p.get("id") == product_id), None)


# --- reading products back, shaped like USDA's ----------------------------------------

def food(product_id):
    """One product in fdcdb.food's shape (nutrients keyed by FDC id, per 100 g), or None."""
    found = product(product_id)
    if not found:
        return None
    nutrients = {}
    for key, amount in (found.get("per_100") or {}).items():
        if key not in _BY_KEY:
            continue
        words, nutrient_id, unit = _BY_KEY[key]
        nutrients[nutrient_id] = {"name": words, "unit": _FDC_UNITS[unit], "amount": amount,
                                  "data_points": None, "min": None, "max": None, "median": None}
    grams = found.get("serving_amount") if found.get("serving_unit") == "g" else None
    return {
        "fdc_id": found["id"], "data_type": found.get("data_type", LABEL_PHOTO), "description": found["name"],
        "category": None, "nutrients": nutrients,
        "portions": [{"amount": 1, "unit": "serving", "description": found.get("serving_text") or "serving",
                      "grams": grams}] if grams else [],
        "label": _label(found),
    }


def _label(found):
    return {"gtin_upc": found.get("barcode") or "", "brand_owner": found.get("brand") or "",
            "brand_name": found.get("brand") or "", "serving_size": found.get("serving_amount"),
            "serving_size_unit": found.get("serving_unit"), "household_serving": found.get("serving_text"),
            "ingredients": found.get("ingredients") or "", "available_date": found.get("added")}


def as_result(found):
    """A product as a packaged-search result, the same shape fdcdb._packaged gives."""
    return {"fdc_id": found["id"], "data_type": found.get("data_type", LABEL_PHOTO), "description": found["name"],
            "category": None, "gtin_upc": found.get("barcode") or "", "brand_owner": found.get("brand") or "",
            "brand_name": found.get("brand") or "", "serving_size": found.get("serving_amount"),
            "serving_size_unit": found.get("serving_unit"), "household_serving": found.get("serving_text"),
            "nutrient_count": len(found.get("per_100") or {})}


def lookup_barcode(code):
    """Her label-photo products under one barcode, matched the way fdcdb matches USDA's.

    Her own label reads come first, copies from Open Food Facts after them: a photo of the
    package is read straight off it, while a crowd copy can have gaps (sorted() keeps order
    within each kind)."""
    keys = set(fdcdb.barcode_keys(code))
    matches = [p for p in products() if p.get("barcode") and set(fdcdb.barcode_keys(p["barcode"])) & keys]
    return [as_result(p) for p in sorted(matches, key=lambda p: p.get("data_type", LABEL_PHOTO) != LABEL_PHOTO)]


def search(text):
    """Her label-photo products whose name or brand holds every word (as a word start)."""
    words = [w for w in re.split(r"\W+", (text or "").lower()) if w]
    if not words:
        return []
    found = []
    for p in products():
        haystack = re.split(r"\W+", f"{p.get('name', '')} {p.get('brand', '')}".lower())
        if all(any(h.startswith(w) for h in haystack) for w in words):
            found.append(as_result(p))
    return found


# --- small checks ----------------------------------------------------------------------

def _number(value):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number == number else None  # NaN is no number


def _safe_name(name):
    """A bare file name in the labels folder: no slashes, no climbing out."""
    return bool(name) and "/" not in name and "\\" not in name and not name.startswith(".")
