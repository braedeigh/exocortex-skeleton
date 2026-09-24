#!/usr/bin/env python3
"""derive_page_tags.py — tag every code file with the PAGE it serves.

Plain English: a dev note is filed under the page it was written on —
"kitchen", "today", "terminal". To hand that note to an agent with any
orientation at all, something has to answer "which files ARE the Kitchen
page?", frontend and backend both. This script answers it by reading the app
itself, and writes the answer where the rest of the system already looks for
tags.

WHERE THE ANSWER LANDS. Not a new table. `tags` (sqlstore.py) already holds
`file:<repo>/<path>` subjects, fed from tag_rules.json by
scripts/backfill_tags.py and read back through routes/tags.py. This adds one
namespace, `page`, whose values are exactly the dev-note page slugs — so
"which files serve the Kitchen page" is `GET /api/tags/tag/page/kitchen`, and
nothing new has to be invented to ask it.

HOW A PAGE'S FILES ARE FOUND — by reading the real thing, never a hand list:
  1. `frontend/src/routes/<page>.tsx` says which feature modules the page
     mounts. (tools/nightcrew/shots.py reads the router the same way to pick
     which page to photograph; this is that trick run backwards.)
  2. Every file in those feature dirs is scanned for the `/api/...` paths it
     calls — directly, or through a helper imported from
     `frontend/src/api/endpoints.ts`. Following that shared client is not
     optional: without it the Today page looks like it has no backend at all.
  3. A page that borrows a hook from another feature is followed there too,
     but only for the SYMBOLS it actually imported — the Threads page keeps
     its data hooks in the journal feature, and following the whole module
     instead puts the journal's entire backend on every page that imports
     anything from it.
  4. Each call is matched to the `routes/*.py` module that registers it.
  5. A sub-room is filed under its own name AND its parent's
     ('terrain-usage' and 'terrain'), because /terrain is a door that
     redirects and would otherwise own no files at all.
A hand-written list would be wrong within a week. This is re-runnable.

WHAT IS DELIBERATELY NOT TAGGED. The spine — server.py, store.py,
sqlstore.py — is touched by every page, so tagging it would put the same few
files on every page's list and the tag would stop distinguishing anything. A
page gets only what is specific to it. UNMAPPED pages get no rules for the
same reason: 'global' means the whole app and 'rodeo' is an event somebody
filed notes under, and a confident wrong pointer is worse than none.

Usage:
    scripts/derive_page_tags.py              # print the rules, write nothing
    scripts/derive_page_tags.py --write      # replace the ns=page rules in
                                             # tag_rules.json (then run
                                             # scripts/backfill_tags.py)
    scripts/derive_page_tags.py --prune      # delete derived ns=page rows
                                             # from `tags` first

--prune exists because backfill_tags.py is INSERT OR IGNORE: it can add what
is newly true but can never remove a row that has gone stale. Prune + write +
backfill is the clean rebuild after a page's files move.

Touches: tag_rules.json in the data dir (install-specific — rules are written
there, never into this repo), scripts/backfill_tags.py (turns rules into
`tags` rows), routes/tags.py (the read door), tests/test_derive_page_tags.py.

Prompt that produced this file: "select dev notes and start a session that
knows which page the note came from and the files associated with that page —
add tags to the frontend files as well as the backend files; use 'page' as the
naming convention."
"""
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import sqlstore                                  # noqa: E402
import store                                     # noqa: E402
from apiseam import (_read, _symbol_paths, backend_index,   # noqa: E402,F401
                     endpoint_functions, module_for)

SKELETON = Path(__file__).resolve().parents[1]
NAMESPACE = "page"

# Route-file stem -> page slug, for the pages whose URL and NAME differ. The
# tag value has to equal the dev-note page slug, because that slug is what a
# note carries and what the lookup is made with: the Today page lives at
# /todos, and its notes are filed under 'today'.
PAGE_ALIASES = {
    "todos": "today",
    "chat": "terminal",
    "sessions": "terminal",
}

# Route files that name no page of their own: the root layout, the redirecting
# index, and the parameterised ones (`person.$slug`), which are the same page
# as the route they hang off.
SKIPPED_ROUTES = {"__root", "index"}

# Pages whose code is not a feature module. The terminal is the biggest pile of
# dev notes in the vault and it lives in the shell, not under features/.
EXTRA_DIRECTORIES = {
    "terminal": ["frontend/src/shell/"],
}

