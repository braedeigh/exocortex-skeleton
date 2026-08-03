"""Run queue — the app's window onto the background-run admission controller.

Plain English: scripts/run_dispatcher.py is a cron script that decides which
background runs get to start, one at a time, as memory allows. This module is
how the web app sees and touches that queue: it can report how much headroom is
left right now, list what's waiting, and put one of the owner's own sessions
into the queue when there isn't room to start it immediately.

It never admits anything itself. Only the dispatcher admits — one door, one
decision. These endpoints read, and enqueue.

Touches:
  - scripts/run_dispatcher.py — the queue's shape, lanes, and memory constants
    all come from there rather than being restated here.
  - data/run_queue.json — the queue itself.
  - data/run_kickoffs/ — the prompt text a queued session will be sent when it
    finally starts (the dispatcher hands the file to scripts/spinoff_runner.py).
  - routes/observatory.py — the memory refusal that sends the owner here.

Prompt that produced it: "i want some kind of message to pop up with my memory
allocation bar if i want to start more than 3, then with an option to just queue
it if necessary."
"""
from datetime import datetime

from flask import request, jsonify

import store
from scripts import run_dispatcher as rd


def _meminfo_mb():
    """MemAvailable and MemTotal, in MB. Returns (None, None) off Linux — the
    callers degrade to "we can't tell" rather than guessing."""
    avail = total = None
    try:
        with open("/proc/meminfo") as f:
            for line in f:
                if line.startswith("MemAvailable:"):
                    avail = int(line.split()[1]) // 1024
                elif line.startswith("MemTotal:"):
                    total = int(line.split()[1]) // 1024
                if avail is not None and total is not None:
                    break
    except (OSError, ValueError):
        return None, None
    return avail, total


def headroom():
    """What the memory prompt needs to draw itself: how much is free, how much
    is reserved, how many runs are going, and whether one more would start."""
    avail, total = _meminfo_mb()
    data = store.read(rd.QUEUE, rd.queue_default())
    now = datetime.now()
    live = rd.running_runs(data)
    waiting = rd.queued_runs(data)
    paused = rd.is_paused(data, now)

    would_admit = False
    if avail is not None and not paused:
        would_admit = rd.compute_slots(avail, len(live)) >= 1

    return {
        "available_mb": avail,
        "total_mb": total,
        "floor_mb": rd.FLOOR_MB,
        "per_run_mb": rd.MEM_CLASSES["agent"],
        "cap": rd.CAP,
        "running": len(live),
        "queued": len(waiting),
        "would_admit": would_admit,
        "paused_until": data.get("paused_until"),
        "pause_reason": data.get("pause_reason"),
    }


def _kickoff_path(run_id):
    d = store.DATA_DIR / rd.KICKOFF_DIR
    d.mkdir(parents=True, exist_ok=True)
    return d / f"{run_id}.txt"


def enqueue_conversation(conv_id, text, lane="hers", clock=None):
    """Put one of her conversations in the queue instead of starting it now.

    The prompt text is written beside the queue rather than into it: a queue
    entry is metadata a UI reads on every poll, and a full prompt could be
    thousands of characters. The dispatcher hands the file straight to
    spinoff_runner.py when the run is finally admitted.

    Returns the run entry. Raises ValueError on a missing conversation id.
    """
    if not conv_id or not isinstance(conv_id, str):
        raise ValueError("conv_id is required")
    run = rd.new_run(lane, "observatory_turn",
                     {"type": "observatory_turn", "conv_id": conv_id},
                     mem_class="agent", clock=clock, conv_id=conv_id)
    path = _kickoff_path(run["id"])
    store.write_text_file(path, text or "")
    run["spawn"]["text_file"] = str(path)
    with store.mutate(rd.QUEUE, rd.queue_default()) as data:
        data.setdefault("runs", []).append(run)
    return run


def register(app):

    @app.route("/api/runqueue/headroom")
    def runqueue_headroom():
        """Memory + queue state, for the 'not enough room' prompt."""
        return jsonify(headroom())

    @app.route("/api/runqueue")
    def runqueue_list():
        """The queue: what's running, what's waiting, and a recent tail of what
        finished. Waiting runs come back in the order the dispatcher would
        actually take them, not the order they were added — the whole point of
        the view is to answer 'when does mine start'."""
        data = store.read(rd.QUEUE, rd.queue_default())
        now = datetime.now()
        waiting = sorted(rd.queued_runs(data),
                         key=lambda r: (rd.effective_rank(r, now),
                                        r.get("queued_at") or "", r.get("id") or ""))
        finished = [r for r in data.get("runs", [])
                    if r.get("status") in ("done", "failed")]
        finished.sort(key=lambda r: r.get("finished") or "", reverse=True)
        return jsonify({
            "running": rd.running_runs(data),
            "queued": waiting,
            "finished": finished[:20],
            "lanes": list(rd.LANES),
            "headroom": headroom(),
        })

    @app.route("/api/runqueue/enqueue", methods=["POST"])
    def runqueue_enqueue():
        """Queue a conversation she chose not to start right now."""
        body = request.get_json(silent=True) or {}
        try:
            run = enqueue_conversation(body.get("conv_id"), body.get("text"))
        except ValueError as e:
            return jsonify({"error": str(e)}), 400
        return jsonify({"ok": True, "run": run})
