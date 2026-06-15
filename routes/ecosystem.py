"""Ecosystem routes — a map of where the things she's connected to come from.

First layer is **food**: each source is a grocery / meal-prep item traced back to
where it's actually sourced. Retail sourcing is mostly opaque, so an origin is
often only a rough *region*, not a precise farm — hence `precision` + `radius_km`,
which let a dot honestly say "somewhere in this area" rather than faking a point.

Single JSON file, fully editable through the UI (mirrors movement.json / places).

    {"sources": [
        {"id", "layer", "name", "note", "lat", "lng", "precision", "radius_km"}
    ]}

`precision` is "point" (a crisp dot) or "area" (a dot inside a soft circle of
`radius_km` km). `layer` defaults to "food" so later layers (clothing, …) can
share the same store without a migration.
"""
from flask import request, jsonify
import store
import uuid
import os
import json
import urllib.parse
import urllib.request
import urllib.error


def _load():
    return store.read("ecosystem", {"sources": []})


def _save(data):
    store.write("ecosystem", data)


def _find(data, sid):
    return next((s for s in data["sources"] if s["id"] == sid), None)


def _new_id():
    return uuid.uuid4().hex[:8]


def _coord(value, default=None):
    """Parse a lat/lng to float, or return default if blank/unparseable."""
    if value is None or value == "":
        return default
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _precision(value):
    return "area" if str(value).strip().lower() == "area" else "point"


# How disclosed an origin is — the "Proper" axis, distinct from precision.
# disclosed = named/certified/confirmed · partial = country known (e.g. COOL) but
# not the farm · opaque = nothing disclosed · unrated = not yet researched.
_TX_LEVELS = ("disclosed", "partial", "opaque", "unrated")


def _transparency(value):
    v = str(value or "").strip().lower()
    return v if v in _TX_LEVELS else "unrated"


# An "area" source can be drawn as a soft circle, as real county outlines (USDA),
# or as a whole-state outline. counties = list of 5-digit FIPS; region_name = a
# US state name for the state outline.
_AREA_KINDS = ("circle", "counties", "state")


def _area_kind(value):
    v = str(value or "").strip().lower()
    return v if v in _AREA_KINDS else "circle"


def _fips_list(value):
    if not isinstance(value, list):
        return []
    out = []
    for x in value:
        s = str(x).strip()
        if s.isdigit() and len(s) <= 5:
            out.append(s.zfill(5))
    return out


def _radius(value):
    try:
        return max(0.0, float(value))
    except (TypeError, ValueError):
        return 0.0


# --- USDA NASS QuickStats "suggest region" assist ----------------------------
# QuickStats answers "where is this commodity grown/raised, by state?" for free
# (a free API key, https://quickstats.nass.usda.gov/api). We surface the top
# producing state as a rough region the user can accept or nudge. This is the
# honest regional answer — NOT the specific package's farm, which stays opaque.

USDA_API = "https://quickstats.nass.usda.gov/api/api_GET/"

# Map words in a food's name → a QuickStats `commodity_desc`. First keyword that
# appears in the name wins. Items with no US survey data (e.g. quinoa) simply
# return no match, which is the truthful outcome.
USDA_SYNONYMS = [
    ("sweet potato", "SWEET POTATOES"),
    ("potato", "POTATOES"),
    ("rice", "RICE"),
    ("beef", "CATTLE"), ("chuck", "CATTLE"), ("steak", "CATTLE"),
    ("cattle", "CATTLE"), ("roast", "CATTLE"),
    ("chicken", "CHICKENS"), ("poultry", "CHICKENS"), ("broiler", "CHICKENS"),
    ("egg", "CHICKENS"),          # eggs are reported under CHICKENS
    ("milk", "MILK"), ("dairy", "MILK"),
    ("kale", "KALE"),
    ("broccoli", "BROCCOLI"),
    ("onion", "ONIONS"),
    ("spinach", "SPINACH"),
    ("lettuce", "LETTUCE"),
    ("tomato", "TOMATOES"),
    ("carrot", "CARROTS"),
    ("corn", "CORN"), ("wheat", "WHEAT"), ("soybean", "SOYBEANS"),
    ("apple", "APPLES"), ("orange", "ORANGES"), ("almond", "ALMONDS"),
]

