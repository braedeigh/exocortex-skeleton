"""runtime_trace.py — one request, followed all the way through, in order.

Plain English: the other two layers answer "what exists" and "what ran lately".
Neither can answer *"I clicked send — where did that actually go?"* That needs
the hops kept in ORDER, with the clock running, for one specific action. This
is that. Arm it, do the thing, read back the path it took.

HOW IT DIFFERS FROM runtime_sensor.py, which looks superficially similar and is
built on the opposite trade:

  - The sensor is ALWAYS ON and cheap, because its callback disables itself
    after one hit. It therefore knows *that* a file ran, never in what order or
    how many times.
  - This is OFF until armed and expensive while running, because it must NOT
    disable — every entry and every exit has to be seen or the tree has holes.
    You pay for it only during the request you asked about.

WHAT A SPAN IS. Not every function call — every **hop between files**. A call
from `routes/observatory.py` into `store.py` is a span; the fifty calls
`observatory.py` makes to its own helpers in between are not. That is a
deliberate ~10-100x reduction, and it is the right one for two reasons: it is
exactly the question being asked ("every single flow that touches one
another"), and it makes a trace's spans the SAME EDGES codegraph.py already
draws — so a captured trace can be laid straight over the map instead of
needing a display of its own.

The caller is the nearest OUR-frame below on the stack, not the immediate
caller. This is the fix for the hole in runtime_sensor's edges: when Flask
dispatches a request, the immediate caller is `flask/app.py` and the sensor
records nothing. Here, our shadow stack simply has nothing on it, so the hop is
recorded as an ENTRY — which is both true and the single most useful row in the
trace. And when our code calls a framework helper that calls back into our
code, the hop is attributed to the our-frame that started it rather than being
lost.

FRAME LIFECYCLE, all five events. PY_START and PY_RESUME push; PY_RETURN,
PY_YIELD and PY_UNWIND pop. Generators are why the pair-with-RESUME/YIELD
matters rather than being pedantry: this app streams SSE out of a generator for
the whole length of an agent turn, and a tracer that only understood
call/return would leave that frame on the stack forever and hang every
subsequent hop off it.

COST, and it is real: while a trace is live, monitoring runs with no
de-instrumentation at all, on every Python function in the process — which
under gevent means every greenlet, not only the request being traced. That is
the coverage.py-with-tracing regime, in the 100%+ range rather than the
sensor's 5%. It is bounded by being (a) off by default, (b) armed one request
at a time, and (c) torn down the moment the last live trace ends.

TWO WAYS TO ARM. The one-shot arm (`arm`/`claim`) traces the NEXT request,
whichever it is. A JOURNEY (`arm_journey`, the section at the bottom) opens a
window instead: the browser carries the journey id on every request until the
deadline, each one is recorded as its own child trace, and the browser posts
its own half — clicks, route changes, fetches, with the React component chain
each landed in — as a `<jid>.browser` part. The turn host's continuation nests
under the request that spawned it. One id, the whole press-send-to-reply.

WHEN IT'S ON. The browser (api/journey.ts, "live" mode, on by default) keeps
a journey open for as long as the app is on screen and re-opens one when it
comes back — so the deep trace runs exactly while someone is looking, and
never for the crons, agents and rollovers that run when nobody is. Several
journeys can be open at once (one per visible tab), each its own file under
`trace_journeys/`. Only requests that follow something she DID carry the id;
background polls don't, so they cost nothing and don't clutter the record.

Touches: `sqlstore.py` (v17 rung: `traces`, `trace_spans`), `server.py` (arms
and captures around each request, one-shot or by journey header),
`scripts/turn_host.py` (a trace that starts in the web worker continues in
the turn's own process), `routes/terrain.py` (the endpoints, and the browser
event intake), `frontend/src/api/journey.ts` (the browser's half),
`codestore.py` (repo roots, so spans are keyed the same way the code graph is).

Prompt that produced this file: "Wanting the map and the trace. Please build
it" — the map being codegraph.py + runtime_sensor.py, the trace being this.
Journeys were added on: "I want to see every file involved in processing this
message, from the buttons I click, to the interface hosting it, to the claude
code calls, to where it's stored" — one id across the browser, every request
in the window, and the turn.
"""
import os
import sqlite3
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import codestore
import sqlstore

