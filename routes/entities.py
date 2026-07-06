"""Entities — the people index, and the backlinks that power cross-references.

This is the *database view* over the markdown vault. The files stay the single
source of truth (human-editable, git-tracked, written by the Keeper and the
nightly people cricket); this module parses them into the structure a database
would hold — `Person -> many Entries` — rebuilt fresh on each request.

WHY it's built this way: the people cricket writes each reference in a rigid
`- [[YYYY-MM-DD]] (note)` shape, so that shape *is* the schema. When queries ever
outgrow parse-per-request, swap the in-memory build here for SQLite behind these
same functions and nothing above the API changes. Until then, YAGNI.

Shapes returned:
  Person  = { id, name, file, blurb, impression, body, entries: [Entry] }
  Entry   = { date: "YYYY-MM-DD", note }        # from the person's own file
  Mention = { file, label, date, snippet, count }  # anywhere else the name appears
  Day     = { date: "YYYY-MM-DD", count }       # per-day mention count, for person pages

The person-page tier (routes/person.py) builds on top of the shapes here:
`mention_days()` turns loose mentions + structured entries into a day-by-day
timeline, and `person_stats()` rolls that timeline (plus the mentions list) up
into a small summary block. Both are exposed here (not in person.py) because
they read the same vault-parsing internals as everything else in this module —
see the "ALL people-file parsing lives in entities.py" rule in dev_todo.md.
"""
import re

from flask import request, jsonify

import store

PEOPLE_DIR = "people"
# The stream-cards cutover: from this date the journal is a pool of card files
# tagged with person slugs (keeper in-session, endsession sweep, nightly cards
# cricket). No cards exist before it — earlier days are plain markdown reachable
# only by the named scan (journal + people + THREADS/WORRIES).
CARDS_CUTOVER = "2026-07-06"
CARDS_GLOB = "_system/data/cards/*.md"

# A "Referenced In" line, wikilinked or bare:
#   - [[2026-05-10]] (note)   OR   - 2026-02-27 (note)
_REF_RE = re.compile(r"^-\s*(?:\[\[)?(\d{4}-\d{2}-\d{2})(?:\]\])?\s*(?:\((.*)\))?\s*$")
# A date embedded in a filename (Journal/Daily/2026-07-03.md) for ordering mentions.
_DATE_IN_NAME = re.compile(r"(\d{4}-\d{2}-\d{2})")

# Folders whose files we scan for loose mentions of a name. The person's own file
# gives structured entries; these give "everywhere else it's referenced."
_MENTION_GLOBS = ["Journal/Daily/*.md", "people/*.md", "THREADS.md", "WORRIES.md"]


def _vault():
    # Resolve fresh each call so tests/env overrides of CONTENT_DIR are honored.
    return store.CONTENT_DIR.resolve()


def _slug(stem):
    """First-name key the way she writes it in prose: david-armenian -> david."""
    return stem.lower().split("-")[0]


def _parse_frontmatter(text):
    """Pull a leading `---` YAML block into a dict, return (meta, body).
    Deliberately tiny: we handle bracket lists `[a, b]`, comma-separated lists,
    and plain scalar strings. Returns ({}, text) when there's no frontmatter."""
    if not text.startswith("---"):
        return {}, text
    lines = text.splitlines()
    if lines[0].strip() != "---":
        return {}, text
    end = next((i for i in range(1, len(lines)) if lines[i].strip() == "---"), None)
    if end is None:
        return {}, text
    meta = {}
    for line in lines[1:end]:
        if ":" not in line:
            continue
        key, _, val = line.partition(":")
        val = val.strip()
        if val.startswith("[") and val.endswith("]"):
            inner = val[1:-1]
            items = [v.strip().strip('"\'') for v in inner.split(",")]
            meta[key.strip().lower()] = [v for v in items if v]
        elif "," in val:
            items = [v.strip().strip('"\'') for v in val.split(",")]
            meta[key.strip().lower()] = [v for v in items if v]
        else:
            # scalar string
            meta[key.strip().lower()] = val
    return meta, "\n".join(lines[end + 1:])


