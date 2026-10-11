"""Wiki home page — the front door of the traversable wiki about the owner.

    GET /api/wiki/home

One endpoint, one file: `<CONTENT_DIR>/context/home.md` (frontmatter + a
short markdown body), parsed the same way every other markdown-vault view in
this app is parsed — reusing the existing helpers rather than growing a
fourth frontmatter parser (see dev_todo.md's "one people parser" rule, same
spirit applies here):

  - `entities._parse_frontmatter` splits the `---` block from the body.
  - `threads._resolve_cast` turns the `people:` slugs into {slug, name}.
  - `entities.resolve_person` (the same lookup routes/person.py's
    /api/person/<slug> uses) tells us whether that slug actually has a
    people file yet, so the frontend can render a muted "redlink" chip for
    one that doesn't (e.g. home.md's `mom` slug, which has no people/mom.md).
  - `threads.threads_index()` (the same roster /api/threads is built from)
    gives us every living (non-retired) thread for the browse-by-front index.
  - fronts.json (the same collection routes/fronts.py reads) gives the full
    front vocabulary the browse index is grouped/filtered by.

Nothing here is stored — it's all derived fresh per request from the
markdown + the existing JSON collections, same philosophy as threads.py.

    GET /api/wiki/pond

The wiki's own pond: one endpoint laying journal, research, build and todo
items on a single time axis, the pond's own read-only-mirror discipline
(routes/pond.py's `mode=ro` + `query_only` connection) applied to every
tagged family at once rather than just cards. `?days=` (default 45, clamped
to 1..366) and `?end=` (default today) pick the window; the response is
`{"start", "end", "rows", "rail"}` — rows carry each item's subject address
(the same `<family>:<id>` scheme docs/tags-architecture.md defines for the
universal `tags` table), day/time, title, a whitespace-collapsed and capped
body, and its tags; the rail groups those tags by namespace the same way
routes/tags.py's `/api/tags` does. A build (commit) row's tags are not its
own — commits carry no tags of their own — they're INHERITED as the union of
the tags on the files it touched, because a commit's meaning IS the files it
changed. See docs/tags-architecture.md's "Wiki-pond" section for the contract
this implements exactly.
"""
import sqlite3
from contextlib import closing
from datetime import date, timedelta

from flask import jsonify, request

import store
from routes import entities, threads
from routes.entities import _parse_frontmatter
from routes.pond import BODY_CHARS as _POND_BODY_CHARS

HOME_PATH = ("context", "home.md")
ORGANIZED_HEADING = "## How this is organized"
HOW_TO_READ_HEADING = "## How to read this"


def _vault():
    # Resolve fresh each call so tests/env overrides of CONTENT_DIR are honored
    # (same pattern as entities._vault() / threads._vault()).
    return store.CONTENT_DIR.resolve()


def _home_path():
    p = _vault()
    for part in HOME_PATH:
        p = p / part
    return p


def _split_body(body):
    """Three fixed sections, in order: `lead` (everything before the first of
    the two known headings), `organizedBlurb` (under "## How this is
    organized"), `howToRead` (under "## How to read this"). A missing
    heading just means an empty section — this is a fixed shape
    (frontmatter's job is the schema), not a general markdown-sections
    parser."""
    org_idx = body.find(ORGANIZED_HEADING)
    read_idx = body.find(HOW_TO_READ_HEADING)

    lead_end = len(body)
    if org_idx != -1:
        lead_end = org_idx
    elif read_idx != -1:
        lead_end = read_idx
    lead = body[:lead_end].strip()

    organized_blurb = ""
    if org_idx != -1:
        org_end = read_idx if read_idx != -1 else len(body)
        organized_blurb = body[org_idx + len(ORGANIZED_HEADING):org_end].strip()

    how_to_read = ""
    if read_idx != -1:
        how_to_read = body[read_idx + len(HOW_TO_READ_HEADING):].strip()

    return lead, organized_blurb, how_to_read


def _wiki_threads():
    """Every non-retired thread (active + dormant — status != "retired") for
    the browse-by-front index: {slug, name, fronts, status}. Sorted by name;
    the frontend does its own grouping (by primary front) and filtering (by
    any front in the list), so this stays a flat, alphabetized roster —
    same "derive, don't store" spirit as threads._all_threads()."""
    idx = threads.threads_index()
    out = [
        {"slug": t["id"], "name": t["name"], "fronts": t.get("fronts", []), "status": t.get("status", "")}
        for t in idx.values()
        if t.get("status") != "retired"
    ]
    out.sort(key=lambda t: t["name"])
    return out


