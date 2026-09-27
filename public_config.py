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
    "retired_streaks": "frosted",

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
    # Every food with the sources it's traced to (product names withheld
    # from the public view by server.py) and the origin vocabulary.
    "eco_foods": "public",
    "eco_origins": "public",

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
# row-level redaction rather than a whole-stream rule above. The static
# fallback lives in the owner's DATA (data/public_view.json ->
# private_activity_types), never in this shareable file — an owner's redaction
# list is itself a disclosure. The live set is additionally driven by each
# reminder's `private` flag (see `private_act_types` computed in server.py and
# applied in filter_for_view).
def private_activity_types():
    import store  # local import: keep this module import-cycle-free
    cfg = store.read("public_view", {})
    return tuple(cfg.get("private_activity_types") or ())


# --- Which of the database's tables a visitor may READ ------------------------
#
# The Terrain map publishes exo.db's tables as bodies (routes/terrain_tables.py).
# Since 2026-09-22 the values inside them are governed per TABLE, in the same
# two words STREAMS uses above:
#
#   "public":  a visitor reads the real values
#   "frosted": a visitor gets blocks the length the value was — the row is
#              still there, the columns are still there, the counts are still
#              honest, and nothing inside can be read
#
# Her rule, verbatim: "The only ones I care about hiding are specifically my
# journal rows and personal records of what I've said about myself and others"
# — and, on what should happen to those: "I want it visible in terms of the
# columns and rows but no actual information to be readable."
#
# So NOTHING IS EVER HIDDEN HERE. Every table keeps every row. The marks below
# only ever decide whether a value is legible, which means this whole layer can
# only take frost OFF; it can never open a door that wasn't already open.
#
# UNKNOWN TABLE → FROSTED, deliberately, same as STREAMS' unknown-key rule: a
# table added by a future migration rung in sqlstore.py publishes nothing until
# someone lists it here on purpose.
#
# Two tables are decided PER ROW rather than per table, because half of each is
# hers and half isn't. Those two rules can't live here — they need to read the
# row — so they live in routes/terrain_tables.py (`_commits_row_rule` and
# `_sessions_row_rule`, resolved by `_visitor_policy`), and they are
# the only thing about this policy that isn't in this file:
#   commits  — a skeleton commit's subject is already public on GitHub and
#              reads in full; a vault commit's subject is frosted.
#   sessions — a Coding session keeps its title; every other one reads
#              "Personal"/"Orchestra" and has its id frosted, matching what
#              routes/terrain.py does to the same sessions on the map.
TABLES = {
    # ---- the code and the machine: published in full --------------------
    # Files and their history, in both repos. Vault PATHS travel here (a
    # filename is not speech, and her 2026-09-17 call already put every dot
    # from both repos on the public map) — their CONTENTS never do; the file
    # endpoint still refuses anything but git-tracked app code to a visitor.
    "files": "public",
    "file_paths": "public",
    "commits": "public",        # ...except vault subjects — see the row rules
    "commit_files": "public",
    "code_files": "public",
    "code_edges": "public",
    # What ran, and what it did. Slash-command names, working directories and
    # transcript paths: her call, "publish".
    "command_runs": "public",
    "command_sources": "public",
    "job_runs": "public",
    "traces": "public",
    "trace_spans": "public",
    # Which files a session touched and when it was working. The activity is
    # the exhibit; WHOSE session it was is handled by the row rule on `sessions`.
    "sessions": "public",       # ...except non-Coding titles and ids
    "session_files": "public",
    "session_turns": "public",
    "attention_segments": "public",
    # Category names only — no content hangs off either of these here. The
    # tables that attach them to her actual life (todo_fronts, expenses) are
    # frosted below.
    "fronts": "public",
    "expense_categories": "public",

    # ---- her life: the shape shows, the values don't --------------------
    # The journal itself: cards are what she wrote, tags are what was said
    # about them.
    "cards": "frosted",
    "card_tags": "frosted",
    "tags": "frosted",
    # Dev and idea notes (notestore.py), and the verdicts on them.
    "notes": "frosted",
    "note_judgments": "frosted",
    # THE ONE THAT DOESN'T LOOK LIKE A HAZARD. `docs` is not documentation: it
    # is every JSON collection stored whole, one row each, contents in a `data`
    # column — contacts, budget, research, reminders, archivals. STREAMS above
    # governs the /api/data/* endpoints and has NO SAY over this table, so
    # publishing it would hand a visitor everything STREAMS hides.
    "docs": "frosted",
    # The to-do queue, and the three tables that hang off it. `todo_fronts`
    # says which area of her life each to-do belongs to.
    "todos": "frosted",
    "todo_subtasks": "frosted",
    "todo_agent_notes": "frosted",
    "todo_fronts": "frosted",
    # The filer's proposals and her rulings on them (empty today).
    "filer_nominations": "frosted",
    "filer_verdicts": "frosted",
    # Real cents and the bank's memo line. STREAMS already multiplies every
    # public dollar figure by a private factor, so publishing these rows would
    # undo a decision she has already made.
    "expenses": "frosted",
    # Health. The names in `habits` are peptides, supplements and somatic
    # practice, and `habit_aliases` carries the SAME names under every key the
    # app has ever logged — frosting one without the other publishes both.
    "habits": "frosted",
    "habit_aliases": "frosted",
    "habit_entries": "frosted",
}


