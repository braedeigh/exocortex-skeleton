"""What the scheduled jobs actually did — the system's event memory.

**The problem this solves.** This box runs ~19 scheduled jobs. Before this
file, four of them wrote a single "here's how the last run went" line into
`data/scheduled_runs.json` (overwritten every run, no history) and the other
fifteen wrote to `.log` text files that nothing parses. One of those logs,
`prompt_dispatcher.log`, has been zero bytes since July 7 while the job behind
it ran about 43,000 times — from its own record you cannot tell "fine, nothing
due" from "cron has been broken for a month."

So the system stored its STATE and threw away its DECIDING. "322 of 1,119
journal cards carry no tag" was answerable from the `cards` table. "Did the
2 AM cricket swarm run on July 17th — and did it look at those 35 cards and
decline them, or error on them, or never wake up at all?" was not, and those
are three different problems with three different fixes. This module is the
missing half.

**This table is not derived, and that makes it different from every other one
in exo.db.** `cards` can be re-walked from the vault's markdown, `commits`
from git, `todos` from a JSON blob. A job run is an event that happened once;
when it's over the only evidence it existed is the row it wrote. Two
consequences, both load-bearing:

  - `job_runs` must NEVER be added to routes/sqlab.py's rebuild button.
  - `export_day()` writes a JSON mirror per sealed day under `data/job_runs/`,
    so the vault's hourly git commit is a real backup. (`usage_rollup.py`'s
    `seal_yesterday()` calls it at 02:30 for yesterday, and only prunes if that
    export returned — the ordering is what makes RETENTION_DAYS safe rather
    than a six-month fuse. Today's rows live only in SQLite until then: a disk
    loss before 02:30 costs up to one day of provenance. That gap is deliberate
    and cheap; it is not an oversight.)

**Recording can never break the job.** Every database call here is wrapped and
swallowed, the same rule store.py's op counters follow (store.py:313-329) and
for the same reason: a job that stops running because its bookkeeping failed
is far worse than a job with a missing row. An exception raised by the job's
own work still propagates untouched — that failure is real and gets recorded
on the way past.

Usage — the whole API is one context manager:

    import jobstore

    with jobstore.run("cricket_swarm") as r:
        r.looked(40)
        r.acted(5)
        r.failed(3, "cricket 'threads' errored")

The status writes itself: an exception is `failed`, any `failed()` count is
`failed`, any `acted()` count is `ok`, and anything else is `noop`. A job that
stands down because its Automations toggle is off calls `r.skip("disabled")`,
which is `skipped` — deliberately NOT a failure.

Touches: `sqlstore.py` (owns the schema — the v10 rung — and the connection
factory), `store.py` (DATA_DIR for the mirror, and the scheduled_runs.json
registry), `routes/automations.py` (serves the registry `_touch_registry` keeps
current), and `filerstore.py`, which follows the same not-derived/mirror-or-lose-it
rules for the filer's provenance tables.

**What is wired, honestly.** `scripts/usage_rollup.py` is the first and so far
the ONLY job that runs under this ledger, and it is also the one that seals the
day (`seal_yesterday`: mirror, then prune — in that order). The other ~18
scheduled jobs still write text logs nothing parses; each is a two-line change
to bring in, and until then `job_runs` speaks only for the rollup. There is no
read API and no shell-script CLI yet — a job written in bash has no door into
this table at present.

Prompt that produced this file: "most of the system's judgments leave no trace
of having been made — build one table: what ran, when, what it looked at, what
it decided, what it skipped, what it failed on, and wire the cron jobs to it."
"""
from contextlib import contextmanager
from datetime import datetime, timedelta
import json
import traceback

import sqlstore
import store

# How long a run's history survives before prune() drops it. Six months is
# long enough to answer "was this stretch of bad runs a one-off or a pattern"
# across a season, and at ~350 rows a day that's ~65k rows — a few megabytes.
RETENTION_DAYS = 180

# Where export_day() writes the JSON mirrors, under the data dir.
MIRROR_DIR = "job_runs"

