"""The ecosystem map's sources as rows beside the foods — where each food comes from.

**What this is.** Every dot on the Ecosystem map is a *source*: a place (or a
rough region) a food or product comes from. Sources used to live in their own
JSON file, joined to the kitchen only by guessing from shared words. Now they
are rows in `food_sources`, right next to `foods` and `products`, and the tie
between them is a real link in `food_links` (target 'ecosystem'). So "where
does this recipe's chuck roast come from" is a walk along links, not a guess:

    recipe line → food (by any name it goes by) → the food's links, and the
    links of each product that belongs to it → source

**Four honest things about a source**, kept apart on purpose:
  transparency — how disclosed the supply chain is (disclosed/partial/opaque)
  precision    — a crisp spot, or a rough area (circle, counties, a state)
  geo_source   — how the dot got placed: placed on purpose, a USDA proxy for
                 "where this is generally grown", or a guess
  origin       — where the placement information came from (USDA NASS, a
                 geocoded address, the package, a visit…) and when, with a
                 citation. The counties USDA reported keep their numbers.

A source is her record: written only here, inside foodstore's write
transaction, so every change is also backed up to food_catalog.json.

Touches: `sqlstore.py` (the food_sources / food_source_counties tables, rung
30), `foodstore.py` (the write transaction, the backup list, name matching),
`routes/ecosystem.py` (the map's writes), `server.py` (the map's and kitchen's
data payloads), `routes/food.py` (a food's page), `scripts/migrate_ecosystem_sql.py`
(moved the old JSON in), and `tests/test_sourcestore.py`.

Prompt that produced this file: "i want it to no longer be json and be in the
sql along with other foods. i want to be able to identify where foods are from
and create profiles of any food. i want the map wired up to the sql as well and
function off of that." — then "i want to save the source origin information
like USDA or whatever in the table and display it."
"""
import uuid

import foodstore
import sqlstore
import store

# --- the vocabularies ----------------------------------------------------------
# Each mirrors a CHECK in sqlstore rung 32; the table refuses anything else.

TRANSPARENCY = ("disclosed", "partial", "opaque", "unrated")
GEO_SOURCES = ("placed", "proxy", "guess", "unrated")
AREA_KINDS = ("circle", "counties", "state")

# Where a source's placement information came from, and what each word means.
ORIGINS = {
    "usda-nass": "USDA NASS — where this commodity is grown (Census of Agriculture)",
    "geocoded": "An address, looked up on OpenStreetMap",
    "package": "The package or brand says so",
    "visit": "Seen or asked in person — a market, a farm",
    "research": "A study, article or report",
    "hand": "Placed by hand, no record behind it",
    "unknown": "Recorded before origins were kept",
}

# The columns a source row carries, in table order.
_COLUMNS = ("id", "layer", "name", "note", "lat", "lng", "precision", "radius_km",
            "area_kind", "region_name", "transparency", "geo_source",
            "origin", "origin_detail", "origin_url", "origin_date",
            "created_at", "updated_at")


# --- cleaning what comes in ---------------------------------------------------
# Each takes whatever the browser (or the old JSON) sent and returns a value
# the table accepts, or a safe default.

def coord(value, default=None):
    """A lat/lng as a float, or `default` when blank or unreadable."""
    if value is None or value == "":
        return default
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _pick(value, allowed, default):
    """Coerce a word to one of `allowed`, else `default` (case and space forgiven)."""
    word = str(value or "").strip().lower()
    return word if word in allowed else default


def precision(value):
    return "area" if str(value).strip().lower() == "area" else "point"


def transparency(value):
    return _pick(value, TRANSPARENCY, "unrated")


def geo_source(value):
    return _pick(value, GEO_SOURCES, "unrated")


def area_kind(value):
    return _pick(value, AREA_KINDS, "circle")


def origin(value):
    return _pick(value, ORIGINS, "unknown")


def radius(value):
    try:
        return max(0.0, float(value))
    except (TypeError, ValueError):
        return 0.0


def fips_list(value):
    """County codes as 5-digit strings, deduped, junk dropped, order kept."""
    if not isinstance(value, list):
        return []
    out = []
    for item in value:
        text = str(item).strip()
        if text.isdigit() and len(text) <= 5 and text.zfill(5) not in out:
            out.append(text.zfill(5))
    return out


