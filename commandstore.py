"""Which slash commands the owner actually runs — the skills ledger.

**What this answers.** This install has ~18 of its own slash commands (the
voices: /spark, /terra, /gardener, /thistle …, symlinked into
`~/.claude/commands/` by `scripts/link_commands.sh`). Nothing recorded which
ones got called. So "am I actually using /tiller, or did I build it and never
open it again?" had no answer, and neither did "when do I reach for /spark" —
the commands were the one part of the system with no telemetry at all, while
pages, clicks and dwell have been counted since July (routes/usage.py).

**Where the data comes from — nothing new is written at call time.** Claude
Code already records every slash command in its own session transcripts under
`~/.claude/projects/<slug>/<session>.jsonl`, as a user line whose text is
`<command-name>/spark</command-name>` (plus `<command-args>` when arguments
were typed). So this module is a READER, not a hook: it walks those files and
folds them into `command_runs`. Two things follow from that, both good — the
whole history back to the first session was available the day this shipped,
retroactively, and no hook runs inside the owner's turn to slow it down or to
break it if this code has a bug.

**The table is DERIVED** — like the habit tables (habitstore.py) and unlike
`job_runs` (jobstore.py, whose rows are the only evidence the event happened).
Every row here can be re-read from the transcripts, so `rebuild()` may drop
and re-ingest freely, and the table never needs its own backup.

**Idempotence is the transcript message's own `uuid`**, used as the primary
key: reading the same line twice inserts once. That is what makes re-running
the walk free, and it's insurance against a resumed or forked session leaving
the same line in two files. Measured on this corpus it currently collapses
nothing — 90 `/journalstart` lines, 90 distinct uuids. The count that DOES
get filtered is the one below: a raw grep for the marker finds 227
`/journalstart` hits, because the marker also appears in assistant echoes and
inside quoted file snippets.

**Incremental by design.** The corpus is ~8,000 files / 1.7 GB and grows every
day; re-reading it on every rollup tick would cost minutes to find a handful
of new lines. `command_sources` remembers each file's size, and because JSONL
is append-only, a file whose size is unchanged is skipped outright and one
that grew is re-opened at the old size. A file that SHRANK was rewritten, not
appended to, so it's re-read from the top. Within a file, a cheap substring
test skips the ~99.9% of lines that can't be a command before any JSON parsing
happens.

**Arguments are counted, never stored.** `<command-args>` is the owner's own
prose — "/spark <something personal>" — and this is a counting table that gets
mirrored and queried in the SQL lab. Keeping the text would smuggle personal
content into telemetry for no gain, since the question is *which command, how
often, when*. So only `arg_chars` is kept: enough to tell a bare `/spark` from
one that carried a real ask, carrying none of what it said.

Touches: `sqlstore.py` (owns the schema — rung 15 — and the connection
factory), `scripts/command_rollup.py` (the cron entry point), and
`routes/usage.py` (serves it at /api/usage/commands).

Prompt that produced this file: "build a / command tracker — I want to know
when I'm using different skills."
"""
import json
import os
import re
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

import sqlstore

# The transcript root. Env-overridable so tests (and any install that moves
# its Claude Code home) don't need this path compiled in.
def projects_dir():
    override = os.environ.get("CLAUDE_PROJECTS_DIR")
    if override:
        return Path(override)
    return Path.home() / ".claude" / "projects"


# Commands the harness ships, as opposed to the ones this install wrote.
#
# The split is a NAMED SET rather than "does ~/.claude/commands/<n>.md exist
# right now", because that test would quietly re-label a RETIRED skill as a
# built-in and erase the very thing the owner is most likely looking for — the
# commands that stopped being used. A name not on this list is a skill even if
# its file is long gone.
#
# But a local file SHADOWS the harness command of the same name, so an
# installed command is always a skill no matter what this set says: this
# install ships its own /help, and reading those runs as the harness's /help
# hid a real skill from the only view built to show it. `local` carries the
# currently-installed names into the classification for exactly that case.
#
# The honest edge, since this is the one place the two rules can disagree:
# delete a shadowing command and a later --rebuild will re-file its old runs
# as built-in. That only touches names that collide with the list below, and
# the alternative — trusting the set alone — is what hid /help.
BUILTINS = frozenset((
    "add-dir", "agents", "bashes", "clear", "compact", "config", "context",
    "cost", "doctor", "exit", "export", "fast", "feedback", "help", "hooks",
    "ide", "init", "install-github-app", "listen", "login", "logout",
    "mcp", "memory", "migrate-installer", "model", "output-style",
    "permissions", "pr-comments", "privacy-settings", "release-notes",
    "resume", "review", "rewind", "security-review", "status", "statusline",
    "terminal-setup", "todos", "upgrade", "usage", "vim", "workflows",
))

