"""scripts/research_dispatcher.py — the memory-aware admission loop for
annotation-batch worker sessions (routes/research.py's /api/research/
annotation-batch only QUEUES them; this is the half that actually spawns a
`claude` process, one at a time, only when there's headroom).

tmux itself is never invoked — `tmux_fn` is injected as a fake, the same
pattern test_prompt_dispatcher.py uses for `tmux`. `spawner`, `meminfo`, and
`clock` are injected too, so these tests never shell out or depend on the
real clock or the real /proc/meminfo.
"""
import fcntl
import sys

import pytest

import store
from scripts import research_dispatcher as dispatcher


# --- fakes -------------------------------------------------------------------

class _FakeTmuxResult:
    def __init__(self, returncode, stdout=""):
        self.returncode = returncode
        self.stdout = stdout


def _fake_tmux(live_sessions):
    """A tmux_fn stand-in: answers 'list-sessions' with the given names."""
    def _tmux(cmd_str):
        if cmd_str.startswith("list-sessions"):
            if not live_sessions:
                return _FakeTmuxResult(1, "")  # tmux errors when nothing's running
            return _FakeTmuxResult(0, "\n".join(live_sessions) + "\n")
        return _FakeTmuxResult(0, "")
    return _tmux


def _session(id, status="queued", created="2026-07-07 09:00", worker=True,
             mode="regular", **extra):
    s = {
        "id": id, "entry_ids": [f"q-{id}"], "topics": [], "created": created,
        "status": status, "report": "", "mode": mode,
    }
    if worker:
        s["worker"] = True
    s.update(extra)
    return s


def _write(sessions, entries=None):
    store.write("research.json", {"topics": [], "entries": entries or [], "sessions": sessions})


def _sessions():
    return store.read("research.json")["sessions"]


# --- worker_tmux_name ---------------------------------------------------------

def test_worker_tmux_name_sanitizes_separators():
    """'.' and ':' (tmux target separators) get collapsed to '-', matching
    the exact sanitizing the old routes/research.py _spawn_worker used."""
    assert dispatcher.worker_tmux_name("2026-07-07.0900") == "rw-2026-07-07-0900"


# --- slot math (a) -------------------------------------------------------------

def test_admits_one_when_memory_plentiful(data_dir):
    _write([_session("s1")])
    spawned = []
    dispatcher.run_once(
        meminfo=lambda: 3000, tmux_fn=_fake_tmux([]),
        spawner=lambda sid, mode, qid: spawned.append((sid, mode, qid)),
    )
    assert spawned == [("s1", "regular", "q-s1")]
    assert _sessions()[0]["status"] == "running"


def test_admits_none_when_memory_low(data_dir):
    """Below the 1GB floor + 450MB-per-worker budget: no slots, no admission."""
    _write([_session("s1")])
    spawned = []
    dispatcher.run_once(meminfo=lambda: 1400, tmux_fn=_fake_tmux([]),
                        spawner=lambda *a: spawned.append(a))
    assert spawned == []
    assert _sessions()[0]["status"] == "queued"


def test_admits_none_with_three_live_workers_even_with_memory(data_dir):
    _write([_session("s1")])
    spawned = []
    dispatcher.run_once(meminfo=lambda: 4000, tmux_fn=_fake_tmux(["rw-a", "rw-b", "rw-c"]),
                        spawner=lambda *a: spawned.append(a))
    assert spawned == []
    assert _sessions()[0]["status"] == "queued"


# --- at most one admission per invocation (b) ---------------------------------

def test_admits_exactly_one_even_with_five_queued(data_dir):
    _write([_session(f"s{i}", created=f"2026-07-07 09:0{i}") for i in range(5)])
    spawned = []
    dispatcher.run_once(meminfo=lambda: 4000, tmux_fn=_fake_tmux([]),
                        spawner=lambda sid, mode, qid: spawned.append(sid))
    assert len(spawned) == 1
    statuses = [s["status"] for s in _sessions()]
    assert statuses.count("running") == 1
    assert statuses.count("queued") == 4


# --- oldest-first admission (c) ------------------------------------------------

def test_admits_oldest_first(data_dir):
    _write([
        _session("late", created="2026-07-07 10:00"),
        _session("early", created="2026-07-07 08:00"),
        _session("mid", created="2026-07-07 09:00"),
    ])
    spawned = []
    dispatcher.run_once(meminfo=lambda: 4000, tmux_fn=_fake_tmux([]),
                        spawner=lambda sid, mode, qid: spawned.append(sid))
    assert spawned == ["early"]


# --- recovery (d) --------------------------------------------------------------

def test_recovery_dead_worker_no_reply_goes_back_to_queued(data_dir):
    _write([_session("s1", status="running")])
    # Deliberately no memory, so recovery's result isn't masked by a same-run
    # re-admission back to "running".
    dispatcher.run_once(meminfo=lambda: 0, tmux_fn=_fake_tmux([]), spawner=lambda *a: None)
    s = _sessions()[0]
    assert s["status"] == "queued"
    assert s["attempts"] == 1


