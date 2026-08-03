"""procmem.py — how much memory each live agent session is actually holding.

Plain English: every turn the app starts is a `claude` process, and each one is
launched with its conversation id in its environment (routes/observatory.py's
`_spawn` sets EXOCORTEX_CONV_ID). So to find out what a session weighs, we walk
/proc, read each process's environment, and add up the memory of everything
tagged with the same conversation. Tool subprocesses inherit the tag from their
parent, so a session that shelled out to run tests counts that too.

WHY PSS AND NOT RSS. RSS counts shared memory once per process, so four sessions
sharing the same node runtime would each claim it and the four cards would add
up to more memory than the box actually has — contradicting the meter in the
Observatory header. PSS ("proportional set size") splits shared pages between
the processes using them, so the per-session numbers reconcile with the whole.
Measured live on this box: four claude processes read 1304MB by RSS and 1073MB
by PSS. RSS is only the fallback for a process whose smaps_rollup can't be read.

Linux-only by nature. Anywhere without /proc this returns {} and every caller
just shows nothing, which is the honest answer rather than a made-up one.

Touches: routes/run_queue.py (serves this at /api/runqueue/session-memory),
routes/observatory.py (whose `_spawn` sets the tag this relies on).

Prompt that produced it: "i am also wanting like a descriptor of the amount of
memory a session is using on the session, reflecting the amount of size of
memory it's using in real time."
"""
import os
import time

PROC = "/proc"
TAG = b"EXOCORTEX_CONV_ID="

# The roster polls every few seconds, from more than one client and more than
# one gunicorn worker. Walking /proc is cheap but not free, so a result is
# reused for a moment rather than recomputed per request.
_CACHE_TTL_SEC = 3.0
_cache = {"at": 0.0, "value": {}}


def _conv_id_of(pid):
    """The conversation this process belongs to, or None.

    Reads the process's environment block — a NUL-separated blob. A process we
    can't read (gone, or another user's) simply isn't ours to count.
    """
    try:
        with open(f"{PROC}/{pid}/environ", "rb") as fh:
            blob = fh.read()
    except (OSError, ValueError):
        return None
    for entry in blob.split(b"\0"):
        if entry.startswith(TAG):
            value = entry[len(TAG):].decode("utf-8", "replace").strip()
            return value or None
    return None


def _pss_kb(pid):
    """This process's share of memory in kB — PSS if the kernel will tell us,
    else RSS. Returns 0 for a process that vanished mid-read, which happens
    routinely and is not an error."""
    try:
        with open(f"{PROC}/{pid}/smaps_rollup") as fh:
            for line in fh:
                if line.startswith("Pss:"):
                    return int(line.split()[1])
    except (OSError, ValueError, IndexError):
        pass
    try:
        with open(f"{PROC}/{pid}/status") as fh:
            for line in fh:
                if line.startswith("VmRSS:"):
                    return int(line.split()[1])
    except (OSError, ValueError, IndexError):
        pass
    return 0


def scan():
    """{conversation_id: megabytes} for every tagged process alive right now.

    Uncached — `session_memory()` is what callers should use.
    """
    totals = {}
    try:
        pids = [name for name in os.listdir(PROC) if name.isdigit()]
    except OSError:
        return totals   # no /proc — not Linux, or a locked-down container

    for pid in pids:
        conv = _conv_id_of(pid)
        if not conv:
            continue
        totals[conv] = totals.get(conv, 0) + _pss_kb(pid)

    # kB -> MB, rounded to the nearest 10. The roster re-polls every few
    # seconds and an exact number would tick 286 -> 291 -> 288 in her
    # peripheral vision forever; rounding means it moves when something
    # actually happened.
    return {conv: max(0, round(kb / 1024 / 10) * 10) for conv, kb in totals.items()}


def session_memory(now=None):
    """{conversation_id: megabytes}, cached for a few seconds. Never raises."""
    now = now if now is not None else time.monotonic()
    if now - _cache["at"] < _CACHE_TTL_SEC and _cache["value"] is not None:
        return dict(_cache["value"])
    try:
        value = scan()
    except Exception:
        value = {}
    _cache["at"] = now
    _cache["value"] = value
    return dict(value)


def reset_cache():
    """Drop the cached scan — for tests, and for a caller that just spawned
    something and wants the next read to see it."""
    _cache["at"] = 0.0
    _cache["value"] = {}
