"""scripts/research_dispatcher.py — the research crew's adapter onto the shared
run queue.

It no longer decides anything about memory: it notices queued worker sessions,
puts them in run_queue.json, and knows how to spawn one when
scripts/run_dispatcher.py says go. The admission tests that used to live here
(slot math, one-per-tick, oldest-first, dead-worker recovery) moved to
tests/test_run_dispatcher.py, where that logic now lives for every crew.

tmux is never invoked — `shared.tmux`, `send_prompt` and `capture_session_id`
are all monkeypatched, the same pattern test_prompt_dispatcher.py uses.
"""
import fcntl
import sys

import pytest

import store
from scripts import research_dispatcher as dispatcher
from scripts import run_dispatcher as rd


# --- fakes -------------------------------------------------------------------

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


def _queued_runs():
    return store.read(rd.QUEUE, rd.queue_default())["runs"]


def _tick(**kwargs):
    kwargs.setdefault("kicker", lambda: None)
    dispatcher.run_once(**kwargs)


# --- worker_tmux_name ---------------------------------------------------------

def test_worker_tmux_name_sanitizes_separators():
    """tmux treats '.' and ':' as target separators and rewrites '_' — a name
    that differs from what we spawned can never be prompted or killed."""
    assert dispatcher.worker_tmux_name("2026-07-07.1148") == "rw-2026-07-07-1148"
    assert dispatcher.worker_tmux_name("a_b:c") == "rw-a-b-c"


# --- enqueueing ---------------------------------------------------------------

def test_a_queued_worker_session_lands_in_the_shared_queue(data_dir):
    _write([_session("s1")])
    _tick()
    runs = _queued_runs()
    assert len(runs) == 1
    assert runs[0]["lane"] == "research"
    assert runs[0]["kind"] == "research_worker"
    assert runs[0]["spawn"] == {"type": "tmux_worker", "session_id": "s1",
                                "mode": "regular", "target_id": "q-s1"}


def test_every_waiting_session_is_enqueued_not_just_one(data_dir):
    """The adapter isn't the gate any more — it hands over everything and lets
    the run dispatcher meter admission one at a time."""
    _write([_session("s1"), _session("s2"), _session("s3")])
    _tick()
    assert len(_queued_runs()) == 3


def test_enqueueing_starts_nothing(data_dir, monkeypatch):
    spawned = []
    monkeypatch.setattr(dispatcher, "spawn_worker", lambda *a: spawned.append(a))
    _write([_session("s1")])
    _tick()
    assert spawned == []
    assert _sessions()[0]["status"] == "queued"


def test_a_session_already_in_the_queue_is_not_enqueued_twice(data_dir):
    """The research record stays `queued` until the run dispatcher spawns it,
    so without this check every tick would add the same session again."""
    _write([_session("s1")])
    _tick()
    _tick()
    _tick()
    assert len(_queued_runs()) == 1


def test_a_running_run_also_blocks_a_duplicate(data_dir):
    _write([_session("s1")])
    _tick()
    data = store.read(rd.QUEUE)
    data["runs"][0]["status"] = "running"
    store.write(rd.QUEUE, data)
    _tick()
    assert len(_queued_runs()) == 1


def test_a_finished_run_does_not_block_a_fresh_attempt(data_dir):
    _write([_session("s1")])
    _tick()
    data = store.read(rd.QUEUE)
    data["runs"][0]["status"] = "done"
    store.write(rd.QUEUE, data)
    _tick()
    assert len(_queued_runs()) == 2


def test_non_worker_sessions_are_never_picked_up(data_dir):
    """research-runner / research-deep / filer sessions aren't dispatcher-
    managed and must never be enqueued."""
    _write([_session("runner", worker=False)])
    _tick()
    assert _queued_runs() == []


def test_a_session_with_no_target_is_skipped_rather_than_queued_to_fail(data_dir):
    _write([_session("s1", entry_ids=[])])
    _tick()
    assert _queued_runs() == []


def test_a_distill_session_targets_its_topic_not_a_question(data_dir):
    _write([_session("d1", mode="distill", entry_ids=[], topics=["hair-care"])])
    _tick()
    spawn = _queued_runs()[0]["spawn"]
    assert spawn["mode"] == "distill"
    assert spawn["target_id"] == "hair-care"


def test_the_run_dispatcher_is_kicked_once_work_is_queued(data_dir):
    kicks = []
    _write([_session("s1")])
    dispatcher.run_once(kicker=lambda: kicks.append(1))
    assert kicks == [1]


def test_nothing_is_kicked_when_there_is_nothing_to_queue(data_dir):
    kicks = []
    _write([])
    dispatcher.run_once(kicker=lambda: kicks.append(1))
    assert kicks == []


