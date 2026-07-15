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

# The validated write tools. Both live in this same repo under tools/.
ADD_TODO_BIN = Path(__file__).resolve().parent.parent / "tools" / "add-todo" / "target" / "release" / "add-todo"
THREAD_BIN = Path(__file__).resolve().parent.parent / "tools" / "thread" / "target" / "release" / "thread"

# Life-todo tags are front ids (fronts.json) since 2026-07-14, carried as a
# `fronts` list (`category`, a single string, accepted as the legacy alias).
# Staged payloads may still carry the pre-fronts theme vocabulary — translate
# at the gate. life/admin were junk-drawer tags: they map to untagged.
_LEGACY_FRONTS = {"life": None, "admin": None, "move": "living-space"}


def _payload_fronts(payload):
    """Front ids from a life_todo payload, legacy-translated and deduped."""
    raw = payload.get("fronts")
    if not isinstance(raw, list):
        raw = [payload.get("category")]
    out = []
    for f in raw:
        f = (str(f) if f is not None else "").strip() or None
        if f in _LEGACY_FRONTS:
            f = _LEGACY_FRONTS[f]
        if f and f not in out:
            out.append(f)
    return out


def _run_thread(args):
    """Shell to THREAD_BIN — the single writer of Threads/*.md
    (threads-architecture.md §5/§8). Same fail-loud pattern as ADD_TODO_BIN
    below: nonzero exit -> RuntimeError with stderr, so a caller mid-sequence
    (thread_open's cards loop) stops immediately and the item stays queued."""
    cmd = [str(THREAD_BIN), *args,
           "--content-dir", str(store.CONTENT_DIR), "--data-dir", str(store.DATA_DIR)]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "thread failed")


def _card_sources(card):
    """A card's `source` may be a single string or a list — always give back
    a list, so the caller can pass one `--source` flag per entry."""
    src = card.get("source")
    if src is None:
        return []
    if isinstance(src, list):
        return src
    return [src]


def _commit(change):
    """Apply an approved change to the real dashboard data. Raises on failure
    so the caller leaves the item in the queue (nothing is silently lost)."""
    kind = change.get("kind")
    payload = change.get("payload") or {}
    data_dir = str(store.DATA_DIR)
    if kind == "thread_open":
        args = ["open", "--slug", payload["slug"], "--name", payload["name"],
                "--fronts", ",".join(payload.get("fronts") or []),
                "--kind", payload.get("kind", "")]
        if payload.get("parents"):
            args += ["--parents", ",".join(payload["parents"])]
        if payload.get("aliases"):
            args += ["--aliases", ",".join(payload["aliases"])]
        _run_thread(args)
        # Cards were already validated at propose time by the Rust binary, so
        # this normally just lands them. Known edge: if a card's source was
        # deleted between staging and approval, add-card fails here — the
        # thread file already exists (from `open`, above) with whatever cards
        # made it in before the failure, and we raise so this item stays
        # queued. A re-approve will then fail on "exists" (open refuses to
        # overwrite), so the right move at that point is deny — the owning
        # cricket picks the missed material back up through the thread's
        # inbox on its next pass, no data lost.
        for card in payload.get("cards") or []:
            card_args = ["add-card", "--slug", payload["slug"],
                         "--section", card["section"], "--text", card["text"]]
            for source in _card_sources(card):
                card_args += ["--source", source]
            _run_thread(card_args)
        return
    elif kind == "thread_link":
        args = ["link", "--slug", payload["slug"]]
        for f in payload.get("add_fronts") or []:
            args += ["--add-front", f]
        for f in payload.get("remove_fronts") or []:
            args += ["--remove-front", f]
        for p in payload.get("add_parents") or []:
            args += ["--add-parent", p]
        for p in payload.get("remove_parents") or []:
            args += ["--remove-parent", p]
        _run_thread(args)
        return
    elif kind == "thread_retire":
        _run_thread(["set-status", payload["slug"], "retired"])
        return
    elif kind == "todo":
        cmd = [str(ADD_TODO_BIN), "build",
               "--text", payload["text"],
               "--theme", payload["theme"],
               "--data-dir", data_dir]
        if payload.get("source"):
            cmd += ["--source", payload["source"]]
    elif kind == "life_todo":
        fronts = _payload_fronts(payload)
        cmd = [str(ADD_TODO_BIN), "life",
               "--text", payload["text"],
               "--bucket", payload.get("bucket", "now"),
               "--data-dir", data_dir]
        if fronts:
            cmd += ["--category", ",".join(fronts)]
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
