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


# --- make_probe: the real probe, on observatory turns -------------------------
# These are the first tests make_probe has ever had, and they exist because the
# thing it got wrong was invisible without them: every other test in this file
# injects a stub probe, so the real one shipped a bug that quietly killed live
# turns. The regression it guards is the one below — a healthy turn that has
# simply been thinking for a while.

class _Tmux:
    """Minimal stand-in for shared.tmux — no tmux workers in these tests."""
    returncode = 1
    stdout = ""


def _probe_for(entry, log_age_sec=None, now=NOW):
    """A real probe over one conversation, with both witnesses under control."""
    (store.DATA_DIR / "bot_chats").mkdir(parents=True, exist_ok=True)
    store.write("bot_chats/index", {"c1": entry})
    mtime = None if log_age_sec is None else (
        now - timedelta(seconds=log_age_sec)).timestamp()
    return rd.make_probe(tmux_fn=lambda *a, **kw: _Tmux(),
                         clock=lambda: now,
                         log_mtime_fn=lambda conv_id: mtime)


def _observatory_run(**extra):
    return _run(id="a", status="running",
                spawn={"type": "observatory_turn", "conv_id": "c1"},
                conv_id="c1", **extra)


def test_a_long_thinking_turn_is_alive_even_though_last_at_went_stale(data_dir):
    """THE REGRESSION. last_at only moves at the start and end of a turn plus a
    30s heartbeat; the log moves on every event. A turn quiet in the index for
    longer than STALE_SEC, whose log was written seconds ago, is working — and
    used to be requeued and then permanently failed while it was still typing.
    """
    stale = (NOW - timedelta(seconds=rd.STALE_SEC + 300)).isoformat()
    probe = _probe_for({"running": True, "last_at": stale}, log_age_sec=5)
    assert probe(_observatory_run())["alive"] is True


def test_a_turn_with_no_witness_moving_is_not_alive(data_dir):
    """The other half: `running` on its own still buys nothing. A worker that
    died mid-turn leaves the flag set forever, and neither witness moves."""
    stale = (NOW - timedelta(seconds=rd.STALE_SEC + 300)).isoformat()
    probe = _probe_for({"running": True, "last_at": stale},
                       log_age_sec=rd.STALE_SEC + 300)
    assert probe(_observatory_run())["alive"] is False


def test_a_freshly_spawned_turn_with_no_log_yet_is_alive_on_last_at(data_dir):
    """Between spawn and the first event there may be no log file at all (or
    only a stale one from a previous turn). last_at covers exactly that gap."""
    probe = _probe_for({"running": True, "last_at": NOW.isoformat()},
                       log_age_sec=None)
    assert probe(_observatory_run())["alive"] is True


def test_a_turn_that_stopped_running_reads_as_completed(data_dir):
    probe = _probe_for({"running": False, "last_at": NOW.isoformat()},
                       log_age_sec=5)
    result = probe(_observatory_run())
    assert result["alive"] is False
    assert result["completed"] is True


def test_a_turns_last_error_reaches_the_probe(data_dir):
    probe = _probe_for({"running": False, "last_at": NOW.isoformat(),
                        "last_error": "claude exited 1"}, log_age_sec=5)
    assert probe(_observatory_run())["error"] == "claude exited 1"


# --- quiet_seconds: which witness wins ----------------------------------------

def test_quiet_seconds_takes_the_freshest_of_the_two_witnesses(data_dir):
    entry = {"last_at": (NOW - timedelta(seconds=900)).isoformat()}
    fresh_log = (NOW - timedelta(seconds=10)).timestamp()
    quiet = rd.quiet_seconds("c1", entry, NOW, lambda conv_id: fresh_log)
    assert quiet == pytest.approx(10, abs=1)

    entry = {"last_at": (NOW - timedelta(seconds=10)).isoformat()}
    old_log = (NOW - timedelta(seconds=900)).timestamp()
    quiet = rd.quiet_seconds("c1", entry, NOW, lambda conv_id: old_log)
    assert quiet == pytest.approx(10, abs=1)


def test_quiet_seconds_is_none_when_neither_witness_exists(data_dir):
    assert rd.quiet_seconds("c1", {}, NOW, lambda conv_id: None) is None


# --- make_probe: research workers, judged by the research record --------------
# A research worker used to be probed by its tmux pane. It runs as a
# research-room conversation now, so liveness is the conversation's (the same
# two witnesses as an observatory turn) and completion is the research
# record's — done/failed, or an llm reply filed under the session.