# A hard stop on one trace's size. A pathological request (a full terrain
# rebuild, an import storm) can hop between files tens of thousands of times,
# and a trace that eats the database to record it has failed at its job. Past
# this the trace keeps its shape — the stack still pushes and pops, so
# durations stay right — but stops adding rows, and says so with `truncated`.
MAX_SPANS = 20_000

# Retention. Traces used to be a debugging artifact (newest 50); with the
# browser keeping a journey open whenever the app is on screen they are THE
# RECORD of what she did, so they're kept by AGE — a week — with a high count
# cap as the backstop against a runaway. Roots only; children go with them.
KEEP_TRACES = 2000
KEEP_DAYS = 7

# Tool id, distinct from runtime_sensor's. Both may monitor at once — PEP 669
# supports several tools — but they must not share an id, and this one is
# tried first so the two settle into different slots on a normal boot.
_CANDIDATE_TOOL_IDS = (4, 3)

# The tracer itself is never part of what it measures. Without this, the
# teardown hook that ENDS a trace shows up as the last three hops inside it —
# a measurement artifact sitting in the record it produced.
_SELF = os.path.abspath(__file__)

_EXCLUDE_PARTS = ("/venv/", "/.venv/", "/site-packages/", "/node_modules/",
                  "/__pycache__/", "/.git/")

# ...and neither are the request hooks that switch it on and off. They live in
# server.py, which IS ours, so they can't be excluded by file — but `_trace_end`
# runs while the trace is still recording and would otherwise be the final hop
# of every single trace ever taken. Matched on qualname, which is exact.
_SELF_FUNCS = frozenset(("_trace_begin", "_trace_end"))

# THE ACTIVE TRACE, per greenlet. `threading.local` is patched by gevent into a
# greenlet-local (verified on this install), which is exactly what's needed:
# monitoring is global to the interpreter, so the callback fires for every
# greenlet in the worker, and this is what tells it whose call it is looking at.
# Without it, two concurrent requests would braid into one meaningless tree.
_local = threading.local()

_lock = threading.Lock()
_state = {"tool_id": None, "live": 0, "roots": None}

# filename -> (repo, relpath) or None. Resolving a path is several syscalls'
# worth of string work and the callback runs on every function entry in the
# process, so it is done once per file per process and never again.
_path_cache = {}


def _now_iso():
    # Milliseconds, not seconds: a journey's parts (browser, several requests,
    # a turn) are ordered by this column, and two requests in one second is
    # the normal case, not the edge case.
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def _roots():
    if _state["roots"] is None:
        _state["roots"] = tuple((r["id"], str(Path(r["root"]).resolve()))
                                for r in codestore.default_repos())
    return _state["roots"]


def configure(roots):
    """Point the tracer at explicit (repo_id, root) pairs and drop the resolved
    path cache. For tests, and for any caller that knows better than
    codestore's default pair."""
    _state["roots"] = tuple((rid, str(Path(root).resolve())) for rid, root in roots)
    _path_cache.clear()


def _resolve(filename):
    """(repo, relpath) for one of ours, else None. Memoized — see _path_cache."""
    hit = _path_cache.get(filename, False)
    if hit is not False:
        return hit
    out = None
    if (filename and filename[0] == "/" and filename != _SELF
            and not any(p in filename for p in _EXCLUDE_PARTS)):
        for repo_id, root in _roots():
            if filename.startswith(root + "/"):
                out = (repo_id, filename[len(root) + 1:])
                break
    _path_cache[filename] = out
    return out


