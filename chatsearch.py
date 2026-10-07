"""Search over everything said in the Observatory's chats — the engine behind
the chat search box.

**What this does.** Finds the sessions where a set of words was said, by the
owner or by the agent, across every session ever held (closed ones included),
and hands back a few marked excerpts from each. A second search, `search_tools`,
finds sessions by what the agent DID instead: the files it edited, the commands
it ran.

**How.** Every conversation is one log file of raw events
(data/bot_chats/<conv>.jsonl), and most of each file is machinery: tool
results, progress ticks, token counts. This module reads only the spoken
lines out of those files and keeps them in a word index in exo.db
(`chat_lines_fts`, SQLite's built-in full-text search), so a search reads the
index and never the files. `chat_line_sources` remembers how far into each
file has been read, so only what's new since last time is read again.

**The index is DERIVED.** Every row can be re-read from the logs, so
`rebuild()` may wipe it and start over. The logs stay the record.

**Kept up to date three ways.** A search first reads whatever was said since
the last one (`catch_up`), so a line typed a minute ago is findable. The
hourly cron (scripts/usage_events.py) reads everything that's new. And
`rebuild()` re-reads the lot, for a change in the reading rules.

**What you can type** (the query parsing is textsearch.parse_query, the same
as the journal and Research searches):
  - plain words: every one must appear in the same line, in any order. Each
    word also matches longer words that start with it ("hous" finds
    "housing"), and word endings are folded ("bartending" finds "bartender").
  - "a quoted phrase": those words, side by side, in that order.
  - -word: leave out lines containing it.

Touches: `sqlstore.py` (owns the schema, rung 51, and the connection),
`store.py` (DATA_DIR for bot_chats), `textsearch.py` (query parsing),
`routes/chat_search.py` (the HTTP door), `scripts/usage_events.py` (the
hourly read). The tool search reads `tool_calls`, which toolcallstore.py
fills.

Prompt that produced this file: "Need some kind of search function for chats
and to be able to see the last ones I had opened in the observatory."
"""
import json
import re
from datetime import datetime, timezone
from pathlib import Path

import sqlstore
import store
import textsearch

# One letter matches nearly everything; not a search.
MIN_QUERY = 2
# How many sessions one search answers with, newest first.
_MAX_SESSIONS = 60
# Excerpts shown per session: enough to recognise the conversation, not read it.
_HITS_PER_SESSION = 3
# Excerpt length, in words, around the best-matching spot.
_SNIPPET_WORDS = 24
# Characters kept either side of a match in a tool-call excerpt.
_TOOL_SNIPPET_PAD = 70
# Markers FTS5 wraps around each hit inside an excerpt. Control characters,
# so they can't collide with anything typed; split out again below.
_HIT_START = "\x02"
_HIT_END = "\x03"
# How many unread bytes a search is willing to read before answering. Past
# this the search answers from what's indexed and says it is still catching up.
CATCH_UP_BUDGET = 40 * 1024 * 1024
# The position of the `text` column in chat_lines_fts, for snippet().
_TEXT_COLUMN = 4


def bot_chats_dir():
    """Resolved at call time so tests get an isolated data dir."""
    return store.DATA_DIR / "bot_chats"


# --- Reading the logs ------------------------------------------------------

def _local(stamp):
    """A log line's timestamp as local naive ISO to the second. The agent's
    lines are stamped in UTC with a trailing Z; the owner's are already local.
    Returns None for anything unparseable."""
    if not isinstance(stamp, str) or not stamp:
        return None
    try:
        moment = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
    except ValueError:
        return None
    if moment.tzinfo is not None:
        moment = moment.astimezone().replace(tzinfo=None)
    return moment.isoformat(timespec="seconds")