def _research_index(entry):
    (store.DATA_DIR / "bot_chats").mkdir(parents=True, exist_ok=True)
    store.write("bot_chats/index", {"c1": entry})


def _research_json(status="running", conv_id="c1", entries=None, **extra):
    store.write("research.json", {
        "topics": [], "entries": entries or [],
        "sessions": [dict({"id": "s1", "status": status, "conv_id": conv_id,
                           "worker": True, "entry_ids": ["q1"]}, **extra)],
    })


def _research_run(**extra):
    return _run(id="a", status="running",
                spawn={"type": "research_worker", "session_id": "s1"}, **extra)


def _research_probe(log_age_sec=5, live_tmux=()):
    class _Tmux:
        returncode = 0 if live_tmux else 1
        stdout = "\n".join(live_tmux)
    mtime = None if log_age_sec is None else (NOW - timedelta(seconds=log_age_sec)).timestamp()
    return rd.make_probe(tmux_fn=lambda *a, **kw: _Tmux(), clock=lambda: NOW,
                         log_mtime_fn=lambda conv_id: mtime)


def test_a_room_worker_is_alive_while_its_conversation_is_running_and_moving(data_dir):
    _research_index({"running": True, "last_at": NOW.isoformat()})
    _research_json()
    result = _research_probe()(_research_run())
    assert result["alive"] is True and result["completed"] is False
    # The conversation id reaches the run through the probe, even when the
    # run entry never learned it — settle backfills it for the receipt.
    assert result["conv_id"] == "c1"


def test_a_room_worker_whose_conversation_went_quiet_is_not_alive(data_dir):
    stale = (NOW - timedelta(seconds=rd.STALE_SEC + 300)).isoformat()
    _research_index({"running": True, "last_at": stale})
    _research_json()
    assert _research_probe(log_age_sec=rd.STALE_SEC + 300)(_research_run())["alive"] is False


def test_a_room_worker_is_completed_when_the_research_record_closes(data_dir):
    _research_index({"running": False, "last_at": NOW.isoformat()})
    _research_json(status="done")
    result = _research_probe()(_research_run())
    assert result["alive"] is False and result["completed"] is True


def test_an_llm_reply_under_the_session_also_counts_as_completed(data_dir):
    _research_index({"running": False, "last_at": NOW.isoformat()})
    _research_json(status="running", entries=[{"id": "r1", "author": "llm", "session": "s1"}])
    assert _research_probe()(_research_run())["completed"] is True


def test_the_conversations_last_error_reaches_a_research_probe(data_dir):
    _research_index({"running": False, "last_at": NOW.isoformat(), "last_error": "claude exited 1"})
    _research_json(status="running")
    assert _research_probe()(_research_run())["error"] == "claude exited 1"


def test_a_legacy_tmux_worker_is_still_judged_by_its_pane(data_dir):
    """A record spawned before the move has no conv_id; its pane is the only
    witness left, under either spawn-type name."""
    _research_index({})
    _research_json(conv_id=None)
    live = _research_probe(live_tmux=("rw-s1",))
    dead = _research_probe(live_tmux=())
    legacy = _run(id="a", status="running", spawn={"type": "tmux_worker", "session_id": "s1"})
    assert live(legacy)["alive"] is True
    assert dead(legacy)["alive"] is False
    assert live(_research_run())["alive"] is True


def test_settle_backfills_the_conversation_id_from_the_probe():
    run = _run(status="running")
    rd.settle(run, {"alive": False, "completed": True, "conv_id": "c9"}, NOW)
    assert run["conv_id"] == "c9"


def test_spawning_a_research_worker_writes_its_conversation_back_onto_the_queue(data_dir, monkeypatch):
    """spawn_run gets a COPY of the admitted entry, so what the spawn learns
    has to be written back on purpose — or the reaper and the receipt would
    look for a conversation the queue never heard of."""
    from scripts import research_dispatcher
    _write([_research_run()])
    monkeypatch.setattr(research_dispatcher, "spawn_worker",
                        lambda sid, mode, target, run_id=None:
                        {"conv_id": "c1", "text_file": "/tmp/k.txt", "prompt": "go"})
    launched = []
    monkeypatch.setattr(rd, "_spawn_observatory_turn", lambda run: launched.append(run))

    rd.spawn_run(_research_run())

    stored = _runs()[0]
    assert stored["conv_id"] == "c1"
    assert stored["spawn"]["conv_id"] == "c1" and stored["spawn"]["text_file"] == "/tmp/k.txt"
    assert stored["spawn"]["type"] == "research_worker"
    assert launched[0]["conv_id"] == "c1"