# Rough geographic centroids for US states (QuickStats `state_name`, uppercase).
STATE_CENTROIDS = {
    "ALABAMA": [32.8, -86.8], "ALASKA": [64.2, -149.5], "ARIZONA": [34.3, -111.7],
    "ARKANSAS": [34.9, -92.4], "CALIFORNIA": [37.2, -119.5], "COLORADO": [39.0, -105.5],
    "CONNECTICUT": [41.6, -72.7], "DELAWARE": [39.0, -75.5], "FLORIDA": [28.6, -82.4],
    "GEORGIA": [32.6, -83.4], "HAWAII": [20.3, -156.4], "IDAHO": [44.4, -114.6],
    "ILLINOIS": [40.0, -89.2], "INDIANA": [39.9, -86.3], "IOWA": [42.0, -93.5],
    "KANSAS": [38.5, -98.3], "KENTUCKY": [37.5, -85.3], "LOUISIANA": [31.0, -92.0],
    "MAINE": [45.4, -69.2], "MARYLAND": [39.0, -76.8], "MASSACHUSETTS": [42.3, -71.8],
    "MICHIGAN": [44.3, -85.4], "MINNESOTA": [46.3, -94.3], "MISSISSIPPI": [32.7, -89.7],
    "MISSOURI": [38.4, -92.5], "MONTANA": [47.0, -109.6], "NEBRASKA": [41.5, -99.8],
    "NEVADA": [39.3, -116.6], "NEW HAMPSHIRE": [43.7, -71.6], "NEW JERSEY": [40.2, -74.7],
    "NEW MEXICO": [34.4, -106.1], "NEW YORK": [42.9, -75.5], "NORTH CAROLINA": [35.6, -79.4],
    "NORTH DAKOTA": [47.4, -100.5], "OHIO": [40.3, -82.8], "OKLAHOMA": [35.6, -97.5],
    "OREGON": [43.9, -120.6], "PENNSYLVANIA": [40.9, -77.8], "RHODE ISLAND": [41.7, -71.6],
    "SOUTH CAROLINA": [33.9, -80.9], "SOUTH DAKOTA": [44.4, -100.2], "TENNESSEE": [35.9, -86.4],
    "TEXAS": [31.5, -99.3], "UTAH": [39.3, -111.7], "VERMONT": [44.1, -72.7],
    "VIRGINIA": [37.5, -78.9], "WASHINGTON": [47.4, -120.5], "WEST VIRGINIA": [38.6, -80.6],
    "WISCONSIN": [44.6, -89.9], "WYOMING": [43.0, -107.5],
}


def _usda_key():
    cfg = store.read("ecosystem_config", {})
    return (cfg.get("usda_key") or os.environ.get("EXOCORTEX_USDA_KEY") or "").strip()


def _usda_commodity(name):
    """Best-effort map a food name to a QuickStats commodity_desc, or None."""
    low = (name or "").lower()
    for kw, commodity in USDA_SYNONYMS:
        if kw in low:
            return commodity
    return None


def _usda_fetch(commodity, key, level="STATE"):
    """Hit QuickStats for rows of a commodity at STATE or COUNTY level. Returns a
    list of row dicts (possibly empty). Raises urllib errors on network failure.
    County data lives in the Census of Agriculture (every 5 years)."""
    params = {
        "key": key,
        "commodity_desc": commodity,
        "agg_level_desc": level,
        # Census of Agriculture, 2022, totals only. Pinning source+year+domain
        # keeps the payload bounded — without this, broad commodities (cattle)
        # blow past USDA's row cap and come back 413 Payload Too Large.
        "source_desc": "CENSUS",
        "year": "2022",
        "domain_desc": "TOTAL",
        "format": "JSON",
    }
    url = USDA_API + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": "exocortex/ecosystem"})
    with urllib.request.urlopen(req, timeout=40) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    return payload.get("data", []) if isinstance(payload, dict) else []


def _usda_fips(row):
    """5-digit county FIPS from a QuickStats row, or None. Skips the '998/999'
    combined-/other-counties pseudo-rows."""
    sf = str(row.get("state_fips_code") or "").strip()
    cc = str(row.get("county_code") or "").strip()
    if not (sf.isdigit() and cc.isdigit()):
        return None
    if int(cc) >= 900:
        return None
    return sf.zfill(2) + cc.zfill(3)


def _usda_top_counties(rows, limit=8):
    """Top producing counties from county rows. Groups by statistic category so
    we never mix units (acres vs head), takes the latest year, and returns
    {counties:[{fips,county,state,value}], year} or None."""
    if not rows:
        return None
    years = [r.get("year") for r in rows if r.get("year")]
    latest = max(years) if years else None
    # Group by statistic category (so we never mix units), and within each,
    # dedupe by FIPS — QuickStats returns several rows per county (different
    # class/practice), which otherwise put the same county in the list 3-4×.
    by_cat = {}
    for r in rows:
        if latest and r.get("year") != latest:
            continue
        fips = _usda_fips(r)
        if not fips:
            continue
        n = _usda_num(r.get("Value"))
        if n is None:
            continue
        cat = r.get("statisticcat_desc") or ""
        counties = by_cat.setdefault(cat, {})
        if fips in counties:
            counties[fips]["value"] += n
        else:
            counties[fips] = {
                "fips": fips,
                "county": (r.get("county_name") or "").title(),
                "state": (r.get("state_name") or "").title(),
                "value": n,
            }
    if not by_cat:
        return None
    best = max(by_cat.values(), key=len)              # the most-counties statistic
    ranked = sorted(best.values(), key=lambda d: d["value"], reverse=True)
    return {"counties": ranked[:limit], "year": latest}