# --- What a stranger may reach ------------------------------------------------
#
# Three tuples, joined into PUBLIC_PATHS at the bottom:
#
#   _SHELL_PATHS        what any browser needs to render ANY public page — the
#                       SPA shell, its assets, the service worker, the front
#                       door. Never personal; never needs deciding.
#   PRESENTABLE_PATHS   the pages and APIs the owner has decided a visitor may
#                       open TODAY. This is the list to edit.
#   _NOT_YET_PRESENTABLE  everything that USED to be public and was closed on
#                       2026-09-17 ("only Terrain for now" — the public site is
#                       a portfolio, and its one exhibit is the Terrain map).
#                       Each line is a working entry: to reopen a page, move
#                       its line (and its API's) up into PRESENTABLE_PATHS.
#                       tests/test_public_only.py checks every line here is
#                       actually closed, so a move is the only way to reopen.
#
# Everything else: API → 401, page → redirect (to /login on the private site,
# to / on a public-only mirror). Matching is exact, except entries ending in
# "/" or "-" which are prefixes (see is_public_path).

_SHELL_PATHS = (
    "/login",
    "/logout",
    "/static/",
    "/",
    "/api/version",
    # The web-push hook door (routes/push.py): Claude Code's Stop/Notification
    # hooks POST here from localhost with no session cookie, authenticated by
    # a shared secret checked inside the route itself instead.
    "/api/push/notify",
    # The terrain-mirror door (routes/terrain_mirror.py): the private box
    # POSTs its freshly built map here every few seconds, with no session
    # cookie, authenticated by a shared secret checked inside the route. Only
    # live on a public-only mirror; 404 on the private site.
    "/api/observatory/terrain/ingest",
    # The React SPA shell (routes/spa.py) — the app-shell HTML/JS/CSS/
    # manifest/SW must all be reachable to render the public landing at all.
    "/assets/",
    "/manifest.webmanifest",
    "/registerSW.js",
    "/sw.js",
    "/workbox-",  # hashed workbox runtime at dist root; see is_public_path prefix rule below
    # Everything the SW precache manifest lists must be public, or a logged-out
    # browser's SW install caches login redirects (or fails) instead of assets.
    "/index.html",
    # US county/state outlines the food map draws its regions from
    # (frontend/public/geo/, served by routes/spa.py). Public boundary data,
    # nothing personal — and without it a visitor's map shows dots, not shapes.
    "/geo/",
    "/icon-192.png",
    "/icon-512.png",
)

