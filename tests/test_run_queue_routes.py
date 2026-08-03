"""routes/run_queue.py — the HTTP contract for the background-run queue.

Built against a MINIMAL Flask app registering only this blueprint (the shape
tests/test_todos_routes.py uses), so nothing here needs server.py's startup or
the auth gate. /proc/meminfo is the one real thing these endpoints read, so the
memory numbers are asserted as "present and sane", not as fixed values.
"""
from datetime import datetime

import pytest
from flask import Flask

import store
from routes import run_queue
from scripts import run_dispatcher as rd


@pytest.fixture
def qclient(data_dir):
    app = Flask(__name__)
    run_queue.register(app)
    return app.test_client()


def _run(id="r1", lane="research", status="queued", queued_at=None):
    # Queued JUST NOW by default. These endpoints use the real clock, and the
    # anti-starvation bump lifts a run one lane per 30 minutes waited — so a
    # hardcoded past timestamp would flatten every lane to rank 0 and the
    # ordering assertions would pass or fail depending on the time of day.
    queued_at = queued_at or datetime.now().isoformat(timespec="seconds")
    return {"id": id, "lane": lane, "kind": "k", "mem_class": "agent",
            "status": status, "queued_at": queued_at, "attempts": 0,
            "spawn": {"type": "tmux_worker"}, "started": None, "finished": None}


def _seed(runs, **top):
    data = rd.queue_default()
    data["runs"] = runs
    data.update(top)
    store.write(rd.QUEUE, data)


# --- headroom -----------------------------------------------------------------

def test_headroom_reports_the_floor_and_the_cap(qclient):
    body = qclient.get("/api/runqueue/headroom").get_json()
    assert body["floor_mb"] == rd.FLOOR_MB
    assert body["cap"] == rd.CAP
    assert body["per_run_mb"] == rd.MEM_CLASSES["agent"]


def test_headroom_counts_what_is_actually_running(qclient):
    _seed([_run("a", status="running"), _run("b", status="running"), _run("c")])
    body = qclient.get("/api/runqueue/headroom").get_json()
    assert body["running"] == 2
    assert body["queued"] == 1


def test_headroom_says_no_when_the_cap_is_full(qclient):
    _seed([_run(f"r{i}", status="running") for i in range(rd.CAP)])
    assert qclient.get("/api/runqueue/headroom").get_json()["would_admit"] is False


def test_headroom_says_no_while_the_queue_is_paused(qclient):
    _seed([], paused_until="2099-01-01T00:00:00", pause_reason="usage limit")
    body = qclient.get("/api/runqueue/headroom").get_json()
    assert body["would_admit"] is False
    assert body["pause_reason"] == "usage limit"


def test_headroom_works_on_an_empty_install(qclient):
    """No queue file yet is the normal state on day one, not an error."""
    body = qclient.get("/api/runqueue/headroom").get_json()
    assert body["running"] == 0 and body["queued"] == 0


# --- the queue view -----------------------------------------------------------

def test_the_queue_lists_waiting_runs_in_the_order_they_will_start(qclient):
    _seed([_run("housekeeping-job", lane="housekeeping"),
           _run("keeper-job", lane="keeper"),
           _run("research-job", lane="research")])
    body = qclient.get("/api/runqueue").get_json()
    assert [r["id"] for r in body["queued"]] == \
        ["keeper-job", "research-job", "housekeeping-job"]


def test_the_queue_separates_running_from_waiting_from_finished(qclient):
    _seed([_run("going", status="running"), _run("waiting"),
           _run("over", status="done")])
    body = qclient.get("/api/runqueue").get_json()
    assert [r["id"] for r in body["running"]] == ["going"]
    assert [r["id"] for r in body["queued"]] == ["waiting"]
    assert [r["id"] for r in body["finished"]] == ["over"]


def test_the_queue_reports_the_lane_order_so_a_client_need_not_hardcode_it(qclient):
    assert qclient.get("/api/runqueue").get_json()["lanes"] == list(rd.LANES)


# --- enqueue ------------------------------------------------------------------

def test_queueing_a_conversation_adds_it_in_her_lane(qclient):
    r = qclient.post("/api/runqueue/enqueue",
                     json={"conv_id": "2026-08-03.150000", "text": "keep going"})
    assert r.status_code == 200
    run = r.get_json()["run"]
    assert run["lane"] == "hers"
    assert run["status"] == "queued"
    assert run["conv_id"] == "2026-08-03.150000"


def test_the_queued_prompt_is_written_beside_the_queue_not_into_it(qclient):
    """A queue entry is polled constantly; a full prompt belongs in a file."""
    run = qclient.post("/api/runqueue/enqueue",
                       json={"conv_id": "c1", "text": "a very long ask"}).get_json()["run"]
    path = store.DATA_DIR / rd.KICKOFF_DIR / f"{run['id']}.txt"
    assert path.read_text() == "a very long ask"
    assert run["spawn"]["text_file"] == str(path)


def test_a_queued_conversation_persists_to_the_queue_file(qclient):
    qclient.post("/api/runqueue/enqueue", json={"conv_id": "c1", "text": "hi"})
    runs = store.read(rd.QUEUE)["runs"]
    assert len(runs) == 1 and runs[0]["conv_id"] == "c1"


def test_enqueue_without_a_conversation_is_rejected(qclient):
    assert qclient.post("/api/runqueue/enqueue", json={"text": "hi"}).status_code == 400


def test_enqueue_survives_an_empty_body(qclient):
    assert qclient.post("/api/runqueue/enqueue").status_code == 400