# Longest a `note` may be. A note is one human line, not a stack trace; an
# exception's text gets truncated to this rather than pouring a whole traceback
# into a column something will eventually try to render in a table cell.
_NOTE_MAX = 500


def _now():
    """This system's clock: LOCAL, naive, second resolution.

    Every timestamp this module writes uses it, matching `cards.ts`,
    `session_turns.ts` and `commits.authored_at`. Deliberately not UTC:
    `session_files.last` is UTC and the mismatch between those two is what
    draws a day's work five hours off the axis while looking entirely
    plausible (see codestore.local_iso, which exists to clean up exactly
    that).
    """
    return datetime.now().replace(microsecond=0).isoformat(sep="T")


def _hour_floor(iso):
    """The clock hour an ISO timestamp falls in — the no-op collapsing key."""
    return iso[:13]  # 'YYYY-MM-DDTHH'


def _clip(text):
    if text is None:
        return None
    text = str(text).strip()
    return text[:_NOTE_MAX] if text else None


class Recorder:
    """The handle a job holds while it runs. Counters accumulate; the status
    is worked out at close. Every method is safe to call any number of times,
    and safe never to call at all — a job that reports nothing is a `noop`,
    which is a true statement about it."""

    def __init__(self, job):
        self.job = job
        self.row_id = None
        self._looked = None
        self._acted = None
        self._failed = None
        self._note = None
        self._detail = None
        self._skipped = False

    # --- what the job decided -------------------------------------------
    def looked(self, n=1):
        """Things considered. Does NOT promote a run out of `noop`: a
        dispatcher that examines three queued runs every minute and admits
        none of them has still done nothing, and collapsing those is the whole
        point of the heartbeat."""
        self._looked = (self._looked or 0) + int(n)

    def acted(self, n=1):
        """Things actually changed. This is what makes a run `ok`."""
        self._acted = (self._acted or 0) + int(n)

    def failed(self, n=1, note=None):
        """Things this run errored on. Any count here makes the run `failed`
        even if it also acted — a swarm that tagged 5 cards and blew up on 35
        is not a success, and reading it as one is how the July 16-24 gap went
        unnoticed for three weeks."""
        self._failed = (self._failed or 0) + int(n)
        if note and not self._note:
            self._note = _clip(note)

    def note(self, text):
        """One human line, shown beside the run. Last writer wins."""
        self._note = _clip(text)

    def detail(self, obj):
        """Optional structured payload for what the three counters can't
        carry. Stored as JSON text; nothing queries it yet."""
        try:
            self._detail = json.dumps(obj, ensure_ascii=False, default=str)[:4000]
        except Exception:
            self._detail = None

    def skip(self, why=None):
        """Stood down deliberately — almost always the Automations `enabled`
        toggle being off. Recorded as `skipped`, never `failed`: a job you
        turned off is doing what you asked."""
        self._skipped = True
        if why:
            self._note = _clip(why)

    # --- the status, worked out rather than declared ---------------------
    def _status(self, exc):
        if exc is not None:
            return "failed"
        if self._skipped:
            return "skipped"
        if self._failed:
            return "failed"
        if self._acted:
            return "ok"
        return "noop"


@contextmanager
def run(job):
    """Record one run of `job`. See the module docstring for the whole story.

    The row is written at START, not at finish, and that is the point: a run
    that dies — OOM, a killed cgroup, the box rebooting — leaves a `running`
    row with a NULL `finished`, which is the only way a job that never came
    back can announce itself. A recorder that only wrote on success would be
    blind to exactly the failures this table exists to catch.
    """
    rec = Recorder(job)
    rec.row_id = _open(job)
    try:
        yield rec
    except BaseException as exc:
        _close(rec, exc)
        raise
    else:
        _close(rec, None)


