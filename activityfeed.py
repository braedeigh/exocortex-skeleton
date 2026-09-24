"""A session's activity, step by step — what the agent did, with the outputs.

**What this is for.** The Observatory's session page shows the conversation:
her messages and the agent's replies, with each tool reduced to a friendly
label. When a turn stalls, drops, or fails, the reason is almost never in the
reply. It's in the steps underneath: a command that errored, an API retry, a
permission the classifier refused, a tool that's been running for four
minutes. This module reads those steps back out of the transcript so the
Activity pane (frontend/src/features/activity/) can show them live, outputs
included.

**Where it reads from.** `data/bot_chats/<conv>.jsonl`, the one raw event
stream the app writes for every Observatory turn (routes/observatory.py
`_run_turn`). It is flushed one event per line as the turn runs, so reading
it again a second later picks up whatever just happened. The SQL tables in
toolcallstore.py hold the same tool calls, but an hourly cron fills them and
they keep only the size of each result, not its text. So this reads the file
directly, the way the Workshop's flow feed does.

**The shape.** `parse_line()` turns one log line into zero or more small,
flat events, each tagged with a `kind`:

    prompt    her message
    init      a turn's harness starting (model, working directory)
    said      the agent's visible text
    thought   the agent's thinking, when the log carries its text
    call      a tool call: which tool, on what, the input
    result    a tool's output, matched to its call by `id`
    progress  "this tool is still running", with seconds elapsed
    denied    a permission refused, and why
    task      a background task starting or finishing
    retry     an API retry (overloaded, rate limited, …)
    limit     a rate-limit warning (only when it isn't plain "allowed")
    end       a turn's final result: how it ended, how long, what it cost
    error     the app's own "claude exited" line
    note      any other system event, by name, so nothing is silently hidden

The frontend folds these into steps (activityMath.ts). Pairing a call with
its result happens there, because a result can arrive in a later poll than
its call.

**What's capped.** Inputs and outputs are cut at _TEXT_CAP characters so a
session that read a hundred whole files doesn't ship megabytes on every
poll. `full_output()` reads one result back uncut, for the "show all" button.

Touches: routes/observatory.py (serves it at
/api/observatory/conversation/<id>/activity), toolcallstore.py (borrows its
`target_of` and its UTC→local clock), tests/test_activityfeed.py.

Prompt that produced this file: "i want something like the workshop, but for
tool call usage … a new button on an individual session … it opens the
activity of the session … i want for all of the outputs to be visible as
it's working so that i can visualize what's going on and why things might
drop or fail."
"""
import json

from toolcallstore import _local, target_of

# How much of any one input or output travels with the feed, in characters.
_TEXT_CAP = 3000
# System events that fire constantly and say nothing about why a turn went
# wrong: token counters, "requesting…" pings, subagent progress ticks.
_QUIET_SUBTYPES = {"thinking_tokens", "status", "task_progress", "task_updated",
                   "background_tasks_changed"}


def _cap(text):
    """Cut a string to _TEXT_CAP. Returns (text, was_cut)."""
    if text is None:
        return None, False
    if len(text) > _TEXT_CAP:
        return text[:_TEXT_CAP], True
    return text, False


def result_text(block):
    """A tool_result's content as plain text, whether a string or blocks.

    Images can't be shown as text, so each becomes a placeholder line."""
    content = block.get("content")
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    parts = []
    for part in content:
        if not isinstance(part, dict):
            continue
        if part.get("type") == "text":
            parts.append(part.get("text", ""))
        elif part.get("type") == "image":
            parts.append("[image]")
    return "\n".join(parts)