def _parse_person(path):
    """One people/*.md file -> a Person dict (blurb + impression + structured
    entries + tags/aliases + the raw body for narrative rendering)."""
    raw = path.read_text()
    meta, body = _parse_frontmatter(raw)
    lines = body.splitlines()

    name = path.stem
    entries = []
    in_refs = False
    in_impression = False
    blurb_done = False   # stop growing the blurb, but keep scanning for entries
    blurb_parts = []
    impression_lines = []

    for i, line in enumerate(lines):
        stripped = line.strip()
        if i == 0 and stripped.startswith("# "):
            name = stripped[2:].strip()
            continue
        if stripped.lower().startswith("## referenced in"):
            in_refs = True
            in_impression = False
            continue
        if stripped.lower().startswith("## impression"):
            in_impression = True
            in_refs = False
            blurb_done = True
            continue
        if in_refs:
            m = _REF_RE.match(stripped)
            if m:
                entries.append({"date": m.group(1), "note": (m.group(2) or "").strip()})
            continue
        if in_impression:
            if stripped.startswith("## "):
                in_impression = False   # a different section starts; impression is over
            else:
                impression_lines.append(line)
            continue
        # Everything before Referenced-In/Impression: the first paragraph is the blurb.
        if stripped.startswith("## "):
            blurb_done = True          # a different section starts; blurb is over
            continue
        if blurb_done:
            continue
        if not blurb_parts and not stripped:
            continue                    # skip leading blank(s) after the title
        if stripped:
            blurb_parts.append(stripped)
        else:
            blurb_done = True           # blank line ends the first paragraph

    blurb = " ".join(blurb_parts).strip()
    impression = "\n".join(impression_lines).strip()
    entries.sort(key=lambda e: e["date"])

    RESERVED = {"tags", "aliases"}
    SEED_ORDER = ["relationship", "age", "lives", "work"]
    raw_facts = {k: v for k, v in meta.items() if k not in RESERVED}
    facts = {}
    for key in SEED_ORDER:
        if key in raw_facts:
            val = raw_facts[key]
            facts[key] = str(val) if not isinstance(val, list) else ", ".join(val)
    for key, val in raw_facts.items():
        if key not in facts:
            facts[key] = str(val) if not isinstance(val, list) else ", ".join(val)

    return {
        "id": _slug(path.stem),
        "name": name,
        "file": path.relative_to(_vault()).as_posix(),
        "blurb": blurb,
        "impression": impression,
        "body": body.strip("\n"),
        "entries": entries,
        "tags": meta.get("tags", []),
        "aliases": meta.get("aliases", []),
        "facts": facts,
    }


def resolve_person(query):
    """Find a person by slug, first name, or any alias (case-insensitive)."""
    q = (query or "").strip().lower()
    if not q:
        return None
    idx = people_index()
    if q in idx:
        return idx[q]
    for p in idx.values():
        if p["name"].split()[0].lower() == q:
            return p
        if any(a.lower() == q for a in p.get("aliases", [])):
            return p
    return None


def people_index():
    """Every person as a Person dict, keyed by first-name slug (first file wins)."""
    base = _vault()
    pdir = base / PEOPLE_DIR
    index = {}
    if not pdir.exists():
        return index
    for p in sorted(pdir.glob("*.md")):
        person = _parse_person(p)
        index.setdefault(person["id"], person)  # first file wins the slug
    return index


def _pretty_label(rel):
    """Journal/Daily/2026-07-03.md -> '2026-07-03 (journal)'; people/x.md -> 'x'."""
    parts = rel.split("/")
    if parts[0] == "Journal" and len(parts) >= 3:
        return parts[-1].replace(".md", "")
    return parts[-1].replace(".md", "")


def find_mentions(terms, self_file=None, limit=200):
    """Loose word-boundary hits across the vault (excluding the person's own file).
    `terms` is a name or list of names/aliases — so "my landlord" catches Sally too.
    Returns newest-first Mention dicts with a one-line snippet for context."""
    if isinstance(terms, str):
        terms = [terms]
    terms = [t for t in terms if t]
    base = _vault()
    if not base.exists() or not terms:
        return []
    word = re.compile(r"\b(" + "|".join(re.escape(t) for t in terms) + r")\b", re.IGNORECASE)
    seen = set()
    out = []
    for pattern in _MENTION_GLOBS:
        for p in base.glob(pattern):
            rel = p.relative_to(base).as_posix()
            if rel == self_file or rel in seen:
                continue
            try:
                text = p.read_text()
            except OSError:
                continue
            hits = word.findall(text)
            if not hits:
                continue
            seen.add(rel)
            # First matching line, trimmed, as the snippet.
            snippet = ""
            for line in text.splitlines():
                if word.search(line):
                    snippet = line.strip().lstrip("#-* ").strip()
                    break
            dm = _DATE_IN_NAME.search(rel)
            out.append({
                "file": rel,
                "label": _pretty_label(rel),
                "date": dm.group(1) if dm else "",
                "snippet": snippet[:240],
                "count": len(hits),
            })
    # Newest-first by any date in the path; undated (THREADS etc.) sink to the end.
    out.sort(key=lambda m: m["date"] or "0000-00-00", reverse=True)
    return out[:limit]


