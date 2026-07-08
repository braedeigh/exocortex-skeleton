"""Journal cards — read/edit/delete over the stream-cards pool.

Cards are one-markdown-file-per-utterance in the vault
(`CONTENT_DIR/_system/data/cards/<id>.md`, see routes/entities.py's module
docstring for the CARDS_CUTOVER background). This module is a thin read/write
API over that pool for the journal-day UI:

  - GET  /api/cards/<date>   — every card for one day, parsed
  - POST /api/cards/update   — edit a card's body
  - POST /api/cards/delete   — remove a card

Reads parse the frontmatter directly (fast, no subprocess). Mutations never
touch the files themselves — they shell out to the vault's own `stream.py`,
which re-renders the derived daily file / month index / manifests after every
write. Editing/deleting a card file by hand here would silently desync those
derived views from the pool.
"""
import re
import subprocess
import sys

from flask import request, jsonify

import store
from routes.entities import _parse_frontmatter, CARDS_CUTOVER

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
# date . HHMM . b|k . optional counter — see CLAUDE.md background for this task.
CARD_ID_RE = re.compile(r"^\d{4}-\d{2}-\d{2}\.\d{4}[bk]\d*$")

STREAM_TIMEOUT_SEC = 30


def _content_dir():
    # Resolve fresh each call so tests/env overrides of CONTENT_DIR are honored
    # (same pattern as routes/entities.py's _vault()).
    return store.CONTENT_DIR.resolve()


def _pool_dir():
    return _content_dir() / "_system" / "data" / "cards"


def _stream_py():
    return _content_dir() / "_system" / "stream.py"


def _card_path(cid):
    return _pool_dir() / f"{cid}.md"


def _card_dict(meta, body, fallback_id=None):
    """Shape the frontmatter + body into the API's card object. `who` keeps
    its on-disk case (B/K) — _parse_frontmatter only lowercases keys, not
    values."""
    reply_to = meta.get("reply_to")
    if reply_to in (None, "null", ""):
        reply_to = None
    tags = meta.get("tags", [])
    if not isinstance(tags, list):
        tags = [tags] if tags else []
    refs = meta.get("refs", [])
    if not isinstance(refs, list):
        refs = [refs] if refs else []
    return {
        "id": meta.get("id") or fallback_id,
        "who": meta.get("who", ""),
        "ts": meta.get("ts", ""),
        "reply_to": reply_to,
        "tags": tags,
        "kind": meta.get("kind", ""),
        "refs": refs,
        "body": body.strip("\n"),
    }


def _read_card(cid):
    """Parse one card file straight off disk. None if it doesn't exist."""
    path = _card_path(cid)
    try:
        text = path.read_text()
    except OSError:
        return None
    meta, body = _parse_frontmatter(text)
    return _card_dict(meta, body, fallback_id=cid)


def _run_stream(*args, stdin=None):
    """Shell out to the vault's stream.py — the only thing allowed to mutate
    card files, since it re-renders the derived day/month/manifest views on
    every write. Returns the CompletedProcess; caller checks returncode."""
    cmd = [sys.executable, str(_stream_py()), *args]
    return subprocess.run(
        cmd, input=stdin, text=True, capture_output=True, timeout=STREAM_TIMEOUT_SEC,
    )


def _stream_error_response(result, fallback):
    err = (result.stderr or "").strip() or fallback
    status = 404 if "no such card" in err.lower() else 400
    return jsonify({"error": err}), status


def register(app):

    @app.route("/api/cards/<date>")
    def get_cards(date):
        if not DATE_RE.match(date):
            return jsonify({"error": "invalid date"}), 400
        pool = _pool_dir()
        cards = []
        if pool.exists():
            for p in pool.glob(f"{date}.*.md"):
                try:
                    text = p.read_text()
                except OSError:
                    continue
                meta, body = _parse_frontmatter(text)
                cards.append(_card_dict(meta, body, fallback_id=p.stem))
        cards.sort(key=lambda c: (c.get("ts") or "", c["id"]))
        return jsonify({
            "date": date,
            "editable": date >= CARDS_CUTOVER,
            "cards": cards,
        })

    @app.route("/api/cards/update", methods=["POST"])
    def update_card():
        data = request.json or {}
        cid = (data.get("id") or "").strip()
        body = data.get("body")
        if not CARD_ID_RE.match(cid):
            return jsonify({"error": "invalid card id"}), 400
        if not (body or "").strip():
            return jsonify({"error": "body cannot be empty"}), 400
        try:
            result = _run_stream("edit", cid, stdin=body)
        except subprocess.TimeoutExpired:
            return jsonify({"error": "timed out editing card"}), 400
        if result.returncode != 0:
            return _stream_error_response(result, "edit failed")
        card = _read_card(cid)
        if card is None:
            return jsonify({"error": "card not found after edit"}), 404
        return jsonify(card)

    @app.route("/api/cards/delete", methods=["POST"])
    def delete_card():
        data = request.json or {}
        cid = (data.get("id") or "").strip()
        if not CARD_ID_RE.match(cid):
            return jsonify({"error": "invalid card id"}), 400
        try:
            result = _run_stream("delete", cid)
        except subprocess.TimeoutExpired:
            return jsonify({"error": "timed out deleting card"}), 400
        if result.returncode != 0:
            return _stream_error_response(result, "delete failed")
        return jsonify({"ok": True})