def _open(job):
    """Insert the `running` row, return its id (or None if recording failed —
    every later step tolerates a None id)."""
    try:
        conn = sqlstore.open_db()
        try:
            cur = conn.execute(
                "INSERT INTO job_runs (job, started, status) VALUES (?, ?, 'running')",
                (job, _now()),
            )
            return cur.lastrowid
        finally:
            conn.close()
    except Exception:
        return None


def _close(rec, exc):
    """Finish the run: set the status and counters, or collapse it onto this
    hour's heartbeat if it was a no-op. Swallows everything."""
    try:
        status = rec._status(exc)
        note = rec._note
        if exc is not None and not note:
            # The exception type and message, never the whole traceback — this
            # column gets rendered in a table cell.
            note = _clip("".join(
                traceback.format_exception_only(type(exc), exc)).strip())
        finished = _now()

        conn = sqlstore.open_db()
        inserted = True
        try:
            sqlstore.begin_immediate(conn)
            if status == "noop":
                # Collapse onto an existing no-op heartbeat for this job in
                # this clock hour, if there is one: bump its tick count and
                # move its `finished` forward. Three jobs run every minute and
                # do nothing on almost every tick; a row each would be ~1.5M
                # rows a year of noise around the few thousand that matter.
                prior = conn.execute(
                    "SELECT id, ticks FROM job_runs"
                    " WHERE job = ? AND status = 'noop' AND started LIKE ?"
                    " ORDER BY id DESC LIMIT 1",
                    (rec.job, _hour_floor(finished) + "%"),
                ).fetchone()
                if prior is not None:
                    conn.execute(
                        "UPDATE job_runs SET ticks = ?, finished = ? WHERE id = ?",
                        ((prior[1] or 1) + 1, finished, prior[0]),
                    )
                    # The `running` row this call opened is now redundant —
                    # the heartbeat stands for it.
                    if rec.row_id is not None:
                        conn.execute("DELETE FROM job_runs WHERE id = ?", (rec.row_id,))
                    inserted = False
            if inserted:
                if rec.row_id is not None:
                    conn.execute(
                        "UPDATE job_runs SET finished = ?, status = ?, looked = ?,"
                        " acted = ?, failed = ?, note = ?, detail = ? WHERE id = ?",
                        (finished, status, rec._looked, rec._acted, rec._failed,
                         note, rec._detail, rec.row_id),
                    )
                else:
                    # _open() failed (locked database, disk full). Record what
                    # we can rather than losing the run entirely.
                    conn.execute(
                        "INSERT INTO job_runs (job, started, finished, status,"
                        " looked, acted, failed, note, detail)"
                        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                        (rec.job, finished, finished, status, rec._looked,
                         rec._acted, rec._failed, note, rec._detail),
                    )
            conn.execute("COMMIT")
        finally:
            conn.close()

        # Keep the Automations page current — but only when a real row landed.
        # A collapsed no-op tick skips this, so a job that idles all night
        # takes one flock per hour instead of 60. The cost is that `last_run`
        # for a quiet job reads as the top of its heartbeat hour rather than
        # the last minute; `ticks` on the row carries the truth.
        if inserted:
            _touch_registry(rec.job, finished, status)
    except Exception:
        pass


def _touch_registry(job, when, status):
    """Upsert this job's `last_run` / `last_status` into scheduled_runs.json —
    the registry routes/automations.py serves and the scripts read `enabled`
    from.

    Only ever touches those two fields, and seeds `id` / `name` / `enabled`
    for a job that has no entry yet. Never overwrites a `description`,
    `schedule` or `schedule_human` someone wrote by hand, and never invents
    one: a job wired here that nobody has described simply shows up with its
    id, which is honest and is how it gets onto the page at all.
    """
    try:
        with store.mutate("scheduled_runs.json", {"runs": []}) as data:
            runs = data.setdefault("runs", [])
            entry = next((r for r in runs
                          if isinstance(r, dict) and r.get("id") == job), None)
            if entry is None:
                entry = {"id": job, "name": job.replace("_", " ").capitalize(),
                         "enabled": True}
                runs.append(entry)
            entry["last_run"] = when
            entry["last_status"] = status
    except Exception:
        pass


