"""Research tables' HTTP door — the hazard map, the grids, and the owner's review.

What this file does: it serves the Tables page under the research tab
(frontend/src/features/research/TablesPage.tsx, shapes in types.ts) and takes
the owner's writes. Every read and write goes through hazardstore.py; this
module only turns requests into calls and ValueErrors into 400s.

    GET  /api/research/tables?topic=          -> {"tables", "vocab"}
    POST /api/research/tables/add             {name, kind, topic_id?, hazard?, measure?, foods?, note?}
    POST /api/research/tables/<id>/update     same fields, any subset
    POST /api/research/tables/<id>/delete
    GET  /api/research/tables/<id>?all=1      -> the grid (hazardstore.table_view)
    GET  /api/research/hazards                -> {"hazards": [...]}
    POST /api/research/hazards/add            {name, parents?, note?, aliases?}
    POST /api/research/hazards/seed           plant the starter map (empty map only)
    POST /api/research/hazards/<id>/update    {name?, note?, parents?, aliases?}
    POST /api/research/hazards/<id>/delete
    GET  /api/research/measures/<id>          -> one number with its source and history
    POST /api/research/measures/<id>/review   {review: unreviewed|confirmed|disputed}
    GET  /api/research/judgments/<id>         -> one verdict with its grounds and history
    POST /api/research/judgments/<id>/review  {review}
    POST /api/research/judgments/set          {food, lens, verdict, hazard?, reasoning?}

What the owner writes here is hers (author 'owner') and so born confirmed;
the agents write through scripts/research_tables.py instead, and theirs arrive
unreviewed. No feature gate — like the claims routes, these are her own reads
and writes; the auth gate in server.py closes them to visitors.

Prompt that produced this file: "I want my research tool to be able to create
sql tables … I want the agents to fill the table but I want it to mark it as
reviewed by me or not … and a judgment table for buy organic or not based on
health specifically. Sustainability would be another one."
"""
from flask import jsonify, request

import hazardstore


def _vocab():
    """The words the page offers in its pickers, so it never hardcodes them."""
    return {
        "measures": list(hazardstore.MEASURES),
        "units": hazardstore.MEASURES,
        "lenses": list(hazardstore.LENSES),
        "verdicts": hazardstore.VERDICTS,
        "reviews": list(hazardstore.REVIEWS),
        "food_sets": list(hazardstore.FOOD_SETS),
        "kinds": list(hazardstore.TABLE_KINDS),
    }


def _refused(exc):
    return jsonify({"error": str(exc)}), 400


def _not_found():
    return jsonify({"error": "not found"}), 404


