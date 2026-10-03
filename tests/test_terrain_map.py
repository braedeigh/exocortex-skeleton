"""Terrain's Map room — codebase maps read from markdown box files
(codemap.py, routes/terrain_map.py, scripts/codemap.py).

What has to hold, and would break without anyone noticing:

  - A map in any build's `docs/map/<name>/` is found and served whole: its
    boxes, their parents, their links with kind and reason.
  - A map kept outside its repo, in the data folder, works the same: served
    whole, and its boxes still go stale against the repo's files.
  - Keeping it true: a stamped box reads as current; editing one of its files
    makes it stale (and only it); deleting one makes it broken, and the
    nightly check fails on broken.
  - A typo costs a warning, not the map: a link to a missing box or a
    malformed line is reported on the box, and the box still arrives.
  - The import scan finds box-to-box imports through a workspace's own
    package names, which is how a Based Foods-style monorepo imports.
  - A visitor gets none of it.
"""
import pytest
from flask import Flask

import buildlist
import codemap
import store
from routes import observatory, terrain, terrain_map
from scripts import codemap as codemap_script


def _box(folder, box_id, **fields):
    """Write one box file the way docs/codemap.md describes it."""
    lines = ["---", f"id: {box_id}"]
    for key in ("name", "kind", "parent"):
        if key in fields:
            lines.append(f"{key}: {fields[key]}")
    for key in ("sources", "links"):
        if key in fields:
            lines.append(f"{key}:")
            lines += [f"  - {item}" for item in fields[key]]
    lines += ["---", "", fields.get("text", "A box.")]
    (folder / f"{box_id}.md").write_text("\n".join(lines) + "\n")


@pytest.fixture
def project(data_dir, tmp_path, monkeypatch):
    """A small pnpm-style workspace on the Builds list, with a map of three
    boxes: the project, an api that imports the shared contracts package, and
    the contracts."""
    monkeypatch.setattr(observatory, "_terrain_repos", lambda: ())
    monkeypatch.setattr(codemap.codestore, "default_repos", lambda: ())
    monkeypatch.setattr(buildlist, "_core_roots", lambda: (tmp_path / "app", tmp_path / "vault"))
    root = tmp_path / "shop"
    (root / "apps/api/src").mkdir(parents=True)
    (root / "packages/contracts/src").mkdir(parents=True)
    (root / "packages/contracts/package.json").write_text('{"name": "@shop/contracts"}')
    (root / "packages/contracts/src/index.ts").write_text("export const Food = 1;\n")
    (root / "apps/api/src/main.ts").write_text("import { Food } from '@shop/contracts';\n")
    folder = root / "docs/map/system"
    folder.mkdir(parents=True)
    _box(folder, "shop", name="Shop", kind="project")
    _box(folder, "api", name="API", parent="shop", sources=["apps/api/src/main.ts"],
         links=["depends-on contracts: The API checks every request against the shared shapes."])
    _box(folder, "contracts", name="Contracts", parent="shop", sources=["packages/contracts/"])
    store.write("terrain_builds", {"builds": [{"id": "shop", "name": "Shop", "root": str(root)}]})
    return root


@pytest.fixture
def client(project):
    app = Flask(__name__)
    app.config.update(TESTING=True)
    terrain_map.register(app)
    return app.test_client()


def test_a_builds_map_is_listed_and_served_whole(client):
    listed = client.get("/api/observatory/terrain/maps").get_json()
    assert [(m["key"], m["name"], m["boxes"]) for m in listed["maps"]] == [("shop/system", "Shop", 3)]

    body = client.get("/api/observatory/terrain/maps/shop/system").get_json()
    boxes = {box["id"]: box for box in body["boxes"]}
    assert body["root"] == "shop"
    assert boxes["api"]["parent"] == "shop"
    assert boxes["api"]["links"] == [{"kind": "depends-on", "to": "contracts",
                                      "reason": "The API checks every request against the shared shapes."}]
    assert client.get("/api/observatory/terrain/maps/shop/nope").status_code == 404


def test_a_map_kept_in_the_data_folder_describes_the_repo_from_outside(client, project, data_dir):
    """The repo carries no map files at all; the same boxes sit in the data
    folder and are checked against the repo's files."""
    home = data_dir / "codemaps" / "shop"
    home.mkdir(parents=True)
    (project / "docs/map/system").rename(home / "system")
    assert not any((project / "docs/map").iterdir())

    listed = client.get("/api/observatory/terrain/maps").get_json()
    assert [(m["key"], m["boxes"]) for m in listed["maps"]] == [("shop/system", 3)]

    codemap.stamp(codemap.find_map("shop/system"))
    (project / "apps/api/src/main.ts").write_text("// changed\n")
    boxes = {b["id"]: b for b in client.get("/api/observatory/terrain/maps/shop/system").get_json()["boxes"]}
    assert (boxes["api"]["stale"], boxes["contracts"]["stale"]) == (True, False)
    assert boxes["api"]["sources"] == [{"path": "apps/api/src/main.ts", "exists": True, "folder": False}]
    assert boxes["contracts"]["sources"][0]["folder"] is True


def test_editing_a_file_makes_only_its_box_stale_and_deleting_it_breaks_it(client, project, capsys):
    found = codemap.find_map("shop/system")
    codemap.stamp(found)
    assert codemap_script.main(["check", "shop/system"]) == 0
    assert "every box matches" in capsys.readouterr().out

    (project / "packages/contracts/src/index.ts").write_text("export const Food = 2;\n")
    boxes = {b["id"]: b for b in client.get("/api/observatory/terrain/maps/shop/system").get_json()["boxes"]}
    assert (boxes["contracts"]["stale"], boxes["api"]["stale"]) == (True, False)

    # Restamping after the words are rewritten clears it.
    codemap.stamp(found, {"contracts"})
    assert not any(b["stale"] for b in codemap.load(found)["boxes"])

    (project / "apps/api/src/main.ts").unlink()
    boxes = {b["id"]: b for b in codemap.load(found)["boxes"]}
    assert boxes["api"]["broken"] and boxes["api"]["sources"] == [
        {"path": "apps/api/src/main.ts", "exists": False, "folder": False}]
    assert codemap_script.main(["check"]) == 1


def test_a_typo_is_reported_on_its_box_and_the_box_still_arrives(client, project):
    _box(project / "docs/map/system", "web", name="Web", parent="shop",
         links=["calls apii: A typo in the target.", "pokes api: Not a link kind."])
    boxes = {b["id"]: b for b in client.get("/api/observatory/terrain/maps/shop/system").get_json()["boxes"]}
    assert boxes["web"]["links"] == []
    assert len(boxes["web"]["problems"]) == 2


def test_the_import_scan_follows_a_workspace_package_name(project):
    found = codemap.find_map("shop/system")
    assert codemap.import_links(codemap.load(found), project) == [("api", "contracts", 1)]


def test_a_visitor_gets_no_map(project, monkeypatch):
    """Through the real app and its gate."""
    monkeypatch.delenv("EXOCORTEX_PUBLIC_ONLY", raising=False)
    import server
    visitor = server.app.test_client()
    assert visitor.get("/api/observatory/terrain/maps").status_code == 401
    assert visitor.get("/api/observatory/terrain/maps/shop/system").status_code == 401
