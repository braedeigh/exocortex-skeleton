"""The apps may only grow apart: no new crossing between them, and a fixed
one comes off the list (appboundaries.py, app_boundaries_baseline.json).

A crossing is one app's code using another's — an import, a feature folder
reaching into another's, another app's table in SQL, a borrowed page. The
baseline is how tangled things were when the apps were drawn; this file
holds the line on it in both directions, so the tangle can only shrink.
See docs/apps.md.
"""
import pytest

import appboundaries


@pytest.fixture(scope="module")
def found():
    return appboundaries.crossings()


def test_no_new_crossing_between_apps(found):
    new = sorted({appboundaries.key(c) for c in found} - appboundaries.baseline())
    assert new == [], (
        "new crossings between apps — use Core, or the app's own code, instead; "
        "if one is truly wanted, add it to app_boundaries_baseline.json by hand"
    )


def test_a_fixed_crossing_comes_off_the_baseline(found):
    fixed = sorted(appboundaries.baseline() - {appboundaries.key(c) for c in found})
    assert fixed == [], "untangled — run `python3 appboundaries.py --prune` to take these off"


def test_a_new_import_of_another_apps_code_is_caught(tmp_path, monkeypatch):
    """The ratchet bites: a journal route that imports the kitchen's store
    is a crossing the baseline doesn't know."""
    root = tmp_path
    (root / "routes").mkdir()
    (root / "routes" / "diary.py").write_text("import foodstore\nfrom routes import money\n")
    (root / "routes" / "money.py").write_text("")
    (root / "foodstore.py").write_text("")
    monkeypatch.setattr(appboundaries, "ROOT", root)
    monkeypatch.setattr(appboundaries, "projects", lambda: {
        "journal": {"modules": [], "routes": ["diary.py"], "scripts": [], "tools": [], "tables": [], "frontend": []},
        "kitchen": {"modules": ["foodstore.py"], "routes": [], "scripts": [], "tools": [], "tables": [], "frontend": []},
        "money": {"modules": [], "routes": ["money.py"], "scripts": [], "tools": [], "tables": [], "frontend": []},
    })
    owners = appboundaries._python_owners()
    found = appboundaries._python_crossings(owners, {"journal": "journal", "kitchen": "based-foods", "money": "finances"})
    assert {appboundaries.key(c) for c in found} == {
        "import routes/diary.py -> foodstore.py", "import routes/diary.py -> routes/money.py"}


def test_another_apps_table_in_sql_is_caught(tmp_path, monkeypatch):
    (tmp_path / "todostore.py").write_text('db.execute("SELECT * FROM expenses JOIN todos ON 1")\n')
    monkeypatch.setattr(appboundaries, "ROOT", tmp_path)
    monkeypatch.setattr(appboundaries, "projects", lambda: {
        "todos": {"modules": ["todostore.py"], "routes": [], "scripts": [], "tools": [], "tables": ["todos"], "frontend": []},
        "money": {"modules": [], "routes": [], "scripts": [], "tools": [], "tables": ["expenses"], "frontend": []},
    })
    owners = appboundaries._python_owners()
    found = appboundaries._table_crossings(owners, {"todos": "journal", "money": "finances"})
    assert [appboundaries.key(c) for c in found] == ["table todostore.py -> expenses"]
