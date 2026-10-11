"""World state/province outlines (georegions.py), their route, and proposals drawn with them.

What can silently break here, worst first: a region drawn that the proposal's
words don't name (a whole state for "East Texas", the state of México for
"central Mexico", every province of a group whose members were named one by
one), a region the words do name being missed, the backfill touching a
proposal already drawn as USDA counties, and the route handing back outlines
for codes nobody asked for. The world file is a tiny stand-in.
"""
import json

import pytest
from flask import Flask

import foodstore
import georegions
import proposalstore
from routes import georegions as georegions_route
from scripts import propose_sources


def _square(x, y):
    return {"type": "Polygon", "coordinates": [[[x, y], [x + 1, y], [x + 1, y + 1], [x, y + 1], [x, y]]]}


def _feature(code, name, admin, region="", aliases=""):
    return {"type": "Feature",
            "properties": {"iso_3166_2": code, "iso_a2": code[:2], "name": name, "name_en": name,
                           "admin": admin, "region": region, "name_alt": aliases,
                           "woe_name": region or name, "gn_name": name},
            "geometry": _square(len(code), len(name))}


WORLD = [
    _feature("BO-O", "Oruro", "Bolivia"),
    _feature("BO-P", "Potosí", "Bolivia"),
    _feature("MX-MEX", "México", "Mexico"),
    _feature("MX-SIN", "Sinaloa", "Mexico"),
    _feature("US-TX", "Texas", "United States of America"),
    _feature("US-LA", "Louisiana", "United States of America"),
    _feature("PE-CAL", "Callao", "Peru", aliases="Region|Region de Callao"),
    _feature("VN-33", "Đắk Lắk", "Vietnam"),
    # Italian provinces carry their region's name as an alias (woe_name).
    _feature("IT-PR", "Parma", "Italy", region="Emilia-Romagna"),
    _feature("IT-MO", "Modena", "Italy", region="Emilia-Romagna"),
    _feature("IT-BO", "Bologna", "Italy", region="Emilia-Romagna"),
    _feature("ES-CC", "Cáceres", "Spain", region="Extremadura"),
    _feature("ES-BA", "Badajoz", "Spain", region="Extremadura"),
    _feature("XX-~", "Nowhere", "Nowhere"),
]


@pytest.fixture
def world(tmp_path, monkeypatch):
    root = tmp_path / "commons"
    (root / "natural-earth").mkdir(parents=True)
    (root / georegions.SOURCE_FILE).write_text(json.dumps({"features": WORLD}))
    monkeypatch.setenv("EXOCORTEX_COMMONS_DIR", str(root))
    georegions.build(root)
    yield root
    georegions._names.cache_clear()
    georegions._country_features.cache_clear()


def _codes(world, country, words):
    return [r["code"] for r in georegions.regions_for(country, words, root=world)]


# --- matching words to regions ---------------------------------------------------

def test_every_region_the_words_name_is_found_in_their_order(world):
    assert _codes(world, "BO", "Oruro / Potosí departments, Bolivian Altiplano") == ["BO-O", "BO-P"]


def test_accents_and_vietnamese_letters_are_folded(world):
    assert _codes(world, "VN", "Central Highlands (Dak Lak), Vietnam") == ["VN-33"]


def test_a_qualified_region_stays_unmatched(world):
    assert _codes(world, "US", "East Texas broiler belt") == []


def test_a_part_of_one_region_leaves_the_others_undrawn_too(world):
    assert _codes(world, "US", "East Texas / Louisiana salt dome belt") == []


def test_a_generic_word_alias_names_no_region(world):
    assert _codes(world, "PE", "La Libertad region, Peru") == []


def test_a_region_far_bigger_than_the_circle_is_refused(world):
    # The stand-in squares are 1° (~150 km corner to corner); a 10 km circle is far smaller.
    small = georegions.regions_for("BO", "Oruro", radius_km=10, root=world)
    large = georegions.regions_for("BO", "Oruro", radius_km=100, root=world)
    assert (small, [r["code"] for r in large]) == ([], ["BO-O"])


def test_the_country_name_never_names_a_state(world):
    assert _codes(world, "MX", "central Mexico and Sinaloa") == ["MX-SIN"]


def test_a_group_named_alone_stands_for_all_its_regions(world):
    assert sorted(_codes(world, "ES", "La Vera, Extremadura")) == ["ES-BA", "ES-CC"]


def test_a_group_whose_regions_are_named_stays_those_regions(world):
    assert _codes(world, "IT", "Emilia-Romagna (Parma, Modena)") == ["IT-PR", "IT-MO"]


def test_regions_without_a_real_code_are_left_out_of_the_build(world):
    assert not (world / georegions.DERIVED_DIR / "XX.json").exists()


# --- the route ------------------------------------------------------------------

def test_route_returns_only_the_known_codes_asked_for(world):
    app = Flask(__name__)
    georegions_route.register(app)
    body = app.test_client().get("/api/geo/regions?codes=BO-O,PE-JUN,bo-p").get_json()
    assert [f["id"] for f in body["features"]] == ["BO-O", "BO-P"]


# --- proposals drawn as regions ---------------------------------------------------

def _answer(region_name, country="BO"):
    return {"item": "food:1", "name": "Quinoa",
            "place": {"lat": -18.9, "lng": -67.1, "country": country, "region_name": region_name,
                      "precision": "area", "radius_km": 150},
            "transparency": "partial", "geo_source": "guess", "origin": "package",
            "summary": "Grown on the altiplano.", "usda_commodity": None,
            "evidence": [{"url": "https://brand.example/q", "title": "Q", "quote": "Oruro",
                          "claim": "Grown near Oruro"}]}


def test_a_proposal_naming_regions_is_saved_as_their_outlines(world, data_dir):
    food = foodstore.add_food("quinoa")
    target = {"key": f"food:{food}", "label": "quinoa", "food_id": food}
    proposal_id, _ = propose_sources.save_answer(target, _answer("Oruro / Potosí"), "", "t")
    saved = proposalstore.live(food)[0]
    assert (saved["id"], saved["area_kind"], [r["code"] for r in saved["regions"]]) == \
        (proposal_id, "state", ["BO-O", "BO-P"])


def test_backfill_draws_a_circle_proposal_but_never_a_counties_one(world, data_dir):
    food = foodstore.add_food("quinoa")
    target = {"key": f"food:{food}", "label": "quinoa", "food_id": food}
    proposal_id, _ = propose_sources.save_answer(target, _answer("somewhere unnamed"), "", "t")
    regions = [{"code": "BO-O", "name": "Oruro"}]
    first, again = proposalstore.set_regions(proposal_id, regions), proposalstore.set_regions(proposal_id, regions)
    assert (first, again, proposalstore.live(food)[0]["area_kind"]) == (True, False, "state")
