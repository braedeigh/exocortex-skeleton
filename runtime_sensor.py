"""runtime_sensor.py — which source files this app actually RAN, and which of
them called each other, live.

Plain English: everything else that feeds Terrain answers a question about
HISTORY. Git says which files were edited and when. The bot_chats footprints
say which files an agent opened while it was working. Neither one can tell you
which files were *used* — which code actually executed to serve a click.

This is that sensor. It watches the running Python process and writes down
every source file whose code ran, with a timestamp. Press send in the
Observatory and `server.py`, `routes/observatory.py`, `store.py` and
`scripts/turn_host.py` all light up, because they all ran; a route module for a
page nobody opened stays dark, however recently it was edited.

HOW IT WATCHES. CPython 3.12 ships `sys.monitoring` (PEP 669), which can call
us on entry to any Python function. Calling back on every call would be ruinous
— so the callback records the filename and immediately returns
`sys.monitoring.DISABLE`, which tells the interpreter never to call us for that
exact function again. Each function costs one callback per re-arm window, not
one per call.

That would go silent after the first second, so a background thread re-arms it
(`restart_events()`) on a fixed cycle and writes what it saw. The result is a
SAMPLED signal, and the sampling is what the cycle length means: "this file ran
at least once during this 60-second window". That is exactly the resolution a
heat map with day-and-month half-lives can use, and it is the reason this can
run continuously rather than being switched on to take a reading.

WHAT IT COSTS, measured rather than assumed, because "the callback disables
itself" invites the wrong conclusion. Steady state is NOT free: registering a
global PY_START callback at all takes the interpreter off some of its
specialized call paths, and that residual is paid on every call whether or not
the event is disabled. On a microbenchmark of nothing but function calls (2.8M
calls, no I/O) it measured **+4.9%**. That is the worst case by construction —
real request handling is dominated by JSON, SQLite and the network, so the
share of wall time spent in bare CALL opcodes is a fraction of it — but it is
not nothing, and an install that cares more about latency than about knowing
what ran should set EXOCORTEX_RUNTIME_SENSOR=0. The other two costs are small
and known: `restart_events()` is ~0.02ms, and the cycle's `store.mutate` is
~83ms when it writes, ~2ms when the unchanged-write guard skips it (see
BUCKET_SEC for why it usually skips).

THE EDGES, and the one thing that must not be misread about them. The CALL
event gives caller→callee, so the sensor also records which of our files
actually invoked which — the observed counterpart to codegraph.py's static
import graph. An edge here is proof: that call really happened.

But the ABSENCE of an edge proves nothing, and the reason is structural rather
than a sampling artefact. An edge is only recorded when the IMMEDIATE caller is
also one of ours. Every call that goes through a framework therefore leaves no
edge at all: Flask dispatching a request to a route handler is `flask/app.py`
calling `routes/observatory.py`, and `flask` is not ours, so the flow from the
app into that route is invisible here. Same for anything reached through a
decorator, a callback, a registry, or a C builtin like `map`. Measured on a
real request: three GETs across the roster and the todos API produced five
internal edges, because almost every hop on that path is mediated.

So the two layers answer different halves and neither is redundant.
codegraph.py is COMPLETE and static — it knows `server.py` imports
`routes/observatory.py` whether or not a request ever arrives. This is PARTIAL
and observed — it knows the call happened. Read the runtime edges as evidence
laid over the static map, never as the map.

WHAT IT CANNOT SEE, stated plainly, because a confident signal that is quietly
partial is worse than no signal:
  - Only Python. The browser half of a click — the React that drew the button,
    `api.ts`, `events.ts` — runs in the browser and is invisible here. Nothing
    in this file will ever light a `.tsx` file up.
  - Edges only between two of ours, and only when the caller is the immediate
    one — see above.
  - Only Python that is CALLED. A module whose constants were read at import
    time before the sensor started never registers, even though the app
    genuinely depends on it.
  - Not the agent. The `claude` binary is Node, in its own process; the sensor
    sees `scripts/turn_host.py` hosting it, not the agent's own work.
  - Functions, never lines. The second sidecar (FUNCTIONS_COLLECTION) says
    which FUNCTION ran, because that is what the interpreter hands the callback
    for free. It cannot say which lines inside the function ran: a function
    that was entered counts whole, including the branch it didn't take.
  - It says "ran", not "ran a lot". A file hit once and a file hit ten thousand
    times inside one window are the same entry; `windows` counts the five-minute
    buckets a file appeared in, which is a measure of how OFTEN it is reached
    over time, never of how hard.

Touches:
  - `store.py` — the sidecar is a normal collection, `runtime_use`, written
    through `store.mutate` so two gunicorn workers and any number of turn hosts
    can merge into it without clobbering each other.
  - `server.py` calls `start()` at startup (each gunicorn worker, since the
    service runs without `--preload`), `scripts/turn_host.py` calls it too, so
    a turn's own process is measured as well as the web worker's.
  - `routes/terrain.py` serves it back at GET /api/observatory/terrain/runtime,
    and the per-function half at GET /api/observatory/terrain/file/runs — the
    gold mark in the file pane's gutter.

Prompt that produced this file: "I want the gold to actually be files that were
utilized ... I want a sensor for what I just described" — the described thing
being the whole server-side path of one send, from the route through the spawn
to the stream.
"""
import atexit
import json
import os
import sys
import threading
import time
from pathlib import Path

