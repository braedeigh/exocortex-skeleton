"""The build queue as separate dated cards — one record per item, SQL-backed.

**The problem this solves.** The build queue has always been one long markdown
file in the vault (`dev_todo.md`, 1500+ lines, ~55 `## ` sections). Every item
is already card-shaped — a heading with a status, an author and a date, then a
few paragraphs of spec — but they live glued together, so nothing can be
reordered, closed, filtered or counted without editing prose.

**What changes, and what deliberately doesn't.** From here on a *new* build item
is minted as its own record: `{id, title, body, status, author, created, tags}`,
kept in the `build_todo` collection. Because that name is in
`store.SQL_COLLECTIONS`, the read/write path lands in SQLite (`exo.db`, the
database of record) and store.py exports `data/build_todo.json` as a derived
mirror on every write — which is what the hourly vault cron commits. So a card
is in the database *and* in a git-diffable file, without this module doing
anything special for either.

**The old file is not migrated.** `dev_todo.md` stays exactly where it is and
keeps being read by everything that reads it today (`scripts/spark_morning.py`,
the personas). Parsing 1500 lines of hand-written prose into records is the one
genuinely risky part of the idea, and it buys nothing that waiting doesn't —
the backlog drains on its own as items ship. GET /api/buildtodo therefore
returns both halves: the new `cards`, and the legacy file's `##` sections as
read-only `legacy` entries so one page can show the whole queue.

**Ids are dated on their face** — `YYYY-MM-DD.<4 hex>`. Sortable, unique, and
the date is readable without a lookup, matching how the card pool names its own
cards (see routes/cards.py).

Touches: `store.py` (the `build_todo` collection + `DEV_TODO_FILE`),
`server.py` (registration), `tests/test_buildtodo_routes.py`.

Prompt that produced this file: "I want my dev todo to start being split up
into cards… just start separating them but keep them in sql for now separated,
and any future ones are their own dated cards and get backed up in the db."
"""
import re
import secrets
from datetime import datetime

from flask import request, jsonify

import store

FILE = "build_todo"

# Same slug shape as the journal's card tags (routes/cards.py TAG_RE) — a build
# card and a journal card tagged `warden` should be answering the same query.
TAG_RE = re.compile(r"^[a-z0-9-]{1,40}$")

CARD_ID_RE = re.compile(r"^\d{4}-\d{2}-\d{2}\.[0-9a-f]{4}$")

# open   — in the queue.
# shipped — built. Kept, not deleted: the old file's ✅ SHIPPED sections are
#           load-bearing history (they carry the commit hashes).
# dropped — decided against. Also kept, for the same reason: "we chose not to"
#           is an answer, and a deleted card re-arrives as a new idea.
STATUSES = ("open", "shipped", "dropped")

# Roughly how urgent, in the ladder the markdown file already uses via emoji
# (🔴 / 🟠 / 🟡). Optional — an item with no read on its urgency gets None
# rather than a middle value nobody chose.
PRIORITIES = ("red", "orange", "yellow")

MAX_TITLE = 300


def load():
    return store.read(FILE, {"cards": []})


def _cards(blob):
    """The card list out of a possibly-malformed blob."""
    if not isinstance(blob, dict):
        return []
    cards = blob.get("cards")
    return [c for c in cards if isinstance(c, dict)] if isinstance(cards, list) else []


def new_id(today=None, existing=()):
    """A dated id: `YYYY-MM-DD.<4 hex>`. Retries on the (vanishingly unlikely)
    same-day collision rather than trusting randomness blindly — ids are the
    identity here, and a duplicate would silently merge two items."""
    day = today or datetime.now().strftime("%Y-%m-%d")
    taken = set(existing)
    for _ in range(50):
        cid = f"{day}.{secrets.token_hex(2)}"
        if cid not in taken:
            return cid
    raise RuntimeError("could not mint a free build-card id")


def _clean_tags(raw):
    """Validated, de-duplicated, order-preserving. None means 'invalid'."""
    if raw is None:
        return []
    if not isinstance(raw, list):
        return None
    out = []
    for t in raw:
        if not isinstance(t, str) or not TAG_RE.match(t):
            return None
        if t not in out:
            out.append(t)
    return out


