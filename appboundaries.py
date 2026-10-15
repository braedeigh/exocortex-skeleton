"""Where the apps reach into each other — the tangle to shrink before each app
can live in a repo of its own.

Plain English: apps.json cuts the site into apps, and projects.json says
which code and tables make up each project, so between them every file and
table belongs to one app (or to Core, which every app shares). This file
walks the code and lists every CROSSING: a place where one app's code uses
another app's. Four kinds:

  import    a Python file (a module, a route, a script, a tool) imports a
            module another app owns;
  frontend  a page's code (frontend/src/features/<feature>/) imports from
            another app's feature folder;
  table     a Python file names another app's table in its SQL. This one is
            a TEXT HEURISTIC, not a parse: it looks for the table's name
            right after FROM / JOIN / INTO / UPDATE / TABLE. It can miss SQL
            built up in pieces, and it can catch a comment that reads like
            SQL. Good enough to see the tangle, not a proof;
  page      an app shows a page another app holds (apps.json `borrows`) —
            the Journal showing the Observatory's session list.

Core (projects.json `core`, apps.json shared.projects) is everyone's, so
nothing to or from it is a crossing. Based Foods' pages (the kitchen project)
count as their own app here: Journal code reaching into the kitchen is a
crossing like any other.

THE RATCHET. Today's crossings are written down in
app_boundaries_baseline.json. tests/test_app_boundaries.py fails when a
crossing appears that isn't in it (new tangle), and when one in it no longer
happens (untangled — take it out, so it can't come back unnoticed). So the
list can only shrink. `python3 appboundaries.py --prune` takes the fixed ones
out; adding to the baseline is a hand edit, on purpose.

Touches: apps.json, projects.json, app_boundaries_baseline.json,
routes/apps.py (serves this to the Terrain's Apps room),
tests/test_app_boundaries.py. Design: docs/apps.md.

Prompt that produced it: "i want to just refactor it such that they are
separate enough to be in their own repos" — this is the map of how far that is.
"""
import ast
import json
import re
import sys
from pathlib import Path

import appmap

ROOT = Path(__file__).resolve().parent
PROJECTS_FILE = ROOT / "projects.json"
BASELINE_FILE = ROOT / "app_boundaries_baseline.json"
FEATURES = ROOT / "frontend" / "src" / "features"

# The app id the kitchen project's code counts as (apps.json based_foods).
BASED_FOODS = "based-foods"


def projects():
    return json.loads(PROJECTS_FILE.read_text())["projects"]


def project_apps():
    """{project: app id}, None for the shared ones (Core)."""
    data = appmap.load()
    owner = {project: None for project in data["shared"]["projects"]}
    for app_id, entry in data["apps"].items():
        for project in entry["projects"]:
            owner[project] = app_id
    for project in data["based_foods"]["projects"]:
        owner[project] = BASED_FOODS
    return owner


# --- who owns which file ------------------------------------------------------

def _python_owners():
    """{repo-relative path or folder: project} for every Python unit listed
    in projects.json: top-level modules, routes, scripts, tools."""
    owners = {}
    for project_id, project in projects().items():
        for name in project["modules"]:
            owners[name] = project_id
        for name in project["routes"]:
            owners[f"routes/{name}"] = project_id
        for name in project["scripts"]:
            owners[f"scripts/{name}"] = project_id
        for name in project["tools"]:
            owners[f"tools/{name}"] = project_id
    return owners


def _owner_of_file(rel, owners):
    """The project a repo-relative file belongs to: listed itself, or inside
    a listed folder (routes/kitchen/, tools/stream/). None when unlisted."""
    if rel in owners:
        return owners[rel]
    parts = rel.split("/")
    for depth in range(len(parts) - 1, 0, -1):
        folder = "/".join(parts[:depth])
        if folder in owners:
            return owners[folder]
    return None


def _python_files(owners):
    """Every .py file some project owns, as repo-relative paths."""
    files = []
    for unit in owners:
        path = ROOT / unit
        if path.is_file() and path.suffix == ".py":
            files.append(unit)
        elif path.is_dir():
            files.extend(str(p.relative_to(ROOT)) for p in sorted(path.rglob("*.py"))
                         if "__pycache__" not in p.parts)
    return sorted(set(files))


def _imported_units(source):
    """The repo units one Python file imports, as repo-relative names a
    project can own: "foodstore.py", "routes/kitchen", "scripts/x.py",
    "tools/stream". Relative imports stay inside their own package and are
    skipped; anything not in this repo (flask, json) simply isn't owned."""
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return set()
    names = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            names.add(node.module)
            # `from routes import kitchen, todos` names the modules after `import`.
            if node.module in ("routes", "scripts", "tools") or node.module.startswith("tools."):
                names.update(f"{node.module}.{alias.name}" for alias in node.names)
    units = set()
    for name in names:
        parts = name.split(".")
        if parts[0] in ("routes", "scripts") and len(parts) > 1:
            base = ROOT / parts[0] / parts[1]
            units.add(f"{parts[0]}/{parts[1]}" if base.is_dir() else f"{parts[0]}/{parts[1]}.py")
        elif parts[0] == "tools" and len(parts) > 1:
            units.add(f"tools/{parts[1]}")
        elif len(parts) == 1 or parts[0] not in ("routes", "scripts", "tools"):
            units.add(f"{parts[0]}.py")
    return units


