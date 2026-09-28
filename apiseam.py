"""apiseam.py — the seam where the frontend calls the backend.

Plain English: `codegraph.py` draws an edge when one file IMPORTS another.
That works inside the frontend and inside the Python, but it cannot cross
between them — a React component doesn't import `routes/todos.py`, it names a
string like `/api/todos` and a request carries it across. So the import graph
has a canyon down the middle of it, and a question like "which SQL tables does
this page's code end at" dies at the near edge.

This module is the bridge. It reads every frontend file for the `/api` paths
it names, matches each one to the `routes/*.py` module whose decorator
registers it, and hands `codegraph.py` those pairs as `code_edges` rows with
`kind='http'` — so one walk can start at a `.tsx` and come out at a table.

WHAT AN EDGE HERE MEANS, stated as narrowly as it is true: this file names a
path that this module registers. It is the same kind of claim `kind='import'`
makes — a thing that CAN flow, read out of the source — and it is not a claim
that the call ever ran. What actually ran is in `trace_spans`
(`runtime_trace.py`), deliberately kept in a different store.

ONE FILE, NOT ONE DIRECTORY. `scripts/derive_page_tags.py` asks the same
question per PAGE, and to answer it follows hooks borrowed from other features
SYMBOL BY SYMBOL. This scanner deliberately doesn't: it reports only what the
file in front of it names, and leaves joining files up to whoever walks the
import edges already in `code_edges`.

That split is right for the rows, and a caller doing the walk has to know it
is not enough on its own. Measured on this repo: closing over the frontend
import edges puts 12 route modules on a page that directly calls one, because
a page imports a hook module that calls many APIs and the edge carries no way
to tell which hook was taken. The fix is the symbol granularity the page
deriver already has (`_symbol_paths`), applied to the walk — not to these
rows. Until a walker does that, treat a transitive frontend reach as an upper
bound, not an answer.

`file_reach` is that walker, for the Terrain map: it follows a file's
imported NAMES rather than whole modules, so a page reaches what the hooks it
took reach and not what their neighbours do.

Touches: `codegraph.py` (calls `seam_edges` during `build`, writes the rows),
`scripts/derive_page_tags.py` (imports the four matching primitives below —
this module owns them now), `routes/terrain_tables.py` (`scan_code`, the last
leg: which Python files touch which table).

Prompt that produced this file: "I want to be able to see which backend files
and which sql tables are associated with which frontend files."
"""
import re
from pathlib import Path

SKELETON = Path(__file__).resolve().parent

# Where the frontend lives, and the one module that writes `/api` paths on
# behalf of everybody else.
FRONTEND = "frontend/src"
ENDPOINTS = "frontend/src/api/endpoints.ts"

# A call has to start at a QUOTE. A path merely named in a comment or a
# docstring is not a call, and counting it puts a backend on a page that never
# talks to it.
_CALL_RE = re.compile(r"""['"`](/api/[A-Za-z0-9_/-]*)""")

# `import { getTodos } from '../api/endpoints'` — the names a file takes from
# the shared client, which stand in for the paths that client writes.
_ENDPOINT_IMPORT_RE = re.compile(
    r"""import\s*\{([^}]*)\}\s*from\s*['"][^'"]*api/endpoints['"]""")


def _read(path):
    """Read a source file, or an empty string. A file that can't be read must
    not take the whole derivation down with it."""
    try:
        return path.read_text(encoding="utf-8")
    except OSError:
        return ""


# --- the backend: which module answers a call -------------------------------

def backend_index(root=None):
    """Every `/api/...` path the Flask side registers, and the module that
    owns it. Read out of the decorators, so it is true of the code as it is
    today."""
    root = Path(root or SKELETON)
    index = {}
    modules = sorted((root / "routes").rglob("*.py")) + [root / "server.py"]
    for module in modules:
        for match in re.finditer(r"@app\.route\(\s*['\"](/api/[^'\"]*)", _read(module)):
            index.setdefault(match.group(1),
                             module.relative_to(root).as_posix())
    return index


def module_for(call, index):
    """The route module most likely to serve one `/api/...` call.

    Matched on path SEGMENTS rather than string equality, because the
    registered path carries Flask's placeholders (`/api/person/<slug>`) and
    the caller carries a real value or a template hole. The second segment
    must agree — that's the family, `/api/kitchen/...` — and the best score
    across the first three wins. No agreement, no guess: a wrong module is
    worse for orientation than a short list.
    """
    wanted = [part for part in call.strip("/").split("/") if part][:3]
    if len(wanted) < 2:
        return None
    best = None
    for path, module in index.items():
        have = [part for part in path.strip("/").split("/") if part][:3]
        if len(have) < 2 or have[1] != wanted[1]:
            continue
        score = sum(1 for a, b in zip(wanted, have) if a == b or b.startswith("<"))
        if best is None or score > best[0]:
            best = (score, module)
    return best[1] if best else None


