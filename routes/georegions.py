"""World state/province outlines for the ecosystem map.

What this file does: serves the outlines of first-level regions (states,
provinces, departments) by ISO 3166-2 code, so the map can draw a proposal
from Peru's Junín or Mexico's Sinaloa as the region itself. The outlines are
Natural Earth's public-domain data from the commons, split per country by
georegions.py; this only reads them.

    GET /api/geo/regions?codes=PE-JUN,MX-SIN  -> GeoJSON FeatureCollection (unknown codes left out)

Public reference data, so it carries nothing of hers; server.py's auth gate
still covers it like every /api route.
"""
from flask import jsonify, request

import georegions

# The most codes one request may ask for — a map never needs more at once.
MAX_CODES = 200


def register(app):
    @app.route("/api/geo/regions")
    def geo_regions():
        codes = [c for c in (request.args.get("codes") or "").split(",") if c.strip()]
        response = jsonify(georegions.outlines(codes[:MAX_CODES]))
        # Borders don't change between requests; let the browser keep them.
        response.headers["Cache-Control"] = "private, max-age=86400"
        return response