def _all_fronts():
    """The shared fronts vocabulary (routes/fronts.py's own collection read) —
    {id, name} pairs, in fronts.json's own order (the order the browse index
    groups/sorts by)."""
    data = store.read("fronts.json", {"fronts": []})
    return [{"id": f["id"], "name": f["name"]} for f in data.get("fronts", []) if f.get("id")]


def _scalar(meta, key):
    """A frontmatter value as a plain string. `_parse_frontmatter` splits any
    comma-containing scalar into a list (its `[a, b]`/bare-comma-list rule),
    which turns `place: Austin, TX` into `["Austin", "TX"]` — rejoin those
    back into the string she actually wrote rather than teaching the shared
    parser a field-by-field exception."""
    v = meta.get(key, "")
    if isinstance(v, list):
        return ", ".join(v)
    return v


def _resolve_people(slugs):
    """thread._resolve_cast's {slug, name} plus whether /person/<slug> would
    actually resolve (entities.resolve_person — the same lookup the person
    page's own API uses), so the frontend can render a redlink chip for a
    named-but-unwritten person instead of a dead link that looks live."""
    cast = threads._resolve_cast(slugs)
    for c in cast:
        c["resolved"] = entities.resolve_person(c["slug"]) is not None
    return cast


# --- Wiki-pond: GET /api/wiki/pond -------------------------------------------
#
# Prompt that produced this endpoint: "the wiki gets the pond UI — one
# endpoint returning journal, research, build and todo rows on one time axis,
# tagged, with a rail grouped by namespace".
#
# The design of record is docs/tags-architecture.md's "Wiki-pond" section —
# this is that contract, exactly. routes/pond.py is the sibling this mirrors:
# same read-only connection discipline, same body-capping, same windowed
# read, same documentation voice.

POND_DAYS_DEFAULT = 45
POND_DAYS_MIN = 1
POND_DAYS_MAX = 366

# One query's worth of subjects for the batched tags lookup. Comfortably
# under SQLite's default 999-host-parameter ceiling.
_TAG_QUERY_CHUNK = 400

# Same shelf order the rail groups by everywhere else in the app —
# routes/tags.py's own `_ns_sort_key` (private there, so twinned here rather
# than imported across modules; see that file if this drifts).
_NS_PRIORITY = {"front": 0, "thread": 1, "person": 2, "topic": 3}


def _pond_ns_sort_key(ns):
    return (_NS_PRIORITY.get(ns, len(_NS_PRIORITY)), ns)


def _pond_ro_conn():
    """A connection SQLite itself will not let anything write through.

    Twinned from routes/pond.py's own `_read_only_conn` (private there, so
    not imported) rather than duplicated by accident: same `mode=ro` +
    `PRAGMA query_only` belt-and-braces, same `contextlib.closing` contract —
    a bare `with conn:` only scopes a transaction and would leave the file
    descriptor open until the garbage collector gets to it.
    """
    conn = sqlite3.connect(
        f"file:{store.DATA_DIR / 'exo.db'}?mode=ro", uri=True, timeout=5
    )
    conn.execute("PRAGMA query_only = ON")
    conn.row_factory = sqlite3.Row
    return conn


def _pond_cap(text):
    """Whitespace collapsed, capped — the same rule routes/pond.py's `_body`
    applies to card text (that helper is private, so twinned here), reused
    for research entries too since both are free prose read whole in place."""
    flat = " ".join((text or "").split())
    return flat[:_POND_BODY_CHARS] + ("…" if len(flat) > _POND_BODY_CHARS else "")


def _pond_window():
    """`days` back from `end` (today by default). `days` CLAMPS into
    [POND_DAYS_MIN, POND_DAYS_MAX] rather than erroring — a fat-fingered
    `days=50000` degrading to a year is a better failure than a 400. `end`,
    if given, must be a real calendar date (same reasoning as pond.py's
    `_valid_day`: a date-shaped-but-impossible string would quietly define an
    empty window with no clue why)."""
    raw_end = (request.args.get("end") or "").strip()
    if raw_end:
        try:
            end_date = date.fromisoformat(raw_end)
        except ValueError:
            return None, None, '"end" must be a real date, YYYY-MM-DD'
    else:
        end_date = date.today()

    raw_days = (request.args.get("days") or "").strip()
    try:
        days = int(raw_days) if raw_days else POND_DAYS_DEFAULT
    except ValueError:
        days = POND_DAYS_DEFAULT
    days = max(POND_DAYS_MIN, min(POND_DAYS_MAX, days))

    start_date = end_date - timedelta(days=days - 1)
    return start_date.isoformat(), end_date.isoformat(), None


