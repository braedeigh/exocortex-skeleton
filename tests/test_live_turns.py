"""The deploy guard's one question: is anyone mid-turn right now?

This gates deploys, so it has two ways to be wrong and they are not
symmetrical. Saying "live" about a corpse wedges every deploy behind a flag
nobody will ever clear — and this index really does carry `running` flags left
over from July. Saying "clear" about a live turn silently destroys someone's
work, which is the failure the guard exists to prevent.

So: the flag alone never counts, and a fresh heartbeat is what makes it real.
"""
import subprocess
import time
from datetime import datetime, timedelta

import pytest

import store
from scripts import live_turns as lt
from scripts import run_detached


def idx(**entries):
    return entries


def fresh(seconds_ago=5):
    return (datetime.now() - timedelta(seconds=seconds_ago)).isoformat()


def test_a_turn_with_a_fresh_heartbeat_is_live():
    got = lt.live_turns(idx(c1={"running": True, "last_at": fresh(5)}))
    assert [t["id"] for t in got] == ["c1"]


def test_a_running_flag_with_a_stale_heartbeat_is_a_corpse():
    """The July flags. A turn re-stamps last_at every 30s while it works, so
    anything past the staleness window was killed without clearing up."""
    old = (datetime.now() - timedelta(days=18)).isoformat()
    assert lt.live_turns(idx(c1={"running": True, "last_at": old})) == []


def test_a_finished_turn_is_not_live():
    assert lt.live_turns(idx(c1={"running": False, "last_at": fresh(1)})) == []


def test_right_at_the_staleness_edge():
    just_inside = lt.live_turns(idx(c1={"running": True,
                                        "last_at": fresh(lt.STALE_SEC - 30)}))
    just_outside = lt.live_turns(idx(c1={"running": True,
                                         "last_at": fresh(lt.STALE_SEC + 30)}))
    assert [t["id"] for t in just_inside] == ["c1"]
    assert just_outside == []


def test_a_running_flag_with_no_heartbeat_does_not_wedge_deploys():
    """Unknowable, so treated as dead. Erring the other way would let one
    malformed entry block every deploy forever, and orphaned flags are by far
    the likelier state of this index."""
    assert lt.live_turns(idx(c1={"running": True})) == []
    assert lt.live_turns(idx(c1={"running": True, "last_at": "not a date"})) == []


def test_junk_entries_are_skipped_not_fatal():
    got = lt.live_turns(idx(c1="not a dict", c2=None,
                            c3={"running": True, "last_at": fresh(2)}))
    assert [t["id"] for t in got] == ["c3"]


def test_a_junk_index_is_not_fatal():
    assert lt.live_turns([]) == []
    assert lt.live_turns("nope") == []


def test_live_turns_come_back_newest_heartbeat_first():
    got = lt.live_turns(idx(old={"running": True, "last_at": fresh(300)},
                            new={"running": True, "last_at": fresh(2)}))
    assert [t["id"] for t in got] == ["new", "old"]


@pytest.fixture
def jobs_dir(tmp_path, monkeypatch):
    """An empty jobs folder, so the real machine's detached jobs never count."""
    monkeypatch.setattr(run_detached, "JOBS_DIR", tmp_path / "jobs")
    return tmp_path / "jobs"


def _index(entries):
    (store.DATA_DIR / "bot_chats").mkdir(parents=True, exist_ok=True)
    store.write("bot_chats/index", entries)


def test_exit_code_is_what_the_deploy_script_reads(data_dir, jobs_dir, capsys):
    """Non-zero means work is live. The shell guard is built on this alone."""
    _index({"c1": {"running": True, "last_at": fresh(3)}})
    assert lt.main([]) == 1
    assert "c1" in capsys.readouterr().out

    _index({"c1": {"running": False}})
    assert lt.main([]) == 0
    assert "no turns or detached jobs running" in capsys.readouterr().out


def test_a_missing_index_refuses_instead_of_saying_all_clear(data_dir, jobs_dir, capsys):
    """The 9/28 reboot: run from a terminal with no EXOCORTEX_DATA_DIR, this
    read an empty folder, said "no turns running", and two turns died."""
    assert lt.main([]) == 2
    assert "can't find the turn index" in capsys.readouterr().out


def _running_job(jobs_dir):
    job_dir = jobs_dir / "j1"
    job_dir.mkdir(parents=True)
    run_detached._write_meta(job_dir, {
        "id": "j1", "conv_id": "c9", "argv": ["sleep", "9"], "label": "suite",
        "log": str(job_dir / "output.log"), "queued_epoch": time.time()})


def test_a_running_detached_job_blocks_a_restart_but_not_a_reload(data_dir, jobs_dir, capsys):
    """A restart or reboot kills detached jobs; a reload leaves them alone."""
    _index({})
    _running_job(jobs_dir)
    assert lt.main([]) == 1
    assert "suite" in capsys.readouterr().out
    assert lt.main(["--turns-only"]) == 0


def _systemctl_says(stdout):
    def runner(argv, **kwargs):
        return subprocess.CompletedProcess(argv, 0, stdout=stdout, stderr="")
    return runner


def test_without_the_env_var_the_data_dir_comes_from_the_service(tmp_path, monkeypatch):
    monkeypatch.delenv("EXOCORTEX_DATA_DIR", raising=False)
    monkeypatch.setattr(store, "DATA_DIR", store.BUILD_DIR / "data")
    live = tmp_path / "live data"
    (live / "bot_chats").mkdir(parents=True)
    (live / "bot_chats" / "index.json").write_text("{}")
    runner = _systemctl_says(f'TZ=x "EXOCORTEX_DATA_DIR={live}" EXOCORTEX_APP_NAME=E\n')
    assert lt.locate_data(runner) is True
    assert store.DATA_DIR == live


def test_an_explicit_data_dir_is_never_second_guessed(data_dir):
    def runner(argv, **kwargs):
        raise AssertionError("systemctl should not be asked")
    _index({})
    assert lt.locate_data(runner) is True


def test_no_systemd_means_no_data_dir():
    def runner(argv, **kwargs):
        raise FileNotFoundError("systemctl")
    assert lt.service_data_dir(runner) is None
    assert lt.service_data_dir(_systemctl_says("TZ=x\n")) is None
