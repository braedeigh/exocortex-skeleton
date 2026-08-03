"""scripts/run_dispatcher.py — the shared admission controller every background
crew queues into.

Nothing here touches tmux, /proc, the real clock, or a real `claude` process:
`meminfo`, `probe`, `spawner`, `clock`, `receipt_fn` and `ledger_fn` are all
injected, the same pattern tests/test_research_dispatcher.py uses. The pure
functions (ranking, slots, settling) are tested directly, because they're where
the actual decisions live.
"""
from datetime import datetime, timedelta

import pytest

import store
from scripts import run_dispatcher as rd


NOW = datetime(2026, 8, 3, 15, 0, 0)


# --- fakes -------------------------------------------------------------------

def _run(id="r1", lane="research", status="queued", mem_class="agent",
         queued_at="2026-08-03 15:00:00", spawn=None, **extra):
    run = {
        "id": id, "lane": lane, "kind": "test_kind", "mem_class": mem_class,
        "status": status, "queued_at": queued_at, "attempts": 0,
        "spawn": spawn if spawn is not None else {"type": "tmux_worker", "session_id": "s1"},
        "started": None, "finished": None, "model": None, "conv_id": None,
        "claude_session": None, "claude_cwd": None,
    }
    run.update(extra)
    return run


def _write(runs, **top):
    data = rd.queue_default()
    data["runs"] = runs
    data.update(top)
    store.write(rd.QUEUE, data)


def _queue():
    return store.read(rd.QUEUE, rd.queue_default())


def _runs():
    return _queue()["runs"]


def _tick(**kwargs):
    """run_once with every real dependency replaced by a harmless default."""
    kwargs.setdefault("meminfo", lambda: 4000)
    kwargs.setdefault("clock", lambda: NOW)
    kwargs.setdefault("probe", lambda run: {"alive": True})
    kwargs.setdefault("spawner", lambda run: None)
    kwargs.setdefault("receipt_fn", lambda run, now=None: {"tokens": {}, "cost_usd": 0.0})
    kwargs.setdefault("ledger_fn", lambda entry: None)
    rd.run_once(**kwargs)


# --- the shared default ------------------------------------------------------

def test_queue_default_is_a_fresh_object_every_call():
    """A shared default dict would be mutated and written back by store.mutate,
    so the 'empty' queue would accumulate real runs on a fresh install."""
    a, b = rd.queue_default(), rd.queue_default()
    a["runs"].append({"id": "x"})
    assert b["runs"] == []


# --- ranking -----------------------------------------------------------------

def test_lanes_rank_in_her_order():
    ranks = [rd.lane_index(l) for l in
             ("keeper", "hers", "research", "housekeeping", "night")]
    assert ranks == sorted(ranks) == [0, 1, 2, 3, 4]


def test_an_unknown_lane_sorts_last_not_first():
    assert rd.lane_index("nonsense") > rd.lane_index("night")


def test_waiting_bumps_a_run_up_one_lane_per_interval():
    run = _run(lane="night", queued_at=(NOW - timedelta(minutes=65)).isoformat())
    # night is index 4; 65 minutes = two bumps
    assert rd.effective_rank(run, NOW) == 2


def test_the_bump_never_outranks_a_fresh_keeper_run():
    old = _run(lane="night", queued_at=(NOW - timedelta(days=3)).isoformat())
    assert rd.effective_rank(old, NOW) == 0


def test_admission_takes_the_best_lane_first():
    _write([_run(id="low", lane="housekeeping"), _run(id="high", lane="keeper")])
    chosen = rd.next_admit(_queue(), NOW, avail_mb=4000, live_count=0)
    assert chosen["id"] == "high"


def test_within_a_lane_it_is_first_in_first_out():
    _write([
        _run(id="second", queued_at="2026-08-03 14:30:00"),
        _run(id="first", queued_at="2026-08-03 14:00:00"),
    ])
    chosen = rd.next_admit(_queue(), NOW, avail_mb=4000, live_count=0)
    assert chosen["id"] == "first"


# --- memory arithmetic --------------------------------------------------------

def test_the_floor_is_never_spent():
    # 1024 floor + 450 for one agent = 1474 needed to admit anything
    assert rd.compute_slots(1473, 0) == 0
    assert rd.compute_slots(1474, 0) == rd.CAP


def test_the_cap_holds_even_with_memory_to_spare():
    assert rd.compute_slots(8000, rd.CAP) == 0


def test_a_run_too_big_for_the_headroom_is_not_admitted():
    _write([_run(id="big", mem_class="agent_verify")])
    # 1024 floor + 900 = 1924 needed; 1900 is not enough
    assert rd.next_admit(_queue(), NOW, avail_mb=1900, live_count=0) is None
    assert rd.next_admit(_queue(), NOW, avail_mb=1930, live_count=0)["id"] == "big"


