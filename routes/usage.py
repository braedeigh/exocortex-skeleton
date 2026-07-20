"""Feature-usage tracking — how often the app's features actually get used.

One collection, feature_usage.json, holds both data sources keyed by day:

    {"days": {"2026-07-20": {"api": {"habits": {"reads": 3, "writes": 1}},
                             "tabs": {"habits": 4}}}}

The "tabs" half is written live by the beacon below (the frontend pings it on
tab switches). The "api" half is back-filled for past days by
scripts/usage_rollup.py, which folds the access log's per-request lines into
per-feature read/write counts. The two writers never touch each other's key.
"""
import re
from datetime import datetime

from flask import request, jsonify

import store

_TAB_RE = re.compile(r"^[a-z0-9_-]{1,40}$")


def register(app):

    @app.route("/api/usage/tab", methods=["POST"])
    def usage_tab_beacon():
        body = request.json or {}
        tab = str(body.get("tab") or "")
        if not _TAB_RE.match(tab):
            return jsonify({"error": "invalid tab name"}), 400
        today = datetime.now().strftime("%Y-%m-%d")
        with store.mutate("feature_usage.json", {"days": {}}) as data:
            day = data.setdefault("days", {}).setdefault(today, {})
            tabs = day.setdefault("tabs", {})
            tabs[tab] = tabs.get(tab, 0) + 1
        return jsonify({"ok": True})

    @app.route("/api/usage")
    def usage_get():
        return jsonify(store.read("feature_usage.json", {"days": {}}))