# --- the frontend: which calls a file makes ---------------------------------

def _symbol_paths(text, functions=None):
    """Every exported symbol in one TypeScript module -> the `/api` paths it
    reaches: the ones written in its own body, plus the ones any endpoint
    helper it calls by name writes for it.

    Symbol granularity is the whole point. `features/journal/useJournalData`
    exports hooks for cards, threads, to-dos and dev notes together, and two
    thirds of the pages import something from it — so following the FILE puts
    the journal's whole backend on the Car page. Following only the symbols a
    page actually named keeps the Threads page's `useThreads` and leaves the
    rest behind.
    """
    symbols = {}
    for chunk in re.split(r"\nexport (?:async )?(?:function|const) ", "\n" + text)[1:]:
        name = re.match(r"(\w+)", chunk)
        if not name:
            continue
        body = re.split(r"\nexport ", chunk)[0]
        paths = set(_CALL_RE.findall(body))
        for helper, helper_paths in (functions or {}).items():
            if re.search(r"\b%s\b" % re.escape(helper), body):
                paths |= helper_paths
        symbols[name.group(1)] = paths
    return symbols


def endpoint_functions(root=None):
    """`frontend/src/api/endpoints.ts`: each exported helper -> the `/api`
    paths it calls. Most feature modules call through these helpers rather
    than writing the path themselves, so without this step half the pages
    resolve to no backend at all."""
    root = Path(root or SKELETON)
    return _symbol_paths(_read(root / ENDPOINTS))


def file_calls(text, functions=None):
    """Every `/api` path ONE frontend file reaches — written in its own body,
    or written for it by a shared endpoint helper it imported by name.

    Deliberately shallower than the page deriver: a hook borrowed from another
    feature is NOT followed here, because `code_edges` already records that
    import and a walk across it gets there anyway. Two ways to reach the same
    answer, and this is the one that stays true per file."""
    calls = set(_CALL_RE.findall(text))
    for match in _ENDPOINT_IMPORT_RE.finditer(text):
        for name in match.group(1).split(","):
            name = name.strip().split(" as ")[0].strip()
            name = name.removeprefix("type ").strip()
            if name:
                calls |= (functions or {}).get(name, set())
    return calls


# --- the walk: which route modules a file reaches, through what it imports ---
#
# file_calls() stops at the file's own text, so a page whose data hooks live
# in `./api` reaches no backend at all. Following the import FILE instead puts
# every route that module calls on the page — the 12-for-1 overclaim the top
# block measures. This walk follows the imported NAMES: a page that takes
# `useTodos` from `./api` reaches what `useTodos` reaches, and nothing the
# rest of that module does. It keeps going name by name — a route file
# imports a page, the page a hook, the hook an endpoint helper — until it
# arrives at an `/api` path or runs out.
#
# What it can't see, all of it UNDER-reporting: a default import, a non-exported
# helper inside a module (only exported names are followed), and anything
# imported from a package rather than a relative path.

# `import { a, b as c, type T } from './x'`, with or without a default in front.
_LOCAL_IMPORT_RE = re.compile(
    r"""import\s+(?:type\s+)?(?:\w+\s*,\s*)?\{([^}]*)\}\s*from\s*['"](\.[^'"]*)['"]""")
# `export { a, b as c } from './x'` — a module handing on another's names.
_REEXPORT_RE = re.compile(r"""export\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"](\.[^'"]*)['"]""")


def _resolve_import(source, specifier):
    """The real file a relative specifier names, or None. Tries it as
    written, then the extensions and index files the bundler would."""
    base = source.parent / specifier
    for candidate in (base, base.with_name(base.name + ".ts"), base.with_name(base.name + ".tsx"),
                      base / "index.ts", base / "index.tsx"):
        if candidate.is_file():
            return candidate.resolve()
    return None


def _named(clause):
    """`a, b as c, type T` -> [(local name, exported name), ...]."""
    pairs = []
    for part in clause.split(","):
        part = part.strip().removeprefix("type ").strip()
        if not part:
            continue
        exported, _, local = part.partition(" as ")
        pairs.append(((local or exported).strip(), exported.strip()))
    return pairs


def _symbol_bodies(text):
    """Every exported function/const in one module -> its body text — the
    same split `_symbol_paths` makes, kept as text so the walk can see which
    names each body mentions."""
    bodies = {}
    for chunk in re.split(r"\nexport (?:async )?(?:function|const) ", "\n" + text)[1:]:
        name = re.match(r"(\w+)", chunk)
        if name:
            bodies[name.group(1)] = re.split(r"\nexport ", chunk)[0]
    return bodies


