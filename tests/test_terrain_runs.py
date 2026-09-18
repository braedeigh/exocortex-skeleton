"""Tests GET /api/observatory/terrain/file/runs — per-line last-ran times.

The endpoint says when each line of a Python file last RAN, one function at a
time, for the file pane's gold "ran" toggle (routes/terrain.py
`_terrain_line_runs`). The sensor's second sidecar (runtime_sensor.py
FUNCTIONS_COLLECTION) is seeded by hand here, so the tests control exactly
which functions "ran" and when. The contract:
  - a line inside a function that ran carries that function's stamp; every
    other line is 0
  - a line belongs to the INNERMOST function around it — an outer function
    that ran does not light an inner one that didn't
  - a method is found under its class's name
  - a file that isn't Python, or that the sensor has seen nothing in, answers
    `runs: null` — nothing to say, no guess
  - the same door as /terrain/file: a visitor's vault read is a 403 `private`
"""
import textwrap
from pathlib import Path

import pytest

import runtime_sensor
import store

RAN_AT = 1_700_000_100

SOURCE = textwrap.dedent('''\
    import os

    def outer():
        first = 1
        def inner():
            return 2
        return first

    class Thing:
        def method(self):
            return 3

    def cold():
        return 4
    ''')


@pytest.fixture
def vault(tmp_path, monkeypatch):
    """A temp vault holding one Python file and one markdown file."""
    from routes import observatory
    root = tmp_path / "vault"
    root.mkdir()
    (root / "tool.py").write_text(SOURCE)
    (root / "notes.md").write_text("one\ntwo\n")
    monkeypatch.setattr(observatory, "_terrain_repos", lambda: (
        {"id": "skeleton", "name": "App code", "root": Path(store.BUILD_DIR)},
        {"id": "vault", "name": "Personal vault", "root": root},
    ))
    return root


def _client(monkeypatch, authed):
    """A test client on the real server app, logged in or not.

    The real app rather than a minimal one, because the visitor lock reads
    what the server's auth gate decides about the request."""
    monkeypatch.delenv("EXOCORTEX_PUBLIC_ONLY", raising=False)
    import server
    c = server.app.test_client()
    if authed:
        with c.session_transaction() as sess:
            sess["authed"] = True
    return c


@pytest.fixture
def owner(data_dir, vault, monkeypatch):
    return _client(monkeypatch, authed=True)


def _seed_ran(vault, functions):
    store.write(runtime_sensor.FUNCTIONS_COLLECTION, {"files": {
        str((vault / "tool.py").resolve()): functions}})


def _runs(client, path):
    return client.get(f"/api/observatory/terrain/file/runs?repo=vault&path={path}")


def test_lines_of_a_function_that_ran_carry_its_stamp(owner, vault):
    _seed_ran(vault, {"outer": RAN_AT})
    runs = _runs(owner, "tool.py").get_json()["runs"]
    # line 1 `import os` is in no function; 3, 4 and 7 are outer's own lines.
    assert runs[0] == 0
    assert runs[2] == runs[3] == runs[6] == RAN_AT
    # `cold` never ran.
    assert runs[12] == runs[13] == 0


def test_an_inner_function_is_lit_only_by_its_own_runs(owner, vault):
    _seed_ran(vault, {"outer": RAN_AT})
    runs = _runs(owner, "tool.py").get_json()["runs"]
    assert runs[4] == runs[5] == 0        # `inner` sits inside `outer`, dark

    _seed_ran(vault, {"outer": RAN_AT, "outer.<locals>.inner": RAN_AT + 300})
    runs = _runs(owner, "tool.py").get_json()["runs"]
    assert runs[4] == runs[5] == RAN_AT + 300
    assert runs[6] == RAN_AT               # outer's tail keeps outer's stamp


def test_a_method_is_found_under_its_class(owner, vault):
    _seed_ran(vault, {"Thing.method": RAN_AT})
    runs = _runs(owner, "tool.py").get_json()["runs"]
    assert runs[8] == 0                    # the `class` line itself
    assert runs[9] == runs[10] == RAN_AT


def test_a_file_the_sensor_never_saw_answers_null(owner, vault):
    assert _runs(owner, "tool.py").get_json()["runs"] is None


def test_a_file_that_is_not_python_answers_null(owner, vault):
    _seed_ran(vault, {"outer": RAN_AT})
    assert _runs(owner, "notes.md").get_json()["runs"] is None


def test_a_visitor_cannot_read_a_vault_files_runs(data_dir, vault, monkeypatch):
    _seed_ran(vault, {"outer": RAN_AT})
    visitor = _client(monkeypatch, authed=False)
    response = _runs(visitor, "tool.py")
    assert response.status_code in (401, 403)
