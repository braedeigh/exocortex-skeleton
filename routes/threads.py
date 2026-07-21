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
import os
import re
from datetime import datetime, timedelta
from pathlib import Path

from flask import request, jsonify

import store
from routes import entities
from routes.entities import _parse_frontmatter

THREADS_DIR = "Threads"

# --- "Talk about this thread" session spawning -------------------------------
# The talk button starts a FRESH claude session per thread (not the Keeper's
# chat — the owner's call, 2026-07-14: keep the Keeper conversation clean). The /thread
# slash command is passed as claude's launch prompt, so there's no race against
# claude booting that typing into the pane would have. The session runs from
# the vault (where the Keeper's files live) and dies when the owner quits claude.
CLAUDE_BIN = os.environ.get("EXOCORTEX_CLAUDE_BIN") or str(Path.home() / ".local" / "bin" / "claude")
# The vault = the directory holding the content dir (tulku/); sessions launch
# from there so the Keeper's files are in scope. Overridable for odd layouts.
VAULT_CWD = os.environ.get("EXOCORTEX_VAULT_DIR") or str(Path(store.CONTENT_DIR).parent)
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

# --- Day-row excerpts: pre-card-pool journal blobs, mention-windowed --------
# A bare-day row whose date predates the card pool has no card text to show —
# but the old markdown "blob" day file (server.py's GET /api/journal/<date>
# convention: CONTENT_DIR/Journal/Daily/<date>.md) often does. When that date
# carries no pool card at all, pull a bounded excerpt around each mention of
# the thread instead of just a bare link.
JOURNAL_DAILY_SUBDIR = ("Journal", "Daily")
EXCERPT_WINDOW_WORDS = 40      # words kept before/after a mention, mirrors the
                               # client's CONTEXT_WINDOW_WORDS (clipToContextWindow)
MAX_EXCERPTS_PER_DAY = 6       # bounds payload size; silently capped past this

_WORD_TOKEN = re.compile(r"\S+")
_DAY_TITLE_LINE = re.compile(r"^#\s+\S")   # "# 2026-07-13" / "# February 27, 2026 (Friday)"
_DAY_HR_LINE = re.compile(r"^-{3,}\s*$")


def _is_day_legend_line(line):
    """The `B = you | K = keeper` legend line under a blob day's title —
    matched structurally (B=, a "|", K=) so it survives whatever names the
    legend actually carries (e.g. `` `B = you | K = Ember` ``)."""
    s = line.strip()
    return bool(
        re.match(r"^\W*B\s*=", s, re.IGNORECASE)
        and "|" in s
        and re.search(r"K\s*=", s, re.IGNORECASE)
    )


def _strip_day_blob_header(body):
    """Frontmatter is already gone (caller runs _parse_frontmatter first) —
    this strips the blob's own header furniture: the `# <date>` title line,
    the who-legend line, and leading `---` separators, leaving the body
    prose a mention search can run over."""
    lines = body.splitlines()
    i = 0

    def skip_blank():
        nonlocal i
        while i < len(lines) and not lines[i].strip():
            i += 1

    skip_blank()
    if i < len(lines) and _DAY_TITLE_LINE.match(lines[i].strip()):
        i += 1
        skip_blank()
    if i < len(lines) and _is_day_legend_line(lines[i]):
        i += 1
        skip_blank()
    while i < len(lines) and _DAY_HR_LINE.match(lines[i].strip()):
        i += 1
        skip_blank()
    return "\n".join(lines[i:])


def _load_day_body(date):
    """A journal day's blob prose, with header furniture stripped — same
    CONTENT_DIR/Journal/Daily/<date>.md path + read-if-exists convention as
    server.py's GET /api/journal/<date>, not a second loader."""
    path = _vault()
    for part in JOURNAL_DAILY_SUBDIR:
        path = path / part
    path = path / f"{date}.md"
    if not path.exists():
        return ""
    raw = path.read_text()
    if not raw.strip():
        return ""
    _, body = _parse_frontmatter(raw)
    return _strip_day_blob_header(body).strip()


def _tokenize_words(text):
    """Whitespace-delimited words with character offsets — mirrors the
    client's tokenizeWords (ThreadJournalPage.tsx) so both sides window the
    same way."""
    return [(m.group(0), m.start(), m.end()) for m in _WORD_TOKEN.finditer(text)]