# --- the four kinds of crossing ----------------------------------------------

def _python_crossings(owners, app_of):
    found = []
    for rel in _python_files(owners):
        source_app = app_of.get(_owner_of_file(rel, owners))
        if source_app is None:
            continue
        for unit in sorted(_imported_units((ROOT / rel).read_text(errors="replace"))):
            target_app = app_of.get(_owner_of_file(unit, owners))
            if target_app is not None and target_app != source_app:
                found.append({"kind": "import", "from": rel, "to": unit,
                              "from_app": source_app, "to_app": target_app})
    return found


# A page's code importing a sibling feature: "../todos/api", "../../features/habits/x".
_TS_IMPORT = re.compile(r"""(?:from\s+|import\s*\(\s*)['"](\.[^'"]+)['"]""")


def _frontend_crossings(app_of):
    feature_project = {name: project_id for project_id, project in projects().items()
                       for name in project["frontend"]}
    found = []
    for path in sorted(FEATURES.rglob("*")):
        if path.suffix not in (".ts", ".tsx") or not path.is_file():
            continue
        feature = path.relative_to(FEATURES).parts[0]
        source_app = app_of.get(feature_project.get(feature))
        if source_app is None:
            continue
        targets = set()
        for spec in _TS_IMPORT.findall(path.read_text(errors="replace")):
            target = (path.parent / spec).resolve()
            try:
                other = target.relative_to(FEATURES).parts[0]
            except ValueError:
                continue
            if other != feature:
                targets.add(other)
        for other in sorted(targets):
            target_app = app_of.get(feature_project.get(other))
            if target_app is not None and target_app != source_app:
                found.append({"kind": "frontend", "from": str(path.relative_to(ROOT)),
                              "to": f"frontend/src/features/{other}",
                              "from_app": source_app, "to_app": target_app})
    return found


def _table_crossings(owners, app_of):
    """Another app's table named in SQL — the text heuristic described at the
    top. One pattern for all tables, longest name first so `cards_fts_data`
    isn't read as `cards`."""
    table_app = {table: app_of.get(project_id) for project_id, project in projects().items()
                 for table in project["tables"]}
    table_app = {table: app for table, app in table_app.items() if app is not None}
    names = sorted(table_app, key=len, reverse=True)
    pattern = re.compile(r"""(?i)\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\s+["'`]?(%s)\b"""
                         % "|".join(map(re.escape, names)))
    found = []
    for rel in _python_files(owners):
        source_app = app_of.get(_owner_of_file(rel, owners))
        if source_app is None:
            continue
        named = {match.lower() for match in pattern.findall((ROOT / rel).read_text(errors="replace"))}
        for table in sorted(named):
            target_app = table_app.get(table)
            if target_app is not None and target_app != source_app:
                found.append({"kind": "table", "from": rel, "to": table,
                              "from_app": source_app, "to_app": target_app})
    return found


def _page_crossings():
    found = []
    for app_id, entry in appmap.apps().items():
        for page in entry.get("borrows", []):
            owner = appmap.owner_of(page)
            if owner and owner != app_id:
                found.append({"kind": "page", "from": app_id, "to": page,
                              "from_app": app_id, "to_app": owner})
    return found


def key(crossing):
    """One crossing as a line of the baseline: "kind from -> to"."""
    return f"{crossing['kind']} {crossing['from']} -> {crossing['to']}"


def crossings():
    """Every crossing in the code right now, sorted by its key."""
    owners = _python_owners()
    app_of = project_apps()
    found = (_python_crossings(owners, app_of) + _frontend_crossings(app_of)
             + _table_crossings(owners, app_of) + _page_crossings())
    return sorted(found, key=key)


# --- the baseline -------------------------------------------------------------

def baseline():
    """The crossings written down as known, as a set of keys."""
    if not BASELINE_FILE.exists():
        return set()
    return set(json.loads(BASELINE_FILE.read_text())["crossings"])


def write_baseline(keys):
    BASELINE_FILE.write_text(json.dumps({
        "_about": ("Every place one app's code uses another's, as it stood when written down "
                   "(appboundaries.py). tests/test_app_boundaries.py fails on a crossing not "
                   "listed here, and on one listed here that no longer happens: the list only "
                   "shrinks. `python3 appboundaries.py --prune` drops the fixed ones. See docs/apps.md."),
        "crossings": sorted(keys),
    }, indent=2) + "\n")


def compare():
    """(new, fixed): crossings not in the baseline, and baseline entries
    that no longer happen."""
    now = {key(crossing) for crossing in crossings()}
    known = baseline()
    return sorted(now - known), sorted(known - now)


if __name__ == "__main__":
    # `--prune`: drop the crossings that are gone. Never adds one.
    new, fixed = compare()
    if "--prune" in sys.argv[1:]:
        write_baseline(baseline() - set(fixed))
        print(f"dropped {len(fixed)} fixed crossing(s)")
    print(f"{len(new)} new, {len(fixed)} fixed, {len(baseline())} in the baseline")
    for line in new:
        print("  new:", line)