# --- reading it back ------------------------------------------------------

def recent(job=None, since=None, limit=200):
    """Runs newest first, optionally for one job and/or since a local ISO
    timestamp. Read-only and safe to call from a request."""
    sql = ("SELECT id, job, started, finished, status, ticks, looked, acted,"
           " failed, note FROM job_runs")
    where, args = [], []
    if job:
        where.append("job = ?")
        args.append(job)
    if since:
        where.append("started >= ?")
        args.append(since)
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY started DESC, id DESC LIMIT ?"
    args.append(int(limit))
    conn = sqlstore.open_db()
    try:
        cols = ["id", "job", "started", "finished", "status", "ticks",
                "looked", "acted", "failed", "note"]
        return [dict(zip(cols, r)) for r in conn.execute(sql, args).fetchall()]
    finally:
        conn.close()


def summary(days=7):
    """Per job: how it's been going lately, and whether it's stuck.

    `open_runs` counts rows still marked `running` whose start is older than
    `stale_after_min` — a run that opened and never closed. That is the
    silent-failure signal, and it's the number worth putting on a page.
    """
    since = (datetime.now() - timedelta(days=days)).replace(
        microsecond=0).isoformat(sep="T")
    stale = (datetime.now() - timedelta(hours=6)).replace(
        microsecond=0).isoformat(sep="T")
    conn = sqlstore.open_db()
    try:
        rows = conn.execute(
            "SELECT job,"
            "  COUNT(*),"
            "  SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END),"
            "  SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END),"
            "  SUM(CASE WHEN status = 'noop' THEN ticks ELSE 0 END),"
            "  SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END),"
            "  MAX(started),"
            "  SUM(CASE WHEN status = 'running' AND started < ? THEN 1 ELSE 0 END),"
            "  SUM(COALESCE(acted, 0)), SUM(COALESCE(failed, 0))"
            " FROM job_runs WHERE started >= ? GROUP BY job ORDER BY job",
            (stale, since),
        ).fetchall()
        return [{"job": r[0], "runs": r[1], "ok": r[2], "failed": r[3],
                 "noop_ticks": r[4], "skipped": r[5], "last_run": r[6],
                 "open_runs": r[7], "acted": r[8], "errors": r[9]}
                for r in rows]
    finally:
        conn.close()


# --- keeping it small, and backing it up ----------------------------------

def export_day(day):
    """Write one sealed day's runs to data/job_runs/<day>.json — the mirror
    that rides the vault's hourly git backup.

    Called for YESTERDAY, from usage_rollup.py at 02:30, because a sealed day
    never changes again: the file is write-once and the git diff is clean.
    Returns the row count written.
    """
    conn = sqlstore.open_db()
    try:
        cols = ["id", "job", "started", "finished", "status", "ticks",
                "looked", "acted", "failed", "note", "detail"]
        rows = conn.execute(
            f"SELECT {', '.join(cols)} FROM job_runs"
            " WHERE started LIKE ? ORDER BY id",
            (day + "%",),
        ).fetchall()
    finally:
        conn.close()
    out = [dict(zip(cols, r)) for r in rows]
    path = store.DATA_DIR / MIRROR_DIR / f"{day}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    store.write_text_file(path, json.dumps({"day": day, "runs": out},
                                           indent=2, ensure_ascii=False))
    return len(out)


def prune(days=RETENTION_DAYS):
    """Drop runs older than `days`. Returns how many went.

    Safe because export_day() has already mirrored every sealed day into the
    vault — the rows leave the database, not the record.
    """
    cutoff = (datetime.now() - timedelta(days=days)).replace(
        microsecond=0).isoformat(sep="T")
    conn = sqlstore.open_db()
    try:
        sqlstore.begin_immediate(conn)
        cur = conn.execute("DELETE FROM job_runs WHERE started < ?", (cutoff,))
        conn.execute("COMMIT")
        return cur.rowcount
    finally:
        conn.close()