# Note sections that are not pages, and get no rules: 'global' means the whole
# app, 'rodeo' is an event. Leaving them unmapped is the honest answer.
UNMAPPED = ("global", "rodeo")

# Never carries a page tag — see the block above.
SPINE = {"server.py", "store.py", "sqlstore.py"}


# The seam primitives live in apiseam.py now, because codegraph.py needs the
# same four to draw its frontend-to-backend edges and two copies of this
# matching would drift apart. Imported rather than re-implemented.



# A feature borrowing from another feature:
# `import { useThreads } from '../journal/useJournalData'`, or the same thing
# spelled `'../features/journal/x'` from the shell. Both groups are captured —
# the names taken, and the module they came from.
_BORROWED = re.compile(
    r"""import\s*\{([^}]*)\}\s*from\s*['"](?:\.\./)+(?:features/)?([A-Za-z0-9_-]+/[A-Za-z0-9_./-]+)['"]""")


def directory_calls(directory, functions):
    """Every `/api` path one frontend directory reaches — written inline, or
    written for it by an imported endpoint helper — plus, separately, the
    (module, names) it borrows from other features.

    Test files are skipped: a path only a test mentions is not a page's
    wiring. A match has to start at a QUOTE, so a path merely named in a
    comment doesn't count — the Threads page has `/api/threads` in a docstring
    and reaches it from somewhere else entirely.
    """
    calls, borrowed = set(), set()
    if not directory.is_dir():
        return calls, borrowed
    for source in sorted(list(directory.rglob("*.ts")) + list(directory.rglob("*.tsx"))):
        if ".test." in source.name:
            continue
        text = _read(source)
        calls |= set(re.findall(r"['\"`](/api/[A-Za-z0-9_/-]*)", text))
        for match in re.finditer(
                r"import\s*\{([^}]*)\}\s*from\s*['\"][^'\"]*api/endpoints['\"]", text):
            for name in match.group(1).split(","):
                name = name.strip().split(" as ")[0].strip()
                calls |= functions.get(name, set())
        for names, module in _BORROWED.findall(text):
            for name in names.split(","):
                name = name.strip().split(" as ")[0].strip().removeprefix("type ").strip()
                if name:
                    borrowed.add((module, name))
    return calls, borrowed


def page_calls(root, paths, functions):
    """What a page reaches: `(its own calls, the calls it borrows)`.

    The Threads page keeps its data hooks in `features/journal/useJournalData`,
    so a page that reads only its own directory resolves to NO backend at all.
    But a borrowed module is usually shared — that one exports hooks for cards,
    threads, to-dos and dev notes — so only the SYMBOLS this page imported are
    followed, and only one hop. What comes back is kept separate from the
    page's own calls because it is weaker evidence, and rules() weighs the two
    differently.

    A borrowed file never joins the page's own file list: it belongs to the
    page that owns it.
    """
    calls, borrowed = set(), set()
    for path in sorted(paths):
        found, taken = directory_calls(root / path, functions)
        calls |= found
        borrowed |= taken

    features_dir = root / "frontend/src/features"
    by_module = {}
    for module, name in borrowed:
        by_module.setdefault(module, set()).add(name)
    through_borrowed = set()
    for module, names in sorted(by_module.items()):
        for suffix in (".ts", ".tsx"):
            source = features_dir / (module + suffix)
            if source.is_file():
                symbols = _symbol_paths(_read(source), functions)
                for name in names:
                    through_borrowed |= symbols.get(name, set())
                break
    return calls, through_borrowed


def page_slugs(stem):
    """The pages a route file belongs to, most specific first.

    A sub-room belongs to TWO pages: its own (`terrain_.usage` -> 'terrain-usage')
    and its parent's (-> 'terrain'). Both, because /terrain itself is a door
    that redirects to /terrain/map — without the parent tag the room that
    carries six dev notes would own no files at all, while 'terrain-map' and
    the life Map page would both try to be called 'map'. Tags are many-to-many
    already, so a file serving a sub-room costs nothing to file under the room
    family as well.
    """
    if stem in SKIPPED_ROUTES or "$" in stem:
        return []
    if "_." in stem:
        base, sub = stem.split("_.", 1)
        base = PAGE_ALIASES.get(base, base)
        return [f"{base}-{sub.split('.')[0]}", base]
    return [PAGE_ALIASES.get(stem, stem)]


