#!/usr/bin/env python3
"""scripts/usage_doctor.py — weekly architecture-pulse report over
feature_usage.json (the collection all five usage writers feed — see
routes/usage.py for the shape).

Where scripts/research_doctor.py checks one subsystem's *integrity*, this
reports the whole app's *pulse*: which routes actually get hit, which
collections the store actually reads and writes (per caller, from the
"store" key that store.py's op counters flush), which tabs she actually
lives in — and, just as important, which route modules and collections saw
ZERO traffic, the candidates for pruning or benign neglect. The zero-traffic
sections are labeled with when collection started, because "no traffic in 28
days of data" and "no traffic since telemetry landed last Tuesday" are very
different claims.

Read-only over usage data; aggregation is pure functions over the `days`
dict so tests can feed literal dicts. `--devnote` posts (or replaces) one
`[usage] ...` summary note on dev_notes.json — same replace-not-append
mechanics as research_doctor's `[doctor]` note.

    EXOCORTEX_DATA_DIR=... venv/bin/python3 scripts/usage_doctor.py
    EXOCORTEX_DATA_DIR=... venv/bin/python3 scripts/usage_doctor.py --devnote

Meant for a weekly cron tick; running it more often is harmless.
"""
import argparse
import os
import sys
from datetime import date, timedelta

# Make the skeleton root importable regardless of where the script is invoked
# from (mirrors scripts/research_doctor.py's bootstrap).
HERE = os.path.dirname(os.path.abspath(__file__))
SKELETON = os.path.dirname(HERE)
if SKELETON not in sys.path:
    sys.path.insert(0, SKELETON)

import store  # noqa: E402

WINDOW_DAYS = 28
DEVNOTE_TAB = "usage"
DEVNOTE_PREFIX = "[usage] "

# routes/ modules that are plumbing, not features: spa serves the built React
# bundle (no /api surface of its own) and shell is legacy redirects + the
# VALID_TABS constant. Everything else in the package registers real /api
# feature endpoints and is fair game for the zero-traffic list.
INFRA_MODULES = {"spa", "shell"}


# --- pure aggregation (days dict in, plain data out) -------------------------

def window(days, today, n=WINDOW_DAYS):
    """The trailing-n-days subset of `days` (ISO date keys), today included."""
    start = (date.fromisoformat(today) - timedelta(days=n - 1)).isoformat()
    return {d: day for d, day in days.items() if start <= d <= today}


def first_date_seen(days, key):
    """Earliest date whose day dict carries `key` ('api'/'store'/...), or
    None — i.e. when that data source started collecting."""
    dates = [d for d, day in days.items() if key in (day or {})]
    return min(dates) if dates else None


def _sum_counts(into, counts):
    into["reads"] += counts.get("reads", 0)
    into["writes"] += counts.get("writes", 0)


def route_totals(days):
    """The 'api' key folded: feature -> {"reads", "writes"}."""
    out = {}
    for day in days.values():
        for feature, counts in (day or {}).get("api", {}).items():
            _sum_counts(out.setdefault(feature, {"reads": 0, "writes": 0}), counts)
    return out


def store_caller_totals(days):
    """The 'store' key folded: caller -> collection -> {"reads", "writes"}."""
    out = {}
    for day in days.values():
        for caller, colls in (day or {}).get("store", {}).items():
            per = out.setdefault(caller, {})
            for coll, counts in colls.items():
                _sum_counts(per.setdefault(coll, {"reads": 0, "writes": 0}), counts)
    return out


def store_collection_totals(days):
    """collection -> {"reads", "writes"}, summed across callers."""
    out = {}
    for per in store_caller_totals(days).values():
        for coll, counts in per.items():
            _sum_counts(out.setdefault(coll, {"reads": 0, "writes": 0}), counts)
    return out


def _top(totals, n):
    """[(name, {"reads","writes"})] sorted by reads+writes desc, name asc."""
    return sorted(totals.items(),
                  key=lambda kv: (-(kv[1]["reads"] + kv[1]["writes"]), kv[0]))[:n]


def top_routes(days, n=10):
    return _top(route_totals(days), n)