def _person_word_re(person):
    terms = [person["name"].split()[0]] + list(person.get("aliases", []))
    terms = [t for t in terms if t]
    if not terms:
        return None
    return re.compile(r"\b(" + "|".join(re.escape(t) for t in terms) + r")\b", re.IGNORECASE)


def mention_days(person):
    """Day-by-day mention counts for one person, for the person-page timeline.

    Two sources, unioned:
      1. `Journal/Daily/*.md` — word-boundary hits of the name/aliases (same
         regex as find_mentions), one count per day.
      2. Card files (CARDS_GLOB) from CARDS_CUTOVER on — the cricket tags cards
         with the person's slug even when it doesn't name them. Each such card
         adds 1, but only when the card body has NO name/alias hit itself (a
         named card is already counted by the journal-day scan above; counting
         it again here would double-count the same reference).
    Structured `entries` dates (from the person's own file) are unioned in last
    at count 1 for any date not already present — a reference the cricket only
    recorded under an alias we don't know to search for.
    Returns dates sorted ascending, only where count > 0.
    """
    base = _vault()
    word = _person_word_re(person)
    days = {}

    if word:
        journal_dir = base / "Journal" / "Daily"
        for p in journal_dir.glob("*.md"):
            m = _DATE_IN_NAME.search(p.name)
            if not m:
                continue
            date = m.group(1)
            try:
                text = p.read_text()
            except OSError:
                continue
            count = len(word.findall(text))
            if count:
                days[date] = days.get(date, 0) + count

        for p in base.glob(CARDS_GLOB):
            m = _DATE_IN_NAME.search(p.name)
            if not m:
                continue
            date = m.group(1)
            if date < CARDS_CUTOVER:
                continue
            try:
                text = p.read_text()
            except OSError:
                continue
            meta, card_body = _parse_frontmatter(text)
            tags = [t.lower() for t in meta.get("tags", [])]
            if person["id"] not in tags:
                continue
            if word.search(card_body):
                continue  # named — the journal-day scan above already caught it
            days[date] = days.get(date, 0) + 1

    for e in person.get("entries", []):
        days.setdefault(e["date"], 1)

    return sorted(
        ({"date": d, "count": c} for d, c in days.items() if c > 0),
        key=lambda d: d["date"],
    )


def person_stats(person, days, mentions):
    """Roll `days` + `mentions` up into the summary block for a person page."""
    total = sum(d["count"] for d in days)
    first_date = days[0]["date"] if days else ""
    last_date = days[-1]["date"] if days else ""
    last = None
    if mentions:
        m = mentions[0]  # newest-first
        last = {"date": m["date"], "file": m["file"], "label": m["label"], "snippet": m["snippet"]}
    elif days:
        d = days[-1]["date"]
        last = {"date": d, "file": f"Journal/Daily/{d}.md", "label": d, "snippet": ""}
    return {
        "total": total,
        "days": len(days),
        "first_date": first_date,
        "last_date": last_date,
        "last": last,
    }


def register(app):
    @app.route("/api/backlinks")
    def backlinks():
        """Everything the exocortex holds about one name: the person's blurb +
        their structured entries + every other file that mentions them."""
        q = (request.args.get("name") or "").strip()
        if not q:
            return jsonify({"error": "name required"}), 400
        person = resolve_person(q)
        # Search the person's first name AND every alias, so role references count.
        terms = ([person["name"].split()[0]] + person.get("aliases", [])) if person else [q]
        mentions = find_mentions(terms, self_file=person["file"] if person else None)
        stats = person_stats(person, mention_days(person), mentions) if person else None
        return jsonify({
            "name": person["name"] if person else q,
            "person": person,  # None if no people file yet
            "mentions": mentions,
            "stats": stats,     # None for a non-person query
        })

    @app.route("/api/people")
    def people_list():
        """Roster for the journal highlighter + tag filtering.
        `?tag=austin` returns only people carrying that tag."""
        tag = (request.args.get("tag") or "").strip().lower()
        out = []
        for p in people_index().values():
            if tag and tag not in [t.lower() for t in p.get("tags", [])]:
                continue
            out.append({
                "id": p["id"], "name": p["name"], "file": p["file"],
                "tags": p.get("tags", []), "aliases": p.get("aliases", []),
            })
        return jsonify({"people": out})
