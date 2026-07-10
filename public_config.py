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
    # Things-you-own catalog (routes/archivals.py). The server already strips
    # private items/fields before this filter runs (public_view); frost the
    # rest. To open the catalog up later, flip to "public" AND add
    # /archivals/photo/ to PUBLIC_PATHS — otherwise strangers get broken images.
    "archivals": "frosted",

    # ---- money ----
    # Visible to the public, but RESCALED server-side (see _scale_money_streams):
    # every dollar figure is multiplied by one private factor before it leaves
    # the server, so the bars/percentages render identically while the real
    # amounts never travel. The client additionally masks displayed figures ($•••).
    "budget": "public",
    "expenses": "public",
    "subscriptions": "public",
    "tax_setaside": "frosted",   # set-aside/tax UI is auth-only; keep its data private

    # Plain list of activity types to hide on the public calendar (legend). Safe
    # to expose — just type strings, no cadence/personal detail.
    "private_act_types": "public",

    # ---- ecosystem (the shareable food-sourcing map at /food-map) ----
    "ecosystem": "public",
    # Light recipe list (id / name / ingredients only) for the map's "trace a
    # recipe" picker. Distinct from the full "recipes" stream, which stays hidden
    # (it carries instructions and rides the public kitchen tab too).
    "eco_recipes": "public",

    # ---- frosted (visible as existing, content blurred) ----
    "todos": "frosted",
    "growth_notes": "frosted",

    # ---- hidden (key dropped entirely) ----
    "contacts": "hidden",
    "applications": "hidden",       # shrike_applied
    "dev_notes": "hidden",
    "idea_notes": "hidden",
    "idea_notes_all": "hidden",
    "ideas_md": "hidden",           # the private vision doc
    "tab_todos": "hidden",          # per-tab to-do strip (todos are personal)
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
    "/dashboard/today",
    "/dashboard/map",
    "/dashboard/kitchen",
    "/dashboard/inventory",
    "/dashboard/money",
    "/dashboard/ecosystem",
    "/food-map",
    "/ecosystem",
    "/map",
    "/kitchen",
    "/inventory",
    "/money",
    "/item/buy/",
    "/api/data/today",
    "/api/data/map",
    "/api/data/kitchen",
    "/api/data/inventory",
    "/api/data/money",
    "/api/data/item-buy",
    "/api/data/ecosystem",
    "/api/version",
    # The React SPA shell (routes/spa.py) — the app-shell HTML/JS/CSS/
    # manifest/SW must all be reachable to render the public landing at all.
    # "/legacy/<tab>" entries stay so old public bookmarks can follow the
    # redirect to the native tab paths above.
    "/assets/",
    "/manifest.webmanifest",
    "/registerSW.js",
    "/sw.js",
    "/workbox-",  # hashed workbox runtime at dist root; see is_public_path prefix rule below
    "/todos",
    "/legacy/map",
    "/legacy/kitchen",
    "/legacy/inventory",
    "/legacy/money",
    "/legacy/ecosystem",
)


def is_public_path(path: str) -> bool:
    for p in PUBLIC_PATHS:
        if p == "/":
            if path == "/":
                return True
        elif p.endswith(("/", "-")):
            # trailing "-" covers hash-suffixed files like /workbox-<hash>.js
            if path.startswith(p):
                return True
        else:
            if path == p:
                return True
    return False


def _money_f(v):
    try:
        return float(v or 0)
    except (TypeError, ValueError):
        return 0.0


def _scale_money_streams(out):
    """Public money view: ship RELATIVE numbers, never dollars.

    The public money tab only renders ratios (budget bars = spent/planned,
    expense bars = amount/max, income-vs-spent fractions), and the client masks
    every displayed figure as $•••. But client-side masking means the real
    amounts still travel in the response — open devtools and read them. So:
    rescale every dollar figure by ONE private factor (largest value → 100)
    before the response leaves the server. All ratio math renders identically;
    the absolute dollars are unrecoverable. Also drops fields with no business
    in a public response: the bank CSV deep-link and receipt file paths.

    Returns new dicts/lists — never mutates the caller's data (the
    filter_for_view contract).
    """
    budget = out.get("budget")
    expenses = out.get("expenses")
    subs = out.get("subscriptions")

    vals = []
    if isinstance(budget, dict):
        vals.append(abs(_money_f(budget.get("income_monthly"))))
        vals += [abs(_money_f(c.get("planned"))) for c in budget.get("categories") or []]
    if isinstance(expenses, list):
        vals += [abs(_money_f(e.get("amount"))) for e in expenses if isinstance(e, dict)]
    if isinstance(subs, list):
        vals += [abs(_money_f(s.get("amount"))) for s in subs if isinstance(s, dict)]
    peak = max(vals, default=0)
    k = (100.0 / peak) if peak > 0 else 0.0

    def scale(v):
        return round(_money_f(v) * k, 2)

    if isinstance(budget, dict):
        budget = dict(budget)
        budget.pop("bank_csv_url", None)  # bank deep-link: owner-only, full stop
        budget["income_monthly"] = scale(budget.get("income_monthly"))
        budget["categories"] = [
            {**c, "planned": scale(c.get("planned"))}
            for c in budget.get("categories") or [] if isinstance(c, dict)
        ]
        out["budget"] = budget
    if isinstance(expenses, list):
        out["expenses"] = [
            {**{key: v for key, v in e.items() if key not in ("receipt", "source")},
             "amount": scale(e.get("amount"))}
            for e in expenses if isinstance(e, dict)
        ]
    if isinstance(subs, list):
        out["subscriptions"] = [
            {**s, "amount": scale(s.get("amount"))}
            for s in subs if isinstance(s, dict)
        ]


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
    # Money: replace absolute dollar figures with relative values (see docstring)
    _scale_money_streams(out)
    return out
