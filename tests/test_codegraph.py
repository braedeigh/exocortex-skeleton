"""The static code graph (codegraph.py) and the endpoints that serve it.

What's pinned here is resolution — the part that can be silently, confidently
wrong. An import that resolves to the WRONG file draws an edge that reads as
fact, and an import that resolves to nothing leaves a hole in a graph whose
whole claim is completeness. So the tests are built around a small synthetic
repo whose correct answer is known by construction, plus one guard against the
specific bug this shipped with: a `from pkg.mod import ClassName` inventing an
external package edge because the speculative submodule guess didn't land.
"""
import json
import textwrap

import pytest
from flask import Flask

import codegraph
import runtime_sensor
import store
from routes import observatory, terrain


def _repo(root, files):
    for path, body in files.items():
        full = root / path
        full.parent.mkdir(parents=True, exist_ok=True)
        full.write_text(textwrap.dedent(body).lstrip())
    return {"id": "skeleton", "root": root}


def _edge_map(edges):
    return {(src, dst): json.loads(symbols)
            for _repo_id, src, _dr, dst, _kind, symbols in edges}


# --- python resolution --------------------------------------------------------

def test_python_import_forms_all_resolve(tmp_path):
    repo = _repo(tmp_path / "app", {
        "store.py": "DATA_DIR = '/x'\ndef mutate():\n    pass\n",
        "pkg/__init__.py": "",
        "pkg/thing.py": "class Slug:\n    pass\n",
        "server.py": """
            import store
            from pkg import thing
            from pkg.thing import Slug
            from . import store as sibling

            def go():
                store.mutate()
                return store.DATA_DIR, thing, Slug, sibling
        """,
    })
    _files, edges = codegraph.build([repo])
    edges = _edge_map(edges)

    # `import store` + the attributes actually reached for.
    assert set(edges[("server.py", "store.py")]) >= {"mutate", "DATA_DIR"}
    # `from pkg import thing` resolves to the MODULE, not just the package.
    assert ("server.py", "pkg/thing.py") in edges
    assert ("server.py", "pkg/__init__.py") in edges


def test_from_package_import_class_does_not_invent_a_package(tmp_path):
    """The regression this shipped with. `from pkg.thing import Slug` is tried
    as the submodule `pkg.thing.Slug`, which is a class and resolves to no
    file. Falling through to the external-package fallback invented an edge to
    a package named `pkg` — a WRONG row, which is worse than a missing one."""
    repo = _repo(tmp_path / "app", {
        "pkg/__init__.py": "",
        "pkg/thing.py": "class Slug:\n    pass\n",
        "user.py": "from pkg.thing import Slug\n\ndef go():\n    return Slug.match\n",
    })
    _files, edges = codegraph.build([repo])
    externals = {dst for _r, _s, dst_repo, dst, _k, _sym in edges if not dst_repo}
    assert "pkg" not in externals
    assert ("user.py", "pkg/thing.py") in _edge_map(edges)


def test_external_packages_are_kept_and_marked(tmp_path):
    repo = _repo(tmp_path / "app", {
        "a.py": "import flask\nfrom datetime import datetime\n",
    })
    _files, edges = codegraph.build([repo])
    ext = {dst for _r, _s, dst_repo, dst, _k, _sym in edges if not dst_repo}
    assert ext == {"flask", "datetime"}


def test_a_file_importing_itself_draws_no_edge(tmp_path):
    repo = _repo(tmp_path / "app", {"solo.py": "import solo\n"})
    _files, edges = codegraph.build([repo])
    assert ("solo.py", "solo.py") not in _edge_map(edges)


def test_unparseable_python_becomes_a_row_with_a_reason(tmp_path):
    """Every piece of code gets a row — a file the parser choked on is kept
    WITH the reason, because "what is unreachable" can't be answered from a
    table that silently drops its failures."""
    repo = _repo(tmp_path / "app", {"broken.py": "def (:\n"})
    files, _edges = codegraph.build([repo])
    row = next(f for f in files if f[1] == "broken.py")
    assert row[4] and "SyntaxError" in row[4]


