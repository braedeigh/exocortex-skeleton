"""USDA FoodData Central in commons.db: what's in each food, per 100 grams.

**What this is.** FoodData Central (FDC) is USDA's food-composition database —
the numbers Cronometer and every nutrition app are built on. Three of its
datasets are kept whole in the commons (`<commons>/usda-fdc/`, brought in by
scripts/commons_fetch.py):

  foundation_food   ~470 whole foods USDA analyzed itself, with how many
                    samples were measured and their min / max / median —
                    so a number comes with its own spread
  sr_legacy_food    ~7,800 foods from the old Standard Reference, frozen in
                    2018; wider coverage, one number per nutrient, no spread
  survey_fndds_food ~5,400 foods "as eaten" from FNDDS 2021–2023 (the survey
                    database behind USDA's own diet models); every food has
                    all ~65 nutrients, because USDA estimates (imputes) the
                    ones nobody analyzed — complete, but softer

This module reads those zips into four tables in commons.db (the derived
database beside the commons files — see commonsdb.py), so the app can look up
a food without the internet:

  fdc_foods      one row per food: its FDC id, which dataset, its name, its
                 USDA category
  fdc_nutrients  FDC's nutrient list: id, name, unit (G, MG, UG, KCAL, …)
  fdc_amounts    amount of each nutrient per 100 g of each food, with the
                 sample count and min / max / median where USDA gives them
  fdc_portions   household measures ("1 cup, chopped" = 67 g) per food

Only these datasets' own foods are kept. The Foundation zip also carries
tens of thousands of per-sample sub-rows (one per store purchase); those are
USDA's working, and the foundation row already summarizes them.

**Packaged foods (Branded).** A fourth dataset, branded_food, is USDA's copy
of what manufacturers print on their labels: ~2 million rows, ~465,000
products with a barcode (GTIN/UPC). Its zip is 428 MB, so the commons keeps
it outside git (commons_fetch.py `--outside-git`). Its figures are the
LABEL's, not a lab's: usually 10–15 nutrients, rounded the way labels round
("0 g" can mean under 0.5 g). So they live apart from the lab figures:

  fdc_branded          one row per product barcode: brand, serving size,
                       ingredients as printed; the newest version of each
                       barcode only (USDA keeps every label revision)
  fdc_branded_amounts  the label's nutrients, per 100 g, as USDA derived
                       them from the per-serving label
  fdc_branded_fts      a full-text index over name + brand, for search

Products still get an fdc_foods row (data_type "branded_food"), so a meal
item can point at one like any other food; `food()` reads the label
amounts in beside the lab ones. The whole-food search and the nutrient
rankings read only the lab tables, so half a million products don't bury
"Kale, raw".

Touches: `commonsdb.py` (the connection), `commons.py` (checksums),
`nutrition.py` (reads it), `scripts/nutrient_data.py` (runs the loader),
`routes/nutrition.py` (the packaged-food search and barcode lookup),
`tests/test_fdcdb.py`. Design: docs/nutrition.md.

Prompt that produced this file: "make my own kind of like, Cronometer so I can
plug in my diet and see how to optimize it" — step 1 of the plan: "USDA
FoodData Central, downloaded whole into SQLite (through the commons), so
there's no API dependency." Packaged foods: "no packaged or branded food
support, and no barcode lookup" — "yeah sure".
"""
from contextlib import contextmanager
import csv
import io
import zipfile

import commons
import commonsdb

# The datasets this loader reads, by FDC's own data_type name.
DATASETS = ("foundation_food", "sr_legacy_food", "survey_fndds_food")