def _public(card):
    """One card in API shape, filling defaults for records written before a
    field existed. Never invents a `created` — an undated card says so."""
    return {
        "id": card.get("id"),
        "title": card.get("title") or "",
        "body": card.get("body") or "",
        "status": card.get("status") if card.get("status") in STATUSES else "open",
        "priority": card.get("priority") if card.get("priority") in PRIORITIES else None,
        "author": card.get("author") or "",
        "created": card.get("created") or "",
        "updated": card.get("updated") or "",
        "tags": [t for t in (card.get("tags") or []) if isinstance(t, str)],
    }


# --- the legacy markdown half ------------------------------------------------

# `## 🟡 Some title (Bradie, 2026-08-08)` — the heading dialect dev_todo.md has
# always used. The emoji and the trailing attribution are both optional; a
# heading that has neither still becomes a card, just a barer one.
_HEADING_RE = re.compile(r"^## (.+)$")
_ATTRIB_RE = re.compile(r"\((?P<who>[^()]*?),\s*(?P<when>\d{4}-\d{2}-\d{2})[^()]*\)\s*$")


def parse_legacy(md):
    """Split dev_todo.md into read-only card dicts on its `## ` headings.

    Everything before the first heading is dropped — it's the `# Build TODO`
    doc title, not an item. The author/date are lifted out of the heading when
    it carries them so the legacy cards wear the same meta row as real ones;
    when it doesn't, they come back empty rather than guessed.
    """
    out = []
    cur = None
    for line in (md or "").split("\n"):
        m = _HEADING_RE.match(line)
        if m:
            if cur:
                out.append(cur)
            heading = m.group(1).strip()
            a = _ATTRIB_RE.search(heading)
            cur = {
                "heading": heading,
                "author": (a.group("who").strip() if a else ""),
                "created": (a.group("when") if a else ""),
                "lines": [],
            }
        elif cur is not None:
            cur["lines"].append(line)
    if cur:
        out.append(cur)
    return [
        {
            "id": f"legacy:{i}",
            "title": c["heading"],
            "body": "\n".join(c["lines"]).strip("\n"),
            "author": c["author"],
            "created": c["created"],
            # A heading that says SHIPPED/FIXED/DONE has already happened. This
            # is a display hint read off the prose, not a claim the file
            # records status — hence `legacy`, which nothing writes back to.
            "shipped": bool(re.search(r"\b(SHIPPED|FIXED|BACKFILLED)\b", c["heading"])
                            or c["heading"].lstrip().startswith("✅")),
        }
        for i, c in enumerate(out)
    ]


def _legacy_cards():
    """The old file's sections, or [] if it isn't there. Never fatal: the new
    cards are the point, and a missing vault file must not blank the page."""
    path = store.DEV_TODO_FILE
    try:
        if not path.exists():
            return []
        return parse_legacy(path.read_text())
    except OSError:
        return []