# --- typescript resolution ----------------------------------------------------

def test_ts_relative_imports_resolve_through_the_suffix_ladder(tmp_path):
    repo = _repo(tmp_path / "app", {
        "src/api/client.ts": "export const api = 1;\n",
        "src/features/x/helper.ts": "export function help() {}\n",
        "src/features/x/Page.module.css": ".a { color: red }\n",
        "src/features/x/index.ts": "export const idx = 1;\n",
        "src/features/x/Page.tsx": """
            import { useState } from 'react';
            import { api } from '../../api/client';
            import { help as h } from './helper';
            import './Page.module.css';
            const lazy = () => import('./index');
        """,
    })
    _files, edges = codegraph.build([repo])
    edges = _edge_map(edges)
    src = "src/features/x/Page.tsx"
    assert edges[(src, "src/api/client.ts")] == ["api"]
    # The LOCAL alias is dropped — an edge is labelled with the destination's
    # own name for the thing, not with what this file renamed it to.
    assert edges[(src, "src/features/x/helper.ts")] == ["help"]
    assert (src, "src/features/x/Page.module.css") in edges
    assert (src, "src/features/x/index.ts") in edges      # dynamic import()


def test_ts_multiline_and_type_imports(tmp_path):
    repo = _repo(tmp_path / "app", {
        "src/types.ts": "export type A = 1; export type B = 2;\n",
        "src/use.ts": """
            import type {
              A,
              B as Renamed,
            } from './types';
            export type { A } from './types';
        """,
    })
    _files, edges = codegraph.build([repo])
    assert set(_edge_map(edges)[("src/use.ts", "src/types.ts")]) == {"A", "B"}


def test_ts_ignores_imports_inside_comments(tmp_path):
    repo = _repo(tmp_path / "app", {
        "src/real.ts": "export const r = 1;\n",
        "src/ghost.ts": "export const g = 1;\n",
        "src/c.ts": """
            /* import { g } from './ghost'; */
            // import { g } from './ghost';
            import { r } from './real';
        """,
    })
    _files, edges = codegraph.build([repo])
    paired = _edge_map(edges)
    assert ("src/c.ts", "src/real.ts") in paired
    assert ("src/c.ts", "src/ghost.ts") not in paired


def test_css_is_a_destination_but_never_a_source(tmp_path):
    repo = _repo(tmp_path / "app", {
        "src/a.module.css": "@import './b.css';\n.x { color: red }\n",
        "src/b.css": ".y { color: blue }\n",
    })
    files, edges = codegraph.build([repo])
    assert {f[1] for f in files} == {"src/a.module.css", "src/b.css"}
    assert not [e for e in edges if e[1].endswith(".css")]


# --- the tables ---------------------------------------------------------------

def test_rebuild_writes_degrees_and_is_idempotent(data_dir, tmp_path):
    repo = _repo(tmp_path / "app", {
        "hub.py": "def h():\n    pass\n",
        "one.py": "import hub\n",
        "two.py": "import hub\nimport one\n",
        "lonely.py": "x = 1\n",
    })
    first = codegraph.rebuild([repo])
    assert first["files"] == 4 and first["errors"] == 0
    second = codegraph.rebuild([repo])
    assert second["files"] == first["files"] and second["edges"] == first["edges"]

    graph = codegraph.graph()
    by_path = {f["path"]: f for f in graph["files"]}
    assert by_path["hub.py"]["in_degree"] == 2      # one.py and two.py
    assert by_path["hub.py"]["out_degree"] == 0
    assert by_path["two.py"]["out_degree"] == 2
    # The point of the files table existing at all: an island is still a row.
    assert by_path["lonely.py"]["in_degree"] == 0
    assert by_path["lonely.py"]["out_degree"] == 0


