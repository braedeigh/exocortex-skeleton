"""The runtime-utilization sensor (runtime_sensor.py) and the endpoint that
reads it back.

What's worth pinning here is the contract, not the plumbing: that real
execution of a real file is what lands in the sidecar (so the test drives
sys.monitoring for real rather than faking the hit set), that everything which
is not ours is filtered out, that an idle window writes nothing, and that the
ring buffer bounds the file. The route test covers the abs-path → repo-relative
mapping, which is the one place this can silently disagree with the rest of
Terrain.
"""
import pathlib
import sys
import textwrap

import pytest
from flask import Flask

import runtime_sensor
import store
from routes import observatory, terrain


@pytest.fixture
def sensor(data_dir, monkeypatch):
    """The sensor, started foreground (no background thread — the cycle is
    driven by hand) and always torn down, so a leaked tool id or a live
    PY_START callback can't follow one test into the next.

    The suite runs with the sensor switched OFF at the env (see conftest), so
    these tests turn it back on for themselves. They also stop anything already
    running first: `start()` is idempotent, so a sensor left on by another test
    would hand this one a True that means "already watching somewhere else"."""
    monkeypatch.setenv("EXOCORTEX_RUNTIME_SENSOR", "1")
    if runtime_sensor.running():
        runtime_sensor.stop()
    try:
        yield runtime_sensor
    finally:
        if runtime_sensor.running():
            runtime_sensor.stop()
        runtime_sensor._harvest()   # drop anything the teardown itself saw


def _module_under(root, name, body):
    """Write a python module into `root` and import it, so calling into it
    produces genuine PY_START events with a co_filename under that root.

    Forgets any module an earlier test imported under the same name first:
    Python would otherwise hand that one back, from the earlier test's root,
    and the sensor would rightly ignore it. Same guard as `_mod` in
    tests/test_runtime_trace.py, where this bit for real."""
    import importlib
    root.mkdir(parents=True, exist_ok=True)
    path = root / f"{name}.py"
    path.write_text(textwrap.dedent(body))
    sys.modules.pop(name, None)
    importlib.invalidate_caches()
    sys.path.insert(0, str(root))
    try:
        mod = __import__(name)
    finally:
        sys.path.remove(str(root))
    assert mod.__file__ == str(path), f"{name} was imported from {mod.__file__}, not {path}"
    return mod, path


# --- what counts as ours -----------------------------------------------------

def test_under_roots_accepts_only_our_trees(tmp_path):
    root = str(tmp_path / "app")
    roots = (root,)
    assert runtime_sensor._under_roots(f"{root}/server.py", roots)
    assert runtime_sensor._under_roots(f"{root}/routes/observatory.py", roots)
    assert not runtime_sensor._under_roots("/usr/lib/python3.12/json/decoder.py", roots)
    # The root itself is not a file under the root, and a sibling that merely
    # shares the prefix is not inside it.
    assert not runtime_sensor._under_roots(root, roots)
    assert not runtime_sensor._under_roots(f"{root}-other/x.py", roots)


def test_under_roots_excludes_dependencies_and_pseudo_files(tmp_path):
    root = str(tmp_path / "app")
    roots = (root,)
    # Inside our tree, but not our code — the venv is the big one: every
    # third-party function would otherwise land in the sidecar.
    assert not runtime_sensor._under_roots(f"{root}/venv/lib/site-packages/flask/app.py", roots)
    assert not runtime_sensor._under_roots(f"{root}/node_modules/x/y.py", roots)
    assert not runtime_sensor._under_roots(f"{root}/__pycache__/server.pyc", roots)
    # The interpreter's own non-file code objects.
    assert not runtime_sensor._under_roots("<frozen importlib._bootstrap>", roots)
    assert not runtime_sensor._under_roots("<string>", roots)
    assert not runtime_sensor._under_roots("", roots)


# --- the sensor actually sensing ---------------------------------------------

def test_records_a_file_only_once_it_runs(sensor, tmp_path):
    """The whole point: defining code is not using it. The module is imported
    (and so its functions exist) BEFORE the sensor starts, and it stays dark
    until something calls into it."""
    root = tmp_path / "app"
    mod, path = _module_under(root, "sensed_a", """
        def work():
            return 1
    """)

    assert sensor.start(roots=[root], background=False) is True
    sensor.cycle()
    assert str(path) not in sensor.snapshot()["files"]

    mod.work()
    sensor.cycle()
    entry = sensor.snapshot()["files"][str(path)]
    assert entry["windows"] == 1
    assert entry["touches"] == [entry["last"]]