_SCHEMA = (
    "CREATE TABLE IF NOT EXISTS fdc_foods ("
    "  fdc_id INTEGER PRIMARY KEY,"
    "  data_type TEXT NOT NULL,"
    "  description TEXT NOT NULL,"
    "  category TEXT,"
    "  publication_date TEXT,"
    "  file_sha256 TEXT NOT NULL"
    ")",
    "CREATE INDEX IF NOT EXISTS fdc_foods_by_type ON fdc_foods (data_type)",
    "CREATE TABLE IF NOT EXISTS fdc_nutrients ("
    "  id INTEGER PRIMARY KEY,"
    "  name TEXT NOT NULL,"
    "  unit TEXT NOT NULL,"
    "  nutrient_nbr TEXT,"
    "  rank REAL"
    ")",
    "CREATE TABLE IF NOT EXISTS fdc_amounts ("
    "  fdc_id INTEGER NOT NULL,"
    "  nutrient_id INTEGER NOT NULL,"
    # Per 100 g of the food, in the nutrient's unit.
    "  amount REAL NOT NULL,"
    "  data_points INTEGER, min REAL, max REAL, median REAL,"
    "  PRIMARY KEY (fdc_id, nutrient_id)"
    ")",
    "CREATE TABLE IF NOT EXISTS fdc_portions ("
    "  fdc_id INTEGER NOT NULL,"
    "  seq INTEGER,"
    "  amount REAL,"
    "  unit TEXT,"
    "  description TEXT,"
    "  grams REAL NOT NULL"
    ")",
    "CREATE INDEX IF NOT EXISTS fdc_portions_by_food ON fdc_portions (fdc_id)",
    "CREATE TABLE IF NOT EXISTS fdc_branded ("
    "  fdc_id INTEGER PRIMARY KEY,"
    # The barcode as USDA prints it, and as digits with leading zeros dropped
    # (the key a scan is matched on: see barcode_keys).
    "  gtin_upc TEXT NOT NULL,"
    "  gtin TEXT NOT NULL,"
    "  brand_owner TEXT, brand_name TEXT,"
    "  serving_size REAL, serving_size_unit TEXT, household_serving TEXT,"
    "  ingredients TEXT,"
    "  available_date TEXT"
    ")",
    "CREATE INDEX IF NOT EXISTS fdc_branded_by_gtin ON fdc_branded (gtin)",
    "CREATE TABLE IF NOT EXISTS fdc_branded_amounts ("
    "  fdc_id INTEGER NOT NULL,"
    "  nutrient_id INTEGER NOT NULL,"
    # Per 100 g, from the label.
    "  amount REAL NOT NULL,"
    "  PRIMARY KEY (fdc_id, nutrient_id)"
    ") WITHOUT ROWID",
    "CREATE VIRTUAL TABLE IF NOT EXISTS fdc_branded_fts USING fts5(name, content='')",
)

BRANDED = "branded_food"


def ensure_schema(conn):
    """Add the FDC tables to a commons.db connection if they aren't there yet."""
    for statement in _SCHEMA:
        conn.execute(statement)


@contextmanager
def session(root=None):
    """A commons.db session (commonsdb.session) with the FDC tables in place."""
    with commonsdb.session(root) as conn:
        ensure_schema(conn)
        yield conn


def _number(text):
    """A CSV cell as a float, or None when blank."""
    text = (text or "").strip()
    if not text:
        return None
    try:
        return float(text)
    except ValueError:
        return None


def _food_id(row):
    """A row's fdc_id as an int, or None — a few FDC rows leave it blank."""
    text = (row.get("fdc_id") or "").strip()
    return int(text) if text.isdigit() else None


def _rows(archive, filename):
    """Read one CSV out of the zip line by line, as dicts, whatever folder it's in."""
    names = [n for n in archive.namelist() if n.rsplit("/", 1)[-1] == filename]
    if not names:
        return iter(())
    handle = archive.open(names[0])
    return csv.DictReader(io.TextIOWrapper(handle, encoding="utf-8-sig", newline=""))