def _mention_excerpts(text, mention_re):
    """Every mention_re match in `text` -> a merged list of bounded excerpts:
    ~EXCERPT_WINDOW_WORDS words before/after each match (mirrors the client's
    clipToContextWindow), overlapping/adjacent windows merged into one, each
    excerpt getting a leading/trailing "…" where it was actually clipped.
    Capped at MAX_EXCERPTS_PER_DAY. Empty when there's no mention_re/text/match."""
    if not mention_re or not text:
        return []
    tokens = _tokenize_words(text)
    if not tokens:
        return []

    windows = []
    for m in mention_re.finditer(text):
        match_start, match_end = m.start(), m.end()
        start_tok = next((i for i, tok in enumerate(tokens) if tok[2] > match_start), len(tokens) - 1)
        end_tok = start_tok
        while end_tok + 1 < len(tokens) and tokens[end_tok + 1][1] < match_end:
            end_tok += 1
        w_start = max(0, start_tok - EXCERPT_WINDOW_WORDS)
        w_end = min(len(tokens) - 1, end_tok + EXCERPT_WINDOW_WORDS)
        windows.append([w_start, w_end])
    if not windows:
        return []

    windows.sort()
    merged = [windows[0]]
    for w_start, w_end in windows[1:]:
        if w_start <= merged[-1][1] + 1:
            merged[-1][1] = max(merged[-1][1], w_end)
        else:
            merged.append([w_start, w_end])

    excerpts = []
    for w_start, w_end in merged[:MAX_EXCERPTS_PER_DAY]:
        snippet = " ".join(tok[0] for tok in tokens[w_start:w_end + 1])
        if w_start > 0:
            snippet = f"… {snippet}"
        if w_end < len(tokens) - 1:
            snippet = f"{snippet} …"
        excerpts.append(snippet)
    return excerpts


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
    people = _list_field("people")
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
        "people": people,
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


def _cast_name(slug):
    """A people-file slug -> its display name: the H1 in people/<slug>.md if
    the file resolves, else a title-cased fallback of the slug. Reuses
    entities._parse_person (the tolerant people-file parser) rather than
    hand-rolling a second one — see dev_todo.md's "one people parser" rule."""
    path = _vault() / entities.PEOPLE_DIR / f"{slug}.md"
    if path.exists():
        try:
            return entities._parse_person(path)["name"]
        except OSError:
            pass
    return slug.replace("-", " ").replace("_", " ").title()


def _resolve_cast(slugs):
    """thread.people (slug strings) -> [{slug, name}] for API payloads."""
    return [{"slug": s, "name": _cast_name(s)} for s in slugs if s]


def threads_for_person(slug, include_retired=False):
    """Threads whose `people:` cast lists `slug` — derived per request, same
    shape/spirit as backlinks_for (threads-architecture.md §7: nothing about
    who's in what thread is stored beyond the thread's own `people:` list)."""
    slug = (slug or "").strip().lower()
    out = []
    if not slug:
        return out
    for t in _all_threads(include_retired).values():
        if slug in [p.lower() for p in t.get("people", [])]:
            out.append({"slug": t["id"], "name": t["name"], "status": t.get("status", "")})
    return out


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
        # Same normalization as routes/cards.py's _card_dict: a missing/blank/
        # literal-"null" frontmatter value all mean "no parent" -> None.
        reply_to = meta.get("reply_to")
        if reply_to in (None, "null", ""):
            reply_to = None
        yield {
            "id": meta.get("id") or p.stem,
            "ts": meta.get("ts", ""),
            "who": meta.get("who", ""),
            "text": body.strip(),
            "tags": [t.lower() for t in tags if t],
            "reply_to": reply_to,
        }