def county_detail(value, fips):
    """What USDA said about each county, keyed by FIPS, for the counties kept.

    Accepts the suggest route's `detail` list ({fips, county, state, value,
    unit}); anything for a county not in `fips` is dropped."""
    out = {}
    for item in value if isinstance(value, list) else []:
        if not isinstance(item, dict):
            continue
        code = str(item.get("fips") or "").strip().zfill(5)
        if code not in fips:
            continue
        out[code] = {"county": str(item.get("county") or "").strip(),
                     "state": str(item.get("state") or "").strip(),
                     "value": coord(item.get("value")),
                     "unit": str(item.get("unit") or "").strip()}
    return out


def clean(body, partial=False):
    """The fields of a source from a request body, cleaned.

    `partial` keeps only the fields present (an update); otherwise every field
    gets a value (an add). Name and location are checked by the caller, since
    what to say when they're missing is the route's business."""
    cleaners = {
        "layer": lambda v: (str(v or "").strip() or "food"),
        "name": lambda v: str(v or "").strip(),
        "note": lambda v: str(v or "").strip(),
        "lat": coord, "lng": coord,
        "precision": precision, "radius_km": radius,
        "area_kind": area_kind,
        "region_name": lambda v: str(v or "").strip(),
        "transparency": transparency, "geo_source": geo_source,
        "origin": origin,
        "origin_detail": lambda v: str(v or "").strip(),
        "origin_url": lambda v: str(v or "").strip(),
        "origin_date": lambda v: str(v or "").strip()[:10],
    }
    out = {}
    for key, fn in cleaners.items():
        if key in body:
            out[key] = fn(body.get(key))
        elif not partial:
            out[key] = fn(None)
    return out


# --- writing ------------------------------------------------------------------

def _new_id():
    return uuid.uuid4().hex[:8]


def _write_counties(conn, source_id, fips, detail):
    """Replace a source's county rows with `fips`, carrying USDA's numbers."""
    conn.execute("DELETE FROM food_source_counties WHERE source_id = ?", (source_id,))
    for seq, code in enumerate(fips):
        info = detail.get(code) or {}
        conn.execute(
            "INSERT INTO food_source_counties (source_id, fips, seq, county, state, value, unit)"
            " VALUES (?,?,?,?,?,?,?)",
            (source_id, code, seq, info.get("county", ""), info.get("state", ""),
             info.get("value"), info.get("unit", "")))


def _normalise(fields):
    """Keep a source coherent: a point has no radius."""
    if fields.get("precision") == "point":
        fields["radius_km"] = 0.0


def add(fields, counties=(), detail=None, source_id=None, created_at=None):
    """Put a new source on the map. `fields` as clean() returns them. Returns its id."""
    fields = dict(fields)
    _normalise(fields)
    source_id = source_id or _new_id()
    with foodstore._Write() as conn:
        columns = ["id", *fields]
        values = [source_id, *fields.values()]
        if created_at:
            columns += ["created_at", "updated_at"]
            values += [created_at, created_at]
        conn.execute(
            f"INSERT INTO food_sources ({', '.join(columns)})"
            f" VALUES ({', '.join('?' * len(values))})", values)
        codes = fips_list(list(counties))
        _write_counties(conn, source_id, codes, detail or {})
    return source_id


def update(source_id, fields, counties=None, detail=None):
    """Change some of a source's fields. False when there's no such source.

    `counties` None leaves the county rows alone; a list replaces them (and
    `detail` supplies USDA's numbers for the new ones — kept numbers for a
    county that stays are carried over when no new detail is given)."""
    with foodstore._Write() as conn:
        row = conn.execute("SELECT precision FROM food_sources WHERE id = ?",
                           (source_id,)).fetchone()
        if not row:
            return False
        fields = dict(fields)
        fields.setdefault("precision", row[0])
        _normalise(fields)
        sets = [f"{key} = ?" for key in fields]
        sets.append("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')")
        conn.execute(f"UPDATE food_sources SET {', '.join(sets)} WHERE id = ?",
                     (*fields.values(), source_id))
        if counties is not None:
            codes = fips_list(list(counties))
            kept = {r[0]: {"county": r[1], "state": r[2], "value": r[3], "unit": r[4]}
                    for r in conn.execute(
                        "SELECT fips, county, state, value, unit FROM food_source_counties"
                        " WHERE source_id = ?", (source_id,))}
            kept.update(detail or {})
            _write_counties(conn, source_id, codes, kept)
    return True


