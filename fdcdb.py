"""USDA FoodData Central in commons.db: what's in each food, per 100 grams.

**What this is.** FoodData Central (FDC) is USDA's food-composition database —
the numbers Cronometer and every nutrition app are built on. Two of its
datasets are kept whole in the commons (`<commons>/usda-fdc/`, brought in by
scripts/commons_fetch.py):

  foundation_food   ~470 whole foods USDA analyzed itself, with how many
                    samples were measured and their min / max / median —
                    so a number comes with its own spread
  sr_legacy_food    ~7,800 foods from the old Standard Reference, frozen in
                    2018; wider coverage, one number per nutrient, no spread

This module reads those zips into four tables in commons.db (the derived
database beside the commons files — see commonsdb.py), so the app can look up
a food without the internet:

  fdc_foods      one row per food: its FDC id, which dataset, its name, its
                 USDA category
  fdc_nutrients  FDC's nutrient list: id, name, unit (G, MG, UG, KCAL, …)
  fdc_amounts    amount of each nutrient per 100 g of each food, with the
                 sample count and min / max / median where USDA gives them
  fdc_portions   household measures ("1 cup, chopped" = 67 g) per food

Only these two datasets' own foods are kept. The Foundation zip also carries
tens of thousands of per-sample sub-rows (one per store purchase); those are
USDA's working, and the foundation row already summarizes them.

Touches: `commonsdb.py` (the connection), `commons.py` (checksums),
`nutrition.py` (reads it), `scripts/nutrient_data.py` (runs the loader),
`tests/test_fdcdb.py`. Design: docs/nutrition.md.

Prompt that produced this file: "make my own kind of like, Cronometer so I can
plug in my diet and see how to optimize it" — step 1 of the plan: "USDA
FoodData Central, downloaded whole into SQLite (through the commons), so
there's no API dependency."
"""
from contextlib import contextmanager
import csv
import io
import zipfile

import commons
import commonsdb

# The datasets this loader reads, by FDC's own data_type name.
DATASETS = ("foundation_food", "sr_legacy_food")

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
)


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
        # Read the small lookup tables first: categories and measure units.
        categories = {row["id"]: row["description"] for row in _rows(archive, "food_category.csv")}
        units = {row["id"]: row["name"] for row in _rows(archive, "measure_unit.csv")}

        # Keep only the dataset's own foods, not the per-sample sub-rows.
        foods = {}
        for row in _rows(archive, "food.csv"):
            if row["data_type"] in DATASETS and _food_id(row) is not None:
                foods[_food_id(row)] = row
        if not foods:
            raise ValueError(f"{zip_path}: no foundation or SR Legacy foods in food.csv")
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

        # Nutrient names: the newer file wins where both datasets list one.
        conn.executemany(
            "INSERT OR REPLACE INTO fdc_nutrients (id, name, unit, nutrient_nbr, rank)"
            " VALUES (?, ?, ?, ?, ?)",
            [(int(row["id"]), row["name"], row["unit_name"], row.get("nutrient_nbr") or None,
              _number(row.get("rank"))) for row in _rows(archive, "nutrient.csv")])

        # The amounts, streamed: SR Legacy's file is 36 MB and 640k rows.
        amounts = 0
        batch = []
        for row in _rows(archive, "food_nutrient.csv"):
            fdc_id = _food_id(row)
            amount = _number(row["amount"])
            if fdc_id not in foods or amount is None:
                continue
            points = _number(row.get("data_points"))
            batch.append((fdc_id, int(row["nutrient_id"]), amount,
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


def _insert_amounts(conn, batch):
    conn.executemany(
        "INSERT OR REPLACE INTO fdc_amounts (fdc_id, nutrient_id, amount, data_points, min, max, median)"
        " VALUES (?, ?, ?, ?, ?, ?, ?)", batch)
    return len(batch)


def search(conn, text, limit=20):
    """Foods whose name holds every word of `text`, Foundation foods first.

    A plain word match (each word anywhere in the name, any case), then the
    shortest names first — "Kale, raw" before "Kale, frozen, cooked, boiled,
    drained, with salt".
    """
    words = [w for w in (text or "").lower().split() if w]
    if not words:
        return []
    where = " AND ".join("lower(description) LIKE ?" for _ in words)
    rows = conn.execute(
        f"SELECT fdc_id, data_type, description, category FROM fdc_foods WHERE {where}"
        " ORDER BY data_type = 'foundation_food' DESC, length(description), description LIMIT ?",
        [f"%{w}%" for w in words] + [limit]).fetchall()
    return [{"fdc_id": r[0], "data_type": r[1], "description": r[2], "category": r[3]} for r in rows]


def food(conn, fdc_id):
    """One food with every nutrient amount (per 100 g) and its portions, or None."""
    head = conn.execute("SELECT fdc_id, data_type, description, category FROM fdc_foods WHERE fdc_id = ?",
                        (fdc_id,)).fetchone()
    if not head:
        return None
    amounts = conn.execute(
        "SELECT a.nutrient_id, n.name, n.unit, a.amount, a.data_points, a.min, a.max, a.median"
        " FROM fdc_amounts a JOIN fdc_nutrients n ON n.id = a.nutrient_id"
        " WHERE a.fdc_id = ? ORDER BY n.rank", (fdc_id,)).fetchall()
    portions = conn.execute(
        "SELECT amount, unit, description, grams FROM fdc_portions WHERE fdc_id = ? ORDER BY seq",
        (fdc_id,)).fetchall()
    return {
        "fdc_id": head[0], "data_type": head[1], "description": head[2], "category": head[3],
        "nutrients": {r[0]: {"name": r[1], "unit": r[2], "amount": r[3], "data_points": r[4],
                             "min": r[5], "max": r[6], "median": r[7]} for r in amounts},
        "portions": [{"amount": r[0], "unit": r[1], "description": r[2], "grams": r[3]} for r in portions],
    }