def _pond_journal_rows(conn, start, end):
    """Cards in the window, alive (not deleted), whole body capped like the
    pond's own list."""
    rows = conn.execute(
        "SELECT id, day, ts, body FROM cards"
        " WHERE deleted_at IS NULL AND day >= ? AND day <= ?"
        " ORDER BY day ASC, ts ASC, id ASC",
        (start, end),
    ).fetchall()
    return [
        {
            "id": f"card:{r['id']}", "family": "journal",
            "day": r["day"], "ts": r["ts"],
            "title": "", "body": _pond_cap(r["body"]),
        }
        for r in rows
    ]


def _pond_research_rows(start, end):
    """Research entries by their `created` stamp ('YYYY-MM-DD HH:MM') — read
    through store.read, not the ro connection above: the research collection
    is SQL-backed via the generic `docs` table (see sqlstore.py), and
    store.read is the one door onto that regardless of backing."""
    data = store.read("research", {"topics": [], "entries": []})
    out = []
    for e in data.get("entries", []) or []:
        created = e.get("created") or ""
        day = created[:10]
        if len(day) != 10 or not (start <= day <= end):
            continue
        ts = created[11:] if len(created) > 10 else ""
        out.append({
            "id": f"entry:{e.get('id')}", "family": "research",
            "day": day, "ts": ts,
            "title": "", "body": _pond_cap(e.get("text") or ""),
        })
    return out


def _pond_build_rows(conn, start, end):
    """Commits in the window, `title` = subject line, `body` empty (a commit
    has no prose the way a card or entry does). Tags are not read here —
    commits carry none of their own, so `_file_subjects` stashes the
    addresses whose tags this commit INHERITS (its files, every path each one
    has ever worn — commit_files -> file_paths), and the caller resolves and
    unions them once it has one batched tags query for the whole response."""
    commit_rows = conn.execute(
        "SELECT sha, authored_at, subject FROM commits"
        " WHERE substr(authored_at, 1, 10) >= ? AND substr(authored_at, 1, 10) <= ?"
        " ORDER BY authored_at ASC, sha ASC",
        (start, end),
    ).fetchall()
    if not commit_rows:
        return []

    shas = [r["sha"] for r in commit_rows]
    marks = ",".join("?" * len(shas))
    file_ids_by_sha = {}
    all_file_ids = set()
    for r in conn.execute(
        f"SELECT sha, file_id FROM commit_files WHERE sha IN ({marks})", shas,
    ):
        file_ids_by_sha.setdefault(r["sha"], set()).add(r["file_id"])
        all_file_ids.add(r["file_id"])

    file_subjects_by_id = {}
    if all_file_ids:
        fmarks = ",".join("?" * len(all_file_ids))
        for r in conn.execute(
            f"SELECT file_id, repo, path FROM file_paths WHERE file_id IN ({fmarks})",
            list(all_file_ids),
        ):
            file_subjects_by_id.setdefault(r["file_id"], set()).add(
                f"file:{r['repo']}/{r['path']}"
            )

    rows = []
    for r in commit_rows:
        subjects = set()
        for fid in file_ids_by_sha.get(r["sha"], ()):
            subjects |= file_subjects_by_id.get(fid, set())
        authored = r["authored_at"] or ""
        rows.append({
            "id": f"commit:{r['sha']}", "family": "build",
            "day": authored[:10], "ts": authored[11:],
            "title": r["subject"] or "", "body": "",
            "_file_subjects": subjects,
        })
    return rows


def _pond_todo_rows(conn, start, end):
    """Todos placed on `finished_on` if she claimed one, else the date part
    of `created` — the same precedence todostore.py's own `finished()` uses
    for "what day does this to-do belong to". A todo with neither is not
    placeable on the axis and is skipped, not guessed at."""
    rows = conn.execute(
        "SELECT id, text, notes, finished_on, finished_time, created FROM todos"
    ).fetchall()
    out = []
    for r in rows:
        if r["finished_on"]:
            day = r["finished_on"][:10]
            ts = r["finished_time"] or ""
        else:
            created = r["created"] or ""
            if len(created) < 10:
                continue
            day = created[:10]
            ts = created[11:] if len(created) > 10 else ""
        if not (start <= day <= end):
            continue
        out.append({
            "id": f"todo:{r['id']}", "family": "todo",
            "day": day, "ts": ts,
            "title": r["text"] or "", "body": r["notes"] or "",
        })
    return out


