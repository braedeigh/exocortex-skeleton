"""Threads — group / topic profiles, the database view over tulku/Threads/*.md.

Same philosophy as entities.py: the markdown files stay the source of truth
(keeper-written), parsed fresh per request into the shape a DB would hold. A
*thread* is a group or standing topic (a TPOT office-hours crowd, the Tianmu
community). Its file is a set of **fact-cards** — each a short statement plus
links to the journal records / people files / context it came from.

File shape (the rigid shape IS the schema, like the people files):

    ---
    name: Office Hours
    aliases: [office hours, TPOT]
    status: active
    ---

    ## What it is
    A TPOT office-hours group. Recurring.
    → `2026-07-08.1828b`

Each `## Heading` — and each `- bullet` under it that carries its own source —
becomes a fact-card `{heading, text, sources: [...]}`. Sources are backtick
tokens, classified so the client routes a click the SAME way the person popover
does (journal:<date> loads in-app, keeper:<path> opens the Files tab):
  - `2026-07-08.1841b`  card id     -> journal:<date>
  - `2026-07-08`        a day       -> journal:<date>
  - `people/ian.md`     vault file  -> keeper:<path>
  - `tulku/CLAUDE.md`   repo path   -> keeper:<path minus the tulku/ prefix>

When this ever needs queries it can't do per-request, swap the parse for SQLite
behind these same functions and nothing above the API changes. Until then, YAGNI.
"""
import re

from flask import request, jsonify

import store
from routes.entities import _parse_frontmatter

THREADS_DIR = "Threads"

_CARD_ID = re.compile(r"^\d{4}-\d{2}-\d{2}\.\w+$")
_DAY = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_TOKEN = re.compile(r"`([^`]+)`")          # backtick-wrapped source tokens
_ARROW = re.compile(r"\s*[→·]\s*")          # the "→"/"·" source markers
_BULLET = re.compile(r"^\s*[-*]\s+")


def _vault():
    # Resolve fresh each call so tests/env overrides of CONTENT_DIR are honored.
    return store.CONTENT_DIR.resolve()


def _threads_dir():
    return _vault() / THREADS_DIR


def _classify_source(tok):
    """A backtick token -> a routable source dict, or None if it isn't a source."""
    tok = tok.strip()
    if _CARD_ID.match(tok):
        return {"ref": tok, "kind": "journal", "val": tok.split(".")[0], "label": tok}
    if _DAY.match(tok):
        return {"ref": tok, "kind": "journal", "val": tok, "label": tok}
    if tok.endswith(".md"):
        # Files tab (keeper) paths are CONTENT_DIR-relative; CONTENT_DIR is tulku/,
        # so a "tulku/…" repo path needs its prefix stripped to resolve.
        path = tok[len("tulku/"):] if tok.startswith("tulku/") else tok
        return {"ref": tok, "kind": "keeper", "val": path,
                "label": path.split("/")[-1][:-3] if path.endswith(".md") else path}
    return None


def _clean_text(line):
    """Strip the bullet dash, the source tokens, and the arrow marker from a line."""
    line = _TOKEN.sub("", line)
    line = _ARROW.sub(" ", line)
    line = _BULLET.sub("", line)
    return line.strip()


def parse_thread(path):
    """One Threads/*.md file -> a thread dict with parsed fact-cards."""
    raw = path.read_text()
    meta, body = _parse_frontmatter(raw)
    stem = path.stem
    lines = body.splitlines()

    name = meta.get("name")
    if not name:
        name = next((ln.strip()[2:].strip() for ln in lines
                     if ln.strip().startswith("# ") and not ln.strip().startswith("## ")), stem)
    aliases = meta.get("aliases", [])
    if isinstance(aliases, str):
        aliases = [aliases]

    cards = []
    section = ""
    unit = []   # accumulates one card's lines; flushed on a new bullet / heading

    def flush():
        if not unit or not section:   # pre-heading intro text isn't a card
            unit.clear()
            return
        sources, seen, text_parts = [], set(), []
        for ln in unit:
            for tok in _TOKEN.findall(ln):
                src = _classify_source(tok)
                if src and src["ref"] not in seen:
                    seen.add(src["ref"])
                    sources.append(src)
            cleaned = _clean_text(ln)
            if cleaned:
                text_parts.append(cleaned)
        unit.clear()
        text = " ".join(text_parts).strip()
        if text or sources:
            cards.append({"heading": section, "text": text, "sources": sources})

    for ln in lines:
        s = ln.strip()
        if s.startswith("## "):
            flush()
            section = s[3:].strip()
        elif s.startswith("# "):
            continue                       # title, handled above
        elif not s:
            continue                       # blanks don't split a card
        elif _BULLET.match(s):
            flush()                        # each bullet is its own card
            unit.append(s)
        else:
            unit.append(s)                 # continuation (e.g. a "→ source" line)
    flush()

    return {
        "id": stem.lower(),
        "name": name,
        "file": path.relative_to(_vault()).as_posix(),
        "aliases": [a for a in aliases if a],
        "status": meta.get("status", ""),
        "cards": cards,
    }


def threads_index():
    """Every thread as a dict, keyed by filename-stem slug (first file wins)."""
    d = _threads_dir()
    index = {}
    if not d.exists():
        return index
    for p in sorted(d.glob("*.md")):
        t = parse_thread(p)
        index.setdefault(t["id"], t)
    return index


def resolve_thread(query):
    """Find a thread by slug, name, or alias (case-insensitive)."""
    q = (query or "").strip().lower()
    if not q:
        return None
    idx = threads_index()
    if q in idx:
        return idx[q]
    for t in idx.values():
        if t["name"].lower() == q or any(a.lower() == q for a in t.get("aliases", [])):
            return t
    return None


def register(app):
    @app.route("/api/threads")
    def threads_list():
        """Roster for the journal highlighter: id, name, aliases, file."""
        out = [{"id": t["id"], "name": t["name"], "aliases": t.get("aliases", []), "file": t["file"]}
               for t in threads_index().values()]
        return jsonify({"threads": out})

    @app.route("/api/thread")
    def thread_detail():
        """One thread's parsed fact-cards, for the popover / threads page."""
        q = (request.args.get("name") or "").strip()
        if not q:
            return jsonify({"error": "name required"}), 400
        t = resolve_thread(q)
        if not t:
            return jsonify({"error": "not found", "name": q}), 404
        return jsonify(t)