import store

COLLECTION = "runtime_use"

# Which FUNCTIONS ran, kept apart from the per-file sidecar above.
# A second collection rather than a field on the first: the map reads
# `runtime_use` on every payload build, and one entry per function would make
# that read several times heavier for a detail only an open file pane asks for.
# Shape: {"files": {abspath: {qualname: last_bucket}}}.
FUNCTIONS_COLLECTION = "runtime_use_functions"

# How long a function's "last ran" is kept without being seen again. A renamed
# or deleted function never runs again under its old name, so without this its
# entry would sit in the sidecar forever. Five weeks: just past the month that
# is the longest window the pane can be asked to colour.
FUNCTION_KEEP_SEC = 35 * 86400

# How long a re-arm window is. Everything about the signal's resolution comes
# from this number: a file that ran at any point inside a window gets one
# timestamp for that window, and files that ran are re-armed at the end of it.
# A minute is far finer than the map's shortest half-life (a day) and coarse
# enough that the re-arm's own cost is invisible.
CYCLE_SEC = 60.0

# Recorded timestamps are rounded down to this, so a file that runs on every
# request doesn't get a distinct number every cycle — five minutes of constant
# use is one entry, which is what keeps the sidecar small enough to keep a real
# history in.
#
# It also does the thing that keeps this cheap. EVERYTHING recorded per file is
# bucketed — the timestamp, the ring, and the `windows` count, which counts
# distinct buckets rather than cycles — so a second cycle inside the same bucket
# produces a byte-identical collection, and store.mutate's unchanged-write guard
# drops the write. A busy worker therefore writes once per bucket, not once per
# cycle, without the sensor having to buffer anything or decide anything.
# Measured on this install: the mutate costs ~83ms when it writes and ~2ms when
# the guard skips it, so this is the difference between a 5-minute cadence and a
# 1-minute one, at no cost in how quickly a newly-run file appears.
BUCKET_SEC = 300

# The most bucketed timestamps kept per file. Past this the oldest fall off the
# front, exactly like a ring buffer: the sidecar is a heat source, not an audit
# log, and nothing downstream can use a touch older than the map's longest
# half-life anyway. 50 buckets is over four hours of continuous use, or the
# last 50 separate occasions a rarely-run file ran. `windows` keeps counting
# past the cap, so it stays a true total when the ring has already forgotten.
TOUCH_CAP = 50