def _pond_tags(conn, subjects):
    """{subject: [{"ns","tag"}, ...]} for exactly the subjects asked for, in
    chunks of `_TAG_QUERY_CHUNK` rather than one query per subject — the
    batching the contract calls for."""
    by_subject = {}
    subjects = sorted(s for s in set(subjects) if s)
    for i in range(0, len(subjects), _TAG_QUERY_CHUNK):
        chunk = subjects[i:i + _TAG_QUERY_CHUNK]
        marks = ",".join("?" * len(chunk))
        for r in conn.execute(
            f"SELECT subject, ns, tag FROM tags WHERE subject IN ({marks})", chunk,
        ):
            by_subject.setdefault(r["subject"], []).append(
                {"ns": r["ns"], "tag": r["tag"]}
            )
    for subj, tags in by_subject.items():
        tags.sort(key=lambda t: (t["ns"], t["tag"]))
    return by_subject


def _pond_rail(rows):
    """Tags ranked by SPAN (distinct days touched) then count (distinct
    subjects), grouped by namespace — over the rows actually returned, same
    ranking philosophy as /api/pond/threads."""
    agg = {}  # (ns, tag) -> {"subjects": set(), "days": set()}
    for r in rows:
        for t in r["tags"]:
            slot = agg.setdefault((t["ns"], t["tag"]), {"subjects": set(), "days": set()})
            slot["subjects"].add(r["id"])
            slot["days"].add(r["day"])

    by_ns = {}
    for (ns, tag), slot in agg.items():
        by_ns.setdefault(ns, []).append({
            "tag": tag,
            "count": len(slot["subjects"]),
            "span": len(slot["days"]),
        })
    rail = []
    for ns, tags in by_ns.items():
        tags.sort(key=lambda t: (-t["span"], -t["count"], t["tag"]))
        rail.append({"ns": ns, "tags": tags})
    rail.sort(key=lambda n: _pond_ns_sort_key(n["ns"]))
    return rail


def register(app):
    @app.route("/api/wiki/home")
    def wiki_home():
        path = _home_path()
        if not path.exists():
            return jsonify({"error": "not found"}), 404

        meta, body = _parse_frontmatter(path.read_text())
        lead, organized_blurb, how_to_read = _split_body(body)

        people = meta.get("people", [])
        if isinstance(people, str):
            people = [people] if people else []

        return jsonify({
            "title": _scalar(meta, "title"),
            "pronouns": _scalar(meta, "pronouns"),
            "age": _scalar(meta, "age"),
            "birthday": _scalar(meta, "birthday"),
            "place": _scalar(meta, "place"),
            "lead": lead,
            "organizedBlurb": organized_blurb,
            "howToRead": how_to_read,
            "people": _resolve_people(people),
            "threads": _wiki_threads(),
            "fronts": _all_fronts(),
        })

    @app.route("/api/wiki/pond")
    def wiki_pond():
        """The wiki-pond: journal, research, build and todo rows on one time
        axis, tagged, with a rail grouped by namespace. See the module-level
        docstring's "GET /api/wiki/pond" section and
        docs/tags-architecture.md's "Wiki-pond" section for the contract.

        Read-only throughout: cards/commits/todos/tags/files come off a
        connection SQLite itself refuses writes through (`_pond_ro_conn`,
        routes/pond.py's own belt-and-braces twinned); the research family
        comes through store.read, which is the one door onto its SQL-backed
        collection regardless of what's behind it.
        """
        start, end, err = _pond_window()
        if err:
            return jsonify({"error": err}), 400

        with closing(_pond_ro_conn()) as conn:
            journal_rows = _pond_journal_rows(conn, start, end)
            research_rows = _pond_research_rows(start, end)
            build_rows = _pond_build_rows(conn, start, end)
            todo_rows = _pond_todo_rows(conn, start, end)

            # One batched tags query for the whole response: every row's own
            # subject, PLUS every file address a returned commit touched (a
            # build row's tags are inherited from those, not its own).
            direct_subjects = {r["id"] for r in journal_rows + research_rows + todo_rows}
            file_subjects = set()
            for r in build_rows:
                file_subjects |= r["_file_subjects"]
            tags_by_subject = _pond_tags(conn, direct_subjects | file_subjects)

        for r in journal_rows + research_rows + todo_rows:
            r["tags"] = tags_by_subject.get(r["id"], [])
        for r in build_rows:
            union = {}
            for subject in r.pop("_file_subjects"):
                for t in tags_by_subject.get(subject, []):
                    union[(t["ns"], t["tag"])] = t
            r["tags"] = sorted(union.values(), key=lambda t: (t["ns"], t["tag"]))

        rows = journal_rows + research_rows + build_rows + todo_rows
        rows.sort(key=lambda r: (r["day"], r["ts"] or "", r["family"], r["id"]))

        return jsonify({
            "start": start,
            "end": end,
            "rows": rows,
            "rail": _pond_rail(rows),
        })