def _card_editable(ts):
    """True iff `ts` ("%Y-%m-%d %H:%M:%S") is well-formed and within the
    rolling last 24 hours of the SERVER clock — never the client's Date,
    per house convention. Empty/unparseable ts (or anything older than the
    cutoff) is not editable. Plain string comparison is safe once both sides
    share that exact zero-padded shape."""
    if not ts:
        return False
    try:
        datetime.strptime(ts, "%Y-%m-%d %H:%M:%S")
    except ValueError:
        return False
    cutoff = (datetime.now() - timedelta(hours=24)).strftime("%Y-%m-%d %H:%M:%S")
    return ts >= cutoff


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
            # Cheap here: raw cast slugs, not resolved to names — the tree
            # view is a structural map, name resolution is the roster/detail
            # endpoints' job (threads-architecture.md §1: derive, don't store,
            # and don't pay for what a view doesn't need).
            "people": t.get("people", []),
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
                "people": _resolve_cast(t.get("people", [])),
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

    @app.route("/api/thread/<slug>/journal")
    def thread_journal(slug):
        """The thread's whole journal stream, for the thread's own page (not
        just the not-yet-absorbed inbox): every pool card tagged `<slug>`,
        union'd with every journal source the thread's fact-cards cite by id
        (falling back to a day row if that id predates the card pool), union'd
        with every pool card whose TEXT mentions the thread by name/alias
        (word-boundary, case-insensitive — same spirit as entityHighlight.ts's
        matcher on the client), plus a day row for every bare-day citation.
        Keeper-authored cards (`who: K`) are excluded — the owner's call, 2026-07-20:
        a thread's journal is the owner's record, not the keeper's commentary. Each
        card entry also carries `reply_to` (the parent card id or null) and
        `editable` (true iff its ts is within the rolling last 24 hours —
        see _card_editable), so the client can offer in-place edit/delete on
        recent cards and a reply-note affordance on older ones.
        Ascending, day rows sorting before that day's cards. A day row for a
        date with no pool card at all also carries `excerpts`: bounded
        mention-windowed snippets pulled from that day's pre-card-pool blob
        file (see _mention_excerpts) — [] when the day has pool cards, no
        blob file, or no mention of the thread in it."""
        slug = (slug or "").strip().lower()
        t = threads_index().get(slug)
        if not t:
            return jsonify({"error": "not found", "slug": slug}), 404

        pool = {c["id"]: c for c in _iter_cards()}

        cards = {}   # id -> pool card dict, insertion order = first-seen
        days = {}    # date -> label, first citing heading wins

        for c in pool.values():
            if slug in c["tags"]:
                cards.setdefault(c["id"], c)

        # Hoisted so the day-row excerpt pass below reuses the exact same
        # matcher the card-mention union just used — one thread, one pattern.
        terms = [term for term in [t["name"]] + t.get("aliases", []) if term]
        mention_re = None
        if terms:
            mention_re = re.compile(
                r"\b(?:" + "|".join(re.escape(term) for term in terms) + r")\b",
                re.IGNORECASE,
            )
            for c in pool.values():
                if mention_re.search(c["text"]):
                    cards.setdefault(c["id"], c)

        for fc in t.get("cards", []):
            heading = fc.get("heading", "")
            for src in fc.get("sources", []):
                if src.get("kind") != "journal":
                    continue
                ref = src["ref"]
                if _CARD_ID.match(ref):
                    if ref in pool:
                        cards.setdefault(ref, pool[ref])
                    else:
                        days.setdefault(ref.split(".")[0], heading)
                elif _DAY.match(ref):
                    days.setdefault(ref, heading)

        entries = []
        for cid, c in cards.items():
            # One choke point for the keeper filter: a K card cited by id still
            # counts as "in pool" above (no bogus day-row fallback), it just
            # never becomes an entry.
            if c["who"] == "K":
                continue
            entries.append({
                "kind": "card", "id": cid, "date": cid.split(".")[0],
                "ts": c["ts"], "who": c["who"], "text": c["text"],
                "reply_to": c["reply_to"], "editable": _card_editable(c["ts"]),
            })
        # A day row's excerpts only make sense when the pool has NO card at
        # all for that date (tagged or not) — a date WITH pool cards is
        # covered by its own card entries above, so the day row there is a
        # pure bare-day citation with nothing further to excerpt.
        pool_dates = {cid.split(".")[0] for cid in pool}
        for date, label in days.items():
            excerpts = []
            if mention_re and date not in pool_dates:
                body = _load_day_body(date)
                if body:
                    excerpts = _mention_excerpts(body, mention_re)
            entries.append({"kind": "day", "date": date, "label": label or "", "excerpts": excerpts})

        def sort_key(e):
            # Same "YYYY-MM-DD HH:MM:SS" shape for both, so plain string
            # comparison sorts correctly across dates too — no datetime
            # parsing needed. Day rows get "00:00:00" so they land first.
            return e["ts"] if e["kind"] == "card" else e["date"] + " 00:00:00"

        entries.sort(key=sort_key)

        return jsonify({
            "thread": {
                "id": t["id"], "name": t["name"], "status": t.get("status", ""),
                "kind": t.get("kind"), "fronts": t.get("fronts", []),
                "aliases": t.get("aliases", []),
                "people": _resolve_cast(t.get("people", [])),
            },
            "entries": entries,
        })

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
        """One thread's parsed fact-cards, for the popover / threads page /
        the wiki's per-thread article (routes/wiki.py doesn't duplicate this
        endpoint — the wiki page hits the same GET /api/thread the threads
        feature already calls). `backlinks` is derived per request (§7) —
        never stored. `peopleResolved` is a sibling {slug: bool} map (added
        alongside `people`, not folded into each cast entry, so it can't
        disturb the exact `{slug, name}` shape existing callers assert on) —
        whether /person/<slug> would actually resolve (entities.resolve_person,
        the same lookup routes/wiki.py's redlink flag uses), so a consumer
        can render an unresolved cast member as a muted redlink instead of a
        dead link that looks live."""
        q = (request.args.get("name") or "").strip()
        if not q:
            return jsonify({"error": "name required"}), 400
        t = resolve_thread(q)
        if not t:
            return jsonify({"error": "not found", "name": q}), 404
        payload = dict(t)
        payload["people"] = _resolve_cast(t.get("people", []))
        payload["peopleResolved"] = {
            p["slug"]: entities.resolve_person(p["slug"]) is not None for p in payload["people"]
        }
        payload["backlinks"] = backlinks_for(t["id"])
        return jsonify(payload)