def load_fdc(conn, zip_path):
    """Read one FDC CSV zip into the fdc_* tables; return counts for the log.

    Replaces what an earlier load of the same dataset wrote, so running it
    twice gives the same rows. Returns {"dataset", "foods", "amounts",
    "portions"}.
    """
    ensure_schema(conn)
    sha = commons.sha256_of(zip_path)
    with zipfile.ZipFile(zip_path) as archive:
        # The Branded zip is shaped differently: it goes through its own loader.
        if any(n.rsplit("/", 1)[-1] == "branded_food.csv" for n in archive.namelist()):
            return _load_branded(conn, archive, sha)

        # Read the small lookup tables first: categories and measure units.
        categories = {row["id"]: row["description"] for row in _rows(archive, "food_category.csv")}
        # FNDDS names its categories in its own WWEIA list instead.
        categories.update({row["wweia_food_category"]: row["wweia_food_category_description"]
                           for row in _rows(archive, "wweia_food_category.csv")})
        units = {row["id"]: row["name"] for row in _rows(archive, "measure_unit.csv")}

        # Keep only the dataset's own foods, not the per-sample sub-rows.
        foods = {}
        for row in _rows(archive, "food.csv"):
            if row["data_type"] in DATASETS and _food_id(row) is not None:
                foods[_food_id(row)] = row
        if not foods:
            raise ValueError(f"{zip_path}: none of {DATASETS} in food.csv")
        dataset = next(iter(foods.values()))["data_type"]

        # Clear this dataset's earlier load, so a re-run replaces rather than piles up.
        old = [r[0] for r in conn.execute("SELECT fdc_id FROM fdc_foods WHERE data_type = ?", (dataset,))]
        for table in ("fdc_amounts", "fdc_portions", "fdc_foods"):
            conn.executemany(f"DELETE FROM {table} WHERE fdc_id = ?", [(i,) for i in old])

        conn.executemany(
            "INSERT OR REPLACE INTO fdc_foods (fdc_id, data_type, description, category,"
            " publication_date, file_sha256) VALUES (?, ?, ?, ?, ?, ?)",
            [(fdc_id, row["data_type"], row["description"],
              categories.get(row.get("food_category_id") or ""), row.get("publication_date"), sha)
             for fdc_id, row in foods.items()])

        nutrient_rows = _load_nutrients(conn, archive)

        # Translate FNDDS's nutrient numbers into FDC nutrient ids.
        # FNDDS's food_nutrient.csv names a nutrient by its old 3-digit number
        # (301 = calcium) where the other datasets use the id (1087); each
        # number it uses belongs to exactly one id.
        by_number = {}
        if dataset == "survey_fndds_food":
            by_number = {row["nutrient_nbr"]: int(row["id"]) for row in nutrient_rows
                         if row.get("nutrient_nbr")}

        # The amounts, streamed: SR Legacy's file is 36 MB and 640k rows.
        amounts = 0
        batch = []
        for row in _rows(archive, "food_nutrient.csv"):
            fdc_id = _food_id(row)
            amount = _number(row["amount"])
            if fdc_id not in foods or amount is None:
                continue
            points = _number(row.get("data_points"))
            nutrient_id = by_number.get(row["nutrient_id"]) or int(row["nutrient_id"])
            batch.append((fdc_id, nutrient_id, amount,
                          int(points) if points is not None else None,
                          _number(row.get("min")), _number(row.get("max")), _number(row.get("median"))))
            if len(batch) >= 5000:
                amounts += _insert_amounts(conn, batch)
                batch = []
        amounts += _insert_amounts(conn, batch)

        # Household portions: "1 cup, chopped" and its gram weight.
        portions = []
        for row in _rows(archive, "food_portion.csv"):
            fdc_id = _food_id(row)
            grams = _number(row.get("gram_weight"))
            if fdc_id not in foods or not grams:
                continue
            unit = units.get(row.get("measure_unit_id") or "")
            if unit == "undetermined":
                unit = None
            words = " ".join(w for w in (row.get("portion_description"), row.get("modifier")) if w)
            portions.append((fdc_id, int(_number(row.get("seq_num")) or 0), _number(row.get("amount")),
                             unit, words or None, grams))
        conn.executemany(
            "INSERT INTO fdc_portions (fdc_id, seq, amount, unit, description, grams)"
            " VALUES (?, ?, ?, ?, ?, ?)", portions)

    return {"dataset": dataset, "foods": len(foods), "amounts": amounts, "portions": len(portions)}


def _load_nutrients(conn, archive):
    """FDC's nutrient list into fdc_nutrients; the newer file wins where two list one."""
    rows = list(_rows(archive, "nutrient.csv"))
    conn.executemany(
        "INSERT OR REPLACE INTO fdc_nutrients (id, name, unit, nutrient_nbr, rank)"
        " VALUES (?, ?, ?, ?, ?)",
        [(int(row["id"]), row["name"], row["unit_name"], row.get("nutrient_nbr") or None,
          _number(row.get("rank"))) for row in rows])
    return rows


def barcode_keys(code):
    """The keys a typed or scanned barcode is looked up by, most likely first.

    A barcode is matched as its digits with leading zeros dropped, because the
    same product is written 12 digits long on the can (UPC-A), 13 in Europe
    (EAN-13, a 0 in front) and 14 in USDA's file (GTIN-14, two 0s in front).
    Eight digits is either EAN-8 or UPC-E, the squeezed UPC on small packs;
    both are tried, UPC-E expanded back to its 12-digit UPC-A.
    """
    digits = "".join(ch for ch in str(code or "") if ch.isdigit())
    if not digits:
        return []
    keys = [digits.lstrip("0")]
    if len(digits) == 8 and digits[0] in "01":
        keys.append(_upc_e_to_a(digits).lstrip("0"))
    return [key for key in dict.fromkeys(keys) if key]