def test_neighbors_answers_both_directions(data_dir, tmp_path):
    repo = _repo(tmp_path / "app", {
        "mid.py": "import leaf\n\ndef go():\n    return leaf.work()\n",
        "leaf.py": "def work():\n    return 1\n",
        "top.py": "import mid\n",
    })
    codegraph.rebuild([repo])
    n = codegraph.neighbors("skeleton", "mid.py")
    assert [(r["dst"], r["symbols"]) for r in n["imports"]] == [("leaf.py", ["work"])]
    assert [r["src"] for r in n["imported_by"]] == ["top.py"]


# --- the endpoints ------------------------------------------------------------

@pytest.fixture
def graph_client(data_dir, tmp_path, monkeypatch):
    """A minimal app with only the terrain routes, pointed at a synthetic repo.
    The TTL cache is reset per test — a warm cache from another test would skip
    the rebuild and serve the wrong repo's graph."""
    root = tmp_path / "app"
    _repo(root, {
        "server.py": "import store\n\ndef go():\n    return store.read()\n",
        "store.py": "def read():\n    return 1\n",
        "orphan.py": "x = 1\n",
    })
    monkeypatch.setattr(observatory, "_terrain_repos",
                        lambda: ({"id": "skeleton", "name": "App", "root": root},))
    monkeypatch.setattr(terrain, "_graph_cache", {"built_at": 0.0})
    app = Flask(__name__)
    app.config.update(TESTING=True)
    terrain.register(app)
    return app.test_client(), root


def test_graph_endpoint_returns_every_file_and_its_edges(graph_client):
    client, _root = graph_client
    data = client.get("/api/observatory/terrain/graph").get_json()
    assert {f["path"] for f in data["files"]} == {"server.py", "store.py", "orphan.py"}
    assert [(e["src"], e["dst"], e["symbols"]) for e in data["edges"]] == \
        [("server.py", "store.py", ["read"])]
    assert data["counts"]["observed"] == 0      # nothing has run


def test_graph_endpoint_overlays_observed_calls(graph_client, monkeypatch):
    """The overlay is where the two stores' path vocabularies meet — the sensor
    keys by absolute path, the graph by repo-relative. A mismatch here would
    show up as a graph that never marks anything observed, which looks exactly
    like an app that never runs."""
    client, root = graph_client
    store.write(runtime_sensor.COLLECTION, {"files": {}, "edges": {
        f"{root}/server.py\t{root}/store.py": {"last": 500, "windows": 7},
        # A call the parser can't see — it must surface, not vanish.
        f"{root}/store.py\t{root}/orphan.py": {"last": 600, "windows": 2},
    }})
    data = client.get("/api/observatory/terrain/graph").get_json()
    edge = next(e for e in data["edges"] if e["src"] == "server.py")
    assert edge["observed"] == {"last": 500, "windows": 7}
    assert [(e["src"], e["dst"]) for e in data["observed_only"]] == \
        [("store.py", "orphan.py")]


def test_graph_external_edges_are_opt_in(graph_client, monkeypatch):
    client, root = graph_client
    (root / "server.py").write_text("import flask\nimport store\n")
    monkeypatch.setattr(terrain, "_graph_cache", {"built_at": 0.0})
    plain = client.get("/api/observatory/terrain/graph").get_json()
    assert all(e["dst_repo"] for e in plain["edges"])
    with_ext = client.get("/api/observatory/terrain/graph?external=1").get_json()
    assert any(e["dst"] == "flask" and not e["dst_repo"] for e in with_ext["edges"])


def test_graph_file_endpoint_requires_both_args(graph_client):
    client, _root = graph_client
    assert client.get("/api/observatory/terrain/graph/file").status_code == 400
    resp = client.get("/api/observatory/terrain/graph/file?repo=skeleton&path=store.py")
    assert resp.status_code == 200
    assert [r["src"] for r in resp.get_json()["imported_by"]] == ["server.py"]
