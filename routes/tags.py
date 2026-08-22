"""Tags routes — the one universal, namespaced tags table (schema v12; see
docs/tags-architecture.md, the design of record this file implements). Any
subject in the system (a card, a todo, a file, a research entry, a thread...)
can carry a tag under a namespace (front/topic/thread/person/...), and this
is the read+write surface over that single `tags` table sqlstore.py creates.

Touches: sqlstore.py (the `tags` table + open_db()/begin_immediate() write
door), server.py (registers this module next to the other routes/*.py).
Nothing else — the old junction tables (card_tags, todo_fronts) are untouched
and keep serving the surfaces that already read them; a future
scripts/backfill_tags.py is what would mirror them into `tags`.

Prompt that produced this file: "one universal namespaced tags table so every
subject in the system — cards, todos, files, research entries, threads — can
be tagged and searched like a wiki by front, topic, and any future
structure".
"""
import re

from flask import request, jsonify

import sqlstore


# Address + slug rules straight out of the doc: a subject is
# `<family>:<local id>` (the family prefix must already be lowercase, e.g.
# 'card:2026-08-14.0930'); ns/tag are free-form namespace/label slugs,
# lowercased on the way in so 'Front' and 'front' land on the same row.
_SUBJECT_RE = re.compile(r"^[a-z]+:.+$")
_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9\-_.]*$")

# GET /api/tags groups namespaces in this order — the vocabulary the doc
# names explicitly comes first, any future ns falls in after it, alphabetical.
_NS_PRIORITY = {"front": 0, "thread": 1, "person": 2, "topic": 3}


def _ns_sort_key(ns):
    return (_NS_PRIORITY.get(ns, len(_NS_PRIORITY)), ns)


def _valid_subject(subject):
    return isinstance(subject, str) and bool(_SUBJECT_RE.match(subject))


def _clean_slug(value):
    """Lowercase + validate a ns or tag. Returns the cleaned string, or None
    if it doesn't survive (missing, not a string, or fails the slug shape)."""
    if not isinstance(value, str):
        return None
    value = value.strip().lower()
    return value if _SLUG_RE.match(value) else None


def _subject_tags(conn, subject):
    rows = conn.execute(
        "SELECT ns, tag, source FROM tags WHERE subject = ? ORDER BY ns, tag",
        (subject,),
    ).fetchall()
    return [{"ns": r[0], "tag": r[1], "source": r[2]} for r in rows]


def register(app):

    @app.route("/api/tags")
    def list_tags():
        """Every tag in use, grouped by namespace with a count — the rail a
        tag picker or the wiki-pond reads."""
        conn = sqlstore.open_db()
        try:
            rows = conn.execute(
                "SELECT ns, tag, COUNT(*) FROM tags GROUP BY ns, tag"
            ).fetchall()
        finally:
            conn.close()

        by_ns = {}
        for ns, tag, count in rows:
            by_ns.setdefault(ns, []).append({"tag": tag, "count": count})
        namespaces = [
            {"ns": ns, "tags": sorted(tags, key=lambda t: (-t["count"], t["tag"]))}
            for ns, tags in by_ns.items()
        ]
        namespaces.sort(key=lambda n: _ns_sort_key(n["ns"]))
        return jsonify({"namespaces": namespaces})

    @app.route("/api/tags/for")
    def tags_for():
        """Every tag on one subject — the chip list a detail view renders.
        `subject` is a query param, not a path segment, because subjects
        contain slashes (file:skeleton/routes/health.py)."""
        subject = request.args.get("subject", "")
        if not _valid_subject(subject):
            return jsonify({"error": "missing or malformed subject"}), 400
        conn = sqlstore.open_db()
        try:
            tags = _subject_tags(conn, subject)
        finally:
            conn.close()
        return jsonify({"subject": subject, "tags": tags})

    @app.route("/api/tags/tag/<ns>/<tag>")
    def tag_page(ns, tag):
        """Every subject carrying this (ns, tag) — the tag page's subject
        list. `family` is split out so the page can group card/todo/thread/...
        subjects apart without re-parsing the address itself."""
        conn = sqlstore.open_db()
        try:
            rows = conn.execute(
                "SELECT subject FROM tags WHERE ns = ? AND tag = ? ORDER BY subject",
                (ns, tag),
            ).fetchall()
        finally:
            conn.close()
        subjects = [{"subject": r[0], "family": r[0].split(":", 1)[0]} for r in rows]
        return jsonify({"ns": ns, "tag": tag, "subjects": subjects})

    @app.route("/api/tags/add", methods=["POST"])
    def add_tag():
        body = request.json or {}
        subject = body.get("subject")
        ns = _clean_slug(body.get("ns"))
        tag = _clean_slug(body.get("tag"))
        if not _valid_subject(subject) or ns is None or tag is None:
            return jsonify({"error": "bad subject/ns/tag"}), 400

        conn = sqlstore.open_db()
        try:
            sqlstore.begin_immediate(conn)
            # OR IGNORE: re-adding a tag that's already there is a success,
            # not a conflict — the primary key (subject, ns, tag) is the
            # de-dupe, and a manual re-add never clobbers an existing
            # derived/cricket row's source.
            conn.execute(
                "INSERT OR IGNORE INTO tags (subject, ns, tag, source)"
                " VALUES (?, ?, ?, 'manual')",
                (subject, ns, tag),
            )
            conn.execute("COMMIT")
            tags = _subject_tags(conn, subject)
        finally:
            conn.close()
        return jsonify({"subject": subject, "tags": tags})

    @app.route("/api/tags/remove", methods=["POST"])
    def remove_tag():
        body = request.json or {}
        subject = body.get("subject")
        ns = _clean_slug(body.get("ns"))
        tag = _clean_slug(body.get("tag"))
        if not _valid_subject(subject) or ns is None or tag is None:
            return jsonify({"error": "bad subject/ns/tag"}), 400

        conn = sqlstore.open_db()
        try:
            sqlstore.begin_immediate(conn)
            # Deletes regardless of source — manual, derived or cricket — the
            # owner's "remove this" always wins; only a re-run of the
            # backfill would put a derived tag back, never this route.
            conn.execute(
                "DELETE FROM tags WHERE subject = ? AND ns = ? AND tag = ?",
                (subject, ns, tag),
            )
            conn.execute("COMMIT")
            tags = _subject_tags(conn, subject)
        finally:
            conn.close()
        return jsonify({"subject": subject, "tags": tags})
