"""Behavioral tests for the Money API (routes/money.py).

Money is where silent corruption costs real dollars: the budget, the expense
log, subscriptions, the bank-CSV import (with its merchant-rule learning loop
and receipt-merge dedup), and the tax set-aside. These tests pin the HTTP
contract of each.

The CSV parse tests write fixture files into the import-time CSV dir
(data_helpers.DATA_DIR / "bank_csvs" — an isolated temp dir during tests);
everything else is JSON through the per-test `data_dir` store.

Same shape as the other route tests: minimal app, only this blueprint.
"""
import io
import json
from datetime import datetime

import pytest

import store
from data_helpers import DATA_DIR as IMPORT_DATA_DIR


@pytest.fixture
def client(data_dir):
    """A test client for a minimal app exposing only the money routes."""
    from flask import Flask
    from routes import money
    app = Flask(__name__)
    app.config.update(TESTING=True)
    money.register(app)
    return app.test_client()


def _post(client, path, payload=None):
    return client.post(path, data=json.dumps(payload or {}), content_type="application/json")


def read_expenses():
    return store.read("expenses", {"items": []})["items"]


def read_budget():
    return store.read("budget", {"income_monthly": 0, "categories": []})


def read_subs():
    return store.read("subscriptions", {"items": []})["items"]


# --- budget -------------------------------------------------------------------

def test_budget_update_sets_income_and_rejects_garbage(client):
    _post(client, "/api/budget/update", {"income_monthly": "5706.16"})
    assert read_budget()["income_monthly"] == 5706.16
    assert _post(client, "/api/budget/update", {"income_monthly": "lots"}).status_code == 400


def test_budget_category_add_validates_and_rejects_duplicates(client):
    r = _post(client, "/api/budget/category/add", {"name": "Groceries", "planned": "400", "type": "variable"})
    assert r.status_code == 200
    assert read_budget()["categories"] == [{"name": "Groceries", "planned": 400.0, "type": "variable"}]
    assert _post(client, "/api/budget/category/add", {"name": "groceries"}).status_code == 400
    assert _post(client, "/api/budget/category/add", {"name": "  "}).status_code == 400
    assert _post(client, "/api/budget/category/add", {"name": "Rent", "planned": "??"}).status_code == 400


def test_budget_category_remove(client):
    _post(client, "/api/budget/category/add", {"name": "Groceries", "planned": 400})
    _post(client, "/api/budget/category/remove", {"name": "Groceries"})
    assert read_budget()["categories"] == []


# --- expenses ------------------------------------------------------------------

def test_expense_add_creates_item_with_id_and_defaults_date(client):
    r = _post(client, "/api/expense/add", {"amount": "42.50", "category": "Groceries", "comments": "HEB"})
    assert r.status_code == 200
    items = read_expenses()
    assert len(items) == 1
    e = items[0]
    assert e["amount"] == 42.5 and e["category"] == "Groceries" and e["id"]
    assert e["date"] == datetime.now().strftime("%Y-%m-%d")


def test_expense_add_rejects_bad_amount(client):
    assert _post(client, "/api/expense/add", {"amount": "lots"}).status_code == 400
    assert _post(client, "/api/expense/add", {}).status_code == 400


def test_expense_remove_by_id_leaves_others(client):
    _post(client, "/api/expense/add", {"amount": 10, "category": "A"})
    _post(client, "/api/expense/add", {"amount": 20, "category": "B"})
    eid = read_expenses()[0]["id"]
    _post(client, "/api/expense/remove", {"id": eid})
    items = read_expenses()
    assert len(items) == 1 and items[0]["category"] == "B"


def test_expense_update_partial_fields(client):
    _post(client, "/api/expense/add", {"amount": 10, "category": "A", "comments": "x"})
    eid = read_expenses()[0]["id"]
    _post(client, "/api/expense/update", {"id": eid, "amount": "12.5", "category": "B"})
    e = read_expenses()[0]
    assert e["amount"] == 12.5 and e["category"] == "B" and e["comments"] == "x"
    assert _post(client, "/api/expense/update", {"id": eid, "amount": "??"}).status_code == 400


def test_expense_title_with_learn_rule_saves_merchant_label(client):
    _post(client, "/api/expense/add", {"amount": 15.49, "comments": "NETFLIX COM 866-579"})
    eid = read_expenses()[0]["id"]
    _post(client, "/api/expense/update",
          {"id": eid, "title": "Netflix", "learn_label_rule": True})
    assert read_expenses()[0]["title"] == "Netflix"
    patterns = store.read("merchant_labels", {"patterns": []})["patterns"]
    assert patterns == [{"match": "netflix com", "title": "Netflix"}]


# --- subscriptions ----------------------------------------------------------------