def remove(source_id):
    """Take a source off the map, and its links with it. False when not found."""
    with foodstore._Write() as conn:
        # Links point at a source by its id as text, so no foreign key clears
        # them; delete them in the same transaction so none dangle.
        conn.execute("DELETE FROM food_links WHERE target = 'ecosystem' AND target_id = ?",
                     (source_id,))
        return conn.execute("DELETE FROM food_sources WHERE id = ?",
                            (source_id,)).rowcount > 0


def link(source_id, food=None, product_id=None, note=None):
    """Say a food (or one product of it) comes from this source. Returns the link id.

    A product link is the stronger claim — this carton, not eggs in general.
    ValueError when the source, food or product doesn't exist."""
    if (food is None) == (product_id is None):
        raise ValueError("link a food or a product, not both or neither")
    with foodstore._Write() as conn:
        if not conn.execute("SELECT 1 FROM food_sources WHERE id = ?", (source_id,)).fetchone():
            raise ValueError(f"no such source: {source_id!r}")
        food_id = foodstore._food_id(conn, food) if food is not None else None
        if product_id is not None and not conn.execute(
                "SELECT 1 FROM products WHERE id = ?", (product_id,)).fetchone():
            raise ValueError(f"no such product: {product_id!r}")
        conn.execute(
            "INSERT OR IGNORE INTO food_links (food_id, product_id, target, target_id, note)"
            " VALUES (?,?,'ecosystem',?,?)", (food_id, product_id, source_id, note))
        row = conn.execute(
            "SELECT id FROM food_links WHERE target = 'ecosystem' AND target_id = ?"
            " AND COALESCE(food_id, 0) = ? AND COALESCE(product_id, 0) = ?",
            (source_id, food_id or 0, product_id or 0)).fetchone()
    return row[0]


def unlink(link_id):
    """Remove one food↔source link. Only map links; False when not found."""
    with foodstore._Write() as conn:
        return conn.execute("DELETE FROM food_links WHERE id = ? AND target = 'ecosystem'",
                            (link_id,)).rowcount > 0


# --- reading ------------------------------------------------------------------

def _read_conn():
    return sqlstore.open_db()


def _links_by_source(conn, include_products):
    """Every map link, grouped by source id, with the food and product named.

    A product link names its food too, so a recipe asking for "eggs" finds a
    source linked only to one carton of eggs."""
    out = {}
    for lid, sid, fid, fname, pid, pname, pstore, pfid, pfname in conn.execute(
            "SELECT l.id, l.target_id, f.id, f.name, p.id, p.name, p.store, pf.id, pf.name"
            " FROM food_links l"
            " LEFT JOIN foods f ON f.id = l.food_id"
            " LEFT JOIN products p ON p.id = l.product_id"
            " LEFT JOIN foods pf ON pf.id = p.food_id"
            " WHERE l.target = 'ecosystem' ORDER BY l.id"):
        if pid is not None and not include_products:
            # The public map says which food, never which receipt line.
            entry = {"id": lid, "food_id": pfid, "food_name": pfname, "via_product": True}
        elif pid is not None:
            entry = {"id": lid, "food_id": pfid, "food_name": pfname, "product_id": pid,
                     "product_name": pname, "product_store": pstore}
        else:
            entry = {"id": lid, "food_id": fid, "food_name": fname}
        out.setdefault(sid, []).append(entry)
    return out


def _counties_by_source(conn):
    out = {}
    for sid, fips, county, state, value, unit in conn.execute(
            "SELECT source_id, fips, county, state, value, unit FROM food_source_counties"
            " ORDER BY source_id, seq"):
        out.setdefault(sid, []).append(
            {"fips": fips, "county": county, "state": state, "value": value, "unit": unit})
    return out


def _shape(row, counties, links):
    """One source as the map reads it: the row, its counties, its links."""
    source = dict(zip(_COLUMNS, row))
    detail = counties.get(source["id"], [])
    source["counties"] = [c["fips"] for c in detail]
    source["county_detail"] = detail
    source["links"] = links.get(source["id"], [])
    return source


def all_sources(include_products=True):
    """Every source on the map, oldest first."""
    conn = _read_conn()
    try:
        counties = _counties_by_source(conn)
        links = _links_by_source(conn, include_products)
        return [_shape(row, counties, links) for row in conn.execute(
            f"SELECT {', '.join(_COLUMNS)} FROM food_sources ORDER BY created_at, id")]
    finally:
        conn.close()


def get(source_id, include_products=True):
    """One source, or None."""
    return next((s for s in all_sources(include_products) if s["id"] == source_id), None)