def test_idle_window_writes_nothing(sensor, tmp_path):
    """An app serving nothing must not write a file a minute to say so — the
    sidecar is only ever touched by a window that saw one of our files run."""
    root = tmp_path / "app"
    root.mkdir()
    assert sensor.start(roots=[root], background=False) is True
    sensor.cycle()
    assert not store.file_path(runtime_sensor.COLLECTION).exists()


def test_everything_is_counted_per_bucket_not_per_cycle(sensor, tmp_path, monkeypatch):
    """A file used on every request gets ONE entry per BUCKET_SEC — one
    timestamp and one increment, however many cycles fall inside it. That's
    what keeps a real history in a bounded file, and it's what leaves the
    collection unchanged so store's guard can skip the write."""
    root = tmp_path / "app"
    mod, path = _module_under(root, "sensed_b", """
        def work():
            return 2
    """)
    assert sensor.start(roots=[root], background=False) is True

    clock = {"t": 1_000_000.0}
    monkeypatch.setattr(runtime_sensor, "_now", lambda: clock["t"])
    for _ in range(3):
        mod.work()
        sensor.cycle()
        clock["t"] += runtime_sensor.CYCLE_SEC      # same 5-minute bucket

    entry = sensor.snapshot()["files"][str(path)]
    assert entry["windows"] == 1
    assert entry["touches"] == [entry["last"]]
    first_last = entry["last"]

    clock["t"] += runtime_sensor.BUCKET_SEC          # …now a new one
    mod.work()
    sensor.cycle()
    entry = sensor.snapshot()["files"][str(path)]
    assert entry["windows"] == 2
    assert len(entry["touches"]) == 2
    assert entry["last"] == entry["touches"][-1] > first_last


def test_a_second_cycle_in_one_bucket_writes_nothing(sensor, tmp_path, monkeypatch):
    """The throttle, pinned: re-seeing the same file inside a bucket must leave
    the collection byte-identical, because that no-op is the ONLY thing keeping
    a busy worker from paying for a real write every cycle."""
    root = tmp_path / "app"
    mod, path = _module_under(root, "sensed_d", """
        def work():
            return 4
    """)
    assert sensor.start(roots=[root], background=False) is True
    clock = {"t": 3_000_000.0}
    monkeypatch.setattr(runtime_sensor, "_now", lambda: clock["t"])

    mod.work()
    sensor.cycle()
    sidecar = store.file_path(runtime_sensor.COLLECTION)
    before = sidecar.read_bytes()

    clock["t"] += runtime_sensor.CYCLE_SEC
    mod.work()
    sensor.cycle()
    assert sidecar.read_bytes() == before


def test_touches_are_capped(sensor, tmp_path, monkeypatch):
    """The ring buffer is a bound on the file, so it has to actually drop the
    oldest rather than growing forever."""
    root = tmp_path / "app"
    mod, path = _module_under(root, "sensed_c", """
        def work():
            return 3
    """)
    assert sensor.start(roots=[root], background=False) is True
    monkeypatch.setattr(runtime_sensor, "TOUCH_CAP", 3)

    clock = {"t": 2_000_000.0}
    monkeypatch.setattr(runtime_sensor, "_now", lambda: clock["t"])
    for _ in range(5):
        mod.work()
        sensor.cycle()
        clock["t"] += runtime_sensor.BUCKET_SEC

    entry = sensor.snapshot()["files"][str(path)]
    # The ring forgot, the total didn't — that's what makes `windows` usable
    # as "how often is this reached" past the cap.
    assert entry["windows"] == 5
    assert len(entry["touches"]) == 3
    assert entry["touches"] == sorted(entry["touches"])   # oldest fell off the front


def test_start_is_idempotent_and_stop_releases_the_tool(sensor, tmp_path):
    root = tmp_path / "app"
    root.mkdir()
    assert sensor.start(roots=[root], background=False) is True
    assert sensor.start(roots=[root], background=False) is True   # already on
    assert sensor.running() is True
    sensor.stop()
    assert sensor.running() is False
    # The id went back, so it can be claimed again — a stop that leaked it
    # would make every later start() in this process silently fail.
    assert sensor.start(roots=[root], background=False) is True


