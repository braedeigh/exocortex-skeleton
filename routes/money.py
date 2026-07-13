"""Money routes — budget, expense log, subscriptions, CSV import, receipts."""
from flask import request, jsonify, send_from_directory
from data_helpers import DATA_DIR, RECEIPTS_DIR
from datetime import datetime
from pathlib import Path
import csv
import json
import re
import uuid
import store


def register(app):

    # --- Budget (income + planned categories) ---

    @app.route("/api/budget/get")
    def get_budget():
        return jsonify(store.read("budget.json", {"income_monthly": 0, "categories": []}))

    @app.route("/api/budget/update", methods=["POST"])
    def update_budget():
        data = request.json
        bdata = store.read("budget.json", {"income_monthly": 0, "categories": []})
        if "income_monthly" in data:
            try:
                bdata["income_monthly"] = float(data["income_monthly"]) if data["income_monthly"] != "" else 0
            except (ValueError, TypeError):
                return jsonify({"error": "Invalid income"}), 400
        if "categories" in data:
            bdata["categories"] = data["categories"]
        if "bank_csv_url" in data:
            bdata["bank_csv_url"] = data["bank_csv_url"].strip()
        store.write("budget.json", bdata)
        return jsonify({"ok": True})

    @app.route("/api/budget/category/add", methods=["POST"])
    def add_category():
        data = request.json
        name = data.get("name", "").strip()
        if not name:
            return jsonify({"error": "Empty name"}), 400
        try:
            planned = float(data.get("planned", 0) or 0)
        except (ValueError, TypeError):
            return jsonify({"error": "Invalid planned amount"}), 400
        ctype = data.get("type", "variable")  # variable | fixed | savings
        bdata = store.read("budget.json", {"income_monthly": 0, "categories": []})
        if any(c["name"].lower() == name.lower() for c in bdata["categories"]):
            return jsonify({"error": "Category already exists"}), 400
        bdata["categories"].append({"name": name, "planned": planned, "type": ctype})
        store.write("budget.json", bdata)
        return jsonify({"ok": True})

    @app.route("/api/budget/category/remove", methods=["POST"])
    def remove_category():
        data = request.json
        name = data["name"]
        bdata = store.read("budget.json")
        bdata["categories"] = [c for c in bdata["categories"] if c["name"] != name]
        store.write("budget.json", bdata)
        return jsonify({"ok": True})

    # --- Expenses ---

    @app.route("/api/expense/add", methods=["POST"])
    def add_expense():
        data = request.json
        try:
            amount = float(data["amount"])
        except (ValueError, TypeError, KeyError):
            return jsonify({"error": "Invalid amount"}), 400
        category = data.get("category", "").strip()
        comments = data.get("comments", "").strip()
        date = data.get("date") or datetime.now().strftime("%Y-%m-%d")
        edata = store.read("expenses.json", {"items": []})
        edata["items"].append({
            "id": str(uuid.uuid4()),
            "date": date,
            "amount": amount,
            "category": category,
            "comments": comments,
        })
        store.write("expenses.json", edata)
        return jsonify({"ok": True})

    @app.route("/api/expense/remove", methods=["POST"])
    def remove_expense():
        data = request.json
        eid = data["id"]
        edata = store.read("expenses.json")
        edata["items"] = [i for i in edata["items"] if i.get("id") != eid]
        store.write("expenses.json", edata)
        return jsonify({"ok": True})

    @app.route("/api/expense/update", methods=["POST"])
    def update_expense():
        data = request.json
        eid = data["id"]
        edata = store.read("expenses.json")
        for i in edata["items"]:
            if i.get("id") == eid:
                if "amount" in data:
                    try:
                        i["amount"] = float(data["amount"])
                    except (ValueError, TypeError):
                        return jsonify({"error": "Invalid amount"}), 400
                if "category" in data:
                    i["category"] = data["category"]
                if "comments" in data:
                    i["comments"] = data["comments"]
                if "date" in data:
                    i["date"] = data["date"]
                if "title" in data:
                    i["title"] = data["title"]
                    # If learn_as_rule is set, save as a merchant_labels rule for future matches
                    if data.get("learn_label_rule"):
                        comments = i.get("comments", "")
                        # Use first 2 words as merchant key, like categories
                        words = re.sub(r"[^a-z0-9 *-]", " ", comments.lower()).split()
                        match_key = " ".join(words[:2])
                        if match_key and data["title"]:
                            ldata = store.read("merchant_labels.json", {"patterns": []})
                            # Replace any existing pattern with same match key
                            ldata["patterns"] = [p for p in ldata["patterns"] if p["match"].lower() != match_key]
                            ldata["patterns"].append({"match": match_key, "title": data["title"]})
                            store.write("merchant_labels.json", ldata)
                break
        store.write("expenses.json", edata)
        return jsonify({"ok": True})

    # --- Subscriptions ---

    @app.route("/api/subscription/add", methods=["POST"])
    def add_subscription():
        data = request.json
        name = data.get("name", "").strip()
        if not name:
            return jsonify({"error": "Empty name"}), 400
        try:
            amount = float(data.get("amount", 0) or 0)
        except (ValueError, TypeError):
            return jsonify({"error": "Invalid amount"}), 400
        frequency = data.get("frequency", "monthly")  # monthly | yearly
        next_renewal = data.get("next_renewal", "").strip()
        cancel_url = data.get("cancel_url", "").strip()
        notes = data.get("notes", "").strip()
        sdata = store.read("subscriptions.json", {"items": []})
        if any(s["name"].lower() == name.lower() for s in sdata["items"]):
            return jsonify({"error": "Subscription already exists"}), 400
        sdata["items"].append({
            "name": name,
            "amount": amount,
            "frequency": frequency,
            "next_renewal": next_renewal,
            "cancel_url": cancel_url,
            "notes": notes,
        })
        store.write("subscriptions.json", sdata)
        return jsonify({"ok": True})

    @app.route("/api/subscription/update", methods=["POST"])
    def update_subscription():
        data = request.json
        name = data["name"]
        sdata = store.read("subscriptions.json")
        for s in sdata["items"]:
            if s["name"] == name:
                if "amount" in data:
                    try:
                        s["amount"] = float(data["amount"])
                    except (ValueError, TypeError):
                        return jsonify({"error": "Invalid amount"}), 400
                if "bill_day" in data:
                    raw_day = data["bill_day"]
                    if raw_day in ("", None):
                        s["bill_day"] = None
                    else:
                        try:
                            day_int = int(raw_day)
                        except (ValueError, TypeError):
                            return jsonify({"error": "Invalid bill day"}), 400
                        if not (1 <= day_int <= 31):
                            return jsonify({"error": "Bill day must be 1-31"}), 400
                        s["bill_day"] = day_int
                for k in ("frequency", "next_renewal", "cancel_url", "notes", "display_name"):
                    if k in data:
                        s[k] = data[k]
                if "new_name" in data:
                    new_name = data["new_name"].strip()
                    if new_name and new_name != name and not any(x["name"].lower() == new_name.lower() for x in sdata["items"] if x is not s):
                        s["name"] = new_name
                break
        store.write("subscriptions.json", sdata)
        return jsonify({"ok": True})

    @app.route("/api/subscription/auto-detect", methods=["POST"])
    def auto_detect_subscriptions():
        """Scan expenses with category 'Subscriptions', group by merchant, add recurring ones."""
        expenses = store.read("expenses.json", {"items": []}).get("items", [])
        sub_expenses = [e for e in expenses if (e.get("category", "").lower() == "subscriptions")]
        if not sub_expenses:
            return jsonify({"added": 0, "skipped": 0})

        # Group by merchant key (first 2 lowercased alphanumeric words of description)
        import re
        def merchant_key(desc):
            if not desc:
                return ""
            words = re.sub(r"[^a-z0-9 *-]", " ", desc.lower()).split()
            return " ".join(words[:2])

        def display_name(desc):
            # Take first word capitalized; for known multi-word, expand
            if not desc:
                return "Unknown"
            first = desc.split()[0]
            # Strip common prefixes
            for prefix in ("SQ", "TST*", "PAYPAL", "SQSP*", "AMAZON"):
                if first.upper().startswith(prefix) and len(desc.split()) > 1:
                    first = desc.split()[1] if len(desc.split()) > 1 else first
                    break
            return first.title().rstrip("*")

        groups = {}
        for e in sub_expenses:
            key = merchant_key(e.get("comments", ""))
            if not key:
                continue
            groups.setdefault(key, []).append(e)

        # Load existing subs to skip duplicates
        sdata = store.read("subscriptions.json", {"items": []})
        existing_names = {s["name"].lower() for s in sdata["items"]}

        added = 0
        skipped = 0
        for key, items in groups.items():
            if len(items) < 2:
                skipped += 1
                continue
            # Need at least 2 different months
            months = {(e.get("date") or "")[:7] for e in items if e.get("date")}
            if len(months) < 2:
                skipped += 1
                continue

            sorted_items = sorted(items, key=lambda x: x.get("date", ""))
            most_recent = sorted_items[-1]
            # Use most common amount, or most recent if all unique
            from collections import Counter
            amounts = [round(e.get("amount", 0), 2) for e in sorted_items]
            most_common_amt = Counter(amounts).most_common(1)[0][0]

            # Estimate cycle from average days between consecutive dates
            from datetime import datetime as _dt
            dates = sorted([_dt.strptime(e["date"], "%Y-%m-%d") for e in sorted_items if e.get("date")])
            if len(dates) >= 2:
                gaps = [(dates[i+1] - dates[i]).days for i in range(len(dates) - 1)]
                avg_gap = sum(gaps) / len(gaps)
                frequency = "yearly" if avg_gap > 200 else "monthly"
                cycle_days = int(round(avg_gap)) if frequency == "monthly" else 365
                next_renewal = (dates[-1] + __import__("datetime").timedelta(days=cycle_days)).strftime("%Y-%m-%d")
            else:
                frequency = "monthly"
                next_renewal = ""

            name = display_name(most_recent.get("comments", ""))
            # Avoid name collision with existing
            if name.lower() in existing_names:
                skipped += 1
                continue

            sdata["items"].append({
                "name": name,
                "amount": most_common_amt,
                "frequency": frequency,
                "next_renewal": next_renewal,
                "cancel_url": "",
                "notes": f"Auto-detected from {len(items)} charges, last seen {most_recent.get('date')}",
            })
            existing_names.add(name.lower())
            added += 1

        if added:
            store.write("subscriptions.json", sdata)
        return jsonify({"added": added, "skipped": skipped})

    @app.route("/api/subscription/remove", methods=["POST"])
    def remove_subscription():
        data = request.json
        name = data["name"]
        sdata = store.read("subscriptions.json")
        sdata["items"] = [s for s in sdata["items"] if s["name"] != name]
        store.write("subscriptions.json", sdata)
        return jsonify({"ok": True})

    # --- CSV Import (rules-based with learning loop) ---

    CSV_DIR = DATA_DIR / "bank_csvs"

    def _load_merchant_rules():
        return store.read("merchant_categories.json", {"patterns": []})

    def _save_merchant_rules(rules):
        store.write("merchant_categories.json", rules)

    def _categorize(desc, amount, rules):
        d = desc.lower()
        # Income / transfers — special signals, not categories
        if amount > 0:
            if "transfer from" in d:
                return "Transfer (in)"
            return "Income"
        if "transfer to" in d:
            return "Savings/Transfer"
        for p in rules.get("patterns", []):
            if p["match"].lower() in d:
                return p["category"]
        return "Uncategorized"

    def _label_for(desc):
        """Return a saved label (title) for this merchant, if any."""
        if not desc:
            return ""
        ldata = store.read("merchant_labels.json", {"patterns": []})
        d = desc.lower()
        for p in ldata.get("patterns", []):
            if p["match"].lower() in d:
                return p.get("title", "")
        return ""

    def _parse_boa_csv(path):
        """Parse Bank of America-style CSV. Return list of {date, desc, amount}."""
        with open(path) as f:
            lines = f.readlines()
        # Locate the transactions header row
        header_idx = None
        for idx, line in enumerate(lines):
            if line.strip().startswith("Date,Description,Amount"):
                header_idx = idx
                break
        if header_idx is None:
            return []
        reader = csv.reader(lines[header_idx + 1:])
        rows = []
        for row in reader:
            if len(row) < 3 or not row[0]:
                continue
            date_raw, desc, amt_raw = row[0].strip(), row[1].strip(), row[2].strip()
            if "balance" in desc.lower():
                continue
            try:
                amount = float(amt_raw.replace(",", "").replace('"', ""))
            except ValueError:
                continue
            # Normalize date MM/DD/YYYY -> YYYY-MM-DD
            try:
                date_iso = datetime.strptime(date_raw, "%m/%d/%Y").strftime("%Y-%m-%d")
            except ValueError:
                date_iso = date_raw
            rows.append({"date": date_iso, "desc": desc, "amount": amount})
        return rows

    @app.route("/api/csv/list")
    def list_csvs():
        if not CSV_DIR.exists():
            return jsonify({"files": []})
        files = sorted([p.name for p in CSV_DIR.iterdir() if p.is_file() and p.suffix.lower() == ".csv"])
        return jsonify({"files": files})

    @app.route("/api/csv/parse", methods=["POST"])
    def parse_csv():
        data = request.json
        filename = data.get("filename", "")
        path = CSV_DIR / filename
        if not path.exists() or not str(path.resolve()).startswith(str(CSV_DIR.resolve())):
            return jsonify({"error": "File not found"}), 404
        rules = _load_merchant_rules()
        rows = _parse_boa_csv(path)
        # Annotate with auto-category + default include flag
        for r in rows:
            r["category"] = _categorize(r["desc"], r["amount"], rules)
            # Default include logic:
            #   - Expenses (negative): include unless internal transfer
            #   - Vidala paychecks (positive + "vidala"): include (needed for tax tracking)
            #   - Other income / transfers: skip by default
            desc_lower = (r["desc"] or "").lower()
            if r["amount"] < 0:
                r["include"] = r["category"] not in ("Savings/Transfer", "Transfer (in)")
            elif "vidala" in desc_lower or "cashout" in desc_lower or "des:cashout" in desc_lower:
                # Auto-include real income / reimbursements (paychecks, Venmo cashouts)
                r["include"] = True
                if r["category"] == "Income" and "cashout" in desc_lower:
                    # Tag cashouts so the Set Aside section knows they're not paycheck-style income
                    pass  # Keep as Income; user can recategorize if needed
            else:
                r["include"] = False
        # Detect already-imported rows (match by date+amount+desc)
        existing = store.read("expenses.json", {"items": []}).get("items", [])
        existing_keys = {(e.get("date"), abs(e.get("amount", 0)), e.get("comments", "")) for e in existing}
        for r in rows:
            key = (r["date"], abs(r["amount"]), r["desc"])
            r["already_imported"] = key in existing_keys
            if r["already_imported"]:
                r["include"] = False
        # Get list of all known categories (from budget + existing rules + observed)
        budget_cats = [c["name"] for c in store.read("budget.json", {"categories": []}).get("categories", [])]
        rule_cats = sorted({p["category"] for p in rules.get("patterns", [])})
        all_cats = sorted(set(budget_cats) | set(rule_cats) | {r["category"] for r in rows})
        return jsonify({"rows": rows, "categories": all_cats})

    @app.route("/api/csv/import", methods=["POST"])
    def import_csv():
        data = request.json
        selections = data.get("selections", [])
        learn_rules = data.get("learn_rules", [])  # [{match, category}, ...]
        edata = store.read("expenses.json", {"items": []})
        added = 0
        merged_with_receipt = 0
        for s in selections:
            try:
                amount = float(s["amount"])
            except (ValueError, TypeError, KeyError):
                continue
            comments = s.get("desc", "").strip()
            row_date = s.get("date") or datetime.now().strftime("%Y-%m-%d")
            row_amount = abs(amount)
            # Receipt-link dedup: if an existing entry is a receipt-import with the same
            # date + amount (and same category if both have one), merge bank info INTO that
            # entry instead of creating a duplicate. The receipt keeps its photo + items,
            # the bank's title/comments overwrite the placeholder.
            match = next(
                (e for e in edata["items"]
                 if e.get("source") == "receipt_import"
                 and e.get("date") == row_date
                 and abs(float(e.get("amount", 0)) - row_amount) < 0.10
                 and not e.get("bank_matched")),
                None,
            )
            if match:
                match["comments"] = comments or match.get("comments", "")
                match["title"] = _label_for(comments)
                if s.get("category"):
                    match["category"] = s["category"]
                match["bank_matched"] = True
                merged_with_receipt += 1
                continue
            edata["items"].append({
                "id": str(uuid.uuid4()),
                "date": row_date,
                "amount": row_amount,
                "category": s.get("category", ""),
                "comments": comments,
                "title": _label_for(comments),
            })
            added += 1
        store.write("expenses.json", edata)

        # Learn new merchant→category rules
        rules = _load_merchant_rules()
        learned = 0
        for lr in learn_rules:
            match = lr.get("match", "").strip().lower()
            category = lr.get("category", "").strip()
            if not match or not category:
                continue
            if any(p["match"].lower() == match for p in rules["patterns"]):
                continue
            rules["patterns"].append({"match": match, "category": category})
            learned += 1
        if learned:
            _save_merchant_rules(rules)

        # Auto-create budget categories that don't exist yet (with planned=0)
        bdata = store.read("budget.json", {"income_monthly": 0, "categories": []})
        existing_cats = {c["name"].lower() for c in bdata["categories"]}
        new_cats_added = 0
        used_categories = {s.get("category", "") for s in selections if s.get("category")}
        SKIP = {"income", "transfer (in)", "savings/transfer", "uncategorized", ""}
        for cat in used_categories:
            if cat.lower() in SKIP or cat.lower() in existing_cats:
                continue
            bdata["categories"].append({"name": cat, "planned": 0, "type": "variable"})
            existing_cats.add(cat.lower())
            new_cats_added += 1
        if new_cats_added:
            store.write("budget.json", bdata)

        return jsonify({
            "ok": True,
            "added": added,
            "merged_with_receipt": merged_with_receipt,
            "rules_learned": learned,
            "categories_added": new_cats_added,
        })

    # --- Tax Setaside (track 25% obligation from Vidala paychecks) ---

    @app.route("/api/tax/log", methods=["POST"])
    def log_tax_setaside():
        data = request.json
        try:
            amount = float(data["amount"])
        except (ValueError, TypeError, KeyError):
            return jsonify({"error": "Invalid amount"}), 400
        date = data.get("date") or datetime.now().strftime("%Y-%m-%d")
        notes = data.get("notes", "").strip()
        tdata = store.read("tax_setaside.json", {"items": []})
        tdata["items"].append({
            "id": str(uuid.uuid4()),
            "date": date,
            "amount": amount,
            "notes": notes,
        })
        store.write("tax_setaside.json", tdata)
        return jsonify({"ok": True})

    @app.route("/api/tax/remove", methods=["POST"])
    def remove_tax_setaside():
        data = request.json
        tid = data["id"]
        tdata = store.read("tax_setaside.json")
        tdata["items"] = [i for i in tdata["items"] if i.get("id") != tid]
        store.write("tax_setaside.json", tdata)
        return jsonify({"ok": True})

    # --- Receipts ---
    # RECEIPTS_DIR comes from the data layer (store.py), not the code dir.

    def _load_receipts_map():
        return store.read("expense_receipts.json", {})

    def _save_receipts_map(m):
        store.write("expense_receipts.json", m)

    def _slugify(s):
        s = (s or "").lower()
        s = re.sub(r"[^a-z0-9]+", "-", s)
        return s.strip("-")[:30] or "unknown"

    @app.route("/api/expense/<eid>/receipt", methods=["POST"])
    def upload_receipt(eid):
        if "file" not in request.files:
            return jsonify({"error": "No file provided"}), 400
        f = request.files["file"]
        if not f.filename:
            return jsonify({"error": "Empty filename"}), 400

        # Look up expense for naming context
        edata = store.read("expenses.json", {"items": []})
        expense = next((e for e in edata["items"] if e.get("id") == eid), None)
        if not expense:
            return jsonify({"error": "Expense not found"}), 404

        # Filename: <date>-<merchant_slug>-<short_id>.<ext>
        ext = Path(f.filename).suffix.lower() or ".jpg"
        if ext not in {".jpg", ".jpeg", ".png", ".heic", ".heif", ".webp", ".pdf"}:
            return jsonify({"error": f"Unsupported extension: {ext}"}), 400
        date_part = expense.get("date", datetime.now().strftime("%Y-%m-%d"))
        merchant_slug = _slugify((expense.get("comments", "") or "").split()[0] if expense.get("comments") else expense.get("category", "receipt"))
        short_id = eid.replace("-", "")[:6]
        fname = f"{date_part}-{merchant_slug}-{short_id}{ext}"

        RECEIPTS_DIR.mkdir(parents=True, exist_ok=True)
        target = RECEIPTS_DIR / fname
        f.save(str(target))

        # Update map
        rmap = _load_receipts_map()
        rmap[eid] = {
            "filename": fname,
            "uploaded": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "parsed": False,
        }
        _save_receipts_map(rmap)
        return jsonify({"ok": True, "filename": fname})

    @app.route("/api/expense/<eid>/receipt", methods=["DELETE"])
    def remove_receipt(eid):
        rmap = _load_receipts_map()
        entry = rmap.pop(eid, None)
        if entry:
            target = RECEIPTS_DIR / entry["filename"]
            if target.exists():
                target.unlink()
            _save_receipts_map(rmap)
        return jsonify({"ok": True})

    @app.route("/receipts/<path:filename>")
    def serve_receipt(filename):
        # Auth-protected serve from the receipts dir
        if "session" in request.cookies and not request.cookies.get("session"):
            return "", 401
        return send_from_directory(str(RECEIPTS_DIR), filename)

    # --- Money-tab receipt parsing ingest -----------------------------------------
    # A receipt uploaded here (root of receipts/, via upload_receipt above — NOT
    # the grocery/ subfolder) gets parsed by the "receipts" Claude session per
    # personal/receipts/CLAUDE.md. That agent's job stops at transcription: it
    # writes a sibling staging file `<filename>.parsed.json` (same convention as
    # the grocery pipeline, routes/kitchen/receipts.py) and NEVER touches
    # expense_receipts.json or grocery_trips.json directly. Both are SQL-backed
    # (store.SQL_COLLECTIONS): a raw file write is invisible to the app (which
    # reads SQLite) and gets silently clobbered the next time anything writes
    # that collection through store.py. These two routes are the only door in —
    # they apply a staged transcription through store.mutate.

    def _parsed_receipt_staging_path(filename):
        return RECEIPTS_DIR / f"{filename}.parsed.json"

    @app.route("/api/expense-receipts/parsed/list")
    def list_parsed_expense_receipts():
        """Money-tab receipts with a staged transcription ready to import."""
        results = []
        if not RECEIPTS_DIR.exists():
            return jsonify({"receipts": results})
        rmap = _load_receipts_map()
        for staged in sorted(RECEIPTS_DIR.glob("*.parsed.json")):
            if staged.with_suffix(".imported").exists():
                continue
            filename = staged.name[: -len(".parsed.json")]
            eid = next((k for k, v in rmap.items() if v.get("filename") == filename), None)
            if not eid:
                continue  # staged file with no matching expense — orphaned, skip
            try:
                pdata = json.loads(staged.read_text())
            except (json.JSONDecodeError, OSError):
                continue
            results.append({
                "eid": eid,
                "filename": filename,
                "store": pdata.get("store", ""),
                "date": pdata.get("date", ""),
                "total": pdata.get("total", 0),
                "items_count": len(pdata.get("line_items", [])),
            })
        return jsonify({"receipts": results})

    @app.route("/api/expense-receipts/parsed/import", methods=["POST"])
    def import_parsed_expense_receipt():
        """Apply a staged transcription: write the trip into grocery_trips.json and
        flip `parsed` in expense_receipts.json — both through store.mutate, never a
        direct file write (see module note above)."""
        data = request.json or {}
        eid = data.get("eid", "")
        rmap = _load_receipts_map()
        entry = rmap.get(eid)
        if not entry:
            return jsonify({"error": "No receipt on file for this expense"}), 404
        filename = entry.get("filename", "")
        staged = _parsed_receipt_staging_path(filename)
        if not staged.exists():
            return jsonify({"error": "No parsed staging file found"}), 404
        try:
            pdata = json.loads(staged.read_text())
        except json.JSONDecodeError:
            return jsonify({"error": "Staged file is not valid JSON"}), 400

        line_items = [
            {
                "name": li.get("name", ""),
                "qty": li.get("qty", 1),
                "price": li.get("price", 0),
            }
            for li in pdata.get("line_items", [])
        ]
        trip = {
            "date": pdata.get("date") or (entry.get("uploaded") or "")[:10],
            "store": pdata.get("store", ""),
            "total": pdata.get("total", 0),
            "saved": pdata.get("saved", 0),
            "items": sum(int(li.get("qty") or 1) for li in line_items),
            "line_count": len(line_items),
            "receipt": f"receipts/{filename}",
            "expense_id": eid,
            "line_items": line_items,
        }

        # Write the trip (append, or update the one already linked to this expense).
        with store.mutate("grocery_trips.json", {"trips": []}) as tdata:
            tdata.setdefault("trips", [])
            merged = False
            for existing in tdata["trips"]:
                if existing.get("expense_id") == eid:
                    existing.update(trip)
                    merged = True
                    break
            if not merged:
                tdata["trips"].append(trip)

        # Flip the map entry's `parsed` flag — through store.mutate, so a concurrent
        # writer (another receipt import, a new upload) can't lose this update.
        with store.mutate("expense_receipts.json", {}) as rmap2:
            if eid in rmap2:
                rmap2[eid]["parsed"] = True

        # Mark the staging file consumed (mirrors the grocery pipeline's marker).
        staged.with_suffix(".imported").write_text(datetime.now().strftime("%Y-%m-%d"))

        return jsonify({"ok": True, "trip_items": len(line_items)})