def register(app):

    @app.route("/api/buildtodo")
    def buildtodo_list():
        """The whole queue: real cards newest-first, then the legacy file's
        sections in document order."""
        cards = [_public(c) for c in _cards(load())]
        cards.sort(key=lambda c: (c["created"], c["id"]), reverse=True)
        return jsonify({"cards": cards, "legacy": _legacy_cards()})

    @app.route("/api/buildtodo/add", methods=["POST"])
    def buildtodo_add():
        data = request.json or {}
        title = (data.get("title") or "").strip()
        body = (data.get("body") or "").strip()
        author = (data.get("author") or "").strip()
        priority = data.get("priority")
        if not title:
            return jsonify({"error": "title required"}), 400
        if len(title) > MAX_TITLE:
            return jsonify({"error": f"title over {MAX_TITLE} chars"}), 400
        if priority is not None and priority not in PRIORITIES:
            return jsonify({"error": "invalid priority"}), 400
        tags = _clean_tags(data.get("tags"))
        if tags is None:
            return jsonify({"error": "tags must be a list of slugs"}), 400
        now = datetime.now()
        card = {
            "id": None,   # filled inside the mutate, against the live id set
            "title": title,
            "body": body,
            "status": "open",
            "priority": priority,
            "author": author,
            "created": now.strftime("%Y-%m-%d"),
            "updated": now.strftime("%Y-%m-%d %H:%M"),
            "tags": tags,
        }
        # Mint the id inside the transaction: two agents filing a card in the
        # same second would otherwise both read the same id set and collide.
        with store.mutate(FILE, {"cards": []}) as blob:
            cards = blob.setdefault("cards", [])
            card["id"] = new_id(card["created"], [c.get("id") for c in cards
                                                  if isinstance(c, dict)])
            cards.append(card)
        return jsonify(_public(card))

    @app.route("/api/buildtodo/update", methods=["POST"])
    def buildtodo_update():
        """Edit one card. Only the fields present in the request change — an
        absent key is 'leave it alone', not 'clear it'."""
        data = request.json or {}
        cid = (data.get("id") or "").strip()
        if not CARD_ID_RE.match(cid):
            return jsonify({"error": "invalid card id"}), 400
        if "title" in data and not (data.get("title") or "").strip():
            return jsonify({"error": "title cannot be empty"}), 400
        if "status" in data and data.get("status") not in STATUSES:
            return jsonify({"error": "invalid status"}), 400
        if "priority" in data and data.get("priority") is not None \
                and data.get("priority") not in PRIORITIES:
            return jsonify({"error": "invalid priority"}), 400
        tags = None
        if "tags" in data:
            tags = _clean_tags(data.get("tags"))
            if tags is None:
                return jsonify({"error": "tags must be a list of slugs"}), 400

        found = {}
        with store.mutate(FILE, {"cards": []}) as blob:
            for card in _cards(blob):
                if card.get("id") != cid:
                    continue
                if "title" in data:
                    card["title"] = data["title"].strip()[:MAX_TITLE]
                if "body" in data:
                    card["body"] = (data.get("body") or "").strip()
                if "status" in data:
                    card["status"] = data["status"]
                if "priority" in data:
                    card["priority"] = data["priority"]
                if "author" in data:
                    card["author"] = (data.get("author") or "").strip()
                if tags is not None:
                    card["tags"] = tags
                card["updated"] = datetime.now().strftime("%Y-%m-%d %H:%M")
                found = dict(card)
                break
        if not found:
            return jsonify({"error": "card not found"}), 404
        return jsonify(_public(found))

    @app.route("/api/buildtodo/remove", methods=["POST"])
    def buildtodo_remove():
        """Delete for real. Shipping or dropping an item is a `status` change
        — this is for the mis-filed ones, so the response carries the whole
        card back for an undo toast to re-add."""
        data = request.json or {}
        cid = (data.get("id") or "").strip()
        if not CARD_ID_RE.match(cid):
            return jsonify({"error": "invalid card id"}), 400
        removed = None
        with store.mutate(FILE, {"cards": []}) as blob:
            cards = _cards(blob)
            removed = next((c for c in cards if c.get("id") == cid), None)
            if removed is not None:
                blob["cards"] = [c for c in cards if c.get("id") != cid]
        if removed is None:
            return jsonify({"error": "card not found"}), 404
        return jsonify({"ok": True, "card": _public(removed)})

    @app.route("/api/buildtodo/restore", methods=["POST"])
    def buildtodo_restore():
        """Undo of remove: put a whole card back, id and created intact.
        Restoring twice can't duplicate."""
        data = request.json or {}
        card = data.get("card")
        if not isinstance(card, dict):
            return jsonify({"error": "card object required"}), 400
        cid = (card.get("id") or "").strip()
        if not CARD_ID_RE.match(cid):
            return jsonify({"error": "invalid card id"}), 400
        if not (card.get("title") or "").strip():
            return jsonify({"error": "title required"}), 400
        clean = _public(card)
        with store.mutate(FILE, {"cards": []}) as blob:
            cards = blob.setdefault("cards", [])
            if not any(isinstance(c, dict) and c.get("id") == cid for c in cards):
                cards.append(clean)
        return jsonify(clean)