def top_collections(days, n=10):
    return _top(store_collection_totals(days), n)


def caller_breakdown(days, n=5):
    """caller -> its top-n [(collection, total ops)], callers sorted by name."""
    return {
        caller: [(coll, c["reads"] + c["writes"]) for coll, c in _top(per, n)]
        for caller, per in sorted(store_caller_totals(days).items())
    }


def tab_totals(days):
    """'tabs' + 'time' folded: tab -> {"visits", "seconds"}."""
    out = {}
    for day in days.values():
        for tab, n in (day or {}).get("tabs", {}).items():
            out.setdefault(tab, {"visits": 0, "seconds": 0})["visits"] += n
        for tab, secs in (day or {}).get("time", {}).items():
            out.setdefault(tab, {"visits": 0, "seconds": 0})["seconds"] += secs
    return out


def top_tabs(days, n=10):
    """[(tab, {"visits","seconds"})], by visits desc, seconds desc, name asc."""
    return sorted(tab_totals(days).items(),
                  key=lambda kv: (-kv[1]["visits"], -kv[1]["seconds"], kv[0]))[:n]


def seen_api_features(days):
    return set(route_totals(days))


def seen_store_collections(days):
    return set(store_collection_totals(days))


def zero_traffic_routes(module_features, seen_features):
    """Route modules none of whose /api features appear in `seen_features`.
    `module_features` maps module name -> set of /api/<feature> first
    segments it registers (a module with an empty set is skipped — it has no
    /api surface to measure)."""
    seen = set(seen_features)
    return sorted(m for m, feats in module_features.items()
                  if feats and not (feats & seen))


def zero_traffic_collections(known_collections, seen_collections):
    """Known collections never touched via the store (feature_usage itself is
    the telemetry sink, not a signal — always dropped)."""
    return sorted(set(known_collections) - set(seen_collections) - {"feature_usage"})


# --- environment probes (the impure inputs to the pure functions) ------------

def route_module_features():
    """module name -> set of /api/<feature> first segments it registers,
    discovered by registering each routes/ module into a throwaway Flask app
    (so multi-feature modules like health.py and renamed surfaces like
    food_test.py -> /api/body are mapped truthfully, not guessed from file
    names). Infra modules (INFRA_MODULES) and non-route files are skipped."""
    import importlib
    import pkgutil

    from flask import Flask

    import routes

    out = {}
    for info in pkgutil.iter_modules(routes.__path__):
        name = info.name
        if name in INFRA_MODULES or name.startswith("_"):
            continue
        try:
            mod = importlib.import_module(f"routes.{name}")
            register = getattr(mod, "register", None)
            if register is None:
                continue
            app = Flask(__name__)
            register(app)
            feats = set()
            for rule in app.url_map.iter_rules():
                parts = str(rule).split("/")
                if len(parts) > 2 and parts[1] == "api" and parts[2] and not parts[2].startswith("<"):
                    feats.add(parts[2])
            out[name] = feats
        except Exception as e:  # a broken module shouldn't kill the report
            print(f"note: could not inspect routes.{name}: {e}")
    return out


def known_collections():
    """SQL_COLLECTIONS ∪ every *.json in DATA_DIR (mirrors included) — the
    universe the zero-traffic collection diff runs against."""
    known = set(store.SQL_COLLECTIONS)
    try:
        known |= {p.stem for p in store.DATA_DIR.glob("*.json")}
    except OSError:
        pass
    return known


# --- report ------------------------------------------------------------------

def _fmt_counts(c):
    return f"{c['reads'] + c['writes']:>7}  ({c['reads']}r + {c['writes']}w)"


