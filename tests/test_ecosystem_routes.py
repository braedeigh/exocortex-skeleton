"""Behavioral tests for the Ecosystem API (routes/ecosystem.py).

The map's sources are rows in SQL (sourcestore.py), each a point on a map. A
source carries a location (lat/lng) and a `precision` — "point" (a crisp dot) or
"area" (a dot inside a soft circle of `radius_km`). These tests pin down the
CRUD + the field contracts that matter: required name + location, partial
updates, the point/area + radius normalisation, and 404s.

Same shape as test_movement_routes: a minimal app with only this blueprint, an
isolated temp data dir (via the `data_dir` fixture), read back through `store`.
"""
import json

import pytest

import store


@pytest.fixture
def client(data_dir):
    """A test client for a minimal app exposing only the ecosystem routes."""
    from flask import Flask
    from routes import ecosystem
    app = Flask(__name__)
    app.config.update(TESTING=True)
    ecosystem.register(app)
    return app.test_client()


def _post(client, path, payload):
    return client.post(path, data=json.dumps(payload), content_type="application/json")


def read_eco():
    """The map as the routes left it — read from SQL, where sources live now."""
    import sourcestore
    return {"sources": sourcestore.all_sources()}


# --- helpers to build state --------------------------------------------------

def _add(client, **fields):
    payload = {"name": fields.pop("name", "Quinoa"), "lat": fields.pop("lat", 30.0),
               "lng": fields.pop("lng", -97.0)}
    payload.update(fields)
    r = _post(client, "/api/ecosystem/source/add", payload)
    assert r.status_code == 200, r.get_json()
    return r.get_json()["id"]


def _source(client):
    return read_eco()["sources"][0]


# --- add ---------------------------------------------------------------------

def test_add_creates_with_id_and_defaults(client, data_dir):
    sid = _add(client, name="HEB chuck roast", lat=31.0, lng=-99.0)
    sources = read_eco()["sources"]
    assert len(sources) == 1
    s = sources[0]
    assert s["id"] == sid
    assert s["name"] == "HEB chuck roast"
    assert s["lat"] == 31.0 and s["lng"] == -99.0
    assert s["layer"] == "food"           # default layer
    assert s["precision"] == "point"      # default precision
    assert s["radius_km"] == 0.0          # a point carries no radius
    assert s["note"] == ""


def test_add_area_keeps_radius(client, data_dir):
    _add(client, name="Quinoa", precision="area", radius_km=300)
    s = _source(client)
    assert s["precision"] == "area"
    assert s["radius_km"] == 300.0


def test_add_point_zeroes_radius_even_if_sent(client, data_dir):
    # A precise dot can't be a fuzzy region — radius is forced to 0.
    _add(client, name="Lundberg rice", precision="point", radius_km=120)
    assert _source(client)["radius_km"] == 0.0


def test_add_requires_name(client, data_dir):
    r = _post(client, "/api/ecosystem/source/add", {"name": "  ", "lat": 30, "lng": -97})
    assert r.status_code == 400
    assert read_eco()["sources"] == []


def test_add_requires_location(client, data_dir):
    r = _post(client, "/api/ecosystem/source/add", {"name": "Kale"})
    assert r.status_code == 400
    assert read_eco()["sources"] == []


def test_add_rejects_unparseable_location(client, data_dir):
    r = _post(client, "/api/ecosystem/source/add",
              {"name": "Kale", "lat": "north", "lng": -97})
    assert r.status_code == 400
    assert read_eco()["sources"] == []


# --- update ------------------------------------------------------------------

def test_update_is_partial(client, data_dir):
    sid = _add(client, name="HEB milk", note="dairy belt", lat=32.2, lng=-98.2)
    _post(client, "/api/ecosystem/source/update", {"id": sid, "note": "Erath County dairies"})
    s = _source(client)
    assert s["note"] == "Erath County dairies"   # changed
    assert s["name"] == "HEB milk"                # untouched
    assert s["lat"] == 32.2                       # untouched


