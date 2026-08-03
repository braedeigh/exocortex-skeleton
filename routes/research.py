"""Research routes — a flat pool of atomic entries (note/source/claim/question).

Topics are tags/lenses over the pool, not containers: an entry can carry
several topic ids (or none at all — it shows up in "Unfiled"). Removing a
topic strips that id from every entry's `topics` list; the entries survive.

    {"topics": [{"id", "name", "status", "created", "fronts"}],
     "entries": [{"id", "kind", "text", "topics", "url", "verdict",
                  "status", "reply_to", "created",
                  "flagged", "processed", "author", "reviewed", "session"}],
     "sessions": [{"id", "entry_ids", "topics", "created", "status", "report"}]}

Entry ids are legible time stamps (`YYYY-MM-DD.HHMM`) with a `-2`, `-3`, ...
suffix on same-minute collisions. Topic ids are slugified names, same
collision handling.

The new entry fields are all optional/backward-compatible (old entries just
lack them): `flagged` marks an entry the owner has queued to send to Claude;
`processed` is set by the runner once a session has dealt with an entry;
`author` == "llm" marks an entry the runner wrote back (absent means the owner's);
`reviewed` (llm entries only) is whether the owner has signed off on it; `session`
is the id of the session that produced an llm entry. A "session" is one
research-runner run: it records which of the owner's entries were sent, the union
of their topics, and a status ("running" → "done") with a one-line report
the runner leaves behind. Session ids share the entry id scheme. An
optional `"mode": "deep"` marks a session spawned for a single-question
deep-research dive (research-deep) rather than the regular runner. `"mode":
"distill"` marks a per-topic session (`entry_ids: []`, one topic id in
`topics`) that synthesizes the topic's REVIEWED replies + reports into
research/edge/<topic-id>.md — see /api/research/topic/distill and
scripts/research_dispatcher.py's spawn_worker.

Topics can also carry an optional `fronts` list — ids from the shared
life-domain vocabulary in fronts.json (routes/fronts.py), tagging a topic to
one or more life domains (health, finances, ...). Optional/backward
compatible: old topics simply lack the key (treat as `[]`). Removing a front
strips its id from every topic's `fronts` list (routes/fronts.py's
remove_front); removing a topic here has no effect on fronts.json.
"""
import os
import re
import subprocess
import threading
import time
from datetime import datetime
from pathlib import Path

from flask import request, jsonify

import store


def _md_title(path):
    """First '# ' heading of a markdown file, else the file stem."""
    try:
        for line in path.read_text().splitlines():
            if line.startswith("# "):
                return line[2:].strip()
            if line.strip():
                break  # title must lead the file
    except OSError:
        pass
    return path.stem

KINDS = ("note", "source", "claim", "question")
TOPIC_STATUSES = ("active", "dormant", "settled")
CLAIM_VERDICTS = ("", "real", "shaky", "interesting")
SOURCE_VERDICTS = ("", "verified")
QUESTION_STATUSES = ("open", "answered")


def _load():
    return store.read("research.json", {"topics": [], "entries": []})


def _save(data):
    store.write("research.json", data)


def _slugify(name):
    slug = re.sub(r"[^a-z0-9]+", "-", name.strip().lower()).strip("-")
    return slug or "topic"


def _unique_id(base, taken):
    if base not in taken:
        return base
    i = 2
    while f"{base}-{i}" in taken:
        i += 1
    return f"{base}-{i}"


def _new_entry_id(entries):
    base = datetime.now().strftime("%Y-%m-%d.%H%M")
    return _unique_id(base, {e["id"] for e in entries})


def _now_stamp():
    return datetime.now().strftime("%Y-%m-%d %H:%M")


def _blob(data, **extra):
    d = {
        "ok": True,
        "topics": data.get("topics", []),
        "entries": data.get("entries", []),
        "sessions": data.get("sessions", []),
    }
    d.update(extra)
    return jsonify(d)


def _new_session_id(sessions):
    base = datetime.now().strftime("%Y-%m-%d.%H%M")
    return _unique_id(base, {s["id"] for s in sessions})


