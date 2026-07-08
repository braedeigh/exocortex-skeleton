"""Grocery receipt pipeline: photo upload → Claude (in the 'receipts' tmux
session) transcribes it to a sibling .parsed.json → user previews/categorizes
→ import writes the trip, expense, catalog, pantry, and learned rules.
"""
import json
import uuid
from datetime import datetime
from pathlib import Path

from flask import request, jsonify

from data_helpers import RECEIPTS_DIR
import store
from . import shared

GROCERY_RECEIPTS_DIR = RECEIPTS_DIR / "grocery"


def _find_parsed_receipt(filename):
    """Locate a .parsed.json in the grocery receipts dir (path-traversal safe).
    Returns Path or None."""
    p = GROCERY_RECEIPTS_DIR / filename
    try:
        if p.exists() and str(p.resolve()).startswith(str(GROCERY_RECEIPTS_DIR.resolve())):
            return p
    except OSError:
        pass
    return None


def register(app):

    @app.route("/api/kitchen/scan-receipt", methods=["POST"])
    def scan_receipt():
        if "photo" not in request.files:
            return jsonify({"error": "No photo uploaded"}), 400
        f = request.files["photo"]
        if not f.filename:
            return jsonify({"error": "Empty filename"}), 400

        ext = Path(f.filename).suffix.lower() or ".jpg"
        if ext not in {".jpg", ".jpeg", ".png", ".heic", ".heif", ".webp", ".pdf"}:
            return jsonify({"error": f"Unsupported extension: {ext}"}), 400

        date_part = datetime.now().strftime("%Y-%m-%d")
        store_slug = shared.slug(request.form.get("store") or "receipt")
        ts = datetime.now().strftime("%H%M%S")
        fname = f"{date_part}-{store_slug}-{ts}{ext}"
        GROCERY_RECEIPTS_DIR.mkdir(parents=True, exist_ok=True)
        target = GROCERY_RECEIPTS_DIR / fname
        f.save(str(target))
        # Make dir + photo writable so the (non-root) agent can drop the .parsed.json
        shared.chmod_for_claude(GROCERY_RECEIPTS_DIR)
        shared.chmod_for_claude(target)

        # Path Claude will see (relative to receipts/ — which is the cwd of the receipts session)
        rel_path = f"grocery/{fname}"

        newly_spawned = shared.ensure_claude_session("receipts", RECEIPTS_DIR, dirs=(RECEIPTS_DIR,))
        prompt = f"new grocery receipt uploaded: {rel_path} — please parse it per CLAUDE.md and append the result to data/grocery_trips.json"
        shared.send_prompt("receipts", prompt, delay=(6.0 if newly_spawned else 1.5))

        return jsonify({
            "ok": True,
            "filename": fname,
            "session": "receipts",
            "newly_spawned": newly_spawned,
        })

    # --- Rules-based grocery receipt parser (consumes Claude's transcription) ---

    @app.route("/api/kitchen/parsed-receipts/list")
    def list_parsed_receipts():
        """Return parsed-but-not-yet-imported grocery receipts."""
        results = []
        if not GROCERY_RECEIPTS_DIR.exists():
            return jsonify({"receipts": results})
        for parsed in sorted(GROCERY_RECEIPTS_DIR.glob("*.parsed.json")):
            marker = parsed.with_suffix(".imported")
            if marker.exists():
                continue
            try:
                pdata = json.loads(parsed.read_text())
            except (json.JSONDecodeError, OSError):
                continue
            results.append({
                "filename": parsed.name,
                "photo": parsed.name.replace(".parsed.json", ""),
                "store": pdata.get("store", ""),
                "date": pdata.get("date", ""),
                "total": pdata.get("total", 0),
                "items_count": len(pdata.get("line_items", [])),
            })
        return jsonify({"receipts": results})

    @app.route("/api/kitchen/parsed-receipts/preview", methods=["POST"])
    def preview_parsed_receipt():
        data = request.json
        filename = data.get("filename", "")
        path = _find_parsed_receipt(filename)
        if not path:
            return jsonify({"error": "File not found"}), 404
        pdata = json.loads(path.read_text())
        rules = shared.load_grocery_rules()
        gdata = store.read("kitchen.json", {})
        kitchen_catalog = gdata.get("category_map", {})
        active_items = gdata.get("items", [])
        rows = []
        for item in pdata.get("line_items", []):
            cat, catalog = shared.categorize_grocery_item(item.get("name", ""), rules, kitchen_catalog, active_items)
            rows.append({
                "name": item.get("name", ""),
                "qty": item.get("qty", 1),
                "price": item.get("price", 0),
                "unit_price": item.get("unit_price"),
                "category": cat or "",
                "catalog_name": catalog or "",
                "include": True,
            })
        return jsonify({
            "rows": rows,
            "header": {
                "store": pdata.get("store", ""),
                "date": pdata.get("date", ""),
                "subtotal": pdata.get("subtotal", 0),
                "tax": pdata.get("tax", 0),
                "total": pdata.get("total", 0),
                "saved": pdata.get("saved", 0),
            },
        })

    @app.route("/api/kitchen/parsed-receipts/import", methods=["POST"])
    def import_parsed_receipt():
        data = request.json
        filename = data.get("filename", "")
        selections = data.get("selections", [])
        learn_rules = data.get("learn_rules", [])  # [{match, category, catalog_name}]
        update_pantry = bool(data.get("update_pantry", True))
        path = _find_parsed_receipt(filename)
        if not path:
            return jsonify({"error": "File not found"}), 404
        pdata = json.loads(path.read_text())

        # Build the trip entry
        included = [s for s in selections if s.get("include")]
        # Trip item count = total UNITS bought (so 2× rice pudding counts as 2),
        # matching the receipt's "ITEMS PURCHASED" footer convention.
        unit_count = sum(int(s.get("qty") or 1) for s in included)
        trip = {
            "date": pdata.get("date") or datetime.now().strftime("%Y-%m-%d"),
            "store": pdata.get("store", ""),
            "total": pdata.get("total", 0),
            "saved": pdata.get("saved", 0),
            "items": unit_count,
            "line_count": len(included),
            "receipt": f"receipts/grocery/{filename.replace('.parsed.json', '')}",
            "line_items": [
                {
                    "name": s.get("name", ""),
                    "qty": s.get("qty", 1),
                    "price": s.get("price", 0),
                    "category": s.get("category", "other"),
                    "catalog_name": s.get("catalog_name", ""),
                }
                for s in included
            ],
        }

        # Create a Money-tab expense entry for this trip + link the receipt photo to it.
        # Future bank-statement CSV imports should match by (date, amount) within $0.10
        # against entries with category='Groceries' to dedup; that match logic lives in
        # routes/money.py's CSV import handler (TODO).
        edata = store.read("expenses.json", {"items": []})
        # Idempotency: skip if an expense with same date+amount+receipt already exists
        receipt_rel = trip["receipt"]
        existing_expense = next(
            (e for e in edata["items"]
             if e.get("date") == trip["date"]
             and abs(float(e.get("amount", 0)) - float(trip["total"])) < 0.01
             and e.get("receipt") == receipt_rel),
            None,
        )
        if existing_expense:
            expense_id = existing_expense["id"]
        else:
            expense_id = str(uuid.uuid4())
            store_label = trip["store"] or "Grocery"
            comments_bits = [store_label, f"{trip['items']} units"]
            if trip.get("saved"):
                comments_bits.append(f"saved ${trip['saved']:.2f}")
            edata["items"].append({
                "id": expense_id,
                "date": trip["date"],
                "amount": float(trip["total"]),
                "category": "Groceries",
                "comments": " · ".join(comments_bits),
                "receipt": receipt_rel,
                "source": "receipt_import",
            })
            store.write("expenses.json", edata)

        # Stamp expense_id back onto the trip so it's bi-directionally linked
        trip["expense_id"] = expense_id

        # Also register in expense_receipts.json so Money-tab receipt UI shows it
        emap = store.read("expense_receipts.json", {})
        emap[expense_id] = {"filename": filename.replace(".parsed.json", ""), "parsed": True}
        store.write("expense_receipts.json", emap)

        # Append to grocery_trips.json (or update matching date+store entry)
        tdata = store.read("grocery_trips.json", {"trips": []})
        merged = False
        for existing in tdata["trips"]:
            if existing.get("date") == trip["date"] and existing.get("store", "") == trip["store"] and not existing.get("line_items"):
                # Update placeholder trip with full data
                existing.update(trip)
                merged = True
                break
        if not merged:
            tdata["trips"].append(trip)
        store.write("grocery_trips.json", tdata)

        # Update kitchen catalog + pantry + purchase counts + aisles from chosen catalog_names
        gdata = store.read("kitchen.json", {"items": [], "category_map": {}, "pantry": {}})
        cat_map = gdata.setdefault("category_map", {})
        pantry = gdata.setdefault("pantry", {}) if update_pantry else {}
        counts = gdata.setdefault("purchase_counts", {})
        aisles = gdata.setdefault("aisles", {})
        last_bought = gdata.setdefault("last_bought", {})  # name -> YYYY-MM-DD
        trip_date = trip["date"]
        today = datetime.now().strftime("%Y-%m-%d")
        for s in included:
            cn = (s.get("catalog_name") or "").strip().lower()
            if not cn:
                continue
            cat_map[cn] = s.get("category", "other")
            counts[cn] = counts.get(cn, 0) + int(s.get("qty") or 1)
            last_bought[cn] = trip_date
            # Aisle: only set when provided (non-empty truthy int). Clearing not supported here.
            aisle_val = s.get("aisle")
            if aisle_val not in (None, "", 0):
                try:
                    aisles[cn] = int(aisle_val)
                except (TypeError, ValueError):
                    pass
            if update_pantry:
                pantry[cn] = {"added": today}
        store.write("kitchen.json", gdata)

        # Also patch kitchen_trips.json (the trip-log table) with totals so the
        # spend-trend view can use a single source of truth.
        ktdata = store.read("kitchen_trips.json", {"trips": []})
        patched = False
        for kt in ktdata["trips"]:
            if kt.get("date") == trip["date"]:
                kt["store"] = trip["store"]
                kt["total"] = trip["total"]
                kt["saved"] = trip["saved"]
                kt["items"] = trip["items"]
                kt["receipt"] = trip["receipt"]
                patched = True
                break
        if not patched:
            ktdata["trips"].append({
                "date": trip["date"],
                "store": trip["store"],
                "total": trip["total"],
                "saved": trip["saved"],
                "items": trip["items"],
                "receipt": trip["receipt"],
            })
            ktdata["trips"].sort(key=lambda t: t.get("date", ""))
        store.write("kitchen_trips.json", ktdata)

        # Learn new merchant rules (substring match → category + catalog_name)
        rules = shared.load_grocery_rules()
        learned = 0
        for lr in learn_rules:
            match = (lr.get("match") or "").strip().lower()
            category = (lr.get("category") or "").strip()
            catalog_name = (lr.get("catalog_name") or "").strip()
            if not match or not category:
                continue
            if any(p.get("match", "").lower() == match for p in rules["patterns"]):
                continue
            rules["patterns"].append({"match": match, "category": category, "catalog_name": catalog_name})
            learned += 1
        if learned:
            shared.save_grocery_rules(rules)

        # Mark the parsed file as imported
        path.with_suffix(".imported").write_text(today)

        return jsonify({
            "ok": True,
            "trip_items": len(included),
            "rules_learned": learned,
        })
