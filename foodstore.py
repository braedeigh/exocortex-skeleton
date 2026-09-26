"""The kitchen as connected rows — one row per food, and everything points at it.

**What this is.** Recipes, the grocery list, receipts, the ecosystem map and
research all name foods, and until now each typed its own string: "beef chuck
roast" in a recipe, "Chuck roast" on the list, "PRIME CHUCK ROAST BNLS" on the
receipt, "HEB chuck roast" on the map. Nothing could be joined. This module
keeps a small catalog of foods and products that those strings resolve to, so a
question like "what did this recipe cost, and where does each part come from"
becomes one query.

**The shape, in three steps.**

  food     — what a recipe asks for: "quinoa", "bone broth". Not necessarily
             raw; boxed broth is a food. `kind` also lets shampoo and foil live
             here, since they share the receipt.
  product  — one tangible thing you buy: "HEB ORG WHITE QUINOA". Belongs to a
             food. Receipts land on products; the map's sources hang off them.
             Organic or not is marked here, not on the food — the list just
             says "milk", the receipt knows which carton.
  names    — every way a food has been written (`food_names`) and every way a
             store prints a product (`receipt_names`). Matching happens here.

**Two halves, handled differently.** Her record — foods, names, products,
links, which recipe makes which food, the meal rotation — is written only by
the functions below and backed up to `food_catalog.json` after every change;
if the tables are ever empty and that file exists, it is read back in. The
derived half — recipes, recipe lines, shopping trips and lines, the grocery
list — is wiped and re-read from the kitchen's JSON collections by `rebuild()`,
resolving every name as it goes. The `receipts` table is derived too, from
the photos in the receipts folder: one row per photo, what it was read as, and
which trip and expense it became. The kitchen screens are untouched: they still
write their blobs, and a rebuild catches these rows up.

**Nothing is merged automatically.** `adopt()` makes one food per name nobody
has matched yet, which leaves duplicates ("onion", "onions") in plain sight;
`merge()` is how two become one. Guessing would hide the decision.

Touches: `sqlstore.py` (the tables, rungs 20 and 22, and two views:
food_last_price, recipe_cost), `store.py` (reads recipes / kitchen /
grocery_trips / kitchen_trips / expense_receipts / food_guide, and the photos
under store.RECEIPTS_DIR), `routes/food.py` (the HTTP
seam), `routes/sqlab.py` (lists the tables, calls rebuild), and
`tests/test_foodstore.py`.

Prompt that produced this file: "rewrite my kitchen/recipes/grocery list to
function on sql … link all the foods to the research tool … and also my
receipts and expenses. a food item would have to come from a receipt as some
item i can buy tangibly … i buy a box of bone broth so it's not just raw food
items. i basically eat the same meal prep every week. build the sql layer and
then i can play with it."
"""
from decimal import Decimal, ROUND_HALF_UP
import json
import re

import sqlstore
import store

MIRROR_FILE = "food_catalog.json"

# Kitchen categories whose items are not eaten. Used only when adopt() first
# creates a food, to give it a sensible starting kind; editable after.
NON_FOOD_CATEGORIES = {"household": "household", "pharmacy": "body"}

# The food guide's lists, mapped onto the safety column. 'inflammatory' has no
# column value of its own and is left for her to judge.
GUIDE_SAFETY = {"safe": "safe", "hurts": "hurts", "unsure": "unsure"}

# Her record, in the order a restore must insert it (parents before children).
# Each entry: table name and its columns.
_RECORD_TABLES = (
    ("foods", ("id", "name", "kind", "category", "safety", "note", "created_at")),
    ("food_names", ("name", "food_id")),
    ("products", ("id", "food_id", "name", "brand", "store", "size", "note", "organic")),
    ("receipt_names", ("store", "text", "product_id")),
    ("food_links", ("id", "food_id", "product_id", "target", "target_id", "note")),
    ("recipe_makes", ("recipe_id", "food_id")),
    ("meal_rotation", ("recipe_id", "per_week", "since", "note")),
)


