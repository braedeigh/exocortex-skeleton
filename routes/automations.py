"""Automations — the app-visible registry of recurring scheduled runs.

Recurring jobs (e.g. the 6 AM Morning Spark) are fired by the system crontab,
which the web app can't and shouldn't read or write directly. This registry
(scheduled_runs.json) is the app-owned MIRROR: each cron script writes its
last-run status back here, and this surface reads it so the owner can see what
runs, when it last ran, whether it succeeded, and open what it produced — plus
flip an `enabled` toggle the scripts honor, so a run can be paused from the UI
without touching cron.

Distinct from routes/terminal.py's /api/terminal/schedule* (one-off prompts
queued into a session, fired by prompt_dispatcher.py). Those are one-shots; the
runs here are the standing, recurring automations.
"""
from flask import jsonify

import store


def _load():
    return store.read("scheduled_runs.json", {"runs": []})


def register(app):

    @app.route("/api/automations")
    def automations_list():
        """The recurring-runs registry, newest last-run first."""
        data = _load()
        runs = data.get("runs", []) if isinstance(data, dict) else []
        runs = [r for r in runs if isinstance(r, dict)]
        runs.sort(key=lambda r: r.get("last_run") or "", reverse=True)
        return jsonify({"runs": runs})

    @app.route("/api/automations/<run_id>/toggle", methods=["POST"])
    def automations_toggle(run_id):
        """Pause/resume a run. The scripts read `enabled` at the top of their
        run and no-op when false — so this never has to touch the crontab."""
        data = _load()
        if not any(isinstance(r, dict) and r.get("id") == run_id
                   for r in data.get("runs", [])):
            return jsonify({"error": "unknown run"}), 404
        with store.mutate("scheduled_runs.json", {"runs": []}) as data:
            state = None
            for r in data.get("runs", []):
                if isinstance(r, dict) and r.get("id") == run_id:
                    r["enabled"] = not r.get("enabled", True)
                    state = r["enabled"]
        return jsonify({"ok": True, "id": run_id, "enabled": state})
