"""The turn runs in its own process, and survives the one that started it.

Plain English: a reply used to be written down by a thread living inside the
web server, so whenever the web server recycled a worker — on a deploy, or on
gunicorn's own request-count recycling — the reply stopped mid-sentence with
nothing written anywhere to say so. The session's card went grey, exactly like
a reply that had finished. Now the turn is handed to scripts/turn_host.py in a
process of its own.

These tests cover what `_spawn_host` stages and when it refuses, and — end to
end, with a real subprocess and a stub agent — that the host really does write
the transcript and clear the `running` flag from outside the web app entirely.

They also cover how a turn ENDS, with real processes: Stop kills the agent and
everything it started (Claude Code puts each Bash command in a session of its
own, so that takes a tree walk) but never a run_detached job; Close kills from
the turn's process record and waits before removing the worktree; and a host
that dies mid-turn — or can't read its job, or can't start the agent — turns
the card red instead of leaving `running` to age out into grey.

test_observatory_routes.py deliberately switches this path OFF (see its
`bot_client` fixture) so its 150 route tests don't each fork a process; the
turn LOOP is identical either way. This file is where the process boundary
itself is exercised.
"""
import json
import os
import stat
import subprocess
import sys
import time
from pathlib import Path

import store
from routes import observatory


STUB = """#!/usr/bin/env python3
import sys, json
text = sys.stdin.read()
print(json.dumps({"type": "system", "subtype": "init", "session_id": "sid-h"}))
print(json.dumps({"type": "stream_event", "event": {"type": "content_block_delta",
    "delta": {"type": "text_delta", "text": "hi"}}}))
print(json.dumps({"type": "assistant", "message": {"role": "assistant",
    "content": [{"type": "text", "text": "host said: " + text}]}}))
print(json.dumps({"type": "result", "subtype": "success",
    "session_id": "sid-h", "total_cost_usd": 0.02}))
"""


def _stub(tmp_path):
    p = tmp_path / "claude-stub"
    p.write_text(STUB)
    p.chmod(p.stat().st_mode | stat.S_IEXEC)
    return p


# --- staging the job ---------------------------------------------------------

def test_spawn_host_stages_a_self_describing_job(data_dir, tmp_path, monkeypatch):
    """The job file has to carry everything the host needs, because the host
    resolves nothing from its own environment — that's what stops it writing
    into a different data dir than the worker that started it."""
    seen = {}

    def fake_popen(cmd, **kw):
        seen["cmd"] = cmd
        seen["kw"] = kw
        seen["job"] = json.loads(Path(cmd[2]).read_text())
        class P: pass
        return P()

    monkeypatch.setattr(observatory.subprocess, "Popen", fake_popen)
    monkeypatch.setattr(observatory, "CLAUDE_BIN", "/nowhere/claude")
    log_path = tmp_path / "c.jsonl"
    assert observatory._spawn_host(
        {"cwd": str(tmp_path)}, "the prompt", "sid-0", "2026-01-01.000000", log_path)

    job = seen["job"]
    assert job["conv_id"] == "2026-01-01.000000"
    assert job["text"] == "the prompt"          # never argv: no length cap, not in `ps`
    assert job["resume_sid"] == "sid-0"
    assert job["log_path"] == str(log_path)
    assert job["data_dir"] == str(store.DATA_DIR)
    assert job["claude_bin"] == "/nowhere/claude"
    assert "the prompt" not in " ".join(seen["cmd"])
    # Its own session is the entire point: not in the worker's process group,
    # so a reload or a --max-requests recycle can't take it with them.
    assert seen["kw"]["start_new_session"] is True


def test_spawn_host_refuses_rather_than_raises_when_it_cannot_launch(
        data_dir, tmp_path, monkeypatch):
    """A False here selects the in-worker fallback. It must never become an
    exception, because that would cost her the reply outright — worse than the
    bug this whole change exists to fix."""
    def boom(*a, **k):
        raise OSError("no interpreter")

    monkeypatch.setattr(observatory.subprocess, "Popen", boom)
    assert observatory._spawn_host(
        {}, "text", None, "2026-01-01.000001", tmp_path / "c.jsonl") is False
    # and it doesn't leave the prompt lying around on disk
    assert not observatory._turn_job_path("2026-01-01.000001").exists()


