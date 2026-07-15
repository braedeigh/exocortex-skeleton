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

# --- "Talk about this thread" session spawning -------------------------------
# The talk button starts a FRESH claude session per thread (not the Keeper's
# chat — her call, 2026-07-14: keep the Keeper conversation clean). The /thread
# slash command is passed as claude's launch prompt, so there's no race against
# claude booting that typing into the pane would have. The session runs from
# the vault (where the Keeper's files live) and dies when she quits claude.
CLAUDE_BIN = "/home/bradie/.local/bin/claude"
VAULT_CWD = "/opt/exocortex/personal"
_SESSION_SLUG = re.compile(r"^[a-z0-9-]{1,40}$")
# sessions.json names are capped at 30 chars (routes/terminal.py); leave room
# for a "-N" retry suffix when the base name's tmux session is still alive.
_SESSION_NAME_MAX = 30


def _talk_session_name(slug, tmux):
    """First free tmux session name for a thread: thread-<slug>, then -2, -3…
    ('=' forces exact match — tmux otherwise prefix-matches names)."""
    base = f"thread-{slug}"[:_SESSION_NAME_MAX].rstrip("-")
    name = base
    for i in range(2, 10):
        if tmux(f"has-session -t ={name}").returncode != 0:
            return name
        suffix = f"-{i}"
        name = base[: _SESSION_NAME_MAX - len(suffix)] + suffix
    return None

_CARD_ID = re.compile(r"^\d{4}-\d{2}-\d{2}\.\w+$")
_DAY = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_TOKEN = re.compile(r"`([^`]+)`")          # backtick-wrapped source tokens
_ARROW = re.compile(r"\s*[→·]\s*")          # the "→"/"·" source markers
_BULLET = re.compile(r"^\s*[-*]\s+")
_WIKILINK = re.compile(r"\[\[([^\]]+)\]\]")  # [[slug]] cross-thread links

# threads-architecture.md §8 step 2: cards live under <content>/_system/data/cards,
# one file per card, tagged with the thread slugs they belong to. The inbox
# derives from these — never stored on the thread itself.
CARDS_SUBDIR = ("_system", "data", "cards")


def _vault():
    # Resolve fresh each call so tests/env overrides of CONTENT_DIR are honored.
    return store.CONTENT_DIR.resolve()


def _threads_dir():
    return _vault() / THREADS_DIR


def _cards_dir():
    d = _vault()
    for part in CARDS_SUBDIR:
        d = d / part
    return d


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

    def _list_field(key):
        # threads-architecture.md §3: fronts/parents are flow-style `[a, b]`
        # lists; _parse_frontmatter already turns those (and bare comma-lists)
        # into Python lists. Tolerant reader: a stray bare scalar still becomes
        # a one-item list instead of raising.
        v = meta.get(key, [])
        if isinstance(v, str):
            v = [v] if v else []
        return [x for x in v if x]

    def _scalar_field(key):
        # opened/retired/distilled/kind are single dates or words. A blank
        # frontmatter value (`retired:` with nothing after it) parses to ""
        # here — normalize that to None, the documented "unset" value.
        v = meta.get(key)
        if isinstance(v, list):
            v = v[0] if v else None
        if isinstance(v, str):
            v = v.strip() or None
        return v

    fronts = _list_field("fronts")
    parents = _list_field("parents")
    kind = _scalar_field("kind")
    opened = _scalar_field("opened")
    retired = _scalar_field("retired")
    distilled = _scalar_field("distilled")

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
        "fronts": fronts,
        "parents": parents,
        "kind": kind,
        "opened": opened,
        "retired": retired,
        "distilled": distilled,
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


def _all_threads(include_retired=False):
    """threads_index(), optionally with `status: retired` filtered out —
    the default everywhere per threads-architecture.md §3."""
    idx = threads_index()
    if include_retired:
        return idx
    return {slug: t for slug, t in idx.items() if t.get("status") != "retired"}


def backlinks_for(slug):
    """Threads whose body links to `slug` via a `[[slug]]` token. Derived per
    request, scanning every thread file directly (not the parsed card text,
    so a link outside any fact-card still counts) — never stored."""
    slug = (slug or "").strip().lower()
    out = []
    d = _threads_dir()
    if not d.exists() or not slug:
        return out
    for p in sorted(d.glob("*.md")):
        if p.stem.lower() == slug:
            continue
        meta, body = _parse_frontmatter(p.read_text())
        links = {m.group(1).strip().lower() for m in _WIKILINK.finditer(body)}
        if slug in links:
            out.append({"slug": p.stem.lower(), "name": meta.get("name") or p.stem})
    return out


def _iter_cards():
    """Every card under _system/data/cards, parsed into a routable dict."""
    d = _cards_dir()
    if not d.exists():
        return
    for p in sorted(d.glob("*.md")):
        meta, body = _parse_frontmatter(p.read_text())
        tags = meta.get("tags", [])
        if isinstance(tags, str):
            tags = [tags] if tags else []
        yield {
            "id": meta.get("id") or p.stem,
            "ts": meta.get("ts", ""),
            "who": meta.get("who", ""),
            "text": body.strip(),
            "tags": [t.lower() for t in tags if t],
        }


