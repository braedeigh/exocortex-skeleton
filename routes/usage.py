"""Feature-usage tracking — how often the app's features actually get used.

One collection, feature_usage.json, holds all data sources keyed by day:

    {"days": {"2026-07-20": {"api": {"habits": {"reads": 3, "writes": 1}},
                             "tabs": {"habits": 4},
                             "time": {"habits": 84},
                             "clicks": {"habits": {"card-edit": 3}}}}}

The "tabs" key is written live by the beacon below (the frontend pings it on
tab switches). The "time" (seconds of dwell per tab) and "clicks" (per-page
control click counts) keys are written by the batch endpoint below, which the
frontend flushes to periodically. The "api" key is back-filled for past days
by scripts/usage_rollup.py, which folds the access log's per-request lines
into per-feature read/write counts. The four writers never touch each other's
keys.
"""
import re
from datetime import datetime

from flask import request, jsonify

import store

_TAB_RE = re.compile(r"^[a-z0-9_-]{1,40}$")
_CONTROL_RE = re.compile(r"^[a-z0-9:._-]{1,60}$")


def _valid_count(value, upper):
    """A plain int in 1..upper (bool is an int subclass — reject it)."""
    return isinstance(value, int) and not isinstance(value, bool) and 1 <= value <= upper


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

    @app.route("/api/usage/batch", methods=["POST"])
    def usage_batch():
        body = request.json or {}
        time_part = body.get("time", {})
        clicks_part = body.get("clicks", {})
        if not isinstance(time_part, dict):
            return jsonify({"error": '"time" must be an object'}), 400
        if not isinstance(clicks_part, dict):
            return jsonify({"error": '"clicks" must be an object'}), 400

        # Validate everything up front — a single bad item rejects the whole
        # batch and nothing is persisted.
        for tab, seconds in time_part.items():
            if not (isinstance(tab, str) and _TAB_RE.match(tab)):
                return jsonify({"error": f"invalid time tab name: {tab!r}"}), 400
            if not _valid_count(seconds, 86400):
                return jsonify({"error": f"invalid time value for {tab!r}: "
                                         "must be an int in 1..86400"}), 400
        for page, controls in clicks_part.items():
            if not (isinstance(page, str) and _TAB_RE.match(page)):
                return jsonify({"error": f"invalid clicks page name: {page!r}"}), 400
            if not isinstance(controls, dict):
                return jsonify({"error": f"clicks for {page!r} must be an object"}), 400
            for control, n in controls.items():
                if not (isinstance(control, str) and _CONTROL_RE.match(control)):
                    return jsonify({"error": f"invalid control name on {page!r}: "
                                             f"{control!r}"}), 400
                if not _valid_count(n, 10000):
                    return jsonify({"error": f"invalid click count for "
                                             f"{page!r}/{control!r}: "
                                             "must be an int in 1..10000"}), 400

        if time_part or clicks_part:
            today = datetime.now().strftime("%Y-%m-%d")
            with store.mutate("feature_usage.json", {"days": {}}) as data:
                day = data.setdefault("days", {}).setdefault(today, {})
                if time_part:
                    times = day.setdefault("time", {})
                    for tab, seconds in time_part.items():
                        times[tab] = times.get(tab, 0) + seconds
                if clicks_part:
                    clicks = day.setdefault("clicks", {})
                    for page, controls in clicks_part.items():
                        page_clicks = clicks.setdefault(page, {})
                        for control, n in controls.items():
                            page_clicks[control] = page_clicks.get(control, 0) + n
        return jsonify({"ok": True})

    @app.route("/api/usage")
    def usage_get():
        return jsonify(store.read("feature_usage.json", {"days": {}}))