def test_recovery_second_dead_attempt_gives_up(data_dir):
    _write([_session("s1", status="running", attempts=1)])
    dispatcher.run_once(meminfo=lambda: 0, tmux_fn=_fake_tmux([]), spawner=lambda *a: None)
    s = _sessions()[0]
    assert s["status"] == "failed"
    assert s["attempts"] == 2
    assert "gave up" in s["report"]


def test_recovery_leaves_session_with_reply_alone(data_dir):
    entries = [{
        "id": "e1", "kind": "note", "text": "reply", "topics": [], "url": "",
        "verdict": "", "status": "", "reply_to": None, "created": "2026-07-07 09:00",
        "author": "llm", "reviewed": False, "session": "s1",
    }]
    _write([_session("s1", status="running")], entries=entries)
    dispatcher.run_once(meminfo=lambda: 0, tmux_fn=_fake_tmux([]), spawner=lambda *a: None)
    s = _sessions()[0]
    assert s["status"] == "running"
    assert "attempts" not in s


def test_recovery_ignores_non_worker_sessions(data_dir):
    """A running session with no `worker` flag (e.g. research-deep) is
    never touched by recovery, even if its tmux name looks dead."""
    _write([_session("deep1", status="running", worker=False, mode="deep")])
    dispatcher.run_once(meminfo=lambda: 0, tmux_fn=_fake_tmux([]), spawner=lambda *a: None)
    s = _sessions()[0]
    assert s["status"] == "running"
    assert "attempts" not in s


def test_recovered_session_can_be_admitted_same_run_if_slots_allow(data_dir):
    """A session recovered back to 'queued' is eligible for the same run's
    admission pass, not stuck waiting for the next invocation."""
    _write([_session("s1", status="running")])
    spawned = []
    dispatcher.run_once(meminfo=lambda: 4000, tmux_fn=_fake_tmux([]),
                        spawner=lambda sid, mode, qid: spawned.append(sid))
    assert spawned == ["s1"]
    assert _sessions()[0]["status"] == "running"


# --- --ending exclusion (e) -----------------------------------------------------

def test_list_live_workers_excludes_ending(data_dir):
    names = dispatcher.list_live_workers(_fake_tmux(["rw-a", "rw-b"]), ending="rw-a")
    assert names == {"rw-b"}


def test_ending_session_excluded_from_slot_count(data_dir):
    """Without excluding the caller's own about-to-close session, 3 live
    names would use up the whole cap and block admission."""
    _write([_session("new1")])
    spawned = []
    dispatcher.run_once(
        ending="rw-old",
        meminfo=lambda: 4000, tmux_fn=_fake_tmux(["rw-a", "rw-b", "rw-old"]),
        spawner=lambda sid, mode, qid: spawned.append(sid),
    )
    assert spawned == ["new1"]


# --- locking ---------------------------------------------------------------

def test_concurrent_run_exits_silently_without_acting(data_dir, capsys):
    _write([_session("s1")])
    lock_path = store.DATA_DIR / dispatcher.LOCK_NAME
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    held = open(lock_path, "w")
    fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
    try:
        spawned = []
        dispatcher.run_once(meminfo=lambda: 4000, tmux_fn=_fake_tmux([]),
                            spawner=lambda *a: spawned.append(a))
        assert spawned == []
        assert _sessions()[0]["status"] == "queued"
        assert capsys.readouterr().out == ""
    finally:
        fcntl.flock(held, fcntl.LOCK_UN)
        held.close()


# --- main() smoke test ------------------------------------------------------

def test_main_runs_without_arguments(data_dir, monkeypatch):
    _write([_session("s1")])
    monkeypatch.setattr(dispatcher, "read_meminfo_mb", lambda: 4000)
    monkeypatch.setattr(dispatcher.shared, "tmux", _fake_tmux([]))
    spawned = []
    monkeypatch.setattr(dispatcher, "spawn_worker", lambda sid, mode, qid: spawned.append(sid))
    monkeypatch.setattr(sys, "argv", ["research_dispatcher.py"])  # ignore pytest's own args
    dispatcher.main()  # smoke test: entry point cron will actually call
    assert spawned == ["s1"]


# --- the spawn path must survive this short-lived process --------------------

def test_spawn_worker_sends_prompt_blocking(data_dir, monkeypatch):
    """The dispatcher exits right after run_once — a daemon-thread send dies
    with the process before typing, so spawn_worker must pass block=True.
    (Bit us live: the first admitted worker sat at an empty prompt forever.)"""
    monkeypatch.setattr(dispatcher.shared, "ensure_claude_session", lambda *a, **k: True)
    sends = []
    monkeypatch.setattr(dispatcher.shared, "send_prompt",
                        lambda session, text, **kw: sends.append((session, kw)))
    dispatcher.spawn_worker("s1", "regular", "q1")
    assert len(sends) == 1
    assert sends[0][1].get("block") is True


def test_send_prompt_block_true_types_before_returning(monkeypatch):
    """block=True must run synchronously — the caller's process may exit the
    moment send_prompt returns."""
    from routes.kitchen import shared as sh
    typed = []
    monkeypatch.setattr(sh, "tmux", lambda cmd: typed.append(cmd))
    monkeypatch.setattr(sh.time, "sleep", lambda s: None)
    sh.send_prompt("some-session", "hello", block=True)
    assert any("send-keys" in c for c in typed)