class Trace:
    """One request's path. Built by the callbacks, saved by `finish`."""

    def __init__(self, trace_id, label, entry, kind, parent_id=None):
        self.id = trace_id
        self.label = label
        self.entry = entry
        self.kind = kind
        self.parent_id = parent_id
        self.started_at = _now_iso()
        self.t0 = time.perf_counter_ns()
        self.spans = []
        self.stack = []
        self.truncated = False

    def _us(self):
        return (time.perf_counter_ns() - self.t0) // 1000

    def push(self, code):
        """A frame of ours started (or resumed). Emits a span only when the
        FILE changed — a call inside one file is stack bookkeeping, not a
        flow."""
        where = _resolve(code.co_filename)
        if where is None or code.co_qualname in _SELF_FUNCS:
            return          # not ours: never on the stack, so it can't be a parent
        repo, path = where
        caller = self.stack[-1] if self.stack else None
        index = None
        if caller is None or caller[2] != path or caller[1] != repo:
            if len(self.spans) < MAX_SPANS:
                index = len(self.spans)
                self.spans.append({
                    "seq": index,
                    "depth": len(self.stack),
                    # No caller on the stack means the call came from outside
                    # our code entirely — the framework, or the interpreter.
                    # That is an ENTRY, and it is the row that answers "where
                    # does this request actually get in".
                    "src_repo": caller[1] if caller else None,
                    "src": caller[2] if caller else None,
                    "src_func": caller[3] if caller else None,
                    "dst_repo": repo,
                    "dst": path,
                    "dst_func": code.co_qualname,
                    "t0_us": self._us(),
                    "t1_us": None,
                })
            else:
                self.truncated = True
        self.stack.append((code, repo, path, code.co_qualname, index))

    def pop(self, code):
        """A frame of ours ended (returned, yielded, or unwound).

        Tolerant on purpose: if the top isn't the frame being closed, the stack
        is searched downward and unwound to it. A monitoring stream can be made
        to look inconsistent by things this tracer doesn't model (a C-level
        throw into a generator, an interpreter fast path), and the honest
        response is to resynchronize rather than to let every later span hang
        off a parent that already returned."""
        for depth in range(len(self.stack) - 1, -1, -1):
            if self.stack[depth][0] is code:
                stamp = self._us()
                for frame in self.stack[depth:]:
                    if frame[4] is not None:
                        self.spans[frame[4]]["t1_us"] = stamp
                del self.stack[depth:]
                return
        # Never opened here (the trace began mid-frame) — nothing to close.


def current():
    return getattr(_local, "trace", None)


# --- the monitoring hooks ------------------------------------------------------

def _install(tool_id):
    mon = sys.monitoring
    events = mon.events

    def _push(code, *_rest):
        trace = getattr(_local, "trace", None)
        if trace is not None:
            trace.push(code)

    def _pop(code, *_rest):
        trace = getattr(_local, "trace", None)
        if trace is not None:
            trace.pop(code)

    mon.register_callback(tool_id, events.PY_START, _push)
    mon.register_callback(tool_id, events.PY_RESUME, _push)
    mon.register_callback(tool_id, events.PY_RETURN, _pop)
    mon.register_callback(tool_id, events.PY_YIELD, _pop)
    mon.register_callback(tool_id, events.PY_UNWIND, _pop)
    mon.set_events(tool_id, events.PY_START | events.PY_RESUME
                   | events.PY_RETURN | events.PY_YIELD | events.PY_UNWIND)


def _arm_monitoring():
    """Turn instrumentation on for the whole process, refcounted by how many
    traces are live. The refcount is what keeps two overlapping traces from
    tearing each other's instrumentation down."""
    with _lock:
        _state["live"] += 1
        if _state["tool_id"] is not None:
            return True
        for tool_id in _CANDIDATE_TOOL_IDS:
            try:
                sys.monitoring.use_tool_id(tool_id, "exocortex-trace")
            except ValueError:
                continue
            _state["tool_id"] = tool_id
            _install(tool_id)
            return True
        _state["live"] -= 1
        return False


def _disarm_monitoring():
    with _lock:
        _state["live"] = max(0, _state["live"] - 1)
        if _state["live"] or _state["tool_id"] is None:
            return
        try:
            sys.monitoring.set_events(_state["tool_id"], 0)
            sys.monitoring.free_tool_id(_state["tool_id"])
        except (ValueError, TypeError):
            pass
        _state["tool_id"] = None


