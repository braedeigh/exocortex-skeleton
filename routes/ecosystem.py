"""Ecosystem routes — a map of where the things she's connected to come from.

First layer is **food**: each source is a place (or a rough region) a food or
product comes from. The sources are rows in SQL beside the foods themselves —
`sourcestore.py` owns them and explains the four honest things a source says
(transparency, precision, how the dot was placed, and where that information
came from). This file is the HTTP seam over it, plus two lookups that help
place a dot: an address geocoder and the USDA "where is this grown" assist.

    POST /api/ecosystem/source/add      {name, lat, lng, precision, radius_km,
                                         transparency, geo_source, area_kind,
                                         counties, county_detail, region_name,
                                         origin, origin_detail, origin_url,
                                         origin_date, food?, product_id?}
    POST /api/ecosystem/source/update   {id, …any of the above}
    POST /api/ecosystem/source/remove   {id} — its links go with it
    POST /api/ecosystem/link            {source_id, food | product_id}
    POST /api/ecosystem/unlink          {link_id}
    POST /api/ecosystem/request-link    {food, from?, product_id?} — queue a food
                                         to have its origin found; idempotent
    POST /api/ecosystem/request/close   {id, status: answered|withdrawn}
    POST /api/ecosystem/geocode         {address}
    POST /api/ecosystem/usda/key        {key}
    POST /api/ecosystem/usda/suggest    {name}

Reading happens through /api/data/ecosystem in server.py.
"""
from datetime import date
import os
import json
import sqlite3
import urllib.parse
import urllib.request
import urllib.error

from flask import request, jsonify

import sourcestore
import store


