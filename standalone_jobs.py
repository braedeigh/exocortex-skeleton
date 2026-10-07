"""The desktop app's own clock: the timed jobs cron runs on the live site, run
from inside the app instead.

**What this does, in plain English.** On the live site about a dozen cron
lines keep the Observatory and Terrain current — a once-a-minute heartbeat
that delivers waiting messages and notices dead turns, an hourly pass that
works out which files each session touched, and so on. A downloaded app has no
cron. So this file is a very small cron of its own: a list of jobs (`JOBS`),
each with how often it runs, and one background thread (`Scheduler`) that
starts whichever are due.

Each job runs as its own short process — the same script cron would have run,
with the same environment the server has — so a job that crashes or leaks
can't hurt the server, and the scripts themselves needed no changes. Jobs run
one at a time, never overlapping. Every job also runs once shortly after the
app starts, so a window opened for ten minutes still gets the hourly ones.

Only one server per data folder runs the jobs: `Scheduler.start` takes a lock
file in the data folder, and a second server on the same folder leaves the
clock to the first.

The minute heartbeat is `minute_tick` here rather than the live site's
`scripts/coming_up_dispatcher.py`, because that script also runs things the
desktop app doesn't have (journal reminders, the Linear feed) and things that
spend the person's Claude usage unasked (the helpers), which here wait behind
`config.standalone_helpers()`.

Touches: `scripts/*.py` (the jobs), `routes/observatory.py` (the heartbeat's
steps), `scripts/standalone.py` (starts the scheduler), `config.py` (the
helpers switch), `docs/standalone.md`.

Prompt that produced this file: "with the cron jobs those two need run from
inside the app on a timer".
"""
from pathlib import Path
import fcntl
import os
import signal
import subprocess
import sys
import threading
import time

ROOT = Path(__file__).resolve().parent

MINUTE = 60
HOUR = 3600

# The jobs: (name, seconds between runs, command after the python program,
# needs the helpers switch). The cadences are the live crontab's.
JOBS = (
    # The heartbeat: mailbox, dead turns, done sessions, interrupted jobs.
    ("heartbeat", MINUTE, ["-m", "standalone_jobs", "minute"], False),
    # The run queue: starts a waiting session when there is memory for it.
    ("run queue", MINUTE, ["scripts/run_dispatcher.py"], False),
    # Which files each session touched — Terrain's session orbs read this.
    ("footprints", HOUR, ["scripts/extract_footprints.py"], False),
    # Commit history and the session tables in the database.
    ("code history", HOUR, ["scripts/update_code_history.py"], False),
    # Tool calls, finished turns and the chat search index.
    ("tool calls", HOUR, ["scripts/usage_events.py"], False),
    # Slash commands the person ran — Terrain's Commands room.
    ("commands", HOUR, ["scripts/command_rollup.py"], False),
    # The journal's cards, copied into the database for search.
    ("journal cards", HOUR, ["scripts/update_cards.py"], False),
    # What the runs cost, folded into per-day totals.
    ("usage ledger", HOUR, ["scripts/usage_ledger.py"], False),
    # Names and files each new session with a small Claude call of its own.
    ("session titles", HOUR, ["scripts/sort_bot_chats.py"], True),
)

# How long after the app starts the first job runs, and the gap between the
# first runs of the rest, so they don't all land on the same second.
FIRST_RUN_AFTER_SEC = 5
STAGGER_SEC = 3
# The longest one job may run before it is stopped.
JOB_TIMEOUT_SEC = 600
# How often the scheduler looks for a due job.
POLL_SEC = 2


def minute_tick(helpers=None):
    """The once-a-minute heartbeat, as the desktop app runs it. Returns
    {step name: what it did, or the error it raised}.

    Every step is tried even if an earlier one fails — the same rule the live
    site's dispatcher follows, for the same reason: a broken mailbox must not
    stop dead turns from being noticed."""
    import config
    from routes import observatory
    from scripts import run_detached
    if helpers is None:
        helpers = config.standalone_helpers()

    def _file_overlaps():
        import file_alerts
        return file_alerts.tick()

    def _watches():
        import watches
        return watches.tick()

    def _swarm_helpers():
        import swarm_helper
        return swarm_helper.tick()

    def _room_helper():
        import room_helper
        return room_helper.tick()

    def _helper_wake():
        import helper_chat
        return helper_chat.wake_tick()

    steps = [
        # Messages waiting for a session that has gone idle start its turn.
        ("mailbox", observatory.drain_all_inbox),
        # A turn whose process died is marked failed, so its card turns red.
        ("dead turns", observatory.mark_dead_turns),
        # A finished session whose countdown ran out is closed.
        ("done sessions", observatory.close_done_sessions),
        # A follow-up still waiting on an idle session (a finished background
        # job's result, an approval's retry) is started.
        ("follow-ups", observatory.drain_all_followups),
        # A background job whose watcher died wakes its session to say so.
        ("interrupted jobs", run_detached.sweep),
        # Two open sessions in the same file are written down, once.
        ("file overlaps", _file_overlaps),
    ]
    if helpers:
        steps += [
            ("watches", _watches),
            ("swarm helpers", _swarm_helpers),
            ("room helper", _room_helper),
            ("helper wake-up", _helper_wake),
        ]
    # A session idle for a day is asked whether it is done — on unless the
    # person switched it off in the app.
    import standalone_app
    import standalone_journal
    if standalone_app.idle_check():
        steps.append(("idle check", observatory.idle_check_sessions))
    # The Keeper's day closes and a fresh Keeper opens, once a night after
    # 3am — on unless the person switched it off. The step itself decides
    # whether tonight's is due.
    steps.append(("keeper rollover", standalone_journal.start_rollover))
    done = {}
    for name, step in steps:
        try:
            done[name] = step()
        except Exception as error:
            done[name] = f"failed: {error!r}"
    return done