def threads_tree(include_retired=False):
    """The derived parent/child DAG (threads-architecture.md §7): built fresh
    from `parents:` edges, never stored. A parent slug that doesn't resolve to
    a (living) thread is dropped silently — the child just becomes a root."""
    idx = _all_threads(include_retired)
    nodes = {
        slug: {
            "name": t["name"],
            "fronts": t.get("fronts", []),
            "parents": t.get("parents", []),
            "kind": t.get("kind"),
            "status": t.get("status", ""),
            "children": [],
        }
        for slug, t in idx.items()
    }
    roots = []
    for slug, t in idx.items():
        living_parents = [p for p in t.get("parents", []) if p in idx]
        if living_parents:
            for p in living_parents:
                nodes[p]["children"].append(slug)
        else:
            roots.append(slug)
    for node in nodes.values():
        node["children"].sort(key=lambda s: nodes[s]["name"])
    roots.sort(key=lambda s: nodes[s]["name"])
    return {"roots": roots, "nodes": nodes}


def register(app):
    @app.route("/api/threads")
    def threads_list():
        """Roster for the journal highlighter and the threads tree's flat
        list: id, name, aliases, file, plus fronts/parents/kind/status.
        Excludes `status: retired` by default (?include=retired to see them);
        ?front=<id> narrows to threads carrying that front."""
        include_retired = request.args.get("include") == "retired"
        front = (request.args.get("front") or "").strip()
        idx = _all_threads(include_retired)
        out = []
        for t in idx.values():
            if front and front not in t.get("fronts", []):
                continue
            out.append({
                "id": t["id"], "name": t["name"], "aliases": t.get("aliases", []),
                "file": t["file"], "fronts": t.get("fronts", []),
                "parents": t.get("parents", []), "kind": t.get("kind"),
                "status": t.get("status", ""),
            })
        return jsonify({"threads": out})

    @app.route("/api/threads/tree")
    def threads_tree_route():
        """The derived DAG — see threads_tree() above."""
        include_retired = request.args.get("include") == "retired"
        return jsonify(threads_tree(include_retired))

    @app.route("/api/thread/<slug>/inbox")
    def thread_inbox(slug):
        """Cards tagged `<slug>` dated after the thread's `distilled:`
        watermark (all tagged cards if it has none yet) — the thread's "not
        yet absorbed" queue, computed per request, never stored."""
        slug = (slug or "").strip().lower()
        t = threads_index().get(slug)
        if not t:
            return jsonify({"error": "not found", "slug": slug}), 404
        watermark = t.get("distilled")
        cards = []
        for c in _iter_cards():
            if slug not in c["tags"]:
                continue
            card_date = c["id"].split(".")[0]
            if watermark and not (card_date > watermark):
                continue
            cards.append({"id": c["id"], "ts": c["ts"], "who": c["who"],
                           "text": c["text"], "tags": c["tags"]})
        cards.sort(key=lambda c: c["id"])
        return jsonify({"cards": cards, "distilled": watermark})

    @app.route("/api/thread/talk", methods=["POST"])
    def thread_talk():
        """Spawn a fresh terminal session running `claude "/thread <slug>"` —
        the vault-side slash command reads the thread + its sources and opens
        a conversation. Returns the tmux session name so the client can
        switch the terminal there. Registered in sessions.json so the
        /sessions page lists it and ttyd can attach (closable: not a
        DEFAULT_SESSION)."""
        # Imported here, not at module top: routes/terminal.py touches
        # DATA_DIR/tmux paths at import time, which the threads tests (pure
        # CONTENT_DIR parsing) shouldn't have to stub.
        from routes import terminal as term

        data = request.json or {}
        q = (data.get("name") or "").strip()
        if not q:
            return jsonify({"error": "name required"}), 400
        t = resolve_thread(q)
        if not t:
            return jsonify({"error": "not found", "name": q}), 404
        slug = t["id"]
        if not _SESSION_SLUG.match(slug):
            # Thread ids are filename stems; anything outside [a-z0-9-] is not
            # safe to interpolate into the tmux command line below.
            return jsonify({"error": "thread id not sessionable", "id": slug}), 400

        name = _talk_session_name(slug, term._tmux)
        if not name:
            return jsonify({"error": "too many sessions for this thread"}), 409

        r = term._tmux(
            f"new-session -d -s {name} -c {VAULT_CWD} "
            f"'{CLAUDE_BIN} \"/thread {slug}\"'"
        )
        if r.returncode != 0:
            return jsonify({"error": (r.stderr or "").strip() or "tmux failed"}), 500

        sessions = term._load_sessions()
        if name not in sessions:
            sessions.append(name)
            term._save_sessions(sessions)
        return jsonify({"ok": True, "session": name, "thread": slug})

    @app.route("/api/thread")
    def thread_detail():
        """One thread's parsed fact-cards, for the popover / threads page.
        `backlinks` is derived per request (§7) — never stored."""
        q = (request.args.get("name") or "").strip()
        if not q:
            return jsonify({"error": "name required"}), 400
        t = resolve_thread(q)
        if not t:
            return jsonify({"error": "not found", "name": q}), 404
        payload = dict(t)
        payload["backlinks"] = backlinks_for(t["id"])
        return jsonify(payload)
