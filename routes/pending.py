"""Pending dashboard changes — the approval gate.

When an agent proposes a change it gets *staged* into pending_changes.json (by the
`add-todo --stage` Rust tool, or any future stager). The browser's 5s poll reads
GET /api/pending, and if anything's waiting it pops a modal over whatever pane is
open. The user taps Approve (commit it for real) or Deny (discard it). Nothing
reaches the real dashboard data until Approve runs here.

Commit is delegated back to the Rust binary (no --stage) so there is exactly ONE
writer of build_todos.json — the validated "narrow door" stays the only way in.
"""
from pathlib import Path
import subprocess

from flask import request, jsonify

import store

PENDING_FILE = "pending_changes"  # -> data/pending_changes.json
_EMPTY = {"pending": []}

# The validated write tool. Lives in this same repo under tools/.
ADD_TODO_BIN = Path(__file__).resolve().parent.parent / "tools" / "add-todo" / "target" / "release" / "add-todo"

# Life-todo tags are front ids (fronts.json) since 2026-07-14. Staged payloads
# may still carry the pre-fronts theme vocabulary — translate at the gate.
# life/admin were junk-drawer tags: they map to untagged, not to a front.
_LEGACY_FRONTS = {"life": None, "admin": None, "move": "living-space"}


def _commit(change):
    """Apply an approved change to the real dashboard data. Raises on failure
    so the caller leaves the item in the queue (nothing is silently lost)."""
    kind = change.get("kind")
    payload = change.get("payload") or {}
    data_dir = str(store.DATA_DIR)
    if kind == "todo":
        cmd = [str(ADD_TODO_BIN), "build",
               "--text", payload["text"],
               "--theme", payload["theme"],
               "--data-dir", data_dir]
        if payload.get("source"):
            cmd += ["--source", payload["source"]]
    elif kind == "life_todo":
        front = (payload.get("category") or "").strip() or None
        if front in _LEGACY_FRONTS:
            front = _LEGACY_FRONTS[front]
        cmd = [str(ADD_TODO_BIN), "life",
               "--text", payload["text"],
               "--bucket", payload.get("bucket", "now"),
               "--data-dir", data_dir]
        if front:
            cmd += ["--category", front]
    elif kind == "life_remove":
        cmd = [str(ADD_TODO_BIN), "life", "--remove",
               "--id", payload["id"],
               "--data-dir", data_dir]
    else:
        raise ValueError(f"unknown change kind: {kind!r}")
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "add-todo failed")


def register(app):
    @app.route("/api/pending", methods=["GET"])
    def get_pending():
        return jsonify(store.read(PENDING_FILE, dict(_EMPTY)))

    @app.route("/api/pending/approve", methods=["POST"])
    def approve_pending():
        req = request.json or {}
        pid = req.get("id")
        edited = req.get("payload")  # the modal sends back the (possibly edited) fields
        if not pid:
            return jsonify({"ok": False, "error": "missing id"}), 400
        # Hold the lock across find -> commit -> remove. If _commit raises, the
        # mutate block exits via exception and never writes back, so the item
        # stays queued for a retry instead of vanishing.
        with store.mutate(PENDING_FILE, dict(_EMPTY)) as data:
            change = next((p for p in data["pending"] if p.get("id") == pid), None)
            if change is None:
                return jsonify({"ok": False, "error": "not found"}), 404
            # Apply the user's edits over the staged payload before committing, so
            # what she approves is exactly what she sees in the modal.
            if isinstance(edited, dict):
                change["payload"] = {**(change.get("payload") or {}), **edited}
            _commit(change)
            data["pending"] = [p for p in data["pending"] if p.get("id") != pid]
        return jsonify({"ok": True})

    @app.route("/api/pending/deny", methods=["POST"])
    def deny_pending():
        pid = (request.json or {}).get("id")
        if not pid:
            return jsonify({"ok": False, "error": "missing id"}), 400
        with store.mutate(PENDING_FILE, dict(_EMPTY)) as data:
            data["pending"] = [p for p in data["pending"] if p.get("id") != pid]
        return jsonify({"ok": True})
