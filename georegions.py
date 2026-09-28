"""States and provinces anywhere in the world — their outlines, and finding them in words.

**What this is.** A proposal says where a food comes from in words: "Oruro /
Potosí departments, Bolivian Altiplano", "Sinaloa / Sonora, Mexico". The map
used to draw anything outside the US as a dot with a circle round it, because
it only had US county and state outlines. This file gives it the world's
first-level regions (states, provinces, departments — "admin-1"), from Natural
Earth's public-domain 1:10m file in the commons, keyed by ISO 3166-2 code
('BO-O', 'MX-SIN', 'US-TX').

Three jobs:
  build     — split the 40 MB commons file into one small outline file per
              country plus a names index, under
              `<commons>/natural-earth/admin1/` (derived, rebuildable, not
              committed to the commons repo). `scripts/build_georegions.py`.
  match     — find the regions a place description names, using only the
              description's own words (pure; tested). Nothing is guessed that
              the words don't say.
  outlines  — the GeoJSON features for a list of codes, for the map
              (`routes/georegions.py`).

Touches: `commons.py` (where the file lives), `proposalstore.py` and
`scripts/propose_sources.py` (proposals get their regions from `match`),
`scripts/backfill_proposal_regions.py`, `routes/georegions.py`,
`tests/test_georegions.py`.

Prompt that produced this file: "admin-1 outlines for imports" — imported
foods drawn as the region they come from, not a dot.
"""
import json
import math
import re
import unicodedata
from functools import lru_cache
from pathlib import Path

import commons

SOURCE_FILE = "natural-earth/ne_10m_admin_1_states_provinces.geojson"
DERIVED_DIR = "natural-earth/admin1"
NAMES_FILE = "_names.json"

# A name this short is too easy to find inside other words ("Lak", "Ica").
_MIN_NAME_LENGTH = 4

# A region name right after one of these words is a part of that region
# ("East Texas", "northern Peru"), so drawing the whole region would claim
# more than the words do. Those stay a dot and a circle.
_QUALIFIERS = {"north", "south", "east", "west", "central", "northern", "southern",
               "eastern", "western", "coastal", "upper", "lower", "inland", "northeast",
               "northwest", "southeast", "southwest", "northeastern", "northwestern",
               "southeastern", "southwestern"}

# Words Natural Earth sometimes lists as a region's alias ('Region' for Callao)
# that name no place on their own.
_GENERIC = {"region", "regions", "province", "provinces", "state", "states", "department",
            "departments", "district", "districts", "county", "counties", "capital",
            "city", "territory", "municipality", "prefecture", "governorate"}

# A region may stand in for a circle only if it isn't far bigger than the
# circle: this many times the circle's width, measured corner to corner.
MAX_REGION_TO_CIRCLE = 3.0

# Letters NFKD doesn't take apart.
_FOLD = str.maketrans({"đ": "d", "Đ": "d", "ł": "l", "Ł": "l", "ø": "o", "Ø": "o",
                       "ß": "ss", "æ": "ae", "œ": "oe", "ı": "i"})


def normalize(text):
    """Lowercase ASCII words separated by single spaces: 'Đắk Lắk' → 'dak lak'."""
    text = unicodedata.normalize("NFKD", (text or "").translate(_FOLD))
    text = "".join(c for c in text if not unicodedata.combining(c)).lower()
    return " ".join(re.sub(r"[^a-z0-9]+", " ", text).split())


def derived_dir(root=None):
    return Path(root or commons.commons_dir()) / DERIVED_DIR


# --- build: split the world file into per-country pieces -----------------------

def _round_coordinates(value, places=3):
    """Coordinates to ~100 m, dropping repeated points — the map never needs more."""
    if isinstance(value, (int, float)):
        return round(value, places)
    if value and isinstance(value[0], (int, float)):
        return [round(v, places) for v in value]
    out = []
    for item in value:
        rounded = _round_coordinates(item, places)
        if not out or rounded != out[-1]:
            out.append(rounded)
    return out


def build(root=None):
    """Write `<commons>/natural-earth/admin1/<CC>.json` and `_names.json`.

    Returns how many regions went in. Regions without a real ISO 3166-2 code
    (Natural Earth marks some with '~' or leaves them blank) are left out."""
    root = Path(root or commons.commons_dir())
    with open(root / SOURCE_FILE, encoding="utf-8") as handle:
        world = json.load(handle)
    countries, names = {}, {}
    for feature in world["features"]:
        props = feature["properties"]
        code, country = props.get("iso_3166_2") or "", props.get("iso_a2") or ""
        if not re.fullmatch(r"[A-Z]{2}-[A-Z0-9]{1,3}", code) or code[:2] != country:
            continue
        aliases = {props.get(k) or "" for k in ("name", "name_en", "woe_name", "gn_name")}
        aliases |= set((props.get("name_alt") or "").split("|"))
        names.setdefault(country, {"country": props.get("admin") or "", "regions": []})
        names[country]["regions"].append({
            "code": code, "name": props.get("name") or code,
            "aliases": sorted(a for a in aliases if a),
            "group": props.get("region") or ""})
        countries.setdefault(country, []).append({
            "type": "Feature", "id": code,
            "properties": {"code": code, "name": props.get("name") or code},
            "geometry": {"type": feature["geometry"]["type"],
                         "coordinates": _round_coordinates(feature["geometry"]["coordinates"])}})
    out = derived_dir(root)
    out.mkdir(parents=True, exist_ok=True)
    for country, features in countries.items():
        (out / f"{country}.json").write_text(
            json.dumps({"type": "FeatureCollection", "features": features},
                       separators=(",", ":")), encoding="utf-8")
    (out / NAMES_FILE).write_text(json.dumps(names, ensure_ascii=False), encoding="utf-8")
    _names.cache_clear()
    _country_features.cache_clear()
    return sum(len(f) for f in countries.values())