def test_subscription_add_validates_and_rejects_duplicates(client):
    r = _post(client, "/api/subscription/add",
              {"name": "Netflix", "amount": "15.49", "frequency": "monthly"})
    assert r.status_code == 200
    assert read_subs()[0]["amount"] == 15.49
    assert _post(client, "/api/subscription/add", {"name": "netflix"}).status_code == 400
    assert _post(client, "/api/subscription/add", {"name": ""}).status_code == 400
    assert _post(client, "/api/subscription/add", {"name": "X", "amount": "??"}).status_code == 400


def test_subscription_update_and_rename_avoids_collision(client):
    _post(client, "/api/subscription/add", {"name": "Netflix", "amount": 15.49})
    _post(client, "/api/subscription/add", {"name": "Spotify", "amount": 11.99})
    _post(client, "/api/subscription/update",
          {"name": "Netflix", "amount": "17.99", "new_name": "Netflix 4K"})
    names = {s["name"] for s in read_subs()}
    assert names == {"Netflix 4K", "Spotify"}
    # Renaming onto an existing name is silently refused, other fields still apply
    _post(client, "/api/subscription/update",
          {"name": "Spotify", "new_name": "Netflix 4K", "notes": "student plan"})
    s = next(x for x in read_subs() if x["name"] == "Spotify")
    assert s["notes"] == "student plan"


def test_subscription_remove(client):
    _post(client, "/api/subscription/add", {"name": "Netflix", "amount": 15.49})
    _post(client, "/api/subscription/remove", {"name": "Netflix"})
    assert read_subs() == []


def test_auto_detect_finds_recurring_merchant_across_months(client):
    store.write("expenses", {"items": [
        {"id": "1", "date": "2026-04-05", "amount": 15.49, "category": "Subscriptions",
         "comments": "NETFLIX SUBSCRIPTION 123"},
        {"id": "2", "date": "2026-05-05", "amount": 15.49, "category": "Subscriptions",
         "comments": "NETFLIX SUBSCRIPTION 456"},
        # one-off in a single month: not recurring, must be skipped
        {"id": "3", "date": "2026-05-09", "amount": 4.99, "category": "Subscriptions",
         "comments": "ONEOFF APP PURCHASE"},
    ]})
    r = _post(client, "/api/subscription/auto-detect")
    out = r.get_json()
    assert out["added"] == 1 and out["skipped"] == 1
    sub = read_subs()[0]
    assert sub["name"] == "Netflix"
    assert sub["amount"] == 15.49
    assert sub["frequency"] == "monthly"
    assert sub["next_renewal"] == "2026-06-04"  # 30-day cycle after the last charge


def test_auto_detect_with_no_subscription_expenses_is_a_noop(client):
    r = _post(client, "/api/subscription/auto-detect")
    assert r.get_json() == {"added": 0, "skipped": 0}


# --- CSV parse + import -------------------------------------------------------------

BOA_CSV = """Description,,Summary Amt
Beginning balance as of 04/01/2026,,"1,000.00"

Date,Description,Amount
04/03/2026,PAYPAL DES:GUMROAD,-25.50
04/04/2026,Beginning balance as of 04/04/2026,"1,000.00"
04/05/2026,VIDALA DES:PAYROLL,500.00
04/06/2026,TRANSFER TO SAVINGS,-100.00
"""


def _write_csv(name, content=BOA_CSV):
    csv_dir = IMPORT_DATA_DIR / "bank_csvs"
    csv_dir.mkdir(parents=True, exist_ok=True)
    (csv_dir / name).write_text(content)
    return name


def test_csv_parse_normalizes_dates_skips_balance_rows_and_sets_includes(client):
    fname = _write_csv("test_parse.csv")
    r = _post(client, "/api/csv/parse", {"filename": fname})
    rows = r.get_json()["rows"]
    descs = [row["desc"] for row in rows]
    assert "Beginning balance as of 04/04/2026" not in descs
    by_desc = {row["desc"]: row for row in rows}
    paypal = by_desc["PAYPAL DES:GUMROAD"]
    assert paypal["date"] == "2026-04-03"
    assert paypal["include"] is True            # plain expense: in by default
    assert by_desc["VIDALA DES:PAYROLL"]["include"] is True   # paycheck: in (tax tracking)
    assert by_desc["TRANSFER TO SAVINGS"]["include"] is False  # internal transfer: out
    assert by_desc["TRANSFER TO SAVINGS"]["category"] == "Savings/Transfer"


def test_csv_parse_flags_already_imported_rows(client):
    fname = _write_csv("test_dedup.csv")
    store.write("expenses", {"items": [
        {"id": "1", "date": "2026-04-03", "amount": 25.50, "comments": "PAYPAL DES:GUMROAD"},
    ]})
    rows = _post(client, "/api/csv/parse", {"filename": fname}).get_json()["rows"]
    paypal = next(r for r in rows if r["desc"] == "PAYPAL DES:GUMROAD")
    assert paypal["already_imported"] is True
    assert paypal["include"] is False


