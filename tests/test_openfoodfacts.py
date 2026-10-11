"""Barcodes USDA hasn't got, looked up on Open Food Facts (openfoodfacts.py).

The promises: Open Food Facts' figures, which it keeps in grams per 100 g,
come out in a US label's units; a figure it doesn't give stays unknown; a find
is kept as a local copy named as Open Food Facts', so a second scan doesn't
ask again; and a miss or an unreachable server is said as such, never saved.
No test touches the network: `fetch` is swapped for a stand-in.
"""
import io
import json
import urllib.error

import pytest

import label_products
import nutrition
import openfoodfacts
from tests.test_nutrition import client, conn  # noqa: F401 — fixtures

# H-E-B whole milk as Open Food Facts gives it (trimmed from the live record).
MILK = {
    "code": "0041220753772", "product_name": "Whole Milk", "brands": "H-E-B, HEB",
    "serving_size": "1 portion (240 ml)", "serving_quantity": 240, "serving_quantity_unit": "ml",
    "nutriments": {"energy-kcal_100g": 62.5, "fat_100g": 3.33333333333333, "sodium_100g": 0.04375,
                   "cholesterol_100g": 0.0104166666666667, "vitamin-d_100g": 0.0000012,
                   "calcium_100g": "", "salt_100g": 0.109375},
}


@pytest.fixture
def asked(monkeypatch):
    """Open Food Facts stood in by MILK; the list collects every barcode asked."""
    calls = []

    def fetch(code, timeout=6):
        calls.append(code)
        return MILK if code.lstrip("0") == "41220753772" else None
    monkeypatch.setattr(openfoodfacts, "fetch", fetch)
    return calls


def test_grams_become_a_labels_units():
    figures = openfoodfacts.per_100(MILK["nutriments"])
    assert (figures["sodium"], figures["cholesterol"], figures["vitamin_d"]) == (43.75, 10.4167, 1.2)


def test_a_figure_it_doesnt_give_stays_unknown():
    assert "calcium" not in openfoodfacts.per_100(MILK["nutriments"])


def test_a_find_is_kept_as_an_open_food_facts_copy(data_dir, asked):
    results, outcome = openfoodfacts.lookup("041220753772")
    saved = label_products.product(results[0]["fdc_id"])
    assert (outcome, saved["data_type"], saved["brand"], saved["url"]) == (
        "found", "open_food_facts", "H-E-B", "https://world.openfoodfacts.org/product/0041220753772")


def test_a_miss_saves_nothing(data_dir, asked):
    assert (openfoodfacts.lookup("000000000017"), label_products.products()) == (([], "missing"), [])


def test_an_unreachable_server_is_said_so(data_dir, monkeypatch):
    def down(code, timeout=6):
        raise OSError("no network")
    monkeypatch.setattr(openfoodfacts, "fetch", down)
    assert openfoodfacts.lookup("041220753772") == ([], "unreachable")


def test_fetch_reads_a_404_as_not_there(monkeypatch):
    def not_found(request, timeout):
        raise urllib.error.HTTPError(request.full_url, 404, "Not Found", {}, io.BytesIO(b""))
    monkeypatch.setattr(openfoodfacts.urllib.request, "urlopen", not_found)
    assert openfoodfacts.fetch("041220753772") is None


def test_fetch_reads_status_zero_as_not_there(monkeypatch):
    class Reply(io.BytesIO):
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False
    monkeypatch.setattr(openfoodfacts.urllib.request, "urlopen",
                        lambda request, timeout: Reply(json.dumps({"status": 0}).encode()))
    assert openfoodfacts.fetch("041220753772") is None


def test_packaged_route_asks_open_food_facts_once_then_finds_the_copy(client, asked):
    first = client.get("/api/nutrition/packaged?q=041220753772").get_json()
    second = client.get("/api/nutrition/packaged?q=041220753772").get_json()
    assert (first["open_food_facts"], second["open_food_facts"], len(asked),
            second["foods"][0]["data_type"]) == ("found", None, 1, "open_food_facts")


def test_packaged_route_doesnt_ask_for_a_name(client, asked):
    client.get("/api/nutrition/packaged?q=milk")
    assert asked == []


def test_a_copy_counts_as_label_figures_in_the_totals(data_dir, asked):
    results, _ = openfoodfacts.lookup("041220753772")
    assert results[0]["data_type"] in nutrition.LABEL_TYPES


def test_source_route_sends_a_copy_to_its_open_food_facts_page(client, asked):
    client.get("/api/nutrition/packaged?q=041220753772")
    reply = client.get("/api/nutrition/label-products/1/source")
    assert (reply.status_code, reply.headers["Location"]) == (
        302, "https://world.openfoodfacts.org/product/0041220753772")