def test_a_small_run_never_hops_a_big_one_that_does_not_fit():
    """Head-of-line waiting is deliberate: letting small runs jump the queue
    means a big run can starve forever behind a trickle of little ones."""
    _write([
        _run(id="big", lane="keeper", mem_class="agent_verify"),
        _run(id="small", lane="research", mem_class="agent"),
    ])
    assert rd.next_admit(_queue(), NOW, avail_mb=1600, live_count=0) is None


def test_an_unknown_mem_class_is_budgeted_as_the_large_one():
    assert rd.mem_needed({"mem_class": "who-knows"}) == rd.MEM_CLASSES["agent_verify"]


# --- one per tick -------------------------------------------------------------

def test_only_one_run_is_admitted_per_tick(data_dir):
    _write([_run(id="a"), _run(id="b"), _run(id="c")])
    spawned = []
    _tick(spawner=spawned.append)
    assert len(spawned) == 1
    assert sum(1 for r in _runs() if r["status"] == "running") == 1


def test_an_admitted_run_is_marked_running_with_a_start_time(data_dir):
    _write([_run(id="a")])
    _tick()
    admitted = _runs()[0]
    assert admitted["status"] == "running"
    assert admitted["started"] == NOW.isoformat(timespec="seconds")


def test_nothing_is_admitted_without_headroom(data_dir):
    _write([_run(id="a")])
    spawned = []
    _tick(meminfo=lambda: 1100, spawner=spawned.append)
    assert spawned == []
    assert _runs()[0]["status"] == "queued"


# --- liveness by evidence -----------------------------------------------------

def test_a_live_run_is_left_alone(data_dir):
    _write([_run(id="a", status="running", started=NOW.isoformat())])
    _tick(probe=lambda run: {"alive": True})
    assert _runs()[0]["status"] == "running"


def test_a_finished_run_is_reaped_and_gets_a_receipt(data_dir):
    _write([_run(id="a", status="running", started=NOW.isoformat())])
    ledgered = []
    _tick(probe=lambda run: {"alive": False, "completed": True},
          ledger_fn=ledgered.append)
    assert _runs()[0]["status"] == "done"
    assert _runs()[0]["finished"] == NOW.isoformat(timespec="seconds")
    assert len(ledgered) == 1
    assert ledgered[0]["id"] == "a"


def test_a_run_that_errored_is_failed_and_still_gets_a_receipt(data_dir):
    _write([_run(id="a", status="running", started=NOW.isoformat())])
    ledgered = []
    _tick(probe=lambda run: {"alive": False, "completed": False, "error": "boom"},
          ledger_fn=ledgered.append)
    assert _runs()[0]["status"] == "failed"
    assert "boom" in _runs()[0]["error"]
    assert len(ledgered) == 1


def test_a_vanished_run_is_requeued_once_then_failed(data_dir):
    _write([_run(id="a", status="running", started=NOW.isoformat())])
    gone = lambda run: {"alive": False, "completed": False, "error": None}  # noqa: E731

    _tick(probe=gone, spawner=lambda run: None, meminfo=lambda: 1100)
    assert _runs()[0]["status"] == "queued"
    assert _runs()[0]["attempts"] == 1

    _write([_run(id="a", status="running", attempts=1, started=NOW.isoformat())])
    _tick(probe=gone, meminfo=lambda: 1100)
    assert _runs()[0]["status"] == "failed"


def test_liveness_ignores_the_status_field_entirely(data_dir):
    """The whole point: a run flagged `running` that no evidence supports is
    not running. Trusting the flag is how sessions got stranded for days."""
    _write([_run(id="a", status="running", started=NOW.isoformat())])
    _tick(probe=lambda run: {"alive": False, "completed": True}, meminfo=lambda: 1100)
    assert _runs()[0]["status"] == "done"


# --- the throttle rule --------------------------------------------------------

def test_a_rate_limited_run_requeues_without_counting_an_attempt(data_dir):
    _write([_run(id="a", status="running", started=NOW.isoformat())])
    _tick(probe=lambda run: {"alive": False, "error": "Claude usage limit reached"},
          meminfo=lambda: 1100)
    run = _runs()[0]
    assert run["status"] == "queued"
    assert run["attempts"] == 0
    assert run["throttled"] is True


def test_a_rate_limit_pauses_the_whole_queue(data_dir):
    _write([_run(id="a", status="running", started=NOW.isoformat()),
            _run(id="b", status="queued")])
    spawned = []
    _tick(probe=lambda run: {"alive": False, "error": "429 too many requests"},
          spawner=spawned.append)
    assert spawned == [], "nothing may be admitted on the tick that hit the wall"
    assert rd.is_paused(_queue(), NOW)