def _usda_num(value):
    """Parse a QuickStats Value string ('1,234,567', '(D)', ' (Z) ') to float|None."""
    if value is None:
        return None
    s = str(value).replace(",", "").strip()
    try:
        return float(s)
    except ValueError:
        return None  # suppressed/withheld codes like (D), (Z), (NA)


def _usda_top_state(rows):
    """Biggest-producing state. Groups by statistic category (so we don't add
    head-count to dollars to acreage), takes the latest year, and returns
    (state_name, total) for the top state or None."""
    if not rows:
        return None
    years = [r.get("year") for r in rows if r.get("year")]
    latest = max(years) if years else None
    by_cat = {}
    for r in rows:
        if latest and r.get("year") != latest:
            continue
        st = (r.get("state_name") or "").strip().upper()
        if not st or st not in STATE_CENTROIDS:
            continue
        n = _usda_num(r.get("Value"))
        if n is None:
            continue
        cat = r.get("statisticcat_desc") or ""
        d = by_cat.setdefault(cat, {})
        d[st] = d.get(st, 0.0) + n
    if not by_cat:
        return None
    best = max(by_cat.values(), key=len)          # the most-states statistic
    top = max(best.items(), key=lambda kv: kv[1])
    return top[0], top[1]


def _usda_suggestion(name, rows):
    """Build a map suggestion (top state centroid as a ~200km region) or None."""
    top = _usda_top_state(rows)
    if not top:
        return None
    state, _ = top
    lat, lng = STATE_CENTROIDS[state]
    pretty = state.title()
    return {
        "lat": lat, "lng": lng,
        "precision": "area", "radius_km": 200,
        "state": state, "label": pretty,
        "note": f"USDA: {pretty} is a leading US producer. Regional estimate, not this item's exact source.",
    }


def _usda_error_reason(err):
    """Turn a captured (http_code, body) fetch error into a human-readable reason."""
    if not err:
        return "USDA has no usable data for this item — place it by hand."
    code, body = err
    b = (body or "").lower()
    if code == 401 or "unauthorized" in b or "invalid api key" in b:
        return "Your USDA key looks invalid — re-paste it."
    if code == 413 or "exceeds" in b or "50,000" in b or "50000" in b or "maximum" in b or "too large" in b:
        return "USDA query is too broad for this item — place it by hand."
    if "invalid query" in b or "no records" in b or "bad request" in b:
        return "USDA has no county/state data for this item — place it by hand."
    if code is None and ("timed out" in b or "timeout" in b):
        return "USDA timed out (it can be slow) — tap the button again."
    return "Couldn't reach USDA just now — try again."


