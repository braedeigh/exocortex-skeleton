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