def _cents(amount):
    """A float from a blob → exact integer cents (same rule as expensestore)."""
    if amount is None or amount == "":
        return None
    return int(Decimal(str(amount)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP) * 100)


# What a receipt prints for organic. Word-bounded so "ORGANIZER" isn't one.
_ORGANIC_WORDS = re.compile(r"\b(ORG|ORGANIC|ORGANICS)\b")

# The photo formats the upload routes accept.
_PHOTO_SUFFIXES = {".jpg", ".jpeg", ".png", ".heic", ".heif", ".webp", ".pdf"}


def _guess_organic(text):
    """Organic or not, read off a receipt line: 1 when it says so, else 0.

    Stores print ORG on organic items reliably, so a line without it is taken
    as not organic rather than unknown. A guess — set by hand to overrule it.
    """
    return 1 if _ORGANIC_WORDS.search(str(text or "").upper()) else 0


def _norm(name):
    """How a food name is matched: trimmed, lowercased, inner spaces collapsed."""
    return " ".join(str(name or "").split()).lower()


def _receipt_key(text):
    """How a receipt line is matched: trimmed, uppercased, spaces collapsed."""
    return " ".join(str(text or "").split()).upper()


# --- the write transaction ---------------------------------------------------

class _Write:
    """One write transaction on her record, followed by a fresh mirror.

    Every function that changes her record goes through this, so none of them
    can forget the backup: the mirror is exported after COMMIT, and only then.
    An exception inside rolls everything back and writes no mirror.
    """

    def __enter__(self):
        self.conn = sqlstore.open_db()
        sqlstore.begin_immediate(self.conn)
        return self.conn

    def __exit__(self, exc_type, exc, tb):
        try:
            if exc_type is None:
                self.conn.execute("COMMIT")
                _export_mirror(self.conn)
            else:
                self.conn.execute("ROLLBACK")
        finally:
            self.conn.close()
        return False


def _export_mirror(conn):
    """Write her record to food_catalog.json — the backup, as plain rows.

    Written with store's atomic file writer. One-way: nothing reads it back
    except _restore_if_empty, and only when the tables are empty.
    """
    out = {}
    for table, cols in _RECORD_TABLES:
        rows = conn.execute(
            f"SELECT {', '.join(cols)} FROM {table} ORDER BY 1, 2").fetchall()
        out[table] = [dict(zip(cols, r)) for r in rows]
    store.write_file(MIRROR_FILE, out)


def _restore_if_empty(conn):
    """Refill her record from the mirror when the tables have nothing in them.

    The recovery path for a lost or rebuilt exo.db: the vault's git history
    keeps food_catalog.json, and this reads it back. Does nothing when there is
    already a food, so it can never overwrite work.
    """
    if conn.execute("SELECT 1 FROM foods LIMIT 1").fetchone():
        return False
    backup = store.read(MIRROR_FILE, {})
    if not backup.get("foods"):
        return False
    for table, cols in _RECORD_TABLES:
        rows = [tuple(r.get(c) for c in cols) for r in backup.get(table) or []]
        conn.executemany(
            f"INSERT OR IGNORE INTO {table} ({', '.join(cols)})"
            f" VALUES ({', '.join('?' * len(cols))})", rows)
    return True


# --- rebuild: the derived half -----------------------------------------------

def _resolver(conn):
    """Lookups for turning written names into ids, read once per rebuild."""
    names = dict(conn.execute("SELECT name, food_id FROM food_names"))
    receipts = {
        (s, t): (pid, fid)
        for s, t, pid, fid in conn.execute(
            "SELECT r.store, r.text, r.product_id, p.food_id"
            " FROM receipt_names r JOIN products p ON p.id = r.product_id")
    }
    return names, receipts