def test_update_can_move_location(client, data_dir):
    sid = _add(client, lat=30.0, lng=-97.0)
    _post(client, "/api/ecosystem/source/update", {"id": sid, "lat": 26.3, "lng": -98.2})
    s = _source(client)
    assert s["lat"] == 26.3 and s["lng"] == -98.2


def test_update_to_point_clears_radius(client, data_dir):
    sid = _add(client, precision="area", radius_km=200)
    _post(client, "/api/ecosystem/source/update", {"id": sid, "precision": "point"})
    s = _source(client)
    assert s["precision"] == "point"
    assert s["radius_km"] == 0.0          # normalised away when it becomes a point


def test_update_to_area_then_set_radius(client, data_dir):
    sid = _add(client)  # starts as a point
    _post(client, "/api/ecosystem/source/update",
          {"id": sid, "precision": "area", "radius_km": 150})
    s = _source(client)
    assert s["precision"] == "area"
    assert s["radius_km"] == 150.0


def test_update_empty_name_rejected(client, data_dir):
    sid = _add(client, name="Keep")
    r = _post(client, "/api/ecosystem/source/update", {"id": sid, "name": "  "})
    assert r.status_code == 400
    assert _source(client)["name"] == "Keep"


def test_update_unknown_404(client, data_dir):
    r = _post(client, "/api/ecosystem/source/update", {"id": "nope", "name": "X"})
    assert r.status_code == 404


# --- remove ------------------------------------------------------------------

def test_remove(client, data_dir):
    sid = _add(client)
    _post(client, "/api/ecosystem/source/remove", {"id": sid})
    assert read_eco()["sources"] == []


def test_remove_leaves_siblings(client, data_dir):
    a = _add(client, name="A")
    _add(client, name="B")
    _post(client, "/api/ecosystem/source/remove", {"id": a})
    names = [s["name"] for s in read_eco()["sources"]]
    assert names == ["B"]


# --- transparency (the Proper axis) ------------------------------------------

def test_add_defaults_transparency_unrated(client, data_dir):
    _add(client)
    assert _source(client)["transparency"] == "unrated"


def test_add_accepts_valid_transparency(client, data_dir):
    _add(client, name="HEB beef", transparency="opaque")
    assert _source(client)["transparency"] == "opaque"


def test_add_coerces_bogus_transparency_to_unrated(client, data_dir):
    _add(client, transparency="super-clear")
    assert _source(client)["transparency"] == "unrated"


def test_update_transparency(client, data_dir):
    sid = _add(client, transparency="unrated")
    _post(client, "/api/ecosystem/source/update", {"id": sid, "transparency": "disclosed"})
    assert _source(client)["transparency"] == "disclosed"


# --- geo_source (the placement axis: how the dot itself got placed) -----------

def test_add_defaults_geo_source_unrated(client, data_dir):
    _add(client)
    assert _source(client)["geo_source"] == "unrated"


def test_add_accepts_valid_geo_source(client, data_dir):
    _add(client, name="HEB milk", geo_source="proxy")
    assert _source(client)["geo_source"] == "proxy"


def test_add_coerces_bogus_geo_source_to_unrated(client, data_dir):
    # A proxy dot must never silently masquerade as a real placement — anything
    # off-vocabulary lands on "unrated", not on a confident value.
    _add(client, geo_source="definitely-the-farm")
    assert _source(client)["geo_source"] == "unrated"


def test_update_geo_source(client, data_dir):
    sid = _add(client, geo_source="unrated")
    _post(client, "/api/ecosystem/source/update", {"id": sid, "geo_source": "placed"})
    assert _source(client)["geo_source"] == "placed"


# --- USDA suggest parsing (no network — feed fixture rows) --------------------