# Free tool ids in sys.monitoring: 0 is the debugger, 1 coverage, 2 the
# profiler, 5 the optimizer. 3 and 4 are unclaimed; try both so a process that
# already has something in 3 (a profiler run, another sensor) still gets a slot
# rather than silently going dark.
_CANDIDATE_TOOL_IDS = (3, 4)

# Nothing under these ever counts, however it is reached. Checked as substrings
# of the absolute path, so it doesn't matter which root a file came in under.
_EXCLUDE_PARTS = ("/venv/", "/.venv/", "/site-packages/", "/node_modules/",
                  "/__pycache__/", "/.git/")

# The two shared pieces of mutable state: (filename, function name) pairs seen
# since the last cycle, and caller→callee file pairs seen since the last cycle. Plain sets, and
# `_seen_add` / `_edge_add` are their BOUND `add` methods — the callbacks below
# call those directly, so a hit costs one C call and touches no Python frame of
# ours (which is also what keeps a callback from recursing into itself).
_seen = set()
_seen_add = _seen.add
_edges = set()
_edge_add = _edges.add

_lock = threading.Lock()
_state = {"running": False, "tool_id": None, "roots": (), "thread": None,
          "stop": None, "cycles": 0}


def _now():
    return time.time()


def default_roots():
    """Which trees count as "ours". The app's own directory by default; the
    env var takes a colon-separated list, so an install that wants its vault's
    scripts measured too can say so without a code change."""
    env = os.environ.get("EXOCORTEX_RUNTIME_SENSOR_ROOTS")
    if env:
        return tuple(str(Path(p).resolve()) for p in env.split(os.pathsep) if p.strip())
    return (str(Path(store.BUILD_DIR).resolve()),)


def enabled():
    """On unless explicitly switched off. The overhead is one callback per
    function per minute, which is not a thing worth asking anyone to opt into,
    but an install that wants nothing written down gets a single lever."""
    return os.environ.get("EXOCORTEX_RUNTIME_SENSOR", "1").strip().lower() not in (
        "0", "false", "no", "off")


def _under_roots(filename, roots):
    if not filename or filename[0] != "/":
        return False          # "<frozen importlib._bootstrap>", "<string>", …
    for part in _EXCLUDE_PARTS:
        if part in filename:
            return False
    for root in roots:
        if filename.startswith(root + "/"):
            return True
    return False


def _install(tool_id):
    """Register both callbacks. They are deliberately short: each one runs on
    the hot path of every function (or every call site) in the process the
    first time it is reached after a re-arm.

    TWO EVENTS, ANSWERING TWO QUESTIONS.

    PY_START fires on entry to a Python function and says WHICH FILE RAN, and
    which function in it — `co_qualname`, the dotted name Python itself prints
    in a traceback ("register.<locals>.observatory_terrain_file"). The name
    rather than the line number, because a line number is only true for the
    version of the file this process loaded; the name survives edits above it.
    It disables per function, so each function costs one callback per window.

    CALL fires at a call SITE and says WHO CALLED WHOM. It is the right event
    for edges for two reasons: the caller arrives as `code` rather than having
    to be dug out of the frame stack, and it disables per (code, offset) — per
    call site — so a file with fifty call sites into another gets fifty chances
    to be seen rather than one. Its sampling limit is worth stating plainly: a
    single site that calls different things on different passes (a dispatch
    table, a callback parameter) contributes only the FIRST callee it sees each
    window. Over many windows the edge set fills in; inside any one window it
    is a sample, never a proof of absence."""
    mon = sys.monitoring
    disable = mon.DISABLE

    def _py_start(code, instruction_offset):
        _seen_add((code.co_filename, code.co_qualname))
        return disable       # never call us for this function again — until re-arm

    def _call(code, instruction_offset, callable_, arg0):
        try:
            dst = callable_.__code__.co_filename
        except AttributeError:
            # Not a Python function. Either a C builtin (len, dict.get) — which
            # has no file and never will — or a CLASS being constructed, where
            # the code that runs is its __init__. Worth the second look: a call
            # to Flask() or Path() is a real edge, and skipping every
            # constructor would quietly drop a whole category of flow.
            try:
                dst = callable_.__init__.__code__.co_filename
            except AttributeError:
                return disable
        _edge_add((code.co_filename, dst))
        return disable       # never call us for this SITE again — until re-arm

    mon.register_callback(tool_id, mon.events.PY_START, _py_start)
    mon.register_callback(tool_id, mon.events.CALL, _call)
    mon.set_events(tool_id, mon.events.PY_START | mon.events.CALL)