def test_csv_parse_404s_on_missing_or_escaping_filename(client):
    assert _post(client, "/api/csv/parse", {"filename": "nope.csv"}).status_code == 404
    assert _post(client, "/api/csv/parse", {"filename": "../expenses.json"}).status_code == 404


def test_csv_import_adds_expenses_learns_rules_and_creates_categories(client):
    r = _post(client, "/api/csv/import", {
        "selections": [
            {"date": "2026-04-03", "amount": -25.50, "desc": "PAYPAL DES:GUMROAD", "category": "Fun"},
            {"date": "2026-04-05", "amount": 500.00, "desc": "VIDALA DES:PAYROLL", "category": "Income"},
        ],
        "learn_rules": [{"match": "paypal des:gumroad", "category": "Fun"}],
    })
    out = r.get_json()
    assert out["added"] == 2 and out["rules_learned"] == 1
    # Amounts stored as positive magnitudes
    assert sorted(e["amount"] for e in read_expenses()) == [25.5, 500.0]
    rules = store.read("merchant_categories", {"patterns": []})["patterns"]
    assert rules == [{"match": "paypal des:gumroad", "category": "Fun"}]
    # 'Fun' auto-created as a budget category; 'Income' is in the skip-list
    cats = {c["name"] for c in read_budget()["categories"]}
    assert cats == {"Fun"}
    assert out["categories_added"] == 1


def test_csv_import_merges_bank_row_into_receipt_expense(client):
    store.write("expenses", {"items": [
        {"id": "r1", "date": "2026-06-01", "amount": 54.32, "category": "Groceries",
         "comments": "HEB · 12 units", "receipt": "receipts/grocery/x.jpg",
         "source": "receipt_import"},
    ]})
    r = _post(client, "/api/csv/import", {
        "selections": [
            {"date": "2026-06-01", "amount": -54.32, "desc": "HEB ONLINE GROCERY", "category": "Groceries", "include": True},
        ],
    })
    out = r.get_json()
    assert out["merged_with_receipt"] == 1 and out["added"] == 0
    items = read_expenses()
    assert len(items) == 1  # merged, not duplicated
    e = items[0]
    assert e["bank_matched"] is True
    assert e["comments"] == "HEB ONLINE GROCERY"
    assert e["receipt"] == "receipts/grocery/x.jpg"  # receipt link preserved


# --- tax set-aside ---------------------------------------------------------------------

def test_tax_log_and_remove(client):
    r = _post(client, "/api/tax/log", {"amount": "125.00", "notes": "Vidala May"})
    assert r.status_code == 200
    items = store.read("tax_setaside", {"items": []})["items"]
    assert items[0]["amount"] == 125.0 and items[0]["notes"] == "Vidala May"
    _post(client, "/api/tax/remove", {"id": items[0]["id"]})
    assert store.read("tax_setaside", {"items": []})["items"] == []


def test_tax_log_rejects_bad_amount(client):
    assert _post(client, "/api/tax/log", {"amount": "??"}).status_code == 400


# --- expense receipts ---------------------------------------------------------------------

def test_receipt_upload_names_file_and_registers_map_entry(client):
    _post(client, "/api/expense/add", {"amount": 54.32, "category": "Groceries",
                                       "comments": "HEB grocery run", "date": "2026-06-01"})
    eid = read_expenses()[0]["id"]
    r = client.post(f"/api/expense/{eid}/receipt",
                    data={"file": (io.BytesIO(b"fake-jpg-bytes"), "photo.jpg")},
                    content_type="multipart/form-data")
    assert r.status_code == 200
    fname = r.get_json()["filename"]
    assert fname.startswith("2026-06-01-heb-")
    rmap = store.read("expense_receipts", {})
    assert rmap[eid]["filename"] == fname and rmap[eid]["parsed"] is False


def test_receipt_upload_404s_on_unknown_expense(client):
    r = client.post("/api/expense/nope/receipt",
                    data={"file": (io.BytesIO(b"x"), "photo.jpg")},
                    content_type="multipart/form-data")
    assert r.status_code == 404


def test_receipt_delete_clears_map_entry(client):
    _post(client, "/api/expense/add", {"amount": 1, "comments": "HEB"})
    eid = read_expenses()[0]["id"]
    client.post(f"/api/expense/{eid}/receipt",
                data={"file": (io.BytesIO(b"x"), "photo.jpg")},
                content_type="multipart/form-data")
    client.delete(f"/api/expense/{eid}/receipt")
    assert store.read("expense_receipts", {}) == {}
