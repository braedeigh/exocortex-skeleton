"""Bot surface API — slice S1 of docs/bot-surface-design (the "pipe").

A bot is a persona wrapped around headless Claude Code: each turn spawns one
`claude -p --output-format stream-json` subprocess (no resident daemon — the
process exits when the reply ends; continuity comes from `--resume`), relays
its NDJSON events to the browser as SSE, and appends every event to a
conversation log the owner controls. Claude Code's own transcript files are
undocumented internals that churn between releases — they are never the record
here; `bot_chats/<conv>.jsonl` is.

Guarantees carried over from the terminal send door (routes/terminal.py):
- capture-first journaling: a journaling bot's turn mints its B card BEFORE
  the model is called, so a failed model call can never lose a journal line.
- off-the-record turns (record: false) skip BOTH the journal mint and the
  chat-log append — the log gets only an explicit gap marker. The surface
  must never promise more privacy than the machinery gives (Terra, 07-23).

Headless mode authenticates exactly like interactive Claude Code (the owner's
subscription login, or an API key on a fresh install) — no separate billing.
"""
from flask import request, jsonify, Response
from datetime import datetime
from pathlib import Path
import json
import os
import re
import subprocess

import recap_summary
import store
from routes import terminal

# Overridable for tests (a stub emitting canned NDJSON) and for installs where
# claude isn't on gunicorn's PATH.
CLAUDE_BIN = os.environ.get("EXOCORTEX_CLAUDE_BIN", "claude")

_BOT_ID_RE = re.compile(r"^[a-z0-9-]{1,30}$")
_CONV_ID_RE = re.compile(r"^[A-Za-z0-9.\-]{1,60}$")

# The roster ships one generic default so a fresh install has a keeper the
# moment the surface exists; an instance overrides/extends via bots.json in
# the data dir (id, name, cwd, journal, allowed_tools, system_prompt_file).
# Tool scoping is per-bot on purpose — no bot gets ambient everything.
_DEFAULT_ALLOWED_TOOLS = ["Read", "Grep", "Glob"]


def _default_bots():
    return [{
        "id": "keeper",
        "name": "Keeper",
        # The vault root: personas live beside the content dir, and running
        # there lets Claude Code pick up the vault's own CLAUDE.md protocol.
        "cwd": str(store.CONTENT_DIR.parent),
        "journal": True,
        "allowed_tools": list(_DEFAULT_ALLOWED_TOOLS),
    }]


def _bots():
    bots = store.read("bots", None)
    if not isinstance(bots, list) or not bots:
        return _default_bots()
    return [b for b in bots if isinstance(b, dict) and _BOT_ID_RE.match(str(b.get("id", "")))]


def _bot(bot_id):
    return next((b for b in _bots() if b["id"] == bot_id), None)


def _chats_dir():
    d = store.DATA_DIR / "bot_chats"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _new_conv_id(index):
    """Legible timestamp id, '-2'-suffixed on same-second collisions (the
    same shape as terminal.py's schedule ids)."""
    base = datetime.now().strftime("%Y-%m-%d.%H%M%S")
    if base not in index:
        return base
    i = 2
    while f"{base}-{i}" in index:
        i += 1
    return f"{base}-{i}"


def _now():
    return datetime.now().isoformat(timespec="seconds")


def _build_cmd(bot, resume_sid):
    """The claude invocation for one turn. The prompt goes in via stdin (never
    argv — no length limit, nothing shell-visible). stream-json in -p mode
    requires --verbose; --include-partial-messages is what makes the stream
    token-granular rather than message-granular."""
    cmd = [CLAUDE_BIN, "-p",
           "--output-format", "stream-json",
           "--verbose",
           "--include-partial-messages"]
    if resume_sid:
        cmd += ["--resume", resume_sid]
    tools = bot.get("allowed_tools")
    if isinstance(tools, list) and tools:
        cmd += ["--allowedTools", ",".join(str(t) for t in tools)]
    prompt_file = bot.get("system_prompt_file")
    if prompt_file:
        try:
            cmd += ["--append-system-prompt", Path(prompt_file).read_text()]
        except OSError:
            pass  # a broken persona ref shouldn't kill the turn; the bot just runs bare
    return cmd


def _spawn(bot, text, resume_sid, cwd_override=None):
    # Claude Code stores conversations PER DIRECTORY — resuming a session id
    # from a different cwd fails with "No conversation found". Every
    # conversation therefore carries the cwd it was born in (imported
    # terminal sessions keep their original one) and is always resumed there.
    cwd = cwd_override or bot.get("cwd")
    if not (cwd and os.path.isdir(cwd)):
        cwd = None
    proc = subprocess.Popen(
        _build_cmd(bot, resume_sid),
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        cwd=cwd, text=True, bufsize=1,
    )
    proc.stdin.write(text)
    proc.stdin.close()
    return proc