def test_disabled_by_env(sensor, tmp_path, monkeypatch):
    monkeypatch.setenv("EXOCORTEX_RUNTIME_SENSOR", "0")
    assert sensor.enabled() is False
    assert sensor.start(roots=[tmp_path], background=False) is False
    assert sensor.running() is False


# --- coverage of the batch half ----------------------------------------------

# Scripts that run as a process and are left off the runtime map on purpose.
# Each one needs its reason here, because the guard below is the only thing
# that notices an untraced script.
#   standalone.py, standalone_seed.py — the desktop app's server and the maker
#     of its seed. The desktop app switches the sensor off for its whole
#     process (`prepare_environment` sets EXOCORTEX_RUNTIME_SENSOR=0; see
#     docs/standalone.md), and neither may import `store` before that function
#     has pointed the folders inside the data folder — which importing the
#     sensor in the __main__ block would do.
DELIBERATELY_UNTRACED = {"standalone.py", "standalone_seed.py"}


def test_every_standalone_script_is_on_the_runtime_map():
    """The goal is that every file be traceable as it runs, and the batch half
    of the system — the cron scripts, the dispatchers, the rollups — is where
    that quietly fails. A script with no `attach()` does real work on real
    files and leaves no trace, so it reads as dead code on the map.

    This is a coverage guard rather than a behaviour test, and it exists
    because the failure is INVISIBLE: nothing breaks, the map just silently
    understates itself. A new script added without the two lines fails here
    instead."""
    scripts = pathlib.Path(store.BUILD_DIR) / "scripts"
    missing = []
    for path in sorted(scripts.glob("*.py")):
        text = path.read_text(encoding="utf-8", errors="replace")
        if 'if __name__ == "__main__":' not in text:
            continue          # a library module, not a process
        if "runtime_sensor" not in text and path.name not in DELIBERATELY_UNTRACED:
            missing.append(path.name)
    assert missing == [], (
        "these standalone scripts run untraced — add `import runtime_sensor;"
        f" runtime_sensor.attach()` inside their __main__ block: {missing}")
    # An exemption for a script that is gone, or that has since been traced,
    # is a stale excuse — take it off the list.
    stale = sorted(name for name in DELIBERATELY_UNTRACED
                   if not (scripts / name).is_file()
                   or "runtime_sensor" in (scripts / name).read_text(encoding="utf-8"))
    assert stale == [], f"no longer needs its exemption: {stale}"


def test_attach_registers_the_exit_flush(sensor, tmp_path, monkeypatch):
    """A cron script is far shorter than one cycle, so the atexit flush is the
    ONLY thing that ever writes its trace down. If attach() stopped registering
    it, every swept script would go silent again and nothing would fail."""
    registered = []
    monkeypatch.setattr(runtime_sensor.atexit, "register", registered.append)
    assert sensor.attach() is True
    assert runtime_sensor.stop in registered


def test_attach_registers_nothing_when_the_sensor_is_off(sensor, monkeypatch):
    registered = []
    monkeypatch.setenv("EXOCORTEX_RUNTIME_SENSOR", "0")
    monkeypatch.setattr(runtime_sensor.atexit, "register", registered.append)
    assert sensor.attach() is False
    assert registered == []


# --- the endpoint ------------------------------------------------------------

@pytest.fixture
def terrain_client(data_dir):
    app = Flask(__name__)
    app.config.update(TESTING=True)
    terrain.register(app)
    return app.test_client()


