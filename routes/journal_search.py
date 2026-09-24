"""GET /api/journal/search — the journal search box's door to cardsearch.py.

Reads the query parameters, catches the mirror up on any freshly captured
cards, runs the search, and answers with JSON. The searching itself (what the
query syntax means, how hits are ranked) lives in cardsearch.py.

    ?q=      the words (required) — see cardsearch.py for the syntax
    ?who=    B or K, to search only the owner's lines or only the Keeper's
    ?from= / ?to=   inclusive YYYY-MM-DD day bounds
    ?sort=   relevance (default) | newest | oldest
    ?limit= / ?offset=   paging; limit is capped at 100

Answers {"q", "total", "hits": [...]} (hit shape in cardsearch.search), or
400 {"error"} for a query with nothing to search for.
"""
import re

from flask import request, jsonify

import cardsearch

_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_MAX_LIMIT = 100
_DEFAULT_LIMIT = 30


def _int_arg(name, default, lowest, highest):
    """Read a whole-number query parameter, clamped; bad input -> default."""
    try:
        value = int(request.args.get(name, default))
    except (TypeError, ValueError):
        return default
    return max(lowest, min(highest, value))


def register(app):

    @app.route("/api/journal/search", methods=["GET"])
    def journal_search():
        q = (request.args.get("q") or "").strip()
        if not q:
            return jsonify({"error": "Type something to search for"}), 400

        # Read the optional filters, dropping any that are malformed rather
        # than erroring: a bad date just means "no bound".
        who = request.args.get("who")
        who = who if who in ("B", "K") else None
        date_from = request.args.get("from") or None
        date_to = request.args.get("to") or None
        date_from = date_from if date_from and _DATE_RE.match(date_from) else None
        date_to = date_to if date_to and _DATE_RE.match(date_to) else None
        sort = request.args.get("sort") or "relevance"
        sort = sort if sort in cardsearch.SORTS else "relevance"
        limit = _int_arg("limit", _DEFAULT_LIMIT, 1, _MAX_LIMIT)
        offset = _int_arg("offset", 0, 0, 1_000_000)

        # Mirror just-captured cards first, so a line said a minute ago is
        # findable. Best-effort: if the catch-up hiccups, search what's there.
        try:
            cardsearch.catch_up()
        except Exception:
            app.logger.exception("journal search: catch-up failed")

        try:
            result = cardsearch.search(
                q, who=who, date_from=date_from, date_to=date_to,
                sort=sort, limit=limit, offset=offset,
            )
        except ValueError:
            return jsonify({"error": "Nothing to search for — add a word that isn't excluded"}), 400
        return jsonify({"q": q, **result})
