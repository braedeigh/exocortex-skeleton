"""Finding a chat again: the Observatory's search box and its "recently
opened" list.

Three doors:

    GET  /api/observatory/search?q=&in=   search every session, closed ones
                                          included. `in=said` (the default)
                                          searches what was said; `in=did`
                                          searches what the agents did (files,
                                          commands). The searching itself
                                          lives in chatsearch.py.
    POST /api/observatory/opened          note that she just opened a session
    GET  /api/observatory/recent          the sessions she opened most
                                          recently, newest first, closed ones
                                          included

**Where "opened" is kept.** In one small JSON file in the data folder,
`bot_chats/opened.json`: conversation id -> when she last opened it. It is on
the server, not in the browser, so the phone and the laptop share one list.
(The browser keeps its own per-device map for the unread dots,
frontend readReceipts.ts; that one is untouched.)

Touches: `chatsearch.py` (the index and both searches), `store.py` (the
session index `bot_chats/index` and the opened file), `lanes.py` (which room
a session is in). Frontend: `features/observatory/ChatFinder.tsx` and
`ArchivePage.tsx`.

Prompt that produced this file: "Need some kind of search function for chats
and to be able to see the last ones I had opened in the observatory."
"""
from datetime import datetime

from flask import request, jsonify

import chatsearch
import lanes
import store

OPENED = "bot_chats/opened"
# How many opened stamps are kept. Far more than the list shows, so closing
# and deleting sessions doesn't leave the list short.
_OPENED_KEPT = 300
# How many sessions the recently-opened list answers with.
_RECENT_DEFAULT = 20
_RECENT_MAX = 100


def _is_stamp(value):
    """True for a string that parses as an ISO date-time."""
    if not isinstance(value, str):
        return False
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return False
    return True


def _as_local(value):
    """An ISO date-time as local naive ISO to the second, so every stamp in
    the opened file sorts on one clock whether a browser sent it in UTC or
    this server wrote it."""
    moment = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if moment.tzinfo is not None:
        moment = moment.astimezone().replace(tzinfo=None)
    return moment.isoformat(timespec="seconds")


def register(app):

    @app.route("/api/observatory/search")
    def observatory_search():
        """Search every session, closed and journalled ones included.

        Answers {"query", "in", "results", "truncated", "catching_up"}. Each
        result is one session with its matching excerpts (shape in
        chatsearch.search). `truncated` means more sessions matched than are
        shown; `catching_up` means some chat logs haven't been indexed yet,
        so the page can say the answer may be incomplete instead of passing
        it off as everything.

        Journalled sessions are included and flagged, not withheld: this
        answers a question she deliberately typed into her own archive, and
        the Keeper session is where most of what she'd look for was said.
        """
        q = (request.args.get("q") or "").strip()
        where = "did" if request.args.get("in") == "did" else "said"
        empty = {"query": q, "in": where, "results": [],
                 "truncated": False, "catching_up": False}
        if len(q) < chatsearch.MIN_QUERY:
            return jsonify(empty)
        index = store.read("bot_chats/index", {})
        if not isinstance(index, dict):
            index = {}

        if where == "did":
            try:
                found = chatsearch.search_tools(q, index, lanes.derive_lane)
            except ValueError:
                return jsonify(empty)
            return jsonify({**empty, **found})

        # Index what was said since the last search first, so a line typed a
        # minute ago is findable. Best-effort: if the catch-up hiccups, search
        # what's there.
        catching_up = False
        try:
            catching_up = chatsearch.catch_up()["behind"] > 0
        except Exception:
            app.logger.exception("chat search: catch-up failed")
        try:
            found = chatsearch.search(q, index, lanes.derive_lane)
        except ValueError:
            return jsonify(empty)
        return jsonify({**empty, **found, "catching_up": catching_up})

    @app.route("/api/observatory/opened", methods=["POST"])
    def observatory_opened():
        """Note that she opened a session.

        Body `{"conv": "<id>"}` stamps that session with the time now. Body
        `{"opened": {"<id>": "<ISO time>", ...}}` merges a whole map, keeping
        the later time for each session; a browser sends that once, to hand
        over the opens it recorded before this list existed.
        """
        body = request.get_json(silent=True) or {}
        conv = body.get("conv")
        merged = body.get("opened")
        if not (isinstance(conv, str) and conv) and not isinstance(merged, dict):
            return jsonify({"error": "conv or opened required"}), 400
        now = datetime.now().isoformat(timespec="seconds")
        with store.mutate(OPENED, {}) as opened:
            if isinstance(merged, dict):
                for cid, stamp in merged.items():
                    if not (isinstance(cid, str) and cid and _is_stamp(stamp)):
                        continue
                    stamp = min(_as_local(stamp), now)
                    if stamp > opened.get(cid, ""):
                        opened[cid] = stamp
            if isinstance(conv, str) and conv:
                opened[conv] = now
            # Keep only the newest stamps, so the file can't grow without end.
            if len(opened) > _OPENED_KEPT:
                keep = sorted(opened, key=opened.get, reverse=True)[:_OPENED_KEPT]
                for cid in [cid for cid in opened if cid not in keep]:
                    del opened[cid]
        return jsonify({"ok": True})

    @app.route("/api/observatory/recent")
    def observatory_recent():
        """The sessions she opened most recently, newest first.

        Closed sessions are included and flagged (`archived`), so a chat that
        closed itself is still one tap away; sessions that no longer exist
        are left out. `?limit=` caps the list (default 20).
        """
        try:
            limit = int(request.args.get("limit", _RECENT_DEFAULT))
        except (TypeError, ValueError):
            limit = _RECENT_DEFAULT
        limit = max(1, min(_RECENT_MAX, limit))
        opened = store.read(OPENED, {})
        index = store.read("bot_chats/index", {})
        if not isinstance(opened, dict) or not isinstance(index, dict):
            return jsonify({"sessions": []})
        sessions = []
        for cid in sorted(opened, key=lambda c: str(opened[c]), reverse=True):
            meta = index.get(cid)
            if not isinstance(meta, dict):
                continue
            sessions.append({
                "id": cid,
                "title": meta.get("title") or cid,
                "lane": lanes.derive_lane(meta),
                "journal": meta.get("journal") is True,
                "archived": bool(meta.get("archived")),
                "pinned": bool(meta.get("pinned")),
                "started": meta.get("started"),
                "last_at": meta.get("last_at"),
                "opened_at": opened[cid],
            })
            if len(sessions) >= limit:
                break
        return jsonify({"sessions": sessions})