def _refill(conn):
    """Wipe the derived tables and read them back from the kitchen blobs."""
    # Children first, so no foreign key is ever left pointing at nothing.
    for table in ("receipts", "recipe_lines", "recipes", "shopping_lines",
                  "shopping_trips", "grocery_list"):
        conn.execute(f"DELETE FROM {table}")
    names, receipts = _resolver(conn)
    counts = {"recipes": 0, "recipe_lines": 0, "trips": 0,
              "shopping_lines": 0, "grocery_list": 0, "receipts": 0}

    # Recipes and their lines, each line resolved to a food by name.
    for r in store.read("recipes.json", {"recipes": []}).get("recipes") or []:
        if not r.get("id"):
            continue
        conn.execute(
            "INSERT OR IGNORE INTO recipes (id, name, servings, prep_min, cook_min,"
            " archived, parent_id, source_url) VALUES (?,?,?,?,?,?,?,?)",
            (r["id"], r.get("name") or "", r.get("servings"), r.get("prep_min"),
             r.get("cook_min"), 1 if r.get("is_archived") else 0,
             r.get("parent_id"), r.get("source_url")))
        counts["recipes"] += 1
        for seq, line in enumerate(r.get("ingredients") or []):
            text = (line.get("item") or "").strip()
            if not text:
                continue
            conn.execute(
                "INSERT OR IGNORE INTO recipe_lines (recipe_id, seq, text, amount, note,"
                " usually_have, food_id) VALUES (?,?,?,?,?,?,?)",
                (r["id"], seq, text, line.get("qty"), line.get("note") or None,
                 1 if line.get("stocking_status") == "usually_have" else 0,
                 names.get(_norm(text))))
            counts["recipe_lines"] += 1

    # Which expense each receipt photo belongs to, for trips that predate the
    # expense_id being stamped on the trip itself.
    expense_by_photo = {
        (v or {}).get("filename"): eid
        for eid, v in (store.read("expense_receipts.json", {}) or {}).items()
        if isinstance(v, dict)
    }

    # Shopping trips: grocery_trips carries line items; kitchen_trips only
    # totals. A kitchen trip on the same date and store as a grocery trip is
    # the same trip told twice, so it is only added when it has no twin.
    trips = list(store.read("grocery_trips.json", {"trips": []}).get("trips") or [])
    seen = {(t.get("date"), _receipt_key(t.get("store"))) for t in trips}
    for t in store.read("kitchen_trips.json", {"trips": []}).get("trips") or []:
        if (t.get("date"), _receipt_key(t.get("store"))) not in seen:
            trips.append(t)
    trips.sort(key=lambda t: t.get("date") or "")
    # The same receipt imported twice is one trip, not two.
    seen_receipts = set()
    for t in trips:
        receipt = t.get("receipt")
        if receipt:
            if receipt in seen_receipts:
                continue
            seen_receipts.add(receipt)
        photo = receipt.rsplit("/", 1)[-1] if receipt else None
        cur = conn.execute(
            "INSERT INTO shopping_trips (date, store, total_cents, saved_cents, units,"
            " receipt, expense_id) VALUES (?,?,?,?,?,?,?)",
            (t.get("date") or "", t.get("store"), _cents(t.get("total")),
             _cents(t.get("saved")), t.get("items"), receipt,
             t.get("expense_id") or expense_by_photo.get(photo)))
        counts["trips"] += 1
        store_key = _receipt_key(t.get("store"))
        for seq, line in enumerate(t.get("line_items") or []):
            text = _receipt_key(line.get("name"))
            picked = (line.get("catalog_name") or "").strip() or None
            # Product from the receipt's own text; food from the product, or
            # failing that from the name she picked at import.
            product_id, food_id = receipts.get((store_key, text), (None, None))
            if food_id is None and picked:
                food_id = names.get(_norm(picked))
            conn.execute(
                "INSERT INTO shopping_lines (trip_id, seq, text, qty, price_cents,"
                " picked_name, product_id, food_id) VALUES (?,?,?,?,?,?,?,?)",
                (cur.lastrowid, seq, text, line.get("qty"), _cents(line.get("price")),
                 picked, product_id, food_id))
            counts["shopping_lines"] += 1

    counts["receipts"] = _fill_receipts(conn, expense_by_photo)

    # The grocery list as it stands right now.
    for seq, item in enumerate(store.read("kitchen.json", {}).get("items") or []):
        text = (item.get("name") or "").strip()
        if not text:
            continue
        conn.execute(
            "INSERT INTO grocery_list (seq, text, amount, category, checked, food_id)"
            " VALUES (?,?,?,?,?,?)",
            (seq, text, item.get("note") or None, item.get("category"),
             1 if item.get("checked") else 0, names.get(_norm(text))))
        counts["grocery_list"] += 1
    return counts