def for_food(food_id, include_products=True):
    """The sources a food comes from: linked to it, or to any product of it."""
    return [s for s in all_sources(include_products)
            if any(link.get("food_id") == food_id for link in s["links"])]


def map_foods(include_products=True):
    """Every eaten food, with its products and the sources each is traced to —
    the map's Foods panel. Untraced foods are listed too; that's the point."""
    conn = _read_conn()
    try:
        foods = {r[0]: {"id": r[0], "name": r[1], "category": r[2], "products": [],
                        "source_ids": []}
                 for r in conn.execute(
                     "SELECT id, name, category FROM foods WHERE kind = 'food'"
                     " ORDER BY name COLLATE NOCASE")}
        if include_products:
            for pid, fid, name, store_name, organic in conn.execute(
                    "SELECT id, food_id, name, store, organic FROM products"
                    " WHERE food_id IS NOT NULL ORDER BY name"):
                if fid in foods:
                    foods[fid]["products"].append({"id": pid, "name": name,
                                                   "store": store_name, "organic": organic})
        # A food's sources: its own links plus those of its products.
        for sid, fid in conn.execute(
                "SELECT l.target_id, COALESCE(l.food_id, p.food_id) FROM food_links l"
                " LEFT JOIN products p ON p.id = l.product_id"
                " WHERE l.target = 'ecosystem'"):
            if fid in foods and sid not in foods[fid]["source_ids"]:
                foods[fid]["source_ids"].append(sid)
        return list(foods.values())
    finally:
        conn.close()


def map_recipes():
    """The live recipes, light (no instructions), each ingredient carrying the
    food it resolves to. Resolved the same way foodstore.rebuild does — by any
    name the food goes by — but read fresh, so the 5-second poll never has to
    wait on a rebuild."""
    conn = _read_conn()
    try:
        names = dict(conn.execute("SELECT n.name, f.id FROM food_names n"
                                  " JOIN foods f ON f.id = n.food_id"))
        titles = dict(conn.execute("SELECT id, name FROM foods"))
    finally:
        conn.close()
    out = []
    for recipe in store.read("recipes.json", {}).get("recipes", []):
        if recipe.get("is_archived"):
            continue
        ingredients = []
        for line in recipe.get("ingredients", []) or []:
            line = dict(line)
            food_id = names.get(foodstore._norm(line.get("item")))
            line["food_id"] = food_id
            line["food_name"] = titles.get(food_id)
            ingredients.append(line)
        out.append({"id": recipe.get("id"), "name": recipe.get("name"),
                    "ingredients": ingredients})
    return out


# --- moving the old JSON file in ----------------------------------------------

def legacy_origin(source):
    """The origin a pre-SQL source gets, from what the JSON can prove.

    County outlines only ever came from the USDA assist, so a counties source
    is marked usda-nass — but the exact query wasn't saved then, and the
    detail says so. Nothing else can be proved, so everything else is
    'unknown' rather than a guess dressed up as a record."""
    if source.get("area_kind") == "counties" and source.get("counties"):
        return ("usda-nass",
                "USDA NASS county data (Census of Agriculture) via the map's "
                "suggest button — the exact query wasn't saved before origins were kept")
    return ("unknown", "")


def adopt_legacy(legacy, apply=False):
    """Copy the old ecosystem.json sources into food_sources, ids unchanged.

    Returns one line per source saying what happened. A source already in the
    table is skipped, so running twice changes nothing. Without `apply` it
    only reports."""
    existing = {s["id"] for s in all_sources()}
    report = []
    for old in (legacy or {}).get("sources", []):
        source_id = str(old.get("id") or "").strip()
        if not source_id:
            report.append(f"skip  (no id) {old.get('name')!r}")
            continue
        if source_id in existing:
            report.append(f"have  {source_id} {old.get('name')}")
            continue
        fields = clean(old)
        if not fields["name"] or fields["lat"] is None or fields["lng"] is None:
            report.append(f"skip  {source_id} {old.get('name')!r}: no name or location")
            continue
        fields["origin"], fields["origin_detail"] = legacy_origin(old)
        counties = fips_list(old.get("counties"))
        report.append(f"{'add ' if apply else 'would add'} {source_id} {fields['name']}"
                      f" · {fields['transparency']}/{fields['geo_source']}"
                      f" · origin {fields['origin']} · {len(counties)} counties")
        if apply:
            add(fields, counties, source_id=source_id)
    return report
