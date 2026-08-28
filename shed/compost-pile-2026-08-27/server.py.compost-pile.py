# Sections cut from server.py by the shed (see SHED.md). Each block's header
# says where it sat; put them back there on restore, and add the five names
# (car, meditation, housing, movement, travel) back to the `from routes import (...)` list.

# ---- server.py: _load_car() — among the _load_* helpers above _load_media() ----
def _load_car():
    return store.read("car_maintenance.json", {"entries": []})

# ---- server.py: _load_car_notes() — among the _load_* helpers above _load_media() ----
def _load_car_notes():
    return store.read("car_notes.json", {"text": ""})

# ---- server.py: _load_meditation() — among the _load_* helpers above _load_media() ----
def _load_meditation():
    return store.read("meditation_log.json", {"entries": []})

# ---- server.py: _load_deity_profiles() — among the _load_* helpers above _load_media() ----
def _load_deity_profiles():
    return store.read("deity_profiles.json", {"profiles": []})

# ---- server.py: _load_meditation_notes() — among the _load_* helpers above _load_media() ----
def _load_meditation_notes():
    return store.read("meditation_notes.json", {"text": ""})

# ---- server.py: _load_movement() — among the _load_* helpers above _load_media() ----
def _load_movement():
    return store.read("movement.json", {"routines": []})

# ---- server.py: /api/data/car handler — among the /api/data/<tab> handlers ----
@app.route("/api/data/car")
def get_data_car():
  try:
    data = _common_data()
    data.update({
        "car_maintenance": _load_car(),
        "car_notes": _load_car_notes(),
    })
    data["dev_notes"] = _load_dev_notes().get("tabs", {}).get("car", [])
    data["idea_notes"] = _load_idea_notes().get("tabs", {}).get("car", [])
    data["tab_todos"] = todos_for_tab("car")
    return jsonify(filter_for_view(data, request.view_mode))
  except Exception as e:
    app.logger.error(f"/api/data/car failed: {e}\n{traceback.format_exc()}")
    return jsonify({"error": str(e)}), 500

# ---- server.py: /api/data/housing handler — among the /api/data/<tab> handlers ----
@app.route("/api/data/housing")
def get_data_housing():
  try:
    data = _common_data()
    data["housing"] = store.read("housing.json", {"entries": [], "notes": ""})
    data["dev_notes"] = _load_dev_notes().get("tabs", {}).get("housing", [])
    data["idea_notes"] = _load_idea_notes().get("tabs", {}).get("housing", [])
    data["tab_todos"] = todos_for_tab("housing")
    return jsonify(filter_for_view(data, request.view_mode))
  except Exception as e:
    app.logger.error(f"/api/data/housing failed: {e}\n{traceback.format_exc()}")
    return jsonify({"error": str(e)}), 500

# ---- server.py: /api/data/meditation handler — among the /api/data/<tab> handlers ----
@app.route("/api/data/meditation")
def get_data_meditation():
  try:
    data = _common_data()
    data.update({
        "meditation_log": _load_meditation(),
        "meditation_notes": _load_meditation_notes(),
        "deity_profiles": _load_deity_profiles(),
    })
    data["dev_notes"] = _load_dev_notes().get("tabs", {}).get("meditation", [])
    data["idea_notes"] = _load_idea_notes().get("tabs", {}).get("meditation", [])
    data["tab_todos"] = todos_for_tab("meditation")
    return jsonify(filter_for_view(data, request.view_mode))
  except Exception as e:
    app.logger.error(f"/api/data/meditation failed: {e}\n{traceback.format_exc()}")
    return jsonify({"error": str(e)}), 500

# ---- server.py: /api/data/movement handler — among the /api/data/<tab> handlers ----
@app.route("/api/data/movement")
def get_data_movement():
  try:
    data = _common_data()
    data.update({
        "movement": _load_movement(),
    })
    data["dev_notes"] = _load_dev_notes().get("tabs", {}).get("movement", [])
    data["idea_notes"] = _load_idea_notes().get("tabs", {}).get("movement", [])
    data["tab_todos"] = todos_for_tab("movement")
    return jsonify(filter_for_view(data, request.view_mode))
  except Exception as e:
    app.logger.error(f"/api/data/movement failed: {e}\n{traceback.format_exc()}")
    return jsonify({"error": str(e)}), 500

# ---- server.py: car.register(app) — in the register block at the bottom ----
car.register(app)

# ---- server.py: housing.register(app) — in the register block at the bottom ----
housing.register(app)

# ---- server.py: meditation.register(app) — in the register block at the bottom ----
meditation.register(app)

# ---- server.py: movement.register(app) — in the register block at the bottom ----
movement.register(app)

# ---- server.py: travel.register(app) — in the register block at the bottom ----
travel.register(app)