def _prose(message):
    """The words out of one agent message. `content` is either a string or a
    list of blocks, of which only the text ones carry words, so a message that
    was nothing but tool calls comes back empty."""
    if not isinstance(message, dict):
        return ""
    content = message.get("content")
    if isinstance(content, str):
        return content.strip()
    if not isinstance(content, list):
        return ""
    parts = [block.get("text") for block in content
             if isinstance(block, dict) and block.get("type") == "text"
             and isinstance(block.get("text"), str) and block.get("text").strip()]
    return "\n\n".join(parts).strip()


def spoken_line(raw):
    """One log line (bytes) -> (who, at, text) if it is something SAID, else None.

    Only speech counts: the owner's typed messages ("B") and the agent's prose
    replies ("K"). Tool calls, tool results and usage records are machinery;
    they would match a file name thousands of times and bury the one moment
    she meant. A `user` event carrying `message` is the agent echoing a tool
    result back to itself, and an agent line with `parent_tool_use_id` is a
    subagent talking to the agent that launched it, so both are skipped.

    Most lines are machinery, so a cheap look at the start of the line rules
    them out before any JSON parsing. That is what keeps reading a gigabyte of
    logs to minutes."""
    head = raw[:80]
    is_agent = b'"type": "assistant"' in head or b'"type":"assistant"' in head
    is_owner = b'"type": "user"' in head or b'"type":"user"' in head
    if not is_agent and not is_owner:
        return None
    if is_owner and (b'"message"' in head or b'"tool_result"' in head):
        return None
    try:
        event = json.loads(raw)
    except ValueError:
        return None
    if not isinstance(event, dict):
        return None
    if event.get("type") == "assistant":
        if event.get("parent_tool_use_id"):
            return None
        text = _prose(event.get("message"))
        return ("K", _local(event.get("timestamp")), text) if text else None
    if event.get("type") == "user":
        text = event.get("text")
        if isinstance(text, str) and text.strip():
            return ("B", _local(event.get("ts")), text.strip())
    return None


def _read_new(path, start):
    """The spoken lines in one log from byte `start` on, and where reading
    stopped: ([(who, at, text)], offset).

    Stop at the last WHOLE line. A log is read while its turn is still writing
    it, so the tail may be half a line; reading it now would lose it for good.
    `offset` is where the next read picks up."""
    lines = []
    offset = start
    with open(path, "rb") as handle:
        if start:
            handle.seek(start)
        for raw in handle:
            if not raw.endswith(b"\n"):
                break
            offset += len(raw)
            spoken = spoken_line(raw)
            if spoken:
                lines.append(spoken)
    return lines, offset


def _ingest_path(conn, path, seen, stats):
    """Fold what's new in ONE log into the index.

    This is a watermark, the same one toolcallstore.py uses: a file whose size
    hasn't changed is skipped on a stat(); one that grew is reopened where the
    last read stopped; one that shrank was rewritten, so its lines are dropped
    and it is read from the top.

    The file is read BEFORE the write lock is taken, so parsing a large log
    never holds up another writer. The watermark is then checked again inside
    the transaction: if another process indexed this file in the meantime,
    this read is thrown away rather than stored twice."""
    key = str(path)
    conv = path.stem
    try:
        size = path.stat().st_size
    except OSError:
        return
    start, turn = seen.get(key, (0, 0))
    if size == start:
        stats["skipped"] += 1
        return
    rewritten = size < start
    if rewritten:
        start, turn = 0, 0
    try:
        lines, offset = _read_new(path, start)
    except OSError:
        return
    if offset == start and not rewritten:
        stats["skipped"] += 1
        return
    sqlstore.begin_immediate(conn)
    try:
        row = conn.execute(
            "SELECT size, lines FROM chat_line_sources WHERE path = ?", (key,)).fetchone()
        if tuple(row or (0, 0)) != seen.get(key, (0, 0)):
            conn.execute("ROLLBACK")
            return
        if rewritten:
            conn.execute("DELETE FROM chat_lines_fts WHERE conv = ?", (conv,))
        conn.executemany(
            "INSERT INTO chat_lines_fts (conv, turn, who, at, text) VALUES (?, ?, ?, ?, ?)",
            [(conv, turn + number, who, at, text)
             for number, (who, at, text) in enumerate(lines)])
        conn.execute(
            "INSERT INTO chat_line_sources (path, conv, size, lines, scanned_at)"
            " VALUES (?, ?, ?, ?, ?)"
            " ON CONFLICT(path) DO UPDATE SET size = excluded.size,"
            "  lines = excluded.lines, scanned_at = excluded.scanned_at",
            (key, conv, offset, turn + len(lines),
             datetime.now().isoformat(timespec="seconds")))
        conn.execute("COMMIT")
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    seen[key] = (offset, turn + len(lines))
    stats["files"] += 1
    stats["lines"] += len(lines)


