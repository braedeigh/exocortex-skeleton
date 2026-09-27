"""scripts/nightly_tests.py — the nightly full run and the fixer it sends.

pytest itself and the spinoff door are faked: these pin what the script
decides from pytest's output (what's broken, what's flaky, whether a session
is opened, what the brief says), not the running of a real suite.
"""
import pytest

import store
from scripts import nightly_tests

FULL_RUN = """\
........F..E
FAILED tests/test_a.py::test_broken - AssertionError: 1 != 2
FAILED tests/test_b.py::test_flaky[x] - TimeoutError
ERROR tests/test_c.py::test_teardown - OSError: gone
FAILED tests/test_c.py::test_teardown - AssertionError
3 failed, 9 passed in 1.00s
"""


@pytest.fixture
def night(data_dir, tmp_path, monkeypatch):
    """Fake pytest + a fake spinoff door; record what the script asked for."""
    monkeypatch.setattr(store, "SPINOFF_DIR", tmp_path / "spinoffs")
    monkeypatch.setattr(nightly_tests, "OUT_ROOT", tmp_path / "out")
    calls = {"runs": [], "opened": []}
    outputs = {"full": FULL_RUN, "rerun": "FAILED tests/test_a.py::test_broken - AssertionError\n"}

    def fake_run(args, log_path, timeout):
        calls["runs"].append(args)
        output = outputs["full"] if "--testmon-noselect" in args else outputs["rerun"]
        log_path.write_text(output)
        return (1 if "FAILED" in output or "ERROR" in output else 0), output

    monkeypatch.setattr(nightly_tests, "run_pytest", fake_run)
    monkeypatch.setattr(nightly_tests, "open_fixer",
                        lambda slug: calls["opened"].append(slug) or {"ok": True})
    return calls, outputs


def test_summary_lines_become_failures_listed_once():
    failures = nightly_tests.parse_failures(FULL_RUN)
    assert list(failures) == ["tests/test_a.py::test_broken", "tests/test_b.py::test_flaky[x]",
                              "tests/test_c.py::test_teardown"]


def test_a_failure_that_passes_alone_is_flaky_not_broken(night):
    nightly_tests.main([])
    brief = next((store.SPINOFF_DIR).glob("nightly-tests-*/BRIEF.md")).read_text()
    still, flaky = brief.split("## Failed in the full run")
    assert "test_broken" in still and "test_flaky" not in still
    assert "test_flaky" in flaky


def test_real_failures_open_one_coding_session(night):
    calls, _ = night
    nightly_tests.main([])
    assert len(calls["opened"]) == 1 and calls["opened"][0].startswith("nightly-tests-")


def test_a_green_night_opens_nothing(night):
    calls, outputs = night
    outputs["full"] = "....\n4 passed in 1.00s\n"
    nightly_tests.main([])
    assert calls["opened"] == [] and len(calls["runs"]) == 1


def test_only_flaky_failures_open_nothing(night):
    calls, outputs = night
    outputs["rerun"] = "3 passed in 0.5s\n"
    nightly_tests.main([])
    assert calls["opened"] == []


def test_a_suite_that_crashes_without_a_summary_still_sends_the_fixer(night):
    calls, outputs = night
    outputs["full"] = "ImportError while loading conftest\n"
    real_run = nightly_tests.run_pytest

    def crashing(args, log_path, timeout):
        code, output = real_run(args, log_path, timeout)
        return (4 if "--testmon-noselect" in args else code), output

    nightly_tests.run_pytest = crashing
    try:
        nightly_tests.main([])
    finally:
        nightly_tests.run_pytest = real_run
    assert len(calls["opened"]) == 1


def test_paused_on_the_automations_page_runs_nothing(night):
    calls, _ = night
    store.write("scheduled_runs.json", {"runs": [{"id": "nightly_tests", "enabled": False}]})
    nightly_tests.main([])
    assert calls["runs"] == [] and calls["opened"] == []
