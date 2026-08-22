#!/usr/bin/env python3
"""scripts/backfill_tags.py — mirrors the five pre-existing tagging dialects
into the one universal `tags` table (schema v12; see docs/tags-architecture.md,
the design of record this script implements verbatim).

WHAT THIS DOES, in plain terms: before the `tags` table existed, "what is this
tagged with" was answered five different ways in five different places —
`card_tags` (free strings on journal cards), `todo_fronts` (life-domain tags on
to-dos), the `research` collection's own `topics[].fronts` / `entries[].topics`,
each Thread file's `fronts:`/`people:` frontmatter, and (new) a rules file that
tags files by path prefix. This script reads all five and INSERTs a mirror row
into `tags` for each fact found — never touching the originals, never deleting
anything, safe to run again and again.

Idempotent: every row is `INSERT OR IGNORE ... source='derived'`, so re-running
after she edits a thread's fronts, adds a card tag, or edits tag_rules.json
only ever ADDS what's newly true. It can never remove a derived row that's
gone stale (e.g. a front removed from a thread) — that's a known limit of
INSERT OR IGNORE, not a bug; a future `--rebuild` (delete-then-reinsert
`source='derived'` rows) would be the fix if staleness ever matters in
practice. `--dry-run` computes and prints the same per-source candidate counts
without opening a write transaction.

The five sources, subject families, and namespaces (straight out of the doc):
  1. card_tags        -> card:<id>          ns = person|thread|front|topic,
                         classified the way routes/pond.py's rail already
                         classifies a tag: a people/<tag>.md file makes it a
                         person, a Threads/<tag>.md file makes it a thread, a
                         fronts.json id makes it a front, anything else is a
                         topic nobody's filed.
  2. todo_fronts       -> todo:<id>          ns = front
  3. research (SQL)    -> topic:<id> ns=front (a topic's own fronts:);
                          entry:<id> ns=topic (each topic on the entry);
                          entry:<id> ns=front (union of those topics' fronts)
  4. Threads/*.md      -> thread:<slug>      ns=front (fronts:) + ns=person
                         (people:), parsed with the exact frontmatter reader
                         routes/entities.py already uses for people files and
                         routes/threads.py uses for threads.
  5. files x tag_rules.json -> file:<repo>/<path> ns/tag = every rule (repo
                         match + path prefix match) applies, union'd. Deleted
                         files (files.deleted_at set) are skipped — a tag on a
                         file that no longer exists isn't useful. tag_rules.json
                         is install-specific data (EXOCORTEX_DATA_DIR), never
                         checked into this repo.

Every ns/tag is slug-validated with the exact rule routes/tags.py's write door
enforces (`_clean_slug`: lowercase, then `^[a-z0-9][a-z0-9\\-_.]*$`) — a value
that fails is skipped and counted, never allowed to crash the run, and every
skip is printed at the end so a bad tag_rules.json entry or a stray card_tags
string is visible rather than silently dropped.

Paths are resolved the same way every other script in this repo does: import
store (EXOCORTEX_DATA_DIR / EXOCORTEX_CONTENT_DIR), never a hardcoded /opt
path — see scripts/update_cards.py's sys.path bootstrap, mirrored below.

Usage:
    scripts/backfill_tags.py --dry-run     # print counts, write nothing
    scripts/backfill_tags.py               # write for real

Prompt that produced this file: implement docs/tags-architecture.md's
"Backfill — scripts/backfill_tags.py" section exactly — one idempotent script
that mirrors card_tags/todo_fronts/research/thread-frontmatter/files-by-rule
into the new universal `tags` table.
"""
import argparse
import sys
from pathlib import Path

# Make the skeleton root importable regardless of where the script is invoked
# from (mirrors scripts/update_cards.py's / scripts/research_doctor.py's
# bootstrap) — this is what lets `import store`, `import sqlstore`, and
# `from routes...` below resolve when this file is run directly.
HERE = Path(__file__).resolve().parent
SKELETON = HERE.parent
if str(SKELETON) not in sys.path:
    sys.path.insert(0, str(SKELETON))

import sqlstore                                              # noqa: E402
import store                                                  # noqa: E402
from routes.entities import PEOPLE_DIR, _parse_frontmatter    # noqa: E402
from routes.threads import THREADS_DIR                        # noqa: E402
from routes.tags import _clean_slug                           # noqa: E402