def test_spawn_host_refuses_when_the_host_script_is_missing(
        data_dir, tmp_path, monkeypatch):
    monkeypatch.setattr(observatory.Path, "exists", lambda self: False)
    assert observatory._spawn_host(
        {}, "text", None, "2026-01-01.000002", tmp_path / "c.jsonl") is False


# --- the real thing ----------------------------------------------------------

def test_the_host_writes_the_turn_from_outside_the_web_app(data_dir, tmp_path):
    """End to end through a real subprocess: no Flask, no worker, no thread of
    ours. This is the shape that survives a worker exiting."""
    conv_id = "2026-01-01.010101"
    chats = store.DATA_DIR / "bot_chats"
    chats.mkdir(parents=True, exist_ok=True)
    log_path = chats / f"{conv_id}.jsonl"
    live_path = chats / f"{conv_id}.live"
    with store.mutate("bot_chats/index", {}) as index:
        index[conv_id] = {"bot": "keeper", "running": True,
                          "last_at": "2026-01-01T01:01:01", "cost_usd": 0.0}

    job = tmp_path / "job.json"
    job.write_text(json.dumps({
        "conv_id": conv_id,
        "config": {"cwd": str(tmp_path)},
        "text": "ping",
        "resume_sid": None,
        "log_path": str(log_path),
        "live_path": str(live_path),
        "data_dir": str(store.DATA_DIR),
        "content_dir": str(store.CONTENT_DIR),
        "claude_bin": str(_stub(tmp_path)),
    }))
    host = Path(observatory.__file__).resolve().parents[1] / "scripts" / "turn_host.py"
    out = subprocess.run([sys.executable, str(host), str(job)],
                         capture_output=True, text=True, timeout=60)
    assert out.returncode == 0, out.stderr

    # the transcript is written, minus the token deltas (transport, not record)
    events = [json.loads(l) for l in log_path.read_text().splitlines()]
    assert [e["type"] for e in events] == ["system", "assistant", "result"]
    assert "host said: ping" in json.dumps(events[1])

    # the flag is CLEARED — the whole point. A turn that ends without this is
    # the silent death: `running` stuck true, no error, a card that goes grey.
    meta = store.read("bot_chats/index", {})[conv_id]
    assert meta["running"] is False
    assert meta["claude_session_id"] == "sid-h"
    assert meta["cost_usd"] == 0.02
    assert "last_error" not in meta

    # the job file carried the prompt, so it doesn't outlive the read
    assert not job.exists()
    # and the sidecar is this turn's typing only — gone with the turn
    assert not live_path.exists()


def test_the_host_records_an_agent_that_never_starts(data_dir, tmp_path):
    """If the agent can't be launched, only the host knows — the web request
    returned long ago. Leaving `running` set here would recreate the exact
    failure mode this change removes, so it writes the error and clears it."""
    conv_id = "2026-01-01.020202"
    chats = store.DATA_DIR / "bot_chats"
    chats.mkdir(parents=True, exist_ok=True)
    with store.mutate("bot_chats/index", {}) as index:
        index[conv_id] = {"bot": "keeper", "running": True, "cost_usd": 0.0}

    job = tmp_path / "job.json"
    job.write_text(json.dumps({
        "conv_id": conv_id,
        "config": {},
        "text": "ping",
        "resume_sid": None,
        "log_path": str(chats / f"{conv_id}.jsonl"),
        "live_path": None,
        "data_dir": str(store.DATA_DIR),
        "content_dir": str(store.CONTENT_DIR),
        "claude_bin": str(tmp_path / "does-not-exist"),
    }))
    host = Path(observatory.__file__).resolve().parents[1] / "scripts" / "turn_host.py"
    out = subprocess.run([sys.executable, str(host), str(job)],
                         capture_output=True, text=True, timeout=60)
    assert out.returncode == 1

    meta = store.read("bot_chats/index", {})[conv_id]
    assert meta["running"] is False
    assert "could not start claude" in meta["last_error"]