def begin(trace_id, label="", entry="", kind="http", parent_id=None):
    """Start recording on THIS greenlet. Returns the Trace, or None if the
    tracer couldn't claim a monitoring slot."""
    if current() is not None:
        return None            # already tracing here; never nest
    if not _arm_monitoring():
        return None
    trace = Trace(trace_id, label, entry, kind, parent_id)
    _local.trace = trace
    return trace


def finish(save=True):
    """Stop recording on this greenlet and persist. Returns the Trace."""
    trace = current()
    if trace is None:
        return None
    _local.trace = None
    _disarm_monitoring()
    # Anything still on the stack when the trace ends is a frame that outlives
    # it (the SSE generator is the real case). Close them at the end rather
    # than leaving t1 null, so every span has a duration.
    stamp = trace._us()
    for span in trace.spans:
        if span["t1_us"] is None:
            span["t1_us"] = stamp
    trace.duration_us = stamp
    if save:
        save_trace(trace)
    return trace


# --- persistence ---------------------------------------------------------------

def save_trace(trace):
    conn = sqlstore.open_db()
    try:
        sqlstore.begin_immediate(conn)
        conn.execute(
            "INSERT OR REPLACE INTO traces (id, label, kind, entry, started_at,"
            " duration_us, span_count, truncated, pid, parent_id)"
            " VALUES (?,?,?,?,?,?,?,?,?,?)",
            (trace.id, trace.label, trace.kind, trace.entry, trace.started_at,
             getattr(trace, "duration_us", 0), len(trace.spans),
             1 if trace.truncated else 0, os.getpid(), trace.parent_id))
        conn.executemany(
            "INSERT INTO trace_spans (trace_id, seq, depth, src_repo, src,"
            " src_func, dst_repo, dst, dst_func, t0_us, t1_us)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            [(trace.id, s["seq"], s["depth"], s["src_repo"], s["src"],
              s["src_func"], s["dst_repo"], s["dst"], s["dst_func"],
              s["t0_us"], s["t1_us"]) for s in trace.spans])
        # Retention, applied on write so nothing else has to remember to.
        # Counted over ROOTS only, and children are dropped with their parent:
        # evicting a turn's half while keeping the send that spawned it would
        # leave a trace that lies about where it ended.
        cutoff = (datetime.now(timezone.utc) - timedelta(days=KEEP_DAYS)).isoformat(
            timespec="milliseconds")
        conn.execute(
            "DELETE FROM traces WHERE parent_id IS NULL AND (started_at < ? OR id NOT IN ("
            "  SELECT id FROM traces WHERE parent_id IS NULL"
            "  ORDER BY started_at DESC, rowid DESC LIMIT ?))",
            (cutoff, KEEP_TRACES))
        # A journey nests two deep (journey -> request -> turn), so one pass
        # would leave the turn behind as an orphan of an orphan. Loop until
        # nothing else falls.
        while conn.execute(
                "DELETE FROM traces WHERE parent_id IS NOT NULL"
                " AND parent_id NOT IN (SELECT id FROM traces)").rowcount:
            pass
        conn.execute(
            "DELETE FROM trace_spans WHERE trace_id NOT IN (SELECT id FROM traces)")
        conn.execute("COMMIT")
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    finally:
        conn.close()


def recent(limit=200):
    conn = sqlstore.open_db()
    conn.row_factory = sqlite3.Row
    try:
        return [dict(r) for r in conn.execute(
            "SELECT id, label, kind, entry, started_at, duration_us, span_count,"
            " truncated FROM traces WHERE parent_id IS NULL"
            " ORDER BY started_at DESC, rowid DESC LIMIT ?", (limit,))]
    finally:
        conn.close()


def _spans_for(conn, trace_id):
    return [dict(r) for r in conn.execute(
        "SELECT seq, depth, src_repo, src, src_func, dst_repo, dst, dst_func,"
        " t0_us, t1_us FROM trace_spans WHERE trace_id = ?"
        " ORDER BY t0_us, seq", (trace_id,))]


