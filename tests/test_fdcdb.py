"""FoodData Central into commons.db (fdcdb.py).

A tiny hand-built FDC zip stands in for USDA's: the loader keeps the
dataset's own foods and drops per-sample sub-rows, keeps the Foundation
min/max, skips rows with a blank food id, and a second load replaces the
first rather than piling up. Search puts Foundation foods and short names
first.
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