def _food_ref(value):
    """A food reference from JSON: numbers are ids, anything else a name."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    text = str(value).strip()
    if not text:
        return None
    return int(text) if text.isdigit() else text


def _product_ref(value):
    try:
        return int(value) if value not in (None, "") else None
    except (TypeError, ValueError):
        return None


# --- USDA NASS QuickStats "suggest region" assist ----------------------------
# QuickStats answers "where is this commodity grown/raised, by state?" for free
# (a free API key, https://quickstats.nass.usda.gov/api). We surface the top
# producing state as a rough region the user can accept or nudge. This is the
# honest regional answer — NOT the specific package's farm, which stays opaque.

USDA_API = "https://quickstats.nass.usda.gov/api/api_GET/"
# Where a person can re-run the same query by hand (the API link needs a key).
USDA_SITE = "https://quickstats.nass.usda.gov/"

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
                "unit": (r.get("unit_desc") or "").strip(),
            }
    if not by_cat:
        return None
    statistic = max(by_cat, key=lambda cat: len(by_cat[cat]))   # the most-counties statistic
    ranked = sorted(by_cat[statistic].values(), key=lambda d: d["value"], reverse=True)
    return {"counties": ranked[:limit], "year": latest, "statistic": statistic}


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

    # Add a source, and link it to a food or product when one is named.
    # The source and its link are two writes; a link that fails (an unknown
    # food) leaves the source in place and says why, rather than losing it.
    @app.route("/api/ecosystem/source/add", methods=["POST"])
    def add_ecosystem_source():
        body = request.json or {}
        fields = sourcestore.clean(body)
        if not fields["name"]:
            return jsonify({"error": "missing name"}), 400
        if fields["lat"] is None or fields["lng"] is None:
            return jsonify({"error": "missing location"}), 400
        counties = sourcestore.fips_list(body.get("counties"))
        detail = sourcestore.county_detail(body.get("county_detail"), counties)
        source_id = sourcestore.add(fields, counties, detail)
        food, product_id = _food_ref(body.get("food")), _product_ref(body.get("product_id"))
        if food is not None or product_id is not None:
            try:
                sourcestore.link(source_id, food=None if product_id else food,
                                 product_id=product_id)
            except (ValueError, sqlite3.IntegrityError) as exc:
                return jsonify({"ok": True, "id": source_id, "link_error": str(exc)})
        return jsonify({"ok": True, "id": source_id})

    # Change any of a source's fields; what isn't sent stays as it was.
    @app.route("/api/ecosystem/source/update", methods=["POST"])
    def update_ecosystem_source():
        body = request.json or {}
        fields = sourcestore.clean(body, partial=True)
        if "name" in fields and not fields["name"]:
            return jsonify({"error": "name cannot be empty"}), 400
        for key in ("lat", "lng"):
            if key in fields and fields[key] is None:
                return jsonify({"error": f"bad {key}"}), 400
        counties = detail = None
        if "counties" in body:
            counties = sourcestore.fips_list(body.get("counties"))
            detail = sourcestore.county_detail(body.get("county_detail"), counties)
        try:
            found = sourcestore.update(body.get("id"), fields, counties, detail)
        except sqlite3.IntegrityError as exc:
            return jsonify({"error": str(exc)}), 400
        if not found:
            return jsonify({"error": "not found"}), 404
        return jsonify({"ok": True})

    @app.route("/api/ecosystem/source/remove", methods=["POST"])
    def remove_ecosystem_source():
        sourcestore.remove((request.json or {}).get("id"))
        return jsonify({"ok": True})

    # Link a food (or one product) to a source — "this comes from there".
    @app.route("/api/ecosystem/link", methods=["POST"])
    def link_ecosystem_source():
        body = request.json or {}
        food, product_id = _food_ref(body.get("food")), _product_ref(body.get("product_id"))
        try:
            link_id = sourcestore.link(body.get("source_id"), food=None if product_id else food,
                                       product_id=product_id)
        except (ValueError, sqlite3.IntegrityError) as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400
        return jsonify({"ok": True, "id": link_id})

    @app.route("/api/ecosystem/unlink", methods=["POST"])
    def unlink_ecosystem_source():
        link_id = _product_ref((request.json or {}).get("link_id"))
        if link_id is None or not sourcestore.unlink(link_id):
            return jsonify({"ok": False, "error": "no such link"}), 404
        return jsonify({"ok": True})

    # Queue a food to have its origin found — the "Request linking" button.
    # Links nothing: the request waits for the research pass. Asking again
    # while one is open returns the same request.
    @app.route("/api/ecosystem/request-link", methods=["POST"])
    def request_ecosystem_link():
        body = request.json or {}
        food = _food_ref(body.get("food"))
        if food is None:
            return jsonify({"ok": False, "error": "say which food"}), 400
        try:
            request_id, food_id = sourcestore.request(
                food, asked_from=body.get("from") or "",
                product_id=_product_ref(body.get("product_id")))
        except (ValueError, sqlite3.IntegrityError) as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400
        return jsonify({"ok": True, "id": request_id, "food_id": food_id})

    # Close a request by hand: answered, or withdrawn (she no longer wants it).
    @app.route("/api/ecosystem/request/close", methods=["POST"])
    def close_ecosystem_request():
        body = request.json or {}
        try:
            closed = sourcestore.close_request(_product_ref(body.get("id")), body.get("status"))
        except ValueError as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400
        if not closed:
            return jsonify({"ok": False, "error": "no open request with that id"}), 404
        return jsonify({"ok": True})

    # --- Address geocoding (for placing an exact spot by address) ---

    @app.route("/api/ecosystem/geocode", methods=["POST"])
    def ecosystem_geocode():
        """Resolve a typed address/place to lat/lng via OpenStreetMap Nominatim.
        Proxied server-side so we send a proper User-Agent (their usage policy)
        and avoid browser CORS. Low volume / personal use."""
        body = request.json or {}
        q = (body.get("address") or "").strip()
        if not q:
            return jsonify({"ok": False, "reason": "Type an address or place first."})
        url = "https://nominatim.openstreetmap.org/search?" + urllib.parse.urlencode(
            {"q": q, "format": "json", "limit": 1}
        )
        req = urllib.request.Request(url, headers={"User-Agent": "exocortex/ecosystem (personal use)"})
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                rows = json.loads(resp.read().decode("utf-8"))
        except Exception as e:
            app.logger.warning(f"geocode failed for {q!r}: {e}")
            return jsonify({"ok": False, "reason": "Couldn't reach the geocoder — try again."})
        if not rows:
            return jsonify({"ok": False, "reason": "No place matched that — try a fuller address."})
        # Found — hand back the spot and the origin record to keep with it:
        # which service answered, what it matched, and on what day.
        top = rows[0]
        try:
            lat, lng = float(top["lat"]), float(top["lon"])
            label = top.get("display_name", "")
            return jsonify({
                "ok": True, "lat": lat, "lng": lng, "label": label,
                "origin": "geocoded",
                "origin_detail": f"OpenStreetMap Nominatim, searched “{q}”: {label}",
                "origin_url": f"https://www.openstreetmap.org/?mlat={lat}&mlon={lng}#map=13/{lat}/{lng}",
                "origin_date": date.today().isoformat(),
            })
        except (KeyError, ValueError, TypeError):
            return jsonify({"ok": False, "reason": "Geocoder returned something unexpected — try again."})

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
            # The origin record: which dataset, which figure ranked the
            # counties, and the day it was asked. The key never goes in it.
            return jsonify({
                "ok": True, "mode": "counties", "commodity": commodity,
                "counties": [c["fips"] for c in ctop["counties"]],
                "detail": ctop["counties"], "label": label, "note": note,
                "origin": "usda-nass",
                "origin_detail": (f"USDA NASS Census of Agriculture {ctop['year']} — "
                                  f"{commodity}, top {len(ctop['counties'])} counties by "
                                  f"{(ctop.get('statistic') or 'total').lower()}"),
                "origin_url": USDA_SITE,
                "origin_date": date.today().isoformat(),
            })
        # 2. Fall back to the whole-state outline where county data is suppressed.
        sug = _usda_suggestion(name, _try("STATE"))
        if sug:
            return jsonify({
                "ok": True, "mode": "state", "commodity": commodity,
                "region_name": sug["label"], "state": sug["state"],
                "lat": sug["lat"], "lng": sug["lng"],
                "label": sug["label"], "note": sug["note"],
                "origin": "usda-nass",
                "origin_detail": (f"USDA NASS Census of Agriculture 2022 — {commodity}, "
                                  f"top producing state ({sug['label']})"),
                "origin_url": USDA_SITE,
                "origin_date": date.today().isoformat(),
            })
        return jsonify({"ok": False, "reason": _usda_error_reason(last_err[0])})