def _upc_e_to_a(code):
    """An 8-digit UPC-E expanded to its 12-digit UPC-A (GS1's zero-suppression rules)."""
    system, m, check = code[0], code[1:7], code[7]
    last = m[5]
    if last in "012":
        body = m[0:2] + last + "0000" + m[2:5]
    elif last == "3":
        body = m[0:3] + "00000" + m[3:5]
    elif last == "4":
        body = m[0:4] + "00000" + m[4]
    else:
        body = m[0:5] + "0000" + last
    return system + body + check


# Serving units as the label rows spell them (newer rows write "grm" and "mlt").
_SERVING_UNITS = {"g": "g", "grm": "g", "gm": "g", "ml": "ml", "mlt": "ml", "mg": "mg", "iu": "IU"}

# Vitamin D: FDC's IU id and its µg id. 40 IU is 1 µg by definition, so a
# label that gives only IU is converted — the one unit change the loader makes.
_VITAMIN_D_IU, _VITAMIN_D_UG = 1110, 1114


def _load_branded(conn, archive, sha):
    """Read the Branded Foods zip: the newest label of each barcode, and its nutrients.

    USDA keeps every label revision a product has had, so ~2 million rows
    hold ~465,000 barcodes. Only the newest row per barcode is kept (latest
    available_date, then modified_date, then fdc_id), and discontinued ones
    are dropped. A reload clears every branded row first, so it replaces.
    Takes a few minutes: the zip unpacks to 3 GB of CSV, read once, streamed.
    """
    nutrient_ids = {int(row["id"]) for row in _load_nutrients(conn, archive)}

    # Pick each barcode's newest label.
    newest = {}
    for row in _rows(archive, "branded_food.csv"):
        fdc_id = _food_id(row)
        keys = barcode_keys(row.get("gtin_upc"))
        if fdc_id is None or not keys or (row.get("discontinued_date") or "").strip():
            continue
        order = (row.get("available_date") or "", row.get("modified_date") or "", fdc_id)
        if keys[0] not in newest or order > newest[keys[0]][0]:
            newest[keys[0]] = (order, fdc_id, (
                row["gtin_upc"].strip(), keys[0], row.get("brand_owner") or None,
                row.get("brand_name") or None, _number(row.get("serving_size")),
                _SERVING_UNITS.get((row.get("serving_size_unit") or "").strip().lower()) or None,
                row.get("household_serving_fulltext") or None, row.get("ingredients") or None,
                row.get("available_date") or None, row.get("branded_food_category") or None))
    kept = {fdc_id: fields for _, fdc_id, fields in newest.values()}
    del newest

    # Their names, from food.csv.
    names = {}
    for row in _rows(archive, "food.csv"):
        fdc_id = _food_id(row)
        if fdc_id in kept:
            names[fdc_id] = (row.get("description") or "").strip(), row.get("publication_date")
    if not kept:
        raise ValueError("branded zip: no products with a barcode in branded_food.csv")

    # Clear the earlier branded load, so a re-run replaces rather than piles up.
    conn.execute("DELETE FROM fdc_portions WHERE fdc_id IN (SELECT fdc_id FROM fdc_branded)")
    conn.execute("DELETE FROM fdc_foods WHERE data_type = ?", (BRANDED,))
    for table in ("fdc_branded", "fdc_branded_amounts"):
        conn.execute(f"DELETE FROM {table}")
    conn.execute("DROP TABLE IF EXISTS fdc_branded_fts")
    ensure_schema(conn)

    # The products: an fdc_foods row each, the label details, the search index,
    # and the label's serving as a portion where it's given in grams.
    foods, branded, index, portions = [], [], [], []
    for fdc_id, fields in kept.items():
        gtin_upc, gtin, owner, brand, size, unit, household, ingredients, available, category = fields
        name, published = names.get(fdc_id, ("", None))
        name = name or household or gtin_upc
        foods.append((fdc_id, BRANDED, name, category, published, sha))
        branded.append((fdc_id, gtin_upc, gtin, owner, brand, size, unit, household, ingredients, available))
        index.append((fdc_id, " ".join(w for w in (name, brand, owner) if w)))
        if size and unit == "g":
            portions.append((fdc_id, 1, 1.0, "serving", household, size))
    conn.executemany("INSERT OR REPLACE INTO fdc_foods (fdc_id, data_type, description, category,"
                     " publication_date, file_sha256) VALUES (?, ?, ?, ?, ?, ?)", foods)
    conn.executemany("INSERT INTO fdc_branded VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", branded)
    conn.executemany("INSERT INTO fdc_branded_fts (rowid, name) VALUES (?, ?)", index)
    conn.executemany("INSERT INTO fdc_portions (fdc_id, seq, amount, unit, description, grams)"
                     " VALUES (?, ?, ?, ?, ?, ?)", portions)
    del foods, branded, index

    # The label nutrients, streamed: 1.5 GB of rows, most of them for older labels.
    # Plain csv rows, not dicts, and the id checked as text first: this loop is
    # most of the load time.
    kept_text = {str(fdc_id) for fdc_id in kept}
    names = [n for n in archive.namelist() if n.rsplit("/", 1)[-1] == "food_nutrient.csv"]
    reader = csv.reader(io.TextIOWrapper(archive.open(names[0]), encoding="utf-8-sig", newline=""))
    header = next(reader)
    food_col, nutrient_col, amount_col = (header.index(c) for c in ("fdc_id", "nutrient_id", "amount"))
    amounts = 0
    batch = []
    vitamin_d_iu = {}
    for row in reader:
        if row[food_col] not in kept_text:
            continue
        amount = _number(row[amount_col])
        nutrient_id = int(row[nutrient_col])
        if amount is None or nutrient_id not in nutrient_ids:
            continue
        if nutrient_id == _VITAMIN_D_IU:
            vitamin_d_iu[int(row[food_col])] = amount
        batch.append((int(row[food_col]), nutrient_id, amount))
        if len(batch) >= 20000:
            conn.executemany("INSERT OR REPLACE INTO fdc_branded_amounts VALUES (?, ?, ?)", batch)
            amounts += len(batch)
            batch = []
    conn.executemany("INSERT OR REPLACE INTO fdc_branded_amounts VALUES (?, ?, ?)", batch)
    amounts += len(batch)

    # Vitamin D given only in IU: add its µg figure (IU / 40), never over a µg one the label gave.
    conn.executemany("INSERT OR IGNORE INTO fdc_branded_amounts VALUES (?, ?, ?)",
                     [(fdc_id, _VITAMIN_D_UG, iu / 40.0) for fdc_id, iu in vitamin_d_iu.items()])
    return {"dataset": BRANDED, "foods": len(kept), "amounts": amounts, "portions": len(portions)}