def build_report(days, today, module_features, known):
    """The whole plain-text report as a list of lines. `days` is the FULL
    days dict (the window is cut here; first-date-seen looks at all of it)."""
    win = window(days, today)
    start = (date.fromisoformat(today) - timedelta(days=WINDOW_DAYS - 1)).isoformat()
    lines = [f"architecture pulse — trailing {WINDOW_DAYS} days ({start} .. {today})"]

    lines += ["", "routes (api requests) — top 10:"]
    routes_top = top_routes(win)
    if routes_top:
        lines += [f"  {name:<24}{_fmt_counts(c)}" for name, c in routes_top]
    else:
        lines.append("  (no api data in the window)")

    lines += ["", "collections (store ops) — top 10:"]
    colls_top = top_collections(win)
    if colls_top:
        lines += [f"  {name:<24}{_fmt_counts(c)}" for name, c in colls_top]
    else:
        lines.append("  (no store data in the window)")

    breakdown = caller_breakdown(win)
    if breakdown:
        lines += ["", "per caller (top 5 collections each):"]
        for caller, tops in breakdown.items():
            listed = ", ".join(f"{coll} ({n})" for coll, n in tops)
            lines.append(f"  {caller}: {listed}")

    lines += ["", "tabs (visits, hours) — top 10:"]
    tabs = top_tabs(win)
    if tabs:
        lines += [f"  {tab:<24}{t['visits']:>5} visits  {t['seconds'] / 3600:>6.1f}h"
                  for tab, t in tabs]
    else:
        lines.append("  (no tab data in the window)")

    def since(key):
        first = first_date_seen(days, key)
        return (f"collection started {first}" if first
                else "no data of this kind collected yet")

    lines += ["", f"zero-traffic route modules — no api hits in the last "
                  f"{WINDOW_DAYS} days of collected data ({since('api')}):"]
    quiet_routes = zero_traffic_routes(module_features, seen_api_features(win))
    lines += [f"  - {m}" for m in quiet_routes] or ["  (none)"]

    lines += ["", f"zero-traffic collections — no store ops in the last "
                  f"{WINDOW_DAYS} days of collected data ({since('store')}):"]
    quiet_colls = zero_traffic_collections(known, seen_store_collections(win))
    lines += [f"  - {c}" for c in quiet_colls] or ["  (none)"]

    return lines


def summary_line(days, today, module_features, known):
    """The one-line devnote version of the report."""
    win = window(days, today)
    routes_top = top_routes(win, 1)
    colls_top = top_collections(win, 1)
    quiet_r = zero_traffic_routes(module_features, seen_api_features(win))
    quiet_c = zero_traffic_collections(known, seen_store_collections(win))
    top_route = (f"top route {routes_top[0][0]} "
                 f"({routes_top[0][1]['reads'] + routes_top[0][1]['writes']})"
                 if routes_top else "no api data")
    top_coll = (f"top collection {colls_top[0][0]} "
                f"({colls_top[0][1]['reads'] + colls_top[0][1]['writes']})"
                if colls_top else "no store data")
    return (f"{WINDOW_DAYS}d pulse: {top_route}; {top_coll}; "
            f"{len(quiet_r)} quiet route module(s), "
            f"{len(quiet_c)} untouched collection(s)")


def _post_devnote(summary):
    """Write/replace the pulse's own '[usage] ...' note on the usage tab of
    dev_notes.json — same replace-not-append mechanics as research_doctor's
    _post_devnote. Direct store write — this is a script, not a route."""
    from routes.devnotes import load_dev_notes, save_dev_notes, _new_note

    d = load_dev_notes()
    tab_notes = d.setdefault("tabs", {}).setdefault(DEVNOTE_TAB, [])
    tab_notes[:] = [n for n in tab_notes if not str(n.get("text", "")).startswith(DEVNOTE_PREFIX)]
    tab_notes.append(_new_note(f"{DEVNOTE_PREFIX}{summary}"))
    save_dev_notes(d)


def main():
    parser = argparse.ArgumentParser(
        description="Weekly architecture-pulse report over feature_usage.json: "
                    "top routes/collections/tabs and the zero-traffic lists.",
    )
    parser.add_argument(
        "--devnote", action="store_true",
        help="post (replacing any previous) a '[usage] ...' summary note on "
             "dev_notes.json's usage tab",
    )
    args = parser.parse_args()

    days = store.read("feature_usage.json", {"days": {}}).get("days", {})
    today = date.today().isoformat()
    module_features = route_module_features()
    known = known_collections()

    for line in build_report(days, today, module_features, known):
        print(line)

    if args.devnote:
        _post_devnote(summary_line(days, today, module_features, known))


if __name__ == "__main__":
    main()
