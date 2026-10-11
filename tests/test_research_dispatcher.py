"""scripts/research_dispatcher.py — the research crew's adapter onto the shared
run queue.

It no longer decides anything about memory: it notices queued worker sessions,
puts them in run_queue.json, and knows how to spawn one when
scripts/run_dispatcher.py says go. The admission tests that used to live here
(slot math, one-per-tick, oldest-first, dead-worker recovery) moved to
tests/test_run_dispatcher.py, where that logic now lives for every crew.

Nothing is spawned for real: a worker is minted as a research-room
conversation (routes/research_room.py) and its kickoff written to a file, and
the run dispatcher's runner — the only process-starter — is monkeypatched
away in the end-to-end test.
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
    assert runs[0]["spawn"] == {"type": "research_worker", "session_id": "s1",
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

@pytest.fixture
def room(data_dir, tmp_path, monkeypatch):
    """The research-room folder and the two skill folders, all under tmp — the
    worker's skill file exists, the distiller's is left missing on purpose."""
    folder = tmp_path / "research-room"
    folder.mkdir()
    monkeypatch.setattr(store, "RESEARCH_ROOM_DIR", folder)
    worker_dir = tmp_path / "research-worker"
    worker_dir.mkdir()
    (worker_dir / "CLAUDE.md").write_text("# worker\n")
    monkeypatch.setattr(store, "RESEARCH_WORKER_DIR", worker_dir)
    monkeypatch.setattr(store, "RESEARCH_DISTILLER_DIR", tmp_path / "research-distiller")
    return folder


def _index():
    return store.read("bot_chats/index", {})


def _question(id, text):
    return {"id": id, "kind": "question", "text": text, "topics": [], "created": "2026-07-07 09:00"}


def test_spawning_flips_the_research_record_to_running(room):
    """The research page reads this status and knows nothing about the run
    queue — leaving it `queued` while its worker is live would make it lie."""
    _write([_session("s1")])
    dispatcher.spawn_worker("s1", "regular", "q-s1", run_id="rq-1")
    assert _sessions()[0]["status"] == "running"


def test_the_trace_closes_in_both_directions_at_spawn(room):
    """THE CLOSED TRACE. The conversation names the research session, the
    research session names the conversation AND the run — all written by
    code at spawn, so nothing sleeps and scrapes for an id later and nothing
    depends on the worker remembering to report itself."""
    _write([_session("s1")], entries=[_question("q-s1", "Does   X cause Y?")])

    minted = dispatcher.spawn_worker("s1", "regular", "q-s1", run_id="rq-1")

    entry = _index()[minted["conv_id"]]
    assert entry["lane"] == "research"
    assert entry["origin"] == "research"
    assert entry["research_session_id"] == "s1"
    assert entry["title"] == "Does X cause Y?"
    assert entry["cwd"] == str(store.RESEARCH_ROOM_DIR)
    assert entry["system_prompt_file"] == str(store.RESEARCH_WORKER_DIR / "CLAUDE.md")
    session = _sessions()[0]
    assert session["conv_id"] == minted["conv_id"]
    assert session["run_id"] == "rq-1"


def test_the_kickoff_is_the_old_prompt_without_the_pane(room):
    """Same SESSION/MODE line, same verbatim APPLY command — and nothing about
    tmux, because there is no terminal to close any more."""
    _write([_session("s1")], entries=[_question("q-s1", "why")])
    minted = dispatcher.spawn_worker("s1", "regular", "q-s1", run_id="rq-1")
    prompt = open(minted["text_file"], encoding="utf-8").read()
    assert prompt == minted["prompt"]
    assert prompt.startswith("SESSION=s1 MODE=regular\n")
    assert "APPLY:" in prompt and "worker_apply_result.py" in prompt and "--session s1" in prompt
    assert "TMUX" not in prompt and "tmux" not in prompt
    assert "TOPIC=" not in prompt
    assert minted["text_file"].endswith("rq-1.txt")


def test_a_distill_worker_names_its_topic_and_carries_the_distiller_skill(room):
    """mode=='distill' targets a topic, not a question: the card says which,
    the prompt carries TOPIC=<id>: <name> looked up from research.json, and
    the missing distiller CLAUDE.md writes NO system_prompt_file rather than
    a reference the turn would trip on."""
    store.write("research.json", {
        "topics": [{"id": "hair-care", "name": "Hair & Scalp Care", "status": "active",
                    "created": "2026-07-07 09:00"}],
        "entries": [], "sessions": [_session("d1", mode="distill", entry_ids=[], topics=["hair-care"])],
    })

    minted = dispatcher.spawn_worker("d1", "distill", "hair-care", run_id="rq-2")

    entry = _index()[minted["conv_id"]]
    assert entry["title"] == "Distill: Hair & Scalp Care"
    assert "system_prompt_file" not in entry
    assert "SESSION=d1 TOPIC=hair-care: Hair & Scalp Care" in minted["prompt"]
    assert "research/edge/hair-care.md" in minted["prompt"]
    assert "APPLY:" in minted["prompt"] and "--session d1" in minted["prompt"]


def test_a_pinned_model_on_the_research_session_reaches_the_conversation(room):
    _write([_session("s1", model="haiku")], entries=[_question("q-s1", "why")])
    minted = dispatcher.spawn_worker("s1", "regular", "q-s1")
    assert _index()[minted["conv_id"]]["model"] == "haiku"


def test_a_worker_with_no_run_id_still_gets_a_kickoff_file(room):
    """Called outside the queue (a hand run), the file is named by the
    conversation instead — never a bare 'None.txt'."""
    _write([_session("s1")])
    minted = dispatcher.spawn_worker("s1", "regular", "q-s1")
    assert minted["text_file"].endswith(f"{minted['conv_id']}.txt")


def test_send_prompt_block_true_types_before_returning(monkeypatch):
    """block=True must run synchronously — the caller's process may exit the
    moment send_prompt returns."""
    from routes.kitchen import shared as sh
    typed = []
    monkeypatch.setattr(sh, "tmux", lambda cmd: typed.append(cmd))
    monkeypatch.setattr(sh.time, "sleep", lambda s: None)
    sh.send_prompt("some-session", "hello", block=True)
    assert any("send-keys" in c for c in typed)


# --- dead-worker recovery knows both generations ------------------------------

def test_recovery_leaves_a_room_worker_alone_while_its_conversation_runs(data_dir):
    """The doctor's sweep used to judge a stuck worker by its tmux pane. A room
    worker has no pane, so without this it would requeue every live one."""
    _write([_session("s1", status="running", conv_id="c1")])
    (store.DATA_DIR / "bot_chats").mkdir(parents=True, exist_ok=True)
    store.write("bot_chats/index", {"c1": {"running": True}})
    data = store.read("research.json")
    assert dispatcher.recover_dead_workers(data, live_names=set()) == []
    assert data["sessions"][0]["status"] == "running"


def test_recovery_requeues_a_room_worker_whose_conversation_stopped_without_a_reply(data_dir):
    _write([_session("s1", status="running", conv_id="c1")])
    data = store.read("research.json")
    assert dispatcher.recover_dead_workers(data, live_names=set(),
                                           index={"c1": {"running": False}}) == ["s1"]
    assert data["sessions"][0]["status"] == "queued"


# --- the run dispatcher can actually drive this adapter ----------------------

def test_the_run_dispatcher_spawns_an_enqueued_research_worker(data_dir, monkeypatch):
    """End to end across the seam: enqueue here, admit there, and the spawn
    call that comes back out carries this crew's own arguments."""
    _write([_session("s1")])
    _tick()

    spawned = []

    def fake_spawn(sid, mode, target, run_id=None):
        spawned.append((sid, mode, target, run_id))
        return {"conv_id": "c1", "text_file": "/tmp/kick.txt", "prompt": "go"}

    monkeypatch.setattr(dispatcher, "spawn_worker", fake_spawn)
    launched = []
    monkeypatch.setattr(rd, "_spawn_observatory_turn", lambda run: launched.append(run))
    rd.run_once(meminfo=lambda: 4000, probe=lambda run: {"alive": True},
                receipt_fn=lambda run, now=None: {}, ledger_fn=lambda e: None)

    run_id = _queued_runs()[0]["id"]
    assert spawned == [("s1", "regular", "q-s1", run_id)]
    # The minted conversation is handed to the same runner every queued
    # observatory turn uses, and written back onto the queue entry.
    assert launched[0]["conv_id"] == "c1" and launched[0]["spawn"]["text_file"] == "/tmp/kick.txt"
    assert _queued_runs()[0]["conv_id"] == "c1"
    assert _queued_runs()[0]["spawn"]["text_file"] == "/tmp/kick.txt"