def _insert_amounts(conn, batch):
    conn.executemany(
        "INSERT OR REPLACE INTO fdc_amounts (fdc_id, nutrient_id, amount, data_points, min, max, median)"
        " VALUES (?, ?, ?, ?, ?, ?, ?)", batch)
    return len(batch)


def search(conn, text, limit=20):
    """Foods whose name holds every word of `text`: Foundation, then SR Legacy, then FNDDS.

    A plain word match (each word anywhere in the name, any case), then the
    shortest names first — "Kale, raw" before "Kale, frozen, cooked, boiled,
    drained, with salt".
    """
    words = [w for w in (text or "").lower().split() if w]
    if not words:
        return []
    where = " AND ".join("lower(description) LIKE ?" for _ in words)
    # Whole foods only: packaged products have their own search (search_packaged).
    rows = conn.execute(
        f"SELECT fdc_id, data_type, description, category FROM fdc_foods"
        f" WHERE data_type IN ({','.join('?' * len(DATASETS))}) AND {where}"
        " ORDER BY CASE data_type WHEN 'foundation_food' THEN 0 WHEN 'sr_legacy_food' THEN 1 ELSE 2 END,"
        " length(description), description LIMIT ?",
        list(DATASETS) + [f"%{w}%" for w in words] + [limit]).fetchall()
    return [{"fdc_id": r[0], "data_type": r[1], "description": r[2], "category": r[3]} for r in rows]