def _fill_receipts(conn, expense_by_photo):
    """One row per receipt photo in the receipts folder, with what it became.

    Top-level photos came in through the Money tab, grocery/ ones through the
    Kitchen tab's scan button. A sibling `<photo>.parsed.json` means it has
    been read; a `<photo>.parsed.imported` marker means it became a trip.
    """
    root = store.RECEIPTS_DIR
    if not root.is_dir():
        return 0
    trip_by_path = dict(conn.execute(
        "SELECT receipt, id FROM shopping_trips WHERE receipt IS NOT NULL"))
    expense_by_path = dict(conn.execute(
        "SELECT receipt, expense_id FROM shopping_trips WHERE expense_id IS NOT NULL"))
    made = 0
    for photo in sorted(root.rglob("*")):
        if not photo.is_file() or photo.suffix.lower() not in _PHOTO_SUFFIXES:
            continue
        rel = photo.relative_to(root)
        path = f"receipts/{rel.as_posix()}"
        parsed = photo.with_name(photo.name + ".parsed.json")
        read = {}
        if parsed.exists():
            try:
                read = json.loads(parsed.read_text())
            except (OSError, ValueError):
                read = {}
        if photo.with_name(photo.name + ".parsed.imported").exists() or path in trip_by_path:
            status = "imported"
        elif parsed.exists():
            status = "read"
        else:
            status = "unread"
        # The upload names every file YYYY-MM-DD-…; anything else has no date.
        day = re.match(r"\d{4}-\d{2}-\d{2}", photo.name)
        conn.execute(
            "INSERT INTO receipts (path, folder, bytes, uploaded_on, store, receipt_date,"
            " total_cents, line_count, status, trip_id, expense_id)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (path, "kitchen" if len(rel.parts) > 1 else "money", photo.stat().st_size,
             day.group(0) if day else None, read.get("store"), read.get("date"),
             _cents(read.get("total")),
             len(read["line_items"]) if isinstance(read.get("line_items"), list) else None,
             status, trip_by_path.get(path),
             expense_by_path.get(path) or expense_by_photo.get(photo.name)))
        made += 1
    return made


def rebuild():
    """Re-read the derived tables from the kitchen blobs. Idempotent.

    Her record is never touched here — except that an empty catalog is first
    restored from its mirror, so a rebuild on a fresh database comes back with
    her foods rather than with every line unmatched.
    """
    conn = sqlstore.open_db()
    try:
        sqlstore.begin_immediate(conn)
        restored = _restore_if_empty(conn)
        counts = _refill(conn)
        conn.execute("COMMIT")
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    finally:
        conn.close()
    counts["restored"] = restored
    return counts


# --- adopt: a food for every name nobody has matched ------------------------