def ingest(bot_chats=None, budget=None):
    """Fold every new spoken line into the index.

    Returns {"files", "skipped", "lines", "behind"}. Safe on any schedule:
    unchanged files cost one stat() each. With a `budget` (in bytes) it reads
    the most recently written logs first and stops once that much has been
    read; `behind` is how many changed logs were left for next time.
    """
    bot_chats = Path(bot_chats) if bot_chats else bot_chats_dir()
    stats = {"files": 0, "skipped": 0, "lines": 0, "behind": 0}
    if not bot_chats.is_dir():
        return stats
    conn = sqlstore.open_db()
    try:
        seen = {row[0]: (row[1], row[2]) for row in conn.execute(
            "SELECT path, size, lines FROM chat_line_sources")}
        # Work out which logs changed, newest first, so a read that runs out
        # of budget has covered the conversations most likely to be searched.
        changed = []
        for path in bot_chats.glob("*.jsonl"):
            try:
                status = path.stat()
            except OSError:
                continue
            read_to = seen.get(str(path), (0, 0))[0]
            if status.st_size == read_to:
                stats["skipped"] += 1
                continue
            unread = status.st_size - read_to if status.st_size > read_to else status.st_size
            changed.append((status.st_mtime, unread, path))
        changed.sort(key=lambda item: item[0], reverse=True)
        spent = 0
        for position, (_, unread, path) in enumerate(changed):
            if budget is not None and spent and spent + unread > budget:
                stats["behind"] = len(changed) - position
                break
            spent += unread
            _ingest_path(conn, path, seen, stats)
    finally:
        conn.close()
    return stats


def catch_up():
    """Index what was said since the last search, so a line typed a minute ago
    is findable. Bounded by CATCH_UP_BUDGET: on an install whose history has
    never been indexed, a search answers from what it has rather than making
    her wait for the whole back-fill. Returns ingest()'s stats."""
    return ingest(budget=CATCH_UP_BUDGET)


def rebuild(bot_chats=None):
    """Wipe the index and re-read every log from the top. A full pass over the
    logs, only for a change in the reading rules."""
    conn = sqlstore.open_db()
    try:
        sqlstore.begin_immediate(conn)
        conn.execute("DELETE FROM chat_lines_fts")
        conn.execute("DELETE FROM chat_line_sources")
        conn.execute("COMMIT")
    finally:
        conn.close()
    return ingest(bot_chats)


# --- Searching -------------------------------------------------------------

def _quote(text):
    """Quote a word or phrase for FTS5, which reads anything bare as syntax.
    A double quote inside is escaped by doubling it, FTS5's own rule."""
    return '"' + text.replace('"', '""') + '"'


def to_fts_query(q):
    """Turn what she typed into an FTS5 query, or None if nothing to search.

    Every piece is quoted, so a stray `(`, `:` or `AND` in her words is read as
    text, never as FTS5 syntax, and can't make the search error out. Each plain
    word gets a `*` outside its quotes, where FTS5 reads it as "starts with":
    this box searches as she types, so a half-typed word has to find the whole
    one. Exclusions need at least one thing to include: FTS5's NOT is "this but
    not that", so a query of only -words returns None.
    """
    parsed = textsearch.parse_query(q)
    include = [_quote(phrase) for phrase in parsed["phrases"]]
    for term in parsed["terms"]:
        word = term.rstrip("*")
        if word:
            include.append(_quote(word) + "*")
    if not include:
        return None
    query = " AND ".join(include)
    for word in parsed["excluded"]:
        word = word.rstrip("*")
        if word:
            query += " NOT " + _quote(word)
    return query