def test_runtime_endpoint_maps_absolute_paths_into_repos(terrain_client, tmp_path, monkeypatch):
    """The sidecar holds absolute paths (footprints.json's convention); the
    endpoint has to hand back the same repo-relative shape as the rest of
    Terrain, and drop anything that isn't under a repo at all."""
    skeleton, vault = tmp_path / "skeleton", tmp_path / "vault"
    monkeypatch.setattr(observatory, "_terrain_repos", lambda: (
        {"id": "skeleton", "name": "App code", "root": skeleton},
        {"id": "vault", "name": "Personal vault", "root": vault},
    ))
    store.write(runtime_sensor.COLLECTION, {"files": {
        str(skeleton / "server.py"): {"last": 100, "windows": 4, "touches": [100]},
        str(skeleton / "routes/observatory.py"): {"last": 200, "windows": 9, "touches": [200]},
        str(vault / "scripts/x.py"): {"last": 50, "windows": 1, "touches": [50]},
        "/usr/lib/python3.12/json/decoder.py": {"last": 300, "windows": 1, "touches": [300]},
    }})

    data = terrain_client.get("/api/observatory/terrain/runtime").get_json()
    by_repo = {r["id"]: r for r in data["repos"]}
    # Most-recently-run first, and the stdlib path belongs to no repo.
    assert [f["path"] for f in by_repo["skeleton"]["files"]] == \
        ["routes/observatory.py", "server.py"]
    assert [f["path"] for f in by_repo["vault"]["files"]] == ["scripts/x.py"]
    assert by_repo["skeleton"]["files"][0]["windows"] == 9
    assert data["language"] == "python"
    assert data["sampled"] == runtime_sensor.CYCLE_SEC


def test_runtime_endpoint_survives_a_missing_sidecar(terrain_client, tmp_path, monkeypatch):
    monkeypatch.setattr(observatory, "_terrain_repos", lambda: (
        {"id": "skeleton", "name": "App code", "root": tmp_path / "skeleton"},
    ))
    resp = terrain_client.get("/api/observatory/terrain/runtime")
    assert resp.status_code == 200
    assert resp.get_json()["repos"][0]["files"] == []


def test_runtime_endpoint_applies_the_denylist(terrain_client, tmp_path, monkeypatch):
    """Same machine-churn rule the map uses: a sensor hit on a file Terrain
    declines to draw must not come back through this door either."""
    skeleton = tmp_path / "skeleton"
    monkeypatch.setattr(observatory, "_terrain_repos", lambda: (
        {"id": "skeleton", "name": "App code", "root": skeleton},
    ))
    store.write(runtime_sensor.COLLECTION, {"files": {
        str(skeleton / "venv/lib/thing.py"): {"last": 100, "windows": 1, "touches": [100]},
        str(skeleton / "store.py"): {"last": 100, "windows": 1, "touches": [100]},
    }})
    files = terrain_client.get("/api/observatory/terrain/runtime").get_json()["repos"][0]["files"]
    assert [f["path"] for f in files] == ["store.py"]


# --- which FUNCTION ran (the second sidecar) ----------------------------------

def test_records_the_function_that_ran_and_not_its_neighbour(sensor, tmp_path):
    """The gutter's gold is per function: calling one `def` in a file must not
    credit the one beside it."""
    root = tmp_path / "app"
    mod, path = _module_under(root, "sensed_functions_a", """
        def used():
            return 1

        def unused():
            return 2
    """)
    assert sensor.start(roots=[root], background=False) is True
    mod.used()
    sensor.cycle()
    ran = sensor.functions_ran(path)
    assert "used" in ran
    assert "unused" not in ran


def test_importing_a_file_credits_no_function(sensor, tmp_path):
    """A module's top level "runs" at import under the name <module>. That is
    loading, not use — crediting it would paint the whole file gold."""
    root = tmp_path / "app"
    assert sensor.start(roots=[root], background=False) is True
    _, path = _module_under(root, "sensed_functions_b", """
        VALUE = [n for n in range(3)]
        def never_called():
            return VALUE
    """)
    sensor.cycle()
    assert sensor.functions_ran(path) == {}


def test_a_function_not_seen_for_five_weeks_is_forgotten(sensor, tmp_path, monkeypatch):
    """A renamed function never runs again under its old name; without the
    prune its entry would sit in the sidecar forever."""
    root = tmp_path / "app"
    mod, path = _module_under(root, "sensed_functions_c", """
        def old_name():
            return 1

        def still_here():
            return 2
    """)
    clock = {"t": 1_700_000_000.0}
    monkeypatch.setattr(runtime_sensor, "_now", lambda: clock["t"])
    assert sensor.start(roots=[root], background=False) is True
    mod.old_name()
    sensor.cycle()
    assert "old_name" in sensor.functions_ran(path)

    clock["t"] += runtime_sensor.FUNCTION_KEEP_SEC + runtime_sensor.BUCKET_SEC
    mod.still_here()
    sensor.cycle()
    assert set(sensor.functions_ran(path)) == {"still_here"}