def adopt():
    """Create a food for each unmatched name, and a product for each unmatched
    receipt line. Returns what it made.

    Names come from recipe lines, the grocery list, the kitchen's catalog, the
    food guide, and the names she picked when importing receipts. Each new food
    takes its category from the kitchen catalog and its safety from the food
    guide when either has an opinion. A receipt line becomes a product under
    the food she picked for it at import. Nothing is merged — see merge().
    """
    rebuild()
    kitchen = store.read("kitchen.json", {})
    category_of = {_norm(k): v for k, v in (kitchen.get("category_map") or {}).items()}
    safety_of = {}
    for key, value in GUIDE_SAFETY.items():
        for name in (store.read("food_guide.json", {}) or {}).get(key) or []:
            safety_of[_norm(name)] = value

    made = {"foods": 0, "products": 0}
    with _Write() as conn:
        # Every written name, first spelling seen wins as the food's name.
        spellings = {}
        for (text,) in conn.execute(
                "SELECT text FROM recipe_lines UNION ALL SELECT text FROM grocery_list"
                " UNION ALL SELECT picked_name FROM shopping_lines"
                " WHERE picked_name IS NOT NULL"):
            spellings.setdefault(_norm(text), text.strip())
        for name in list(category_of) + list(safety_of):
            spellings.setdefault(name, name)
        known = {n for (n,) in conn.execute("SELECT name FROM food_names")}
        for key, written in spellings.items():
            if not key or key in known:
                continue
            category = category_of.get(key)
            cur = conn.execute(
                "INSERT INTO foods (name, kind, category, safety) VALUES (?,?,?,?)",
                (written, NON_FOOD_CATEGORIES.get(category, "food"), category,
                 safety_of.get(key)))
            conn.execute("INSERT INTO food_names (name, food_id) VALUES (?,?)",
                         (key, cur.lastrowid))
            made["foods"] += 1

        # A product per receipt text not yet recognised, under the food she
        # picked for it (first import wins if she picked differently later).
        names = dict(conn.execute("SELECT name, food_id FROM food_names"))
        for store_name, text, picked in conn.execute(
                "SELECT t.store, l.text, l.picked_name FROM shopping_lines l"
                " JOIN shopping_trips t ON t.id = l.trip_id"
                " WHERE l.product_id IS NULL ORDER BY t.date, l.seq").fetchall():
            store_key = _receipt_key(store_name)
            if conn.execute("SELECT 1 FROM receipt_names WHERE store = ? AND text = ?",
                            (store_key, text)).fetchone():
                continue
            cur = conn.execute(
                "INSERT INTO products (food_id, name, store, organic) VALUES (?,?,?,?)",
                (names.get(_norm(picked)) if picked else None, text, store_name,
                 _guess_organic(text)))
            conn.execute(
                "INSERT INTO receipt_names (store, text, product_id) VALUES (?,?,?)",
                (store_key, text, cur.lastrowid))
            made["products"] += 1

        # Organic or not for every product still unmarked, read off the
        # receipt text it was learned from. Never touches a value already set.
        for product_id, text in conn.execute(
                "SELECT p.id, COALESCE(MIN(r.text), p.name) FROM products p"
                " LEFT JOIN receipt_names r ON r.product_id = p.id"
                " WHERE p.organic IS NULL GROUP BY p.id").fetchall():
            conn.execute("UPDATE products SET organic = ? WHERE id = ?",
                         (_guess_organic(text), product_id))
            made["organic_marked"] = made.get("organic_marked", 0) + 1
    rebuild()
    return made


# --- editing her record ------------------------------------------------------

def _food_id(conn, food):
    """A food given as an id or as any name it goes by → its id, or ValueError."""
    if isinstance(food, int):
        row = conn.execute("SELECT id FROM foods WHERE id = ?", (food,)).fetchone()
    else:
        row = conn.execute("SELECT food_id FROM food_names WHERE name = ?",
                           (_norm(food),)).fetchone()
    if not row:
        raise ValueError(f"no such food: {food!r}")
    return row[0]


def add_food(name, kind="food", category=None, safety=None, note=None):
    """Create a food and file its name. Returns the new id."""
    with _Write() as conn:
        cur = conn.execute(
            "INSERT INTO foods (name, kind, category, safety, note) VALUES (?,?,?,?,?)",
            (name.strip(), kind, category, safety, note))
        conn.execute("INSERT INTO food_names (name, food_id) VALUES (?,?)",
                     (_norm(name), cur.lastrowid))
    rebuild()
    return cur.lastrowid


def update_food(food, **fields):
    """Change a food's name, kind, category, safety or note."""
    allowed = {k: v for k, v in fields.items()
               if k in ("name", "kind", "category", "safety", "note")}
    if not allowed:
        return
    with _Write() as conn:
        food_id = _food_id(conn, food)
        conn.execute(
            f"UPDATE foods SET {', '.join(k + ' = ?' for k in allowed)} WHERE id = ?",
            (*allowed.values(), food_id))
        # A renamed food answers to its new name too.
        if "name" in allowed:
            conn.execute("INSERT OR IGNORE INTO food_names (name, food_id) VALUES (?,?)",
                         (_norm(allowed["name"]), food_id))