def _harvest():
    """Swap the hit set out, and return the (filename, function) pairs that
    were in it.

    The swap rebinds the module-global `add` the callback holds, then reads the
    OLD set — that order is what makes the race benign. A callback that grabbed
    the old bound method a microsecond before the rebind still writes into the
    set we are about to read; the only loss is a hit landing after we have
    iterated, and it lands in the NEXT window rather than nowhere, because the
    very next thing the caller does is re-arm. Inside an already-recorded
    bucket that costs nothing at all; at a bucket boundary it can move one
    timestamp forward by a cycle."""
    global _seen, _seen_add, _edges, _edge_add
    old, old_edges = _seen, _edges
    fresh, fresh_edges = set(), set()
    _seen, _edges = fresh, fresh_edges
    _seen_add, _edge_add = fresh.add, fresh_edges.add
    return old, old_edges


def _merge(hits, roots, now=None, edges=()):
    """Fold one window's filenames and caller→callee pairs into the sidecar.
    Absolute paths, matching the convention bot_chats/footprints.json already
    uses, so terrain.py can map them into repos with the code it already has.

    Skipped entirely when nothing under the roots ran — an idle worker must not
    write a file every minute just to say nothing happened.

    An EDGE is kept only when BOTH ends are ours. A call out to flask or into
    the standard library is real, but it is not a flow between two pieces of
    this app, and keeping it would bury the graph the map is for under
    thousands of edges into the interpreter. Which packages a file depends on
    is already answered, statically and completely, by codegraph.py."""
    now = _now() if now is None else now
    # Split the hits into files and functions. A hit is a (filename, function
    # name) pair; a bare filename is still accepted, as a file with no function
    # to credit.
    functions_by_file = {}
    for hit in hits:
        filename, qualname = hit if isinstance(hit, tuple) else (hit, None)
        if not _under_roots(filename, roots):
            continue
        names = functions_by_file.setdefault(filename, set())
        if qualname and _is_function_name(qualname):
            names.add(qualname)
    ours = sorted(functions_by_file)
    our_edges = sorted((s, d) for s, d in edges
                       if _under_roots(s, roots) and _under_roots(d, roots) and s != d)
    if not ours and not our_edges:
        return 0
    bucket = int(now // BUCKET_SEC) * BUCKET_SEC
    _merge_functions(functions_by_file, bucket)
    with store.mutate(COLLECTION, {"files": {}, "edges": {}}) as data:
        _merge_edges(data.setdefault("edges", {}), our_edges, bucket)
        files = data.setdefault("files", {})
        for path in ours:
            entry = files.get(path)
            if not isinstance(entry, dict):
                entry = {"first": bucket, "windows": 0, "touches": []}
                files[path] = entry
            touches = entry.get("touches")
            if not isinstance(touches, list):
                touches = []
            # Everything here is per BUCKET, never per cycle — including the
            # count. A file that runs on every request would otherwise fill its
            # ring in an hour and lose the history that makes it readable on a
            # month-wide lens, and every cycle would dirty the collection and
            # force a real write. Seen-again inside the same bucket is a no-op
            # by construction, which is what lets store's unchanged-write guard
            # do the throttling for us.
            if touches and touches[-1] == bucket:
                continue
            touches.append(bucket)
            entry["touches"] = touches[-TOUCH_CAP:]
            entry["last"] = bucket
            entry["windows"] = int(entry.get("windows") or 0) + 1
        if files:
            data["updated"] = max(
                (e.get("last") for e in files.values()
                 if isinstance(e, dict) and isinstance(e.get("last"), (int, float))),
                default=bucket)
    return len(ours)


def _is_function_name(qualname):
    """True for a real `def`. The interpreter also "enters" a module's top
    level (`<module>`), a lambda and a generator expression, and names them in
    angle brackets. None of those is a function someone could point at in the
    file — and `<module>` runs at import, so crediting it would paint a whole
    file as "ran" for merely being loaded."""
    return not qualname.rsplit(".", 1)[-1].startswith("<")


def _merge_functions(functions_by_file, bucket):
    """Fold one window's functions into the second sidecar: for each file, the
    bucket each of its functions last ran in.

    One number per function, not a ring of touches like a file gets: the pane
    only ever asks "when did this last run". Bucketed like everything else
    here, so a function seen again inside the same bucket changes nothing and
    store's unchanged-write guard drops the write. Entries not seen for
    FUNCTION_KEEP_SEC are dropped on the way through."""
    if not any(functions_by_file.values()):
        return
    oldest_kept = bucket - FUNCTION_KEEP_SEC
    with store.mutate(FUNCTIONS_COLLECTION, {"files": {}}) as data:
        files = data.setdefault("files", {})
        for path, names in functions_by_file.items():
            if not names:
                continue
            entry = files.get(path)
            if not isinstance(entry, dict):
                entry = {}
                files[path] = entry
            for qualname in sorted(names):
                entry[qualname] = bucket
        for path in list(files):
            entry = files[path]
            if not isinstance(entry, dict):
                del files[path]
                continue
            for qualname in [q for q, last in entry.items()
                             if not isinstance(last, (int, float)) or last < oldest_kept]:
                del entry[qualname]
            if not entry:
                del files[path]


def functions_ran(abspath):
    """{function name: when it last ran} for one file, by absolute path. Empty
    when the sensor has never seen anything in that file run. The reader's half
    of _merge_functions."""
    data = store.read(FUNCTIONS_COLLECTION, {"files": {}})
    files = data.get("files") if isinstance(data, dict) else None
    entry = files.get(str(abspath)) if isinstance(files, dict) else None
    return dict(entry) if isinstance(entry, dict) else {}


def _merge_edges(edges, pairs, bucket):
    """Same bucket-and-ring shape as a file's entry, keyed 'src\\tdst'.

    A tab because it cannot occur in a path, so the key splits back apart
    without escaping — and JSON has no tuple keys, which is the constraint that
    forces a joined string here at all."""
    for src, dst in pairs:
        key = f"{src}\t{dst}"
        entry = edges.get(key)
        if not isinstance(entry, dict):
            entry = {"first": bucket, "windows": 0, "touches": []}
            edges[key] = entry
        touches = entry.get("touches")
        if not isinstance(touches, list):
            touches = []
        if touches and touches[-1] == bucket:
            continue          # already recorded this bucket — leave it untouched
        touches.append(bucket)
        entry["touches"] = touches[-TOUCH_CAP:]
        entry["last"] = bucket
        entry["windows"] = int(entry.get("windows") or 0) + 1


def observed_edges():
    """The runtime edge set, as (src, dst, entry) with the key split back
    apart. The reader's half of _merge_edges."""
    out = []
    for key, entry in (snapshot().get("edges") or {}).items():
        if not isinstance(entry, dict) or "\t" not in key:
            continue
        src, dst = key.split("\t", 1)
        out.append((src, dst, entry))
    return out


def cycle():
    """One window's work: take the hits, write them down, re-arm.

    `restart_events()` re-enables everything every monitoring tool has disabled,
    not only ours. Nothing else in this app uses sys.monitoring; a profiler or
    a coverage run sharing the process would find its own disables cleared and
    would simply do more work than it meant to, never less. Public so a test
    can drive the sensor a window at a time instead of waiting on wall time."""
    roots = _state["roots"] or default_roots()
    hits, edges = _harvest()
    written = _merge(hits, roots, edges=edges)
    _state["cycles"] += 1
    try:
        sys.monitoring.restart_events()
    except (ValueError, RuntimeError):
        pass          # a torn-down tool id isn't a reason to kill the caller
    return written


def _loop(stop):
    while not stop.wait(CYCLE_SEC):
        try:
            cycle()
        except Exception:
            continue   # a contended write, a vanished data dir — never fatal


def start(roots=None, background=True):
    """Turn the sensor on. Idempotent, and a no-op on anything that can't run
    it (Python without sys.monitoring, the env lever off, both tool ids taken).

    Returns True only if monitoring is actually installed, so a caller can log
    the difference between "off by choice" and "on and watching".

    Never called at import — the background thread outlives whatever started
    it, and a thread writing through `store` after a test's tmp data dir has
    gone is exactly the leak tests/conftest.py quarantines the whole process
    against. Callers turn it on deliberately: server.py at startup, and
    scripts/turn_host.py for the turn's own process."""
    with _lock:
        if _state["running"]:
            return True
        if not enabled() or not hasattr(sys, "monitoring"):
            return False
        _state["roots"] = tuple(str(Path(r).resolve()) for r in roots) if roots \
            else default_roots()
        mon = sys.monitoring
        for tool_id in _CANDIDATE_TOOL_IDS:
            try:
                mon.use_tool_id(tool_id, "exocortex-runtime")
            except ValueError:
                continue      # already claimed by something else in this process
            _state["tool_id"] = tool_id
            break
        else:
            return False
        _install(_state["tool_id"])
        _state["running"] = True
        if background:
            stop = threading.Event()
            thread = threading.Thread(target=_loop, args=(stop,), daemon=True,
                                      name="runtime-sensor")
            _state["stop"], _state["thread"] = stop, thread
            thread.start()
        return True


def stop():
    """Switch it off and hand the tool id back. Flushes what it has first —
    the last window's hits are as real as any other's."""
    with _lock:
        if not _state["running"]:
            return
        if _state["stop"] is not None:
            _state["stop"].set()
        tool_id = _state["tool_id"]
        try:
            sys.monitoring.set_events(tool_id, 0)
            sys.monitoring.free_tool_id(tool_id)
        except (ValueError, TypeError):
            pass
        _state.update({"running": False, "tool_id": None, "stop": None,
                       "thread": None})
    try:
        last_hits, last_edges = _harvest()
        _merge(last_hits, _state["roots"] or default_roots(),
               edges=last_edges)
    except Exception:
        pass


def attach():
    """Start the sensor AND arrange for its last window to be written down when
    the process exits. The one-liner for a short-lived script.

    The long-running hosts (server.py, turn_host.py) call `start()` and manage
    their own shutdown — a gunicorn worker is killed rather than exited, so an
    atexit hook there would be a promise the process can't keep. A cron script
    is the opposite case: it runs for two seconds and returns, which is far
    shorter than one CYCLE_SEC, so without the exit flush it would do its whole
    job and leave no trace of having run at all. That is precisely the blind
    spot this exists to close — the batch half of the system (the footprint
    extractor, the rollups, the dispatchers) is real work on real files, and it
    was reading as dead code.

    Deliberately called from inside a script's `if __name__ == "__main__"`
    block, never at import: several of these modules are ALSO imported by the
    web app (routes/terrain.py imports scripts/extract_footprints), and a
    sensor that started on import would arm itself inside every process that
    merely borrowed a function."""
    if not start():
        return False
    atexit.register(stop)
    return True


def running():
    return bool(_state["running"])


def snapshot():
    """The sidecar as it stands. Read straight through `store`, so any process
    can ask — the web worker answering /api/observatory/terrain/runtime is not
    usually the same process as the one that recorded the hit."""
    data = store.read(COLLECTION, {"files": {}})
    return data if isinstance(data, dict) else {"files": {}}
