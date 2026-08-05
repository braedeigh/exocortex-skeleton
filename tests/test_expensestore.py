"""Expenses as typed rows (expensestore.py).

The three things that can silently corrupt money, in order of how badly they
bite: float rounding, income counted as spending, and a category string that
drifted into two rows. Everything here is a version of one of those.
"""
import sqlite3

import pytest

import expensestore
import sqlstore
import store


def seed(items):
    store.write("expenses", {"items": items})


def item(**over):
    base = {
        "id": "e1", "date": "2026-02-09", "amount": 64.0,
        "category": "Groceries", "comments": "SOME STORE 02/08",
    }
    base.update(over)
    return base


def rows(sql, params=()):
    conn = sqlstore.open_db()
    try:
        return conn.execute(sql, params).fetchall()
    finally:
        conn.close()


# --- money ---------------------------------------------------------------------

def test_amounts_become_exact_integer_cents(data_dir):
    seed([item(amount=14.99), item(id="e2", amount=64.0)])
    expensestore.rebuild()
    assert {r[0] for r in rows("SELECT amount_cents FROM expenses")} == {1499, 6400}


@pytest.mark.parametrize("amount,cents", [
    (0.1, 10), (0.2, 20), (14.99, 1499), (5000.0, 500_000),
    (1.005, 101),   # rounds half UP, not to even — money convention
    (33.333, 3333),
])
def test_float_to_cents_conversion(data_dir, amount, cents):
    assert expensestore._cents(amount) == cents


def test_summing_cents_does_not_drift(data_dir):
    """The whole reason for integer cents: 0.1 + 0.2 != 0.3 as floats."""
    seed([item(id="a", amount=0.1), item(id="b", amount=0.2)])
    expensestore.rebuild()
    assert rows("SELECT SUM(amount_cents) FROM expenses")[0][0] == 30


def test_a_zero_or_negative_amount_is_skipped_not_crashed(data_dir):
    seed([item(id="ok"), item(id="bad", amount=0)])
    result = expensestore.rebuild()
    assert result["skipped"] == 1
    assert [r[0] for r in rows("SELECT id FROM expenses")] == ["ok"]


def test_the_check_constraint_backs_that_up(data_dir):
    seed([item()])
    expensestore.rebuild()
    conn = sqlstore.open_db()
    try:
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute("INSERT INTO expenses (id, date, amount_cents) VALUES ('x', '2026-01-01', 0)")
    finally:
        conn.close()


# --- direction (money in vs money out) ----------------------------------------

def test_income_is_marked_as_money_in(data_dir):
    """Every blob amount is positive, including Income — so without this column
    a naive SUM counts a paycheque as spending."""
    seed([item(id="pay", category="Income", amount=100.0), item(id="food", amount=25.0)])
    expensestore.rebuild()
    assert dict(rows("SELECT id, direction FROM expenses")) == {"pay": "in", "food": "out"}


def test_spend_totals_exclude_income(data_dir):
    seed([item(id="pay", category="Income", amount=100.0), item(id="food", amount=25.0)])
    expensestore.rebuild()
    assert expensestore.totals_by_category() == [
        {"category": "Groceries", "count": 1, "cents": 2500},
    ]


def test_direction_only_accepts_in_or_out(data_dir):
    seed([item()])
    expensestore.rebuild()
    conn = sqlstore.open_db()
    try:
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute("UPDATE expenses SET direction = 'sideways'")
    finally:
        conn.close()


# --- categories become a table ------------------------------------------------

def test_repeated_category_strings_collapse_to_one_row(data_dir):
    seed([item(id="a"), item(id="b"), item(id="c", category="Rent")])
    expensestore.rebuild()
    assert {r[0] for r in rows("SELECT name FROM expense_categories")} == {"Groceries", "Rent"}
    assert rows("SELECT COUNT(*) FROM expense_categories WHERE name = 'Groceries'")[0][0] == 1


def test_expenses_point_at_their_category(data_dir):
    seed([item()])
    expensestore.rebuild()
    joined = rows(
        "SELECT e.id, c.name FROM expenses e JOIN expense_categories c ON c.id = e.category_id")
    assert joined == [("e1", "Groceries")]