def register(app):

    # --- the tables she directs -------------------------------------------------

    @app.route("/api/research/tables")
    def research_tables_list():
        topic = request.args.get("topic") or None
        return jsonify({"tables": hazardstore.list_tables(topic), "vocab": _vocab()})

    @app.route("/api/research/tables/add", methods=["POST"])
    def research_tables_add():
        body = request.json or {}
        try:
            table_id = hazardstore.add_table(
                body.get("name"), body.get("kind") or "measures",
                topic_id=body.get("topic_id"), hazard=body.get("hazard"),
                measure=body.get("measure") or None, foods=body.get("foods") or "all",
                note=body.get("note"))
        except ValueError as exc:
            return _refused(exc)
        return jsonify(hazardstore.table_view(table_id))

    @app.route("/api/research/tables/<int:table_id>/update", methods=["POST"])
    def research_tables_update(table_id):
        body = request.json or {}
        allowed = ("name", "topic_id", "hazard", "measure", "foods", "note")
        try:
            hazardstore.update_table(table_id, **{k: body[k] for k in allowed if k in body})
        except ValueError as exc:
            return _refused(exc)
        return jsonify(hazardstore.table_view(table_id))

    @app.route("/api/research/tables/<int:table_id>/delete", methods=["POST"])
    def research_tables_delete(table_id):
        try:
            hazardstore.delete_table(table_id)
        except ValueError:
            return _not_found()
        return jsonify({"ok": True})

    @app.route("/api/research/tables/<int:table_id>")
    def research_tables_view(table_id):
        view = hazardstore.table_view(table_id, all_foods=request.args.get("all") == "1")
        return jsonify(view) if view is not None else _not_found()

    # --- the hazard map -----------------------------------------------------------

    @app.route("/api/research/hazards")
    def research_hazards():
        return jsonify({"hazards": hazardstore.hazard_map()})

    @app.route("/api/research/hazards/add", methods=["POST"])
    def research_hazards_add():
        body = request.json or {}
        try:
            hazardstore.add_hazard(body.get("name"), parents=body.get("parents") or (),
                                   note=body.get("note"), aliases=body.get("aliases") or ())
        except ValueError as exc:
            return _refused(exc)
        return jsonify({"hazards": hazardstore.hazard_map()})

    @app.route("/api/research/hazards/seed", methods=["POST"])
    def research_hazards_seed():
        # The starter families, for an empty map only; a map with anything
        # on it is left exactly as it is.
        hazardstore.seed_starter_map()
        return jsonify({"hazards": hazardstore.hazard_map()})

    @app.route("/api/research/hazards/<int:hazard_id>/update", methods=["POST"])
    def research_hazards_update(hazard_id):
        body = request.json or {}
        allowed = ("name", "note", "parents", "aliases")
        try:
            hazardstore.update_hazard(hazard_id, **{k: body[k] for k in allowed if k in body})
        except ValueError as exc:
            return _refused(exc)
        return jsonify({"hazards": hazardstore.hazard_map()})

    @app.route("/api/research/hazards/<int:hazard_id>/delete", methods=["POST"])
    def research_hazards_delete(hazard_id):
        try:
            hazardstore.delete_hazard(hazard_id)
        except ValueError as exc:
            return _refused(exc)
        return jsonify({"hazards": hazardstore.hazard_map()})

    # --- one number, one verdict, and her review of each ----------------------------

    @app.route("/api/research/measures/<int:measure_id>")
    def research_measure(measure_id):
        detail = hazardstore.measure_detail(measure_id)
        return jsonify(detail) if detail is not None else _not_found()

    @app.route("/api/research/measures/<int:measure_id>/review", methods=["POST"])
    def research_measure_review(measure_id):
        if hazardstore.measure_detail(measure_id) is None:
            return _not_found()
        try:
            hazardstore.review_measure(measure_id, (request.json or {}).get("review"))
        except ValueError as exc:
            return _refused(exc)
        return jsonify(hazardstore.measure_detail(measure_id))

    @app.route("/api/research/judgments/<int:judgment_id>")
    def research_judgment(judgment_id):
        detail = hazardstore.judgment_detail(judgment_id)
        return jsonify(detail) if detail is not None else _not_found()

    @app.route("/api/research/judgments/<int:judgment_id>/review", methods=["POST"])
    def research_judgment_review(judgment_id):
        if hazardstore.judgment_detail(judgment_id) is None:
            return _not_found()
        try:
            hazardstore.review_judgment(judgment_id, (request.json or {}).get("review"))
        except ValueError as exc:
            return _refused(exc)
        return jsonify(hazardstore.judgment_detail(judgment_id))

    @app.route("/api/research/judgments/set", methods=["POST"])
    def research_judgment_set():
        # Her own verdict, which overrides an agent's on the same food, lens
        # and hazard; the agent's version is kept in the history. Grounds are
        # left as they were unless she sends a list.
        body = request.json or {}
        try:
            judgment_id, _ = hazardstore.judge(
                body.get("food"), body.get("lens"), body.get("verdict"),
                hazard=body.get("hazard"), reasoning=body.get("reasoning"),
                grounds=body.get("grounds"), author="owner")
        except ValueError as exc:
            return _refused(exc)
        return jsonify(hazardstore.judgment_detail(judgment_id))
