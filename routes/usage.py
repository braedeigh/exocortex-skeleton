"""Feature-usage tracking — how often the app's features actually get used.

One collection, feature_usage.json, holds all data sources keyed by day:

    {"days": {"2026-07-20": {"api": {"habits": {"reads": 3, "writes": 1}},
                             "tabs": {"habits": 4},
                             "time": {"habits": 84},
                             "clicks": {"habits": {"card-edit": 3}},
                             "store": {"gunicorn": {"todos": {"reads": 40,
                                                              "writes": 2}}}}}}

The "tabs" key is written live by the beacon below (the frontend pings it on
tab switches). The "time" (seconds of dwell per tab) and "clicks" (per-page
control click counts) keys are written by the batch endpoint below, which the
frontend flushes to periodically. The "api" key is back-filled for past days
by scripts/usage_rollup.py, which folds the access log's per-request lines
into per-feature read/write counts. The "store" key is flushed periodically
by store.py's op counters — per-caller, per-collection read/write counts
measured at the data seam itself. The five writers never touch each other's
keys.

GET /api/usage/export packages the collection as a downloadable JSON bundle
(schema "usage-export/1"). Exports are read-only snapshots — nothing in the
collection changes. The consent model is deliberate: the file lands on the
user's own device and stays there; sharing it with anyone is a separate,
deliberate act by the user. The server never adds a name, domain, or any
other identity to the bundle — the optional ``label`` query param is a
self-chosen handle stored verbatim, nothing more.
"""
import re
from datetime import date, datetime, timedelta

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

    @app.route("/api/usage/export")
    def usage_export():
        """The whole collection as a downloadable snapshot bundle.

        Optional ``days=N`` keeps only the trailing N-day window (today
        included); optional ``label=`` is stored verbatim (truncated to 80
        chars) as the person's self-chosen handle. No identity is ever added
        server-side.
        """
        raw_days = request.args.get("days")
        window = None
        if raw_days is not None:
            try:
                window = int(raw_days)
            except (TypeError, ValueError):
                return jsonify({"error": '"days" must be a positive integer'}), 400
            if window < 1:
                return jsonify({"error": '"days" must be a positive integer'}), 400

        today = datetime.now().strftime("%Y-%m-%d")
        days = store.read("feature_usage.json", {"days": {}}).get("days", {})
        if window is not None:
            start = (date.fromisoformat(today) - timedelta(days=window - 1)).isoformat()
            days = {d: day for d, day in days.items() if start <= d <= today}

        covered = sorted(days)
        bundle = {
            "schema": "usage-export/1",
            "generated": today,
            "range": {"from": covered[0] if covered else None,
                      "to": covered[-1] if covered else None},
            "days": days,
        }
        label = request.args.get("label")
        if label:
            bundle["label"] = label[:80]

        resp = jsonify(bundle)
        resp.headers["Content-Type"] = "application/json"
        resp.headers["Content-Disposition"] = (
            f'attachment; filename="usage-export-{today}.json"')
        return resp