def add_name(food, name):
    """File another way of writing a food. Moves the name if another food had it."""
    with _Write() as conn:
        food_id = _food_id(conn, food)
        conn.execute(
            "INSERT INTO food_names (name, food_id) VALUES (?,?)"
            " ON CONFLICT (name) DO UPDATE SET food_id = excluded.food_id",
            (_norm(name), food_id))
    rebuild()


def merge(keep, drop):
    """Fold one food into another: `drop`'s names, products, links and recipes
    all move to `keep`, then `drop` is deleted. The dropped food's name keeps
    working — it's one of the names that now points at `keep`."""
    with _Write() as conn:
        keep_id, drop_id = _food_id(conn, keep), _food_id(conn, drop)
        if keep_id == drop_id:
            raise ValueError("a food can't be merged into itself")
        conn.execute("UPDATE food_names SET food_id = ? WHERE food_id = ?", (keep_id, drop_id))
        conn.execute("UPDATE products SET food_id = ? WHERE food_id = ?", (keep_id, drop_id))
        conn.execute("UPDATE recipe_makes SET food_id = ? WHERE food_id = ?", (keep_id, drop_id))
        # A link keep already has would collide; OR IGNORE leaves it behind,
        # and the delete below takes it away with the dropped food.
        conn.execute("UPDATE OR IGNORE food_links SET food_id = ? WHERE food_id = ?",
                     (keep_id, drop_id))
        # Move the research tables' rows too (hazardstore.py): every number
        # about the dropped food now describes keep. A verdict keep already has
        # for the same lens and hazard wins; drop's goes with the delete below.
        conn.execute("UPDATE hazard_measures SET food_id = ? WHERE food_id = ?", (keep_id, drop_id))
        conn.execute("UPDATE OR IGNORE food_judgments SET food_id = ? WHERE food_id = ?",
                     (keep_id, drop_id))
        # Keep's judgments win; drop fills only what keep left empty.
        conn.execute(
            "UPDATE foods SET"
            "  category = COALESCE(category, (SELECT category FROM foods WHERE id = ?)),"
            "  safety = COALESCE(safety, (SELECT safety FROM foods WHERE id = ?)),"
            "  note = COALESCE(note, (SELECT note FROM foods WHERE id = ?))"
            " WHERE id = ?", (drop_id, drop_id, drop_id, keep_id))
        conn.execute("DELETE FROM foods WHERE id = ?", (drop_id,))
    rebuild()
    # The research tables keep their own backup file, and the move above
    # changed their rows; imported here because hazardstore imports this module.
    import hazardstore
    hazardstore.refresh_mirror()
    return keep_id


def add_product(food, name, brand=None, store_name=None, size=None, note=None,
                receipt_text=None, organic=None):
    """Create a product under a food, optionally with the text a receipt prints
    for it. Organic is read off the receipt text unless given. Returns the new
    product id."""
    if organic is None and receipt_text:
        organic = _guess_organic(receipt_text)
    with _Write() as conn:
        food_id = _food_id(conn, food) if food is not None else None
        cur = conn.execute(
            "INSERT INTO products (food_id, name, brand, store, size, note, organic)"
            " VALUES (?,?,?,?,?,?,?)",
            (food_id, name, brand, store_name, size, note,
             None if organic is None else int(bool(organic))))
        if receipt_text:
            conn.execute(
                "INSERT INTO receipt_names (store, text, product_id) VALUES (?,?,?)"
                " ON CONFLICT (store, text) DO UPDATE SET product_id = excluded.product_id",
                (_receipt_key(store_name), _receipt_key(receipt_text), cur.lastrowid))
    rebuild()
    return cur.lastrowid


def update_product(product_id, **fields):
    """Change a product's food, name, brand, store, size, note or organic."""
    with _Write() as conn:
        if "food" in fields:
            food = fields.pop("food")
            fields["food_id"] = _food_id(conn, food) if food is not None else None
        allowed = {k: v for k, v in fields.items()
                   if k in ("food_id", "name", "brand", "store", "size", "note", "organic")}
        if allowed:
            conn.execute(
                f"UPDATE products SET {', '.join(k + ' = ?' for k in allowed)} WHERE id = ?",
                (*allowed.values(), product_id))
    rebuild()