def page_sources(root=None):
    """page slug -> the frontend paths that ARE that page: its route file and
    every feature module the route mounts."""
    root = Path(root or SKELETON)
    pages = {}
    for route_file in sorted((root / "frontend/src/routes").glob("*.tsx")):
        slugs = [s for s in page_slugs(route_file.stem) if s not in UNMAPPED]
        if not slugs:
            continue
        source = _read(route_file)
        paths = {f"frontend/src/features/{name}/"
                 for name in re.findall(r"features/([A-Za-z0-9_-]+)/", source)}
        if paths:
            # The route file joins the list only when it actually mounts
            # something — a page with no feature module of its own is a
            # wrapper, and pointing an agent at the wrapper teaches it nothing.
            paths.add(route_file.relative_to(root).as_posix())
            for slug in slugs:
                pages.setdefault(slug, set()).update(paths)
    for page, extra in EXTRA_DIRECTORIES.items():
        pages.setdefault(page, set()).update(extra)
    return pages


# --- the rules --------------------------------------------------------------

def rules(root=None):
    """The full ns=page rule list for tag_rules.json: one rule per (page, path
    prefix) — the page's own frontend paths, plus every route module it calls,
    directly or through the symbols it borrows."""
    root = Path(root or SKELETON)
    index = backend_index(root)
    functions = endpoint_functions(root)
    out = []
    for page, paths in sorted(page_sources(root).items()):
        own_calls, borrowed_calls = page_calls(root, paths, functions)
        prefixes = set(paths) | _modules(own_calls | borrowed_calls, index)
        for prefix in sorted(prefixes):
            out.append({"repo": "skeleton", "prefix": prefix,
                        "tags": [{"ns": NAMESPACE, "tag": page}]})
    return out


def _modules(calls, index):
    """The route modules serving a set of calls — spine dropped."""
    found = set()
    for call in sorted(calls):
        module = module_for(call, index)
        if module and Path(module).name not in SPINE:
            found.add(module)
    return found


def _without_page_tags(rule):
    """One existing rule with its page tags taken out, or None if that leaves
    it empty. Rewriting means REPLACING the page layer — a rule for a
    directory that has since moved would otherwise point there forever — while
    every other namespace in the file is left exactly as it was."""
    tags = [t for t in rule.get("tags") or [] if t.get("ns") != NAMESPACE]
    if not tags:
        return None
    return dict(rule, tags=tags)


def write_rules(new_rules):
    """Swap the page layer in tag_rules.json for a freshly derived one."""
    data = store.read("tag_rules.json", {"rules": []})
    kept = [r for r in (_without_page_tags(rule) for rule in data.get("rules") or [])
            if r is not None]
    data["rules"] = kept + new_rules
    store.write("tag_rules.json", data)
    return len(kept), len(new_rules)


def prune_tags():
    """Delete the derived ns=page rows from `tags`. Only the derived ones: a
    page tag she put on a file by hand through /api/tags/add is hers, and this
    script does not get to overrule it."""
    conn = sqlstore.open_db()
    try:
        sqlstore.begin_immediate(conn)
        cursor = conn.execute(
            "DELETE FROM tags WHERE ns = ? AND source = 'derived'", (NAMESPACE,))
        conn.execute("COMMIT")
        return cursor.rowcount or 0
    finally:
        conn.close()


def main(argv):
    derived = rules()
    by_page = {}
    for rule in derived:
        by_page.setdefault(rule["tags"][0]["tag"], []).append(rule["prefix"])

    print(f"derive_page_tags: {len(by_page)} page(s), {len(derived)} rule(s)")
    for page, prefixes in sorted(by_page.items()):
        print(f"  {page:14s} {len(prefixes):2d}  {', '.join(sorted(prefixes))}")
    print(f"  unmapped on purpose: {', '.join(UNMAPPED)}")

    if "--prune" in argv:
        print(f"pruned {prune_tags()} derived ns={NAMESPACE} row(s) from `tags`")
    if "--write" in argv:
        kept, written = write_rules(derived)
        print(f"wrote tag_rules.json: {kept} other rule(s) kept, {written} page rule(s)")
        print("now run: scripts/backfill_tags.py")
    else:
        print(json.dumps(derived[:3], indent=1) + "\n  ... (--write to apply)")
    return 0


if __name__ == "__main__":
    # Put this run on the runtime map (runtime_sensor.py): which of our files
    # actually execute, and which call which. Inside __main__ rather than at
    # import, because only the standalone run is a process of its own.
    import runtime_sensor
    runtime_sensor.attach()
    raise SystemExit(main(sys.argv[1:]))