def read_trace(trace_id):
    """One trace with its spans in order, plus every continuation under it —
    in another process, another request, or the browser — as its own `parts`
    entry, never spliced into the parent's span list, because the clocks don't
    line up (see the parent_id column).

    `parts` is FLAT and in start order however deep the nesting goes: a journey
    holds requests, a request holds the turn it spawned, and each part carries
    its `parent_id` so a reader can rebuild the nesting if it wants to. Flat is
    what a timeline draws."""
    conn = sqlstore.open_db()
    conn.row_factory = sqlite3.Row
    try:
        head = conn.execute("SELECT * FROM traces WHERE id = ?", (trace_id,)).fetchone()
        if head is None:
            return None
        spans = _spans_for(conn, trace_id)
        parts = []
        frontier = [trace_id]
        while frontier:
            marks = ",".join("?" * len(frontier))
            children = [dict(r) for r in conn.execute(
                f"SELECT * FROM traces WHERE parent_id IN ({marks})"
                " ORDER BY started_at, rowid", frontier)]
            for child in children:
                parts.append({**child, "spans": _spans_for(conn, child["id"])})
            frontier = [c["id"] for c in children]
        parts.sort(key=lambda p: (p["started_at"], p["id"]))
    finally:
        conn.close()
    return {**dict(head), "spans": spans, "parts": parts}


# --- arming across processes ---------------------------------------------------
# The web app runs two gunicorn workers and hands agent turns to a third
# process, so "trace the next request" cannot be a variable in one of them. It
# is a FILE, and claiming it is an atomic unlink: whichever process wins the
# unlink owns the trace, and every other process sees it already gone. That is
# the whole coordination mechanism — no lock, no shared memory, no polling.

def _arm_path():
    import store
    return store.DATA_DIR / "trace_armed.json"


def arm(label="", kind="http"):
    """Ask for the next request to be traced. Returns the id it will carry."""
    import json
    import store
    trace_id = f"t-{int(time.time() * 1000):x}"
    path = _arm_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"id": trace_id, "label": label, "kind": kind,
                                "armed_at": _now_iso()}), encoding="utf-8")
    return trace_id


def disarm():
    try:
        _arm_path().unlink()
        return True
    except OSError:
        return False