# The command line itself. `<command-name>` is written by the harness, so the
# shape is fixed; the leading slash is stripped and the name lower-cased so
# /Spark and /spark are one command.
_NAME_RE = re.compile(r"<command-name>\s*/?([A-Za-z0-9:_-]{1,64})\s*</command-name>")
_ARGS_RE = re.compile(r"<command-args>(.*?)</command-args>", re.DOTALL)
# Cheap pre-filter: only lines containing this can possibly match, and
# skipping the rest keeps a 1.7 GB walk I/O-bound instead of JSON-bound.
_MARKER = "<command-name>"


def _text_of(message):
    """The message's text, whether it's a bare string or content blocks."""
    content = message.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(
            b.get("text", "") for b in content if isinstance(b, dict)
        )
    return ""


def parse_line(line, local=frozenset()):
    """One transcript line -> a command-run dict, or None.

    `local` is the set of command names installed in ~/.claude/commands; a
    name in it is always reported as a skill (see BUILTINS).

    Pure and file-free so the parsing rules can be tested directly. Returns
    None for anything that isn't the owner typing a slash command: assistant
    lines, sidechain (subagent) lines, ordinary prompts, and lines that merely
    mention the marker inside a quoted file (an attachment snippet of this
    very module would otherwise count as a run of every command it names).
    """
    if _MARKER not in line:
        return None
    try:
        d = json.loads(line)
    except (ValueError, TypeError):
        return None
    if d.get("type") != "user" or d.get("isSidechain"):
        return None
    uuid = d.get("uuid")
    stamp = d.get("timestamp")
    if not uuid or not stamp:
        return None
    text = _text_of(d.get("message") or {})
    # The marker has to be in the MESSAGE, not merely somewhere in the line —
    # attachments ride along on the same JSON object.
    m = _NAME_RE.search(text)
    if not m:
        return None
    name = m.group(1).lower()
    args = _ARGS_RE.search(text)
    when = _local(stamp)
    if when is None:
        return None
    return {
        "uuid": uuid,
        "at": stamp,
        "day": when.strftime("%Y-%m-%d"),
        "hour": when.hour,
        "name": name,
        "kind": "builtin" if name in BUILTINS and name not in local else "skill",
        "session_id": d.get("sessionId"),
        "cwd": d.get("cwd"),
        "arg_chars": len(args.group(1).strip()) if args else 0,
    }