def link(target, target_id, food=None, product_id=None, note=None):
    """Tie a food or a product to an ecosystem source or a research entry."""
    with _Write() as conn:
        food_id = _food_id(conn, food) if food is not None else None
        conn.execute(
            "INSERT OR IGNORE INTO food_links (food_id, product_id, target, target_id, note)"
            " VALUES (?,?,?,?,?)", (food_id, product_id, target, str(target_id), note))


def unlink(link_id):
    with _Write() as conn:
        conn.execute("DELETE FROM food_links WHERE id = ?", (link_id,))


def set_makes(recipe_id, food):
    """Say which food a recipe makes (None to clear)."""
    with _Write() as conn:
        if food is None:
            conn.execute("DELETE FROM recipe_makes WHERE recipe_id = ?", (recipe_id,))
        else:
            conn.execute(
                "INSERT INTO recipe_makes (recipe_id, food_id) VALUES (?,?)"
                " ON CONFLICT (recipe_id) DO UPDATE SET food_id = excluded.food_id",
                (recipe_id, _food_id(conn, food)))


def set_rotation(recipe_id, per_week=1, since=None, note=None):
    """Put a recipe in the standing meal rotation (per_week=None takes it out)."""
    with _Write() as conn:
        if per_week is None:
            conn.execute("DELETE FROM meal_rotation WHERE recipe_id = ?", (recipe_id,))
        else:
            conn.execute(
                "INSERT INTO meal_rotation (recipe_id, per_week, since, note) VALUES (?,?,?,?)"
                " ON CONFLICT (recipe_id) DO UPDATE SET per_week = excluded.per_week,"
                " since = excluded.since, note = excluded.note",
                (recipe_id, per_week, since, note))


# --- reading -----------------------------------------------------------------

def catalog():
    """Every food with its names, products and links — the whole record, for
    the API. Rebuilt first so match counts reflect the kitchen as it is now."""
    rebuild()
    conn = sqlstore.open_db()
    try:
        foods = {
            r[0]: {"id": r[0], "name": r[1], "kind": r[2], "category": r[3],
                   "safety": r[4], "note": r[5], "names": [], "products": [],
                   "links": [], "used_in_recipes": r[6], "times_bought": r[7]}
            for r in conn.execute(
                "SELECT f.id, f.name, f.kind, f.category, f.safety, f.note,"
                "  (SELECT COUNT(DISTINCT recipe_id) FROM recipe_lines WHERE food_id = f.id),"
                "  (SELECT COUNT(*) FROM shopping_lines WHERE food_id = f.id)"
                " FROM foods f ORDER BY f.name")
        }
        for name, fid in conn.execute("SELECT name, food_id FROM food_names ORDER BY name"):
            foods[fid]["names"].append(name)
        for pid, fid, name, brand, store_name, size, organic in conn.execute(
                "SELECT id, food_id, name, brand, store, size, organic FROM products"
                " WHERE food_id IS NOT NULL ORDER BY name"):
            foods[fid]["products"].append({"id": pid, "name": name, "brand": brand,
                                           "store": store_name, "size": size,
                                           "organic": organic})
        for lid, fid, target, target_id, note in conn.execute(
                "SELECT id, food_id, target, target_id, note FROM food_links"
                " WHERE food_id IS NOT NULL"):
            foods[fid]["links"].append({"id": lid, "target": target,
                                        "target_id": target_id, "note": note})
        loose = [{"id": r[0], "name": r[1], "store": r[2]} for r in conn.execute(
            "SELECT id, name, store FROM products WHERE food_id IS NULL ORDER BY name")]
        unmatched = [r[0] for r in conn.execute(
            "SELECT DISTINCT text FROM recipe_lines WHERE food_id IS NULL"
            " UNION SELECT DISTINCT text FROM grocery_list WHERE food_id IS NULL"
            " ORDER BY 1")]
        return {"foods": list(foods.values()), "unmatched": unmatched,
                "loose_products": loose}
    finally:
        conn.close()