def test_a_missing_category_becomes_uncategorized(data_dir):
    """schemas/expenses.json makes category optional but string-typed, so the
    two real shapes are an empty string and an absent key — not null."""
    absent = {"id": "e2", "date": "2026-02-09", "amount": 5.0, "comments": ""}
    seed([item(category=""), absent])
    expensestore.rebuild()
    assert {r[0] for r in rows("SELECT name FROM expense_categories")} == {"Uncategorized"}


def test_categories_reports_how_many_use_each(data_dir):
    seed([item(id="a"), item(id="b"), item(id="c", category="Rent")])
    expensestore.rebuild()
    assert expensestore.categories() == [
        {"id": pytest.approx(expensestore.categories()[0]["id"]), "name": "Groceries", "used": 2},
        {"id": pytest.approx(expensestore.categories()[1]["id"]), "name": "Rent", "used": 1},
    ]


def test_a_category_cannot_be_duplicated(data_dir):
    seed([item()])
    expensestore.rebuild()
    conn = sqlstore.open_db()
    try:
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute("INSERT INTO expense_categories (name) VALUES ('Groceries')")
    finally:
        conn.close()


# --- the derived-table contract -----------------------------------------------

def test_rebuild_never_writes_the_blob(data_dir):
    raw = {"items": [item()]}
    store.write("expenses", raw)
    expensestore.rebuild()
    assert store.read("expenses") == raw


def test_rebuild_is_idempotent(data_dir):
    seed([item(id="a"), item(id="b", category="Rent")])
    first = expensestore.rebuild()
    second = expensestore.rebuild()
    assert first == second
    assert rows("SELECT COUNT(*) FROM expenses")[0][0] == 2
    assert rows("SELECT COUNT(*) FROM expense_categories")[0][0] == 2


def test_rebuild_reflects_a_deletion_from_the_blob(data_dir):
    seed([item(id="a"), item(id="b")])
    expensestore.rebuild()
    seed([item(id="a")])
    expensestore.rebuild()
    assert [r[0] for r in rows("SELECT id FROM expenses")] == ["a"]


def test_the_blob_uuid_is_kept_as_the_primary_key(data_dir):
    """So a row here and a row there are provably the same expense."""
    seed([item(id="3cbc72f2-79da-40fb-9420-6c66d8ea1a70")])
    expensestore.rebuild()
    assert rows("SELECT id FROM expenses")[0][0] == "3cbc72f2-79da-40fb-9420-6c66d8ea1a70"


def test_sparse_fields_survive_and_default_sensibly(data_dir):
    seed([
        item(id="a", receipt="receipts/x.jpeg", source="receipt_import", title="Groceries run"),
        item(id="b"),
    ])
    expensestore.rebuild()
    got = dict((r[0], r[1:]) for r in rows("SELECT id, receipt, source, title FROM expenses"))
    assert got["a"] == ("receipts/x.jpeg", "receipt_import", "Groceries run")
    assert got["b"] == (None, "manual", None)


def test_an_item_with_no_id_is_skipped(data_dir, monkeypatch):
    """schemas/expenses.json requires id/date/amount, so a valid blob can't
    contain this — but EXOCORTEX_SCHEMA_OFF is a documented kill switch, and
    rebuild() reads whatever is actually there. Written with validation off on
    purpose, to prove the skip path rather than assume it."""
    monkeypatch.setenv("EXOCORTEX_SCHEMA_OFF", "1")
    seed([item(), {"amount": 5.0, "category": "Groceries"}])
    assert expensestore.rebuild()["skipped"] == 1


def test_an_empty_collection_is_fine(data_dir):
    seed([])
    assert expensestore.rebuild() == {"expenses": 0, "categories": 0, "skipped": 0}


# --- the queries the table exists to make possible -----------------------------

def test_monthly_buckets_by_calendar_month(data_dir):
    seed([
        item(id="a", date="2026-02-09", amount=10.0),
        item(id="b", date="2026-02-20", amount=5.0),
        item(id="c", date="2026-03-01", amount=7.5),
    ])
    expensestore.rebuild()
    assert expensestore.monthly() == [
        {"month": "2026-02", "count": 2, "cents": 1500},
        {"month": "2026-03", "count": 1, "cents": 750},
    ]


def test_monthly_ignores_rows_with_no_date(data_dir):
    seed([item(id="a", date=""), item(id="b", date="2026-03-01", amount=7.5)])
    expensestore.rebuild()
    assert expensestore.monthly() == [{"month": "2026-03", "count": 1, "cents": 750}]