def _split_snippet(marked):
    """FTS5's marked excerpt -> [{"text", "hit"}] pieces, so the page can bold
    the hits without ever treating chat text as HTML."""
    pieces = []
    rest = marked
    while rest:
        start = rest.find(_HIT_START)
        if start == -1:
            pieces.append({"text": rest, "hit": False})
            break
        if start:
            pieces.append({"text": rest[:start], "hit": False})
        end = rest.find(_HIT_END, start)
        if end == -1:
            pieces.append({"text": rest[start + 1:], "hit": True})
            break
        pieces.append({"text": rest[start + 1:end], "hit": True})
        rest = rest[end + 1:]
    return pieces


def _mark_words(text, words, pad=_TOOL_SNIPPET_PAD):
    """A window of `text` around the first of `words`, as [{"text", "hit"}]
    pieces with every one of the words marked. Whitespace is collapsed first so
    a multi-line command arrives as one line."""
    flat = " ".join(text.split())
    lowered = flat.lower()
    found = [lowered.find(word) for word in words if word and word in lowered]
    first = min(found) if found else 0
    start = max(0, first - pad)
    end = min(len(flat), first + pad * 2)
    window = flat[start:end]
    pattern = "|".join(re.escape(word) for word in sorted(words, key=len, reverse=True) if word)
    pieces = []
    if start > 0:
        pieces.append({"text": "…", "hit": False})
    position = 0
    for match in (re.finditer(pattern, window, re.IGNORECASE) if pattern else ()):
        if match.start() > position:
            pieces.append({"text": window[position:match.start()], "hit": False})
        pieces.append({"text": match.group(0), "hit": True})
        position = match.end()
    if position < len(window):
        pieces.append({"text": window[position:], "hit": False})
    if end < len(flat):
        pieces.append({"text": "…", "hit": False})
    return pieces


def _session(conv, meta, lane_of):
    """One session's row in a search answer: what the page needs to name it
    and say which room it's in and whether it's closed."""
    return {
        "id": conv,
        "title": meta.get("title") or conv,
        "title_hit": False,
        "lane": lane_of(meta),
        "journal": meta.get("journal") is True,
        "archived": bool(meta.get("archived")),
        "pinned": bool(meta.get("pinned")),
        "started": meta.get("started"),
        "last_at": meta.get("last_at"),
        "count": 0,
        "hits": [],
    }


def _newest_first(sessions, limit):
    """Sort the matching sessions by when they were last said in, newest
    first, and cut to `limit`. Returns (shown, truncated)."""
    sessions.sort(key=lambda s: s.get("last_at") or s.get("started") or "", reverse=True)
    return sessions[:limit], len(sessions) > limit


