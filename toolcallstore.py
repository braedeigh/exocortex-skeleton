"""Every tool an agent ran, on what, and how it went — read out of the logs.

**What this answers.** The Observatory keeps the raw event stream of every
conversation (data/bot_chats/<conv>.jsonl), and Claude Code keeps its own
transcript of every session, Observatory or not (~/.claude/projects/...).
Between them, every tool call any agent ever made on this box is on disk,
with its input and its result. What was missing was a way to ASK: how many
Bash calls did Tuesday's build make, which files get edited together, which
tool fails most, what did a turn cost. Until now that meant parsing gigabytes
of JSONL by hand. This module folds those lines into two tables:

    tool_calls    one row per tool call — when, which tool, on what (the
                  file, the command, the pattern), the input as JSON, and
                  once the matching result line is read: how long it took,
                  how big the result was, whether it errored.
    turn_results  one row per Observatory turn — how it ended, how long it
                  took, and what it cost in tokens and dollars, from the
                  `result` event the harness emits when a turn finishes.

**Both tables are DERIVED**, like command_runs (commandstore.py) and unlike
job_runs: every row can be re-read from the logs, so `rebuild()` may drop and
re-ingest freely.

**Two sources, one key.** An Observatory turn is written to BOTH records —
the app appends the stream to bot_chats, and the harness writes its own
transcript. A tool call carries the same `toolu_...` id in both, and that id
is the primary key, so the second reading of a call inserts nothing. The
`source` column says which record reached the table first; bot_chats is
walked first on purpose, so an Observatory call is labelled 'observatory'
and anything only the harness saw (tmux, a plain terminal) is 'claude'.

**Incremental by design**, the watermark commandstore.py uses: a file whose
size hasn't changed is skipped on a stat(); one that grew is reopened where
the last scan stopped; one that shrank was rewritten and is read from the
top. A cheap substring test skips the lines that can't hold a tool call
before any JSON parsing happens.

**Live for Observatory turns.** A running turn calls `live_ingest` on its own
log every few seconds (routes/observatory.py), so its tool calls are in the
table within seconds — that's what lets one agent see what another is doing
right now. The hourly cron still walks everything, and is the only path for
sessions outside the Observatory (tmux, a plain terminal). Both stop at the
last whole line, so a line still being written is never half-read.

**The clock.** Both sources stamp lines in UTC with a trailing Z. Rows are
stored in LOCAL naive ISO with milliseconds — the clock attention_segments
keeps, with the fraction kept because calls land several to a second. The
`result` event has no timestamp of its own; it is dated by the last stamped
line before it, and that clock is carried in tool_call_sources.last_at so a
scan that resumes mid-turn can still date it.

**What is kept of the input.** The whole input, as JSON, capped at
_INPUT_CAP characters (input_truncated says when). That is the granular part
the owner asked for — the command that ran, the edit that was made — and it
lives in exo.db inside her vault, the same place the logs already are.
Results are NOT copied: only their size and error flag. A result is often a
whole file, and the logs already hold it.

Touches: `sqlstore.py` (owns the schema — rung 19), `store.py` (DATA_DIR for
bot_chats), `commandstore.projects_dir` (the harness transcript root),
`scripts/usage_events.py` (the cron entry point), `routes/observatory.py`
(the live path), and `routes/sqlab.py` (lists the tables).

Prompt that produced this file: "I'm trying to figure out how to record my
usage as granularly as possible and then give my tools the ability and
infrastructure to comb through it all ... I wanna turn it all into sql."
"""
import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

import commandstore
import sqlstore
import store

# How much of a tool's input is kept, in characters of JSON.
_INPUT_CAP = 4000
# How much of the target handle is kept.
_TARGET_CAP = 300
# Lines that can't hold a tool call or a turn result are skipped before any
# JSON parsing — that is what keeps a walk over gigabytes I/O-bound.
_MARKERS = ('"tool_use"', '"tool_result"', '"result"', '"usage"', '"call-usage"')