def _sse(obj):
    return f"data: {json.dumps(obj)}\n\n"


def register(app):
    @app.route("/api/bots")
    def bots_list():
        """Roster + per-bot conversation summaries (newest first). Closed
        (archived) sessions are hidden — their logs and index entries stay."""
        chats = _chats_dir()
        index = store.read("bot_chats/index", {})
        out = []
        for b in _bots():
            convs = sorted(
                (dict(meta, id=cid) for cid, meta in index.items()
                 if isinstance(meta, dict) and meta.get("bot") == b["id"]
                 and not meta.get("archived")),
                key=lambda c: c.get("last_at", ""), reverse=True)
            # Pinned sessions surface first (the Keeper session lives at the
            # top); the sort above stays stable within each group.
            convs.sort(key=lambda c: 0 if c.get("pinned") else 1)
            for c in convs:
                # Haiku card summaries, same machinery as the tmux /sessions
                # page — cached, background-refreshed, never blocking here.
                summary = recap_summary.get_summary(
                    "bot:" + c["id"], chats / f"{c['id']}.jsonl",
                    builder=recap_summary.build_bot_dialogue)
                if summary:
                    c["summary"] = summary
            out.append({"id": b["id"], "name": b.get("name", b["id"]),
                        "journal": bool(b.get("journal")), "conversations": convs})
        return jsonify({"bots": out})

    @app.route("/api/bots/conversation/<conv_id>/close", methods=["POST"])
    def bot_conv_close(conv_id):
        """Close a session: it leaves the roster, but nothing is deleted —
        the jsonl log and index entry stay (her record is the record). The
        pinned Keeper session always stays open."""
        _chats_dir()
        with store.mutate("bot_chats/index", {}) as index:
            entry = index.get(conv_id)
            if not isinstance(entry, dict):
                return jsonify({"error": "not found"}), 404
            if entry.get("pinned"):
                return jsonify({"error": "the pinned Keeper session stays open"}), 400
            entry["archived"] = _now()
        return jsonify({"ok": True})

    @app.route("/api/bots/<bot_id>/conversations", methods=["POST"])
    def bot_conv_create(bot_id):
        """Create a named session before its first message — the reading
        room's '+ New session' (the terminal's create-session gesture).
        `journal: false` makes it a non-diary space: sends still log to the
        session's own jsonl but never mint journal cards (the same split as
        tmux sessions outside KEEPER_CAPTURE_SESSIONS)."""
        bot = _bot(bot_id)
        if not bot:
            return jsonify({"error": "unknown bot"}), 404
        data = request.json or {}
        title = (data.get("title") or "").strip()[:60]
        # Journal is OPT-IN and rare: the diary is the pinned Keeper session's
        # door; every other session is a workshop unless deliberately toggled.
        journal = data.get("journal") is True
        _chats_dir()
        with store.mutate("bot_chats/index", {}) as index:
            conv_id = _new_conv_id(index)
            index[conv_id] = {"bot": bot_id, "started": _now(), "last_at": _now(),
                              "claude_session_id": None, "cost_usd": 0.0,
                              "title": title or "New session", "journal": journal,
                              "cwd": bot.get("cwd")}
        return jsonify({"ok": True, "id": conv_id})

    @app.route("/api/bots/conversation/<conv_id>/settings", methods=["POST"])
    def bot_conv_settings(conv_id):
        """Rename and/or flip a session's journal switch. Pinning is data-only
        for now (set at import/migration) — the pinned Keeper session stays
        the one diary door."""
        data = request.json or {}
        _chats_dir()
        with store.mutate("bot_chats/index", {}) as index:
            entry = index.get(conv_id)
            if not isinstance(entry, dict):
                return jsonify({"error": "not found"}), 404
            if "title" in data:
                title = (data.get("title") or "").strip()[:60]
                if not title:
                    return jsonify({"error": "empty title"}), 400
                entry["title"] = title
            if "journal" in data:
                entry["journal"] = data.get("journal") is True
            out = dict(entry, id=conv_id)
        return jsonify({"ok": True, "conversation": out})

    @app.route("/api/bots/conversation/<conv_id>")
    def bot_conversation(conv_id):
        if not _CONV_ID_RE.match(conv_id):
            return jsonify({"error": "invalid conversation id"}), 400
        path = _chats_dir() / f"{conv_id}.jsonl"
        if not path.exists():
            return jsonify({"error": "not found"}), 404
        events = []
        for line in path.read_text().splitlines():
            try:
                events.append(json.loads(line))
            except ValueError:
                continue  # a torn line (crash mid-append) shouldn't hide the rest
        meta = store.read("bot_chats/index", {}).get(conv_id, {})
        return jsonify({"id": conv_id, "meta": meta, "events": events})

    @app.route("/api/bots/<bot_id>/send", methods=["POST"])
    def bot_send(bot_id):
        bot = _bot(bot_id)
        if not bot:
            return jsonify({"error": "unknown bot"}), 404
        data = request.json or {}
        text = (data.get("text") or "").strip()
        if not text:
            return jsonify({"error": "empty message"}), 400
        record = data.get("record") is not False   # on unless explicitly off
        conv_req = data.get("conversation_id")
        if conv_req is not None and not _CONV_ID_RE.match(str(conv_req)):
            return jsonify({"error": "invalid conversation id"}), 400

        # Everything request-bound happens BEFORE the generator: conv/index
        # setup, the journal mint, and the spawn — the stream only relays.
        _chats_dir()   # the index (and its .lock) lives inside it
        with store.mutate("bot_chats/index", {}) as index:
            conv_id = str(conv_req) if conv_req else _new_conv_id(index)
            entry = index.setdefault(conv_id, {"bot": bot_id, "started": _now(),
                                               "claude_session_id": None,
                                               "title": text[:60], "cost_usd": 0.0,
                                               "journal": False,
                                               "cwd": bot.get("cwd")})
            entry["last_at"] = _now()
            resume_sid = entry.get("claude_session_id")
            conv_cwd = entry.get("cwd")
            # Journal is opt-in per session (the pinned Keeper session carries
            # journal:true) — everything else logs to its own jsonl only.
            conv_journals = entry.get("journal") is True

        # Capture BEFORE the model runs (Slice-1 guarantee, same door the
        # terminal chat session uses). Slash commands are operator control,
        # not journal content — same rule as terminal_send().
        journaled = False
        if record and conv_journals and bot.get("journal") and not text.lstrip().startswith("/"):
            journaled = terminal._capture_journal(text, text)

        log_path = _chats_dir() / f"{conv_id}.jsonl"
        with open(log_path, "a", encoding="utf-8") as log:
            if record:
                log.write(json.dumps({"type": "user", "text": text, "ts": _now(),
                                      "journaled": journaled}) + "\n")
            else:
                log.write(json.dumps({"type": "off-record-gap", "ts": _now()}) + "\n")

        try:
            proc = _spawn(bot, text, resume_sid, cwd_override=conv_cwd)
        except OSError as e:
            return jsonify({"error": f"could not start claude: {e}"}), 502

        def generate():
            session_id = resume_sid
            cost = None
            try:
                yield _sse({"type": "conv", "conversation_id": conv_id,
                            "bot": bot_id, "journaled": journaled})
                with open(log_path, "a", encoding="utf-8") as log:
                    for line in proc.stdout:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            event = json.loads(line)
                        except ValueError:
                            continue  # non-JSON noise on stdout — skip, don't die
                        if isinstance(event, dict):
                            if event.get("session_id"):
                                session_id = event["session_id"]
                            if event.get("total_cost_usd") is not None:
                                cost = event["total_cost_usd"]
                        # Token deltas (stream_event) are transport, not
                        # record — the assistant message events they build
                        # carry the same text, so persisting the deltas would
                        # just triple the log for nothing (Terra: "the jsonl
                        # is transport"... but even transport doesn't keep
                        # every wingbeat).
                        if record and event.get("type") != "stream_event":
                            log.write(json.dumps(event) + "\n")
                        yield _sse(event)
                proc.wait()
                if proc.returncode != 0:
                    err = (proc.stderr.read() or "").strip()[-500:]
                    yield _sse({"type": "error",
                                "error": err or f"claude exited {proc.returncode}"})
                # `--resume` forks a NEW claude session id each turn — store the
                # latest so the next turn resumes where this one ended.
                with store.mutate("bot_chats/index", {}) as index:
                    entry = index.get(conv_id)
                    if isinstance(entry, dict):
                        entry["claude_session_id"] = session_id
                        entry["last_at"] = _now()
                        if cost is not None:
                            entry["cost_usd"] = round(
                                float(entry.get("cost_usd") or 0.0) + float(cost), 6)
                yield _sse({"type": "done", "conversation_id": conv_id})
            finally:
                if proc.poll() is None:
                    proc.kill()   # client went away mid-turn — don't orphan claude

        return Response(generate(), mimetype="text/event-stream",
                        headers={"Cache-Control": "no-cache",
                                 "X-Accel-Buffering": "no"})