def register(app):

    @app.route("/api/ecosystem/source/add", methods=["POST"])
    def add_ecosystem_source():
        body = request.json or {}
        name = (body.get("name") or "").strip()
        if not name:
            return jsonify({"error": "missing name"}), 400
        lat = _coord(body.get("lat"))
        lng = _coord(body.get("lng"))
        if lat is None or lng is None:
            return jsonify({"error": "missing location"}), 400
        precision = _precision(body.get("precision"))
        source = {
            "id": _new_id(),
            "layer": (body.get("layer") or "food").strip() or "food",
            "name": name,
            "note": (body.get("note") or "").strip(),
            "lat": lat,
            "lng": lng,
            "precision": precision,
            "radius_km": _radius(body.get("radius_km")) if precision == "area" else 0.0,
            "transparency": _transparency(body.get("transparency")),
            "area_kind": _area_kind(body.get("area_kind")),
            "counties": _fips_list(body.get("counties")),
            "region_name": (body.get("region_name") or "").strip(),
        }
        data = _load()
        data["sources"].append(source)
        _save(data)
        return jsonify({"ok": True, "id": source["id"]})

    @app.route("/api/ecosystem/source/update", methods=["POST"])
    def update_ecosystem_source():
        body = request.json or {}
        sid = body.get("id")
        data = _load()
        s = _find(data, sid)
        if not s:
            return jsonify({"error": "not found"}), 404
        if "name" in body:
            name = (body.get("name") or "").strip()
            if not name:
                return jsonify({"error": "name cannot be empty"}), 400
            s["name"] = name
        if "note" in body:
            s["note"] = (body.get("note") or "").strip()
        if "lat" in body:
            lat = _coord(body.get("lat"))
            if lat is None:
                return jsonify({"error": "bad lat"}), 400
            s["lat"] = lat
        if "lng" in body:
            lng = _coord(body.get("lng"))
            if lng is None:
                return jsonify({"error": "bad lng"}), 400
            s["lng"] = lng
        if "layer" in body:
            s["layer"] = (body.get("layer") or "food").strip() or "food"
        if "precision" in body:
            s["precision"] = _precision(body.get("precision"))
        if "radius_km" in body:
            s["radius_km"] = _radius(body.get("radius_km"))
        if "transparency" in body:
            s["transparency"] = _transparency(body.get("transparency"))
        if "area_kind" in body:
            s["area_kind"] = _area_kind(body.get("area_kind"))
        if "counties" in body:
            s["counties"] = _fips_list(body.get("counties"))
        if "region_name" in body:
            s["region_name"] = (body.get("region_name") or "").strip()
        # An area with no radius and a point with a radius are both incoherent —
        # normalise so the map renders predictably.
        if s.get("precision") == "point":
            s["radius_km"] = 0.0
        _save(data)
        return jsonify({"ok": True})

    @app.route("/api/ecosystem/source/remove", methods=["POST"])
    def remove_ecosystem_source():
        body = request.json or {}
        sid = body.get("id")
        data = _load()
        data["sources"] = [s for s in data["sources"] if s["id"] != sid]
        _save(data)
        return jsonify({"ok": True})

    # --- USDA assist ---

    @app.route("/api/ecosystem/usda/key", methods=["POST"])
    def set_usda_key():
        body = request.json or {}
        key = (body.get("key") or "").strip()
        with store.mutate("ecosystem_config", {}) as cfg:
            if key:
                cfg["usda_key"] = key
            else:
                cfg.pop("usda_key", None)
        return jsonify({"ok": True, "key_set": bool(key)})

    @app.route("/api/ecosystem/usda/suggest", methods=["POST"])
    def usda_suggest():
        body = request.json or {}
        name = (body.get("name") or "").strip()
        if not name:
            return jsonify({"ok": False, "reason": "Type the food's name first."})
        key = _usda_key()
        if not key:
            return jsonify({"ok": False, "need_key": True,
                            "reason": "Add a free USDA QuickStats key to use this."})
        commodity = _usda_commodity(name)
        if not commodity:
            return jsonify({"ok": False,
                            "reason": f"No USDA crop/livestock match for “{name}” "
                                      "(likely imported or not surveyed) — place it by hand."})
        last_err = [None]

        def _try(level):
            try:
                return _usda_fetch(commodity, key, level)
            except urllib.error.HTTPError as e:
                body = ""
                try:
                    body = e.read().decode("utf-8", "ignore")
                except Exception:
                    pass
                last_err[0] = (e.code, body[:300])
                app.logger.warning(f"USDA {level} HTTPError {e.code}: {body[:200]}")
                return []
            except Exception as e:
                last_err[0] = (None, str(e))
                app.logger.warning(f"USDA {level} fetch failed: {e}")
                return []

        # 1. Real county outlines (the precise, data-backed answer).
        ctop = _usda_top_counties(_try("COUNTY"))
        if ctop and ctop["counties"]:
            states = []
            for c in ctop["counties"]:
                if c["state"] and c["state"] not in states:
                    states.append(c["state"])
            where = ", ".join(states[:2]) + ("…" if len(states) > 2 else "")
            label = f"{len(ctop['counties'])} counties in {where}" if where else f"{len(ctop['counties'])} counties"
            note = (f"USDA: top {commodity.title()} counties (Census {ctop['year']}). "
                    "Regional estimate, not this item's exact source.")
            return jsonify({
                "ok": True, "mode": "counties", "commodity": commodity,
                "counties": [c["fips"] for c in ctop["counties"]],
                "detail": ctop["counties"], "label": label, "note": note,
            })
        # 2. Fall back to the whole-state outline where county data is suppressed.
        sug = _usda_suggestion(name, _try("STATE"))
        if sug:
            return jsonify({
                "ok": True, "mode": "state", "commodity": commodity,
                "region_name": sug["label"], "state": sug["state"],
                "lat": sug["lat"], "lng": sug["lng"],
                "label": sug["label"], "note": sug["note"],
            })
        return jsonify({"ok": False, "reason": _usda_error_reason(last_err[0])})
