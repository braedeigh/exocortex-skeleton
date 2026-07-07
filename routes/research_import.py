"""POST /api/research/import-questions — mine the research/*.md corpus for
open-question sections and turn them into question entries.

The corpus uses varied headings ("Open questions", "Open gaps", "threads to
pull", "Due-diligence questions", "unknowns"...), so extraction is heuristic
and therefore NEVER runs blind: `{"dry_run": true}` returns the full preview
and the UI shows it before a real import. The import itself is additive and
idempotent — a question whose exact text already exists (case-insensitive)
is skipped, so re-running is safe.

Each source file gets (or reuses) one topic, named from the file's `# ` title;
imported entries carry `origin: "note:<filename>"` so the provenance survives
even though no UI shows it yet.

The parsing core (`mine_questions`, `md_title`) is pure — text in, data out —
per the Rust-translation-friendly rules; the route does the file and store I/O.
"""
import re
from datetime import datetime

from flask import request, jsonify

import store

# A heading whose text contains any of these (case-insensitive) marks an
# open-question section. Deliberately conservative — prerequisites lists
# ("What needs to exist first") are NOT questions and stay out.
SECTION_MARKERS = ("open question", "questions", "open gap", "unknown",
                   "threads to pull", "to investigate")

_HEADING = re.compile(r"^#{1,6}\s+(.*)$")
_LIST_ITEM = re.compile(r"^\s*(?:[-*+]|\d+\.)\s+(.+)$")

MIN_LEN = 15      # shorter than this is noise, not a question
MAX_LEN = 500     # longer than this is a paragraph that ate the section
MAX_PER_SECTION = 10   # paragraph-mode cap; list mode is naturally bounded


def md_title(text):
    """First `# ` heading, else ""."""
    for line in text.splitlines():
        m = _HEADING.match(line)
        if m and line.startswith("# "):
            return m.group(1).strip()
        if line.strip() and not line.startswith("#"):
            break
    return ""


def _is_question_heading(heading_text):
    low = heading_text.lower()
    return any(marker in low for marker in SECTION_MARKERS)


def _clean(item):
    """Strip markdown emphasis and collapse whitespace; "" if out of bounds."""
    text = re.sub(r"\*\*|__", "", item)
    text = " ".join(text.split())
    if len(text) < MIN_LEN or len(text) > MAX_LEN:
        return ""
    return text


def mine_questions(text):
    """All question strings in one markdown document, in document order.

    Under each question-marked heading: list items if the section has any,
    otherwise each paragraph (blank-line separated, capped) — the corpus has
    both shapes. Pure function.
    """
    lines = text.splitlines()
    found = []
    in_section = False
    section_items = []
    section_paras = []
    para = []

    def flush_section():
        if section_items:
            found.extend(section_items)
        else:
            found.extend(section_paras[:MAX_PER_SECTION])
        section_items.clear()
        section_paras.clear()

    def flush_para():
        if para:
            cleaned = _clean(" ".join(para))
            if cleaned:
                section_paras.append(cleaned)
            para.clear()

    for line in lines:
        m = _HEADING.match(line)
        if m:
            if in_section:
                flush_para()
                flush_section()
            in_section = _is_question_heading(m.group(1))
            continue
        if not in_section:
            continue
        item = _LIST_ITEM.match(line)
        if item:
            flush_para()
            cleaned = _clean(item.group(1))
            if cleaned:
                section_items.append(cleaned)
        elif line.strip():
            para.append(line.strip())
        else:
            flush_para()
    if in_section:
        flush_para()
        flush_section()
    return found


def _slugify(name):
    slug = re.sub(r"[^a-z0-9]+", "-", name.strip().lower()).strip("-")
    return slug or "topic"


def _now_stamp():
    return datetime.now().strftime("%Y-%m-%d %H:%M")


def _new_entry_id(entries, taken):
    base = datetime.now().strftime("%Y-%m-%d.%H%M")
    existing = {e["id"] for e in entries} | taken
    if base not in existing:
        return base
    i = 2
    while f"{base}-{i}" in existing:
        i += 1
    return f"{base}-{i}"


def _scan_corpus():
    """[(filename, title, [question, ...])] for every md file with finds."""
    root = store.RESEARCH_DIR
    out = []
    if not root.is_dir():
        return out
    for path in sorted(root.glob("*.md")):
        try:
            text = path.read_text()
        except OSError:
            continue
        questions = mine_questions(text)
        if questions:
            out.append((path.name, md_title(text) or path.stem, questions))
    return out


def register(app):

    @app.route("/api/research/import-questions", methods=["POST"])
    def import_research_questions():
        body = request.json or {}
        dry_run = bool(body.get("dry_run"))
        corpus = _scan_corpus()

        existing = store.read("research.json", {"topics": [], "entries": []})
        have = {e.get("text", "").strip().lower()
                for e in existing.get("entries", [])
                if e.get("kind") == "question"}

        plan = []
        seen_this_run = set()
        for filename, title, questions in corpus:
            fresh = []
            for q in questions:
                key = q.strip().lower()
                if key in have or key in seen_this_run:
                    continue
                seen_this_run.add(key)
                fresh.append(q)
            if fresh:
                plan.append({"file": filename, "topic": title, "questions": fresh})

        total = sum(len(p["questions"]) for p in plan)
        if dry_run or not plan:
            return jsonify({"ok": True, "dry_run": True, "plan": plan, "total": total})

        with store.mutate("research.json", {"topics": [], "entries": []}) as data:
            topics = data.setdefault("topics", [])
            entries = data.setdefault("entries", [])
            by_name = {t["name"].strip().lower(): t for t in topics}
            have_now = {e.get("text", "").strip().lower()
                        for e in entries if e.get("kind") == "question"}
            new_ids = set()
            imported = 0
            for p in plan:
                topic = by_name.get(p["topic"].strip().lower())
                if topic is None:
                    tid = p["topic"]
                    tid = _slugify(tid)
                    taken = {t["id"] for t in topics}
                    if tid in taken:
                        i = 2
                        while f"{tid}-{i}" in taken:
                            i += 1
                        tid = f"{tid}-{i}"
                    topic = {"id": tid, "name": p["topic"], "status": "active",
                             "created": _now_stamp()}
                    topics.append(topic)
                    by_name[p["topic"].strip().lower()] = topic
                for q in p["questions"]:
                    if q.strip().lower() in have_now:
                        continue
                    eid = _new_entry_id(entries, new_ids)
                    new_ids.add(eid)
                    entries.append({
                        "id": eid,
                        "kind": "question",
                        "text": q,
                        "topics": [topic["id"]],
                        "url": "",
                        "verdict": "",
                        "status": "open",
                        "reply_to": None,
                        "origin": f"note:{p['file']}",
                        "created": _now_stamp(),
                    })
                    imported += 1
        return jsonify({"ok": True, "dry_run": False, "imported": imported,
                        "topics": data.get("topics", []),
                        "entries": data.get("entries", [])})