def search(q, index, lane_of, limit=_MAX_SESSIONS):
    """Search everything said. Returns {"results", "truncated"}.

    `index` is the session index (conv id -> its entry) and `lane_of` turns an
    entry into its room; both are passed in so this module needs nothing from
    the routes. One result per session that matches, newest first, each with
    how many of its lines matched (`count`) and up to _HITS_PER_SESSION
    excerpts. A session also matches when every word is in its NAME, since
    "the housing one" is a real way to look for a conversation that may never
    say "housing" inside. Raises ValueError for a query with nothing to
    include.
    """
    match = to_fts_query(q)
    if match is None:
        raise ValueError("empty query")
    conn = sqlstore.open_db()
    try:
        # Find every matching line and which session it is in. No excerpts
        # yet: a common word matches tens of thousands of lines, and an
        # excerpt is only worth building for the few that get shown.
        by_conv = {}
        for rowid, conv in conn.execute(
                "SELECT rowid, conv FROM chat_lines_fts"
                " WHERE chat_lines_fts MATCH ? ORDER BY rowid", (match,)):
            by_conv.setdefault(conv, []).append(rowid)

        # A session matches by name when every word she typed is in its title.
        parsed = textsearch.parse_query(q)
        wanted = [word.rstrip("*") for word in parsed["terms"]] + \
                 [phrase.lower() for phrase in parsed["phrases"]]
        sessions = []
        for conv, meta in index.items():
            if not isinstance(meta, dict):
                continue
            title = (meta.get("title") or "").lower()
            title_hit = bool(wanted) and all(word in title for word in wanted) \
                and not any(word in title for word in parsed["excluded"])
            if conv not in by_conv and not title_hit:
                continue
            session = _session(conv, meta, lane_of)
            session["title_hit"] = title_hit
            session["count"] = len(by_conv.get(conv, ()))
            sessions.append(session)
        shown, truncated = _newest_first(sessions, limit)

        # Build the excerpts, only for the first few lines of the sessions
        # that made the cut.
        first_lines = [rowid for session in shown
                       for rowid in by_conv.get(session["id"], ())[:_HITS_PER_SESSION]]
        hits = {}
        for start in range(0, len(first_lines), 400):
            batch = first_lines[start:start + 400]
            marks = ",".join("?" * len(batch))
            for conv, turn, who, at, marked in conn.execute(
                    "SELECT conv, turn, who, at,"
                    f"  snippet(chat_lines_fts, {_TEXT_COLUMN}, ?, ?, '…', {_SNIPPET_WORDS})"
                    " FROM chat_lines_fts"
                    f" WHERE chat_lines_fts MATCH ? AND rowid IN ({marks})"
                    " ORDER BY rowid",
                    (_HIT_START, _HIT_END, match, *batch)):
                flat = " ".join((marked or "").split())
                hits.setdefault(conv, []).append(
                    {"who": who, "turn": turn, "said_at": at, "pieces": _split_snippet(flat)})
        for session in shown:
            session["hits"] = hits.get(session["id"], [])
        return {"results": shown, "truncated": truncated}
    finally:
        conn.close()


def search_tools(q, index, lane_of, limit=_MAX_SESSIONS):
    """Search what the agents DID. Returns {"results", "truncated"}.

    Looks through `tool_calls.target`: the file a tool read or edited, the
    command it ran, the pattern it searched for. Every word she typed must
    appear somewhere in the target, as a plain fragment (so part of a file
    name is enough). Same answer shape as `search`: one result per session,
    newest first, with how many calls matched and the latest few as excerpts,
    where `who` is the tool's name.
    """
    words = [word for word in q.lower().split() if word]
    if not words:
        raise ValueError("empty query")
    # Escape LIKE's own wildcards, so a typed % or _ is matched as itself.
    patterns = ["%" + word.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
                for word in words]
    where = " AND ".join("target LIKE ? ESCAPE '\\'" for _ in patterns)
    conn = sqlstore.open_db()
    try:
        by_conv = {}
        for conv, name, target, at in conn.execute(
                "SELECT conv, name, target, at FROM tool_calls"
                f" WHERE conv IS NOT NULL AND {where} ORDER BY at DESC", patterns):
            by_conv.setdefault(conv, []).append((name, target, at))
    finally:
        conn.close()
    sessions = []
    for conv, calls in by_conv.items():
        meta = index.get(conv)
        if not isinstance(meta, dict):
            continue
        session = _session(conv, meta, lane_of)
        session["count"] = len(calls)
        # The same file edited forty times is one thing to show, not forty.
        shown_targets = set()
        for name, target, at in calls:
            if (name, target) in shown_targets:
                continue
            shown_targets.add((name, target))
            session["hits"].append({"who": name, "turn": None, "said_at": at,
                                    "pieces": _mark_words(target, words)})
            if len(session["hits"]) >= _HITS_PER_SESSION:
                break
        sessions.append(session)
    shown, truncated = _newest_first(sessions, limit)
    return {"results": shown, "truncated": truncated}
