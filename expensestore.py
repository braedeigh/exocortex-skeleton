"""Expenses as real rows — the second typed entity in exo.db.

Why a second one at all: the plan is a schema-driven UI, where one component
reads a table's columns and renders a list and a form from them. A generator
with only `habits` to generalise over would be quietly shaped like habits. This
is the table that keeps it honest — different key type, a real foreign key, a
money column, and an enum.

Same contract as habitstore: **`expenses.json` stays the source of truth and is
never written here.** `rebuild()` reads it and re-derives both tables, so the
app's own read/write path is untouched and this can be rebuilt freely.

Three modelling decisions, all of which change what the data says:

  1. **Category is a table, not a string.** 15 distinct values repeated across
     124 rows. A foreign key is also what lets a generated form render a
     dropdown rather than a free-text box, which is the point of the exercise.
  2. **Money is integer cents.** The blob stores floats. 0.1 + 0.2 != 0.3 in
     binary floating point, so a running total drifts. Cents are exact.
  3. **Direction is explicit.** Every amount in the blob is positive —
     *including* the five tagged 'Income'. Sign therefore cannot distinguish
     money in from money out, so summing the table without a direction column
     would count income as spending. See DIRECTION_IN below: that list is a
     guess about intent and is the thing most worth overruling.

Touches: `sqlstore.py` (schema + connection), `store.py` (reads the `expenses`
collection), and `routes/sqlab.py`, whose map lists the typed tables.

Prompt that produced this file: "expenses as a typed table — the second entity,
so the schema-driven UI has something other than habits to generalise over."
"""
from collections import defaultdict
from decimal import Decimal, ROUND_HALF_UP

import sqlstore
import store

EXPENSES_FILE = "expenses.json"

# Categories that represent money coming IN. Everything else is money going out.
# This is a JUDGEMENT about what the owner meant, not a fact in the data — the
# blob has no direction field at all — so it's one editable line rather than
# logic buried in the loop.
DIRECTION_IN = {"Income"}


def _cents(amount):
    """A float from the blob → exact integer cents.

    Decimal(str(x)) rather than Decimal(x): the latter inherits the float's
    binary error (Decimal(14.99) is 14.9900000000000002131628...), which then
    rounds correctly by luck rather than by construction. ROUND_HALF_UP because
    Python's default banker's rounding would send 0.125 to 0.12, and money
    conventions expect 0.13.
    """
    return int(Decimal(str(amount)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP) * 100)


def _items(blob):
    """The expense list out of its envelope, tolerating either shape."""
    if isinstance(blob, dict):
        items = blob.get("items", [])
        return items if isinstance(items, list) else []
    return blob if isinstance(blob, list) else []


def rebuild():
    """Re-derive expense_categories + expenses from the blob. Idempotent.

    Wholly derived: both tables are cleared and rewritten, so anything
    hand-inserted does not survive. Category ids are stable across runs because
    the upsert matches on the unique name.
    """
    items = _items(store.read(EXPENSES_FILE, {}))

    conn = sqlstore.open_db()
    try:
        conn.execute("BEGIN IMMEDIATE")
        # Children first: expenses reference categories, and clearing the
        # parent while rows still point at it is what a foreign key is for.
        conn.execute("DELETE FROM expenses")
        conn.execute("DELETE FROM expense_categories")

        names = sorted({(it.get("category") or "").strip() or "Uncategorized" for it in items})
        for name in names:
            conn.execute(
                "INSERT INTO expense_categories (name) VALUES (?)"
                " ON CONFLICT (name) DO NOTHING",
                (name,),
            )
        ids = dict(conn.execute("SELECT name, id FROM expense_categories").fetchall())

        skipped = []
        for it in items:
            expense_id = it.get("id")
            amount = it.get("amount")
            if not expense_id or amount is None:
                skipped.append(it)
                continue
            cents = _cents(amount)
            if cents <= 0:
                # The CHECK would reject it anyway; collecting it is more use
                # than a failed transaction.
                skipped.append(it)
                continue
            category = (it.get("category") or "").strip() or "Uncategorized"
            conn.execute(
                "INSERT INTO expenses (id, date, amount_cents, direction, category_id,"
                "                      description, title, receipt, source)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    expense_id,
                    it.get("date") or "",
                    cents,
                    "in" if category in DIRECTION_IN else "out",
                    ids.get(category),
                    it.get("comments") or "",
                    it.get("title"),
                    it.get("receipt"),
                    it.get("source") or "manual",
                ),
            )
        conn.execute("COMMIT")
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    finally:
        conn.close()
    return {"expenses": len(items) - len(skipped), "categories": len(names), "skipped": len(skipped)}


def categories():
    """Every category with what's filed under it — the dropdown's source."""
    conn = sqlstore.open_db()
    try:
        rows = conn.execute(
            "SELECT c.id, c.name, COUNT(e.id) AS used"
            " FROM expense_categories c"
            " LEFT JOIN expenses e ON e.category_id = c.id"
            " GROUP BY c.id ORDER BY used DESC, c.name"
        ).fetchall()
        return [{"id": r[0], "name": r[1], "used": r[2]} for r in rows]
    finally:
        conn.close()


def totals_by_category(direction="out"):
    """What each category cost, biggest first. Cents in, cents out — formatting
    money is the caller's job, and doing it here would invite floats back."""
    conn = sqlstore.open_db()
    try:
        rows = conn.execute(
            "SELECT c.name, COUNT(*) AS n, SUM(e.amount_cents) AS cents"
            " FROM expenses e JOIN expense_categories c ON c.id = e.category_id"
            " WHERE e.direction = ?"
            " GROUP BY c.id ORDER BY cents DESC",
            (direction,),
        ).fetchall()
        return [{"category": r[0], "count": r[1], "cents": r[2]} for r in rows]
    finally:
        conn.close()


def monthly(direction="out"):
    """Spend per calendar month. strftime on a 'YYYY-MM-DD' text column is the
    cheap trick SQLite makes possible without a real date type."""
    conn = sqlstore.open_db()
    try:
        rows = conn.execute(
            "SELECT strftime('%Y-%m', date) AS month, COUNT(*) AS n,"
            "       SUM(amount_cents) AS cents"
            " FROM expenses WHERE direction = ? AND date <> ''"
            " GROUP BY month ORDER BY month",
            (direction,),
        ).fetchall()
        return [{"month": r[0], "count": r[1], "cents": r[2]} for r in rows]
    finally:
        conn.close()