def parse_line(line):
    """One transcript line -> a list of activity events. Pure, file-free.

    Returns [] for a line that doesn't parse or carries nothing worth
    showing. Events from inside a subagent carry `parent`: the id of the
    Agent call that spawned it."""
    try:
        d = json.loads(line)
    except (ValueError, TypeError):
        return []
    if not isinstance(d, dict):
        return []
    kind = d.get("type")
    at = _local(d.get("timestamp"))

    # Her own message. The app writes it with a local `ts` already.
    if kind == "user" and isinstance(d.get("text"), str):
        return [{"kind": "prompt", "at": d.get("ts"), "text": d["text"]}]

    # The agent's side and the tool outputs share one shape: a message with
    # a list of content blocks, each turned into its own event.
    if kind in ("assistant", "user"):
        message = d.get("message")
        content = message.get("content") if isinstance(message, dict) else None
        if not isinstance(content, list):
            return []
        parent = d.get("parent_tool_use_id")
        out = []
        for block in content:
            if not isinstance(block, dict):
                continue
            btype = block.get("type")
            if kind == "assistant" and btype == "text" and block.get("text"):
                out.append({"kind": "said", "at": at, "parent": parent,
                            "text": block["text"]})
            elif kind == "assistant" and btype == "thinking" and block.get("thinking"):
                out.append({"kind": "thought", "at": at, "parent": parent,
                            "text": block["thinking"]})
            elif kind == "assistant" and btype == "tool_use" and block.get("id"):
                inp = block.get("input")
                raw = json.dumps(inp, indent=1) if inp is not None else None
                raw, cut = _cap(raw)
                out.append({"kind": "call", "at": at, "parent": parent,
                            "id": block["id"], "name": block.get("name") or "?",
                            "target": target_of(block.get("name"), inp),
                            "input": raw, "input_cut": cut})
            elif kind == "user" and btype == "tool_result":
                full = result_text(block)
                text, cut = _cap(full)
                out.append({"kind": "result", "at": at, "parent": parent,
                            "id": block.get("tool_use_id"),
                            "output": text, "output_cut": cut,
                            "chars": len(full),
                            "is_error": bool(block.get("is_error"))})
        return out

    # A tool that's still going. The heartbeat's own id is synthetic; the
    # real call is its parent.
    if kind == "tool_progress":
        return [{"kind": "progress", "id": d.get("parent_tool_use_id"),
                 "elapsed": d.get("elapsed_time_seconds")}]

    # How the turn ended. `result` holds the final text, or the error.
    if kind == "result":
        text, _ = _cap(d.get("result") if isinstance(d.get("result"), str) else None)
        return [{"kind": "end", "subtype": d.get("subtype"),
                 "is_error": bool(d.get("is_error")),
                 "reason": d.get("terminal_reason") or d.get("stop_reason"),
                 "duration_ms": d.get("duration_ms"),
                 "turns": d.get("num_turns"),
                 "cost_usd": d.get("total_cost_usd"),
                 "text": text}]

    if kind == "error":
        return [{"kind": "error", "text": str(d.get("error") or "unknown error")}]

    # Only a rate limit that's actually biting is worth a row.
    if kind == "rate_limit_event":
        info = d.get("rate_limit_info") if isinstance(d.get("rate_limit_info"), dict) else {}
        if info.get("status") in (None, "allowed"):
            return []
        return [{"kind": "limit", "status": info.get("status"),
                 "window": info.get("rateLimitType"),
                 "resets_at": info.get("resetsAt")}]

    if kind != "system":
        return []

    # System events: the handful that explain a drop get their own kind;
    # the constant chatter is skipped; anything else is named, not hidden.
    subtype = d.get("subtype")
    if subtype in _QUIET_SUBTYPES:
        return []
    if subtype == "init":
        return [{"kind": "init", "model": d.get("model"), "cwd": d.get("cwd")}]
    if subtype == "api_retry":
        return [{"kind": "retry", "attempt": d.get("attempt"),
                 "max": d.get("max_retries"), "error": d.get("error"),
                 "status": d.get("error_status"),
                 "delay_ms": d.get("retry_delay_ms")}]
    if subtype == "permission_denied":
        return [{"kind": "denied", "id": d.get("tool_use_id"),
                 "tool": d.get("tool_name"),
                 "reason": d.get("decision_reason"),
                 "text": d.get("message")}]
    if subtype in ("task_started", "task_notification"):
        return [{"kind": "task", "id": d.get("tool_use_id"),
                 "task": d.get("task_id"),
                 "status": "started" if subtype == "task_started" else d.get("status"),
                 "text": d.get("description") or d.get("summary")}]
    return [{"kind": "note", "subtype": subtype}]


def read_since(path, offset, window):
    """Activity events from the complete lines after byte `offset`.

    Returns (events, start, next_offset, clipped): `start` is where the read
    really began, which differs from `offset` after a clip or a rewrite. A last line with no newline yet
    is a write in progress and is left for the next read. On a first read
    (offset 0) of a file bigger than `window` bytes, only the last `window`
    bytes are read — a long session's opening hours aren't what she's
    watching — and `clipped` says so."""
    clipped = False
    try:
        with open(path, "rb") as fh:
            size = fh.seek(0, 2)
            # The file shrank: it was rewritten. Start over.
            if offset > size:
                offset = 0
            if offset == 0 and size > window:
                offset, clipped = size - window, True
            fh.seek(offset)
            chunk = fh.read()
    except OSError:
        return [], offset, offset, False
    # Start a clipped read on a line boundary, not mid-line.
    if clipped:
        first = chunk.find(b"\n")
        if first == -1:
            return [], offset, offset, clipped
        offset += first + 1
        chunk = chunk[first + 1:]
    end = chunk.rfind(b"\n")
    if end == -1:
        return [], offset, offset, clipped
    whole = chunk[: end + 1]
    events = []
    for line in whole.decode("utf-8", "replace").splitlines():
        events.extend(parse_line(line))
    return events, offset, offset + len(whole), clipped


def full_output(path, tool_use_id):
    """One tool's output, uncut, found by its call id. None if absent."""
    needle = tool_use_id.encode()
    try:
        with open(path, "rb") as fh:
            for raw in fh:
                if needle not in raw or b'"tool_result"' not in raw:
                    continue
                try:
                    d = json.loads(raw)
                except ValueError:
                    continue
                message = d.get("message") if isinstance(d, dict) else None
                content = message.get("content") if isinstance(message, dict) else None
                for block in content if isinstance(content, list) else []:
                    if (isinstance(block, dict) and block.get("type") == "tool_result"
                            and block.get("tool_use_id") == tool_use_id):
                        return result_text(block)
    except OSError:
        pass
    return None