# --- Stop means stop: the whole tree, and nothing it shouldn't -----------------
# Claude Code starts every Bash command in a session of its own, so a kill that
# stops at `claude` (or at its process group) leaves the test run or dev server
# it started running. These drive real processes shaped like that.

def _seed(conv_id, entry):
    (store.DATA_DIR / "bot_chats").mkdir(parents=True, exist_ok=True)
    with store.mutate("bot_chats/index", {}) as index:
        index[conv_id] = entry


def _gone(pid, timeout=5.0):
    """True once `pid` has exited (a zombie counts — it's only awaiting reaping)."""
    deadline = time.monotonic() + timeout
    while True:
        stat = observatory._proc_stat(pid)
        if stat is None or stat[0] == "Z":
            return True
        if time.monotonic() >= deadline:
            return False
        time.sleep(0.05)


def _agent_with_child(tmp_path, child_argv):
    """A stand-in agent that starts `child_argv` in a NEW session — exactly how
    Claude Code runs a Bash command — prints the child's pid, and waits."""
    script = tmp_path / "agent.py"
    script.write_text(
        "import subprocess, sys, time\n"
        f"c = subprocess.Popen({child_argv!r}, start_new_session=True)\n"
        "print(c.pid, flush=True)\n"
        "time.sleep(60)\n")
    proc = subprocess.Popen([sys.executable, str(script)],
                            stdout=subprocess.PIPE, text=True)
    return proc, int(proc.stdout.readline())


def test_stopping_a_turn_kills_what_the_agent_started_in_its_own_session(tmp_path):
    proc, child = _agent_with_child(
        tmp_path, [sys.executable, "-c", "import time; time.sleep(60)"])
    try:
        observatory._kill_turn(proc)
        proc.wait(timeout=5)
        assert _gone(child), "the agent's own-session child outlived the Stop"
    finally:
        for pid in (child, proc.pid):
            try:
                os.kill(pid, 9)
            except OSError:
                pass


def test_stopping_a_turn_leaves_a_detached_job_running(tmp_path):
    """A run_detached job is promised to outlive the turn. Even caught while
    its watcher is still inside the agent's tree (the launcher hasn't exited
    yet), Stop must leave it alone."""
    watcher = tmp_path / "run_detached.py"
    watcher.write_text("import time; time.sleep(60)\n")
    proc, child = _agent_with_child(
        tmp_path, [sys.executable, str(watcher), "--watch", str(tmp_path)])
    try:
        observatory._kill_turn(proc)
        proc.wait(timeout=5)
        time.sleep(0.2)
        stat = observatory._proc_stat(child)
        assert stat is not None and stat[0] != "Z", "Stop killed a detached job"
    finally:
        for pid in (child, proc.pid):
            try:
                os.kill(pid, 9)
            except OSError:
                pass


def test_the_host_stop_poll_kills_the_turn_when_the_flag_appears(data_dir, monkeypatch):
    """_watch_for_stop is Stop's fast path from another process: the flag in
    the index is all it sees, and it must both kill and mark the kill as
    deliberate so the turn doesn't record a crash."""
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "turn_host", Path(observatory.__file__).resolve().parents[1] / "scripts" / "turn_host.py")
    turn_host = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(turn_host)
    monkeypatch.setattr(turn_host, "_STOP_POLL_SEC", 0.01)
    monkeypatch.setattr(observatory, "_stop_requested", set())
    killed = []
    monkeypatch.setattr(observatory, "_kill_turn", lambda p: killed.append(p))

    class Proc:
        def poll(self):
            return None

    conv_id = "2026-01-01.030303"
    _seed(conv_id, {"running": True, "stop_requested": "2026-01-01T03:03:03"})
    import threading
    proc, done = Proc(), threading.Event()
    watcher = threading.Thread(target=turn_host._watch_for_stop,
                               args=(observatory, store, conv_id, proc, done))
    watcher.start()
    watcher.join(timeout=5)
    done.set()
    assert killed == [proc]
    assert conv_id in observatory._stop_requested