# The job that is running right now, if any — so stopping the app can stop it.
_running_job = None


def _stop_process_group(process):
    """End a job and anything it started. Each job is the leader of its own
    process group, so one signal to the group reaches them all."""
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        pass


def run_job(command, timeout=JOB_TIMEOUT_SEC):
    """Run one job as its own process and return its exit code (-1 if it
    couldn't start or ran past its time). Its output goes to the server's
    stderr, which is where the desktop window keeps the log."""
    global _running_job
    try:
        process = subprocess.Popen(
            [sys.executable, *command], cwd=str(ROOT), stdin=subprocess.DEVNULL,
            stdout=sys.stderr, stderr=sys.stderr, start_new_session=True)
    except OSError:
        return -1
    _running_job = process
    try:
        return process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        _stop_process_group(process)
        return -1
    finally:
        _running_job = None


def stop_running_job():
    """Stop the job that is running, if one is. Called when the app stops:
    without it an hourly job caught mid-run would carry on with no app
    behind it."""
    process = _running_job
    if process is not None and process.poll() is None:
        _stop_process_group(process)


class Scheduler:
    """Runs each job when it is due, one at a time, on a background thread.

    `clock` and `runner` are parameters so a test can drive it with a made-up
    time and a runner that only records what it was asked to run."""

    def __init__(self, jobs=JOBS, helpers=False, clock=time.monotonic, runner=run_job):
        self.clock = clock
        self.runner = runner
        self.runs = {}        # job name -> how many times it has run
        self.last_exit = {}   # job name -> its last exit code
        self._stop = threading.Event()
        self._lock_file = None
        now = clock()
        # Leave out the jobs that need the helpers switch when it is off, and
        # give every other job its first run a few seconds from now.
        self.jobs = []
        for name, every, command, needs_helpers in jobs:
            if needs_helpers and not helpers:
                continue
            due = now + FIRST_RUN_AFTER_SEC + STAGGER_SEC * len(self.jobs)
            self.jobs.append({"name": name, "every": every, "command": list(command),
                              "due": due})

    def run_pending(self):
        """Run every job that is due right now, in list order. Returns the
        names it ran. The next run is counted from when this one FINISHED, so
        a slow job can never queue up behind itself."""
        ran = []
        for job in self.jobs:
            if self._stop.is_set() or self.clock() < job["due"]:
                continue
            self.last_exit[job["name"]] = self.runner(job["command"])
            self.runs[job["name"]] = self.runs.get(job["name"], 0) + 1
            job["due"] = self.clock() + job["every"]
            ran.append(job["name"])
        return ran

    def _loop(self):
        while not self._stop.wait(POLL_SEC):
            self.run_pending()

    def start(self, data_dir):
        """Start the clock unless another server on this data folder already
        runs it. True when this one is running the jobs.

        The lock is held for as long as this process lives and the operating
        system lets go of it the instant the process ends, however it ends."""
        lock_file = open(Path(data_dir) / "standalone_jobs.lock", "a")
        try:
            fcntl.flock(lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            lock_file.close()
            return False
        self._lock_file = lock_file
        threading.Thread(target=self._loop, daemon=True, name="standalone-jobs").start()
        return True

    def stop(self):
        self._stop.set()
        stop_running_job()
        if self._lock_file is not None:
            self._lock_file.close()
            self._lock_file = None


if __name__ == "__main__":
    # `python -m standalone_jobs minute` — the heartbeat, as its own process.
    if sys.argv[1:] == ["minute"]:
        for step_name, outcome in minute_tick().items():
            if outcome:
                print(f"{time.strftime('%Y-%m-%d %H:%M:%S')} heartbeat: {step_name}: {outcome}",
                      file=sys.stderr)
        sys.exit(0)
    print("usage: python -m standalone_jobs minute", file=sys.stderr)
    sys.exit(2)