def _local(stamp):
    """Transcript timestamps are ISO-8601 UTC with a trailing Z; the owner
    lives in local time, and "which hour do I call /spark" is meaningless in
    UTC. Day and hour are stored already converted so every later query is a
    plain string compare."""
    try:
        dt = datetime.fromisoformat(str(stamp).replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone()


def _open():
    """A connection whose rows come back as mappings. sqlstore's factory
    deliberately leaves `row_factory` unset (the blob path wants raw tuples),
    so every typed-table reader sets its own."""
    conn = sqlstore.open_db()
    conn.row_factory = sqlite3.Row
    return conn


def scan_file(path, start=0, local=frozenset()):
    """Yield command-run dicts from one transcript, resuming at byte `start`."""
    try:
        with open(path, "rb") as fh:
            if start:
                fh.seek(start)
            for raw in fh:
                row = parse_line(raw.decode("utf-8", "replace"), local)
                if row:
                    yield row
    except OSError:
        return


def ingest(root=None):
    """Fold every new transcript line into `command_runs`.

    Returns {"files": scanned, "skipped": unchanged, "rows": inserted}.
    Safe to run on any schedule: unchanged files cost one stat() each and
    re-reading a line that's already stored inserts nothing.
    """
    root = Path(root) if root else projects_dir()
    conn = sqlstore.open_db()
    # Read once per walk, not once per line: it's a directory listing, and
    # the answer can't change usefully mid-run.
    local = frozenset(installed())
    stats = {"files": 0, "skipped": 0, "rows": 0}
    try:
        seen = {
            r[0]: r[1]
            for r in conn.execute("SELECT path, size FROM command_sources")
        }
        now = datetime.now().isoformat(timespec="seconds")
        for path in sorted(root.glob("*/*.jsonl")):
            key = str(path)
            try:
                size = path.stat().st_size
            except OSError:
                continue
            before = seen.get(key)
            if before is not None and before == size:
                stats["skipped"] += 1
                continue
            # Grew -> resume where we stopped. Shrank -> it was rewritten
            # rather than appended to, so start over.
            start = before if before is not None and before < size else 0
            stats["files"] += 1
            rows = list(scan_file(path, start, local))
            sqlstore.begin_immediate(conn)
            try:
                for row in rows:
                    cur = conn.execute(
                        "INSERT OR IGNORE INTO command_runs"
                        " (uuid, at, day, hour, name, kind, session_id, cwd,"
                        "  arg_chars)"
                        " VALUES (:uuid, :at, :day, :hour, :name, :kind,"
                        "  :session_id, :cwd, :arg_chars)",
                        row,
                    )
                    stats["rows"] += cur.rowcount
                conn.execute(
                    "INSERT INTO command_sources (path, size, scanned_at)"
                    " VALUES (?, ?, ?)"
                    " ON CONFLICT(path) DO UPDATE SET size = excluded.size,"
                    "  scanned_at = excluded.scanned_at",
                    (key, size, now),
                )
                conn.execute("COMMIT")
            except BaseException:
                conn.execute("ROLLBACK")
                raise
        return stats
    finally:
        conn.close()


def rebuild(root=None):
    """Drop both tables' contents and re-read every transcript from the top.

    Costs a full pass over the corpus. Only needed when the parsing rules
    change — the rows themselves are derived, so nothing is lost."""
    conn = sqlstore.open_db()
    try:
        sqlstore.begin_immediate(conn)
        conn.execute("DELETE FROM command_runs")
        conn.execute("DELETE FROM command_sources")
        conn.execute("COMMIT")
    finally:
        conn.close()
    return ingest(root)


def _window(days):
    """The `day` string that a `days`-long window starts at, or None."""
    if not days:
        return None
    return (datetime.now() - timedelta(days=days - 1)).strftime("%Y-%m-%d")


def summary(days=None, kind="skill"):
    """One row per command: how often, how many days, first and last seen.

    Ordered by count. `kind=None` includes the harness's own commands, which
    are excluded by default — /compact and /clear are the two most-run
    commands on this box by a wide margin and they say nothing about which
    skills get used.
    """
    since = _window(days)
    where, params = [], []
    if since:
        where.append("day >= ?")
        params.append(since)
    if kind:
        where.append("kind = ?")
        params.append(kind)
    clause = (" WHERE " + " AND ".join(where)) if where else ""
    conn = _open()
    try:
        rows = conn.execute(
            "SELECT name, kind, COUNT(*) AS runs,"
            "       COUNT(DISTINCT day) AS days,"
            "       COUNT(DISTINCT session_id) AS sessions,"
            "       MIN(day) AS first_day, MAX(day) AS last_day,"
            "       SUM(CASE WHEN arg_chars > 0 THEN 1 ELSE 0 END) AS with_args"
            f" FROM command_runs{clause}"
            " GROUP BY name, kind ORDER BY runs DESC, name",
            params,
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def by_day(days=30, kind="skill"):
    """Runs per calendar day per command — the "when" axis, coarse."""
    since = _window(days)
    where, params = [], []
    if since:
        where.append("day >= ?")
        params.append(since)
    if kind:
        where.append("kind = ?")
        params.append(kind)
    clause = (" WHERE " + " AND ".join(where)) if where else ""
    conn = _open()
    try:
        rows = conn.execute(
            "SELECT day, name, COUNT(*) AS runs"
            f" FROM command_runs{clause}"
            " GROUP BY day, name ORDER BY day, name",
            params,
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def by_hour(days=None, kind="skill"):
    """Runs per local hour of day, 0-23 — the "when" axis, fine.

    Always returns all 24 buckets so the caller can draw the clock without
    filling gaps itself."""
    since = _window(days)
    where, params = [], []
    if since:
        where.append("day >= ?")
        params.append(since)
    if kind:
        where.append("kind = ?")
        params.append(kind)
    clause = (" WHERE " + " AND ".join(where)) if where else ""
    conn = _open()
    try:
        counts = dict(
            conn.execute(
                f"SELECT hour, COUNT(*) FROM command_runs{clause}"
                " GROUP BY hour",
                params,
            ).fetchall()
        )
        return [{"hour": h, "runs": counts.get(h, 0)} for h in range(24)]
    finally:
        conn.close()


def recent(limit=50, kind="skill"):
    """The last N invocations, newest first."""
    where, params = [], []
    if kind:
        where.append("kind = ?")
        params.append(kind)
    clause = (" WHERE " + " AND ".join(where)) if where else ""
    params.append(max(1, min(int(limit), 500)))
    conn = _open()
    try:
        rows = conn.execute(
            "SELECT uuid, at, day, hour, name, kind, session_id, cwd,"
            "       arg_chars"
            f" FROM command_runs{clause} ORDER BY at DESC LIMIT ?",
            params,
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def installed():
    """Command names currently present in ~/.claude/commands, so a report can
    tell a skill that exists-but-is-unused from one that was deleted."""
    home = projects_dir().parent / "commands"
    try:
        return sorted(p.stem.lower() for p in home.glob("*.md"))
    except OSError:
        return []