def test_a_failed_kick_never_breaks_the_enqueue(data_dir):
    """Cron picks it up within the minute anyway — a dead kick must not cost
    us the queue entry."""
    def boom():
        raise OSError("no interpreter")

    _write([_session("s1")])
    dispatcher.run_once(kicker=boom)
    assert len(_queued_runs()) == 1


def test_ending_is_accepted_and_ignored(data_dir):
    """Kept so scripts/worker_apply_result.py's existing kick doesn't break."""
    _write([_session("s1")])
    _tick(ending="rw-old")
    assert len(_queued_runs()) == 1


# --- locking ---------------------------------------------------------------

def test_concurrent_run_exits_silently_without_acting(data_dir, capsys):
    _write([_session("s1")])
    lock_path = store.DATA_DIR / dispatcher.LOCK_NAME
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    held = open(lock_path, "w")
    fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
    try:
        _tick()
        assert _queued_runs() == []
        assert capsys.readouterr().out == ""
    finally:
        fcntl.flock(held, fcntl.LOCK_UN)
        held.close()


# --- main() smoke test ------------------------------------------------------

def test_main_runs_without_arguments(data_dir, monkeypatch):
    _write([_session("s1")])
    monkeypatch.setattr(dispatcher, "_kick_run_dispatcher", lambda: None)
    monkeypatch.setattr(sys, "argv", ["research_dispatcher.py"])  # ignore pytest's own args
    dispatcher.main()  # smoke test: entry point cron will actually call
    assert len(_queued_runs()) == 1


# --- the spawn path (called BY the run dispatcher) ---------------------------

def test_spawning_flips_the_research_record_to_running(data_dir, monkeypatch):
    """The research page reads this status and knows nothing about the run
    queue — leaving it `queued` while its worker is live would make it lie."""
    monkeypatch.setattr(dispatcher.shared, "ensure_claude_session", lambda *a, **k: True)
    monkeypatch.setattr(dispatcher.shared, "send_prompt", lambda *a, **k: None)
    monkeypatch.setattr(dispatcher.time, "sleep", lambda s: None)
    monkeypatch.setattr(dispatcher.research_ctl, "capture_session_id", lambda *a, **k: False)
    _write([_session("s1")])

    dispatcher.spawn_worker("s1", "regular", "q1")

    assert _sessions()[0]["status"] == "running"


def test_spawn_worker_sends_prompt_blocking(data_dir, monkeypatch):
    """The caller exits right after spawning — a daemon-thread send dies with
    the process before typing, so spawn_worker must pass block=True.
    (Bit us live: the first admitted worker sat at an empty prompt forever.)"""
    monkeypatch.setattr(dispatcher.shared, "ensure_claude_session", lambda *a, **k: True)
    sends = []
    monkeypatch.setattr(dispatcher.shared, "send_prompt",
                        lambda session, text, **kw: sends.append((session, kw)))
    monkeypatch.setattr(dispatcher.time, "sleep", lambda s: None)
    monkeypatch.setattr(dispatcher.research_ctl, "capture_session_id", lambda *a, **k: False)
    dispatcher.spawn_worker("s1", "regular", "q1")
    assert len(sends) == 1
    assert sends[0][1].get("block") is True


# --- sessionId capture tail ---------------------------------------------------

def test_spawn_worker_captures_session_id_after_send(data_dir, monkeypatch):
    """After the blocking send, spawn_worker resolves+stamps its own live
    sessionId before the short-lived caller exits — its only chance, and
    without it the run's token receipt has no transcript to read."""
    monkeypatch.setattr(dispatcher.shared, "ensure_claude_session", lambda *a, **k: True)
    monkeypatch.setattr(dispatcher.shared, "send_prompt", lambda *a, **k: None)
    monkeypatch.setattr(dispatcher.time, "sleep", lambda s: None)
    captures = []
    monkeypatch.setattr(
        dispatcher.research_ctl, "capture_session_id",
        lambda tmux_name, session_id: captures.append((tmux_name, session_id)),
    )

    dispatcher.spawn_worker("s1", "regular", "q1")

    assert captures == [("rw-s1", "s1")]


def test_spawn_worker_capture_failure_never_crashes(data_dir, monkeypatch):
    """The hard rule: a capture blow-up must never crash (or, via a stuck
    sleep, meaningfully delay beyond the deliberate ~7s) the spawn."""
    monkeypatch.setattr(dispatcher.shared, "ensure_claude_session", lambda *a, **k: True)
    monkeypatch.setattr(dispatcher.shared, "send_prompt", lambda *a, **k: None)
    monkeypatch.setattr(dispatcher.time, "sleep", lambda s: None)

    def _boom(*a, **k):
        raise RuntimeError("boom")

    monkeypatch.setattr(dispatcher.research_ctl, "capture_session_id", _boom)

    dispatcher.spawn_worker("s1", "regular", "q1")  # must not raise


