"""projects.json must cover the whole app, once, and point only at real things.

The map is for reading, so a wrong map is worse than none: someone trusts it
and misses a table. These checks fail the moment a new table, route, frontend
feature, top-level module or SQL collection lands without being given a
project — or when a listed file is renamed away.
"""
import json
from collections import Counter
from pathlib import Path

import pytest

import store

ROOT = Path(__file__).resolve().parent.parent
PROJECTS = json.loads((ROOT / "projects.json").read_text())["projects"]

# Each kind of thing the map lists, and where the real set of them comes from.
PLACES = {
    "modules": ROOT,
    "routes": ROOT / "routes",
    "frontend": ROOT / "frontend" / "src" / "features",
    "tools": ROOT / "tools",
    "scripts": ROOT / "scripts",
}


def _listed(kind):
    return Counter(item for project in PROJECTS.values() for item in project[kind])


def _actual(kind):
    if kind == "tables":
        notes = json.loads((ROOT / "table_notes.json").read_text())
        return {name for name in notes if not name.startswith("_")}
    if kind == "collections":
        return set(store.SQL_COLLECTIONS)
    if kind == "modules":
        return {path.name for path in ROOT.glob("*.py")}
    if kind == "routes":
        return {path.name for path in (ROOT / "routes").iterdir()
                if path.name not in ("__init__.py", "__pycache__")
                and (path.suffix == ".py" or (path / "__init__.py").exists())}
    if kind == "frontend":
        return {path.name for path in PLACES["frontend"].iterdir() if path.is_dir()}
    raise KeyError(kind)


@pytest.mark.parametrize("kind", ["tables", "collections", "modules", "routes", "frontend"])
def test_everything_belongs_to_exactly_one_project(kind):
    listed = _listed(kind)
    assert sorted(_actual(kind) - set(listed)) == [], f"{kind} with no project"
    assert sorted(name for name, count in listed.items() if count > 1) == [], f"{kind} in two projects"
    assert sorted(set(listed) - _actual(kind)) == [], f"{kind} listed but not real"


@pytest.mark.parametrize("kind", ["tools", "scripts"])
def test_listed_paths_exist(kind):
    missing = [name for name in _listed(kind) if not (PLACES[kind] / name).exists()]
    assert missing == []


def test_project_map_splits_rebuilt_tables_from_the_owners_record(data_dir, capsys):
    from scripts import project_map
    assert project_map.main(["kitchen"]) == 0
    printed = capsys.readouterr().out
    own, rebuilt = printed.split("## Rebuilt from a source")
    assert "foods " in own and "recipe_lines " in rebuilt and "recipe_lines " not in own