def test_usda_top_state_picks_biggest_in_latest_year():
    from routes import ecosystem as eco
    rows = [
        {"state_name": "NORTH CAROLINA", "year": "2023", "Value": "1,000,000"},
        {"state_name": "CALIFORNIA", "year": "2023", "Value": "400,000"},
        {"state_name": "NORTH CAROLINA", "year": "2019", "Value": "9,000,000"},  # older year ignored
    ]
    assert eco._usda_top_state(rows) == ("NORTH CAROLINA", 1000000.0)


def test_usda_top_state_skips_suppressed_values():
    from routes import ecosystem as eco
    rows = [
        {"state_name": "TEXAS", "year": "2023", "Value": "(D)"},
        {"state_name": "IOWA", "year": "2023", "Value": "500"},
    ]
    assert eco._usda_top_state(rows) == ("IOWA", 500.0)


def test_usda_top_state_none_when_no_usable_rows():
    from routes import ecosystem as eco
    assert eco._usda_top_state([]) is None
    assert eco._usda_top_state([{"state_name": "MARS", "year": "2023", "Value": "5"}]) is None


def test_usda_suggestion_uses_state_centroid():
    from routes import ecosystem as eco
    rows = [{"state_name": "NORTH CAROLINA", "year": "2023", "Value": "1000"}]
    sug = eco._usda_suggestion("sweet potatoes", rows)
    assert sug["state"] == "NORTH CAROLINA"
    assert sug["precision"] == "area" and sug["radius_km"] > 0
    assert sug["lat"] == eco.STATE_CENTROIDS["NORTH CAROLINA"][0]


def test_usda_commodity_synonyms():
    from routes import ecosystem as eco
    assert eco._usda_commodity("HEB chuck roast") == "CATTLE"
    assert eco._usda_commodity("Sweet potatoes") == "SWEET POTATOES"
    assert eco._usda_commodity("HEB eggs") == "CHICKENS"
    assert eco._usda_commodity("quinoa") is None       # imported — honest no-match


def test_add_stores_county_region(client, data_dir):
    _add(client, name="Sweet potatoes", precision="area",
         area_kind="counties", counties=["37163", "37101"])
    s = _source(client)
    assert s["area_kind"] == "counties"
    assert s["counties"] == ["37163", "37101"]


def test_fips_list_pads_and_filters(client, data_dir):
    _add(client, area_kind="counties", counties=["6019", "abc", "37163", ""])
    # 4-digit padded to 5, non-digit dropped.
    assert _source(client)["counties"] == ["06019", "37163"]


def test_area_kind_coerces_bogus_to_circle(client, data_dir):
    _add(client, precision="area", area_kind="blobs")
    assert _source(client)["area_kind"] == "circle"


def test_usda_fips_builds_and_skips_combined():
    from routes import ecosystem as eco
    assert eco._usda_fips({"state_fips_code": "37", "county_code": "163"}) == "37163"
    assert eco._usda_fips({"state_fips_code": "06", "county_code": "19"}) == "06019"
    assert eco._usda_fips({"state_fips_code": "37", "county_code": "998"}) is None  # combined
    assert eco._usda_fips({"state_fips_code": "37", "county_code": "x"}) is None


def test_usda_top_counties_ranks_within_one_statistic():
    from routes import ecosystem as eco
    rows = [
        {"state_fips_code": "37", "county_code": "163", "county_name": "SAMPSON",
         "state_name": "NORTH CAROLINA", "year": "2022",
         "statisticcat_desc": "AREA HARVESTED", "Value": "9,000"},
        {"state_fips_code": "37", "county_code": "101", "county_name": "JOHNSTON",
         "state_name": "NORTH CAROLINA", "year": "2022",
         "statisticcat_desc": "AREA HARVESTED", "Value": "5,000"},
        # a different statistic (operations) — should not be mixed in
        {"state_fips_code": "37", "county_code": "127", "county_name": "NASH",
         "state_name": "NORTH CAROLINA", "year": "2022",
         "statisticcat_desc": "OPERATIONS", "Value": "12"},
    ]
    top = eco._usda_top_counties(rows)
    assert top["year"] == "2022"
    fips = [c["fips"] for c in top["counties"]]
    assert fips == ["37163", "37101"]   # ranked by acreage, ops-row excluded


