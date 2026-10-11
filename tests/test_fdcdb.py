"""FoodData Central into commons.db (fdcdb.py).

A tiny hand-built FDC zip stands in for USDA's: the loader keeps the
dataset's own foods and drops per-sample sub-rows, keeps the Foundation
min/max, skips rows with a blank food id, and a second load replaces the
first rather than piling up. Search puts Foundation foods and short names
first. An FNDDS zip names nutrients by their old number (301), which the
loader turns into the FDC id (1087), and its categories come from WWEIA.
A Branded zip keeps the newest label of each barcode, drops discontinued
ones, keeps its figures apart from the lab ones, and is found by name,
brand, or any of the ways a barcode gets written.
"""
import zipfile

import pytest

import fdcdb


def _csv(header, rows):
    lines = [",".join(f'"{h}"' for h in header)]
    lines += [",".join(f'"{c}"' for c in row) for row in rows]
    return "\n".join(lines) + "\n"


def make_zip(path, folder="FoodData_Central_foundation_food_csv_test"):
    """An FDC-shaped zip: two foundation foods, one sub-sample row, two nutrients."""
    files = {
        "food_category.csv": _csv(("id", "code", "description"), [("11", "1100", "Vegetables")]),
        "measure_unit.csv": _csv(("id", "name"), [("1000", "cup"), ("9999", "undetermined")]),
        "food.csv": _csv(("fdc_id", "data_type", "description", "food_category_id", "publication_date"), [
            ("1", "foundation_food", "Kale, raw", "11", "2026-04-30"),
            ("2", "foundation_food", "Kale, raw, baby, organic", "11", "2026-04-30"),
            ("3", "sub_sample_food", "Kale, raw — sample 1", "11", "2026-04-30"),
        ]),
        "nutrient.csv": _csv(("id", "name", "unit_name", "nutrient_nbr", "rank"), [
            ("1087", "Calcium, Ca", "MG", "301", "5300"), ("1162", "Vitamin C", "MG", "401", "6300")]),
        "food_nutrient.csv": _csv(
            ("id", "fdc_id", "nutrient_id", "amount", "data_points", "derivation_id", "min", "max",
             "median", "footnote", "min_year_acquired"), [
                ("10", "1", "1087", "254", "8", "1", "200", "300", "250", "", ""),
                ("11", "1", "1162", "93.4", "", "", "", "", "", "", ""),
                ("12", "3", "1087", "999", "1", "1", "", "", "", "", ""),
                ("13", "", "1087", "1", "", "", "", "", "", "", ""),
            ]),
        "food_portion.csv": _csv(
            ("id", "fdc_id", "seq_num", "amount", "measure_unit_id", "portion_description", "modifier",
             "gram_weight", "data_points", "footnote", "min_year_acquired"), [
                ("1", "1", "1", "1", "1000", "", "chopped", "21", "", "", ""),
                ("2", "", "1", "1", "1000", "", "", "5", "", "", ""),
            ]),
    }
    with zipfile.ZipFile(path, "w") as archive:
        for name, text in files.items():
            archive.writestr(f"{folder}/{name}", text)
    return path


def make_survey_zip(path):
    """An FNDDS-shaped zip: one survey food whose nutrient is named by number, not id."""
    files = {
        "wweia_food_category.csv": _csv(("wweia_food_category", "wweia_food_category_description"),
                                        [("6402", "Other vegetables")]),
        "measure_unit.csv": _csv(("id", "name"), [("9999", "undetermined")]),
        "food.csv": _csv(("fdc_id", "data_type", "description", "food_category_id", "publication_date"), [
            ("50", "survey_fndds_food", "Kale, raw", "6402", "2024-10-31")]),
        "nutrient.csv": _csv(("id", "name", "unit_name", "nutrient_nbr", "rank"), [
            ("1087", "Calcium, Ca", "MG", "301", "5300"), ("1114", "Vitamin D (D2 + D3)", "UG", "328", "8700")]),
        "food_nutrient.csv": _csv(
            ("id", "fdc_id", "nutrient_id", "amount", "data_points", "derivation_id", "min", "max",
             "median", "footnote", "min_year_acquired"), [
                ("1", "50", "301", "150", "", "", "", "", "", "", ""),
                ("2", "50", "328", "0", "", "", "", "", "", "", "")]),
    }
    with zipfile.ZipFile(path, "w") as archive:
        for name, text in files.items():
            archive.writestr(f"FoodData_Central_survey_food_csv_test/{name}", text)
    return path


