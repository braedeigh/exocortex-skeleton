"""Decisions ledger — every approval decision, appended for later learning.

Each staged change the user acts on (approve, edit-then-approve, or deny) writes
one JSON line here. The signal we care about long-term is the *diff* between what
a cricket proposed and what the user actually kept: that's how the system will one
day learn which category structures work for which people. Append-only, never
rewritten, so it stays a faithful record of every decision in order.

This is deliberately its own endpoint (not folded into /api/pending/approve|deny)
so the native per-kind editors — which commit through their OWN endpoints and then
just drop the queue entry — can log the real decision without us having to reverse
-engineer intent from a bare "deny".
"""
import json
import time
import fcntl

from flask import request, jsonify

import store

LEDGER = store.DATA_DIR / "decisions.jsonl"


def _differs(proposed, final):
    """True if the user changed any field the cricket proposed (added/dropped/edited).
    Computed server-side so `edited` is authoritative — not dependent on the client
    getting the diff right. Compared as strings so 3 == '3' etc."""
    if not isinstance(proposed, dict) or not isinstance(final, dict):
        return False
    for k in set(proposed) | set(final):
        pv = "" if proposed.get(k) is None else str(proposed.get(k))
        fv = "" if final.get(k) is None else str(final.get(k))
        if pv != fv:
            return True
    return False


def register(app):
    @app.route("/api/decisions/log", methods=["POST"])
    def log_decision():
        e = request.json or {}
        action = e.get("action")
        proposed = e.get("proposed")
        final = e.get("final")
        entry = {
            "ts": time.strftime("%Y-%m-%d %H:%M:%S"),
            "action": action,                 # "approve" | "deny"
            "kind": e.get("kind"),            # life_todo | contact | symptoms | food | ...
            "proposed": proposed,             # payload exactly as the cricket staged it
            "final": final,                   # what the user kept (approve only; null on deny)
            # Only meaningful on approve — a deny keeps nothing, so nothing was "edited".
            "edited": action == "approve" and _differs(proposed, final),
        }
        line = json.dumps(entry, ensure_ascii=False) + "\n"
        # Append under a lock so two workers can't interleave a half-line. Plain
        # append (not store.write) — this is a growing log, not a snapshot file.
        with open(LEDGER, "a") as f:
            fcntl.flock(f, fcntl.LOCK_EX)
            f.write(line)
        return jsonify({"ok": True})