# --- shared vault lookups (mirror pond.py's _taxonomy, existence-only) -------

def _people_slugs():
    """Every people/<slug>.md stem — same source pond.py's taxonomy reads,
    just the set of ids rather than the full parsed Person dicts (we only
    need "does this file exist" here)."""
    d = store.CONTENT_DIR / PEOPLE_DIR
    return {p.stem for p in d.glob("*.md")} if d.exists() else set()


def _thread_slugs():
    """Every Threads/<slug>.md stem — same idea as _people_slugs()."""
    d = store.CONTENT_DIR / THREADS_DIR
    return {p.stem for p in d.glob("*.md")} if d.exists() else set()


def _front_ids():
    """The front vocabulary's own ids (fronts.json — a plain file, not the
    SQL `fronts` table todo_fronts' FK uses, which can carry retired ids like
    'admin'/'work'/'life' that were never real fronts)."""
    fronts = store.read("fronts.json", {"fronts": []}).get("fronts") or []
    return {f["id"] for f in fronts if f.get("id")}


def _classify_card_tag(tag, people, threads, fronts):
    """One card_tags string -> its ns, in the order the task spec gives:
    person, then thread, then front, else topic. (routes/pond.py's own
    _classify checks thread before person and has no front branch at all —
    this mirrors the SPIRIT of that classification, extended with the third
    rule the tags-architecture doc explicitly calls for, since a card tag
    like 'exocortex' or 'health' is a real fronts.json id that pond.py's rail
    would otherwise mislabel 'topic'.)"""
    if tag in people:
        return "person"
    if tag in threads:
        return "thread"
    if tag in fronts:
        return "front"
    return "topic"


def _list_field(meta, key):
    """Frontmatter value -> a clean list, same tolerant shape _parse_frontmatter
    itself produces (str -> [str], missing -> [])."""
    v = meta.get(key, [])
    if isinstance(v, str):
        v = [v] if v else []
    return [x for x in v if x]


class Collector:
    """One source's candidate (subject, ns, tag) rows, slug-validated and
    deduped on the way in. `rows` is what --dry-run counts and what the real
    run inserts; `skipped` is every (subject, raw_ns, raw_tag) that failed
    routes/tags.py's own slug rule, kept for the end-of-run report rather
    than silently dropped."""

    def __init__(self, name):
        self.name = name
        self.rows = set()
        self.skipped = []

    def add(self, subject, ns, tag):
        clean_ns = _clean_slug(ns)
        clean_tag = _clean_slug(tag)
        if clean_ns is None or clean_tag is None:
            self.skipped.append((subject, ns, tag))
            return
        self.rows.add((subject, clean_ns, clean_tag))


# --- the five sources ---------------------------------------------------------

def gather_card_tags(conn):
    """1. card_tags -> card:<id>, ns classified per _classify_card_tag."""
    c = Collector("card_tags")
    people, threads, fronts = _people_slugs(), _thread_slugs(), _front_ids()
    for card_id, tag in conn.execute("SELECT card_id, tag FROM card_tags"):
        ns = _classify_card_tag(tag, people, threads, fronts)
        c.add(f"card:{card_id}", ns, tag)
    return c


def gather_todo_fronts(conn):
    """2. todo_fronts -> todo:<id>, ns=front."""
    c = Collector("todo_fronts")
    for todo_id, front in conn.execute("SELECT todo_id, front FROM todo_fronts"):
        c.add(f"todo:{todo_id}", "front", front)
    return c


def gather_research():
    """3. The research collection (SQL-backed — store.read resolves it
    through sqlstore, same door routes/research.py reads through):
      topic:<id>  ns=front  for each id in that topic's own `fronts`
      entry:<id>  ns=topic  for each id in that entry's `topics`
      entry:<id>  ns=front  = the UNION of those topics' `fronts`
    """
    c = Collector("research")
    data = store.read("research.json", {"topics": [], "entries": []})
    topics = data.get("topics") or []
    topics_by_id = {t.get("id"): t for t in topics if t.get("id")}

    for t in topics:
        tid = t.get("id")
        if not tid:
            continue
        for front in t.get("fronts") or []:
            c.add(f"topic:{tid}", "front", front)

    for e in data.get("entries") or []:
        eid = e.get("id")
        if not eid:
            continue
        fronts_union = set()
        for tid in e.get("topics") or []:
            c.add(f"entry:{eid}", "topic", tid)
            topic = topics_by_id.get(tid)
            if topic:
                fronts_union.update(topic.get("fronts") or [])
        for front in fronts_union:
            c.add(f"entry:{eid}", "front", front)
    return c