@pytest.fixture
def conn(tmp_path, data_dir):
    with fdcdb.session(tmp_path / "commons") as connection:
        yield connection


def test_load_keeps_dataset_foods_and_drops_sub_samples(conn, tmp_path):
    counts = fdcdb.load_fdc(conn, make_zip(tmp_path / "f.zip"))
    assert (counts["foods"], counts["amounts"], counts["portions"]) == (2, 2, 1)


def test_load_keeps_foundation_sample_spread(conn, tmp_path):
    fdcdb.load_fdc(conn, make_zip(tmp_path / "f.zip"))
    calcium = fdcdb.food(conn, 1)["nutrients"][1087]
    assert (calcium["min"], calcium["max"], calcium["data_points"]) == (200.0, 300.0, 8)


def test_reload_replaces_rather_than_piles_up(conn, tmp_path):
    path = make_zip(tmp_path / "f.zip")
    fdcdb.load_fdc(conn, path)
    fdcdb.load_fdc(conn, path)
    assert conn.execute("SELECT COUNT(*) FROM fdc_portions").fetchone()[0] == 1


def test_search_puts_short_names_first(conn, tmp_path):
    fdcdb.load_fdc(conn, make_zip(tmp_path / "f.zip"))
    assert [row["fdc_id"] for row in fdcdb.search(conn, "KALE raw")] == [1, 2]


def test_portion_carries_its_unit_and_grams(conn, tmp_path):
    fdcdb.load_fdc(conn, make_zip(tmp_path / "f.zip"))
    assert fdcdb.food(conn, 1)["portions"] == [
        {"amount": 1.0, "unit": "cup", "description": "chopped", "grams": 21.0}]


def test_survey_nutrient_numbers_become_fdc_ids(conn, tmp_path):
    fdcdb.load_fdc(conn, make_survey_zip(tmp_path / "s.zip"))
    assert fdcdb.food(conn, 50)["nutrients"][1087]["amount"] == 150


def test_survey_category_comes_from_wweia(conn, tmp_path):
    fdcdb.load_fdc(conn, make_survey_zip(tmp_path / "s.zip"))
    assert fdcdb.food(conn, 50)["category"] == "Other vegetables"


def make_branded_zip(path):
    """A Branded-shaped zip: one barcode with an old and a new label, and one discontinued."""
    files = {
        "nutrient.csv": _csv(("id", "name", "unit_name", "nutrient_nbr", "rank"), [
            ("1087", "Calcium, Ca", "MG", "301", "5300"), ("1008", "Energy", "KCAL", "208", "300"),
            ("1110", "Vitamin D (D2 + D3), International Units", "IU", "324", "8650"),
            ("1114", "Vitamin D (D2 + D3)", "UG", "328", "8700")]),
        "branded_food.csv": _csv(
            ("fdc_id", "brand_owner", "brand_name", "subbrand_name", "gtin_upc", "ingredients",
             "not_a_significant_source_of", "serving_size", "serving_size_unit", "household_serving_fulltext",
             "branded_food_category", "data_source", "package_weight", "modified_date", "available_date",
             "market_country", "discontinued_date"), [
                ("900", "Oat Co", "OATY", "", "00012345678905", "OATS", "", "40", "g", "1/2 cup",
                 "Cereal", "LI", "", "2020-01-01", "2020-01-01", "United States", ""),
                ("901", "Oat Co", "OATY", "", "00012345678905", "WHOLE GRAIN OATS", "", "40", "GRM", "1/2 cup",
                 "Cereal", "LI", "", "2024-01-01", "2024-01-01", "United States", ""),
                ("902", "Gone Inc", "", "", "00099999999999", "", "", "30", "g", "", "Snacks", "LI", "",
                 "2022-01-01", "2022-01-01", "United States", "2023-01-01"),
            ]),
        "food.csv": _csv(("fdc_id", "data_type", "description", "food_category_id", "publication_date"), [
            ("900", "branded_food", "ROLLED OATS", "", "2020-01-01"),
            ("901", "branded_food", "ROLLED OATS", "", "2024-01-01"),
            ("902", "branded_food", "CHIPS", "", "2022-01-01")]),
        "food_nutrient.csv": _csv(
            ("id", "fdc_id", "nutrient_id", "amount", "data_points", "derivation_id", "min", "max",
             "median", "footnote", "min_year_acquired"), [
                ("1", "900", "1087", "10", "", "70", "", "", "", "", ""),
                ("2", "901", "1087", "50", "", "70", "", "", "", "", ""),
                ("3", "901", "1008", "375", "", "70", "", "", "", "", ""),
                ("5", "901", "1110", "100", "", "70", "", "", "", "", ""),
                ("4", "902", "1087", "5", "", "70", "", "", "", "", "")]),
    }
    with zipfile.ZipFile(path, "w") as archive:
        for name, text in files.items():
            archive.writestr(f"FoodData_Central_branded_food_csv_test/{name}", text)
    return path