def _capture_session_id_async(tmux_name, session_id, delay=7.0):
    """Kick a daemon thread that gives Claude Code a moment to start inside
    `tmux_name`, then resolves + stamps its live sessionId onto
    `session_id`'s record (scripts.research_ctl.capture_session_id — a
    swallow-all resolve+write already). This process (gunicorn) is
    long-lived, unlike scripts/research_dispatcher.py's spawn_worker (a
    short-lived script that has to capture inline, blocking, before it
    exits — see that module for why), so a fire-and-forget daemon thread is
    the natural fit here: `shared.send_prompt`'s default (non-blocking) mode
    already uses exactly this pattern for the same reason.

    Wrapped in its own try/except anyway, on top of capture_session_id's
    internal one — this is a background thread in the request-serving
    process, so nothing in here may ever crash or delay the request that
    kicked it off (which has already returned by the time this thread even
    wakes up), and nothing here may ever break an existing run if it fails.
    research_ctl is imported lazily inside the thread body (not at module
    top) since research_ctl imports this module at ITS top — deferring the
    import past module-load time avoids a circular import.
    """
    def _run():
        try:
            time.sleep(delay)
            from scripts import research_ctl
            research_ctl.capture_session_id(tmux_name, session_id)
        except Exception:
            pass
    threading.Thread(target=_run, daemon=True).start()


def _kick_dispatcher():
    """Fire scripts/research_dispatcher.py once, detached, right after an
    annotation-batch is queued — so the first worker gets admitted within
    seconds instead of waiting for cron to notice. Fire-and-forget: we don't
    wait for it or check its exit code, and the dispatcher's own flock means
    an overlapping/slow run just no-ops rather than piling up. Separated from
    the route handler so tests can monkeypatch this function.
    """
    skeleton_dir = Path(__file__).resolve().parent.parent
    subprocess.Popen(
        [str(skeleton_dir / "venv" / "bin" / "python3"),
         str(skeleton_dir / "scripts" / "research_dispatcher.py")],
        env={**os.environ, "EXOCORTEX_DATA_DIR": str(store.DATA_DIR)},
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        start_new_session=True,
    )


