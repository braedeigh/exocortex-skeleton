"""Token burn — what the agents spent, added up for the page of that name.

What this file does, in plain English. Every Observatory turn ends with the
harness reporting what it used: tokens of four kinds and an estimated cost.
toolcallstore.py reads those into exo.db's `turn_usage` table (one row per
turn per model, each turn's OWN share — see that file for why the raw
figures can't simply be summed). This route adds the table up for one window
(24h, 7d, 30d or all) and one grouping, and hands the page its rows:

  by model    which models did the work, and across how many sessions
  by session  which conversations burned the most — each row opens it
  by room     Keeper, Personal, Coding, Research, Linear, Orchestra, Helpers,
              Night crew — the same split the roster makes
  by kind     re-read from cache / newly cached / fresh input / written — where the
              tokens go vs where the money goes

Alongside the rows: a timeline (per hour for 24h, per day otherwise, each
turn counted when it ended), and GET /api/token-burn/session/<conv> — one
conversation turn by turn, each turn with the model calls inside it, so a
number on the page can be followed down to the calls that made it.

Every grouping splits the same (conversation, model) units, so every view's
rows add up to the same total — that's what the route test proves.

Cost is the harness's own estimate at API list prices, not a bill: on a
subscription the dollars are a yardstick. It only knows cost per model, so
the "by kind" view splits each model's cost across kinds by list-price
ratios (fresh input 1, cache write 2 — the one-hour cache these sessions
use — cache read 0.1, output 5). That split is labelled an estimate.

Only Observatory turns are in the totals. Sessions run straight in a
terminal or tmux have their calls' input on record (model_calls) but not
their final output or cost, so they're reported beside the totals as
"outside", never mixed in.

Touches: toolcallstore.py (burn_units, freshness), store.py (the session
index, for titles and rooms), lanes.py (the room rule), swarms.py (which
roles are helpers). Drawn by frontend/src/features/observatory/
TokenBurnPage.tsx; tests in tests/test_token_burn_routes.py.

Prompt that produced this: "Like could you make me one of these" — a
screenshot of a TOKEN BURN :: FLEET dashboard: stat boxes, group and range
toggles, a table with a share bar per row.
"""
from datetime import datetime, timedelta

from flask import jsonify, request

import lanes
import store
import swarms
import toolcallstore

RANGES = {"24h": timedelta(hours=24), "7d": timedelta(days=7),
          "30d": timedelta(days=30), "all": None}
GROUPS = ("model", "session", "room", "kind")

# The four kinds of token, each with its list-price weight relative to fresh
# input (the by-kind cost split).
KINDS = (("input", "input_tokens", "Fresh input", 1.0),
         ("cache_write", "cache_creation_tokens", "Newly cached", 2.0),
         ("cache_read", "cache_read_tokens", "Re-read from cache", 0.1),
         ("output", "output_tokens", "Written", 5.0))

ROOM_LABEL = {"keeper": "Keeper", "personal": "Personal", "coding": "Coding",
              "research": "Research", "linear": "Linear", "orchestra": "Orchestra",
              "helpers": "Helpers", "nightcrew": "Night crew",
              "unknown": "Not in the index"}


def room_of(entry):
    """Which room a conversation's spending belongs to, the way the roster
    splits it: the Keeper (and the Keepers it rolled over from), the night
    crew's workers, the helpers, then the session's lane."""
    if not isinstance(entry, dict):
        return "unknown"
    origin = entry.get("origin")
    if entry.get("pinned") or origin == "keeper_rollover":
        return "keeper"
    if origin == "nightcrew":
        return "nightcrew"
    if origin == "helper" or entry.get("role") in swarms.HELPER_ROLES:
        return "helpers"
    if origin == "research":
        return "research"
    return lanes.derive_lane(entry)


def _tokens(unit):
    return sum(unit[col] or 0 for _, col, _, _ in KINDS)


def _kind_costs(unit):
    """One unit's cost split across the four kinds by list-price weight."""
    weights = {key: (unit[col] or 0) * w for key, col, _, w in KINDS}
    total = sum(weights.values())
    cost = unit["cost_usd"] or 0.0
    if not total:
        return {key: 0.0 for key in weights}
    return {key: cost * w / total for key, w in weights.items()}