# --- mode switch: distill sessions target a topic, not a question ------------

def test_spawn_worker_uses_distiller_dir_and_topic_prompt_for_distill_mode(data_dir, monkeypatch):
    """spawn_worker itself, for mode=='distill', spawns in
    RESEARCH_DISTILLER_DIR (not RESEARCH_WORKER_DIR) and builds a prompt
    carrying SESSION/TOPIC/TMUX/APPLY — looking the topic's name up from
    research.json since the session only carries its id."""
    store.write("research.json", {
        "topics": [{"id": "hair-care", "name": "Hair & Scalp Care", "status": "active", "created": "2026-07-07 09:00"}],
        "entries": [], "sessions": [],
    })
    spawn_calls = []
    monkeypatch.setattr(dispatcher.shared, "ensure_claude_session",
                        lambda name, path, **kw: spawn_calls.append((name, path)))
    sends = []
    monkeypatch.setattr(dispatcher.shared, "send_prompt",
                        lambda session, text, **kw: sends.append((session, text, kw)))
    monkeypatch.setattr(dispatcher.time, "sleep", lambda s: None)
    monkeypatch.setattr(dispatcher.research_ctl, "capture_session_id", lambda *a, **k: False)

    dispatcher.spawn_worker("d1", "distill", "hair-care")

    assert len(spawn_calls) == 1
    tmux_name, spawn_path = spawn_calls[0]
    assert tmux_name == "rw-d1"
    assert spawn_path == store.RESEARCH_DISTILLER_DIR
    assert spawn_path != store.RESEARCH_WORKER_DIR

    assert len(sends) == 1
    sent_session, prompt, kw = sends[0]
    assert sent_session == "rw-d1"
    assert "SESSION=d1" in prompt
    assert "TOPIC=hair-care: Hair & Scalp Care" in prompt
    assert "TMUX=rw-d1" in prompt
    assert "APPLY:" in prompt
    assert "worker_apply_result.py" in prompt
    assert "--session d1" in prompt
    assert kw.get("block") is True


def test_spawn_worker_regular_mode_still_uses_worker_dir(data_dir, monkeypatch):
    """Non-distill modes are unaffected by the mode switch: still
    RESEARCH_WORKER_DIR, still the MODE=<mode> prompt shape."""
    spawn_calls = []
    monkeypatch.setattr(dispatcher.shared, "ensure_claude_session",
                        lambda name, path, **kw: spawn_calls.append((name, path)))
    sends = []
    monkeypatch.setattr(dispatcher.shared, "send_prompt",
                        lambda session, text, **kw: sends.append((session, text, kw)))
    monkeypatch.setattr(dispatcher.time, "sleep", lambda s: None)
    monkeypatch.setattr(dispatcher.research_ctl, "capture_session_id", lambda *a, **k: False)

    dispatcher.spawn_worker("s1", "regular", "q1")

    assert spawn_calls[0][1] == store.RESEARCH_WORKER_DIR
    assert "MODE=regular" in sends[0][1]
    assert "TOPIC=" not in sends[0][1]


def test_send_prompt_block_true_types_before_returning(monkeypatch):
    """block=True must run synchronously — the caller's process may exit the
    moment send_prompt returns."""
    from routes.kitchen import shared as sh
    typed = []
    monkeypatch.setattr(sh, "tmux", lambda cmd: typed.append(cmd))
    monkeypatch.setattr(sh.time, "sleep", lambda s: None)
    sh.send_prompt("some-session", "hello", block=True)
    assert any("send-keys" in c for c in typed)


# --- the run dispatcher can actually drive this adapter ----------------------

def test_the_run_dispatcher_spawns_an_enqueued_research_worker(data_dir, monkeypatch):
    """End to end across the seam: enqueue here, admit there, and the spawn
    call that comes back out carries this crew's own arguments."""
    _write([_session("s1")])
    _tick()

    spawned = []
    monkeypatch.setattr(dispatcher, "spawn_worker",
                        lambda sid, mode, target: spawned.append((sid, mode, target)))
    rd.run_once(meminfo=lambda: 4000, probe=lambda run: {"alive": True},
                receipt_fn=lambda run, now=None: {}, ledger_fn=lambda e: None)

    assert spawned == [("s1", "regular", "q-s1")]