PRESENTABLE_PATHS = (
    # The Terrain map (routes/terrain.py). Open to visitors by the owner's
    # decision (2026-09-17): every dot from both repos, and the session orbs.
    # NOT their titles any more — her 2026-09-22 call, "everything that isn't
    # coding should be opaque; activity is fine to show". A Coding session
    # keeps its name and its id; every other session keeps its orb, its
    # footprint and its lane, and wears the room's name ("Personal") over an
    # opaque handle. Session ids are timestamps, so the id is as telling as
    # the title and goes with it; the redaction is server-side, in one seam
    # (terrain._redact_sessions), and covers the published mirror too.
    # What stays locked is file TEXT — the file endpoint refuses
    # anything but git-tracked app code to a visitor (see _visitor_may_read
    # there) — and everything that writes, arms, streams or quotes her: the
    # other rooms, traces, flow (it carries the text being written) and the
    # session roster are deliberately NOT listed. Exact paths, never a
    # prefix, so a new endpoint under /terrain/ is closed until someone adds
    # it here on purpose.
    "/terrain",
    "/terrain/map",
    "/api/observatory/terrain",
    "/api/observatory/terrain/file",
    # When each line of a file was last edited (git blame), and when the
    # function around each line last ran (the runtime sensor). Same front
    # door as the file's text above, so the same visitor lock: git-tracked
    # app code only.
    "/api/observatory/terrain/file/edits",
    "/api/observatory/terrain/file/runs",
    # One file in a tab of its own — the ↗ on the map's file pane. The page
    # reads through the three endpoints above and nothing else, so it needs
    # no lock of its own.
    "/code",
    # The threads on the map (routes/creek.py): which app-code file reads or
    # writes which store collection, with traffic counts. Collection NAMES and
    # verbatim lines of the shareable code — architecture, never contents.
    # Only this exact path: the /api/creek/collection/... endpoints below it
    # return what the data IS, and stay shut.
    "/api/creek",
    # The pond landmark's silhouette (routes/pond.py): one row per day, how
    # many journal cards and how long each was. Counts and lengths, never a
    # word of a card. The pond itself (/terrain/pond) stays shut.
    "/api/pond/shape",
    # The database's own tables, as bodies on the map. A visitor gets the
    # architecture — tables, columns, types, row counts, foreign keys, the
    # plain-English notes — and then, per table, either the real values or
    # blocks the length the value was. Which is which is TABLES above; the
    # frosting is done server-side in routes/terrain_tables.py, so nothing but
    # shape crosses the wire for a frosted table.
    #
    # Her 2026-09-22 call replaced the uniform first cut ("i want it published
    # but the actual values inside of the tables will be blurred") with a real
    # line: "Most of the database needs to be readable too, just not the stuff
    # that is very personal." So the code and machine tables read in full, and
    # search, filters and sort WORK again for a visitor — restricted to the
    # columns that are public on every row, because a matching COUNT over a
    # frosted column is a value read one bit at a time.
    #
    # The SQL console (/terrain/sql) stays shut: arbitrary reads, not a
    # described shape.
    "/api/observatory/terrain/tables",
    "/api/observatory/terrain/tables/rows",
    "/api/observatory/terrain/tables/row",
    "/api/observatory/terrain/tables/column",
    # The food-sourcing map (routes/ecosystem.py, the Ecosystem feature).
    # Reopened 2026-09-17 as the second exhibit: the portfolio frames
    # /food-map?embed=1 and links through to the full page. STREAMS above
    # decides what the data feed shows a visitor (sources + the light recipe
    # list); editing is owner-only on the page and behind the auth gate for
    # every write endpoint.
    "/food-map",
    "/api/data/ecosystem",
)

_NOT_YET_PRESENTABLE = (
    # The about page (CONTENT_DIR/public_about.md). The portfolio's own about
    # copy lives on the static page at the apex domain now.
    "/about",
    "/api/about",
    # The frosted dashboard and its data. STREAMS above still decides what
    # each of these would show once reopened — that filter never went away.
    "/todos",
    "/dashboard",
    "/dashboard/today",
    "/dashboard/map",
    "/dashboard/kitchen",
    "/dashboard/inventory",
    "/dashboard/money",
    "/dashboard/ecosystem",
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
    # Old public bookmarks; each only redirected to a native tab path above.
    "/legacy/map",
    "/legacy/kitchen",
    "/legacy/inventory",
    "/legacy/money",
    "/legacy/ecosystem",
)

PUBLIC_PATHS = _SHELL_PATHS + PRESENTABLE_PATHS


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
    # Row-level redaction: drop private activity types from the otherwise-public
    # activity log so they never reach a logged-out browser. The live set comes
    # from the reminders' `private` flags (server computes it into
    # `private_act_types`); fall back to the owner's configured list if absent.
    private_types = set(data.get("private_act_types") or private_activity_types())
    if isinstance(out.get("activity_log"), list):
        out["activity_log"] = [
            e for e in out["activity_log"]
            if not (isinstance(e, dict) and e.get("type") in private_types)
        ]
    # Money: replace absolute dollar figures with relative values (see docstring)
    _scale_money_streams(out)
    return out