def bot_chats_dir():
    """Resolved at call time so tests get an isolated data dir."""
    return store.DATA_DIR / "bot_chats"


def _local(stamp):
    """UTC ISO with a trailing Z -> local naive ISO with milliseconds.
    Returns None for anything unparseable."""
    if not stamp:
        return None
    try:
        dt = datetime.fromisoformat(str(stamp).replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone().replace(tzinfo=None).isoformat(timespec="milliseconds")


def _ms_between(earlier, later):
    """Milliseconds from one local ISO stamp to another, or None."""
    try:
        return int((datetime.fromisoformat(later)
                    - datetime.fromisoformat(earlier)).total_seconds() * 1000)
    except (TypeError, ValueError):
        return None


def target_of(name, inp):
    """The one handle worth indexing for a tool call.

    The file for the file tools, the command for Bash, the pattern for the
    search tools, the url for a fetch, the description for a spawned agent.
    Anything else: the first string value in the input, so an unknown tool
    still gets a readable handle rather than nothing."""
    if not isinstance(inp, dict):
        return None
    keys_by_tool = {
        "Read": ("file_path",), "Edit": ("file_path",), "Write": ("file_path",),
        "MultiEdit": ("file_path",), "NotebookEdit": ("notebook_path",),
        "Bash": ("command",),
        "Grep": ("pattern",), "Glob": ("pattern",),
        "WebFetch": ("url",), "WebSearch": ("query",),
        "Agent": ("description",), "Task": ("description",),
        "Skill": ("skill",), "SendMessage": ("to",),
    }
    value = None
    for key in keys_by_tool.get(name, ()):
        if isinstance(inp.get(key), str) and inp.get(key):
            value = inp[key]
            break
    if value is None:
        for v in inp.values():
            if isinstance(v, str) and v:
                value = v
                break
    if value is None:
        return None
    # A search's pattern means little without where it looked.
    if name in ("Grep", "Glob") and isinstance(inp.get("path"), str):
        value = f"{value} in {inp['path']}"
    return value[:_TARGET_CAP]


def _result_size(block):
    """Characters in a tool_result's content, whether a string or blocks."""
    content = block.get("content")
    if isinstance(content, str):
        return len(content)
    if isinstance(content, list):
        return sum(len(b.get("text", "")) for b in content if isinstance(b, dict))
    return 0


def parse_line(line, source, conv=None):
    """One log line -> a list of row dicts, each tagged with what it is.

    Pure and file-free so the parsing rules can be tested directly. Yields
    {"kind": "call", ...} for each tool_use block, {"kind": "result", ...}
    for each tool_result block, {"kind": "turn", ...} for a result event,
    and {"kind": "clock", "at": ...} for any stamped line so the caller can
    carry the clock forward. Returns [] for anything else.
    """
    if not any(m in line for m in _MARKERS):
        return []
    try:
        d = json.loads(line)
    except (ValueError, TypeError):
        return []
    if not isinstance(d, dict):
        return []
    kind = d.get("type")
    out = []
    if kind == "result":
        out.append(_turn_row(d, conv))
        return out
    if kind == "call-usage":
        # A model call's FINAL output count, written by the turn loop when the
        # call finished (routes/observatory.py) — the assistant lines only
        # carry a partial one.
        if d.get("message_id"):
            out.append({"kind": "call_usage", "message_id": d["message_id"],
                        "conv": conv, "parent_tool_use_id": d.get("parent_tool_use_id"),
                        "output_tokens": d.get("output_tokens"),
                        "thinking_tokens": d.get("thinking_tokens")})
        return out
    if kind not in ("assistant", "user"):
        return []
    at = _local(d.get("timestamp"))
    if at:
        out.append({"kind": "clock", "at": at})
    message = d.get("message")
    if not isinstance(message, dict):
        return out
    content = message.get("content")
    if not isinstance(content, list):
        return out
    session_id = d.get("session_id") or d.get("sessionId")
    parent = d.get("parent_tool_use_id")
    # One model call, from its usage. A call that writes several blocks
    # appears as several assistant lines with the same message id; each one
    # yields this row, and the upsert merges their tool ids.
    usage = message.get("usage")
    if kind == "assistant" and message.get("id") and isinstance(usage, dict):
        fresh = usage.get("input_tokens") or 0
        created = usage.get("cache_creation_input_tokens") or 0
        read = usage.get("cache_read_input_tokens") or 0
        out.append({
            "kind": "model_call",
            "message_id": message["id"],
            "conv": conv,
            "session_id": session_id,
            "parent_tool_use_id": parent,
            "at": at,
            "day": at[:10] if at else None,
            "model": message.get("model"),
            "input_tokens": fresh,
            "cache_creation_tokens": created,
            "cache_read_tokens": read,
            "context_tokens": fresh + created + read,
            "tool_use_ids": json.dumps([b.get("id") for b in content
                                        if isinstance(b, dict) and b.get("type") == "tool_use"
                                        and b.get("id")]),
        })
    for block in content:
        if not isinstance(block, dict):
            continue
        if kind == "assistant" and block.get("type") == "tool_use" and at:
            inp = block.get("input")
            raw = json.dumps(inp, sort_keys=True) if inp is not None else None
            truncated = 0
            if raw and len(raw) > _INPUT_CAP:
                raw, truncated = raw[:_INPUT_CAP], 1
            when = datetime.fromisoformat(at)
            out.append({
                "kind": "call",
                "tool_use_id": block.get("id"),
                "source": source,
                "conv": conv,
                "session_id": session_id,
                "parent_tool_use_id": parent,
                "at": at,
                "day": when.strftime("%Y-%m-%d"),
                "hour": when.hour,
                "name": block.get("name") or "?",
                "target": target_of(block.get("name"), inp),
                "input": raw,
                "input_truncated": truncated,
                "cwd": d.get("cwd"),
                "model": message.get("model"),
            })
        elif kind == "user" and block.get("type") == "tool_result" and at:
            out.append({
                "kind": "result",
                "tool_use_id": block.get("tool_use_id"),
                "result_at": at,
                "result_chars": _result_size(block),
                "is_error": 1 if block.get("is_error") else 0,
            })
    return [r for r in out if r.get("kind") != "call" or r.get("tool_use_id")]


def _turn_row(d, conv):
    """A `result` event -> the turn_results row, minus conv/seq/at, which the
    caller knows and this line doesn't."""
    usage = d.get("usage") if isinstance(d.get("usage"), dict) else {}
    details = usage.get("output_tokens_details")
    thinking = details.get("thinking_tokens") if isinstance(details, dict) else None
    models = d.get("modelUsage") if isinstance(d.get("modelUsage"), dict) else {}
    model = next(iter(models), None)
    return {
        "kind": "turn",
        "conv": conv,
        "session_id": d.get("session_id"),
        "subtype": d.get("subtype"),
        "stop_reason": d.get("stop_reason"),
        "is_error": 1 if d.get("is_error") else 0,
        "duration_ms": d.get("duration_ms"),
        "duration_api_ms": d.get("duration_api_ms"),
        "num_turns": d.get("num_turns"),
        "cost_usd": d.get("total_cost_usd"),
        "input_tokens": usage.get("input_tokens"),
        "cache_creation_tokens": usage.get("cache_creation_input_tokens"),
        "cache_read_tokens": usage.get("cache_read_input_tokens"),
        "output_tokens": usage.get("output_tokens"),
        "thinking_tokens": thinking,
        "model": model,
    }


def _conv_by_session():
    """Claude session uuid -> Observatory conversation id, from the index, so
    a call read from the harness transcript still joins to its session."""
    index = store.read("bot_chats/index", {})
    out = {}
    if isinstance(index, dict):
        for conv, meta in index.items():
            if isinstance(meta, dict) and meta.get("claude_session_id"):
                out[meta["claude_session_id"]] = conv
    return out


def scan_file(path, start=0, source="claude", conv=None, last_at=None):
    """Yield parsed rows from one log, resuming at byte `start`.

    Turn rows come out already dated with the last clock seen (`last_at`
    seeds it for a resumed scan). The final yielded item is
    {"kind": "end", "last_at": ..., "offset": ...} so the caller can store the
    clock and where reading stopped.

    Stop at the last WHOLE line. A log is read while its turn is still writing
    it (live_ingest), and a long line lands in more than one write, so the
    tail may be half a line; reading it now would lose it for good. `offset`
    is where the next scan picks up."""
    offset = start
    try:
        with open(path, "rb") as fh:
            if start:
                fh.seek(start)
            for raw in fh:
                if not raw.endswith(b"\n"):
                    break
                offset += len(raw)
                for row in parse_line(raw.decode("utf-8", "replace"), source, conv):
                    if row["kind"] == "clock":
                        last_at = row["at"]
                        continue
                    if row["kind"] == "turn":
                        row["at"] = last_at
                        row["day"] = last_at[:10] if last_at else None
                    yield row
    except OSError:
        pass
    yield {"kind": "end", "last_at": last_at, "offset": offset}


def _files(root, pattern):
    try:
        return sorted(p for p in Path(root).glob(pattern) if p.is_file())
    except OSError:
        return []


def _ingest_path(conn, path, source, conv, seen, conv_of, now, stats):
    """Fold whatever is new in one log into the tables — the per-file step
    both the hourly ingest and a live turn's live_ingest run."""
    key = str(path)
    try:
        size = path.stat().st_size
    except OSError:
        return
    before, last_at, seq = seen.get(key, (None, None, 0))
    if before is not None and before == size:
        stats["skipped"] += 1
        return
    # Grew -> resume where we stopped, clock in hand. Shrank -> it
    # was rewritten, so start over with no memory of it.
    if before is not None and before < size:
        start = before
    else:
        start, last_at, seq = 0, None, 0
        if before is not None:
            conn.execute("DELETE FROM turn_results WHERE conv = ?", (conv,))
    stats["files"] += 1
    sqlstore.begin_immediate(conn)
    try:
        for row in scan_file(path, start, source, conv, last_at):
            kind = row.pop("kind")
            if kind == "call":
                if row["conv"] is None and row["session_id"] in conv_of:
                    row["conv"] = conv_of[row["session_id"]]
                cur = conn.execute(
                    "INSERT OR IGNORE INTO tool_calls"
                    " (tool_use_id, source, conv, session_id,"
                    "  parent_tool_use_id, at, day, hour, name, target,"
                    "  input, input_truncated, cwd, model)"
                    " VALUES (:tool_use_id, :source, :conv, :session_id,"
                    "  :parent_tool_use_id, :at, :day, :hour, :name,"
                    "  :target, :input, :input_truncated, :cwd, :model)",
                    row)
                stats["calls"] += cur.rowcount
            elif kind == "result":
                # Duration is computed against the stored call, and
                # only the first result for a call counts.
                cur = conn.execute(
                    "UPDATE tool_calls SET result_at = :result_at,"
                    "  result_chars = :result_chars, is_error = :is_error,"
                    "  duration_ms = CAST((julianday(:result_at)"
                    "    - julianday(at)) * 86400000 AS INTEGER)"
                    " WHERE tool_use_id = :tool_use_id"
                    "   AND result_at IS NULL",
                    row)
                stats["results"] += cur.rowcount
            elif kind == "model_call":
                if row["conv"] is None and row["session_id"] in conv_of:
                    row["conv"] = conv_of[row["session_id"]]
                # Merge this line's tool ids into the call's list; keep any
                # output count a call-usage line already stored.
                conn.execute(
                    "INSERT INTO model_calls (message_id, conv, session_id,"
                    "  parent_tool_use_id, at, day, model, input_tokens,"
                    "  cache_creation_tokens, cache_read_tokens, context_tokens,"
                    "  tool_use_ids)"
                    " VALUES (:message_id, :conv, :session_id, :parent_tool_use_id,"
                    "  :at, :day, :model, :input_tokens, :cache_creation_tokens,"
                    "  :cache_read_tokens, :context_tokens, :tool_use_ids)"
                    " ON CONFLICT(message_id) DO UPDATE SET"
                    "  conv = COALESCE(model_calls.conv, excluded.conv),"
                    "  session_id = COALESCE(model_calls.session_id, excluded.session_id),"
                    "  at = COALESCE(model_calls.at, excluded.at),"
                    "  day = COALESCE(model_calls.day, excluded.day),"
                    "  model = COALESCE(model_calls.model, excluded.model),"
                    "  input_tokens = excluded.input_tokens,"
                    "  cache_creation_tokens = excluded.cache_creation_tokens,"
                    "  cache_read_tokens = excluded.cache_read_tokens,"
                    "  context_tokens = excluded.context_tokens,"
                    "  tool_use_ids = (SELECT json_group_array(value) FROM ("
                    "    SELECT value FROM json_each(model_calls.tool_use_ids)"
                    "    UNION SELECT value FROM json_each(excluded.tool_use_ids)))",
                    row)
                stats["model_calls"] = stats.get("model_calls", 0) + 1
            elif kind == "call_usage":
                conn.execute(
                    "INSERT INTO model_calls (message_id, conv, parent_tool_use_id,"
                    "  output_tokens, thinking_tokens)"
                    " VALUES (:message_id, :conv, :parent_tool_use_id,"
                    "  :output_tokens, :thinking_tokens)"
                    " ON CONFLICT(message_id) DO UPDATE SET"
                    "  output_tokens = excluded.output_tokens,"
                    "  thinking_tokens = excluded.thinking_tokens",
                    row)
            elif kind == "turn" and conv is not None:
                seq += 1
                row["seq"] = seq
                cur = conn.execute(
                    "INSERT OR IGNORE INTO turn_results"
                    " (conv, seq, session_id, at, day, subtype,"
                    "  stop_reason, is_error, duration_ms,"
                    "  duration_api_ms, num_turns, cost_usd,"
                    "  input_tokens, cache_creation_tokens,"
                    "  cache_read_tokens, output_tokens,"
                    "  thinking_tokens, model)"
                    " VALUES (:conv, :seq, :session_id, :at, :day,"
                    "  :subtype, :stop_reason, :is_error,"
                    "  :duration_ms, :duration_api_ms, :num_turns,"
                    "  :cost_usd, :input_tokens,"
                    "  :cache_creation_tokens, :cache_read_tokens,"
                    "  :output_tokens, :thinking_tokens, :model)",
                    row)
                stats["turns"] += cur.rowcount
            elif kind == "end":
                last_at = row["last_at"]
                # Store where reading stopped, not the file's size: a half
                # line at the tail is picked up whole next time.
                size = row["offset"]
        conn.execute(
            "INSERT INTO tool_call_sources"
            " (path, size, scanned_at, last_at, results)"
            " VALUES (?, ?, ?, ?, ?)"
            " ON CONFLICT(path) DO UPDATE SET size = excluded.size,"
            "  scanned_at = excluded.scanned_at,"
            "  last_at = excluded.last_at, results = excluded.results",
            (key, size, now, last_at, seq))
        conn.execute("COMMIT")
    except BaseException:
        conn.execute("ROLLBACK")
        raise


def ingest(bot_chats=None, projects=None):
    """Fold every new log line into tool_calls and turn_results.

    Returns {"files", "skipped", "calls", "results", "turns"}. Safe on any
    schedule: unchanged files cost one stat() each, and re-reading a line
    that's already stored changes nothing.
    """
    bot_chats = Path(bot_chats) if bot_chats else bot_chats_dir()
    projects = Path(projects) if projects else commandstore.projects_dir()
    conv_of = _conv_by_session()
    stats = {"files": 0, "skipped": 0, "calls": 0, "results": 0, "turns": 0}
    # bot_chats first, so an Observatory call is labelled by the record the
    # app itself wrote; the harness's copy of the same call then no-ops.
    # Subagent transcripts sit one level down in the harness tree.
    plan = [(p, "observatory", p.stem) for p in _files(bot_chats, "*.jsonl")]
    plan += [(p, "claude", None) for p in _files(projects, "*/*.jsonl")]
    plan += [(p, "claude", None) for p in _files(projects, "*/*/*.jsonl")]
    plan += [(p, "claude", None) for p in _files(projects, "*/*/*/*.jsonl")]
    conn = sqlstore.open_db()
    try:
        seen = {r[0]: (r[1], r[2], r[3]) for r in conn.execute(
            "SELECT path, size, last_at, results FROM tool_call_sources")}
        now = datetime.now().isoformat(timespec="seconds")
        for path, source, conv in plan:
            _ingest_path(conn, path, source, conv, seen, conv_of, now, stats)
        return stats
    finally:
        conn.close()


def live_ingest(path, conv):
    """Fold what's new in ONE Observatory log into the tables, now — called
    every few seconds by a running turn (routes/observatory.py), so tool calls
    land in SQL as they happen instead of at the next hourly ingest. Same
    watermark as the hourly pass, so the two never count a call twice and
    either one can pick up where the other stopped."""
    path = Path(path)
    stats = {"files": 0, "skipped": 0, "calls": 0, "results": 0, "turns": 0}
    conn = sqlstore.open_db()
    try:
        row = conn.execute(
            "SELECT size, last_at, results FROM tool_call_sources WHERE path = ?",
            (str(path),)).fetchone()
        seen = {str(path): tuple(row)} if row else {}
        now = datetime.now().isoformat(timespec="seconds")
        _ingest_path(conn, path, "observatory", conv, seen, {}, now, stats)
        return stats
    finally:
        conn.close()


def rebuild(bot_chats=None, projects=None):
    """Drop everything and re-read every log from the top. A full pass over
    the corpus (gigabytes) — only for a change in the parsing rules."""
    conn = sqlstore.open_db()
    try:
        sqlstore.begin_immediate(conn)
        conn.execute("DELETE FROM tool_calls")
        conn.execute("DELETE FROM model_calls")
        conn.execute("DELETE FROM turn_results")
        conn.execute("DELETE FROM tool_call_sources")
        conn.execute("COMMIT")
    finally:
        conn.close()
    return ingest(bot_chats, projects)


def _open():
    conn = sqlstore.open_db()
    conn.row_factory = sqlite3.Row
    return conn


def summary(days=None):
    """One row per tool: calls, days used, errors, median-ish duration."""
    where, params = "", []
    if days:
        since = (datetime.now().date().toordinal() - days + 1)
        where = " WHERE day >= ?"
        params.append(datetime.fromordinal(since).strftime("%Y-%m-%d"))
    conn = _open()
    try:
        rows = conn.execute(
            "SELECT name, COUNT(*) AS calls, COUNT(DISTINCT day) AS days,"
            "       SUM(COALESCE(is_error, 0)) AS errors,"
            "       CAST(AVG(duration_ms) AS INTEGER) AS avg_ms,"
            "       SUM(CASE WHEN result_at IS NULL THEN 1 ELSE 0 END) AS unanswered"
            f" FROM tool_calls{where} GROUP BY name ORDER BY calls DESC",
            params).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()
