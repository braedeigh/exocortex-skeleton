"""Health, HRT, supplements, contacts, food, symptoms, runs, activity, and meetings routes."""
from flask import request, jsonify
from datetime import datetime, timedelta
from data_helpers import DATA_DIR, CONTENT_DIR
import pandas as pd
import store


def _activity_log_add(date, atype):
    """Add (date, type) to activity_log.json if not already present."""
    with store.mutate("activity_log.json", {"entries": []}) as adata:
        if not any(e["date"] == date and e["type"] == atype for e in adata["entries"]):
            adata["entries"].append({"date": date, "type": atype})
            adata["entries"].sort(key=lambda e: e["date"])


def _activity_log_remove(date, atype):
    if not (DATA_DIR / "activity_log.json").exists():
        return
    with store.mutate("activity_log.json") as adata:
        adata["entries"] = [e for e in adata["entries"] if not (e["date"] == date and e["type"] == atype)]


def register(app):

    # --- HRT ---

    @app.route("/api/hrt/done", methods=["POST"])
    def hrt_done():
        hrt = store.read("hrt.json")
        hrt["prev_last_dose"] = hrt.get("last_dose")
        hrt["prev_next_due"] = hrt.get("next_due")
        data = request.json or {}
        dose_date = data.get("date") or datetime.now().strftime("%Y-%m-%d")
        cycle = hrt.get("cycle_days", 5)
        dose_dt = datetime.strptime(dose_date, "%Y-%m-%d")
        next_due = (dose_dt + timedelta(days=cycle)).strftime("%Y-%m-%d")
        hrt["last_dose"] = dose_date
        hrt["next_due"] = next_due
        store.write("hrt.json", hrt)
        _activity_log_add(dose_date, "estradiol")
        return jsonify({"ok": True, "next_due": next_due})

    @app.route("/api/hrt/cycle", methods=["POST"])
    def hrt_cycle():
        """Update the estradiol injection cycle length (managed from the reminders
        manager). Re-derives next_due from the existing last_dose so the schedule
        stays anchored to the real last shot."""
        data = request.json or {}
        try:
            cycle = int(data.get("cycle_days"))
        except (TypeError, ValueError):
            return jsonify({"error": "cycle_days must be a number"}), 400
        if cycle < 1:
            return jsonify({"error": "cycle_days must be >= 1"}), 400
        hrt = store.read("hrt.json", {})
        hrt["cycle_days"] = cycle
        if hrt.get("last_dose"):
            last_dt = datetime.strptime(hrt["last_dose"], "%Y-%m-%d")
            hrt["next_due"] = (last_dt + timedelta(days=cycle)).strftime("%Y-%m-%d")
        store.write("hrt.json", hrt)
        return jsonify({"ok": True})

    @app.route("/api/hrt/undo", methods=["POST"])
    def hrt_undo():
        hrt = store.read("hrt.json")
        if hrt.get("prev_last_dose") is not None:
            undone_dose = hrt.get("last_dose")
            hrt["last_dose"] = hrt.pop("prev_last_dose")
            hrt["next_due"] = hrt.pop("prev_next_due")
            store.write("hrt.json", hrt)
            if undone_dose:
                _activity_log_remove(undone_dose, "estradiol")
            return jsonify({"ok": True})
        return jsonify({"error": "Nothing to undo"}), 400

    # --- Contacts ---

    @app.route("/api/contacts/log", methods=["POST"])
    def log_contact():
        data = request.json
        name = data["name"]
        method = data.get("method")
        cdata = store.read("contacts.json")
        date = data.get("date") or datetime.now().strftime("%Y-%m-%d")
        for c in cdata["contacts"]:
            if c["name"] == name:
                if not c["last_contact"] or date >= c["last_contact"]:
                    c["last_contact"] = date
                    c["method"] = method
                if "history" not in c:
                    c["history"] = []
                c["history"] = [h for h in c["history"] if h["date"] != date]
                c["history"].append({"date": date, "method": method})
                break
        store.write("contacts.json", cdata)
        return jsonify({"ok": True})

    @app.route("/api/contacts/add", methods=["POST"])
    def add_contact():
        data = request.json
        name = data["name"].strip()
        threshold = data.get("threshold_days", 14)
        cdata = store.read("contacts.json")
        if any(c["name"].lower() == name.lower() for c in cdata["contacts"]):
            return jsonify({"error": "Contact already exists"}), 400
        cdata["contacts"].append({
            "name": name,
            "threshold_days": threshold,
            "last_contact": None,
            "method": None,
        })
        store.write("contacts.json", cdata)
        return jsonify({"ok": True})

    @app.route("/api/contacts/update", methods=["POST"])
    def update_contact():
        """Edit a contact's reminder cadence (threshold_days), and optionally rename."""
        data = request.json or {}
        name = data.get("name")
        if not name:
            return jsonify({"error": "missing name"}), 400
        cdata = store.read("contacts.json")
        target = next((c for c in cdata["contacts"] if c["name"] == name), None)
        if target is None:
            return jsonify({"error": "not found"}), 404
        if "threshold_days" in data:
            try:
                t = int(data["threshold_days"])
            except (TypeError, ValueError):
                return jsonify({"error": "threshold_days must be a number"}), 400
            if t < 1:
                return jsonify({"error": "threshold_days must be >= 1"}), 400
            target["threshold_days"] = t
        if "new_name" in data:
            new_name = (data.get("new_name") or "").strip()
            if not new_name:
                return jsonify({"error": "name cannot be empty"}), 400
            if any(c is not target and c["name"].lower() == new_name.lower() for c in cdata["contacts"]):
                return jsonify({"error": "a contact with that name already exists"}), 400
            target["name"] = new_name
        store.write("contacts.json", cdata)
        return jsonify({"ok": True})

    @app.route("/api/contacts/reorder", methods=["POST"])
    def reorder_contacts():
        """Reorder the contacts list to match the given list of names."""
        data = request.json or {}
        order = data.get("order")
        if not isinstance(order, list):
            return jsonify({"error": "order list required"}), 400
        cdata = store.read("contacts.json")
        by_name = {c["name"]: c for c in cdata.get("contacts", [])}
        reordered = [by_name[n] for n in order if n in by_name]
        # Keep any contacts not mentioned in `order` (appended in original order)
        reordered += [c for c in cdata.get("contacts", []) if c["name"] not in set(order)]
        cdata["contacts"] = reordered
        store.write("contacts.json", cdata)
        return jsonify({"ok": True})

    @app.route("/api/contacts/remove", methods=["POST"])
    def remove_contact():
        data = request.json
        name = data["name"]
        cdata = store.read("contacts.json")
        cdata["contacts"] = [c for c in cdata["contacts"] if c["name"] != name]
        store.write("contacts.json", cdata)
        return jsonify({"ok": True})

    @app.route("/api/contacts/history/remove", methods=["POST"])
    def remove_contact_history():
        data = request.json
        name = data["name"]
        date = data["date"]
        method = data.get("method")
        cdata = store.read("contacts.json")
        for c in cdata["contacts"]:
            if c["name"] == name:
                history = c.get("history", [])
                for i in range(len(history) - 1, -1, -1):
                    if history[i]["date"] == date and (method is None or history[i]["method"] == method):
                        history.pop(i)
                        break
                c["history"] = history
                if history:
                    latest = max(history, key=lambda h: h["date"])
                    c["last_contact"] = latest["date"]
                    c["method"] = latest["method"]
                else:
                    c["last_contact"] = None
                    c["method"] = None
                break
        store.write("contacts.json", cdata)
        return jsonify({"ok": True})

    # --- Meetings ---

    @app.route("/api/meeting/<filename>")
    def get_meeting(filename):
        filepath = CONTENT_DIR / "meetings" / filename
        if not filepath.exists():
            return jsonify({"error": "Not found"}), 404
        return jsonify({"content": filepath.read_text()})

    # --- Food ---

    @app.route("/api/food/log", methods=["POST"])
    def log_food():
        data = request.json
        csv_path = CONTENT_DIR / "habits.csv"
        target_date = data.get("date") or datetime.now().strftime("%Y-%m-%d")
        food = data["food"].strip()
        df = pd.read_csv(csv_path)
        df["date"] = pd.to_datetime(df["date"], format="mixed")
        target = pd.Timestamp(target_date)
        mask = df["date"] == target
        if mask.any():
            existing = df.loc[mask, "food_notes"].iloc[0]
            if pd.notna(existing) and str(existing).strip():
                df.loc[mask, "food_notes"] = str(existing) + "; " + food
            else:
                df.loc[mask, "food_notes"] = food
        else:
            new_row = {"date": target_date, "food_notes": food}
            df = pd.concat([df, pd.DataFrame([new_row])], ignore_index=True)
        df.to_csv(csv_path, index=False)
        return jsonify({"ok": True})

    @app.route("/api/food/set", methods=["POST"])
    def set_food():
        # Replace (not append) the food notes for a given date — used by the
        # day editor to correct/clear a past day's food log.
        data = request.json
        csv_path = CONTENT_DIR / "habits.csv"
        target_date = data.get("date") or datetime.now().strftime("%Y-%m-%d")
        food = (data.get("food_notes") or "").strip()
        df = pd.read_csv(csv_path)
        df["date"] = pd.to_datetime(df["date"], format="mixed")
        target = pd.Timestamp(target_date)
        mask = df["date"] == target
        if mask.any():
            df.loc[mask, "food_notes"] = food if food else pd.NA
        elif food:
            df = pd.concat([df, pd.DataFrame([{"date": target, "food_notes": food}])], ignore_index=True)
        df["date"] = pd.to_datetime(df["date"], format="mixed").dt.strftime("%Y-%m-%d")
        df.to_csv(csv_path, index=False)
        return jsonify({"ok": True})

    # --- Symptoms ---

    @app.route("/api/symptoms", methods=["POST"])
    def log_symptoms():
        data = request.json
        csv_path = CONTENT_DIR / "habits.csv"
        target_date = data["date"]
        symptoms = data["symptoms"]
        df = pd.read_csv(csv_path)
        df["date"] = pd.to_datetime(df["date"], format="mixed")
        target = pd.Timestamp(target_date)
        mask = df["date"] == target
        if mask.any():
            for col, val in symptoms.items():
                df.loc[mask, col] = val
        else:
            new_row = {"date": target}
            new_row.update(symptoms)
            df = pd.concat([df, pd.DataFrame([new_row])], ignore_index=True)
        df["date"] = pd.to_datetime(df["date"], format="mixed").dt.strftime("%Y-%m-%d")
        df.to_csv(csv_path, index=False)
        return jsonify({"ok": True})

    # --- Symptom tier definitions (what 0/1/2/3 mean per symptom) ---

    @app.route("/api/symptom-definitions", methods=["GET"])
    def get_symptom_definitions():
        return jsonify(store.read("symptom_definitions.json", {}))

    @app.route("/api/symptom-definitions", methods=["POST"])
    def save_symptom_definitions():
        body = request.json or {}
        defs = body.get("definitions")
        if not isinstance(defs, dict):
            return jsonify({"error": "definitions object required"}), 400
        # Keep only non-empty strings, nested {symptom: {level: text}}
        clean = {}
        for sym, levels in defs.items():
            if not isinstance(levels, dict):
                continue
            kept = {str(k): str(v).strip() for k, v in levels.items() if str(v).strip()}
            if kept:
                clean[sym] = kept
        store.write("symptom_definitions.json", clean)
        return jsonify({"ok": True})

    # --- Runs ---

    @app.route("/api/runs/log", methods=["POST"])
    def log_run():
        data = request.json
        date = data.get("date") or datetime.now().strftime("%Y-%m-%d")
        minutes = data.get("minutes")
        notes = data.get("notes", "").strip()
        rdata = store.read("runs.json", {"target_per_week": 3, "runs": []})
        rdata["runs"] = [r for r in rdata["runs"] if r["date"] != date]
        rdata["runs"].append({"date": date, "minutes": minutes, "notes": notes})
        rdata["runs"].sort(key=lambda r: r["date"])
        store.write("runs.json", rdata)
        return jsonify({"ok": True})

    @app.route("/api/runs/remove", methods=["POST"])
    def remove_run():
        data = request.json
        date = data["date"]
        rdata = store.read("runs.json")
        rdata["runs"] = [r for r in rdata["runs"] if r["date"] != date]
        store.write("runs.json", rdata)
        return jsonify({"ok": True})

    # --- Activity ---

    @app.route("/api/activity/log", methods=["POST"])
    def log_activity():
        data = request.json
        date = data.get("date") or datetime.now().strftime("%Y-%m-%d")
        atype = data["type"]
        adata = store.read("activity_log.json", {"entries": []})
        adata["entries"] = [e for e in adata["entries"] if not (e["date"] == date and e["type"] == atype)]
        adata["entries"].append({"date": date, "type": atype})
        adata["entries"].sort(key=lambda e: e["date"])
        store.write("activity_log.json", adata)
        return jsonify({"ok": True})

    @app.route("/api/activity/remove", methods=["POST"])
    def remove_activity():
        data = request.json
        date = data["date"]
        atype = data["type"]
        adata = store.read("activity_log.json")
        adata["entries"] = [e for e in adata["entries"] if not (e["date"] == date and e["type"] == atype)]
        store.write("activity_log.json", adata)
        return jsonify({"ok": True})
