"""Packaged foods read off a label photo (label_products.py) and their HTTP door.

The promises: a draft is kept to the known shape; saving turns per-serving
figures into per 100 g; a figure given only as a % Daily Value is left
unknown, never zero; a saved product has a negative id that fdcdb.food and
nutrition.totals read like any food, named as `labelled`; its barcode finds
it however many leading zeros are typed; and the upload route saves the
photos and hands them to a helper session without touching the products.
"""
import io
import json

import pytest

import fdcdb
import label_products
import nutrition
from routes import helpers
from tests.test_nutrition import client, conn  # noqa: F401 — fixtures

MILK = {
    "name": "Whole Milk", "brand": "H-E-B", "barcode": "041220753772",
    "serving_text": "1 cup (240mL)", "serving_amount": 240, "serving_unit": "ml",
    "nutrients": {
        "calories": {"amount": 150, "unit": "kcal"},
        "calcium": {"amount": 300, "unit": "mg"},
        "vitamin_a": {"amount": None, "unit": "mcg", "dv_percent": 10},
        "made_up": {"amount": 5, "unit": "g"},
    },
    "extra": "dropped",
}


def test_clean_draft_drops_unknown_nutrients_and_keys(data_dir):
    draft = label_products.clean_draft(MILK)
    assert (sorted(draft["nutrients"]), "extra" in draft) == (["calcium", "calories", "vitamin_a"], False)


def test_save_turns_per_serving_into_per_100(data_dir):
    product = label_products.save_product(MILK)
    assert product["per_100"] == {"calories": 62.5, "calcium": 125.0}


def test_a_dv_only_figure_stays_unknown(data_dir):
    assert "vitamin_a" not in label_products.save_product(MILK)["per_100"]


def test_saved_products_get_negative_ids_in_turn(data_dir):
    first, second = label_products.save_product(MILK), label_products.save_product(MILK)
    assert (first["id"], second["id"]) == (-1, -2)


def test_save_refuses_a_serving_without_its_metric_amount(data_dir):
    with pytest.raises(ValueError):
        label_products.save_product(dict(MILK, serving_amount=None))


def test_fdcdb_food_reads_a_label_product_by_its_negative_id(conn):
    product = label_products.save_product(MILK)
    food = fdcdb.food(conn, product["id"])
    assert (food["data_type"], food["nutrients"][1087]["amount"]) == (label_products.LABEL_PHOTO, 125.0)


def test_totals_count_a_label_product_and_name_it_labelled(conn):
    product = label_products.save_product(MILK)
    total = nutrition.totals(conn, [{"fdc_id": product["id"], "grams": 200, "label": "milk"}])["calcium"]
    assert (total["amount"], total["labelled"]) == (250.0, ["milk"])


def test_barcode_matches_with_or_without_leading_zeros(data_dir):
    label_products.save_product(MILK)
    assert [len(label_products.lookup_barcode(code)) for code in ("41220753772", "0041220753772")] == [1, 1]


def test_search_matches_word_starts_in_name_or_brand(data_dir):
    label_products.save_product(MILK)
    assert [len(label_products.search(text)) for text in ("whole mi", "h-e-b", "skim")] == [1, 1, 0]


def test_job_status_is_reading_until_the_draft_lands(data_dir):
    (label_products.labels_dir() / "label-1.jpg").write_bytes(b"x")
    before = label_products.job_status("label-1.jpg")["status"]
    label_products.draft_path("label-1.jpg").write_text(json.dumps(MILK))
    after = label_products.job_status("label-1.jpg")
    assert (before, after["status"], after["draft"]["name"]) == ("reading", "ready", "Whole Milk")


def test_job_status_refuses_a_path_that_climbs_out(data_dir):
    assert label_products.job_status("../secrets.json")["status"] == "missing"


def test_packaged_route_puts_her_label_products_first(client):
    label_products.save_product(MILK)
    foods = client.get("/api/nutrition/packaged?q=041220753772").get_json()["foods"]
    assert [f["data_type"] for f in foods] == [label_products.LABEL_PHOTO]


def test_save_route_answers_with_a_search_result(client):
    reply = client.post("/api/nutrition/label-products", json={"draft": MILK, "photo": "label-1.jpg"})
    assert (reply.status_code, reply.get_json()["food"]["fdc_id"]) == (200, -1)


def test_save_route_refuses_a_nameless_draft(client):
    assert client.post("/api/nutrition/label-products", json={"draft": dict(MILK, name="")}).status_code == 400


def test_upload_saves_the_photo_and_briefs_a_helper(client, monkeypatch):
    briefs = []
    monkeypatch.setattr(helpers, "mint_helper",
                        lambda kind, slug, brief, title, model=None: (briefs.append(brief) or ({"ok": True}, 200)))
    reply = client.post("/api/nutrition/labels", data={"photo": (io.BytesIO(b"jpeg"), "IMG.JPG"), "barcode": "0412"},
                        content_type="multipart/form-data")
    job = reply.get_json()["job"]
    assert ((label_products.labels_dir() / job).exists(), f"{job}.parsed.json" in briefs[0]) == (True, True)


def test_a_product_photo_is_served_by_its_number(client):
    (label_products.labels_dir() / "label-1.jpg").write_bytes(b"jpeg")
    client.post("/api/nutrition/label-products", json={"draft": MILK, "photo": "label-1.jpg"})
    assert client.get("/api/nutrition/label-products/1/photo").data == b"jpeg"