def gather_threads():
    """4. Thread frontmatter across tulku/Threads/*.md -> thread:<slug>,
    ns=front (fronts:) + ns=person (people:). Every file under Threads/ is
    included, retired ones too — the doc's spirit doesn't carve those out
    (Threads-Retired/ is a different directory this glob never touches)."""
    c = Collector("threads")
    d = store.CONTENT_DIR / THREADS_DIR
    if not d.exists():
        return c
    for p in sorted(d.glob("*.md")):
        try:
            meta, _ = _parse_frontmatter(p.read_text())
        except (OSError, UnicodeDecodeError):
            continue
        slug = p.stem.lower()
        for front in _list_field(meta, "fronts"):
            c.add(f"thread:{slug}", "front", front)
        for person in _list_field(meta, "people"):
            c.add(f"thread:{slug}", "person", person)
    return c


def gather_files(conn):
    """5. files x tag_rules.json -> file:<repo>/<path>. Every rule whose repo
    matches the file's repo AND whose prefix prefixes the file's path applies
    (union, not longest-match, per the doc). Deleted files are skipped."""
    c = Collector("files")
    rules = store.read("tag_rules.json", {"rules": []}).get("rules") or []
    if not rules:
        return c
    by_repo = {}
    for r in rules:
        by_repo.setdefault(r.get("repo"), []).append(r)
    for repo, path in conn.execute(
        "SELECT repo, path FROM files WHERE deleted_at IS NULL"
    ):
        for r in by_repo.get(repo, []):
            prefix = r.get("prefix", "")
            if not path.startswith(prefix):
                continue
            for tag_obj in r.get("tags") or []:
                c.add(f"file:{repo}/{path}", tag_obj.get("ns"), tag_obj.get("tag"))
    return c


# --- orchestration -------------------------------------------------------------

def run(dry_run):
    conn = sqlstore.open_db()
    try:
        collectors = [
            gather_card_tags(conn),
            gather_todo_fronts(conn),
            gather_research(),
            gather_threads(),
            gather_files(conn),
        ]

        print(f"backfill_tags{' (--dry-run, writing nothing)' if dry_run else ''}:")
        for c in collectors:
            skip_note = f", {len(c.skipped)} skipped (invalid slug)" if c.skipped else ""
            print(f"  {c.name}: {len(c.rows)} candidate row(s){skip_note}")
        total_candidates = sum(len(c.rows) for c in collectors)
        total_skipped = sum(len(c.skipped) for c in collectors)
        print(f"  TOTAL: {total_candidates} candidate row(s), {total_skipped} skipped")

        if total_skipped:
            print("\nskipped (failed the ns/tag slug rule, ^[a-z0-9][a-z0-9-_.]* after lowercasing):")
            for c in collectors:
                for subject, ns, tag in c.skipped:
                    print(f"  [{c.name}] subject={subject!r} ns={ns!r} tag={tag!r}")

        if dry_run:
            return {c.name: len(c.rows) for c in collectors}

        sqlstore.begin_immediate(conn)
        inserted_by_source = {}
        try:
            for c in collectors:
                n = 0
                for subject, ns, tag in sorted(c.rows):
                    cur = conn.execute(
                        "INSERT OR IGNORE INTO tags (subject, ns, tag, source)"
                        " VALUES (?, ?, ?, 'derived')",
                        (subject, ns, tag),
                    )
                    if cur.rowcount and cur.rowcount > 0:
                        n += 1
                inserted_by_source[c.name] = n
            conn.execute("COMMIT")
        except BaseException:
            conn.execute("ROLLBACK")
            raise

        print("\ninserted:")
        for name, n in inserted_by_source.items():
            print(f"  {name}: {n}")
        print(f"  TOTAL inserted: {sum(inserted_by_source.values())}")
        return inserted_by_source
    finally:
        conn.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dry-run", action="store_true",
        help="print per-source would-insert counts, write nothing",
    )
    args = parser.parse_args()
    run(dry_run=args.dry_run)


if __name__ == "__main__":
    main()