def armed():
    """The pending arm request without consuming it, or None."""
    import json
    try:
        return json.loads(_arm_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def claim():
    """Take the arm if there is one, atomically. Exactly one caller in one
    process can win; everybody else gets None.

    The unlink is the claim. Reading first and deleting after would let both
    workers read the same arm and trace the same id twice."""
    import json
    path = _arm_path()
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError:
        return None                 # nothing armed — the common case, one syscall
    try:
        path.unlink()
    except OSError:
        return None                 # another process got there first
    try:
        return json.loads(raw)
    except ValueError:
        return None


# --- a journey: many requests, one id ------------------------------------------
# The one-shot arm above traces the NEXT request, whichever it is. That answers
# "what did this endpoint do" and cannot answer "what happened when I pressed
# send" — a press is a click in the browser, a POST, a turn in another process,
# a stream request that lasts the whole reply, and half a dozen polls, and the
# arm is spent on the first of them.
#
# A journey is a WINDOW instead of a shot. Arming one writes an id and a
# deadline; the browser carries that id on every request it makes until the
# deadline (`X-Journey-Id`), and server.py records each such request as its
# own child trace under the journey. The browser's own half — clicks, route
# changes, the fetches themselves, with the React component chain each landed
# in — arrives afterwards through `save_browser_part`. The turn host's
# continuation nests one deeper, under the request that spawned it, with no
# change: it already follows whatever trace id the request carried.
#
# The journey row itself has no spans. It is the root the parts hang from, and
# it exists in the table from the moment of arming so that `read_trace` can
# find it while the window is still open.

JOURNEY_DEFAULT_SEC = 90
# An hour: live mode opens one journey per visible stretch and rolls over.
JOURNEY_MAX_SEC = 3600


def _journeys_dir():
    import store
    return store.DATA_DIR / "trace_journeys"


def _journey_path(jid):
    return _journeys_dir() / f"{jid}.json"


def arm_journey(label="", seconds=JOURNEY_DEFAULT_SEC):
    """Open a journey window. Returns {id, label, armed_at, until, seconds}.
    Several can be open at once — one per visible tab, when the browser is
    in live mode — each its own file, so nothing here needs a lock."""
    import json
    seconds = max(5, min(int(seconds or JOURNEY_DEFAULT_SEC), JOURNEY_MAX_SEC))
    now = time.time()
    jid = f"j-{int(now * 1000):x}-{os.getpid() & 0xffff:x}"
    rec = {"id": jid, "label": label, "armed_at": _now_iso(),
           "until": now + seconds, "seconds": seconds}
    root = Trace(jid, label, entry="journey", kind="journey")
    root.duration_us = 0
    save_trace(root)
    d = _journeys_dir()
    d.mkdir(parents=True, exist_ok=True)
    _journey_path(jid).write_text(json.dumps(rec), encoding="utf-8")
    return rec


def _read_journey(path):
    import json
    try:
        rec = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(rec, dict) or not rec.get("id"):
        return None
    if time.time() > float(rec.get("until") or 0):
        end_journey(rec["id"])
        return None
    return rec


def open_journey(jid):
    """One open journey by id, or None. Expired on sight is closed."""
    if not jid or "/" in jid or not jid.startswith("j-"):
        return None
    return _read_journey(_journey_path(jid))


def open_journeys():
    """Every open journey, newest first. Sweeps expired ones as it goes."""
    try:
        paths = list(_journeys_dir().glob("j-*.json"))
    except OSError:
        return []
    out = [r for r in (_read_journey(p) for p in paths) if r]
    out.sort(key=lambda r: r["armed_at"], reverse=True)
    return out


def journey():
    """The newest open journey, or None — the one-at-a-time view the older
    callers and tests expect."""
    recs = open_journeys()
    return recs[0] if recs else None


def end_journey(jid=None):
    """Close one window (or the newest, when no id is given). The root's
    duration becomes the time it was open."""
    import json
    if jid is None:
        cur = journey()
        if cur is None:
            return False
        jid = cur["id"]
    path = _journey_path(jid)
    try:
        rec = json.loads(path.read_text(encoding="utf-8"))
        path.unlink()
    except (OSError, ValueError):
        return False
    try:
        armed = datetime.fromisoformat(rec["armed_at"])
        dur_us = int((datetime.now(timezone.utc) - armed).total_seconds() * 1e6)
        dur_us = min(dur_us, int(rec.get("seconds", JOURNEY_MAX_SEC)) * 1_000_000)
        conn = sqlstore.open_db()
        try:
            conn.execute("UPDATE traces SET duration_us = ? WHERE id = ?",
                         (max(0, dur_us), rec["id"]))
            conn.commit()
        finally:
            conn.close()
    except (KeyError, ValueError, TypeError, sqlite3.Error):
        pass
    return True


_req_seq = [0]


def prune_empty(grace_sec=30):
    """Drop CLOSED journeys that nothing ever landed in — a tab shown and
    hidden again — once they're past the grace the browser's trailing flush
    gets. Not at close time: the browser's last batch of events can arrive
    a beat after its close beacon, and a journey deleted in between would
    turn that batch into a 404. Called from the list endpoint, so the record
    tidies itself whenever it's looked at."""
    open_ids = {r["id"] for r in open_journeys()}
    cutoff = (datetime.now(timezone.utc) - timedelta(seconds=grace_sec)).isoformat(
        timespec="milliseconds")
    conn = sqlstore.open_db()
    try:
        rows = conn.execute(
            "SELECT id FROM traces WHERE kind = 'journey' AND parent_id IS NULL"
            " AND started_at < ? AND id NOT IN (SELECT DISTINCT parent_id FROM traces"
            " WHERE parent_id IS NOT NULL)", (cutoff,)).fetchall()
        doomed = [r[0] for r in rows if r[0] not in open_ids]
        if doomed:
            conn.executemany("DELETE FROM traces WHERE id = ?", [(d,) for d in doomed])
            conn.commit()
    finally:
        conn.close()
    return len(doomed)


def journey_request_id(jid):
    """A fresh child id for one request inside a journey. Two workers can be
    serving two of its requests at once (so the pid is in the name), and one
    worker can start two in the same millisecond — a page load fires a dozen
    fetches at once — so a per-process counter is too. Without it, two
    requests born in the same ms shared an id and the second silently
    replaced the first."""
    _req_seq[0] += 1
    return f"{jid}.r{int(time.time() * 1000):x}-{os.getpid():x}-{_req_seq[0]:x}"


def claim_for_header(header_id):
    """The journey record if `header_id` names an OPEN journey, else None.
    Cheap: no header, no work; a header is one open() of that journey's own
    file."""
    if not header_id:
        return None
    return open_journey(str(header_id)[:64])


# --- the browser's half ----------------------------------------------------------
# The browser reports what it did as a list of events, each with a start and
# end in milliseconds from the moment it learned the journey was armed. They
# are stored as spans on ONE part per journey, id `<jid>.browser`, so the
# viewer meets them in the same shape as every other part. Column meaning for
# a browser span:
#   src        the React component chain the event landed in (outermost last),
#              joined with " < "; None for a route change
#   src_func   the event kind: click | key | route | fetch
#   dst_repo   the repo the component's file was resolved into, or 'browser'
#              when nothing could be resolved
#   dst        that file's repo-relative path, or the URL path for a fetch, or
#              the route pathname for a route change
#   dst_func   a short human label: button text, "POST /api/...", the route
# `resolve(component_name)` is supplied by the caller (routes/terrain.py) and
# maps a component name to (repo, path) via the code graph, or None.

BROWSER_MAX_EVENTS = 2000


def save_browser_part(jid, events, started_at, resolve=None):
    """Append browser events to the journey's browser part. Idempotent per
    batch only in the sense that seq continues from what's stored; the browser
    posts each event once."""
    conn = sqlstore.open_db()
    try:
        sqlstore.begin_immediate(conn)
        pid_id = f"{jid}.browser"
        row = conn.execute("SELECT span_count FROM traces WHERE id = ?", (pid_id,)).fetchone()
        seq = int(row[0]) if row else 0
        if row is None:
            conn.execute(
                "INSERT INTO traces (id, label, kind, entry, started_at, duration_us,"
                " span_count, truncated, pid, parent_id) VALUES (?,?,?,?,?,?,?,?,?,?)",
                (pid_id, "", "browser", "browser", started_at, 0, 0, 0, None, jid))
        rows = []
        truncated = 0
        last_end = 0
        for ev in events:
            if not isinstance(ev, dict):
                continue
            if seq >= BROWSER_MAX_EVENTS:
                truncated = 1
                break
            kind = str(ev.get("kind") or "")[:16]
            chain = ev.get("components")
            chain = [str(c)[:80] for c in chain if isinstance(c, str)][:8] \
                if isinstance(chain, list) else []
            src = " < ".join(chain) if chain else None
            where = None
            if resolve is not None and chain:
                for name in chain:
                    where = resolve(name)
                    if where:
                        break
            if kind == "fetch":
                dst_repo, dst = "browser", str(ev.get("path") or "")[:200]
            elif where:
                dst_repo, dst = where
            else:
                dst_repo, dst = "browser", str(ev.get("path") or (chain[0] if chain else ""))[:200]
            t0 = max(0, int(ev.get("t0_ms") or 0)) * 1000
            t1 = ev.get("t1_ms")
            t1 = max(t0, int(t1) * 1000) if isinstance(t1, (int, float)) else None
            rows.append((pid_id, seq, 0, "browser", src, kind, dst_repo, dst,
                         str(ev.get("label") or "")[:200], t0, t1))
            last_end = max(last_end, t1 if t1 is not None else t0)
            seq += 1
        conn.executemany(
            "INSERT INTO trace_spans (trace_id, seq, depth, src_repo, src, src_func,"
            " dst_repo, dst, dst_func, t0_us, t1_us) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            rows)
        conn.execute(
            "UPDATE traces SET span_count = ?, truncated = MAX(truncated, ?),"
            " duration_us = MAX(duration_us, ?) WHERE id = ?",
            (seq, truncated, last_end, pid_id))
        conn.execute("COMMIT")
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    finally:
        conn.close()
    return seq