def file_reach(root=None):
    """Every frontend file -> {route module: sorted `/api` paths} it reaches,
    through its own text and through every name it imports, followed name by
    name (see the block above). Files that reach no backend are left out.

    Prompt that produced this: "show connections between my frontend UI to my
    SQL tables and backend stuff in terrain"."""
    root = Path(root or SKELETON).resolve()
    frontend = root / FRONTEND
    if not frontend.is_dir() or not (root / "routes").is_dir():
        return {}
    index = backend_index(root)
    functions = endpoint_functions(root)
    if not index:
        return {}

    # What each module says, read once: its text, its exported bodies, the
    # paths each body writes for itself, and the names it takes from siblings.
    modules = {}

    def module(path):
        if path not in modules:
            text = _read(path)
            imports = {}
            for regex in (_LOCAL_IMPORT_RE, _REEXPORT_RE):
                for match in regex.finditer(text):
                    target = _resolve_import(path, match.group(2))
                    if target is not None:
                        for local, exported in _named(match.group(1)):
                            imports[local] = (target, exported)
            modules[path] = {"text": text, "bodies": _symbol_bodies(text),
                             "own": _symbol_paths(text, functions), "imports": imports}
        return modules[path]

    # One exported name -> every path it reaches. Memoized; a name already
    # being walked (an import cycle) counts as reaching nothing further, so
    # the walk always ends.
    reached, walking = {}, set()

    def symbol_reach(path, name):
        key = (path, name)
        if key in reached:
            return reached[key]
        if key in walking:
            return set()
        walking.add(key)
        info = module(path)
        if name in info["imports"] and name not in info["bodies"]:
            paths = symbol_reach(*info["imports"][name])          # a re-export
        else:
            body = info["bodies"].get(name, "")
            paths = set(info["own"].get(name, set()))
            for other in info["bodies"]:                          # same-file names
                if other != name and re.search(r"\b%s\b" % re.escape(other), body):
                    paths |= symbol_reach(path, other)
            for local, target in info["imports"].items():         # imported names
                if re.search(r"\b%s\b" % re.escape(local), body):
                    paths |= symbol_reach(*target)
        walking.discard(key)
        reached[key] = paths
        return paths

    # Each file: what its own text calls, plus what every name it imports reaches.
    out = {}
    for source in sorted(list(frontend.rglob("*.ts")) + list(frontend.rglob("*.tsx"))):
        if ".test." in source.name:
            continue        # a path only a test mentions is not the app's wiring
        source = source.resolve()
        info = module(source)
        calls = file_calls(info["text"], functions)
        for target in info["imports"].values():
            calls |= symbol_reach(*target)
        routes = {}
        for call in calls:
            owner = module_for(call, index)
            if owner is not None:                 # no agreement, no guess
                routes.setdefault(owner, set()).add(call)
        if routes:
            out[source.relative_to(root).as_posix()] = {
                owner: sorted(paths) for owner, paths in sorted(routes.items())}
    return out


# --- the rows codegraph writes ----------------------------------------------

def seam_edges(repo_id, root, known_paths=None):
    """`(repo, src, dst_repo, dst, 'http', symbols_json)` for every frontend
    file that names a path some route module registers.

    Returns nothing for a repo that has no frontend and no routes — the vault
    is passed through here the same as the app checkout, and simply has
    neither. Same rule as the import edges: an edge is only drawn when the
    destination is a real file in the same repo.
    """
    import json

    root = Path(root)
    if not (root / FRONTEND).is_dir() or not (root / "routes").is_dir():
        return []

    index = backend_index(root)
    functions = endpoint_functions(root)
    if not index:
        return []

    # One edge per (file, module) pair, carrying every path that crosses it —
    # the same shape the import edges use, where `symbols` is the names going
    # across rather than one row per name.
    pairs = {}
    for source in sorted(list((root / FRONTEND).rglob("*.ts"))
                         + list((root / FRONTEND).rglob("*.tsx"))):
        # A path only a test mentions is not the app's wiring.
        if ".test." in source.name:
            continue
        src = source.relative_to(root).as_posix()
        for call in file_calls(_read(source), functions):
            module = module_for(call, index)
            if module is None:
                continue        # no agreement, no guess — see module_for
            if known_paths is not None and module not in known_paths:
                continue        # destination isn't a file we actually walked
            pairs.setdefault((src, module), set()).add(call)

    return [(repo_id, src, repo_id, module, "http", json.dumps(sorted(calls)))
            for (src, module), calls in sorted(pairs.items())]
