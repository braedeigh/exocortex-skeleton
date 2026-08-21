"""The turn runs in its own process, and survives the one that started it.

Plain English: a reply used to be written down by a thread living inside the
web server, so whenever the web server recycled a worker — on a deploy, or on
gunicorn's own request-count recycling — the reply stopped mid-sentence with
nothing written anywhere to say so. The session's card went grey, exactly like
a reply that had finished. Now the turn is handed to scripts/turn_host.py in a
process of its own.

These tests cover the two halves of that: what `_spawn_host` stages and when it
refuses, and — end to end, with a real subprocess and a stub agent — that the
host really does write the transcript and clear the `running` flag from
outside the web app entirely.

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