def test_usda_top_counties_dedupes_by_fips():
    from routes import ecosystem as eco
    # USDA returns several rows per county (class/practice splits); they must
    # collapse to one entry per FIPS, not appear 3-4 times.
    rows = [
        {"state_fips_code": "06", "county_code": "053", "county_name": "MONTEREY",
         "state_name": "CALIFORNIA", "year": "2022", "statisticcat_desc": "AREA HARVESTED", "Value": "100"},
        {"state_fips_code": "06", "county_code": "053", "county_name": "MONTEREY",
         "state_name": "CALIFORNIA", "year": "2022", "statisticcat_desc": "AREA HARVESTED", "Value": "50"},
        {"state_fips_code": "06", "county_code": "083", "county_name": "SANTA BARBARA",
         "state_name": "CALIFORNIA", "year": "2022", "statisticcat_desc": "AREA HARVESTED", "Value": "40"},
    ]
    top = eco._usda_top_counties(rows)
    fips = [c["fips"] for c in top["counties"]]
    assert fips == ["06053", "06083"]              # Monterey once, summed (150)
    assert top["counties"][0]["value"] == 150.0


def test_usda_error_reason_messages():
    from routes import ecosystem as eco
    assert "invalid" in eco._usda_error_reason((401, "unauthorized")).lower()
    assert "broad" in eco._usda_error_reason((400, "query exceeds 50,000 records")).lower()
    assert "by hand" in eco._usda_error_reason((400, "bad request - invalid query")).lower()
    assert "timed out" in eco._usda_error_reason((None, "<urlopen error timed out>")).lower()
    assert "try again" in eco._usda_error_reason((None, "connection refused")).lower()


def test_usda_suggest_route_without_key_asks_for_one(client, data_dir):
    r = _post(client, "/api/ecosystem/usda/suggest", {"name": "rice"})
    body = r.get_json()
    assert body["ok"] is False and body.get("need_key") is True


def test_usda_key_save_and_clear(client, data_dir):
    assert _post(client, "/api/ecosystem/usda/key", {"key": "abc123"}).get_json()["key_set"] is True
    assert store.read("ecosystem_config", {})["usda_key"] == "abc123"
    # A blank key clears it.
    assert _post(client, "/api/ecosystem/usda/key", {"key": ""}).get_json()["key_set"] is False
    assert "usda_key" not in store.read("ecosystem_config", {})


# --- geocode (address → lat/lng, Nominatim mocked) ---------------------------

class _FakeResp:
    """Minimal stand-in for urlopen's context-manager response."""
    def __init__(self, payload):
        self._b = json.dumps(payload).encode("utf-8")
    def read(self):
        return self._b
    def __enter__(self):
        return self
    def __exit__(self, *a):
        return False


def test_geocode_returns_latlng(client, data_dir, monkeypatch):
    import routes.ecosystem as eco
    monkeypatch.setattr(eco.urllib.request, "urlopen",
                        lambda req, timeout=0: _FakeResp([
                            {"lat": "30.27", "lon": "-97.74", "display_name": "Austin, TX, USA"}]))
    body = _post(client, "/api/ecosystem/geocode", {"address": "Austin TX"}).get_json()
    assert body["ok"] is True
    assert body["lat"] == 30.27 and body["lng"] == -97.74
    assert "Austin" in body["label"]


def test_geocode_no_match_is_honest(client, data_dir, monkeypatch):
    import routes.ecosystem as eco
    monkeypatch.setattr(eco.urllib.request, "urlopen",
                        lambda req, timeout=0: _FakeResp([]))
    body = _post(client, "/api/ecosystem/geocode", {"address": "zzzzzz nowhere"}).get_json()
    assert body["ok"] is False and body.get("reason")


def test_geocode_blank_address_rejected(client, data_dir):
    body = _post(client, "/api/ecosystem/geocode", {"address": "   "}).get_json()
    assert body["ok"] is False