def food(conn, fdc_id):
    """One food with every nutrient amount (per 100 g) and its portions, or None."""
    # A product read off her label photo has a negative id and lives in label_products.py, not here.
    if isinstance(fdc_id, int) and fdc_id < 0:
        import label_products
        return label_products.food(fdc_id)
    head = conn.execute("SELECT fdc_id, data_type, description, category FROM fdc_foods WHERE fdc_id = ?",
                        (fdc_id,)).fetchone()
    if not head:
        return None
    # A product's figures come from its label table; every other food's from the lab's.
    table = ("SELECT fdc_id, nutrient_id, amount, NULL AS data_points, NULL AS min, NULL AS max,"
             " NULL AS median FROM fdc_branded_amounts") if head[1] == BRANDED else "SELECT * FROM fdc_amounts"
    amounts = conn.execute(
        "SELECT a.nutrient_id, n.name, n.unit, a.amount, a.data_points, a.min, a.max, a.median"
        f" FROM ({table}) a JOIN fdc_nutrients n ON n.id = a.nutrient_id"
        " WHERE a.fdc_id = ? ORDER BY n.rank", (fdc_id,)).fetchall()
    portions = conn.execute(
        "SELECT amount, unit, description, grams FROM fdc_portions WHERE fdc_id = ? ORDER BY seq",
        (fdc_id,)).fetchall()
    return {
        "fdc_id": head[0], "data_type": head[1], "description": head[2], "category": head[3],
        "nutrients": {r[0]: {"name": r[1], "unit": r[2], "amount": r[3], "data_points": r[4],
                             "min": r[5], "max": r[6], "median": r[7]} for r in amounts},
        "portions": [{"amount": r[0], "unit": r[1], "description": r[2], "grams": r[3]} for r in portions],
        "label": _label(conn, fdc_id) if head[1] == BRANDED else None,
    }


# What a packaged product's label says besides its nutrients.
_LABEL_COLUMNS = ("gtin_upc", "brand_owner", "brand_name", "serving_size", "serving_size_unit",
                  "household_serving", "ingredients", "available_date")


def _label(conn, fdc_id):
    row = conn.execute(f"SELECT {', '.join(_LABEL_COLUMNS)} FROM fdc_branded WHERE fdc_id = ?",
                       (fdc_id,)).fetchone()
    return dict(zip(_LABEL_COLUMNS, row)) if row else None


def _packaged(conn, where, params, limit):
    """Packaged products as search results: the food's name plus its brand and serving."""
    rows = conn.execute(
        "SELECT f.fdc_id, f.description, f.category, b.gtin_upc, b.brand_owner, b.brand_name,"
        " b.serving_size, b.serving_size_unit, b.household_serving,"
        " (SELECT COUNT(*) FROM fdc_branded_amounts a WHERE a.fdc_id = f.fdc_id)"
        " FROM fdc_branded b JOIN fdc_foods f ON f.fdc_id = b.fdc_id"
        f" WHERE {where} LIMIT ?", list(params) + [limit]).fetchall()
    return [{"fdc_id": r[0], "data_type": BRANDED, "description": r[1], "category": r[2],
             "gtin_upc": r[3], "brand_owner": r[4], "brand_name": r[5], "serving_size": r[6],
             "serving_size_unit": r[7], "household_serving": r[8], "nutrient_count": r[9]} for r in rows]


def lookup_barcode(conn, code):
    """The packaged products under one barcode, typed or scanned; [] when USDA hasn't got it."""
    for key in barcode_keys(code):
        found = _packaged(conn, "b.gtin = ?", [key], 5)
        if found:
            return found
    return []


def search_packaged(conn, text, limit=20):
    """Packaged products whose name or brand holds every word (each as a word start).

    A full-text search (SQLite FTS5) over half a million names, best match first.
    """
    words = ["".join(ch for ch in w if ch.isalnum()) for w in (text or "").split()]
    words = [w for w in words if w]
    if not words:
        return []
    match = " ".join(f'"{w}"*' for w in words)
    ids = [r[0] for r in conn.execute(
        "SELECT rowid FROM fdc_branded_fts WHERE fdc_branded_fts MATCH ? ORDER BY rank LIMIT ?",
        (match, limit)).fetchall()]
    if not ids:
        return []
    found = {food["fdc_id"]: food for food in
             _packaged(conn, f"b.fdc_id IN ({','.join('?' * len(ids))})", ids, limit)}
    return [found[i] for i in ids if i in found]
