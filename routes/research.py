"""Research routes — a flat pool of atomic entries (note/source/claim/question).

Topics are tags/lenses over the pool, not containers: an entry can carry
several topic ids (or none at all — it shows up in "Unfiled"). Removing a
topic strips that id from every entry's `topics` list; the entries survive.

    {"topics": [{"id", "name", "status", "created"}],
     "entries": [{"id", "kind", "text", "topics", "url", "verdict",
                  "status", "reply_to", "created"}]}

Entry ids are legible time stamps (`YYYY-MM-DD.HHMM`) with a `-2`, `-3`, ...
suffix on same-minute collisions. Topic ids are slugified names, same
collision handling.
"""
import re
from datetime import datetime

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


def _blob(data):
    return jsonify({"ok": True, "topics": data.get("topics", []), "entries": data.get("entries", [])})


def register(app):

    # --- Topics ---

    @app.route("/api/research/topic/add", methods=["POST"])
    def add_research_topic():
        body = request.json or {}
        name = (body.get("name") or "").strip()
        if not name:
            return jsonify({"error": "missing name"}), 400
        with store.mutate("research.json", {"topics": [], "entries": []}) as data:
            topics = data.setdefault("topics", [])
            tid = _unique_id(_slugify(name), {t["id"] for t in topics})
            topics.append({"id": tid, "name": name, "status": "active", "created": _now_stamp()})
        return _blob(data)

    @app.route("/api/research/topic/edit", methods=["POST"])
    def edit_research_topic():
        body = request.json or {}
        tid = body.get("id")
        if "status" in body and body["status"] not in TOPIC_STATUSES:
            return jsonify({"error": "bad status"}), 400
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
        with store.mutate("research.json", {"topics": [], "entries": []}) as data:
            entries = data.setdefault("entries", [])
            entry["id"] = _new_entry_id(entries)
            entries.append(entry)
        return _blob(data)

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

    # --- Library: read-only view of the research/*.md corpus ---

    @app.route("/api/research/library")
    def research_library():
        """List the markdown files in RESEARCH_DIR (recursive), newest first."""
        root = store.RESEARCH_DIR
        files = []
        if root.is_dir():
            for p in sorted(root.rglob("*.md")):
                stat = p.stat()
                files.append({
                    "path": p.relative_to(root).as_posix(),
                    "name": p.stem,
                    "title": _md_title(p),
                    "mtime": datetime.fromtimestamp(stat.st_mtime).strftime("%Y-%m-%d"),
                    "size": stat.st_size,
                })
        files.sort(key=lambda f: f["mtime"], reverse=True)
        return jsonify({"ok": True, "files": files})

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
