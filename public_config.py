"""Single source of truth for what the public/frosted website exposes.

Three rules per top-level data key:
  - "public":  return verbatim
  - "frosted": replace value with {"_frosted": True, "shape": ..., "count": ...}
               so the JS can render a blurred placeholder of the right size
  - "hidden":  drop the key entirely

Unknown keys default to "hidden" — safest if a new stream is added later.
Edit this file (and only this file) to change what strangers see.
"""

STREAMS = {
    # ---- common header context ----
    "time_of_day": "public",
    "server_hour": "public",
    "server_day_of_year": "public",
    "server_date": "public",
    "date": "public",
    "streaks": "frosted",

    # ---- habits ----
    "habits": "public",
    "habit_settings": "public",
    "habit_starts": "public",
    "habits_log": "public",

    # ---- health / activity / food ----
    "health_data": "frosted",
    "supplements": "public",
    "runs": "public",
    "kitchen_trips": "public",
    "activity_log": "public",
    "meal_notes": "public",
    "meal_defaults": "public",
    "food_guide": "public",

    # ---- kitchen ----
    "kitchen_list": "public",
    "kitchen_known_items": "public",
    "kitchen_purchase_counts": "public",
    "kitchen_item_notes": "public",
    "kitchen_pantry": "public",
    "kitchen_aisles": "public",
    "kitchen_category_order": "public",

    # ---- inventory ----
    "buy_list": "public",
    "active_inventory": "public",
    "buy_item": "public",
    "known_categories": "public",
    "priority_notes": "public",

    # ---- money ----
    # Visible to the public, but dollar figures are masked client-side ($•••).
    # The raw amounts still travel in this response to drive the bars/percentages.
    "budget": "public",
    "expenses": "public",
    "subscriptions": "public",
    "tax_setaside": "frosted",   # set-aside/tax UI is auth-only; keep its data private

    # Plain list of activity types to hide on the public calendar (legend). Safe
    # to expose — just type strings, no cadence/personal detail.
    "private_act_types": "public",

    # ---- frosted (visible as existing, content blurred) ----
    "todos": "frosted",
    "growth_notes": "frosted",

    # ---- hidden (key dropped entirely) ----
    "contacts": "hidden",
    "applications": "hidden",       # shrike_applied
    "dev_notes": "hidden",
    "receipts_map": "hidden",       # photo paths to receipts
    "reminders": "hidden",          # personal cadence pops (peptides, linen, …)
}

# Activity-log entry types stripped from the public view (kept for the owner).
# These ride inside the otherwise-public `activity_log` stream, so they need
# row-level redaction rather than a whole-stream rule above. This is the static
# fallback; the live set is driven by each reminder's `private` flag (see
# `private_act_types` computed in server.py and applied in filter_for_view).
PRIVATE_ACTIVITY_TYPES = ("estradiol", "peptides")

# Page paths anonymous visitors are allowed to reach.
# Everything else: API → 401, page → redirect to /login.
PUBLIC_PATHS = (
    "/login",
    "/logout",
    "/about",
    "/static/",
    "/",
    "/dashboard",
    "/map",
    "/kitchen",
    "/inventory",
    "/money",
    "/item/buy/",
    "/tab/",
    "/api/data/today",
    "/api/data/map",
    "/api/data/kitchen",
    "/api/data/inventory",
    "/api/data/money",
    "/api/data/item-buy",
    "/api/auth-check",
    "/api/version",
)


def is_public_path(path: str) -> bool:
    for p in PUBLIC_PATHS:
        if p == "/":
            if path == "/":
                return True
        elif p.endswith("/"):
            if path.startswith(p):
                return True
        else:
            if path == p:
                return True
    return False


def _frost_placeholder(value):
    if isinstance(value, list):
        return {"_frosted": True, "shape": "list", "count": len(value)}
    if isinstance(value, dict):
        return {"_frosted": True, "shape": "card"}
    return {"_frosted": True, "shape": "scalar"}


def filter_for_view(data, view_mode):
    """Apply STREAMS rules. Returns a new dict; original is not mutated."""
    if view_mode == "authed":
        return data
    if not isinstance(data, dict):
        return data
    out = {}
    for key, value in data.items():
        rule = STREAMS.get(key, "hidden")
        if rule == "public":
            out[key] = value
        elif rule == "frosted":
            out[key] = _frost_placeholder(value)
        # hidden → skip
    # Row-level redaction: drop private activity types (e.g. estradiol shots) from
    # the otherwise-public activity log so they never reach a logged-out browser.
    # The live set comes from the reminders' `private` flags (server computes it
    # into `private_act_types`); fall back to the static tuple if absent.
    private_types = set(data.get("private_act_types") or PRIVATE_ACTIVITY_TYPES)
    if isinstance(out.get("activity_log"), list):
        out["activity_log"] = [
            e for e in out["activity_log"]
            if not (isinstance(e, dict) and e.get("type") in private_types)
        ]
    return out
