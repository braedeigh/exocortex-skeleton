"""openfoodfacts.py — a barcode USDA hasn't got, looked up on Open Food Facts.

What this does, in plain English. Open Food Facts (world.openfoodfacts.org)
is a free, crowd-sourced product database: people photograph packages and
type in their labels. When a scanned or typed barcode is in neither her own
products nor USDA's Branded Foods, the packaged search asks Open Food Facts
for it here. A product it has is kept as a local copy in her products
(label_products.py, with its own data type), so the next scan finds it without
the network, it can go into meals, and it's always named for what it is:
figures typed in by strangers off a label, not a lab's and not hers.

Open Food Facts gives every figure per 100 g (or 100 ml) already, and in
grams — sodium 0.044 means 44 mg — so this turns each into the unit a US
label prints (label_products.LABEL_NUTRIENTS). A figure it doesn't list is
left out, so it counts as unknown, never zero.

Nothing is sent to Open Food Facts but the barcode being looked up.

Touches: label_products.py (save_copy stores the copy), config.py (the
owner's email, which Open Food Facts asks to see in the User-Agent),
routes/nutrition.py (the packaged search calls lookup on a barcode miss).
Tests: tests/test_openfoodfacts.py. Design: docs/nutrition.md.

Prompt that produced it: "Open Food Facts fallback for barcodes USDA doesn't
carry? ... On a USDA miss, look the barcode up live, tag the result 'Open Food
Facts (crowd-sourced)', and keep a local copy." — "yes".
"""
import json
import re
import urllib.error
import urllib.request

import config
import label_products

# The data type a copied Open Food Facts product carries.
OPEN_FOOD_FACTS = "open_food_facts"

PRODUCT_API = "https://world.openfoodfacts.org/api/v2/product/{code}.json"
PRODUCT_PAGE = "https://world.openfoodfacts.org/product/{code}"

# Open Food Facts' nutriment names for each label figure (label_products' keys).
OFF_KEYS = {
    "calories": "energy-kcal", "total_fat": "fat", "saturated_fat": "saturated-fat",
    "trans_fat": "trans-fat", "polyunsaturated_fat": "polyunsaturated-fat",
    "monounsaturated_fat": "monounsaturated-fat", "cholesterol": "cholesterol", "sodium": "sodium",
    "total_carbohydrate": "carbohydrates", "dietary_fiber": "fiber", "total_sugars": "sugars",
    "added_sugars": "added-sugars", "protein": "proteins", "vitamin_d": "vitamin-d",
    "calcium": "calcium", "iron": "iron", "potassium": "potassium", "vitamin_a": "vitamin-a",
    "vitamin_c": "vitamin-c", "vitamin_e": "vitamin-e", "vitamin_k": "vitamin-k",
    "thiamin": "vitamin-b1", "riboflavin": "vitamin-b2", "niacin": "vitamin-pp",
    "vitamin_b6": "vitamin-b6", "folate": "vitamin-b9", "vitamin_b12": "vitamin-b12",
    "pantothenic_acid": "pantothenic-acid", "choline": "choline", "magnesium": "magnesium",
    "phosphorus": "phosphorus", "zinc": "zinc", "copper": "copper", "manganese": "manganese",
    "selenium": "selenium", "iodine": "iodine",
}
# How many of a label's unit make one of Open Food Facts' (it keeps masses in grams).
_FROM_GRAMS = {"kcal": 1, "g": 1, "mg": 1000, "mcg": 1_000_000}
_UNITS = {key: unit for key, _, _, unit in label_products.LABEL_NUTRIENTS}


def fetch(code, timeout=6):
    """Open Food Facts' record for one barcode: the product dict, None if it hasn't one.

    Raises OSError when it can't be reached (no network, a timeout, a 5xx),
    so a caller can tell 'not there' from 'couldn't ask'."""
    digits = re.sub(r"\D", "", str(code or ""))
    if not digits:
        return None
    email = config.get_profile().get("owner_email")
    agent = f"Exocortex/1.0 ({email})" if email else "Exocortex/1.0"
    request = urllib.request.Request(PRODUCT_API.format(code=digits), headers={"User-Agent": agent})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = json.load(response)
    except urllib.error.HTTPError as exc:
        # A 404 is Open Food Facts saying it hasn't the product; anything else is trouble reaching it.
        if exc.code == 404:
            return None
        raise OSError(f"Open Food Facts answered {exc.code}") from exc
    except ValueError as exc:
        raise OSError("Open Food Facts sent something that isn't JSON") from exc
    if body.get("status") != 1 or not isinstance(body.get("product"), dict):
        return None
    return body["product"]


def per_100(nutriments):
    """Open Food Facts' per-100 g figures, in a US label's units: {label key: amount}.

    Only figures it gives as numbers ≥ 0 are kept; the rest stay unknown."""
    figures = {}
    for key, off_key in OFF_KEYS.items():
        value = (nutriments or {}).get(f"{off_key}_100g")
        if isinstance(value, bool) or not isinstance(value, (int, float)) or value < 0 or value != value:
            continue
        figures[key] = round(value * _FROM_GRAMS[_UNITS[key]], 4)
    return figures


def copy_fields(product, code):
    """The package facts of an Open Food Facts product, in label_products' product shape."""
    unit = str(product.get("serving_quantity_unit") or "").lower()
    try:
        serving = float(product.get("serving_quantity"))
    except (TypeError, ValueError):
        serving = None
    return {
        "name": str(product.get("product_name") or product.get("generic_name") or "").strip(),
        "brand": str(product.get("brands") or "").split(",")[0].strip(),
        "barcode": re.sub(r"\D", "", str(product.get("code") or code)),
        "serving_text": str(product.get("serving_size") or "").strip(),
        "serving_amount": serving if serving and serving > 0 else None,
        "serving_unit": "ml" if unit == "ml" else "g",
        "ingredients": str(product.get("ingredients_text") or "").strip(),
    }


def lookup(code):
    """Look a barcode up on Open Food Facts and keep a copy: (results, outcome).

    `results` are packaged-search results (label_products.as_result);
    `outcome` is found, missing (it hasn't the product, or it has no figures
    for it) or unreachable."""
    try:
        product = fetch(code)
    except OSError:
        return [], "unreachable"
    figures = per_100((product or {}).get("nutriments"))
    fields = copy_fields(product or {}, code)
    if not product or not figures or not fields["name"]:
        return [], "missing"
    saved = label_products.save_copy(fields, figures, data_type=OPEN_FOOD_FACTS,
                                     source="Open Food Facts (crowd-sourced)",
                                     url=PRODUCT_PAGE.format(code=fields["barcode"]))
    return [label_products.as_result(saved)], "found"