def test_branded_keeps_each_barcodes_newest_label(conn, tmp_path):
    counts = fdcdb.load_fdc(conn, make_branded_zip(tmp_path / "b.zip"))
    assert (counts["foods"], fdcdb.lookup_barcode(conn, "012345678905")[0]["fdc_id"]) == (1, 901)


def test_branded_figures_are_the_labels_with_no_spread(conn, tmp_path):
    fdcdb.load_fdc(conn, make_branded_zip(tmp_path / "b.zip"))
    food = fdcdb.food(conn, 901)
    assert (food["nutrients"][1087]["amount"], food["nutrients"][1087]["min"], food["label"]["brand_name"]) == (
        50.0, None, "OATY")


def test_branded_serving_in_grams_becomes_a_portion(conn, tmp_path):
    fdcdb.load_fdc(conn, make_branded_zip(tmp_path / "b.zip"))
    assert fdcdb.food(conn, 901)["portions"] == [
        {"amount": 1.0, "unit": "serving", "description": "1/2 cup", "grams": 40.0}]


def test_branded_reload_replaces_rather_than_piles_up(conn, tmp_path):
    path = make_branded_zip(tmp_path / "b.zip")
    fdcdb.load_fdc(conn, path)
    fdcdb.load_fdc(conn, path)
    assert [f["fdc_id"] for f in fdcdb.search_packaged(conn, "oats")] == [901]


def test_packaged_search_finds_by_brand_and_word_start(conn, tmp_path):
    fdcdb.load_fdc(conn, make_branded_zip(tmp_path / "b.zip"))
    assert [f["fdc_id"] for f in fdcdb.search_packaged(conn, "oaty roll")] == [901]


def test_whole_food_search_leaves_packaged_out(conn, tmp_path):
    fdcdb.load_fdc(conn, make_branded_zip(tmp_path / "b.zip"))
    assert fdcdb.search(conn, "oats") == []


@pytest.mark.parametrize("code", ["012345678905", "0012345678905", "00012345678905", "0 12345 67890 5"])
def test_barcode_matches_however_its_written(conn, tmp_path, code):
    fdcdb.load_fdc(conn, make_branded_zip(tmp_path / "b.zip"))
    assert [f["fdc_id"] for f in fdcdb.lookup_barcode(conn, code)] == [901]


def test_upc_e_expands_to_upc_a():
    # GS1's worked example: UPC-E 04252614 is UPC-A 042100005264.
    assert fdcdb.barcode_keys("04252614") == ["4252614", "42100005264"]


def test_branded_vitamin_d_in_iu_gets_its_microgram_figure(conn, tmp_path):
    fdcdb.load_fdc(conn, make_branded_zip(tmp_path / "b.zip"))
    assert fdcdb.food(conn, 901)["nutrients"][1114]["amount"] == 2.5
