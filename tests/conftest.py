"""Shared pytest fixtures.

The whole app reads and writes JSON through ``store`` (see store.py). Every test
gets its own throwaway data directory by monkeypatching ``store.DATA_DIR`` to a
pytest ``tmp_path`` — so tests never touch real data and never collide with each
other. Route tests build a *minimal* Flask app that registers only the blueprint
under test, which keeps them fast and free of server.py's startup/auth machinery.
"""
import os
import pathlib
import tempfile

import pytest

# QUARANTINE THE WHOLE PROCESS BEFORE store IS IMPORTED.
#
# store.py resolves every root from an env var AT IMPORT TIME, and the
# `data_dir` fixture only monkeypatches store.DATA_DIR for the duration of a
# test. Anything that writes OUTSIDE that window — a detached worker thread
# outliving its test, an atexit hook, a subprocess — uses the import-time value.
# So the import-time value has to already be a throwaway, or those writes land
# wherever the environment happens to point.
#
# This used to be `setdefault`, which is a no-op when the var is ALREADY SET —
# and it is set for any session the app itself spawns (gunicorn's environment is
# inherited straight through, EXOCORTEX_DATA_DIR = the live vault). Running the
# suite from inside one of those sessions pointed the store at real data, and a
# leaked worker thread wrote a test's empty index over the owner's session
# roster. Overriding — never defaulting — is what makes the suite safe to run
# from anywhere, including from inside the running app.
#
# EVERY path-carrying var is re-pointed, not just the data dir: the content dir,
# the research/triage/spinoff roots, the ideas file. A single one left pointing
# at real storage is a hole of exactly the same shape.
#
# Done ONCE per process, keyed on a sentinel: this module gets executed twice
# under two names (`conftest` and `tests.conftest`), and a second pass would
# both mint a stray root and re-run the check below against a store that a
# fixture has legitimately re-pointed at its own tmp_path.
_TEST_ROOT = os.environ.get("EXOCORTEX_TEST_ROOT") or ""
_FIRST_PASS = not _TEST_ROOT
if _FIRST_PASS:
    _TEST_ROOT = tempfile.mkdtemp(prefix="exo-test-default-")
    os.environ["EXOCORTEX_TEST_ROOT"] = _TEST_ROOT
    for _var in list(os.environ):
        if _var.startswith("EXOCORTEX_") and (_var.endswith("_DIR") or _var.endswith("_FILE")):
            os.environ[_var] = os.path.join(_TEST_ROOT, _var.lower())
        elif _var == "TULKU_STREAM_ROOT":              # tools/stream's own root
            os.environ[_var] = os.path.join(_TEST_ROOT, "stream")
# The data dir sits one level DOWN inside the root, because several of store's
# other roots are derived as `DATA_DIR.parent / "..."` (triage, research, the
# person summaries). With the data dir AT the root those siblings would land in
# the shared /tmp; nested, the whole family stays inside the throwaway tree.
    os.environ["EXOCORTEX_DATA_DIR"] = os.path.join(_TEST_ROOT, "data")
    os.environ["EXOCORTEX_CONTENT_DIR"] = os.path.join(_TEST_ROOT, "content")

# Kill the store's op counters for the whole suite (set BEFORE store is
# imported): tests hammer the store, and nothing may leak into any data dir —
# not even at interpreter exit (store's atexit flush checks this env too).
# tests/test_store_stats.py re-enables it per test via monkeypatch.
os.environ["EXOCORTEX_STORE_STATS_OFF"] = "1"

import store  # noqa: E402

# The quarantine, checked rather than assumed — at import, before a single test
# runs. If store resolves ANY root outside the throwaway tree, the suite refuses
# to start: a collection error is cheap, and discovering it from a clobbered
# vault is not. (Only on the first pass — see the sentinel above.)
if _FIRST_PASS:
    for _name in ("DATA_DIR", "CONTENT_DIR", "UPLOAD_DIR", "RECEIPTS_DIR", "RECIPES_DIR",
                  "ARCHIVALS_DIR", "TRIAGE_DIR", "SPINOFF_DIR", "PERSON_SKILL_DIR",
                  "RESEARCH_DIR", "RESEARCH_FILER_DIR", "RESEARCH_RUNNER_DIR",
                  "RESEARCH_DEEP_DIR", "RESEARCH_WORKER_DIR", "RESEARCH_DISTILLER_DIR"):
        _root = getattr(store, _name, None)
        if _root is not None and not str(_root).startswith(_TEST_ROOT):
            raise RuntimeError(
                f"test isolation broken: store.{_name} = {_root} is outside the test "
                f"root {_TEST_ROOT}. Refusing to run against real storage.")


# QUARANTINE THE REPO ITSELF, not just the data dir.
#
# worktrees.py cuts real git worktrees and real branches off the real checkout.
# A route test that reaches open_spinoff() (fork-the-work does) will therefore
# CREATE THEM — silently, and with the suite still green, because a stray
# worktree breaks nothing a test asserts. That happened: a full-suite run left
# six worktrees and six agent/ branches in the live repo.
#
# Same reasoning as the data-dir quarantine above, and the same shape: point the
# roots at the throwaway tree for the whole process. A test that genuinely wants
# real git behaviour (tests/test_worktrees.py) builds its own repo in tmp_path
# and monkeypatches these itself, which still works — this is only the floor.
import worktrees  # noqa: E402

worktrees.WORKTREE_ROOT = pathlib.Path(_TEST_ROOT) / "worktrees"
worktrees.SKELETON = pathlib.Path(_TEST_ROOT) / "not-a-repo"


@pytest.fixture
def data_dir(tmp_path, monkeypatch):
    """Point the store at a fresh temp dir for this test only."""
    monkeypatch.setattr(store, "DATA_DIR", tmp_path)
    monkeypatch.setattr(store, "UPLOAD_DIR", tmp_path / "uploads")
    return tmp_path


@pytest.fixture
def seed(data_dir):
    """Write a todos.json. Call with no args for empty buckets, or pass a dict."""
    def _seed(data=None):
        store.write("todos", data if data is not None else {
            "now": {"items": []},
            "up_next": {"items": []},
            "later": {"items": []},
            "someday": {"items": []},
            "done": {"items": []},
        })
    return _seed


@pytest.fixture
def client(data_dir):
    """A test client for a minimal app exposing the todo + places routes."""
    from flask import Flask
    from routes import todos, places
    app = Flask(__name__)
    app.config.update(TESTING=True)
    todos.register(app)
    places.register(app)
    return app.test_client()


def read_todos():
    """Read the raw todos.json the routes just wrote (no id back-fill)."""
    return store.read("todos", {})