# --- recognising a process again, pid reuse and all ---------------------------

def test_a_reused_pid_is_not_mistaken_for_the_recorded_process():
    stamp = observatory._proc_stamp(os.getpid())
    boot = observatory._boot_id()
    assert observatory._same_proc(stamp, boot)
    # same pid, different start time: the kernel handed the number out again
    assert not observatory._same_proc(dict(stamp, start=stamp["start"] + 1), boot)
    # or a reboot happened in between
    assert not observatory._same_proc(stamp, "some-other-boot")


def test_a_turn_with_no_host_on_record_is_left_to_the_heartbeat():
    """The in-worker fallback, helper runs and older entries carry no host —
    they must never be called dead by this check."""
    assert observatory._host_gone({"running": True}) is False
    assert observatory._host_gone({"running": True, "turn_proc": {"agent": {"pid": 1}}}) is False


# --- a host that dies mid-turn ------------------------------------------------

SLOW_STUB = """#!/usr/bin/env python3
import sys, json, time
sys.stdin.read()
print(json.dumps({"type": "system", "subtype": "init", "session_id": "sid-slow"}), flush=True)
time.sleep(60)
"""


def _start_slow_host(tmp_path, conv_id):
    chats = store.DATA_DIR / "bot_chats"
    chats.mkdir(parents=True, exist_ok=True)
    _seed(conv_id, {"bot": "keeper", "running": True,
                          "last_at": observatory._now(), "cost_usd": 0.0})
    stub = tmp_path / "claude-slow"
    stub.write_text(SLOW_STUB)
    stub.chmod(stub.stat().st_mode | stat.S_IEXEC)
    job = tmp_path / "job.json"
    job.write_text(json.dumps({
        "conv_id": conv_id, "config": {"cwd": str(tmp_path)}, "text": "ping",
        "resume_sid": None, "log_path": str(chats / f"{conv_id}.jsonl"),
        "live_path": str(chats / f"{conv_id}.live"),
        "data_dir": str(store.DATA_DIR), "content_dir": str(store.CONTENT_DIR),
        "claude_bin": str(stub),
    }))
    host_script = Path(observatory.__file__).resolve().parents[1] / "scripts" / "turn_host.py"
    host = subprocess.Popen([sys.executable, str(host_script), str(job)],
                            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    # wait until both the host and the agent have written themselves down
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        record = store.read("bot_chats/index", {})[conv_id].get("turn_proc") or {}
        if record.get("host") and record.get("agent"):
            return host, record
        time.sleep(0.1)
    host.kill()
    raise AssertionError("the host never recorded its processes: "
                         + host.stderr.read().decode())


def test_a_host_that_dies_mid_turn_turns_the_card_red_and_kills_its_orphan(
        data_dir, tmp_path):
    conv_id = "2026-01-01.040404"
    host, record = _start_slow_host(tmp_path, conv_id)
    agent_pid = record["agent"]["pid"]
    try:
        host.kill()             # an OOM kill, as far as anyone can tell
        host.wait(timeout=5)
        entry = store.read("bot_chats/index", {})[conv_id]
        # not "running" for ten more minutes on a stale heartbeat
        assert observatory._effective_running(conv_id, entry) is False

        assert observatory.mark_dead_turns() == [conv_id]
        entry = store.read("bot_chats/index", {})[conv_id]
        assert entry["running"] is False
        assert "died unexpectedly" in entry["last_error"]
        assert "turn_proc" not in entry
        log = (store.DATA_DIR / "bot_chats" / f"{conv_id}.jsonl").read_text()
        assert json.loads(log.splitlines()[-1])["type"] == "error"
        # the agent it left behind is not left thinking (and costing) alone
        assert _gone(agent_pid)
        # and a second sweep finds nothing more to do
        assert observatory.mark_dead_turns() == []
    finally:
        for pid in (host.pid, agent_pid):
            try:
                os.kill(pid, 9)
            except OSError:
                pass


def test_close_from_another_process_kills_the_agent_and_reads_as_a_stop(
        data_dir, tmp_path, monkeypatch):
    """Close runs in a web worker that doesn't own the turn. It kills the
    agent straight from the process record, waits for it to be gone, and only
    then removes the worktree — and the host, seeing its agent die with the
    stop flag set, ends the turn cleanly rather than recording a crash."""
    conv_id = "2026-01-01.050505"
    host, record = _start_slow_host(tmp_path, conv_id)
    agent_pid = record["agent"]["pid"]
    with store.mutate("bot_chats/index", {}) as index:
        index[conv_id]["worktree"] = str(tmp_path / "wt")
    alive_at_reap = []
    monkeypatch.setattr(observatory.worktrees, "remove",
                        lambda path: alive_at_reap.append(not _gone(agent_pid, 0)))
    try:
        payload, status = observatory.close_conversation(conv_id)
        assert status == 200
        assert alive_at_reap == [False]      # removed, and only once it was dead
        host.wait(timeout=30)
        entry = store.read("bot_chats/index", {})[conv_id]
        assert entry["running"] is False
        assert "last_error" not in entry
    finally:
        for pid in (host.pid, agent_pid):
            try:
                os.kill(pid, 9)
            except OSError:
                pass


def test_close_keeps_the_worktree_of_a_turn_that_will_not_die(data_dir, monkeypatch):
    conv_id = "2026-01-01.060606"
    _seed(conv_id, {"bot": "keeper", "running": True,
                          "last_at": observatory._now(), "worktree": "/nowhere/wt"})
    monkeypatch.setattr(observatory, "_wait_turn_gone", lambda *a, **k: False)
    removed = []
    monkeypatch.setattr(observatory.worktrees, "remove", removed.append)
    assert observatory.close_conversation(conv_id)[1] == 200
    assert removed == []


# --- a host that can't get going still says so --------------------------------

def test_a_malformed_job_file_still_turns_the_card_red(data_dir):
    """The job file names its conversation by where it sits, so even one that
    won't parse can't strand `running`."""
    conv_id = "2026-01-01.070707"
    _seed(conv_id, {"bot": "keeper", "running": True})
    job = observatory._turn_job_path(conv_id)
    job.parent.mkdir(parents=True, exist_ok=True)
    job.write_text("{not json")
    host = Path(observatory.__file__).resolve().parents[1] / "scripts" / "turn_host.py"
    env = {k: v for k, v in os.environ.items() if k != "EXOCORTEX_DATA_DIR"}
    out = subprocess.run([sys.executable, str(host), str(job)],
                         capture_output=True, text=True, timeout=60, env=env)
    assert out.returncode == 2
    meta = store.read("bot_chats/index", {})[conv_id]
    assert meta["running"] is False
    assert "unreadable" in meta["last_error"]
    assert not job.exists()


def test_any_failure_to_start_the_agent_is_recorded_not_just_oserror(
        data_dir, tmp_path, monkeypatch):
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "turn_host", Path(observatory.__file__).resolve().parents[1] / "scripts" / "turn_host.py")
    turn_host = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(turn_host)
    import runtime_sensor
    monkeypatch.setattr(runtime_sensor, "start", lambda: None)

    def bad_spawn(*a, **k):
        raise TypeError("a bad value in the config")
    monkeypatch.setattr(observatory, "_spawn", bad_spawn)

    conv_id = "2026-01-01.080808"
    _seed(conv_id, {"bot": "keeper", "running": True})
    job = tmp_path / "job.json"
    job.write_text(json.dumps({
        "conv_id": conv_id, "config": {}, "text": "ping", "resume_sid": None,
        "log_path": str(tmp_path / "c.jsonl"), "live_path": None,
        "data_dir": str(store.DATA_DIR), "content_dir": str(store.CONTENT_DIR)}))
    monkeypatch.setattr(sys, "argv", ["turn_host.py", str(job)])
    assert turn_host.main() == 1
    meta = store.read("bot_chats/index", {})[conv_id]
    assert meta["running"] is False
    assert "could not start claude" in meta["last_error"]
    assert "turn_proc" not in meta
