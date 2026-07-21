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
"""
from flask import jsonify

import store
from routes import entities, threads
from routes.entities import _parse_frontmatter

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
