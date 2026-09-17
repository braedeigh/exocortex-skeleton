#!/usr/bin/env python3
"""scripts/usage_compare.py — compare two or more usage-export bundles
side by side.

Reads files produced by GET /api/usage/export (schema "usage-export/1" —
see routes/usage.py), never the live collection: no store import, stdlib
only. Each column is labeled by the bundle's own ``label`` (the person's
self-chosen handle) or, failing that, the filename.

    venv/bin/python3 scripts/usage_compare.py mine.json theirs.json ...

Per file: days covered + date range, top 8 tabs by hours (with visits),
top 10 controls by taps (all pages merged, names page-prefixed like
``journal/card-edit``), top 8 routes by requests, and an "only in <label>"
section listing tabs/controls the other bundles don't have at all — the
divergence is the interesting signal: different people live in different
parts of the app.

Aggregation is pure functions over parsed bundles so tests can feed
literal dicts.
"""
import json
import os
import sys

SCHEMA = "usage-export/1"

TOP_TABS = 8
TOP_CONTROLS = 10
TOP_ROUTES = 8


# --- pure functions over parsed bundles --------------------------------------

def valid_bundle(obj):
    """True iff `obj` looks like a usage-export/1 bundle."""
    return (isinstance(obj, dict)
            and obj.get("schema") == SCHEMA
            and isinstance(obj.get("days"), dict))


def bundle_label(bundle, fallback):
    """The bundle's self-chosen label, else `fallback` (usually the filename)."""
    label = bundle.get("label")
    return label if isinstance(label, str) and label.strip() else fallback


def coverage(bundle):
    """(day count, first day, last day) — (0, None, None) when empty."""
    days = sorted(bundle.get("days", {}))
    if not days:
        return (0, None, None)
    return (len(days), days[0], days[-1])


def tab_totals(days):
    """'time' + 'tabs' folded: tab -> {"seconds", "visits"}."""
    out = {}
    for day in days.values():
        for tab, secs in (day or {}).get("time", {}).items():
            out.setdefault(tab, {"seconds": 0, "visits": 0})["seconds"] += secs
        for tab, n in (day or {}).get("tabs", {}).items():
            out.setdefault(tab, {"seconds": 0, "visits": 0})["visits"] += n
    return out


def control_totals(days):
    """'clicks' folded across pages: "page/control" -> taps."""
    out = {}
    for day in days.values():
        for page, controls in (day or {}).get("clicks", {}).items():
            for control, n in controls.items():
                name = f"{page}/{control}"
                out[name] = out.get(name, 0) + n
    return out


def route_totals(days):
    """'api' folded: feature -> total requests (reads + writes)."""
    out = {}
    for day in days.values():
        for feature, counts in (day or {}).get("api", {}).items():
            out[feature] = (out.get(feature, 0)
                            + counts.get("reads", 0) + counts.get("writes", 0))
    return out


def top_tabs(days, n=TOP_TABS):
    """[(tab, {"seconds","visits"})] by seconds desc, visits desc, name asc."""
    return sorted(tab_totals(days).items(),
                  key=lambda kv: (-kv[1]["seconds"], -kv[1]["visits"], kv[0]))[:n]


def top_controls(days, n=TOP_CONTROLS):
    """[("page/control", taps)] by taps desc, name asc."""
    return sorted(control_totals(days).items(),
                  key=lambda kv: (-kv[1], kv[0]))[:n]


def top_routes(days, n=TOP_ROUTES):
    """[(feature, requests)] by requests desc, name asc."""
    return sorted(route_totals(days).items(),
                  key=lambda kv: (-kv[1], kv[0]))[:n]


def only_in(sets):
    """Per index: the items that set has and NO other set has (sorted lists)."""
    out = []
    for i, s in enumerate(sets):
        others = set()
        for j, other in enumerate(sets):
            if j != i:
                others |= other
        out.append(sorted(s - others))
    return out


def divergence(days_list):
    """Per bundle: {"tabs": [...], "controls": [...]} nobody else has."""
    tab_sets = [set(tab_totals(d)) for d in days_list]
    control_sets = [set(control_totals(d)) for d in days_list]
    return [{"tabs": t, "controls": c}
            for t, c in zip(only_in(tab_sets), only_in(control_sets))]


# --- plain-text layout -------------------------------------------------------