# --- match: which regions a place description names ----------------------------

def _found(words, name):
    """How `name` sits in `words` as whole words: 'plain' when at least once on
    its own, 'qualified' when only ever as part of itself ('East Texas'),
    None when not at all."""
    seen = None
    for m in re.finditer(rf"(?:^| ){re.escape(name)}(?= |$)", words):
        before = words[:m.start()].split()
        if not before or before[-1] not in _QUALIFIERS:
            return "plain"
        seen = "qualified"
    return seen


def match(country, description, index):
    """The region codes `description` names within `country`, in the order
    they appear. `index` is one country's entry from the names index.

    A region is named by its own name or one of its aliases. A group name
    (Spain's 'Extremadura', Italy's 'Lombardia') stands for all its regions,
    but only when none of that group's regions is named directly — "La Vera,
    Extremadura" isn't narrowed further, "Parma … Emilia-Romagna" stays Parma.
    The country's own name never counts: 'Mexico' is also the state of
    México, and "central Mexico" means the country. And when the words name
    any region only in part ("East Texas / Louisiana"), nothing is returned:
    outlining the rest would draw a place the words don't give."""
    if not index or not description:
        return []
    words = normalize(description)
    country_name = normalize(index.get("country"))
    skip = {country_name, normalize(country)} | _GENERIC
    partial = False

    def names_in_text(names):
        nonlocal partial
        positions = []
        for name in {normalize(n) for n in names}:
            if len(name) < _MIN_NAME_LENGTH or name in skip:
                continue
            how = _found(words, name)
            if how == "plain":
                positions.append(words.find(name))
            elif how == "qualified":
                partial = True
        return min(positions) if positions else None

    # Split names into a region's own and shared ones. Natural Earth files some
    # group names as aliases of every region in the group (each Italian
    # province carries 'Emilia Romagna'), so a name shared by several regions
    # is treated as a group name, not as naming each of them.
    owners = {}
    for region in index["regions"]:
        for name in {normalize(n) for n in [region["name"], *region["aliases"]]}:
            owners.setdefault(name, set()).add(region["code"])
    groups = {}
    for region in index["regions"]:
        if region["group"]:
            groups.setdefault(normalize(region["group"]), set()).add(region["code"])
    for name, codes in owners.items():
        if len(codes) > 1:
            groups.setdefault(name, set()).update(codes)

    hits = {}
    for region in index["regions"]:
        own = [n for n in [region["name"], *region["aliases"]] if len(owners[normalize(n)]) == 1]
        at = names_in_text(own)
        if at is not None:
            hits[region["code"]] = at
    for group, codes in groups.items():
        if any(code in hits for code in codes):
            continue
        at = names_in_text([group])
        if at is not None:
            for code in codes:
                hits.setdefault(code, at)
    if partial:
        return []
    return sorted(hits, key=lambda code: (hits[code], code))


@lru_cache(maxsize=1)
def _names(root=None):
    path = derived_dir(root) / NAMES_FILE
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def regions_for(country, description, radius_km=None, root=None):
    """[{code, name}] for the regions a description names, or [] when the
    outlines haven't been built or nothing matches.

    With `radius_km` (the circle the regions would replace), regions far
    bigger than that circle are refused too: "Grand Saline, Texas" with a
    20 km circle is more exact than all of Texas, so it stays a circle."""
    country = (country or "").upper()
    index = _names(root).get(country)
    by_code = {r["code"]: r["name"] for r in (index or {}).get("regions", [])}
    codes = match(country, description, index)
    if codes and radius_km is not None:
        if radius_km <= 0 or extent_km(codes, root) > MAX_REGION_TO_CIRCLE * 2 * radius_km:
            return []
    return [{"code": code, "name": by_code[code]} for code in codes]


def _points(coordinates):
    """Every [lng, lat] pair in a Polygon or MultiPolygon's nesting."""
    if coordinates and isinstance(coordinates[0], (int, float)):
        yield coordinates
        return
    for item in coordinates:
        yield from _points(item)


def extent_km(codes, root=None):
    """How far the regions reach together, corner to corner of their bounding
    box, in km — rough (an equirectangular measure), which is all a size
    comparison needs. 0 when none of them has an outline."""
    lngs, lats = [], []
    for code in codes:
        feature = _country_features(code[:2], root).get(code)
        for lng, lat in _points(feature["geometry"]["coordinates"] if feature else []):
            lngs.append(lng)
            lats.append(lat)
    if not lats:
        return 0.0
    mid = math.radians((max(lats) + min(lats)) / 2)
    width = (max(lngs) - min(lngs)) * 111.32 * math.cos(mid)
    height = (max(lats) - min(lats)) * 110.57
    return math.hypot(width, height)


# --- outlines: the features for the map -----------------------------------------

@lru_cache(maxsize=16)
def _country_features(country, root=None):
    path = derived_dir(root) / f"{country}.json"
    if not re.fullmatch(r"[A-Z]{2}", country) or not path.exists():
        return {}
    data = json.loads(path.read_text(encoding="utf-8"))
    return {f["id"]: f for f in data["features"]}


def outlines(codes, root=None):
    """A GeoJSON FeatureCollection holding each known code's outline; unknown
    codes are left out."""
    features = []
    for code in dict.fromkeys(c.strip().upper() for c in codes if c and c.strip()):
        feature = _country_features(code[:2], root).get(code)
        if feature:
            features.append(feature)
    return {"type": "FeatureCollection", "features": features}