def _rows(group, units, turns, index):
    """Fold the (conversation, model) units into one row per group key."""
    rows = {}

    def bucket(key, label, **extra):
        if key not in rows:
            rows[key] = {"key": key, "label": label, "tokens": 0, "cost_usd": 0.0,
                         "turns": 0, "_convs": set(), **extra}
        return rows[key]

    if group == "kind":
        for key, _, label, _ in KINDS:
            bucket(key, label, turns=None)
        for u in units:
            costs = _kind_costs(u)
            for key, col, _, _ in KINDS:
                rows[key]["tokens"] += u[col] or 0
                rows[key]["cost_usd"] += costs[key]
                rows[key]["_convs"].add(u["conv"])
        return list(rows.values())

    for u in units:
        conv = u["conv"]
        entry = index.get(conv)
        if group == "model":
            row = bucket(u["model"], u["model"] or "unrecorded")
            # A turn that used two models counts once under each.
            row["turns"] += u["turns"]
        elif group == "session":
            title = entry.get("title") if isinstance(entry, dict) else None
            room = room_of(entry)
            row = bucket(conv, title or conv, conv=conv, room=ROOM_LABEL.get(room, room))
        else:
            room = room_of(entry)
            row = bucket(room, ROOM_LABEL.get(room, room))
        row["tokens"] += _tokens(u)
        row["cost_usd"] += u["cost_usd"] or 0.0
        row["_convs"].add(conv)
    # Sessions and rooms count whole turns, once each.
    if group in ("session", "room"):
        for row in rows.values():
            row["turns"] = sum(turns.get(c, 0) for c in row["_convs"])
    return list(rows.values())


def burn(group, range_key, now=None):
    """The whole page's payload for one grouping and one window."""
    now = now or datetime.now()
    span = RANGES[range_key]
    since = (now - span).isoformat(timespec="milliseconds") if span else None
    data = toolcallstore.burn_units(since)
    units, turns = data["units"], data["turns"]
    index = store.read("bot_chats/index", {})
    if not isinstance(index, dict):
        index = {}

    totals = {"tokens": sum(_tokens(u) for u in units),
              "cost_usd": sum(u["cost_usd"] or 0.0 for u in units),
              "turns": sum(turns.values()),
              "sessions": len(turns)}
    kind_cost = {key: 0.0 for key, _, _, _ in KINDS}
    for key, col, _, _ in KINDS:
        totals[key] = sum(u[col] or 0 for u in units)
    for u in units:
        for key, c in _kind_costs(u).items():
            kind_cost[key] += c
    totals["kind_cost_usd"] = {k: round(v, 4) for k, v in kind_cost.items()}
    totals["thinking"] = sum(u["thinking_tokens"] or 0 for u in units)

    rows = _rows(group, units, turns, index)
    for row in rows:
        row["sessions"] = len(row.pop("_convs"))
        row["cost_usd"] = round(row["cost_usd"], 4)
        row["share"] = row["tokens"] / totals["tokens"] if totals["tokens"] else 0.0
    rows.sort(key=lambda r: (r["tokens"], r["cost_usd"]), reverse=True)
    totals["cost_usd"] = round(totals["cost_usd"], 4)

    return {
        "group": group,
        "range": range_key,
        "since": since,
        "totals": totals,
        "rows": rows,
        "timeline": toolcallstore.burn_timeline(since, hourly=range_key == "24h"),
        "outside": toolcallstore.outside_calls(since),
        "freshness": toolcallstore.freshness(),
        "coverage": {"first_day": data["first_day"], "undated_turns": data["undated"]},
    }


def register(app):

    @app.route("/api/token-burn")
    def token_burn():
        """GET ?group=model|session|room|kind&range=24h|7d|30d|all — the
        Token burn page. Defaults: by model, last 30 days."""
        group = request.args.get("group", "model")
        range_key = request.args.get("range", "30d")
        if group not in GROUPS:
            return jsonify({"error": f"group must be one of {', '.join(GROUPS)}"}), 400
        if range_key not in RANGES:
            return jsonify({"error": f"range must be one of {', '.join(RANGES)}"}), 400
        return jsonify(burn(group, range_key))

    @app.route("/api/token-burn/session/<conv>")
    def token_burn_session(conv):
        """One conversation's turns, each with its model calls — the
        drill-down under a session row."""
        index = store.read("bot_chats/index", {})
        entry = index.get(conv) if isinstance(index, dict) else None
        turns = toolcallstore.session_burn(conv)
        if not turns and not isinstance(entry, dict):
            return jsonify({"error": "no such session"}), 404
        return jsonify({
            "conv": conv,
            "title": (entry or {}).get("title") or conv,
            "room": ROOM_LABEL.get(room_of(entry), room_of(entry)),
            "turns": turns,
        })