def columnize(blocks, widths=None, gap="   "):
    """Blocks (list of list-of-lines) laid out side by side, left-aligned.
    Pass `widths` to keep column edges identical across several calls."""
    height = max((len(b) for b in blocks), default=0)
    if widths is None:
        widths = [max((len(line) for line in b), default=0) for b in blocks]
    lines = []
    for row in range(height):
        cells = [(b[row] if row < len(b) else "").ljust(w)
                 for b, w in zip(blocks, widths)]
        lines.append(gap.join(cells).rstrip())
    return lines


def bundle_sections(bundle, label):
    """One bundle's column, as a list of sections (each a list of lines) so
    the report can row-align section starts across bundles."""
    days = bundle.get("days", {})
    n, first, last = coverage(bundle)
    header = [label, "=" * len(label),
              f"{n} day(s), {first} .. {last}" if n else "no days recorded"]

    tabs = [f"top {TOP_TABS} tabs (hours, visits):"]
    tabs += [f"  {tab:<18}{t['seconds'] / 3600:>7.1f}h  {t['visits']:>4} visits"
             for tab, t in top_tabs(days)] or ["  (no time data)"]

    controls = [f"top {TOP_CONTROLS} controls (taps):"]
    controls += [f"  {name:<28}{taps:>6}"
                 for name, taps in top_controls(days)] or ["  (no click data)"]

    routes = [f"top {TOP_ROUTES} routes (requests):"]
    routes += [f"  {name:<18}{reqs:>7}"
               for name, reqs in top_routes(days)] or ["  (no api data)"]

    return [header, tabs, controls, routes]


def divergence_lines(labels, days_list):
    """The "only in <label>" sections, stacked (they read better full-width)."""
    lines = []
    for label, div in zip(labels, divergence(days_list)):
        lines += ["", f"only in {label}:"]
        if div["tabs"]:
            lines.append("  tabs:     " + ", ".join(div["tabs"]))
        if div["controls"]:
            lines.append("  controls: " + ", ".join(div["controls"]))
        if not div["tabs"] and not div["controls"]:
            lines.append("  (nothing exclusive)")
    return lines


def build_report(bundles, labels):
    """The whole report as a list of lines (pure; no I/O). Sections start on
    the same row in every column; column widths are shared across sections."""
    per = [bundle_sections(b, lab) for b, lab in zip(bundles, labels)]
    widths = [max(len(line) for section in sections for line in section)
              for sections in per]
    lines = []
    for i in range(len(per[0])):
        if i:
            lines.append("")
        lines += columnize([sections[i] for sections in per], widths=widths)
    if len(bundles) > 1:
        lines += divergence_lines(labels, [b.get("days", {}) for b in bundles])
    return lines


# --- CLI ---------------------------------------------------------------------

def load_bundles(paths):
    """[(bundle, label)] for the readable, schema-valid files; warns on the
    rest (stderr) and skips them."""
    out = []
    for path in paths:
        try:
            with open(path, encoding="utf-8") as f:
                obj = json.load(f)
        except (OSError, ValueError) as e:
            print(f"warning: skipping {path}: {e}", file=sys.stderr)
            continue
        if not valid_bundle(obj):
            print(f"warning: skipping {path}: not a {SCHEMA} bundle",
                  file=sys.stderr)
            continue
        out.append((obj, bundle_label(obj, os.path.basename(path))))
    return out


def main(argv=None):
    args = (argv if argv is not None else sys.argv[1:])
    if not args:
        print("usage: usage_compare.py file1.json file2.json ...", file=sys.stderr)
        return 2
    loaded = load_bundles(args)
    if not loaded:
        print("error: no valid bundles to compare", file=sys.stderr)
        return 1
    bundles = [b for b, _ in loaded]
    labels = [lab for _, lab in loaded]
    for line in build_report(bundles, labels):
        print(line)
    return 0


if __name__ == "__main__":
    # Put this run on the runtime map (runtime_sensor.py): which of our
    # files actually execute, and which call which. Inside __main__ rather
    # than at import, because some of these modules are also imported BY
    # the web app, and only the standalone run is a process of its own.
    import sys as _sys, pathlib as _pathlib
    _sys.path.insert(0, str(_pathlib.Path(__file__).resolve().parents[1]))
    import runtime_sensor
    runtime_sensor.attach()
    sys.exit(main())