def register(app):

    # --- Topics ---

    @app.route("/api/research/topic/add", methods=["POST"])
    def add_research_topic():
        body = request.json or {}
        name = (body.get("name") or "").strip()
        if not name:
            return jsonify({"error": "missing name"}), 400
        fronts = body.get("fronts")
        if not isinstance(fronts, list):
            fronts = []
        with store.mutate("research.json", {"topics": [], "entries": []}) as data:
            topics = data.setdefault("topics", [])
            tid = _unique_id(_slugify(name), {t["id"] for t in topics})
            topics.append({
                "id": tid, "name": name, "status": "active", "created": _now_stamp(),
                "fronts": [str(f) for f in fronts],
            })
        return _blob(data)

    @app.route("/api/research/topic/edit", methods=["POST"])
    def edit_research_topic():
        body = request.json or {}
        tid = body.get("id")
        if "status" in body and body["status"] not in TOPIC_STATUSES:
            return jsonify({"error": "bad status"}), 400
        if "fronts" in body and not isinstance(body.get("fronts"), list):
            return jsonify({"error": "fronts must be a list"}), 400
        with store.mutate("research.json", {"topics": [], "entries": []}) as data:
            topic = next((t for t in data.get("topics", []) if t["id"] == tid), None)
            if not topic:
                return jsonify({"error": "not found"}), 404
            if "name" in body:
                name = (body.get("name") or "").strip()
                if not name:
                    return jsonify({"error": "name cannot be empty"}), 400
                topic["name"] = name
            if "status" in body:
                topic["status"] = body["status"]
            if "fronts" in body:
                topic["fronts"] = [str(f) for f in body["fronts"]]
        return _blob(data)

    @app.route("/api/research/topic/remove", methods=["POST"])
    def remove_research_topic():
        body = request.json or {}
        tid = body.get("id")
        with store.mutate("research.json", {"topics": [], "entries": []}) as data:
            data["topics"] = [t for t in data.get("topics", []) if t["id"] != tid]
            for e in data.get("entries", []):
                if tid in (e.get("topics") or []):
                    e["topics"] = [x for x in e["topics"] if x != tid]
        return _blob(data)

    # --- Entries ---

    @app.route("/api/research/entry/add", methods=["POST"])
    def add_research_entry():
        body = request.json or {}
        text = (body.get("text") or "").strip()
        if not text:
            return jsonify({"error": "missing text"}), 400
        kind = body.get("kind") or "note"
        if kind not in KINDS:
            return jsonify({"error": "bad kind"}), 400
        topics = body.get("topics")
        if not isinstance(topics, list):
            topics = []
        entry = {
            "id": None,
            "kind": kind,
            "text": text,
            "topics": [str(t) for t in topics],
            "url": (body.get("url") or "").strip(),
            "verdict": "",
            "status": "open" if kind == "question" else "",
            "reply_to": body.get("reply_to"),
            "created": _now_stamp(),
        }
        re_quote = (body.get("re_quote") or "").strip()
        if re_quote:
            entry["re_quote"] = re_quote
        context_ids = body.get("context_ids")
        if isinstance(context_ids, list) and context_ids:
            entry["context_ids"] = [str(x) for x in context_ids]
        with store.mutate("research.json", {"topics": [], "entries": []}) as data:
            entries = data.setdefault("entries", [])
            entry["id"] = _new_entry_id(entries)
            entries.append(entry)
        return _blob(data, id=entry["id"])

    @app.route("/api/research/entry/edit", methods=["POST"])
    def edit_research_entry():
        body = request.json or {}
        eid = body.get("id")
        with store.mutate("research.json", {"topics": [], "entries": []}) as data:
            entry = next((e for e in data.get("entries", []) if e["id"] == eid), None)
            if not entry:
                return jsonify({"error": "not found"}), 404
            # Validate every field before applying any — a partial apply on a
            # 400 would persist, since an early return exits mutate() cleanly.
            if "text" in body and not (body.get("text") or "").strip():
                return jsonify({"error": "text cannot be empty"}), 400
            if "verdict" in body:
                verdict = body.get("verdict") or ""
                if entry["kind"] == "claim":
                    allowed = CLAIM_VERDICTS
                elif entry["kind"] == "source":
                    allowed = SOURCE_VERDICTS
                else:
                    allowed = ("",)
                if verdict not in allowed:
                    return jsonify({"error": "bad verdict for this kind"}), 400
            if "status" in body:
                status = body.get("status") or ""
                allowed = QUESTION_STATUSES if entry["kind"] == "question" else ("",)
                if status not in allowed:
                    return jsonify({"error": "bad status for this kind"}), 400
            if "text" in body:
                entry["text"] = (body.get("text") or "").strip()
            if "url" in body:
                entry["url"] = (body.get("url") or "").strip()
            if "topics" in body:
                new_topics = body.get("topics")
                entry["topics"] = [str(t) for t in new_topics] if isinstance(new_topics, list) else []
            if "verdict" in body:
                entry["verdict"] = body.get("verdict") or ""
            if "status" in body:
                entry["status"] = body.get("status") or ""
        return _blob(data)

    @app.route("/api/research/entry/remove", methods=["POST"])
    def remove_research_entry():
        body = request.json or {}
        eid = body.get("id")
        with store.mutate("research.json", {"topics": [], "entries": []}) as data:
            data["entries"] = [e for e in data.get("entries", []) if e["id"] != eid]
        return _blob(data)

    @app.route("/api/research/entry/flag", methods=["POST"])
    def flag_research_entry():
        body = request.json or {}
        eid = body.get("id")
        with store.mutate("research.json", {"topics": [], "entries": []}) as data:
            entry = next((e for e in data.get("entries", []) if e["id"] == eid), None)
            if not entry:
                return jsonify({"error": "not found"}), 404
            if entry.get("author") == "llm":
                return jsonify({"error": "can't flag an LLM output"}), 400
            entry["flagged"] = bool(body.get("flagged"))
        return _blob(data)

    @app.route("/api/research/entry/review", methods=["POST"])
    def review_research_entry():
        body = request.json or {}
        eid = body.get("id")
        with store.mutate("research.json", {"topics": [], "entries": []}) as data:
            entry = next((e for e in data.get("entries", []) if e["id"] == eid), None)
            if not entry:
                return jsonify({"error": "not found"}), 404
            if entry.get("author") != "llm":
                return jsonify({"error": "only LLM outputs carry review"}), 400
            entry["reviewed"] = bool(body.get("reviewed"))
        return _blob(data)

    # --- Runner: send flagged entries to a Claude session for engagement ---

    @app.route("/api/research/send", methods=["POST"])
    def send_research_entries():
        """Send a set of her entries to the research-runner Claude session.

        With explicit `ids`, this is "send now" — it flags them and sends in
        one step. With no `ids`, it sends everything already flagged. Either
        way, a session record is appended (before the runner is spawned) so
        the runner has something to look up by id."""
        from routes.kitchen import shared

        body = request.json or {}
        ids = body.get("ids")
        with store.mutate("research.json", {"topics": [], "entries": []}) as data:
            entries = data.get("entries", [])
            by_id = {e["id"]: e for e in entries}
            if ids is not None:
                for eid in ids:
                    entry = by_id.get(eid)
                    if not entry:
                        return jsonify({"error": "not found"}), 404
                    if entry.get("author") == "llm":
                        return jsonify({"error": "can't flag an LLM output"}), 400
                for eid in ids:
                    by_id[eid]["flagged"] = True
                targets = [by_id[eid] for eid in ids]
            else:
                targets = [e for e in entries if e.get("flagged") and e.get("author") != "llm"]

            if not targets:
                return jsonify({"ok": True, "sent": 0, "session": None})

            sessions = data.setdefault("sessions", [])
            sid = _new_session_id(sessions)
            topics = sorted({t for e in targets for t in (e.get("topics") or [])})
            sessions.append({
                "id": sid,
                "entry_ids": [e["id"] for e in targets],
                "topics": topics,
                "created": _now_stamp(),
                "status": "running",
                "report": "",
            })

        n = len(targets)
        newly = shared.ensure_claude_session(
            "research-runner", store.RESEARCH_RUNNER_DIR, dirs=(store.RESEARCH_RUNNER_DIR,),
        )
        prompt = (
            f"Session {sid}: {n} research entries are queued in session record "
            f"'{sid}' in research.json. Do your one job: read your CLAUDE.md, "
            f"process them, and report in one line."
        )
        shared.send_prompt("research-runner", prompt)
        _capture_session_id_async("research-runner", sid)
        return jsonify({"ok": True, "sent": n, "session": sid, "newly_spawned": newly})

    @app.route("/api/research/question/deep", methods=["POST"])
    def deep_research_question():
        """Send one open question to the research-deep Claude session for a
        proper deep-dive, rather than the lighter-touch research-runner."""
        from routes.kitchen import shared

        body = request.json or {}
        eid = body.get("id")
        with store.mutate("research.json", {"topics": [], "entries": []}) as data:
            entry = next((e for e in data.get("entries", []) if e["id"] == eid), None)
            if not entry:
                return jsonify({"error": "not found"}), 404
            # Validate every field before applying any — a partial apply on a
            # 400 would persist, since an early return exits mutate() cleanly.
            if entry["kind"] != "question":
                return jsonify({"error": "only questions can be deep-researched"}), 400
            if entry.get("author") == "llm":
                return jsonify({"error": "can't research an LLM output"}), 400
            if entry.get("status") != "open":
                return jsonify({"error": "question is not open"}), 400

            entry["flagged"] = True
            sessions = data.setdefault("sessions", [])
            sid = _new_session_id(sessions)
            sessions.append({
                "id": sid,
                "entry_ids": [entry["id"]],
                "topics": sorted(set(entry.get("topics") or [])),
                "created": _now_stamp(),
                "status": "running",
                "report": "",
                "mode": "deep",
            })

        newly = shared.ensure_claude_session(
            "research-deep", store.RESEARCH_DEEP_DIR, dirs=(store.RESEARCH_DEEP_DIR,),
        )
        prompt = (
            f"Session {sid}: an open research question is queued in session record "
            f"'{sid}' in research.json. Do your one job: read your CLAUDE.md, "
            f"research it deeply, save the report to the research library, and "
            f"report in one line."
        )
        shared.send_prompt("research-deep", prompt)
        _capture_session_id_async("research-deep", sid)
        return jsonify({"ok": True, "session": sid, "newly_spawned": newly})

    # --- Distill: synthesize a topic's reviewed answers into an edge note ---

    @app.route("/api/research/topic/distill", methods=["POST"])
    def distill_research_topic():
        """Queue a distill session for one topic: a worker session (same
        memory-throttled admission as annotation-batch, `worker: True`) with
        `entry_ids: []` and `mode: "distill"` so research_dispatcher.py's
        spawn_worker routes it to the research-distiller skill instead of the
        regular worker one. The distiller reads the topic's REVIEWED llm
        replies + their report files and (over)writes
        research/edge/<topic-id>.md — the one file class an agent may
        overwrite. Refuses a second distill session for the same topic while
        one is already queued/running (409) rather than double-spawning."""
        body = request.json or {}
        tid = body.get("topic")
        with store.mutate("research.json", {"topics": [], "entries": [], "sessions": []}) as data:
            topic = next((t for t in data.get("topics", []) if t["id"] == tid), None)
            if not topic:
                return jsonify({"error": "not found"}), 404

            sessions = data.setdefault("sessions", [])
            dup = any(
                s.get("mode") == "distill" and s.get("status") in ("queued", "running")
                and tid in (s.get("topics") or [])
                for s in sessions
            )
            if dup:
                return jsonify({"error": "a distill session for this topic is already queued or running"}), 409

            sid = _new_session_id(sessions)
            session = {
                "id": sid,
                "entry_ids": [],
                "topics": [tid],
                "created": _now_stamp(),
                "status": "queued",
                "report": "",
                "mode": "distill",
                "worker": True,
            }
            sessions.append(session)

        _kick_dispatcher()
        return _blob(data, session=session)

    # --- Annotation-batch: create question entries + worker sessions in bulk ---

    @app.route("/api/research/annotation-batch", methods=["POST"])
    def annotation_batch():
        """Create question entries + QUEUED sessions for a batch of annotation-derived
        questions. Sessions don't spawn a worker directly — each is marked
        `"worker": True` so scripts/research_dispatcher.py (cron, and kicked once
        below) knows to admit it as memory allows. A batch of many items used to
        spawn one ~400MB `claude` process per item immediately, which could OOM
        the box; queueing + incremental admission is the fix.

        Body: {items: [{reply_to, question, re_quote, context_ids, mode}, ...]}

        All entries and sessions are written in ONE store.mutate pass.
        """
        body = request.json or {}
        items = body.get("items") or []
        if not items:
            return jsonify({"error": "no items"}), 400

        created = []   # [(session_id, mode, question_id), ...]
        now = _now_stamp()

        with store.mutate("research.json", {"topics": [], "entries": [], "sessions": []}) as data:
            entries = data.setdefault("entries", [])
            sessions = data.setdefault("sessions", [])
            by_id = {e["id"]: e for e in entries}

            for item in items:
                reply_to = item.get("reply_to")
                question_text = (item.get("question") or "").strip()
                if not question_text:
                    continue

                # Inherit topics from the reply_to entry (or [])
                topics = list((by_id.get(reply_to) or {}).get("topics") or [])

                # Build the question entry
                q_entry = {
                    "id": _new_entry_id(entries),
                    "kind": "question",
                    "text": question_text,
                    "topics": topics,
                    "url": "",
                    "verdict": "",
                    "status": "open",
                    "reply_to": reply_to,
                    "created": now,
                }
                re_quote = (item.get("re_quote") or "").strip()
                if re_quote:
                    q_entry["re_quote"] = re_quote
                context_ids = item.get("context_ids")
                if isinstance(context_ids, list) and context_ids:
                    q_entry["context_ids"] = [str(x) for x in context_ids]
                entries.append(q_entry)
                by_id[q_entry["id"]] = q_entry

                # Build the session record
                mode = (item.get("mode") or "regular").strip()
                sid = _new_session_id(sessions)
                sessions.append({
                    "id": sid,
                    "entry_ids": [q_entry["id"]],
                    "topics": sorted(set(topics)),
                    "created": now,
                    "status": "queued",
                    "report": "",
                    "mode": mode,
                    "worker": True,
                })
                created.append((sid, mode, q_entry["id"]))

        # Kick the dispatcher once so the first worker starts within seconds —
        # after the mutate so the store is stable before it can act on it.
        if created:
            _kick_dispatcher()

        return jsonify({
            "ok": True,
            "count": len(created),
            "session_ids": [c[0] for c in created],
            "question_ids": [c[2] for c in created],
        })

    # --- Filer: a cricket-style Claude session that tags the unfiled pool ---

    @app.route("/api/research/file-unfiled", methods=["POST"])
    def research_file_unfiled():
        """Spawn (or reuse) the 'research' tmux Claude session — same pattern
        as triage/person — cwd'd into RESEARCH_FILER_DIR so its CLAUDE.md
        skill loads, and prompt it to file the unfiled entries. The frontend
        then flips the terminal pane to the session so she can watch or
        ignore it."""
        from routes.kitchen import shared

        data = _load()
        unfiled = [e for e in data.get("entries", []) if not e.get("topics")]
        if not unfiled:
            return jsonify({"ok": True, "unfiled": 0, "session": None})
        newly = shared.ensure_claude_session(
            "research", store.RESEARCH_FILER_DIR, dirs=(store.RESEARCH_FILER_DIR,),
        )
        prompt = (
            f"{len(unfiled)} research entries are sitting unfiled. Do your one "
            f"job: read your CLAUDE.md, file them, and report in one line."
        )
        shared.send_prompt("research", prompt)
        return jsonify({"ok": True, "unfiled": len(unfiled), "session": "research",
                        "newly_spawned": newly})

    # --- Health: RAM/worker-slot snapshot for the teal heartbeat pill ---

    @app.route("/api/research/health")
    def research_health():
        """How many worker slots are free right now — reuses the RUN
        dispatcher's admission math (scripts/run_dispatcher.py's
        read_meminfo_mb / compute_slots / constants) and terminal.py's
        live-worker count (rw-* tmux sessions), never duplicating either.

        These numbers are shared with every other background crew now, not
        research's own: the pill answers "can anything start", which is the
        honest question, since a night build eating 900MB is exactly as much a
        reason a worker can't start as another worker would be. Off-Linux or an
        unreadable /proc/meminfo degrades to `available_mb: null` with slots
        computed as if room exists, rather than 500ing."""
        from routes.terminal import _live_workers
        from scripts import run_dispatcher as dispatcher

        live_count = len(_live_workers())
        try:
            avail_mb = dispatcher.read_meminfo_mb()
        except Exception:
            avail_mb = None

        if avail_mb is None:
            slots = max(dispatcher.CAP - live_count, 0)
        else:
            slots = max(dispatcher.compute_slots(avail_mb, live_count), 0)

        # Response keys are unchanged on purpose — the teal heartbeat pill in
        # the frontend reads these names.
        return jsonify({
            "available_mb": avail_mb,
            "floor_mb": dispatcher.FLOOR_MB,
            "per_worker_mb": dispatcher.MEM_CLASSES["agent"],
            "max_concurrent": dispatcher.CAP,
            "live_workers": live_count,
            "slots": slots,
        })

    # --- Library: read-only view of the research/*.md corpus ---

    @app.route("/api/research/library")
    def research_library():
        """List the markdown files in RESEARCH_DIR (recursive), newest first.

        `edge/<topic-id>.md` files — the distiller's "edge of knowledge"
        notes — are excluded from the main list and returned separately
        under `edge`, keyed by topic, so the UI can pin one per topic thread
        instead of it showing up as just another library entry."""
        root = store.RESEARCH_DIR
        files = []
        edge = []
        if root.is_dir():
            for p in sorted(root.rglob("*.md")):
                rel = p.relative_to(root).as_posix()
                stat = p.stat()
                title = _md_title(p)
                mtime = datetime.fromtimestamp(stat.st_mtime).strftime("%Y-%m-%d")
                if rel.startswith("edge/"):
                    edge.append({"file": rel, "title": title, "mtime": mtime})
                    continue
                files.append({
                    "path": rel,
                    "name": p.stem,
                    "title": title,
                    "mtime": mtime,
                    "size": stat.st_size,
                })
        files.sort(key=lambda f: f["mtime"], reverse=True)
        return jsonify({"ok": True, "files": files, "edge": edge})

    @app.route("/api/research/library/file")
    def research_library_file():
        """Return one library file's markdown, read-only. Guards traversal."""
        rel = request.args.get("path", "")
        root = store.RESEARCH_DIR.resolve()
        try:
            target = (root / rel).resolve()
        except (OSError, ValueError):
            return jsonify({"error": "bad path"}), 400
        if not target.is_relative_to(root) or target.suffix != ".md":
            return jsonify({"error": "bad path"}), 400
        if not target.is_file():
            return jsonify({"error": "not found"}), 404
        return jsonify({
            "ok": True,
            "path": rel,
            "title": _md_title(target),
            "text": target.read_text(),
        })