def test_nothing_is_admitted_while_the_queue_is_paused(data_dir):
    _write([_run(id="a")],
           paused_until=(NOW + timedelta(minutes=30)).isoformat(timespec="seconds"))
    spawned = []
    _tick(spawner=spawned.append)
    assert spawned == []
    assert _runs()[0]["status"] == "queued"


def test_the_queue_resumes_once_the_cooling_period_passes(data_dir):
    _write([_run(id="a")],
           paused_until=(NOW - timedelta(minutes=1)).isoformat(timespec="seconds"))
    spawned = []
    _tick(spawner=spawned.append)
    assert len(spawned) == 1


def test_reaping_still_happens_while_paused(data_dir):
    """We stop STARTING things, not learning what finished."""
    _write([_run(id="a", status="running", started=NOW.isoformat())],
           paused_until=(NOW + timedelta(minutes=30)).isoformat(timespec="seconds"))
    _tick(probe=lambda run: {"alive": False, "completed": True})
    assert _runs()[0]["status"] == "done"


# --- failure handling ---------------------------------------------------------

def test_a_failed_spawn_puts_the_run_back_rather_than_stranding_it(data_dir):
    _write([_run(id="a")])

    def boom(run):
        raise RuntimeError("no tmux")

    _tick(spawner=boom)
    run = _runs()[0]
    assert run["status"] == "queued", "a run nothing will reap must not stay `running`"
    assert run["attempts"] == 1
    assert "spawn failed" in run["error"]


def test_a_broken_receipt_never_costs_us_the_reap(data_dir):
    _write([_run(id="a", status="running", started=NOW.isoformat())])

    def boom(run, now=None):
        raise RuntimeError("transcript gone")

    _tick(probe=lambda run: {"alive": False, "completed": True}, receipt_fn=boom)
    assert _runs()[0]["status"] == "done"


def test_probe_results_backfill_the_ids_a_receipt_needs(data_dir):
    _write([_run(id="a", status="running", started=NOW.isoformat())])
    _tick(probe=lambda run: {"alive": False, "completed": True,
                             "claude_session": "sid-9", "claude_cwd": "/tmp/x",
                             "model": "sonnet"})
    run = _runs()[0]
    assert (run["claude_session"], run["claude_cwd"], run["model"]) == \
        ("sid-9", "/tmp/x", "sonnet")


# --- housekeeping -------------------------------------------------------------

def test_finished_runs_are_pruned_to_a_recent_tail():
    data = rd.queue_default()
    data["runs"] = [_run(id=f"d{i}", status="done", finished=f"2026-08-0{i % 9 + 1}")
                    for i in range(60)]
    dropped = rd.prune_finished(data, keep=10)
    assert dropped == 50
    assert len(data["runs"]) == 10


def test_pruning_never_drops_work_that_has_not_finished():
    data = rd.queue_default()
    data["runs"] = ([_run(id=f"d{i}", status="done", finished="2026-08-01") for i in range(60)]
                    + [_run(id="waiting"), _run(id="going", status="running")])
    rd.prune_finished(data, keep=5)
    ids = {r["id"] for r in data["runs"]}
    assert {"waiting", "going"} <= ids


def test_new_run_normalizes_a_bad_lane_and_class():
    run = rd.new_run("not-a-lane", "some_kind", {"type": "tmux_worker"},
                     mem_class="huge", clock=lambda: NOW)
    assert run["lane"] == "housekeeping"
    assert run["mem_class"] == rd.DEFAULT_MEM_CLASS
    assert run["status"] == "queued"


def test_the_dispatcher_registers_itself_on_the_automations_page(data_dir):
    _write([])
    _tick()
    runs = store.read("scheduled_runs.json", {"runs": []})["runs"]
    entry = next(r for r in runs if r["id"] == rd.RUN_ID)
    assert entry["schedule"] == "* * * * *"
    assert entry["last_status"] == "ok"


def test_the_automations_toggle_stops_it(data_dir):
    store.write("scheduled_runs.json",
                {"runs": [{"id": rd.RUN_ID, "name": "Run dispatcher", "enabled": False}]})
    assert rd.enabled() is False


def test_an_absent_registry_entry_means_enabled(data_dir):
    assert rd.enabled() is True


# --- the lock -----------------------------------------------------------------

def test_an_overlapping_tick_exits_instead_of_racing(data_dir, monkeypatch):
    """Two cron ticks (or a tick and an event-driven kick) must never both
    admit — the flock is what makes 'one per tick' true across processes."""
    import fcntl

    def held(*a, **kw):
        raise OSError("locked")

    monkeypatch.setattr(fcntl, "flock", held)
    _write([_run(id="a")])
    spawned = []
    _tick(spawner=spawned.append)
    assert spawned == []
    assert _runs()[0]["status"] == "queued"
